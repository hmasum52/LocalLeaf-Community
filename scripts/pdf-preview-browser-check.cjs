// Execute with: playwright-cli run-code --filename=scripts/pdf-preview-browser-check.cjs
async (page) => {
    const check = (condition, message) => { if (!condition) throw new Error(message); };
    await page.setViewportSize({ width: 1100, height: 700 });
    await page.evaluate(() => {
        const stale = { page: 1, left: 0, top: 0, scale: 'auto', rotation: 0, scrollMode: 0, spreadMode: 0, sidebar: 2, cursor: 0 };
        localStorage.setItem('viewerState', JSON.stringify(stale));
        localStorage.setItem('hostState', JSON.stringify(stale));
    });
    await page.reload();
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered'));
    await page.waitForFunction(() => window.PDFViewerApplication.isInitialViewSet);
    check(await page.evaluate(() => !window.PDFViewerApplication.viewsManager.isOpen), 'Document PageMode opened the sidebar by default');
    await page.evaluate(() => {
        window.PDFViewerApplication.pdfViewer.currentPageNumber = 1;
        window.PDFViewerApplication.viewsManager?.close();
        window.PDFViewerApplication.findBar?.close();
    });
    await page.locator('#next').click();
    await page.waitForFunction(() => document.getElementById('pageNumber').value === '2');
    await page.getByRole('combobox', { name: 'Zoom', exact: true }).selectOption('page-width');
    await page.waitForFunction(() => window.smokeSaved?.scale === 'page-width');
    await page.getByRole('button', { name: 'Find', exact: true }).click();
    await page.locator('#findInput').fill('Second page');
    await page.locator('#findInput').press('Enter');
    await page.waitForFunction(() => document.querySelector('.highlight')); // PDF.js text search actually ran.
    await page.evaluate(() => window.PDFViewerApplication.eventBus.dispatch('findbarclose', { source: window }));
    await page.evaluate(() => window.smokeRefresh());
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered' && message.revision === 2));
    check(await page.locator('#pageNumber').inputValue() === '2', 'Refresh lost the current page');
    check(await page.locator('#scaleSelect').inputValue() === 'page-width', 'Refresh lost zoom');
    check(await page.evaluate(() => !window.PDFViewerApplication.viewsManager.isOpen), 'Refresh reopened the closed sidebar');
    await page.getByRole('button', { name: 'Manage pages', exact: true }).click();
    await page.waitForFunction(() => document.getElementById('viewsManager').checkVisibility());
    await page.locator('.page[data-page-number="2"] .textLayer span').first().dblclick();
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'reverse' && message.revision === 2 && message.page === 2));
    await page.evaluate(() => window.postMessage({ type: 'forward', revision: 2, locations: [{ page: 1, h: 72, v: 92, width: 180, height: 24 }] }, '*'));
    await page.waitForFunction(() => document.querySelector('.localleafHighlight'));
    await page.getByRole('button', { name: 'Recompile', exact: true }).click();
    await page.getByRole('button', { name: 'Show log', exact: true }).click();
    await page.getByRole('button', { name: 'Save PDF', exact: true }).click();
    const messages = await page.evaluate(() => window.smokeMessages);
    check(['compile', 'log', 'save'].every(action => messages.some(message => message.type === 'action' && message.action === action)), 'Missing viewer toolbar messages');
    check(!messages.some(message => message.type === 'error'), 'Viewer reported an error');
    const external = await page.evaluate(() => performance.getEntriesByType('resource').filter(item => !item.name.startsWith(location.origin)).map(item => item.name));
    check(external.length === 0, 'Viewer fetched external resources: ' + external.join(', '));
    await page.evaluate(() => window.PDFViewerApplication.viewsManager.switchView(2, true));
    await page.waitForFunction(() => window.PDFViewerApplication.viewsManager.visibleView === 2);
    check(await page.evaluate(() => window.smokeSaved?.sidebar === 0), 'Open sidebar leaked into persisted preferences');
    await page.evaluate(() => window.smokeRefresh(3));
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered' && message.revision === 3));
    check(await page.evaluate(() => window.PDFViewerApplication.viewsManager.visibleView === 2), 'Refresh lost the manually opened outline');
    await page.locator('#viewsManagerToggleButton').click();
    await page.waitForFunction(() => window.smokeSaved?.sidebar === 0);
    await page.evaluate(() => window.smokeRefresh(4));
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered' && message.revision === 4));
    check(await page.evaluate(() => !window.PDFViewerApplication.viewsManager.isOpen), 'Refresh ignored the manually closed sidebar');
    // Reopening a preview must start closed even when the preceding session ended open.
    await page.getByRole('button', { name: 'Manage pages', exact: true }).click();
    await page.waitForFunction(() => window.PDFViewerApplication.viewsManager.isOpen);
    await page.reload();
    await page.waitForFunction(() => window.smokeMessages.some(message => message.type === 'rendered'));
    check(await page.locator('#scaleSelect').inputValue() === 'page-width', 'Reload lost view preferences');
    check(await page.evaluate(() => !window.PDFViewerApplication.viewsManager.isOpen), 'Reload reopened the closed sidebar');
    for (const width of [320, 400, 600, 900, 1100]) {
        await page.setViewportSize({ width, height: 700 });
        const bounds = await page.evaluate(() => {
            const box = selector => {
                const r = document.querySelector(selector).getBoundingClientRect();
                return { x: r.x, y: r.y, right: r.right, bottom: r.bottom, width: r.width };
            };
            return { header: box('#localleafToolbar'), toolbar: box('#toolbarContainer'), tools: box('#secondaryToolbarToggleButton'), outer: box('#outerContainer') };
        });
        check(bounds.tools.x >= 0 && bounds.tools.right <= width - 4, `Tools button clipped at ${width}px: ${JSON.stringify(bounds)}`);
        check(bounds.toolbar.y === bounds.header.bottom, `Unexpected gap above PDF toolbar at ${width}px`);
        check(bounds.outer.bottom === 700, `Viewer overflows the viewport at ${width}px`);
        await page.locator('#secondaryToolbarToggleButton').click();
        await page.locator('#secondaryToolbar').waitFor({ state: 'visible' });
        const menu = await page.locator('#secondaryToolbar').boundingBox();
        check(menu && menu.x >= 0 && menu.x + menu.width <= width, `Tools menu clipped at ${width}px`);
        await page.locator('#pageRotateCw').click();
        await page.waitForFunction(() => window.PDFViewerApplication.pdfViewer.pagesRotation !== 0);
        await page.evaluate(() => {
            window.PDFViewerApplication.pdfViewer.pagesRotation = 0;
            window.PDFViewerApplication.secondaryToolbar.close();
        });
    }
    return 'PDF.js navigation, search, zoom, refresh, always-closed startup with stale saved state, manual sidebar toggles, SyncTeX, offline assets, and Tools layout at 320–1100px passed.';
}
