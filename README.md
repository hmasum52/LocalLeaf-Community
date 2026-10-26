<p align="center">
  <img src="./docs/branding/localleaf-community-wordmark.png" alt="LocalLeaf Community" width="560">
</p>

# LocalLeaf Community

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Contributions welcome](https://img.shields.io/badge/contributions-welcome-35A66F.svg)](CONTRIBUTING.md)

LocalLeaf Community lets you work on Overleaf projects from VS Code while keeping a real local copy of every file. It is the continuation of [LocalLeaf](https://github.com/Teddy-van-Jerry/LocalLeaf), the extension created by Teddy van Jerry, and is now maintained here with contributions from the wider community.

LocalLeaf Community is an independent, community-maintained continuation. It is not sponsored, endorsed, or maintained by Teddy van Jerry or by Overleaf.

The idea is deliberately simple: write with the local tools you already like, and let LocalLeaf keep the project in step with Overleaf.

## What it can do

- Synchronize files in both directions with Overleaf and self-hosted Overleaf instances
- Show and link remote projects from the VS Code sidebar
- Create blank Overleaf projects directly from the sidebar or Command Palette
- Sign in through an isolated Chrome or Edge window, with manual cookies as a fallback
- Keep documents updated in real time
- Show collaborators and jump to their cursor positions
- Help resolve local and remote conflicts with a visual diff
- Automatically merge independent edits in LaTeX, bibliography, and Markdown files
- Recover synchronization baselines and pending document writes after restarting VS Code
- Ignore build output and other generated files through `.leafignore`
- Preview and remove ignored folders or files that exist only on Overleaf, while keeping local files
- Compile on Overleaf and preview PDFs inside VS Code, with search, navigation, and bidirectional SyncTeX
- Keep the last successful PDF and compilation log locally in `.output`
- Work alongside LaTeX Workshop for local compilation

## Installation

Requires VS Code **1.143.1 or later** for the bundled modern PDF.js viewer.

Install [LocalLeaf Community from the Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=victorstoica114.localleaf-community), or search for `LocalLeaf Community` in the VS Code Extensions view.

For a manual or offline installation, download the latest `.vsix` from [GitHub Releases](https://github.com/victorstoica114/LocalLeaf-Community/releases/latest), then run **Extensions: Install from VSIX...** in VS Code.

To build the extension yourself:

```powershell
npm install
npm run vendor:pdfjs
npm test
npx @vscode/vsce package
```

If the original Marketplace extension is installed, disable or uninstall it first. Both versions currently keep the same commands and workspace format, so existing LocalLeaf projects continue to work.

## Contributing

Contributions are welcome, whether they are code, documentation, bug reports, or testing against different Overleaf installations. The most useful starting points and the local development commands are collected in [CONTRIBUTING.md](CONTRIBUTING.md).

## Getting started

1. Open the folder that should contain your local project.
2. Run `LocalLeaf: Login`, choose your server and browser, then finish signing in in the isolated browser window.
3. Choose a project from the LocalLeaf sidebar and link it to the folder.
4. New remote files download automatically. Independent edits to supported text files merge automatically; overlapping changes remain available for review in the conflict prompt.

To start a new project, click **Create New Project** in the Projects header or the linked project's **Tools** tab. A dedicated editor page lets you enter the project name, choose the Overleaf server, check your account, and optionally select an empty local folder. **Create project** creates a blank project with `main.tex` and downloads it when a local folder is selected. Progress, errors, and the actions **Open in Overleaf** and **Open local folder** stay in the page. If the local download fails, **Retry local setup** resumes the same project. Opening the new folder starts synchronization without asking again about the connection you just chose.

Automatic text merging supports `.tex`, `.bib`, `.md`, `.sty`, and `.cls`. It needs a previously synchronized ancestor and preserves whitespace. Files above 2 MiB and merges that exceed the processing budget require review. Binary attachments are never merged as text. Unsaved editor changes remain unsaved.

Synchronization history is stored locally in VS Code's extension storage, separately for each server, project, and workspace. A copied or empty workspace starts by downloading the remote files. Connection interruptions recover automatically; a file conflict can remain pending while other files synchronize.

Healthy sessions stay connected without periodic project refreshes or reconnections. Socket.IO's heartbeat detects a lost connection and starts recovery with increasing delays. Returning to VS Code after at least 30 seconds away also checks for missed changes, at most once per minute. `LocalLeaf: Sync Now` starts that reconciliation on demand. If a server silently omits an event while the connection remains healthy, returning to the window or running Sync Now catches it up.

Dismissed or ignored prompts for unchanged local-only files stay quiet during that session's background checks. Changing those files or running `Sync Now` allows review again.

> [!WARNING]
> Your Overleaf cookies grant access to your account. Only send them to the real server you intend to use, check the URL carefully, and treat them like a password. LocalLeaf stores them in VS Code Secret Storage rather than inside the workspace. Use `LocalLeaf: Logout` if you suspect they were exposed.

Browser login uses a temporary, isolated Chromium profile and removes it after the session is captured. If cleanup is blocked by another process, LocalLeaf reports the exact temporary folder so you can remove it manually. If the extension is running on a remote extension host (Remote SSH, WSL, or a Dev Container), use the manual cookie option because the browser cannot be opened safely on your local desktop from that host.

## PDF preview

Open **Preview PDF** from the LocalLeaf sidebar or a TeX editor's title bar. LocalLeaf saves the linked project's documents, waits for Overleaf to confirm uploads, then compiles using the selected main document and the server's compiler. No local TeX installation is required.

While the preview is open, saving `.tex`, `.bib`, `.sty`, or `.cls` files schedules a rebuild. Disable this with `localleaf.compileOnSave`. `localleaf.compileTimeoutSeconds` defaults to 180 seconds. If automatic synchronization is disabled, use **Sync Now** to synchronize changes before compiling.

The viewer includes search, page navigation, zoom, rotation, thumbnails, outline, and scroll/spread modes. Run **Sync Source to PDF** from a source editor to jump into the preview; double-click a PDF page to return to its source. Keyboard shortcuts are left unassigned so they can coexist with LaTeX Workshop.

Each newly opened or restored preview starts with the sidebar closed. Open it manually to show thumbnails or the outline; that choice is retained during rebuilds in the same preview. Page position, zoom, and other reading preferences survive reopening. Saved PDFs display while synchronization and any necessary remote compilation run.

Each linked project keeps `.output/output.pdf`, `.output/output.log`, and `.output/.localleaf-preview.json`. Failed compilations preserve the last successful PDF. The metadata identifies its project and build without storing credentials or signed URLs. Output survives restarts and unlinking. `.output` is always excluded from synchronization, including when `.leafignore` has negation rules; add it to your own `.gitignore` if needed. Existing files without matching LocalLeaf ownership metadata are preserved and reported as conflicts. **Save PDF** exports an additional copy.

The PDF.js 6.4.299 modern distribution is bundled into the VSIX with its licenses. Its downloaded files in `resources/pdfjs/` are ignored by Git. After cloning, run `npm ci` and `npm run vendor:pdfjs` before building, testing, or packaging. The download script verifies the pinned release archive's SHA-256 before extraction; it requires internet access during setup. Viewer assets require no runtime CDN access, and an installed VSIX works without downloading PDF.js.

For development, `npm test` includes the transport, output ownership, synchronization barrier, and asset checks. After packaging `localleaf-community-pdf-preview.vsix`, `npm run test:pdf:host` installs it in a temporary VS Code profile and tests the actual webview against a synthetic compiler with LaTeX Workshop active. On Windows the runner finds the standard user installation; set `LOCALLEAF_VSCODE_PATH` or `LOCALLEAF_EXTENSIONS_PATH` to override the installation directories. The browser harness starts with `npm run test:pdf:browser`; run `playwright-cli open http://127.0.0.1:43129` and `playwright-cli run-code --filename=scripts/pdf-preview-browser-check.cjs` to exercise its controls. Run `scripts/pdf-preview-startup-check.cjs` through the same `run-code --filename` command in a fresh browser session to check cold startup, parallel asset requests, stale sidebar preferences, duplicate PDF messages, and worker reuse with simulated asset latency.

## Commands

| Command | What it does |
|---------|--------------|
| `LocalLeaf: Preview PDF` | Opens the compiled PDF beside the source; compiles when needed |
| `LocalLeaf: Compile Project` | Saves project documents, waits for confirmed synchronization, and compiles on Overleaf |
| `LocalLeaf: Stop Compilation` | Cancels the current LocalLeaf compilation |
| `LocalLeaf: Sync Source to PDF` | Reveals the source cursor's position in the PDF |
| `LocalLeaf: Show Compilation Log` | Opens the latest compilation log |
| `LocalLeaf: Save PDF` | Exports the last successful PDF to another location |
| `LocalLeaf: Login` | Opens the Account panel for browser or manual-cookie login |
| `LocalLeaf: Logout` | Removes the stored credentials |
| `LocalLeaf: Verify Credentials` | Checks whether the current session is still valid |
| `LocalLeaf: Re-authenticate` | Opens the Account panel to replace an expired session |
| `LocalLeaf: Link Folder to Overleaf Project` | Links the current folder to a project |
| `LocalLeaf: Create New Project` | Opens the graphical project creation page with account, server, and optional local folder setup |
| `LocalLeaf: Unlink Folder` | Removes the local project link |
| `LocalLeaf: Sync Now` | Starts a two-way synchronization |
| `LocalLeaf: Pull from Overleaf` | Downloads the latest remote state |
| `LocalLeaf: Push to Overleaf` | Explains the automatic push behavior |
| `LocalLeaf: Edit Ignore Patterns` | Opens `.leafignore` |
| `LocalLeaf: Clean Remote Files` | Select ignored folders and remote-only files to delete from Overleaf; local files are kept |
| `LocalLeaf: Show Sync Status` | Shows the connection and synchronization state |
| `LocalLeaf: Set Main Document` | Selects the primary `.tex` document |
| `LocalLeaf: Configure Settings` | Opens the extension settings |
| `LocalLeaf: Jump to Collaborator` | Opens a collaborator's current document and position |
| `LocalLeaf: Remove Standalone LaTeX Comments` | Previews and removes full-line comments with confirmation and Undo support |

## Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `localleaf.defaultServer` | `https://www.overleaf.com` | Overleaf or self-hosted server URL |
| `localleaf.autoSync` | `true` | Upload local filesystem changes automatically; remote collaboration remains connected when disabled |

## The people behind the project

LocalLeaf was started by **Teddy van Jerry (Wuqiong Zhao)**, who designed and built the original extension and maintained its first releases. **Xingyu Chen (Asixa / RFDT)** later contributed a substantial 34-commit proposal for a broader interface, synchronization workflow, local compilation, PDF tooling, and Source Control integration in PR #3. **Victor Stoica** integrated and hardened parts of that work, fixed synchronization and security issues, and now maintains this continuation.

The full story is in [ATTRIBUTION.md](ATTRIBUTION.md), and the commit-by-commit review is in [docs/CONTRIBUTOR_INTEGRATION.md](docs/CONTRIBUTOR_INTEGRATION.md). Asixa's original PR history is preserved in the `archive/asixa-pr-3` branch, while equivalent authored commits are present on the default branch for contributor visibility.

## Related projects

LocalLeaf was inspired by [Overleaf-Workshop](https://github.com/iamhyc/Overleaf-Workshop), which offers a more deeply integrated Overleaf experience inside VS Code. LocalLeaf takes a different route: it keeps a normal local project that remains usable with Git, LaTeX Workshop, scripts, and any other local tool.

LocalLeaf and LocalLeaf Community are not affiliated with or endorsed by Overleaf.

## License

The project is distributed under the [MIT License](LICENSE). Teddy's original copyright notice is kept intact, with a separate notice for the community's later work. See [NOTICE](NOTICE), [ATTRIBUTION.md](ATTRIBUTION.md), and [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for project history, credits, and dependency licenses.
