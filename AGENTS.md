# AGENTS.md

## Cursor Cloud specific instructions

autoAI is an **Electron + React + TypeScript desktop app** with two pillars: (1) a unified
multi-account AI chat client that drives real AI websites (ChatGPT/Claude/Gemini/…) in embedded
isolated browser views, and (2) **Stagent** (`packages/stagent-core`, `@stagent/core`), a
decision-first workflow engine. The dev environment is refreshed by the startup update script
(`npm install`); `predev`/`prebuild`/`pretest`/`pretypecheck` automatically run `npm run build:core`
first, so you rarely need to build the core engine by hand.

Standard commands live in `README.md` and `package.json` `scripts`. Key ones: `npm run dev`
(electron-vite dev), `npm run lint`, `npm test` (vitest), `npm run test:e2e` (build + Playwright
against the real Electron app), `npm run feedback` (offline mock Stagent pipeline). Engine-only
tests: `cd packages/stagent-core && npm test`.

### Non-obvious caveats

- **Headless GUI needs `--disable-gpu --no-sandbox`.** `npm run dev` launches Electron without these
  flags; under the cloud's headless X server the GPU process fails to init and the renderer becomes
  **input-unresponsive** (mouse clicks/keyboard don't reach the React UI even though the window paints).
  To drive the GUI manually, launch the built app with the flags, e.g.
  `npm run build` then `./node_modules/.bin/electron out/main/index.js --disable-gpu --no-sandbox`.
  Even then, **synthetic keyboard input (xdotool) is not reliably delivered to the renderer's
  controlled inputs** in this environment — Playwright works because it injects via CDP.
- **Prefer Playwright E2E / the local adapter for end-to-end checks**, not manual GUI typing. The
  E2E fixture (`e2e/fixtures/electron-app.ts`) already passes `--disable-gpu --no-sandbox` and uses a
  mock AI HTTP server (`e2e/helpers/mock-site.ts`) + seeded store (`e2e/helpers/seed-store.ts`), so no
  network or real AI accounts are required.
- **Local OpenAI-compatible adapter:** when the app runs, it starts a server on `http://127.0.0.1:8787`
  (`/health`, `/v1/models`, `/v1/chat/completions`) that injects prompts into the connected site and
  returns the captured reply. This is a reliable headless way to exercise the chat pillar end-to-end:
  seed a `sites.json` pointing at a local mock page, launch the app, then POST to `/v1/chat/completions`.
- **Real AI chat requires user accounts.** Clicking an onboarding card opens that AI site's login page
  in an embedded view; completing login needs real credentials. The Stagent GUI flow needs an LLM:
  either a `direct:` model (API key + base URL) or a connected browser site backing the `:8787` adapter.
  Use `npm run feedback` (mock LLM) to exercise the Stagent engine without credentials.
- **Known pre-existing test failures (not environment issues):**
  - `npm run test:e2e` → `e2e/stagent-prototype.spec.ts` ("开始执行" stays disabled) fails consistently.
    All other 28 E2E tests pass.
  - `cd packages/stagent-core && npm test` → 4 failures: 3 reference a missing
    `.stagent/charter/calibration/questions.jsonl` (the test resolves a repo root 5 levels up,
    expecting this checkout to be nested inside a larger monorepo; the data file is absent in the
    standalone repo), plus 1 `behavior-spec-gate` lint assertion. The other ~890 engine tests pass.
  - CI (`.github/workflows/verify-engine.yml`) does NOT run the full core suite; it runs the parity
    script and `vitest run src/renderer/src/__tests__`.
