import * as vscode from 'vscode';
import * as path from 'path';
import { promises as fs } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { assertSafeWorkspacePath } from '../utils/pathSafety';
import { MAX_REMOTE_FILE_BYTES } from '../utils/remoteValidation';
import { CompiledBuild } from './types';
import { assertPdfBytes } from './pdfValidation';

interface Manifest {
    version: 1;
    owner: 'localleaf';
    serverUrl: string;
    projectId: string;
    workspaceUri: string;
    pdfHash?: string;
    fingerprint?: string;
    build?: CompiledBuild;
}
export interface StoredPreview { bytes: Uint8Array; build?: CompiledBuild; fingerprint?: string }
export const pdfHash = (bytes: Uint8Array): string => createHash('sha256').update(bytes).digest('hex');

/** Owns exactly three files. Other files in .output are never removed. */
export class OutputStore {
    private mutation: Promise<unknown> = Promise.resolve();
    private readonly directory: vscode.Uri;
    constructor(private readonly workspace: vscode.Uri, private readonly serverUrl: string, private readonly projectId: string) {
        this.directory = vscode.Uri.joinPath(workspace, '.output');
    }
    private uri(name: string): vscode.Uri { return vscode.Uri.joinPath(this.directory, name); }
    private fresh(): Manifest {
        return { version: 1, owner: 'localleaf', serverUrl: this.serverUrl, projectId: this.projectId, workspaceUri: this.workspace.toString() };
    }
    private async read(name: string, maximum: number): Promise<Buffer | undefined> {
        const uri = this.uri(name);
        await assertSafeWorkspacePath(this.workspace, uri);
        try {
            const stat = await fs.lstat(uri.fsPath);
            if (!stat.isFile() || stat.size > maximum) throw new Error(`Invalid or oversized output file: ${uri.fsPath}`);
            return await fs.readFile(uri.fsPath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
            throw error;
        }
    }
    private async manifest(): Promise<Manifest | undefined> {
        const bytes = await this.read('.localleaf-preview.json', 64 * 1024);
        if (!bytes) return undefined;
        let value: Manifest;
        try { value = JSON.parse(bytes.toString('utf8')) as Manifest; }
        catch { throw new Error('Invalid .output/.localleaf-preview.json. Move the conflicting output files before compiling.'); }
        const expected = this.fresh();
        if (!value || value.version !== 1 || value.owner !== expected.owner || value.serverUrl !== expected.serverUrl
            || value.projectId !== expected.projectId || value.workspaceUri !== expected.workspaceUri) {
            throw new Error('.output belongs to another project. Move the conflicting output files before compiling.');
        }
        if (value.build && (typeof value.build.rootResourcePath !== 'string' || typeof value.build.createdAt !== 'string'
            || !Number.isFinite(Date.parse(value.build.createdAt))
            || ![value.build.buildId, value.build.editorId, value.build.clsiServerId].every(item => item === undefined
                || (typeof item === 'string' && item.length <= 8192 && !/[\r\n\0]/.test(item))))) {
            throw new Error('Invalid saved PDF build metadata.');
        }
        return value;
    }
    private async claim(current: () => boolean): Promise<Manifest> {
        await assertSafeWorkspacePath(this.workspace, this.directory);
        await fs.mkdir(this.directory.fsPath, { recursive: true });
        const existing = await this.manifest();
        if (existing) return existing;
        for (const name of ['output.pdf', 'output.log']) {
            if (await this.read(name, MAX_REMOTE_FILE_BYTES)) throw new Error(`Refusing to overwrite unowned .output/${name}. Move it before compiling.`);
        }
        const manifest = this.fresh();
        await this.atomic('.localleaf-preview.json', Buffer.from(JSON.stringify(manifest)), current);
        return manifest;
    }
    private async atomic(name: string, bytes: Uint8Array, current: () => boolean): Promise<void> {
        const destination = this.uri(name);
        await assertSafeWorkspacePath(this.workspace, destination);
        const temporary = this.uri(`${name}.${randomUUID()}.tmp`);
        const handle = await fs.open(temporary.fsPath, 'wx');
        try {
            await handle.writeFile(bytes);
            await handle.sync();
        } finally { await handle.close(); }
        try {
            if (!current()) throw new Error('PDF output cancelled because the project session changed.');
            await assertSafeWorkspacePath(this.workspace, destination);
            await fs.rename(temporary.fsPath, destination.fsPath);
        } finally { await fs.unlink(temporary.fsPath).catch(() => undefined); }
    }
    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.mutation.then(operation);
        this.mutation = result.catch(() => undefined);
        return result;
    }
    restore(): Promise<StoredPreview | undefined> {
        return this.enqueue(async () => {
            const manifest = await this.manifest();
            if (!manifest) return undefined;
            const bytes = await this.read('output.pdf', MAX_REMOTE_FILE_BYTES);
            if (!bytes) return undefined;
            assertPdfBytes(bytes);
            const valid = manifest.pdfHash === pdfHash(bytes);
            return { bytes, build: valid ? manifest.build : undefined, fingerprint: valid ? manifest.fingerprint : undefined };
        });
    }
    saveLog(log: Uint8Array, current: () => boolean): Promise<void> {
        return this.enqueue(async () => {
            await this.claim(current);
            await this.atomic('output.log', log, current);
        });
    }
    ensureWritable(current: () => boolean): Promise<void> {
        return this.enqueue(async () => { await this.claim(current); });
    }
    save(bytes: Uint8Array, build: CompiledBuild, fingerprint: string, current: () => boolean): Promise<void> {
        return this.enqueue(async () => {
            if (bytes.byteLength > MAX_REMOTE_FILE_BYTES) throw new Error('Cannot save oversized PDF output.');
            assertPdfBytes(bytes);
            await this.claim(current);
            await this.atomic('output.pdf', bytes, current);
            await this.atomic('.localleaf-preview.json', Buffer.from(JSON.stringify({ ...this.fresh(), build,
                fingerprint, pdfHash: pdfHash(bytes) }, null, 2)), current);
        });
    }
    async readLog(): Promise<string> { return (await this.read('output.log', MAX_REMOTE_FILE_BYTES))?.toString('utf8') ?? ''; }
    get pdfUri(): vscode.Uri { return this.uri('output.pdf'); }
    get outputDirectory(): string { return path.basename(this.directory.fsPath); }
}
