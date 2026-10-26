import * as vscode from 'vscode';
import * as path from 'path';
import { createHash } from 'crypto';
import { BaseAPI } from '../api/base';
import { SyncEngine } from '../sync/syncEngine';
import { SettingsManager } from '../utils/settingsManager';
import { assertSafeWorkspacePath, getWorkspaceRelativePath, normalizeProjectPath } from '../utils/pathSafety';
import { PdfPreviewPanel } from '../views/pdfPreviewPanel';
import { OutputStore, StoredPreview } from './outputStore';
import { PreviewMessage } from './protocol';
import { CompiledBuild, CompileState } from './types';

export class CompileManager implements vscode.Disposable {
    private panel?: PdfPreviewPanel;
    private cached?: StoredPreview;
    private revision = 0;
    private ready = false;
    private authenticationExpired = false;
    private disposed = false;
    private active?: Promise<void>;
    private pending = false;
    private pendingManual = false;
    private debounce?: NodeJS.Timeout;
    private controller?: AbortController;
    private cancellation?: vscode.CancellationTokenSource;
    private serverCompile = false;
    private stopping?: Promise<void>;
    private restored?: Promise<void>;
    private readonly store: OutputStore;
    private readonly output: vscode.OutputChannel;
    private readonly subscriptions: vscode.Disposable[] = [];
    private readonly project;
    private readonly key: string;
    private state: CompileState = 'idle';
    private message = 'Opening PDF preview…';

