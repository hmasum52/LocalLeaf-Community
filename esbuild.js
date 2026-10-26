const esbuild = require('esbuild');
const fs = require('node:fs/promises');

const production = process.argv.includes('--production');
const watch = process.argv.includes('--watch');

function getBuildOptions() {
    return {
        absWorkingDir: __dirname,
        entryPoints: { extension: 'src/extension.ts', textMergeWorker: 'src/sync/textMergeWorker.ts' },
        bundle: true,
        external: ['vscode'],
        format: 'cjs',
        platform: 'node',
        target: 'node18',
        outdir: 'dist',
        minify: production,
        sourcemap: !production,
        sourcesContent: false,
        logLevel: 'info',
    };
}

async function main() {
    const context = await esbuild.context(getBuildOptions());
    const viewer = await esbuild.context(getViewerBuildOptions());
    await fs.mkdir('dist/pdf-preview', { recursive: true });
    await fs.copyFile('webviews/pdf-preview/index.css', 'dist/pdf-preview/index.css');

    if (watch) {
        await context.watch();
        await viewer.watch();
        console.log('[watch] bundle rebuild enabled');
        return;
    }

    try {
        await context.rebuild();
        await viewer.rebuild();
    } finally {
        await context.dispose();
        await viewer.dispose();
    }
}

function getViewerBuildOptions() {
    return { entryPoints: ['webviews/pdf-preview/index.ts'], bundle: true, format: 'esm',
        platform: 'browser', target: 'esnext', outdir: 'dist/pdf-preview', minify: production,
        sourcemap: !production, logLevel: 'info' };
}
module.exports = { getBuildOptions, getViewerBuildOptions };
if (require.main === module) {
    main().catch(error => {
        console.error(error);
        process.exitCode = 1;
    });
}
