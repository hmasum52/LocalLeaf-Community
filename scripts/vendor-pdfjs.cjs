// Run explicitly when refreshing the pinned, unmodified Mozilla distribution.
const https = require('node:https');
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { execFileSync } = require('node:child_process');
const version = '6.4.299';
const sha256 = 'f2245eb7ef3f674c872fe568a177bfec15874f5c034613e55d8e307f93ebd86d';
const url = `https://github.com/mozilla/pdf.js/releases/download/v${version}/pdfjs-${version}-dist.zip`;
function download(address, remaining = 5) {
    return new Promise((resolve, reject) => {
        https.get(address, { headers: { 'User-Agent': 'LocalLeaf' } }, response => {
            if (response.statusCode >= 300 && response.statusCode < 400 && remaining > 0) {
                response.resume();
                resolve(download(new URL(response.headers.location, address).href, remaining - 1));
                return;
            }
            if (response.statusCode !== 200) { response.resume(); reject(new Error(`Download HTTP ${response.statusCode}`)); return; }
            const chunks = [];
            response.on('data', data => chunks.push(data));
            response.on('end', () => resolve(Buffer.concat(chunks)));
            response.on('error', reject);
        }).on('error', reject);
    });
}
async function main() {
    const bytes = await download(url);
    if (createHash('sha256').update(bytes).digest('hex') !== sha256) throw new Error('PDF.js archive checksum mismatch');
    const destination = path.resolve(__dirname, '../resources/pdfjs');
    const archive = path.resolve(__dirname, '../.tmp-pdfjs.zip');
    await fs.mkdir(destination, { recursive: true });
    await fs.writeFile(archive, bytes);
    try { execFileSync('tar', ['-xf', archive, '-C', destination]); }
    finally { await fs.unlink(archive); }
    async function trim(directory) {
        for (const entry of await fs.readdir(directory, { withFileTypes: true })) {
            const file = path.join(directory, entry.name);
            if (entry.isDirectory()) await trim(file);
            else if (entry.name.endsWith('.map') || entry.name.endsWith('.pdf')) await fs.unlink(file);
        }
    }
    await trim(destination);
    await fs.writeFile(path.join(destination, 'PROVENANCE.json'), JSON.stringify({ version, build: 'modern', url, sha256 }, null, 2) + '\n');
    console.log(`Vendored modern PDF.js ${version}, verified SHA-256 ${sha256}`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
