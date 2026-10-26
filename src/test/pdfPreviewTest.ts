import { BaseAPI, SyncEngine, TestUri, mockVscode } from './nativeSyncFixture';
import type { BaseAPI as API } from '../api/base';
import type { OutputStore as Store } from '../compile/outputStore';
import { CompileAPI } from '../compile/compileApi';
import { isViewerState } from '../compile/protocol';
import { assertPdfBytes } from '../compile/pdfValidation';
import { makePreviewPdf } from './pdfFixture';
import { createTemporaryWorkspace, cleanTemporaryWorkspaces } from './temporaryWorkspace';
import { runStandaloneTest } from './standaloneRunner';
import * as assert from 'node:assert/strict';
import * as http from 'node:http';
import { once } from 'node:events';
import { promises as fs } from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Response } from 'node-fetch';

const Module = require('module');
const original = Module._load;
Module._load = function(request: string, parent: unknown, main: boolean) {
    return request === 'vscode' ? mockVscode : original(request, parent, main);
};
const { OutputStore } = require('../compile/outputStore') as { OutputStore: typeof Store };
const { SettingsManager } = require('../utils/settingsManager') as typeof import('../utils/settingsManager');
const { PdfPreviewPanel } = require('../views/pdfPreviewPanel') as typeof import('../views/pdfPreviewPanel');
Module._load = original;

