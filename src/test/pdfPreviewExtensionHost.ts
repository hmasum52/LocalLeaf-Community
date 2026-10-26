/** Runs inside an isolated real VS Code extension host against a synthetic HTTP compiler. */
import * as vscode from 'vscode';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { BaseAPI } from '../api/base';
import { CompileManager } from '../compile/compileManager';
import { makePreviewPdf } from './pdfFixture';
import type { SyncEngine } from '../sync/syncEngine';
import type { SettingsManager } from '../utils/settingsManager';
import type { PreviewMessage } from '../compile/protocol';

async function until(check: () => boolean | Promise<boolean>, label: string): Promise<void> {
    const deadline = Date.now() + 30_000;
    while (Date.now() < deadline) {
        if (await check()) return;
        await new Promise(resolve => setTimeout(resolve, 50));
    }
    throw new Error(`Timed out waiting for ${label}`);
}

export async function run(): Promise<void> {
    const root = vscode.workspace.workspaceFolders![0].uri;
    const report = path.join(root.fsPath, 'integration-result.json');
    const checks: string[] = [];
    let compileCount = 0;
    let stopCount = 0;
    let failed = false;
    let hold = false;
    const held: http.ServerResponse[] = [];
    let pdf = makePreviewPdf(undefined, { openOutline: true });
    const server = http.createServer((request, response) => {
        request.resume();
        const url = request.url!;
        response.setHeader('Content-Type', 'application/json');
        if (url.includes('/compile/stop')) {
            stopCount++;
            held.splice(0).forEach(item => item.end(JSON.stringify({ status: 'failure', outputFiles: [] })));
            response.end('{}');
        } else if (url.includes('/compile?')) {
            compileCount++;
            if (hold) { held.push(response); return; }
            pdf = makePreviewPdf(`Compilation ${compileCount}`, { openOutline: true });
            response.end(JSON.stringify({ status: failed ? 'failure' : 'success', outputFiles: [
                { path: 'output.pdf', type: 'pdf', build: `build-${compileCount}`, url: `project/p/build/build-${compileCount}/output/output.pdf` },
                { path: 'output.log', type: 'log', url: `project/p/build/build-${compileCount}/output/output.log` },
            ] }));
        } else if (url.endsWith('output.pdf')) response.end(pdf);
        else if (url.endsWith('output.log')) response.end(failed ? 'Synthetic compiler failure' : 'Successful synthetic compilation');
        else response.writeHead(404).end();
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    const api = new BaseAPI(base).setIdentity({ cookies: 'synthetic=1', csrfToken: 'synthetic' });
    const values = new Map<string, unknown>();
    const packagedRoot = process.env.LOCALLEAF_PACKAGED_ROOT!;
    const context = { extensionUri: vscode.Uri.file(packagedRoot), workspaceState: {
        get: (key: string) => values.get(key), update: async (key: string, value: unknown) => { values.set(key, value); },
    } } as unknown as vscode.ExtensionContext;
    const settings = { getWorkspaceFolder: () => root, getSettings: () => ({
        projectName: 'PDF integration', projectId: 'p', serverUrl: base, mainTex: 'main.tex', autoSync: true,
    }), getFilePath: (file: string) => vscode.Uri.joinPath(root, file.replace(/^\//, '')) } as unknown as SettingsManager;
    const engine = { prepareForCompile: async () => ({ ready: true,
        fingerprint: createHash('sha256').update(await fs.readFile(path.join(root.fsPath, 'main.tex'))).digest('hex') }),
        getFileTree: () => new Map([['d', { path: '/main.tex', id: 'd', type: 'doc' }]]),
    } as unknown as SyncEngine;
    let current = true;
    let manager: CompileManager | undefined;
    try {
        const extension = vscode.extensions.getExtension('victorstoica114.localleaf-community');
        assert.ok(extension, 'packaged extension must be loaded');
        await extension.activate();
        const commands = await vscode.commands.getCommands(true);
        for (const command of ['previewPdf', 'compileProject', 'stopCompile', 'syncToPdf', 'showCompileLog', 'savePdf']) {
            assert.ok(commands.includes(`localleaf.${command}`), `Missing command ${command}`);
        }
        checks.push('Installed package activates and registers all six commands');
        const latexWorkshop = vscode.extensions.getExtension('James-Yu.latex-workshop');
        assert.ok(latexWorkshop, 'LaTeX Workshop must coexist in the isolated host');
        await latexWorkshop.activate();
        assert.ok(latexWorkshop.isActive);
        checks.push('LaTeX Workshop active alongside LocalLeaf');
        manager = new CompileManager(context, api, engine, settings, () => current);
        manager.start();
        values.set(`pdfPreview.${manager.identityKey}`, { page: 2, left: 0, top: 0, scale: 'page-width',
            rotation: 0, scrollMode: 0, spreadMode: 0, sidebar: 2, cursor: 0 });
        const messages: PreviewMessage[] = [];
        const opening = manager.preview();
        const panel: vscode.WebviewPanel = (manager as any).panel.panel;
        panel.webview.onDidReceiveMessage(message => {
            messages.push(message);
            void fs.writeFile(path.join(root.fsPath, 'viewer-messages.json'), JSON.stringify(messages, null, 2));
        });
        void fs.writeFile(path.join(root.fsPath, 'viewer.html'), panel.webview.html);
        await opening;
        await until(() => messages.some(message => message.type === 'rendered' && message.revision === 1),
            `real webview PDF rendering (visible=${panel.visible}; messages=${JSON.stringify(messages)})`);
        assert.ok(!messages.some(message => message.type === 'error'), JSON.stringify(messages));
        assert.ok((await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'))).equals(pdf));
        checks.push('Real VS Code webview renders packaged modern PDF.js and blob worker; persists output');
        await until(() => messages.some(message => message.type === 'state' && message.state.sidebar === 0 && message.state.page === 2),
            'closed sidebar and restored reading position despite stale open-outline preferences');
        checks.push('New preview ignores old open-sidebar preferences while restoring the saved page');
        panel.webview.html += '\n<!-- exercise webview reload -->';
        await until(() => messages.filter(message => message.type === 'rendered' && message.revision === 1).length >= 2, 'binary PDF resend after webview reload');
        checks.push('Webview reload restores PDF bytes through the ready handshake');
        const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(root, 'main.tex'));
        const edit = new vscode.WorkspaceEdit();
        edit.insert(document.uri, new vscode.Position(0, 0), '% saved change\n');
        await vscode.workspace.applyEdit(edit); await document.save();
        await until(() => compileCount === 2 && messages.some(message => message.type === 'rendered' && message.revision === 2), 'compile on save');
        checks.push('Saving an editor document triggers compilation and viewer refresh');
        hold = true;
        const beforeCoalesce = compileCount;
        const compiling = manager.compile();
        await until(() => compileCount === beforeCoalesce + 1, 'held compilation for queue test');
        const queuedOne = manager.compile();
        const queuedTwo = manager.compile();
        hold = false;
        held.splice(0).forEach(response => response.end(JSON.stringify({ status: 'success', outputFiles: [
            { path: 'output.pdf', type: 'pdf', build: `build-${compileCount}`, url: `project/p/build/build-${compileCount}/output/output.pdf` },
        ] })));
        await Promise.all([compiling, queuedOne, queuedTwo]);
        assert.equal(compileCount, beforeCoalesce + 2, 'rapid requests must coalesce into a single pending rebuild');
        checks.push('Repeated compile requests coalesce into one pending rebuild');
        const beforeFailure = await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'));
        failed = true;
        await manager.compile(false);
        // Force changed saved input for the automatic failure case.
        await fs.appendFile(path.join(root.fsPath, 'main.tex'), '% compiler error\n');
        await manager.compile(false);
        assert.ok((await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'))).equals(beforeFailure));
        assert.match(await fs.readFile(path.join(root.fsPath, '.output', 'output.log'), 'utf8'), /failure/);
        checks.push('Failed compilation preserves previous PDF and writes latest log');
        failed = false; hold = true;
        const beforeStop = compileCount;
        const active = manager.compile(false);
        await until(() => compileCount > beforeStop, 'owned server compilation');
        await manager.stop(); await active;
        assert.equal(stopCount, 1);
        assert.ok((await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'))).equals(beforeFailure));
        checks.push('Stop cancels an owned compilation without replacing the PDF');
        hold = false;
        manager.dispose(); manager = undefined;
        manager = new CompileManager(context, api, engine, settings, () => current);
        const restoreMessages: PreviewMessage[] = [];
        const restoring = manager.preview(); // Not started: cached viewing must work without a server request.
        const restoredPanel: vscode.WebviewPanel = (manager as any).panel.panel;
        restoredPanel.webview.onDidReceiveMessage(message => restoreMessages.push(message));
        const beforeRestore = compileCount;
        await restoring;
        await until(() => restoreMessages.some(message => message.type === 'rendered'), 'persisted PDF rendering');
        assert.equal(compileCount, beforeRestore);
        checks.push('New session restores the persisted PDF without recompiling');
        manager.start();
        await (manager as any).active;
        hold = true;
        await fs.appendFile(path.join(root.fsPath, 'main.tex'), '% project switch\n');
        const beforeSwitch = await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'));
        const countBeforeSwitch = compileCount;
        const switching = manager.compile(false);
        await until(() => compileCount > countBeforeSwitch, 'compilation before project switch');
        current = false;
        manager.dispose(); manager = undefined;
        held.splice(0).forEach(response => response.end(JSON.stringify({ status: 'success', outputFiles: [] })));
        await switching;
        assert.ok((await fs.readFile(path.join(root.fsPath, '.output', 'output.pdf'))).equals(beforeSwitch));
        checks.push('Project disposal discards pending responses without overwriting output');
        await fs.writeFile(report, JSON.stringify({ passed: true, vscode: vscode.version, checks }, null, 2));
        console.log('PDF extension-host integration passed:', checks);
    } catch (error) {
        await fs.writeFile(report, JSON.stringify({ passed: false, vscode: vscode.version, checks, error: String(error), stack: (error as Error).stack }, null, 2));
        throw error;
    } finally {
        current = false; manager?.dispose(); api.dispose();
        held.forEach(response => response.destroy()); server.closeAllConnections();
        await new Promise<void>(resolve => server.close(() => resolve()));
    }
}
