// Run after starting the local harness: playwright-cli run-code --filename=scripts/pdf-preview-startup-check.cjs
async page => {
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.addInitScript(() => {
        if (window.localleafStartupInstrumented) return;
        window.localleafStartupInstrumented = true;
        const stale = { page: 2, left: 0, top: 0, scale: 'page-width', rotation: 0, scrollMode: 0, spreadMode: 0, sidebar: 2, cursor: 0 };
        localStorage.setItem('viewerState', JSON.stringify(stale));
        localStorage.setItem('hostState', JSON.stringify(stale));
        window.startupLoads = 0;
        window.startupWorkers = 0;
        window.startupSidebarEvents = [];
        const WorkerClass = window.Worker;
        window.Worker = class extends WorkerClass {
            constructor(...args) { super(...args); window.startupWorkers++; }
        };
        window.addEventListener('message', event => {
            if (event.data.type !== 'init') return;
            const app = window.PDFViewerApplication;
            const load = app.load.bind(app);
            app.load = pdf => { window.startupLoads++; return load(pdf); };
            app.eventBus.on('sidebarviewchanged', event => window.startupSidebarEvents.push(event.view));
        });
    });
    // Add reproducible latency so sequential asset requests cannot masquerade as parallel loading.
    const assets = /\/(?:build\/pdf(?:\.worker)?\.mjs|web\/viewer\.mjs)$/;
    await page.route(assets, async route => {
        await new Promise(resolve => setTimeout(resolve, 120));
        await route.continue();
    });
    try {
        await page.goto('http://127.0.0.1:43129/?duplicate');
        await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered'));
        await page.waitForFunction(() => window.PDFViewerApplication.isInitialViewSet);
        const initial = await page.evaluate(() => {
            const assets = performance.getEntriesByType('resource').filter(item => /\/(?:build\/pdf(?:\.worker)?\.mjs|web\/viewer\.mjs)$/.test(item.name));
            return {
                loads: window.startupLoads,
                workers: window.startupWorkers,
                sidebarEvents: window.startupSidebarEvents,
                sidebar: window.PDFViewerApplication.viewsManager.visibleView,
                page: window.PDFViewerApplication.pdfViewer.currentPageNumber,
                startupMs: Math.round(window.smokeTiming.rendered - window.smokeTiming.started),
                assetStartSpreadMs: Math.round(Math.max(...assets.map(item => item.startTime)) - Math.min(...assets.map(item => item.startTime))),
                parallelAssets: assets.length === 3 && Math.max(...assets.map(item => item.startTime)) < Math.min(...assets.map(item => item.responseEnd)),
            };
        });
        const check = (condition, message) => { if (!condition) throw new Error(`${message}: ${JSON.stringify(initial)}`); };
        check(initial.loads === 1, 'Duplicate startup message parsed/loaded the same PDF again');
        check(initial.workers === 1, 'Startup created multiple workers');
        check(initial.sidebar === 0 && initial.sidebarEvents.every(view => view === 0), 'Saved sidebar flashed open during startup');
        check(initial.page === 2, 'Startup discarded the saved reading position');
        check(initial.parallelAssets, 'Startup assets still load sequentially');
        await page.evaluate(() => { window.smokeRefresh(2); window.smokeRefresh(3); });
        await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered' && message.revision === 3));
        check(await page.evaluate(() => window.startupWorkers === 1), 'Replacing a PDF created another worker');
        const errors = await page.evaluate(() => window.smokeMessages.filter(message => message.type === 'error'));
        check(errors.length === 0, `PDF replacement errors ${JSON.stringify(errors)}`);
        return { passed: true, ...initial, rapidReplacement: true };
    } finally {
        await page.unroute(assets);
    }
}
