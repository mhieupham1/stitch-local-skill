# Local Prototype Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Chọn nhiều màn hình để copy prompt cho Codex tạo prototype có ID riêng, Play luồng click giữa các màn hình gốc, và chủ động tạo lại khi UI nguồn đổi.

**Architecture:** Prototype là JSON riêng dưới project, tham chiếu screen ID và `data-design-id`; server xác thực, lưu nguyên tử và so dấu vân tay nguồn. Canvas chỉ chuẩn bị prompt và chạy player; agent dùng CLI/MCP + skill để suy luận hoặc tạo lại luồng, không có model trong server.

**Tech Stack:** TypeScript, React 19, Fastify 5, Zod 4, Vitest, Playwright, Node.js >=22.12.0.

**Spec:** `docs/superpowers/specs/2026-09-29-local-prototype-design.md`

## Global Constraints

- Prototype không sao chép HTML/CSS/JS và không trở thành một `Screen` trong `project.json`.
- Click **Tạo prototype** hoặc **Copy prompt tạo lại** chỉ sao chép prompt; Codex chỉ chạy khi người dùng paste prompt trong cuộc trò chuyện.
- Prototype ID là slug duy nhất trong project; prompt sửa/tạo lại dùng cặp `projectId/prototypeId`.
- Play dùng UI mới nhất và liên kết đã lưu; nguồn đổi chỉ đánh dấu **Cần tạo lại**, không tự sửa liên kết hoặc xóa cảnh báo sau một edit lẻ.
- V1 chỉ nối sự kiện `click`; không thêm model API, chat trong Canvas, hotspot editor, animation, xuất bản Internet hay phụ thuộc CDN.
- Bảo toàn mọi thay đổi đang có trong worktree và project `projects/cgv-home`; chỉ commit các tệp thuộc task.

## Review Focus

- Clipboard bị từ chối: vẫn hiện nguyên prompt và nút thử copy lại (Task 4 E2E).
- Hai project có cùng prototype ID: thao tác không đọc/ghi nhầm project (Task 1 integration).
- Nguồn đổi giữa lúc agent đọc và ghi: trả `SOURCE_CONFLICT`, không ghi baseline mới (Task 1 integration).
- Click vào phần tử con bên trong hotspot: vẫn dùng ID của hotspot gần nhất đã nối (Task 5 E2E).
- Prototype stale có liên kết hỏng: Play báo lỗi cục bộ, không tự chuyển sang màn hình khác hoặc xóa liên kết (Task 5 E2E).

## File map

- `packages/core/src/schema.ts`: kiểu/schema `Prototype`, `PrototypeView`, transition và event `prototype.updated`.
- `packages/server/src/prototype-sources.ts`: hàm hash nguồn màn hình + nguồn dùng chung và so baseline.
- `packages/server/src/prototypes.ts`: CRUD, optimistic revision và ghi JSON nguyên tử trong project root.
- `packages/server/src/app.ts`, `packages/server/src/watcher.ts`: API, preview injection và sự kiện làm mới prototype/stale.
- `packages/cli/src/index.ts`, `packages/mcp/src/index.ts`: cửa vào agent qua API hiện có.
- `packages/canvas/src/features/prototypes/prompts.ts`: prompt tạo/tạo lại và copy fallback.
- `packages/canvas/src/features/prototypes/PrototypeList.tsx`: danh sách, ID, trạng thái stale và Play.
- `packages/canvas/src/features/prototypes/PrototypePlayer.tsx`: tab chạy thử, history và xử lý bridge.
- `packages/preview-bridge/src/index.ts`: script prototype click độc lập với bridge chọn phần tử.
- `packages/canvas/src/App.tsx`, `packages/canvas/src/api.ts`, `packages/canvas/src/styles.css`: tích hợp.
- `skills/local-design-canvas/{SKILL.md,references/commands.md}`, `docs/usage.md`, `README.md`: workflow agent/người dùng.

---

### Task 1: Prototype schema, source baseline và store

**Files:** Modify `packages/core/src/schema.ts`; create `packages/server/src/prototype-sources.ts`, `packages/server/src/prototypes.ts`, `tests/unit/prototype-schema.test.ts`, `tests/integration/prototypes-store.test.ts`.

