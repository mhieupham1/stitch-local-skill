# Commands

Set `canvas` to the installed release runner. Quote every path and display name.

```bash
canvas='node /absolute/path/to/local-design-canvas/scripts/run.mjs'
workspace='/absolute/path/to/design workspace'
```

Every command accepts `--workspace "$workspace"` and can emit exactly one JSON result with `--json`.

| Goal | Command |
| --- | --- |
| Inspect the runtime | `$canvas status --workspace "$workspace" --json` |
| Start and open the canvas | `$canvas start --workspace "$workspace" --open --json` |
| Stop its own workspace runtime | `$canvas stop --workspace "$workspace" --json` |
| List projects | `$canvas project list --workspace "$workspace" --json` |
| Create a project | `$canvas project create shop-dashboard --name 'Quản lý bán hàng' --workspace "$workspace" --json` |
| Rename a project | `$canvas project rename shop-dashboard --name 'Cửa hàng' --workspace "$workspace" --json` |
| List a project's screens | `$canvas screen list --project shop-dashboard --workspace "$workspace" --json` |
| Add a screen | `$canvas screen add overview --project shop-dashboard --name 'Tổng quan' --width 1440 --height 1000 --workspace "$workspace" --json` |
| Move or resize a frame | `$canvas screen update overview --project shop-dashboard --x 1600 --y 0 --width 1280 --height 900 --workspace "$workspace" --json` |
| Capture a preview | `$canvas screenshot overview --project shop-dashboard --workspace "$workspace" --json` |
| Duplicate a screen | `$canvas screen duplicate overview --new-id overview-alt --project shop-dashboard --workspace "$workspace" --json` |
| Delete screens | `$canvas screen delete overview-alt stale-draft --project shop-dashboard --workspace "$workspace" --json` |
| Change layer order | `$canvas screen order detail home --project shop-dashboard --workspace "$workspace" --json` |
| Export a screen for Figma | `$canvas figma export overview --project shop-dashboard --workspace "$workspace" --json` |
| Save/restore a snapshot | `$canvas snapshot create --project shop-dashboard --workspace "$workspace" --json` / `$canvas snapshot restore <snapshot-id> --project shop-dashboard --workspace "$workspace" --json` |
| Read the screen highlighted on the canvas | `$canvas screen focus --project shop-dashboard --workspace "$workspace" --json` |
| Lock a screen while editing | `$canvas screen edit start --project shop-dashboard --screen overview --message 'Đang chỉnh sửa…' --workspace "$workspace" --json` |
| Read the current edit lock | `$canvas screen edit status --project shop-dashboard --workspace "$workspace" --json` |
| Unlock after editing | `$canvas screen edit done --project shop-dashboard --workspace "$workspace" --json` |
| Read the current element selection | `$canvas selection get --project shop-dashboard --workspace "$workspace" --json` |
| Read source fingerprints for a prototype | `$canvas prototype sources --project shop-dashboard --screens home,detail --workspace "$workspace" --json` |
| List/read prototypes | `$canvas prototype list --project shop-dashboard --workspace "$workspace" --json` / `$canvas prototype get booking --project shop-dashboard --workspace "$workspace" --json` |
| Create/update/regenerate a prototype | `$canvas prototype create booking --project shop-dashboard --input prototype.json --workspace "$workspace" --json` / `$canvas prototype update booking --project shop-dashboard --input patch.json --workspace "$workspace" --json` / `$canvas prototype regenerate booking --project shop-dashboard --input regeneration.json --workspace "$workspace" --json` |
| Delete a prototype | `$canvas prototype delete booking --project shop-dashboard --revision 2 --workspace "$workspace" --json` |
| Fetch a page as a design reference | `$canvas reference fetch 'https://example.com/page' --project shop-dashboard --workspace "$workspace" --json` |
| Serve the MCP adapter over stdio | `$canvas mcp serve --workspace "$workspace"` |

`reference fetch <url>` opens the URL in a headless browser on the user's machine and returns `title`, `headings`, `sections`, `links`, plus `imagePath` (a full-page screenshot) and `dataPath`, both under `artifacts/references`. It fetches whatever URL you pass, so confirm the URL with the user first. Treat the result as a layout reference only: build your own static HTML/CSS and do not copy the source page's content or assets.

`screen focus` returns the screen the user last highlighted on the canvas (`screenId`, `name`, `entry`). Use it when they say "this screen" without naming one. `NO_SCREEN_FOCUS` means nothing is highlighted yet.

`screen edit start` locks that frame on the canvas (overlay + no interaction or element selection) so the user can see an edit is in progress. Omit `--screen` to use the focused screen. Always call `screen edit done` when finished or if the edit fails. Sessions also expire after five minutes.

`selection get` returns `{ context, stale }`. `context` has `screenId`, `selector`, `elementId`, `text`, and `bounds`; edit only that screen. When `stale` is `true`, the screen source changed after the click, so re-read the source or ask the user to select again before editing. A copied ID in the user's prompt is a `data-design-id` stored in the screen HTML: locate that exact attribute within the project and confirm one matching element before editing. Prefer the explicit ID over the current selection. IDs assigned to static HTML persist; JavaScript-created elements need an explicit `data-design-id` in their creation code. `mcp serve` speaks the Model Context Protocol on stdio: stdout is the protocol channel, logs go to stderr. It exposes the same operations as the CLI, including `project_rename`, `screen_list`, `screen_update`, `screen_duplicate`, `screen_delete`, `screen_capture`, `screen_focus`, `screen_edit_start`, `screen_edit_done`, `snapshot_create`, `snapshot_restore`, `figma_export`, and the `prototype_*` tools.

`screen add` returns `data.entryPath`, the absolute `index.html` to edit. Its `styles.css` is in the same directory. A project also has `design-system.css` for tokens shared by all screens.

`screen delete` and `screen order` take screen IDs as positional arguments. Deletion is permanent and the project must keep at least one screen, so `LAST_SCREEN` means the operation was refused, not that the screen is gone. Take a `snapshot create` first when the screens you are removing might be wanted again. `screen order` must list every screen in the project in the layer order you want, front-most first; a partial list is rejected rather than applied. Both read the current revision before writing, so a canvas edit that lands in between fails with `REVISION_CONFLICT` instead of being overwritten.

`figma export` renders one screen in a headless browser and returns its element tree, layout, styles and text as structured JSON for pasting into Figma. It is the same export the canvas UI offers.

Prototype input JSON for `create` has `{ "id", "name", "screenIds", "startScreenId", "transitions", "expectedSourceBaseline" }`; each transition has `{ "fromScreenId", "elementId", "toScreenId" }`. `update` accepts `{ "expectedRevision", "name"?, "screenIds"?, "startScreenId"?, "transitions"? }`. If adding/removing screens, keep the start and transitions inside the new set; this keeps existing fingerprints and marks new membership stale until regeneration. `regenerate` accepts `{ "expectedRevision", "screenIds", "startScreenId", "transitions", "expectedSourceBaseline" }`. Use `prototype sources` before analysis and again before saving; if the values changed, inspect the UI again. Prototype IDs are stable and unique within their project. The preview is live, while stale links are changed only on the user's request to regenerate or edit.

Commands return `{ "ok": true, "data": ... }` on stdout and exit 0. They return `{ "ok": false, "error": { "code", "message" } }` and exit 1 on a recoverable error. Resolve a `REVISION_CONFLICT` by reading the current project or screen list and retrying only the requested operation. If `SERVER_NOT_RUNNING`, run `start`; do not create metadata files by hand.