    constructor(private readonly context: vscode.ExtensionContext, private readonly api: BaseAPI,
        private readonly engine: SyncEngine, private readonly settings: SettingsManager,
        private readonly sessionCurrent: () => boolean, private readonly onAuthenticationExpired?: () => void) {
        this.project = { ...settings.getSettings()! };
        this.key = createHash('sha256').update(JSON.stringify([settings.getWorkspaceFolder().toString(),
            this.project.serverUrl, this.project.projectId])).digest('hex');
        this.store = new OutputStore(settings.getWorkspaceFolder(), this.project.serverUrl, this.project.projectId);
        this.output = vscode.window.createOutputChannel('LocalLeaf Compilation');
        this.subscriptions.push(vscode.workspace.onDidSaveTextDocument(document => {
            if (!this.panel || !this.ready || !this.current() || !/\.(tex|bib|sty|cls)$/i.test(document.uri.path)) return;
            const relative = getWorkspaceRelativePath(settings.getWorkspaceFolder(), document.uri);
            if (!relative || relative.toLowerCase().startsWith('.output/') || !vscode.workspace.getConfiguration('localleaf', settings.getWorkspaceFolder()).get('compileOnSave', true)) return;
            clearTimeout(this.debounce);
            this.debounce = setTimeout(() => { void this.compile(false); }, 750);
        }));
    }
    private current(): boolean { return !this.disposed && this.sessionCurrent(); }
    start(): void {
        if (this.ready || this.authenticationExpired || !this.current()) return;
        this.ready = true;
        if (this.panel) void this.compile(false);
    }
    private status(state: CompileState, message: string): void {
        if (!this.current()) return;
        this.state = state; this.message = message;
        this.panel?.setStatus(state, message);
    }
    private restore(): Promise<void> {
        return this.restored ??= (async () => {
            try {
                const preview = await this.store.restore();
                if (!this.current() || !preview) return;
                this.cached = preview; this.revision++;
                this.panel?.setPdf(preview.bytes, this.revision);
                this.status('ready', preview.build ? `Previous build · ${new Date(preview.build.createdAt).toLocaleString()}`
                    : 'Saved PDF · Recompile to restore SyncTeX');
            } catch (error) { this.status('failed', this.error(error)); }
        })();
    }
    get identityKey(): string { return this.key; }
    async preview(existingPanel?: vscode.WebviewPanel): Promise<void> {
        if (!this.current()) return;
        if (!this.panel) {
            const panel = new PdfPreviewPanel(this.context, this.key, this.project.projectName,
                message => this.receive(message).catch(error => { this.handleAuthenticationError(error); throw error; }), () => {
                    if (this.panel === panel) this.panel = undefined;
                    clearTimeout(this.debounce);
                    if (!this.pendingManual) this.pending = false;
                }, existingPanel);
            this.panel = panel;
            panel.setStatus(this.state, this.message);
            if (this.cached) panel.setPdf(this.cached.bytes, this.revision);
        } else this.panel.reveal();
        await this.restore();
        if (this.ready && this.current()) await this.compile(false);
    }
    compile(manual = true): Promise<void> {
        if (!this.current()) return Promise.resolve();
        if (this.stopping) return this.stopping.then(() => this.compile(manual));
        clearTimeout(this.debounce);
        if (!this.ready) {
            this.status('failed', this.authenticationExpired ? 'Overleaf session expired. Sign in again to compile.' : 'Waiting for initial synchronization.');
            return Promise.resolve();
        }
        if (this.active) {
            this.pending = true; this.pendingManual ||= manual;
            return this.active;
        }
        const operation = this.run(manual).then(async () => {
            this.active = undefined;
            await this.stopping;
            if (this.pending && this.current()) {
                const nextManual = this.pendingManual;
                this.pending = false; this.pendingManual = false;
                await this.compile(nextManual);
            }
        });
        this.active = operation;
        return operation;
    }
    private async run(manual: boolean): Promise<void> {
        const controller = new AbortController();
        const cancellation = new vscode.CancellationTokenSource();
        this.controller = controller; this.cancellation = cancellation;
        const current = () => this.current() && !controller.signal.aborted;
        try {
            await this.restore();
            if (manual) {
                this.status('synchronizing', 'Saving project documents…');
                for (const document of vscode.workspace.textDocuments) {
                    const relative = getWorkspaceRelativePath(this.settings.getWorkspaceFolder(), document.uri);
                    if (document.isDirty && relative && !/^\.(?:output|localleaf|git|vscode)(?:\/|$)/i.test(relative)) {
                        if (!(await document.save())) throw new Error(`Could not save ${document.fileName}.`);
                    }
                }
            }
            if (!current()) return;
            this.status('synchronizing', 'Waiting for Overleaf to confirm saved files…');
            const prepared = await this.engine.prepareForCompile(cancellation.token);
            if (!current()) return;
            if (!prepared.ready || !prepared.fingerprint) throw new Error(prepared.message || 'Synchronization is not ready.');
            const root = this.settings.getSettings()?.mainTex;
            if (!root) throw new Error('Set the main .tex document before compiling.');
            if (!manual && this.cached?.fingerprint === prepared.fingerprint && this.cached.build?.rootResourcePath === root) {
                this.status('ready', `PDF up to date · ${this.cached.build?.createdAt ? new Date(this.cached.build.createdAt).toLocaleString() : 'saved build'}`);
                return;
            }
            await this.store.ensureWritable(current);
            if (!current()) return;
            this.status('compiling', 'Compiling on Overleaf…');
            this.output.appendLine(`Compiling ${root} on ${this.project.serverUrl}`);
            const configured = vscode.workspace.getConfiguration('localleaf', this.settings.getWorkspaceFolder()).get<number>('compileTimeoutSeconds', 180);
            const timeout = Math.max(30, Math.min(1800, Number.isFinite(configured) ? configured : 180)) * 1000;
            this.serverCompile = true;
            const result = await this.api.compile.compileProject(this.project.projectId, root, { signal: controller.signal, timeoutMs: timeout });
            this.serverCompile = false;
            if (!current()) return;
            const log = result.artifacts.find(item => item.path === 'output.log');
            if (log) {
                const bytes = await this.api.compile.downloadCompileOutput(this.project.projectId, log, result.routing, controller.signal);
                if (!current()) return;
                await this.store.saveLog(bytes, current);
                this.output.replace(new TextDecoder().decode(bytes));
            } else {
                await this.store.saveLog(Buffer.from(`Overleaf compilation status: ${result.status}\nNo compilation log was returned.\n`), current);
            }
            if (result.status !== 'success') throw new Error(`Overleaf compilation ${result.status}. See the compilation log.`);
            const artifact = result.artifacts.find(item => item.path === 'output.pdf') ?? result.artifacts.find(item => item.type === 'pdf');
            if (!artifact) throw new Error('Compilation returned no PDF. See the compilation log.');
            const bytes = await this.api.compile.downloadCompileOutput(this.project.projectId, artifact, result.routing, controller.signal);
            if (!current()) return;
            const build: CompiledBuild = { buildId: result.routing.buildId, editorId: result.routing.editorId,
                clsiServerId: result.routing.clsiServerId, rootResourcePath: root, createdAt: new Date().toISOString() };
            await this.store.save(bytes, build, prepared.fingerprint, current);
            if (!current()) return;
            this.cached = { bytes, build, fingerprint: prepared.fingerprint };
            this.revision++;
            this.panel?.setPdf(bytes, this.revision);
            this.status('ready', `PDF saved to .output/output.pdf · ${new Date(build.createdAt).toLocaleTimeString()}`);
        } catch (error) {
            if (this.current()) {
                this.handleAuthenticationError(error);
                const message = controller.signal.aborted ? 'Compilation stopped.' : this.error(error);
                this.output.appendLine(message);
                this.status('failed', `${message}${this.cached ? ' Showing the previous PDF.' : ''}`);
                // A timed-out POST may still be compiling. Stop our build before allowing another one.
                if (this.serverCompile && !controller.signal.aborted) await this.stopServer();
                if (manual && !controller.signal.aborted) void vscode.window.showErrorMessage(`LocalLeaf: ${message}`, 'Show log')
                    .then(action => { if (action === 'Show log' && this.current()) void this.showLog(); });
            }
        } finally {
            this.serverCompile = false;
            if (this.controller === controller) this.controller = undefined;
            if (this.cancellation === cancellation) this.cancellation = undefined;
            cancellation.dispose();
        }
    }
    private stopServer(): Promise<void> {
        if (!this.stopping) {
            this.stopping = this.api.compile.stopCompile(this.project.projectId).catch(error => {
                if (!this.disposed) this.output.appendLine(`Could not stop server compilation: ${this.error(error)}`);
            }).finally(() => { this.stopping = undefined; });
        }
        return this.stopping;
    }
    async stop(): Promise<void> {
        clearTimeout(this.debounce);
        this.pending = false; this.pendingManual = false;
        this.cancellation?.cancel(); this.controller?.abort();
        if (this.serverCompile) await this.stopServer();
    }
    async showLog(): Promise<void> {
        try { this.output.replace(await this.store.readLog()); }
        catch (error) { this.output.appendLine(this.error(error)); }
        this.output.show(true);
    }
    async savePdf(): Promise<void> {
        await this.restore();
        if (!this.cached) throw new Error('Compile the project before saving a PDF.');
        const destination = await vscode.window.showSaveDialog({ defaultUri: this.store.pdfUri,
            filters: { PDF: ['pdf'] }, saveLabel: 'Save PDF' });
        if (!destination || !this.current()) return;
        if (destination.toString() === this.store.pdfUri.toString()) return; // Already persisted.
        const relative = getWorkspaceRelativePath(this.settings.getWorkspaceFolder(), destination);
        if (relative) await assertSafeWorkspacePath(this.settings.getWorkspaceFolder(), destination);
        await vscode.workspace.fs.writeFile(destination, this.cached.bytes);
    }
    async syncToPdf(): Promise<void> {
        const editor = vscode.window.activeTextEditor;
        if (!editor) throw new Error('Open a project source document first.');
        const relative = getWorkspaceRelativePath(this.settings.getWorkspaceFolder(), editor.document.uri);
            if (!relative || ![...this.engine.getFileTree().values()]
            .some(entry => entry.path === `/${relative}` && entry.type === 'doc')) throw new Error('The selected source is not part of the linked Overleaf project.');
        const line = editor.selection.active.line + 1;
        const column = editor.selection.active.character;
        await this.preview();
        const build = this.cached?.build;
        if (!build?.buildId || !this.current()) throw new Error('Recompile the project to obtain the build ID required for SyncTeX.');
        const revision = this.revision;
        const rootDirectory = path.posix.dirname(build.rootResourcePath);
        const file = rootDirectory !== '.' && relative.startsWith(rootDirectory + '/')
            ? rootDirectory + '/./' + relative.slice(rootDirectory.length + 1) : relative;
        const locations = await this.api.compile.syncCode(this.project.projectId, { file, line, column }, build)
            .catch(error => { this.handleAuthenticationError(error); throw error; });
        if (this.current() && this.revision === revision) this.panel?.forward(locations, revision);
    }
    private async receive(message: PreviewMessage): Promise<void> {
        if (!this.current()) return;
        if (message.type === 'action') {
            if (message.action === 'compile') await this.compile();
            else if (message.action === 'stop') await this.stop();
            else if (message.action === 'log') await this.showLog();
            else if (message.action === 'save') await this.savePdf();
        } else if (message.type === 'reverse') {
            const build = this.cached?.build;
            if (!build?.buildId || message.revision !== this.revision) throw new Error('Recompile the project to restore SyncTeX.');
            const source = await this.api.compile.syncPdf(this.project.projectId, message, build);
            if (!this.current() || this.revision !== message.revision) return;
            // SyncTeX may return harmless ./ segments, but traversal and absolute paths are never accepted.
            if (/^(?:[\\/]|[A-Za-z]:)/.test(source.file)) throw new Error('SyncTeX returned an absolute source path.');
            const relative = normalizeProjectPath(source.file.split('/').filter(segment => segment !== '.').join('/'), false);
            if (![...this.engine.getFileTree().values()].some(entry => entry.path === relative && entry.type === 'doc')) {
                throw new Error('SyncTeX returned a file outside the linked project.');
            }
            const uri = this.settings.getFilePath(relative);
            await assertSafeWorkspacePath(this.settings.getWorkspaceFolder(), uri);
            const document = await vscode.workspace.openTextDocument(uri);
            if (!this.current() || this.revision !== message.revision) return;
            if (source.line > document.lineCount) throw new Error('Source has changed since compilation. Recompile to update SyncTeX.');
            const column = Math.min(source.column, document.lineAt(source.line - 1).text.length);
            const position = new vscode.Position(source.line - 1, column);
            const existing = vscode.window.visibleTextEditors.find(editor => editor.document.uri.toString() === uri.toString());
            const editor = await vscode.window.showTextDocument(document, { viewColumn: existing?.viewColumn ?? vscode.ViewColumn.One });
            if (!this.current() || this.revision !== message.revision) return;
            editor.selection = new vscode.Selection(position, position);
            editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter);
        }
    }
    private error(error: unknown): string { return error instanceof Error ? error.message : String(error); }
    private handleAuthenticationError(error: unknown): void {
        if (this.current() && error && typeof error === 'object' && (error as { authError?: string }).authError === 'session_expired') {
            this.ready = false; this.authenticationExpired = true;
            this.onAuthenticationExpired?.();
        }
    }
    dispose(): void {
        if (this.disposed) return;
        void this.stop();
        this.disposed = true;
        this.subscriptions.forEach(item => item.dispose());
        this.panel?.dispose(); this.panel = undefined;
        this.output.dispose();
    }
}
