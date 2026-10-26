import * as vscode from 'vscode';
import { createNonce } from './webviewUtils';
import { HostMessage, isViewerState, PreviewMessage, ViewerState } from '../compile/protocol';
import { CompileState, PdfLocation } from '../compile/types';

export class PdfPreviewPanel implements vscode.Disposable {
    private readonly panel: vscode.WebviewPanel;
    private ready = false;
    private closed = false;
    private pdf?: HostMessage & { type: 'pdf' };
    private status: HostMessage & { type: 'status' } = { type: 'status', state: 'idle', message: 'Opening PDF preview…' };
    private state?: ViewerState;
    private renderedRevision?: number;
    private readonly disposables: vscode.Disposable[] = [];
    constructor(private readonly context: vscode.ExtensionContext, private readonly key: string, projectName: string,
        private readonly receive: (message: PreviewMessage) => Promise<void>, onClose: () => void,
        existingPanel?: vscode.WebviewPanel) {
        this.panel = existingPanel ?? vscode.window.createWebviewPanel('localleaf.pdfPreview', `PDF · ${projectName}`,
            { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true }, {
                enableScripts: true, retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources', 'pdfjs'),
                    vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdf-preview')],
            });
        this.panel.title = `PDF · ${projectName}`;
        this.panel.webview.options = { enableScripts: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'resources', 'pdfjs'),
                vscode.Uri.joinPath(context.extensionUri, 'dist', 'pdf-preview')] };
        const saved = context.workspaceState.get<unknown>(`pdfPreview.${key}`);
        if (isViewerState(saved)) this.state = { ...saved, sidebar: 0 };
        this.disposables.push(this.panel.webview.onDidReceiveMessage((value: unknown) => {
            void this.message(value).catch(error => vscode.window.showErrorMessage(`LocalLeaf PDF: ${String(error)}`));
        }), this.panel.onDidDispose(() => {
            this.closed = true;
            this.disposables.forEach(item => item.dispose());
            onClose();
        }));
        void this.html().then(html => { if (!this.closed) this.panel.webview.html = html; }, error => {
            if (!this.closed) this.setStatus('failed', `Unable to load bundled PDF viewer: ${String(error)}`);
        });
    }
    reveal(): void { this.panel.reveal(vscode.ViewColumn.Beside, true); }
    private async post(message: HostMessage): Promise<void> { if (!this.closed && this.ready) await this.panel.webview.postMessage(message); }
    setPdf(bytes: Uint8Array, revision: number): void {
        const buffer = new ArrayBuffer(bytes.byteLength);
        new Uint8Array(buffer).set(bytes);
        this.pdf = { type: 'pdf', bytes: buffer, revision };
        this.renderedRevision = undefined;
        void this.post(this.pdf);
    }
    setStatus(state: CompileState, message: string): void { this.status = { type: 'status', state, message }; void this.post(this.status); }
    forward(locations: PdfLocation[], revision: number): void {
        void this.post({ type: 'forward', locations, revision });
    }
    get displayedRevision(): number | undefined { return this.renderedRevision; }
    private async message(raw: unknown): Promise<void> {
        if (!raw || typeof raw !== 'object') return;
        const value = raw as PreviewMessage;
        if (value.type === 'ready') {
            // Hold updates until initialization is queued, then send the newest PDF
            // once. A restored disk PDF may arrive during this handshake.
            this.ready = false;
            await this.panel.webview.postMessage({ type: 'init', state: this.state, projectKey: this.key } satisfies HostMessage);
            if (this.closed) return;
            this.ready = true;
            void this.post(this.status);
            if (this.pdf) void this.post(this.pdf);
        } else if (value.type === 'state' && isViewerState(value.state)) {
            this.state = value.state;
            await this.context.workspaceState.update(`pdfPreview.${this.key}`, this.state);
        } else if (value.type === 'rendered' && value.revision === this.pdf?.revision) {
            this.renderedRevision = value.revision;
        } else if (value.type === 'action' && ['compile', 'stop', 'log', 'save'].includes(value.action)) {
            await this.receive(value);
        } else if (value.type === 'reverse' && value.revision === this.renderedRevision
            && Number.isInteger(value.page) && value.page >= 1 && value.page <= 1_000_000
            && [value.h, value.v].every(number => Number.isFinite(number) && Math.abs(number) < 1e9)) {
            await this.receive(value);
        } else if (value.type === 'error' && typeof value.message === 'string') {
            this.setStatus('failed', value.message.slice(0, 1000));
        }
    }
    private async html(): Promise<string> {
        const webview = this.panel.webview;
        const root = vscode.Uri.joinPath(this.context.extensionUri, 'resources', 'pdfjs');
        const resource = (...parts: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(root, ...parts)).toString();
        const nonce = createNonce();
        let html = new TextDecoder().decode(await vscode.workspace.fs.readFile(vscode.Uri.joinPath(root, 'web', 'viewer.html')));
        html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
            .replace(/href="(locale\/locale.json|viewer.css)"/g, (_match, value: string) => `href="${resource('web', value)}"`);
        const assetRoot = resource('web', '');
        const script = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf-preview', 'index.js'));
        const style = webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, 'dist', 'pdf-preview', 'index.css'));
        const csp = `default-src 'none'; script-src 'nonce-${nonce}' ${webview.cspSource} 'wasm-unsafe-eval'; worker-src blob:; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} blob: data:; font-src ${webview.cspSource} data:; connect-src ${webview.cspSource} blob:; base-uri 'none'; form-action 'none';`;
        html = html.replace('<head>', `<head><meta http-equiv="Content-Security-Policy" content="${csp}">`)
            .replace('</head>', `<link rel="stylesheet" href="${style}"><script type="module" nonce="${nonce}" src="${script}"></script></head>`)
            .replace('<div id="outerContainer">', `<header id="localleafToolbar" data-viewer="${resource('web', 'viewer.mjs')}" data-pdf="${resource('build', 'pdf.mjs')}" data-worker="${resource('build', 'pdf.worker.mjs')}" data-assets="${assetRoot}">
                <button id="localleafCompile" type="button">Recompile</button><button id="localleafStop" type="button" disabled>Stop</button>
                <button id="localleafLog" type="button">Show log</button><button id="localleafSave" type="button">Save PDF</button>
                <span id="localleafStatus" role="status" aria-live="polite">Opening PDF preview…</span></header><div id="outerContainer">`);
        return html;
    }
    dispose(): void { if (!this.closed) this.panel.dispose(); }
}
