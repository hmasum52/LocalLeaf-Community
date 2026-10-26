// Isolated VS Code profile. Never modifies the person's profile or extension installation.
const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { existsSync } = require('node:fs');
const root = path.resolve(__dirname, '..');
async function main() {
    const installation = process.env.LOCALLEAF_VSCODE_PATH || path.join(process.env.LOCALAPPDATA, 'Programs/Microsoft VS Code');
    const directory = await fs.mkdtemp(path.join(root, '.tmp-pdf-host-'));
    const workspace = path.join(directory, 'project');
    const profile = path.join(directory, 'profile');
    const extensions = path.join(directory, 'extensions');
    await fs.mkdir(workspace, { recursive: true });
    await fs.mkdir(path.join(profile, 'User'), { recursive: true });
    await fs.mkdir(extensions, { recursive: true });
    await fs.writeFile(path.join(workspace, 'main.tex'), '\\documentclass{article}\n\\begin{document}Hello\\end{document}\n');
    await fs.writeFile(path.join(profile, 'User', 'settings.json'), JSON.stringify({
        'security.workspace.trust.enabled': false, 'update.mode': 'none', 'extensions.autoUpdate': false,
        'extensions.ignoreRecommendations': true, 'telemetry.telemetryLevel': 'off', 'workbench.startupEditor': 'none',
        'latex-workshop.latex.autoBuild.run': 'never', 'window.restoreWindows': 'none',
    }));
    const installed = process.env.LOCALLEAF_EXTENSIONS_PATH || path.join(process.env.USERPROFILE, '.vscode/extensions');
    const latex = (await fs.readdir(installed)).find(name => name.startsWith('james-yu.latex-workshop-'));
    if (!latex) throw new Error('LaTeX Workshop installation required for coexistence test');
    await fs.cp(path.join(installed, latex), path.join(extensions, latex), { recursive: true });
    const locations = [installation, ...(await fs.readdir(installation, { withFileTypes: true }))
        .filter(entry => entry.isDirectory()).map(entry => path.join(installation, entry.name))];
    const cli = locations.map(location => path.join(location, 'resources/app/out/cli.js')).find(file => existsSync(file));
    if (!cli) throw new Error('Could not find VS Code CLI');
    const installerLog = await fs.open(path.join(directory, 'install.log'), 'w');
    const installEnvironment = { ...process.env, ELECTRON_RUN_AS_NODE: '1' };
    delete installEnvironment.VSCODE_IPC_HOOK_CLI;
    const installer = spawn(path.join(installation, 'Code.exe'), [cli, '--install-extension',
        path.join(root, 'localleaf-community-pdf-preview.vsix'), '--extensions-dir', extensions,
        '--user-data-dir', profile, '--force'], { env: installEnvironment, windowsHide: true,
        stdio: ['ignore', installerLog.fd, installerLog.fd] });
    const installedCode = await new Promise((resolve, reject) => { installer.on('exit', resolve); installer.on('error', reject); });
    await installerLog.close();
    if (installedCode) throw new Error(`VSIX installation failed; see ${directory}/install.log`);
    const localleaf = (await fs.readdir(extensions)).find(name => name.startsWith('victorstoica114.localleaf-community-'));
    if (!localleaf) throw new Error('VSIX was not installed in the isolated extensions directory');
    const packagedRoot = path.join(extensions, localleaf);
    // VS Code associates API calls with the caller's extension directory. Keep the
    // test runner inside that directory so binary webview messaging uses the real manifest's engine version.
    await fs.cp(path.join(root, 'out'), path.join(packagedRoot, 'integration'), { recursive: true });
    const args = [workspace, '--new-window', '--skip-welcome', '--skip-release-notes', '--disable-workspace-trust',
        '--remote-debugging-port=43130',
        '--user-data-dir', profile, '--extensions-dir', extensions, '--extensionDevelopmentPath', packagedRoot,
        '--extensionTestsPath', path.join(packagedRoot, 'integration/test/pdfPreviewExtensionHost.js'), '--disable-updates'];
    const log = await fs.open(path.join(directory, 'host.log'), 'w');
    const environment = { ...process.env, LOCALLEAF_PACKAGED_ROOT: packagedRoot };
    delete environment.ELECTRON_RUN_AS_NODE;
    const child = spawn(path.join(installation, 'Code.exe'), args, {
        env: environment, windowsHide: true,
        stdio: ['ignore', log.fd, log.fd],
    });
    console.log('Isolated VS Code test directory:', directory);
    const timer = setTimeout(() => { child.kill(); console.error('VS Code integration timed out'); }, 120_000);
    const code = await new Promise((resolve, reject) => { child.on('exit', resolve); child.on('error', reject); });
    clearTimeout(timer); await log.close();
    const result = await fs.readFile(path.join(workspace, 'integration-result.json'), 'utf8').catch(() => undefined);
    if (result) console.log(result);
    if (code || !result || !JSON.parse(result).passed) throw new Error(`VS Code integration failed (${code}); see ${directory}/host.log`);
}
main().catch(error => { console.error(error); process.exitCode = 1; });