**Interfaces:** Produce `Prototype`, `PrototypeView` (`Prototype & { stale: boolean; changedScreenIds: string[]; missingScreenIds: string[] }`), `PrototypeCreateInput` (`id`, `name`, `screenIds`, `startScreenId`, `transitions`, `expectedSourceBaseline`), `PrototypePatchInput` (`expectedRevision`, optional `name`, `screenIds`, `startScreenId`, `transitions`), `PrototypeRegenerateInput` (`expectedRevision`, `screenIds`, `startScreenId`, `transitions`, `expectedSourceBaseline`), `readPrototypeSources(workspace: string, projectId: string, screenIds: string[]): Promise<Record<string,string>>`, `listPrototypes(workspace: string, projectId: string): Promise<PrototypeView[]>`, `readPrototype(workspace: string, projectId: string, id: string): Promise<PrototypeView>`, `createPrototype(workspace: string, projectId: string, input: PrototypeCreateInput): Promise<PrototypeView>`, `updatePrototype(workspace: string, projectId: string, id: string, input: PrototypePatchInput): Promise<PrototypeView>`, `regeneratePrototype(workspace: string, projectId: string, id: string, input: PrototypeRegenerateInput): Promise<PrototypeView>`, `deletePrototype(workspace: string, projectId: string, id: string, expectedRevision: number): Promise<void>`. Only create/regenerate replace baseline. Reads tolerate a screen deleted after generation and report it in `missingScreenIds`; writes reject missing screens.

- [ ] **Step 1: Write failing tests** — `prototypeSchema` rejects duplicate `(fromScreenId, elementId)`, duplicate `screenIds`, and transitions outside the screen set; accepts example `cgv-home/movie-booking`. Store tests: create/read/list two prototypes, same prototype ID in a second project, duplicate ID 409, stale after selected-screen/shared-source changes, fresh after unrelated-screen change, `SOURCE_CONFLICT` if source changes after expected baseline, revision conflict, regenerate clears stale, ordinary update does not, a deleted screen appears in `missingScreenIds`, malformed JSON and symlinked `prototypes/` cannot escape project root.
- [ ] **Step 2: Run red** — `npm test -- tests/unit/prototype-schema.test.ts tests/integration/prototypes-store.test.ts`; expect new imports or assertions to fail.
- [ ] **Step 3: Implement schema and source hashing** — `prototypeSchema` with `schemaVersion: 1`, `revision`, `id`, `name`, `screenIds`, `startScreenId`, `sourceBaseline`, `transitions`; use existing `projectIdSchema`. Hash each selected screen directory plus `design-system.css`, `shared/`, `assets/` in deterministic name order; reject unsafe symlinks. Limit count/size of screens, transitions and file input with explicit Zod/server bounds.
- [ ] **Step 4: Implement store** — use existing `getProjectRoot`/path safety; serialize mutations per project, atomic temp+rename; validate screen membership; compare expected source hashes on create/regenerate before save; compute stale at read time; preserve baseline on ordinary update; reject conflict without changing file.
- [ ] **Step 5: Run green and commit** — same test command plus `npm run typecheck`; expect pass. Commit only Task 1 files.

### Task 2: Management API và live events

**Files:** Modify `packages/server/src/app.ts`, `packages/server/src/watcher.ts`, `packages/core/src/schema.ts`; create `tests/integration/prototypes-api.test.ts`.

**Interfaces:** Consume Task 1 store. Produce `GET /api/projects/:projectId/prototype-sources?screenIds=a,b`, `GET/POST /api/projects/:projectId/prototypes`, `GET/PATCH/DELETE /api/projects/:projectId/prototypes/:prototypeId`, `POST /api/projects/:projectId/prototypes/:prototypeId/regenerate`; JSON results use current `{ok,data}` envelope. `prototype.updated` uses existing SSE event envelope and carries project ID. PATCH accepts a partial metadata/transition payload + `expectedRevision`; regenerate accepts full screen set/start/transitions + `expectedRevision` and `expectedSourceBaseline`.

