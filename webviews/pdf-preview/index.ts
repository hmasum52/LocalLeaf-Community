import type { HostMessage, PreviewMessage, ViewerState } from '../../src/compile/protocol';
import { isViewerState } from '../../src/compile/protocol';
import type { PdfLocation } from '../../src/compile/types';
declare function acquireVsCodeApi(): { postMessage(message: PreviewMessage): void; getState(): unknown; setState(state: ViewerState & { projectKey?: string }): void };
const vscode = acquireVsCodeApi();
const toolbar = document.getElementById('localleafToolbar')!;
const status = document.getElementById('localleafStatus')!;
const button = (id: string) => document.getElementById(id) as HTMLButtonElement;
let state: ViewerState | undefined;
let revision = 0;
let loadingRevision = 0;
let timer: ReturnType<typeof setTimeout>;
let applying = false;
let app: any;
let lib: any;
let snapshot: HTMLElement | undefined;
let pendingForward: PdfLocation[] | undefined;
let projectKey: string | undefined;

function save(location?: { pageNumber: number; left: number; top: number }): void {
    if (!app?.pdfDocument || applying) return;
    const viewer = app.pdfViewer;
    const next: ViewerState = { page: location?.pageNumber ?? viewer.currentPageNumber,
        left: location?.left ?? state?.left ?? 0, top: location?.top ?? state?.top ?? 0,
        scale: typeof viewer.currentScaleValue === 'string' && /^\d/.test(viewer.currentScaleValue)
            ? Number(viewer.currentScaleValue) : viewer.currentScaleValue,
        rotation: viewer.pagesRotation, scrollMode: viewer.scrollMode, spreadMode: viewer.spreadMode,
        sidebar: app.viewsManager?.visibleView ?? 0, cursor: app.pdfCursorTools?.activeTool ?? 0 };
    if (!isViewerState(next)) return;
    state = next;
    // Sidebar visibility belongs to this open preview, not the next preview session.
    const persisted = { ...next, sidebar: 0 };
    vscode.setState({ ...persisted, projectKey });
    clearTimeout(timer);
    timer = setTimeout(() => vscode.postMessage({ type: 'state', state: persisted }), 250);
}
function restore(): void {
    if (!state || !app.pdfDocument) return;
    const viewer = app.pdfViewer;
    viewer.pagesRotation = state.rotation;
    viewer.scrollMode = state.scrollMode;
    viewer.spreadMode = state.spreadMode;
    viewer.currentScaleValue = state.scale;
    viewer.scrollPageIntoView({ pageNumber: Math.min(state.page, app.pdfDocument.numPages),
        destArray: [null, { name: 'XYZ' }, state.left, state.top, null] });
    app.pdfCursorTools?.switchTool(state.cursor);
    app.viewsManager?.switchView(state.sidebar, state.sidebar > 0);
}
function keepRenderedView(): void {
    snapshot?.remove();
    const container = document.getElementById('viewerContainer')!;
    if (!container.querySelector('canvas')) return;
    const clone = container.cloneNode(true) as HTMLElement;
    clone.removeAttribute('id');
    clone.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    const bounds = container.getBoundingClientRect();
    clone.classList.add('localleafSnapshot');
    Object.assign(clone.style, { left: `${bounds.left}px`, top: `${bounds.top}px`, width: `${bounds.width}px`, height: `${bounds.height}px` });
    const originals = container.querySelectorAll('canvas');
    clone.querySelectorAll('canvas').forEach((canvas, index) => canvas.getContext('2d')?.drawImage(originals[index], 0, 0));
    document.body.append(clone);
    clone.scrollTop = container.scrollTop; clone.scrollLeft = container.scrollLeft;
    snapshot = clone;
}
function forward(locations: PdfLocation[]): void {
    if (!locations.length || !app.pdfDocument) return;
    const location = locations[Math.floor((locations.length - 1) / 2)];
    const page = app.pdfViewer.getPageView(location.page - 1);
    if (!page) return;
    const [, , , yMax] = page.viewport.viewBox;
    app.pdfViewer.scrollPageIntoView({ pageNumber: location.page,
        destArray: [null, { name: 'XYZ' }, location.h, yMax - location.v, null] });
    for (const point of locations) {
        const target = app.pdfViewer.getPageView(point.page - 1);
        if (!target) continue;
        const viewport = target.viewport;
        const [x1, y1] = viewport.convertToViewportPoint(point.h, viewport.viewBox[3] - point.v);
        const [x2, y2] = viewport.convertToViewportPoint(point.h + point.width, viewport.viewBox[3] - point.v - point.height);
        const highlight = document.createElement('div');
        highlight.className = 'localleafHighlight';
        Object.assign(highlight.style, { left: `${Math.min(x1, x2)}px`, top: `${Math.min(y1, y2)}px`,
            width: `${Math.max(Math.abs(x2 - x1), 8)}px`, height: `${Math.max(Math.abs(y2 - y1), 8)}px` });
        target.div.append(highlight);
        setTimeout(() => highlight.remove(), 1800);
    }
}
async function main(): Promise<void> {
    const options = { defaultUrl: '', disablePreferences: true, disableHistory: true, enableScripting: false,
        sidebarViewOnLoad: 0, viewOnLoad: 1,
        annotationEditorMode: -1, enableComment: false, enableSignature: false, enablePrintAutoRotate: false,
        enableAltTextModelDownload: false, enableUpdatedAddImage: false, enableSplitMerge: false, enableMerge: false, supportsPrinting: false,
        cMapUrl: `${toolbar.dataset.assets}/cmaps/`, standardFontDataUrl: `${toolbar.dataset.assets}/standard_fonts/`,
        wasmUrl: `${toolbar.dataset.assets}/wasm/`, imageResourcesPath: `${toolbar.dataset.assets}/images/`,
        sandboxBundleSrc: '', isEvalSupported: false };
    document.addEventListener('webviewerloaded', () => {
        (window as any).PDFViewerApplicationOptions.setAll(options);
    }, { once: true });
    // The generic viewer reads globalThis.pdfjsLib while evaluating. Preload its
    // module in parallel, but evaluate it only after the library sets that global.
    const viewerPreload = document.createElement('link');
    viewerPreload.rel = 'modulepreload';
    viewerPreload.href = toolbar.dataset.viewer!;
    document.head.append(viewerPreload);
    const [library, workerBlob] = await Promise.all([
        import(/* @vite-ignore */ toolbar.dataset.pdf!),
        fetch(toolbar.dataset.worker!).then(response => {
            if (!response.ok) throw new Error('Bundled PDF worker could not be loaded.');
            return response.blob();
        }),
    ]);
    lib = library;
    const workerUrl = URL.createObjectURL(new Blob([workerBlob], { type: 'text/javascript' }));
    const workerPort = new Worker(workerUrl, { type: 'module' });
    lib.GlobalWorkerOptions.workerPort = workerPort;
    // Keep one explicitly owned PDFWorker for the preview. Replacing a document must
    // not destroy a worker that is also parsing its replacement.
    const worker = new lib.PDFWorker({ port: workerPort });
    window.addEventListener('unload', () => { worker.destroy(); workerPort.terminate(); URL.revokeObjectURL(workerUrl); });
    const module = await import(/* @vite-ignore */ toolbar.dataset.viewer!);
    app = module.PDFViewerApplication;
    module.PDFViewerApplicationOptions.setAll(options);
    await app.initializedPromise;
    // Generic viewer retains its normal navigation controls; local file opening and editing are disabled.
    document.addEventListener('keydown', event => {
        if ((event.ctrlKey || event.metaKey) && ['o', 'p', 's'].includes(event.key.toLowerCase())) {
            event.preventDefault(); event.stopImmediatePropagation();
            if (event.key.toLowerCase() === 's') vscode.postMessage({ type: 'action', action: 'save' });
        }
    }, true);
    document.addEventListener('drop', event => { event.preventDefault(); event.stopImmediatePropagation(); }, true);
    document.addEventListener('dragover', event => event.preventDefault(), true);
    for (const [id, action] of [['localleafCompile', 'compile'], ['localleafStop', 'stop'], ['localleafLog', 'log'], ['localleafSave', 'save']] as const) {
        button(id).addEventListener('click', () => vscode.postMessage({ type: 'action', action }));
    }
    app.eventBus.on('pagesinit', () => restore());
    // PDF.js applies document page-mode/history after pagesinit. Restore our preferences last,
    // and suppress state writes until then so those defaults cannot replace the saved choice.
    app.eventBus.on('documentinit', () => { restore(); applying = false; });
    app.eventBus.on('pagerendered', () => {
        snapshot?.remove(); snapshot = undefined;
        if (loadingRevision) {
            revision = loadingRevision; loadingRevision = 0;
            vscode.postMessage({ type: 'rendered', revision });
            if (pendingForward) { forward(pendingForward); pendingForward = undefined; }
        }
    });
    app.eventBus.on('updateviewarea', (event: any) => save(event.location));
    for (const event of ['scalechanging', 'rotationchanging', 'scrollmodechanged', 'spreadmodechanged', 'sidebarviewchanged', 'cursortoolchanged']) {
        app.eventBus.on(event, () => save());
    }
    document.addEventListener('dblclick', event => {
        if (!(event.target instanceof Element) || !revision || loadingRevision) return;
        const element = event.target.closest<HTMLElement>('.page[data-page-number]');
        if (!element) return;
        const page = Number(element.dataset.pageNumber);
        const view = app.pdfViewer.getPageView(page - 1);
        const canvas = element.querySelector('canvas');
        if (!view || !canvas) return;
        const bounds = canvas.getBoundingClientRect();
        const [h, y] = view.viewport.convertToPdfPoint(event.clientX - bounds.left, event.clientY - bounds.top);
        vscode.postMessage({ type: 'reverse', revision, page, h, v: view.viewport.viewBox[3] - y });
    });
    let requestedRevision = 0;
    window.addEventListener('message', async (event: MessageEvent<HostMessage>) => {
        const message = event.data;
        try {
            if (message.type === 'init') {
                projectKey = message.projectKey;
                const saved = vscode.getState();
                if (isViewerState(saved)) state = { ...saved, sidebar: 0 };
                else if (isViewerState(message.state)) state = { ...message.state, sidebar: 0 };
                app.viewsManager?.close();
            } else if (message.type === 'status') {
                status.textContent = message.message;
                status.title = message.message;
                status.dataset.state = message.state;
                button('localleafStop').disabled = !['synchronizing', 'compiling'].includes(message.state);
            } else if (message.type === 'pdf') {
                if (message.revision <= requestedRevision) return;
                requestedRevision = message.revision;
                const task = lib.getDocument({ data: new Uint8Array(message.bytes), worker, cMapUrl: options.cMapUrl,
                    standardFontDataUrl: options.standardFontDataUrl, wasmUrl: options.wasmUrl, isEvalSupported: false });
                const document = await task.promise;
                if (requestedRevision !== message.revision) { await task.destroy(); return; }
                save(); keepRenderedView(); applying = true;
                await app.close();
                if (requestedRevision !== message.revision) { await task.destroy(); return; }
                loadingRevision = message.revision;
                app.pdfLoadingTask = task;
                app.load(document);
            } else if (message.type === 'forward' && message.revision === requestedRevision) {
                if (loadingRevision) pendingForward = message.locations;
                else forward(message.locations);
            }
        } catch (error) {
            vscode.postMessage({ type: 'error', message: `PDF viewer: ${String(error)}` });
        }
    });
    vscode.postMessage({ type: 'ready' });
}
void main().catch(error => {
    status.textContent = `Unable to start PDF viewer: ${String(error)}`;
    vscode.postMessage({ type: 'error', message: status.textContent });
});
