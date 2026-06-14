# AGENTS.md

## Cursor Cloud specific instructions

### What this codebase is
`autoAI` is a single **Electron + React + TypeScript desktop app** (no separate backend
server). It has two pillars:
- **Unified AI chat** — drives multiple AI websites (ChatGPT/Claude/Gemini/…) from one UI.
- **Stagent** — a decision-first workflow engine in `packages/stagent-core` (`@stagent/core`),
  glued into the main process under `src/main/stagent/`.

Standard commands live in `README.md` and `package.json` `scripts`; prefer those. Key ones:
`npm run dev`, `npm run build`, `npm run lint`, `npm test`, `npm run test:e2e`, `npm run feedback`.

### Running / testing notes (non-obvious)
- **Dev mode needs a display.** `npm run dev` (electron-vite dev) launches a real Electron
  window and requires `DISPLAY` (the cloud VM provides `:1`). On the virtual display you will
  see benign startup noise that does **not** indicate failure: `Failed to connect to the bus`,
  `Exiting GPU process due to errors during initialization`, and `GpuControl.CreateCommandBuffer`
  errors. The app is healthy once the log prints `Main window created` and
  `adapter: local OpenAI-compatible server started` (http://127.0.0.1:8787).
- **The Stagent engine builds automatically.** `predev`/`prebuild`/`pretest`/`pretypecheck`
  run `npm run build:core` (compiles `@stagent/core` via `tsc -b`). You normally don't need to
  build it by hand.
- **Offline-friendly smoke test for the engine:** `npm run feedback` runs the mock headless
  pipeline (construct → polish → generate → execute → charter) end-to-end with no network and
  should report `6/6 passed`. Note it rewrites `artifacts/headless-feedback.json` /
  `artifacts/headless-feedback.trace.jsonl` — revert those if you didn't mean to commit them.
- **e2e tests are self-contained:** `npm run test:e2e` runs `npm run build` then Playwright
  against a real Electron process, using a local mock HTTP server in `e2e/helpers/` (no network,
  no AI logins). Each test gets its own temp `--user-data-dir`.
- **Lint passes with warnings.** `npm run lint` currently emits a few `no-useless-escape` /
  `no-misleading-character-class` warnings (0 errors) — that is the expected baseline.

### What needs external access (cannot be done offline)
- Real **unified chat** and Stagent **execution against a live model** require either a logged-in
  AI website (network + account) or an OpenAI-compatible API key configured in the Stagent
  "API 设置" panel. Without those, the model list shows "无可用模型".
- A fully-offline core action is still possible: add an AI resource via Resources → "其他"
  (custom site). Pointing it at a local URL such as `http://127.0.0.1:8787/health` loads the
  built-in adapter and persists a `SiteConfig` that then appears in "AI 资源管理".
- A startup dialog `degraded:quality_gate_dependency_inconsistent` (a Stagent self-check) may
  appear; it is benign — dismiss it with "确定".

### Node version
CI (`.github/workflows/verify-engine.yml`) uses Node 20; the app also runs fine on Node 22.