async function transport(): Promise<void> {
    const pdf = makePreviewPdf();
    const requests: Array<{ url: string; headers: http.IncomingHttpHeaders; body: string }> = [];
    let status = 200;
    let partial = false;
    let malformed = false;
    let wait = false;
    const server = http.createServer((request, response) => {
        let body = '';
        request.on('data', chunk => { body += String(chunk); });
        request.on('end', () => {
            const url = request.url!;
            requests.push({ url, headers: request.headers, body });
            if (wait) return;
            if (status !== 200) { response.writeHead(status).end('failure'); return; }
            if (url.includes('/compile/stop')) { response.end('{}'); return; }
            if (url.includes('/compile?')) {
                response.setHeader('Content-Type', 'application/json');
                response.end(JSON.stringify({ status: 'success', compileGroup: 'standard', clsiServerId: 'shard', outputFiles: [
                    { path: 'output.pdf', type: 'pdf', build: 'build-1', editorId: 'editor-1',
                        url: malformed ? 'https://untrusted.invalid/output.pdf' : 'project/project-id/build/build-1/output/output.pdf' },
                ] })); return;
            }
            if (url.includes('/sync/code')) { response.end(JSON.stringify({ pdf: [{ page: 1, h: 10, v: 20, width: 30, height: 10 }] })); return; }
            if (url.includes('/sync/pdf')) { response.end(JSON.stringify({ code: [{ file: 'nested/./main.tex', line: 1, column: 0 }] })); return; }
            if (partial) {
                const start = Number(request.headers.range?.match(/bytes=(\d+)/)?.[1] ?? 0);
                const end = Math.min(start + 127, pdf.length - 1);
                response.writeHead(206, { 'Content-Range': `bytes ${start}-${end}/${pdf.length}`, ETag: '"fixture"' }).end(pdf.subarray(start, end + 1));
            } else response.writeHead(200, { 'Content-Type': 'application/pdf' }).end(pdf);
        });
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const base = `http://127.0.0.1:${(server.address() as import('net').AddressInfo).port}/overleaf`;
    const api: API = new BaseAPI(base);
    api.setIdentity({ cookies: 'synthetic-session=1', csrfToken: 'synthetic-csrf' });
    try {
        const result = await api.compile.compileProject('project-id', 'nested/main.tex');
        assert.equal(requests[0].url, '/overleaf/project/project-id/compile?auto_compile=true');
        assert.equal(requests[0].headers.cookie, 'synthetic-session=1');
        assert.equal(requests[0].headers['x-csrf-token'], 'synthetic-csrf');
        assert.equal(JSON.parse(requests[0].body).rootResourcePath, 'nested/main.tex');
        assert.equal(result.routing.buildId, 'build-1');
        assert.throws(() => assertPdfBytes(Buffer.from('%PDF-1.7\ntruncated')), /invalid or incomplete/);
        assert.throws(() => assertPdfBytes(Buffer.from('<html>Login</html>')), /invalid or incomplete/);
        assert.deepEqual(Buffer.from(await api.compile.downloadCompileOutput('project-id', result.artifacts[0], {})), pdf);
        partial = true;
        assert.deepEqual(Buffer.from(await api.compile.downloadCompileOutput('project-id', result.artifacts[0], {})), pdf);
        assert.ok(requests.some(item => item.headers.range));
        assert.ok(requests.some(item => item.headers['if-range'] === '"fixture"'));
        await api.compile.syncCode('project-id', { file: 'nested/./a & λ.tex', line: 1, column: 0 }, result.routing);
        const query = new URL(requests.at(-1)!.url, base).searchParams;
        assert.equal(query.get('file'), 'nested/./a & λ.tex'); assert.equal(query.get('line'), '1');
        assert.equal(query.get('column'), '0'); assert.equal(query.get('buildId'), 'build-1');
        assert.equal(query.get('editorId'), 'editor-1'); assert.equal(query.get('clsiserverid'), 'shard');
        assert.deepEqual(await api.compile.syncPdf('project-id', { page: 1, h: 1.234, v: 10 }, result.routing),
            { file: 'nested/./main.tex', line: 1, column: 0 });
        await api.compile.stopCompile('project-id');
        assert.match(requests.at(-1)!.url, /\/compile\/stop$/);
        malformed = true;
        await assert.rejects(api.compile.compileProject('project-id', 'main.tex'), /outside the linked project/);
        malformed = false; status = 401;
        await assert.rejects(api.compile.compileProject('project-id', 'main.tex'), /Session expired/);
        status = 404;
        await assert.rejects(api.compile.syncPdf('project-id', { page: 1, h: 1, v: 1 }, result.routing), /expired.*Recompile/);
        status = 200; wait = true;
        const controller = new AbortController();
        const cancelled = api.compile.compileProject('project-id', 'main.tex', { signal: controller.signal });
        setTimeout(() => controller.abort(), 50);
        await assert.rejects(cancelled, /timed out|cancelled|abort/i);
        const timed = api.compile.compileProject('project-id', 'main.tex', { timeoutMs: 20 });
        await assert.rejects(timed, /timed out/i);
        wait = false;
    } finally { api.dispose(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }

    const captures: Array<{ options: import('node-fetch').RequestInit; absolute?: string }> = [];
    const cdn = new CompileAPI('https://overleaf.example/', () => ({ cookies: 'SECRET', csrfToken: 'SECRET' }),
        async (_route, options, _maximum, _timeout, _signal, absolute) => {
            captures.push({ options, absolute }); return new Response(pdf);
        }, async () => { throw new Error('HTTP error'); });
    await cdn.downloadCompileOutput('p', { path: 'output.pdf', type: 'pdf', url: 'project/p/build/b/output/output.pdf' },
        { pdfDownloadDomain: 'https://cdn.example', clsiServerId: 'shard', compileGroup: 'standard' });
    assert.deepEqual(captures[0].options.headers, {});
    assert.match(captures[0].absolute!, /^https:\/\/cdn.example\/project\/p\//);
    assert.doesNotMatch(JSON.stringify(captures), /SECRET/);
    await assert.rejects(cdn.downloadCompileOutput('p', { path: 'output.pdf', type: 'pdf', url: 'project/other/output.pdf' }, {}), /outside/);
    const broken = new CompileAPI('https://overleaf.example/', () => ({ cookies: 'SECRET', csrfToken: 'SECRET' }),
        async () => { throw new Error('request https://cdn.example/output?signature=SECRET failed'); }, async () => { throw new Error('HTTP error'); });
    await assert.rejects(broken.downloadCompileOutput('p', { path: 'output.pdf', type: 'pdf', url: 'project/p/output.pdf' }, {}),
        error => error instanceof Error && !error.message.includes('SECRET') && /download failed/.test(error.message));
}

async function storage(): Promise<void> {
    const root = await createTemporaryWorkspace('pdf-output');
    const store = new OutputStore(TestUri.file(root) as any, 'https://example.test', 'project');
    const pdf = makePreviewPdf();
    const build = { buildId: 'b', rootResourcePath: 'main.tex', createdAt: new Date().toISOString() };
    assert.equal(await store.restore(), undefined);
    await store.saveLog(Buffer.from('first log'), () => true);
    await fs.writeFile(path.join(root, '.output', 'unrelated.txt'), 'keep me');
    await store.save(pdf, build, 'fingerprint', () => true);
    assert.deepEqual(Buffer.from((await store.restore())!.bytes), pdf);
    assert.equal((await store.restore())!.build?.buildId, 'b');
    await store.saveLog(Buffer.from('failed build'), () => true);
    assert.deepEqual(Buffer.from((await store.restore())!.bytes), pdf, 'failed attempts preserve the PDF');
    assert.equal(await store.readLog(), 'failed build');
    assert.equal(await fs.readFile(path.join(root, '.output', 'unrelated.txt'), 'utf8'), 'keep me');
    await fs.writeFile(path.join(root, '.output', 'output.pdf'), makePreviewPdf('different'));
    assert.equal((await store.restore())!.build, undefined, 'hash mismatch disables SyncTeX');
    const cancelled = await fs.readFile(path.join(root, '.output', 'output.pdf'));
    await assert.rejects(store.save(pdf, build, 'next', () => false), /cancelled/);
    assert.deepEqual(await fs.readFile(path.join(root, '.output', 'output.pdf')), cancelled);
    const other = new OutputStore(TestUri.file(root) as any, 'https://example.test', 'other-project');
    await assert.rejects(other.save(pdf, build, 'next', () => true), /another project/);
    const foreign = await createTemporaryWorkspace('pdf-conflict');
    await fs.mkdir(path.join(foreign, '.output')); await fs.writeFile(path.join(foreign, '.output', 'output.pdf'), pdf);
    const conflict = new OutputStore(TestUri.file(foreign) as any, 'https://example.test', 'project');
    await assert.rejects(conflict.save(pdf, build, 'next', () => true), /unowned/);
    assert.deepEqual(await fs.readFile(path.join(foreign, '.output', 'output.pdf')), pdf);
}

async function barrier(): Promise<void> {
    const root = await createTemporaryWorkspace('pdf-barrier');
    await fs.writeFile(path.join(root, 'main.tex'), 'saved revision');
    await fs.mkdir(path.join(root, 'sections'));
    await fs.writeFile(path.join(root, 'sections', 'background.tex'), 'nested revision');
    await fs.mkdir(path.join(root, '.output')); await fs.writeFile(path.join(root, '.output', 'output.pdf'), makePreviewPdf());
    const project = { _id: 'p', rootFolder: [{ _id: 'root', docs: [{ _id: 'doc', name: 'main.tex' }], fileRefs: [],
        folders: [{ _id: 'sections', name: 'sections', docs: [{ _id: 'background', name: 'background.tex' }], fileRefs: [], folders: [] }] }] };
    let autoSync = true;
    const paths = SettingsManager.getInstance(TestUri.file(root) as any);
    const settings = { getWorkspaceFolder: () => TestUri.file(root), getSettings: () => ({ projectId: 'p', autoSync }),
        getFilePath: (relative: string) => paths.getFilePath(relative),
        getRelativePath: (uri: any) => paths.getRelativePath(uri) };
    assert.throws(() => paths.getFilePath('/'), /workspace root/, 'entity path validation must continue rejecting the root');
    const engine: any = new SyncEngine({ dispose() {} }, settings);
    engine.project = project; engine.buildFileTree(project);
    // A successful pull records the root and nested folders in the synchronized baseline.
    engine.setBaseContent('/', Buffer.alloc(0));
    engine.setBaseContent('/sections/', Buffer.alloc(0));
    engine.baseHashes.set('/sections/background.tex', createHash('sha256').update('nested revision').digest('hex'));
    engine.baseHashes.set('/main.tex', createHash('sha256').update('old').digest('hex'));
    let release!: () => void;
    const acknowledged = new Promise<void>(resolve => { release = resolve; });
    let uploading = false;
    engine.handleLocalFileChange = async () => {
        uploading = true; await acknowledged;
        engine.baseHashes.set('/main.tex', createHash('sha256').update('saved revision').digest('hex'));
    };
    const token = { isCancellationRequested: false };
    let settled = false;
    const preparing = engine.prepareForCompile(token).then((result: any) => { settled = true; return result; });
    while (!uploading) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(settled, false, 'must wait for server-applied acknowledgement');
    release();
    const prepared = await preparing;
    assert.equal(prepared.ready, true, prepared.message);
    engine.pendingConflicts.set('/main.tex', {});
    assert.equal((await engine.prepareForCompile(token)).ready, false);
    engine.pendingConflicts.clear();
    assert.equal((await engine.prepareForCompile({ isCancellationRequested: true })).ready, false);
    engine.fileErrors.set('/main.tex', 'upload rejected');
    assert.equal((await engine.prepareForCompile(token)).ready, false, 'reported upload failures must block compilation');
    engine.fileErrors.clear();
    autoSync = false;
    await fs.writeFile(path.join(root, 'main.tex'), 'unsynchronized revision');
    assert.match((await engine.prepareForCompile(token)).message, /Sync Now/);
    autoSync = true;
    engine.handleLocalFileChange = async () => {}; // An upload handler may resolve without confirming its bytes.
    assert.equal((await engine.prepareForCompile(token)).ready, false, 'an idle status or resolved upload is insufficient');
    await fs.writeFile(path.join(root, '.leafignore'), '!/.output/**\n');
    await engine.ignoreParser.load();
    assert.equal(engine.shouldSync('/.output/output.pdf'), false);
    assert.equal(engine.shouldSync('/.OUTPUT/output.log'), false);
    engine.disconnect();
}

async function startupHandshake(): Promise<void> {
    const sent: any[] = [];
    let release!: () => void;
    const initialization = new Promise<void>(resolve => { release = resolve; });
    const panel: any = Object.create(PdfPreviewPanel.prototype);
    Object.assign(panel, { closed: false, ready: false, key: 'test',
        status: { type: 'status', state: 'idle', message: 'opening' },
        panel: { webview: { postMessage(message: any) {
            sent.push(message);
            return message.type === 'init' ? initialization : Promise.resolve(true);
        } } } });
    const starting = panel.message({ type: 'ready' });
    panel.setPdf(makePreviewPdf('disk restoration'), 1);
    panel.setPdf(makePreviewPdf('latest build'), 2);
    assert.deepEqual(sent.map(message => message.type), ['init'], 'restoration must wait for viewer initialization');
    panel.setStatus('ready', 'latest status');
    release(); await starting;
    assert.deepEqual(sent.map(message => message.type), ['init', 'status', 'pdf']);
    assert.equal(sent[1].message, 'latest status');
    assert.equal(sent[2].revision, 2, 'startup must send only the most recent PDF once');
    assert.deepEqual(Buffer.from(sent[2].bytes), makePreviewPdf('latest build'));
}

runStandaloneTest(async () => {
    try {
        await transport(); await storage(); await barrier(); await startupHandshake();
        assert.equal(isViewerState({ page: 1, left: 0, top: 0, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0, sidebar: 0, cursor: 0 }), true);
        assert.equal(isViewerState({ page: -1 }), false);
        console.log('PDF transport, persistent ownership, interrupted writes, synchronization barrier, and protocol checks passed.');
    } finally { await cleanTemporaryWorkspaces(); }
});