- [ ] **Step 1: Write failing API tests** — create/list/get/update/regenerate/delete, revision/source conflicts with 409 codes, wrong-project access 404, malformed JSON 500-style `INVALID_PROTOTYPE`, cross-origin write 403, and SSE notification after API mutation or direct JSON change. Assert unlink of a prototype emits refresh rather than `project.error`; selected-screen and shared-source edits refresh stale state.
- [ ] **Step 2: Run red** — `npm test -- tests/integration/prototypes-api.test.ts`; expect new routes/events to fail.
- [ ] **Step 3: Implement routes/events/watcher** — validate bodies with Task 1 schemas; add `prototype.updated` to `canvasEventSchema`; watcher treats `prototypes/` separately and refreshes on relevant source changes; preview denies direct access to `prototypes/` JSON through the static preview route.
- [ ] **Step 4: Run green and commit** — API test, `npm test -- tests/integration/projects-api.test.ts tests/integration/live-update.test.ts`, `npm run typecheck`; expect pass. Commit Task 2 files.

### Task 3: Agent-facing CLI, MCP và skill

**Files:** Modify `packages/cli/src/index.ts`, `packages/mcp/src/index.ts`, `skills/local-design-canvas/SKILL.md`, `skills/local-design-canvas/references/commands.md`, `docs/usage.md`, `README.md`; create `tests/integration/prototype-cli.test.ts`; modify `tests/integration/mcp.test.ts`.

**Interfaces:** Consume Task 2 API. CLI: `prototype sources --project <id> --screens <comma-separated-ids>`, `prototype list/get <id>/create <id>/update <id>/regenerate <id>/delete <id> --project <id>`, with create/update/regenerate reading JSON from `--input <path>` and delete using `--revision <n>`. MCP tools mirror list/get/create/update/regenerate/delete with structured inputs; all use management API, not a second store.

- [ ] **Step 1: Write failing integration tests** — CLI create/get/list/update/regenerate/delete via temporary JSON inputs, source/revision conflict error codes, MCP create/get/regenerate on same prototype, no stdout noise in JSON mode. Assert create does not touch source HTML or `project.json`.
- [ ] **Step 2: Run red** — `npm test -- tests/integration/prototype-cli.test.ts tests/integration/mcp.test.ts`; expect new CLI/MCP calls to fail.
- [ ] **Step 3: Implement CLI/MCP** — reuse `managementRequest`; validate `--input` file and command arguments; surface API errors unchanged. Update skill with explicit create/regenerate workflows: inspect current source, ensure needed `data-design-id`, call `sources`, infer only evidenced links, send `expectedSourceBaseline`, verify through API and Play, report uncertain links. A prompt addressing one transition uses update, not regenerate.
- [ ] **Step 4: Run green and commit** — same integration tests, `npm run typecheck`, `npm run build`; expect pass. Commit Task 3 files and generated release assets only if build workflow requires tracked assets.

### Task 4: Canvas selection prompt và prototype list

**Files:** Create `packages/canvas/src/features/prototypes/prompts.ts`, `packages/canvas/src/features/prototypes/PrototypeList.tsx`, `tests/unit/prototype-prompts.test.ts`; modify `packages/canvas/src/App.tsx`, `packages/canvas/src/api.ts`, `packages/canvas/src/styles.css`, `tests/e2e/canvas.spec.ts`.

**Interfaces:** Consume Task 2 list API + `prototype.updated`. Produce `createPrototypePrompt(projectId, screenIds): string`, `regeneratePrototypePrompt(projectId, prototypeId, screenIds): string`, and `PrototypeList` that renders ID, stale status, Play, and copy-regenerate action. Select at least two screens to expose Create button; no prototype is created on click.

