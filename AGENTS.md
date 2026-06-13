# AGENTS.md

## Cursor Cloud specific instructions

autoAI is a single Electron + React + TypeScript desktop product with an embedded
`@stagent/core` workflow engine (`packages/stagent-core`). Package manager is **npm**
(root `package-lock.json`). Standard build/run/test commands live in `README.md` and the
root `package.json` `scripts` — use those; the notes below only cover non-obvious caveats.

### Running / building
- Dev: `npm run dev` (electron-vite). It launches a real Electron GUI, so a display is
  required — use `DISPLAY=:1` in this environment. D-Bus / GPU / "Exiting GPU process"
  errors at startup are benign in headless and do not block the app.
- `@stagent/core` is compiled automatically by the `pre*` npm hooks before
  `dev`/`build`/`test`/`typecheck` (`npm run build:core` = `tsc -b packages/stagent-core`).
  Only run `build:core` yourself if importing the engine standalone.
- The app starts an in-process OpenAI-compatible **local adapter** on
  `http://127.0.0.1:8787` (endpoints `/health`, `/v1/models`, `/v1/chat/completions`).
  It auto-falls back to the next free port if 8787 is taken, and can be disabled with
  `AUTOAI_ADAPTER_ENABLE=0`. `/v1/models` is empty until AI sites are added.

### Testing
- Unit tests (`npm test`, vitest) and the mock Stagent pipeline (`npm run feedback`,
  6/6) are self-contained — no network or API keys needed.
- E2E (`npm run test:e2e`) builds first, then launches real Electron via Playwright; it
  needs `DISPLAY=:1`. Mock site + mock LLM servers stand in for real AI accounts.
- GUI caveat: raw X11 clicks (xdotool / computer-use) do **not** route to the Electron
  window in this headless environment. Drive the UI through Playwright (which attaches via
  CDP) instead of clicking the live window.

### Known pre-existing failures (NOT environment issues)
This repo is the `autoAI` subfolder of a larger monorepo, so a few tests reference data
that lived outside it:
- 3 `@stagent/core` tests fail with `ENOENT .../.stagent/charter/calibration/questions.jsonl`
  — the seed file lived above the `autoAI` folder (their `REPO_ROOT` resolves to `/`) and
  is absent from this checkout.
- 1 `@stagent/core` `behavior-spec-gate` test (Run #54) fails on a pure-logic assertion.
- 1 e2e test `stagent-prototype.spec.ts` fails (the "开始执行" button stays disabled via the
  generation gate) — same engine area as the behavior-spec failure.
- `npm run typecheck` reports pre-existing type errors in test/renderer files; `npm run
  lint` passes with warnings only.
