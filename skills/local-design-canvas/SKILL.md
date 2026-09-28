---
name: local-design-canvas
description: Use when creating or revising a local HTML, CSS, and JavaScript design project that should be arranged and previewed in Local Design Canvas.
---

# Local Design Canvas

Use the installed release's `scripts/run.mjs`; it carries the matching local CLI, server, canvas, and starter template. Work in the design workspace the user chose, never in the skill directory.

## Workflow

1. Read the current runtime state before making a project change:
   ```bash
   node /absolute/path/to/local-design-canvas/scripts/run.mjs status --workspace /absolute/path/to/design-workspace --json
   ```
   If it is not running, start it with `start --open` so the user can see the canvas. Keep `--json` when another command needs to consume the result.
2. List projects. Choose the requested existing project, or create a slug ID and a display name. List its screens before adding only the missing screens.
3. Add each screen through the CLI, then edit the returned `entryPath` and neighboring `styles.css`. Build the UI with semantic HTML and local CSS, keeping typography, spacing, and color consistent across a screen set by putting shared tokens in `design-system.css`. Edit only the screens relevant to the user's request. `project.json` and `.local-canvas/` are server-owned metadata; do not edit either directly. See [the design workflow](references/design-workflow.md) for designing a screen set from scratch.
   - Cloning a page: when the user gives a web page as a reference or asks to clone a page's UI, confirm the URL with them, run `reference fetch <url> --project <project-id> --json`, then open the saved full-page screenshot and study it as the source of truth. Build a screen that matches the layout, spacing, colors, and typography, then `screenshot` it and compare to the reference, fixing concrete differences and repeating until it matches. It opens the URL in a headless browser on the user's machine; replace real images and copyrighted text with placeholders and keep the result as local static files.
4. Before editing a screen or a selected element, lock the canvas frame so the user sees an editing state and cannot Interact/Select it:
   ```bash
   node /absolute/path/to/local-design-canvas/scripts/run.mjs screen edit start --project <project-id> --screen <screen-id> --message 'Đang chỉnh sửa…' --workspace /absolute/path/to/design-workspace --json
   ```
   If the user already focused a screen, omit `--screen` and the runtime uses the focused one. After the source edits finish (or if they fail), always clear the lock:
   ```bash
   node /absolute/path/to/local-design-canvas/scripts/run.mjs screen edit done --project <project-id> --workspace /absolute/path/to/design-workspace --json
   ```
5. Source changes appear in the matching preview automatically. For visual verification, run `screenshot <screen-id> --project <project-id> --json`, inspect its PNG and diagnostics, then edit and capture again. Stop after three edit/capture loops and report what remains unresolved. Use `screen duplicate` for a variant and `snapshot create` before risky changes.
6. When the user refers to the screen selected on the canvas without naming it ("this screen", "the one I selected"), run `screen focus --project <project-id> --json`. It returns the screen highlighted in the sidebar or by clicking its frame: `screenId`, `name`, and `entry`. Edit that screen. If the command returns `NO_SCREEN_FOCUS`, ask which screen. When the user asks to change "this" element after clicking one in Select mode, read `selection get --project <project-id> --json` instead; that is more specific than the focused screen. Use its `selector` or `elementId` and edit only that screen. If the response reports `stale: true`, the source changed after the click; ask the user to select again or re-read the source before editing. Give key elements a stable `data-design-id` so selection maps cleanly.
7. Read `status` when a command or preview fails. Report the project, screens, source files changed, and whether the canvas is running. Include the exact recoverable CLI error when one occurs.

Read [the command reference](references/commands.md) before operating the runtime. Read [the design workflow](references/design-workflow.md) when creating a screen set or revising an existing design.

## Boundaries

- Pass the workspace path on every command. Paths may contain spaces or Unicode; pass them as one shell argument.
- Use lowercase ASCII slug IDs. Do not overwrite a project or screen that already exists.
- Keep each screen as static HTML/CSS/optional JavaScript with local assets. Do not install packages, run a build inside a design project, or introduce CDN assets.
- The canvas API is bound to `127.0.0.1` and checks `Host`/`Origin`; never point a design screen at the management port or try to proxy it from a design file.