- [ ] **Step 1: Write failing tests** — unit prompt contains exact IDs and instruction to use skill, with project ID preserved; E2E selects two screens, clicks **Tạo prototype**, reads clipboard, and verifies no prototype exists yet. Simulate clipboard rejection: prompt text remains visible and **Sao chép lại** works. Create a prototype via API and assert list item shows its ID/Play; edit selected source and assert **Cần tạo lại** plus prompt containing `projectId/prototypeId`.
- [ ] **Step 2: Run red** — `npm test -- tests/unit/prototype-prompts.test.ts`; `npm run test:e2e -- tests/e2e/canvas.spec.ts -g prototype`; expect failures.
- [ ] **Step 3: Implement Canvas UI** — add methods to `CanvasApi`, copy with `navigator.clipboard` and existing fallback pattern, load list on project change/SSE, render list separately from screens, open Play URL with encoded IDs and a `noopener` tab. Preserve existing edit/selection/multi-screen behavior.
- [ ] **Step 4: Run green and commit** — same tests plus `npm run typecheck`; expect pass. Commit Task 4 files.

### Task 5: Prototype bridge và Play tab

**Files:** Modify `packages/preview-bridge/src/index.ts`, `packages/server/src/app.ts`, `packages/canvas/src/App.tsx`, `packages/canvas/src/styles.css`; create `packages/canvas/src/features/prototypes/PrototypePlayer.tsx`, `tests/unit/prototype-bridge.test.ts`, `tests/e2e/prototype-player.spec.ts`.

**Interfaces:** Consume Task 2 get API and Task 4 Play URL. Produce `prototypeBridgeScriptSource({ projectId, screenId, nonce }): string` injected only when `prototype=<nonce>` query is present; bridge sends `prototype.ready`, `prototype.initialized` (including missing mapped IDs), and `prototype.click` messages. Player sends `prototype.init` with mapped element IDs and validates message `source`, nonce, project/screen ID and iframe `event.source` before navigation. Bridge accepts init only from its parent with the matching nonce and management origin. No new source-file JS is written.

- [ ] **Step 1: Write failing tests** — unit script emits only for prototype request and escapes JSON config. E2E opens Play, clicks nested child inside linked button, reaches target, Back/Restart/reload work; unmapped anchor stays within prototype; stale source keeps UI live and old links, missing ID displays warning without wrong navigation, missing target/preview shows recoverable error, spoofed `postMessage` cannot navigate.
- [ ] **Step 2: Run red** — `npm test -- tests/unit/prototype-bridge.test.ts`; `npm run test:e2e -- tests/e2e/prototype-player.spec.ts`; expect failures.
- [ ] **Step 3: Implement bridge/player** — injected bridge uses capture-phase click handling: nearest ancestor whose `data-design-id` is in the initialized mapping wins, `preventDefault`/`stopImmediatePropagation` before posting; suppress native anchor/form navigation for unmapped targets. Player waits for matching ready/init/initialized handshake before enabling iframe, displays missing mapped IDs without selecting another element, maintains screen history, and resets unexpected iframe navigation. Use a separate `?prototypeProject=...&prototypeId=...` Canvas URL mode instead of changing `project.json` or creating a source screen.
- [ ] **Step 4: Run green and commit** — unit/E2E commands above, `npm run typecheck`, existing selection E2E; expect pass. Commit Task 5 files.

### Task 6: End-to-end release verification

**Files:** Modify `tests/e2e/prototype-player.spec.ts`, `tests/integration/release.test.ts` only if end-to-end checks expose gaps in packaging; no unrelated refactor.

**Interfaces:** Consume all prior tasks; no new production interface.

- [ ] **Step 1: Add acceptance test** — fresh project with three screens: copy create prompt → create via CLI → list/Play → click home-to-detail-to-seat → edit home HTML → stale indicator + live UI with unchanged links → copy regeneration prompt with stable ID → regenerate via CLI → stale clears and revised link works. Assert no prototype source screen was created and `project.json` screen list is unchanged.
- [ ] **Step 2: Run red if acceptance exposes a gap, fix only owning code, then green** — `npm run test:e2e -- tests/e2e/prototype-player.spec.ts`; expect pass after fixes.
- [ ] **Step 3: Verify release and commit** — `npm test`, `npm run typecheck`, `npm run build`, `npm run test:e2e`, `git diff --check`; confirm installed release includes updated skill/CLI/player. Commit only Task 6 changes; report remaining limitations plainly.
