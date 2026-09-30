# Local Design Canvas

Local Design Canvas lets an agent create static HTML/CSS/JavaScript screens in a workspace and show them in a local multi-screen canvas. It uses Node.js 22.12 or later, binds its servers to `127.0.0.1`, and has no model API key or CDN dependency.

Hướng dẫn sử dụng chi tiết bằng tiếng Việt: [docs/usage.md](docs/usage.md).

## What it does

Each capability below is available on the local canvas, through the CLI, or both. The agent edits screen files; the server owns project metadata.

- **Multi-screen canvas.** Places every screen of a project on one board. You pan, zoom, fit the view, drag frames, and set a viewport (Mobile 390, Tablet 768, Máy tính 1280, or a custom width and height). Saving a screen file refreshes that preview in place and keeps your pan and zoom. This is how you compare a screen set without opening each file in a separate browser tab.
- **Agent skill and CLI.** The installed skill creates projects and screens, then writes `index.html`, `styles.css`, and shared tokens in `design-system.css`. You describe the UI in chat; the agent runs the runtime. `project.json` and `.local-canvas/` stay server-owned.
- **Screen focus and edit lock.** Click a frame or its name in the sidebar, then say “this screen.” `screen focus` tells the agent which frame is highlighted. While it edits, `screen edit start` shows an editing state and blocks interaction on that frame; `screen edit done` clears the lock.
- **Element selection (Chỉnh sửa).** On a selected screen, **Chỉnh sửa** lets you click one element. The canvas highlights it, copies its `data-design-id`, and stores selector, text, and bounds for `selection get`. Paste the ID or say “the selected element” so the agent edits that node. If the source changed after the click, the highlight turns stale and the agent asks you to select again.
- **Prototypes.** Select at least two screens and press **Tạo prototype**. Canvas copies a prompt; the agent stores click targets on the original screens and Canvas shows **Play**. Play always uses the current UI. When the source changes, Canvas marks the flow **Cần tạo lại** and **Copy prompt tạo lại** asks the agent to rebuild that same prototype.
- **Screenshots.** **Chụp ảnh**, or `screenshot`, writes a PNG plus console, page, and resource errors under the project’s `artifacts/captures`. The agent reads the image and the errors, then edits and captures again.
- **Duplicate and versions.** **Nhân bản** copies one screen into its own files while it keeps the shared design tokens, so you can try a variant. **Phiên bản → Lưu phiên bản** snapshots the project source; **Khôi phục phiên bản** restores it and keeps a backup of the state you had before the restore.
- **Page reference.** `reference fetch <url>` opens that URL in a headless browser on your machine and saves the title, headings, section text, links, and a full-page screenshot under `artifacts/references`. The agent uses that screenshot as the layout source when you ask to build a similar static screen, and replaces the page’s images and copyrighted text with your own content.
- **Copy for Figma.** **Copy cho Figma** puts the selected screen on the clipboard as HTML you can paste into Figma.
- **MCP.** `mcp serve` exposes the same project, screen, selection, capture, reference, and prototype operations over stdio. Hosts that call tools directly use this; the skill still works through the CLI when you do not.

## Requirements

- Node.js 22.12 or later.
- macOS for `--open`. That flag launches the canvas with the `open` command. On other platforms `start` still runs the server; open the URL in the command result yourself.
- Playwright Chromium for **Chụp ảnh**, `screenshot`, `reference fetch`, and `npm run test:e2e`. If the browser is missing, capture and reference commands return `BROWSER_NOT_INSTALLED`.

```bash
npx playwright install chromium
```

## Build and run

`npm run build` compiles the canvas, bundles the CLI and server, and writes a self-contained release at `dist/release/local-design-canvas` (CLI, server, canvas assets, starter template, and `scripts/run.mjs`). Run that runner. There is no separate dev-server script.

```bash
npm install
npm run build
node dist/release/local-design-canvas/scripts/run.mjs start \
  --workspace /absolute/path/to/design-workspace --open --json
```

`--workspace` is where designs are stored. Omit it and the CLI uses the current directory. `--json` prints one JSON result on stdout. `--port` picks a management port; omit it and the OS assigns one. Each workspace has one server: calling `start` again reuses it. Different workspaces run side by side on different ports.

