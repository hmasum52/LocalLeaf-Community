// Local harness for the actual packaged webview HTML, adapter, assets and worker.
const http = require('node:http');
const fs = require('node:fs/promises');
const path = require('node:path');
const { TestUri, mockVscode } = require('../out/test/nativeSyncFixture');
const Module = require('node:module');
const original = Module._load;
Module._load = function (name, parent, main) { return name === 'vscode' ? mockVscode : original(name, parent, main); };
const { PdfPreviewPanel } = require('../out/views/pdfPreviewPanel');
Module._load = original;
const { makePreviewPdf } = require('../out/test/pdfFixture');
const root = path.resolve(__dirname, '..');
let html;
const server = http.createServer(async (request, response) => {
    try {
        if (new URL(request.url, 'http://localhost').pathname === '/') { response.setHeader('Content-Type', 'text/html'); response.end(html); return; }
        const filename = path.resolve(root, '.' + decodeURIComponent(new URL(request.url, 'http://localhost').pathname));
        if (!filename.startsWith(root + path.sep)) { response.writeHead(403).end(); return; }
        const types = { '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.ftl': 'text/plain', '.wasm': 'application/wasm', '.svg': 'image/svg+xml', '.png': 'image/png' };
        response.setHeader('Content-Type', types[path.extname(filename)] || 'application/octet-stream');
        response.end(await fs.readFile(filename));
    } catch (error) { response.writeHead(404).end(String(error)); }
});
server.listen(43129, '127.0.0.1', async () => {
    try {
        const base = 'http://127.0.0.1:43129';
        const panel = Object.create(PdfPreviewPanel.prototype);
        panel.context = { extensionUri: TestUri.file(root) };
        panel.panel = { webview: { cspSource: base, asWebviewUri: uri => ({ toString: () => base + '/' + path.relative(root, uri.fsPath).split(path.sep).map(encodeURIComponent).join('/') }) } };
        html = await panel.html();
        const nonce = html.match(/script-src 'nonce-([^']+)'/)[1];
        const pdf = JSON.stringify([...makePreviewPdf(undefined, { openOutline: true })]);
        const bootstrap = `<script nonce="${nonce}">
            window.smokeMessages=[]; window.smokeSaved=JSON.parse(localStorage.getItem('viewerState')||'null');
            window.smokeTiming={started:performance.now()};
            window.acquireVsCodeApi=()=>({getState:()=>window.smokeSaved,setState:s=>{window.smokeSaved=s;localStorage.setItem('viewerState',JSON.stringify(s));},postMessage:m=>{window.smokeMessages.push(m);if(m.type==='ready'){
                window.smokeTiming.ready=performance.now();
                window.postMessage({type:'init',state:JSON.parse(localStorage.getItem('hostState')||'null')},'*');
                window.postMessage({type:'pdf',revision:1,bytes:new Uint8Array(${pdf})},'*');
                if(location.search.includes('duplicate'))window.postMessage({type:'pdf',revision:1,bytes:new Uint8Array(${pdf})},'*');
                window.postMessage({type:'status',state:'ready',message:'Fixture PDF loaded'},'*');
            }if(m.type==='rendered')window.smokeTiming.rendered=performance.now();}});
            window.smokeRefresh=(revision=2)=>window.postMessage({type:'pdf',revision,bytes:new Uint8Array(${pdf})},'*');
        </script>`;
        // VS Code injects this body padding ahead of webview styles.
        html = html.replace('<head>', '<head><style>body { padding: 0 20px; }</style>' + bootstrap);
        console.log('PDF preview smoke harness ready at ' + base);
    } catch (error) { console.error(error); server.close(); process.exitCode = 1; }
});
