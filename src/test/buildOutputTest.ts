import { runStandaloneTest } from './standaloneRunner';
/** Exercise a clean build so an old output cannot mask a missing worker bundle. */
import * as assert from 'node:assert/strict';
import * as path from 'node:path';
import { promises as fs } from 'node:fs';
import { Worker } from 'node:worker_threads';
import * as esbuild from 'esbuild';
import { createTemporaryWorkspace, cleanTemporaryWorkspaces } from './temporaryWorkspace';

async function run(): Promise<void> {
    const directory = await createTemporaryWorkspace('build-output');
    const { getBuildOptions, getViewerBuildOptions } = require('../../esbuild.js') as {
        getBuildOptions(): esbuild.BuildOptions; getViewerBuildOptions(): esbuild.BuildOptions;
    };
    await esbuild.build({ ...getBuildOptions(), outdir: directory, sourcemap: false, minify: true });
    assert.deepEqual((await fs.readdir(directory)).sort(), ['extension.js', 'textMergeWorker.js']);
    const viewerDirectory = path.join(directory, 'pdf-preview');
    await esbuild.build({ ...getViewerBuildOptions(), outdir: viewerDirectory, sourcemap: false, minify: true });
    await fs.copyFile('webviews/pdf-preview/index.css', path.join(viewerDirectory, 'index.css'));
    assert.deepEqual((await fs.readdir(viewerDirectory)).sort(), ['index.css', 'index.js']);
    const provenance = JSON.parse(await fs.readFile('resources/pdfjs/PROVENANCE.json', 'utf8'));
    assert.equal(provenance.version, '6.4.299');
    assert.equal(provenance.build, 'modern');
    for (const asset of ['LICENSE', 'build/pdf.mjs', 'build/pdf.worker.mjs', 'web/viewer.html', 'web/viewer.mjs',
        'web/viewer.css', 'web/locale/locale.json', 'web/locale/en-US/viewer.ftl']) {
        assert.ok((await fs.stat(path.join('resources/pdfjs', asset))).size > 0, `Missing packaged PDF asset ${asset}`);
    }
    for (const directory of ['cmaps', 'standard_fonts', 'wasm', 'images']) {
        assert.ok((await fs.readdir(path.join('resources/pdfjs/web', directory))).length > 0);
    }
    const worker = new Worker(path.join(directory, 'textMergeWorker.js'), {
        workerData: { base: 'first\nseparator\nlast\n', local: 'FIRST\nseparator\nlast\n', remote: 'first\nseparator\nLAST\n' },
    });
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
        const result: unknown = await new Promise((resolve, reject) => {
            timer = setTimeout(() => reject(new Error('Packaged merge worker did not answer')), 5000);
            worker.once('message', resolve);
            worker.once('error', reject);
        });
        assert.deepEqual(result, { clean: true, text: 'FIRST\nseparator\nLAST\n' });
    } finally {
        clearTimeout(timer);
        await worker.terminate();
    }
    console.log('Clean build and bundled merge worker passed.');
}

async function main(): Promise<void> {
    try { await run(); } finally { await cleanTemporaryWorkspaces(); }
}
runStandaloneTest(main);