The canvas has no session token. After `start`, open `http://127.0.0.1:<port>/`. The first visit asks you to confirm **Dùng preview này**; **Đổi preview** switches later. `--open` already passes the preview URL. Management APIs check `Host` and `Origin`, so another website cannot call into your workspace.

`status` reports whether that workspace’s server is running. `stop` shuts it down. Command details for project, screen, prototype, capture, snapshot, selection, and MCP are in the [skill command reference](skills/local-design-canvas/references/commands.md).

## Workspace

```text
design-workspace/
  .local-canvas/
    runtime.json        # pid, port, instance id — leave this out of Git
    server.log
  projects/
    shop-dashboard/
      project.json       # server-owned: id, revision, screens, layout
      design-system.css  # shared tokens
      screens/
        overview/
          index.html
          styles.css
          script.js       # optional
      assets/
      prototypes/         # server-owned prototype JSON
      snapshots/
      artifacts/
        captures/         # preview PNGs and render diagnostics
        references/       # reference-fetch JSON and full-page PNGs
```

Edit files under `screens/`, `assets/`, and `design-system.css`. Leave `project.json`, `prototypes/`, and `.local-canvas/` to the server. The skill and runtime live in the release bundle, outside this workspace, so upgrading the app leaves existing designs in place.

## Install the skill

Build first. The installer copies `dist/release/local-design-canvas` and exits if that directory is missing. The target directory must already exist, and the installer refuses to overwrite an existing `local-design-canvas` skill. It does not change the agent’s configuration and does not delete a design workspace.

```bash
node scripts/install-skill.mjs --target /absolute/path/to/skill-parent
```

For Codex in this environment, install it into the personal skill parent:

```bash
mkdir -p ~/.codex/skills
node scripts/install-skill.mjs --target ~/.codex/skills
```

For Claude Code, the project-scoped location keeps the skill inside the repository and out of your personal configuration:

```bash
mkdir -p .claude/skills
node scripts/install-skill.mjs --target .claude/skills
```

A project-scoped install is picked up when you open a session in that project. The personal location is separate and applies to every project:

```bash
mkdir -p ~/.claude/skills
node scripts/install-skill.mjs --target ~/.claude/skills
```

Restart the agent session after installation and invoke `local-design-canvas` when needed. Claude Code can list it as `/local-design-canvas`; Codex discovers the installed `SKILL.md` according to its active skill configuration.

## MCP

`mcp serve` speaks the Model Context Protocol on stdio. stdout is the protocol channel; diagnostics go to stderr. It starts or attaches to the workspace server and exposes `canvas_status`, project and screen tools, `screen_capture`, `reference_fetch`, `screen_focus`, `screen_edit_start`, `screen_edit_done`, `selection_get`, and prototype source/list/get/create/update/regenerate/delete. A host config example is in [docs/usage.md](docs/usage.md).

```bash
node dist/release/local-design-canvas/scripts/run.mjs mcp serve \
  --workspace /absolute/path/to/design-workspace
```

## Repository

| Path | Role |
| --- | --- |
| `packages/core` | Schema, paths, and the project store |
| `packages/cli` | The `start`, project, screen, prototype, capture, and reference commands |
| `packages/server` | Local HTTP API, file watching, snapshots, prototypes, reference fetch, and Figma export |
| `packages/canvas` | The React canvas |
| `packages/mcp` | The stdio MCP adapter |
| `packages/preview-bridge` | Scripts injected into screen previews |
| `skills/local-design-canvas` | Skill source copied into the release |
| `templates/basic-screen` | Starter screen copied into the release |
| `tests/` | Vitest unit and integration tests, plus Playwright end-to-end tests |

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
```

`npm run test:e2e` needs the Chromium install from [Requirements](#requirements).

## When a command fails

- `SERVER_NOT_RUNNING`: run `start` for that workspace before project or screen commands.
- `REVISION_CONFLICT`: read the project again, then retry the same operation.
- `BROWSER_NOT_INSTALLED`: run `npx playwright install chromium`.
- `PORT_IN_USE`: drop `--port` so the OS can assign a free port.
- The canvas says it is reconnecting: run `start` again and open the URL in `.local-canvas/runtime.json`. Saved designs stay on disk.
- `selection get` reports `stale: true`: the screen source changed after the click. Select the element again.
- Deeper logs are in `.local-canvas/server.log`. The Vietnamese guide’s troubleshooting section is [docs/usage.md](docs/usage.md).
