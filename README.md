# Local Design Canvas

Local Design Canvas lets an agent create static HTML/CSS/JavaScript screens in a workspace and show them in a local multi-screen canvas. It uses Node.js 22.12 or later, binds its servers to `127.0.0.1`, and has no model API key or CDN dependency.

Hướng dẫn sử dụng chi tiết bằng tiếng Việt: [docs/usage.md](docs/usage.md).

## Build and run

```bash
npm install
npm run build
node dist/release/local-design-canvas/scripts/run.mjs start \
  --workspace /absolute/path/to/design-workspace --open --json
```

The runner works from the release directory and includes its built CLI, server, canvas assets, and template. See the [skill command reference](skills/local-design-canvas/references/commands.md) for project, screen, capture, snapshot, selection, and MCP commands.

## Install the skill

The installer requires an existing target directory and refuses to overwrite an existing `local-design-canvas` skill.

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

Restart the agent session after installation and invoke `local-design-canvas` when needed. Claude Code can list it as `/local-design-canvas`; Codex discovers the installed `SKILL.md` according to its active skill configuration. The installer does not change either agent's configuration.

## Checks

```bash
npm run typecheck
npm test
npm run test:e2e
```

M1 covers static screen source, local preview, canvas layout, live refresh, and a local skill. M2 adds preview screenshots with render diagnostics, screen variants, and source snapshots with restore. M3 adds element selection (a Select mode on the canvas that reports the clicked element as structured context for the agent), screen focus and edit locks so the agent knows which screen is highlighted or being edited, and an MCP adapter (`mcp serve`) that exposes the same operations as the CLI over stdio.

Run the MCP adapter over stdio with:

```bash
node dist/release/local-design-canvas/scripts/run.mjs mcp serve --workspace /absolute/path/to/design-workspace
```

It exposes `canvas_status`, `project_list`, `project_create`, `screen_list`, `screen_add`, `screen_focus`, `screen_edit_start`, `screen_edit_done`, `screen_capture`, `reference_fetch`, and `selection_get`. stdout is the protocol channel; diagnostics go to stderr. The CLI and MCP are two ways to reach the same runtime; the skill keeps working with the CLI if you do not need MCP.

`reference fetch <url>` opens a real URL in a headless browser on your machine and saves the page's title, headings, section text, links, and a full-page screenshot under the project's `artifacts/references`. It is a layout reference for building a similar static design, not a way to copy a page's content or assets.
