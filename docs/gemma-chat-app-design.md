# Gemma Chat — Complete Application Design & Forensic Reference

> **Source of truth for the Gemma Chat Electron application as it exists in the MindXpansion fork.**
> Origin: `https://github.com/ammaarreshi/gemma-chat` (upstream) → `https://github.com/MindXpansion/gemma-chat` (working fork)
> Local working copy: `/Users/bear/Development/gemma-chat/`
> Documentation maintained by: Bear (Daryl Lantz) & Claude
> First captured: 2026-05-13 (after EPIPE crash + port-collision + HF Xet stall diagnostic session)

---

## Purpose of This Document

This is a **living, working reference** for the entire Gemma Chat application. The goal is operational mastery: every function, every constant, every IPC channel, every external dependency, every file path the app touches, every error path, and every assumption it makes about its environment is captured here.

Written so that if we read it cold six months from now, on a plane with no internet, we could explain or rebuild any specific behavior from memory.

This is **not** a tutorial, **not** a user manual, and **not** AI-generated summary fluff. It is a forensic, fact-driven reference produced by reading the actual source line by line, validated against observed runtime behavior.

---

## Methodology

For each file:

1. **Role** — what this file is responsible for in the system
2. **Imports** — what it depends on (and what that implies)
3. **Exports** — what other parts of the system can use
4. **Constants & module-level state** — every named thing at module scope
5. **Functions & types** — signature, behavior, side effects, error handling
6. **IPC contracts** — channels registered or invoked (main ↔ preload ↔ renderer)
7. **Filesystem & network surface** — every path written, every URL hit
8. **Known bugs, patches, observed runtime behavior** — what we've actually seen, not what the code claims

After per-file deep-dive, cross-cutting sections cover the architecture, state machine, lifecycle, dependency graph, and prioritized risk register.

---

## Document Status & Change Log

| Date (MT) | Author | Change |
|---|---|---|
| 2026-05-13 19:40 | Bear + Claude | Document initialized. File inventory complete. Three patches already applied to source (EPIPE guard in `main/index.ts`; port move 11434→11437 in `main/mlx.ts`); covered in §Patches Applied. |
| 2026-05-17 18:09 | Bear + Claude | Doc migrated into the repo at `docs/gemma-chat-app-design.md` for version-controlled maintenance. New private repo `MindXpansion/MindXpansion-Gemma-Chat` created as canonical home; public fork `MindXpansion/gemma-chat` left in place per Bear's directive. Patch 4 added: `mlx-lm` → `mlx-vlm` migration for Gemma 4 multimodal support. |

---

## Source File Inventory

Counted: **4,857 source lines** across 19 source files + 9 config/meta files.

### Main process (TypeScript, runs in Node/Electron main)
| Lines | Path | Role (preliminary) |
|---|---|---|
| 596 | `src/main/index.ts` | Electron app entrypoint, window lifecycle, IPC handler registration |
| 520 | `src/main/mlx.ts` | MLX runtime install + `mlx_lm.server` subprocess lifecycle + HF model management |
| 593 | `src/main/tools.ts` | Tool/function-calling integration (largest file — unknown content) |
| 397 | `src/main/workspace.ts` | Per-conversation workspace directories (the `c_<timestamp>_<rand>` dirs) |

### Preload (security bridge between main and renderer)
| Lines | Path | Role (preliminary) |
|---|---|---|
| 90 | `src/preload/index.ts` | Exposes safe APIs to renderer via `contextBridge` |
| 7 | `src/preload/index.d.ts` | TypeScript ambient types for the bridge |

### Renderer (React, runs in Chromium)
| Lines | Path | Role (preliminary) |
|---|---|---|
| 13 | `src/renderer/index.html` | HTML shell |
| 10 | `src/renderer/src/main.tsx` | React entry |
| 161 | `src/renderer/src/App.tsx` | Top-level component, routing, global state |
| 232 | `src/renderer/src/components/Setup.tsx` | First-run download / progress screen (the lying-spinner UI) |
| 591 | `src/renderer/src/components/Chat.tsx` | Conversation surface |
| 393 | `src/renderer/src/components/Message.tsx` | Individual message rendering |
| 283 | `src/renderer/src/components/Composer.tsx` | Input bar |
| 349 | `src/renderer/src/components/Canvas.tsx` | "Build" tab — code generation surface |
| 81 | `src/renderer/src/components/Sidebar.tsx` | Conversation list navigation |
| 101 | `src/renderer/src/lib/whisper.ts` | Voice input via Whisper (not previously discussed) |
| 305 | `src/renderer/src/styles.css` | Global styles (Tailwind + custom) |
| 11 | `src/renderer/src/env.d.ts` | Vite env types |

### Shared
| Lines | Path | Role (preliminary) |
|---|---|---|
| 124 | `src/shared/types.ts` | Type definitions used across main/preload/renderer |

### Configuration & meta
| Lines | Path |
|---|---|
| 44 | `package.json` |
| 31 | `electron.vite.config.ts` |
| 29 | `electron-builder.yml` |
| 7 | `tsconfig.json` |
| 17 | `tsconfig.node.json` |
| 18 | `tsconfig.web.json` |
| 134 | `README.md` |
| 21 | `LICENSE` |
| 41 | `.gitignore` |

---

## Table of Contents

1. Executive Summary & Architecture Overview *(pending)*
2. Build & Configuration Layer *(pending)*
   - `package.json`
   - `electron.vite.config.ts`
   - `electron-builder.yml`
   - `tsconfig*.json`
3. Main Process *(pending)*
   - `main/index.ts`
   - `main/mlx.ts`
   - `main/tools.ts`
   - `main/workspace.ts`
4. Preload Bridge *(pending)*
   - `preload/index.ts`
   - `preload/index.d.ts`
5. Shared Types *(pending)*
   - `shared/types.ts`
6. Renderer *(pending)*
   - Entry & top-level (`main.tsx`, `App.tsx`, `index.html`)
   - `Setup.tsx` (and the lying-spinner investigation)
   - `Chat.tsx`
   - `Message.tsx`
   - `Composer.tsx`
   - `Canvas.tsx`
   - `Sidebar.tsx`
   - `lib/whisper.ts`
   - `styles.css`
7. Cross-Cutting *(pending)*
   - IPC contract map (every channel, every direction)
   - Data flow diagram (model selection → download → server start → first inference)
   - State machine (Setup → Loading → Ready → Error → Recovery)
   - Filesystem footprint (every path the app writes or reads)
   - Network footprint (every URL the app contacts)
   - Process tree (npm → electron-vite → Electron → Python `mlx_lm.server`)
8. Patches Applied (Our Fork's Divergence from Upstream)
9. Known Issues, Observed Runtime Behavior, & Risk Register *(pending)*
10. Recommended Hardening Roadmap *(pending)*

---

## §8 Patches Applied (Our Fork's Divergence from Upstream)

These are real, in-source changes we have made to the MindXpansion fork during the 2026-05-13 diagnostic session. Upstream (`ammaarreshi/gemma-chat`) does not yet have these.

### Patch 1 — EPIPE guard in `src/main/index.ts`

**Symptom:** App crashed at startup with `Error: write EPIPE` traced into `console.log` inside `locateMLX()` at `out/main/index.js:132:21`. The Python MLX detection was actually succeeding; `console.log` itself was throwing because `process.stdout` was a pipe whose other end was closed before main-process startup completed.

**Fix:** Added an EPIPE guard at the very top of `src/main/index.ts`, immediately after the `electron` import:

```ts
// EPIPE guard — Electron main can lose stdout to a closed pipe at startup,
// which turns the first console.log into an uncaught exception that crashes the app.
// See locateMLX() in ./mlx for the first call that surfaces this.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
```

**Verified:** Rebuild succeeded; subsequent `npm run start` no longer crashed at `locateMLX`.

**Upstream PR candidate:** Yes. This is a latent bug for anyone running the packaged build.

### Patch 2 — MLX server port move 11434 → 11437 in `src/main/mlx.ts`

**Symptom:** Bear's machine already runs Ollama, which auto-starts on login and binds `*:11434` (Ollama's documented default). Gemma Chat hardcoded `MLX_PORT = 11434` and would have failed with `OSError: [Errno 48] Address already in use` once the download phase completed. The first run didn't reveal this because the HF Xet download stall hit first.

**Fix:** Changed one line in `src/main/mlx.ts`:

```ts
const MLX_PORT = 11437  // was: 11434 — collides with Ollama default
```

`MLX_HOST` and `MLX_URL` derive from `MLX_PORT`, so a single-line change suffices.

**Verified:** Rebuilt `out/main/index.js` (verified `11437` present, `11434` absent). Ollama relaunched cleanly on 11434. `mlx_lm.server` bound to 11437 on subsequent runs.

**Upstream PR candidate:** Yes — but worth a discussion with upstream about whether to make it configurable rather than just shifting the magic number.

### Patch 3 — None yet on the renderer-vs-main IPC drift (the "lying spinner")

**Observed but not patched:** During HF downloads, the Setup screen reports "10%" or "12%" while `mlx_lm.server` has actually died silently (jetsam SIGKILL under memory pressure, or HF Xet protocol stall with no exception propagated). The renderer has no liveness check on the main-process MLX subprocess. To be diagnosed in §Renderer/Setup.tsx and §Cross-Cutting/state-machine.

> **Note on terminology:** After Patch 4 below, the subprocess is `mlx_vlm.server`, not `mlx_lm.server`. The failure pattern described above is unchanged — `mlx_vlm.server` has the same liveness-reporting gap, and may surface it more often under VLM memory pressure.

### Patch 4 — `mlx-lm` → `mlx-vlm` migration in `src/main/mlx.ts` (Gemma 4 multimodal)

**Motivation:** Gemma 4 — the latest grouping of Gemma models, released by Google in early May 2026 — is multimodal (vision + text). The MLX serving layer for vision-language models is the `mlx-vlm` package, not `mlx-lm`. To run the current generation of Gemma locally on Apple Silicon via MLX, the app must spawn `mlx_vlm.server` (not `mlx_lm.server`) and install the matching Python package into the dedicated venv.

**Fix:** ~10 substitutions in `src/main/mlx.ts`, all `mlx_lm` → `mlx_vlm` (and `mlx-lm` → `mlx-vlm` for the pip package name):

- `locateMLX()` venv probe: `import mlx_lm` → `import mlx_vlm`
- `installMLX()` pip install command: `mlx-lm>=0.24.0` → `mlx-vlm>=0.5.0`
- `installMLX()` post-install verification: same import swap
- `startServer()` subprocess spawn: `-m mlx_lm.server` → `-m mlx_vlm.server`
- `startServer()` log line documenting the spawn command
- Comments and log/error messages throughout (no behavioral effect, but kept consistent so future readers aren't misled)

**Other files affected:** None directly. The renderer never references the package name; the IPC contract speaks in terms of "MLX install progress" and "MLX server health," not "mlx_lm" or "mlx_vlm." This is why the swap is contained to a single file.

**Side effects to verify during deep dive:**
- `AVAILABLE_MODELS` in `src/shared/types.ts` — confirm the listed models are Gemma 4 (or otherwise multimodal-capable on `mlx-vlm`); a Gemma 2 text-only model listed here would silently fail to load on `mlx_vlm.server`.
- HuggingFace cache directories — `mlx-vlm` may write to a different cache path than `mlx-lm`, which would affect existing-installation detection.
- Memory footprint — vision-language models load both a vision encoder and a text decoder; the silent-jetsam failure pattern (Patch 3) may surface more often under VLM memory pressure than it did under text-only.

**Verified:** Local diff inspected line-by-line on 2026-05-17. Not yet rebuilt/tested end-to-end with the rebuilt `out/main/index.js` — verification belongs to the §Main Process / mlx.ts deep dive.

**Upstream PR candidate:** Conditional. Upstream `ammaarreshi/gemma-chat` may still target Gemma 1/2 text-only; pushing this swap upstream without making the package choice configurable would break their users. The right upstream contribution is probably a config flag (`mlx-lm` vs `mlx-vlm`) tied to the selected model — captured here for the §Recommended Hardening Roadmap.

---

# Section 1 — Build & Configuration Layer + Shared Types

This section establishes the ground truth for *how the application is assembled* and *what data contracts everything else depends on*. Everything in §§2–7 reads against this section. If something here is wrong, every later section inherits the error.

## 1.1 `package.json`

**Path:** `package.json` (44 lines, project root)

**Role:** npm manifest. Declares the Electron app's entry point, dev/build scripts, runtime dependencies, and dev dependencies. Read by `npm`, `electron`, `electron-builder`, and `electron-vite`.

### Fields of substantive interest

| Field | Value | Notes |
|---|---|---|
| `name` | `gemma-chat` | Used as artifact name in `electron-builder.yml` (`${name}-${version}.${ext}` → `gemma-chat-0.1.0.dmg`). |
| `version` | `0.1.0` | Embedded in DMG filename. Not bumped during the 2026-05-13 / 2026-05-17 sessions. |
| `description` | `Local AI chat on your Mac, powered by Gemma 3` | **STALE.** The app now targets Gemma 4 (see Patch 4 and `AVAILABLE_MODELS` below). Cosmetic, but trips up anyone reading the manifest for context. Captured in §Hardening Roadmap. |
| `main` | `./out/main/index.js` | Electron's main-process entry, written by `electron-vite build` from `src/main/index.ts`. The EPIPE crash (Patch 1) referenced `out/main/index.js:132:21`. |
| `author` | `Ammaar` | **STALE for this fork.** Upstream attribution still present; MindXpansion fork has not amended. Affects DMG metadata and any auto-update signature. Cosmetic for now; would matter if we ever publish updates. |
| `license` | `MIT` | MIT license file in repo root (21 lines). |
| `type` | `module` | All `.js` files in the package are ESM. `.ts` source compiles to ESM. Affects how `out/main/index.js` is loaded by Electron. |

### Scripts (every one, what it does, when we use it)

- `dev` → `electron-vite dev` — Runs the app in dev mode. Vite dev server for the renderer, hot-reloaded main/preload via `electron-vite`. **What we've been running tonight.**
- `build` → `electron-vite build` — Compiles `src/main`, `src/preload`, `src/renderer` into `out/`. Required before `start`, `pack`, or `dist`. **This is what rebuilds `out/main/index.js` so the EPIPE guard, the port move, and the mlx-vlm migration land in the executed file.**
- `start` → `electron-vite preview` — Launches Electron pointing at the built `out/` artifacts. Closest thing to a production-like run without packaging into a DMG.
- `pack` → `electron-vite build && electron-builder --dir` — Builds, then packages into `release/mac-arm64/Gemma Chat.app` *without* producing a DMG. Useful for sanity-checking the packaged-app behavior.
- `dist` → `electron-vite build && electron-builder` — Full distribution build: builds, packages, and produces the `gemma-chat-0.1.0.dmg`. Reads `electron-builder.yml`.
- `typecheck:node` → `tsc --noEmit -p tsconfig.node.json` — Type-checks main + preload + shared. No emit.
- `typecheck:web` → `tsc --noEmit -p tsconfig.web.json` — Type-checks renderer + preload (.d.ts) + shared. No emit.
- `typecheck` → both of the above in sequence. **No script runs `typecheck` as a precondition of `build` or `dist`.** Type errors do not block a build. This is a real gap — flagged for §Hardening Roadmap.

### Dependencies (runtime — ship inside the .app)

- `@electron-toolkit/preload ^3.0.1` — Convenience wrapper around `contextBridge` for safer preload patterns. Used in `src/preload/index.ts`.
- `@electron-toolkit/utils ^3.0.0` — Helpers used in `src/main/index.ts` (the `electronApp`, `optimizer`, `is` imports). `is.dev` etc.
- `@huggingface/transformers ^4.1.0` — In-renderer HF transformer runtime. **Notable:** also pulled in despite the fact that primary inference goes through the spawned `mlx_vlm.server` subprocess. Used by `src/renderer/src/lib/whisper.ts` for voice input (in-browser Whisper). Verify in §8 deep dive.
- `electron-updater ^6.3.9` — Auto-update client. Reads from `electron-builder.yml`'s `publish.url`, currently set to the placeholder `https://example.com/auto-updates`. **Auto-update is configured but will silently fail** because the URL is a placeholder. Captured for §Hardening Roadmap.
- `highlight.js ^11.11.1` — Syntax highlighting for code in chat messages (used in `src/renderer/src/components/Message.tsx`).
- `marked ^15.0.7` — Markdown → HTML renderer for assistant messages.

### Dependencies (dev — not shipped)

- `electron ^34.0.0` — Electron 34. Recent.
- `electron-builder ^25.1.8` — DMG packaging.
- `electron-vite ^3.0.0` — Vite-based build orchestrator for Electron's three contexts (main/preload/renderer).
- `vite ^6.0.11` — Underlying bundler.
- `react ^19.0.0` + `react-dom ^19.0.0` — React 19. **Important:** React 19 changed some semantics around `useEffect` cleanup and concurrent rendering — relevant when we get to §7 (Setup.tsx / Chat.tsx) and the lying-spinner bug.
- `@types/react ^19.0.7`, `@types/react-dom ^19.0.3` — Matching types.
- `@vitejs/plugin-react ^4.3.4` — React Fast Refresh / JSX plumbing for Vite.
- `tailwindcss ^3.4.17` + `postcss ^8.5.1` + `autoprefixer ^10.4.20` — CSS toolchain. `src/renderer/src/styles.css` is the entry; Tailwind configured implicitly via PostCSS pipeline (no `tailwind.config.js` was inventoried — verify in §7 styles deep dive).
- `typescript ^5.7.3` — TS compiler.
- `@types/node ^22.10.6` — Node typings for main/preload.
- `@electron-toolkit/tsconfig ^1.0.1` — Base tsconfigs extended by `tsconfig.node.json` and `tsconfig.web.json`.

### Notable absences

- **No test framework.** No Vitest, no Jest, no Playwright, no E2E. The "verification before completion" discipline currently rests entirely on manual run-and-see. Captured for §Hardening Roadmap — adding even minimal smoke tests around `mlx.ts` would have caught the port collision and the mlx-vlm import failure before they surfaced to the user.
- **No linter.** No ESLint, no Prettier (despite `.eslintignore` and `.prettierignore` being mentioned in `electron-builder.yml`'s file-exclusion list, neither config exists in the repo). Style is informal.
- **No `engines` field.** `mlx.ts` enforces Python ≥3.10 at runtime (see Patch reference at commit `3352e5b`), but Node version is unconstrained at the manifest level.

---

## 1.2 `electron.vite.config.ts`

**Path:** `electron.vite.config.ts` (31 lines, project root)

**Role:** Build configuration consumed by `electron-vite`. Tells Vite how to bundle each of the three Electron contexts (main, preload, renderer) separately.

### Structure

`defineConfig({ main, preload, renderer })` — one entry per context.

### `main` block (lines 6–13)

```ts
plugins: [externalizeDepsPlugin()],
resolve: { alias: { '@shared': resolve('src/shared') } }
```

- `externalizeDepsPlugin()` — **Critical for understanding the bundle.** Marks all `package.json` `dependencies` as external (not bundled into `out/main/index.js`). They're resolved at runtime from `node_modules`. This is why the .app bundle still needs `node_modules/` shipped (which `electron-builder` handles).
- `@shared` alias → `src/shared` so main can `import { AVAILABLE_MODELS } from '@shared/types'` (which `src/main/index.ts` line 3 does).

### `preload` block (lines 14–21)

Same shape as `main`: externalize deps, `@shared` alias. Preload runs in Electron's preload context, which has Node access but also is loaded into the renderer's window before page scripts.

### `renderer` block (lines 22–30)

- `plugins: [react()]` — Vite's React plugin (JSX, Fast Refresh).
- Two aliases: `@renderer` → `src/renderer/src`, and `@shared` → `src/shared`. So renderer code can do `import { SetupStatus } from '@shared/types'` and `import { Foo } from '@renderer/components/Foo'`.
- **No `externalizeDepsPlugin` here** — renderer dependencies (React, marked, highlight.js, @huggingface/transformers) *are* bundled into `out/renderer/`. This is normal for Electron renderers: bundled JS shipped to the Chromium context.

### What this file does *not* do

- No CSP configuration (handled in `src/main/index.ts` via Electron's `session.defaultSession.webRequest`).
- No environment-variable injection (no `define`).
- No source-map config (Vite defaults apply: source maps in dev, not in production builds).
- No build-output customization (uses electron-vite defaults: `out/main/`, `out/preload/`, `out/renderer/`).

---

## 1.3 `electron-builder.yml`

**Path:** `electron-builder.yml` (29 lines, project root)

**Role:** Production packaging configuration. Consumed by `electron-builder` during `npm run pack` and `npm run dist`. Tells it how to wrap `out/` into a `.app` and `.dmg`.

### Identity

- `appId: com.ammaar.gemmachat` — macOS bundle identifier. **STALE for this fork** (upstream's reverse-DNS). Affects macOS keychain entries, file associations, and any per-app launchd integration. Cosmetic until we ever distribute privately.
- `productName: Gemma Chat` — Display name on disk and in the Dock.

### Filesystem layout

- `directories.buildResources: build` — `build/` holds the .icns icon and any installer resources. `build/icon.iconset/` is gitignored (an intermediate); the final `build/icon.icns` is tracked.

### Files (what ships vs. what doesn't)

Exclusion patterns (lines 5–11) leave behind everything not needed at runtime:
- All of `src/` (compiled to `out/` already)
- Vite, TypeScript, ESLint, Prettier configs (build-time only)
- `.env*`, `.npmrc`, `pnpm-lock.yaml`, `dev-app-update.yml`
- VS Code workspace files

Notably **kept inside the .app**: `out/`, `node_modules/` (the runtime dependencies after externalization), and `package.json` (needed by Electron for `main` lookup and version metadata).

- `asarUnpack: resources/**` — Anything under `resources/` ships as loose files inside `.app/Contents/Resources/app.asar.unpacked/` instead of inside the asar archive. **No `resources/` directory exists in the repo yet** — this is dead config currently. Will become relevant if/when we ship pre-bundled Python or model files.

### macOS-specific

- `mac.icon: build/icon.icns` — Bundle icon.
- `mac.target: [{ target: dmg, arch: [arm64] }]` — **Apple Silicon ONLY.** No x86_64, no universal, no Linux, no Windows. A Mac on Intel cannot run this DMG. Captured for §Hardening Roadmap (or it may be a permanent intentional constraint — Gemma 4 inference performance on Intel Macs would be unusably slow anyway).
- `mac.category: public.app-category.productivity` — App Store category metadata.
- `mac.hardenedRuntime: true` — Required for notarization. We are not currently notarized (no `notarize:` block).
- `mac.gatekeeperAssess: false` — Skips local Gatekeeper validation during build.

### DMG

- `dmg.artifactName: ${name}-${version}.${ext}` → `gemma-chat-0.1.0.dmg`.

### Auto-update

- `publish.provider: generic` — Generic HTTP server.
- `publish.url: https://example.com/auto-updates` — **Placeholder.** `electron-updater` will attempt to fetch update manifests from a domain that returns nothing useful. Auto-update is wired but inert. Captured for §Hardening Roadmap.

### Other

- `npmRebuild: false` — Skips the post-install native-module rebuild step. Reasonable here because the only native-ish dep (`@huggingface/transformers`) uses prebuilt binaries.
- `electronDownload.mirror: https://npmmirror.com/mirrors/electron/` — **Notable:** Electron binary downloads pulled from npmmirror (a China-based mirror). Faster from some networks, slower or blocked from others. Inherited from upstream; reconsider for §Hardening Roadmap if this ever causes install issues for collaborators.

---

## 1.4 `tsconfig.json` + `tsconfig.node.json` + `tsconfig.web.json`

**Pattern:** TypeScript "project references." Root `tsconfig.json` is a thin orchestrator; the two real configs target the two type-checking contexts.

### Root `tsconfig.json` (7 lines)

```json
{ "files": [], "references": [
  { "path": "./tsconfig.node.json" },
  { "path": "./tsconfig.web.json" }
]}
```

Empty `files`, just composes the two project refs. `npm run typecheck` runs each in sequence.

### `tsconfig.node.json` (17 lines)

Extends `@electron-toolkit/tsconfig/tsconfig.node.json`.

- **Includes:** `electron.vite.config.*`, `src/main/**/*`, `src/preload/**/*`, `src/shared/**/*`.
- **`composite: true`** — enables project references; emits `.tsbuildinfo` (gitignored).
- **`types: ["electron-vite/node"]`** — pulls in electron-vite's node-context type declarations.
- **`paths.@shared/*`** → `src/shared/*` — matches the Vite alias so type-checking and runtime agree.

### `tsconfig.web.json` (18 lines)

Extends `@electron-toolkit/tsconfig/tsconfig.web.json`.

- **Includes:** `src/renderer/src/env.d.ts`, all of `src/renderer/src`, `src/preload/*.d.ts`, `src/shared/**/*`. The preload `.d.ts` is included here so the renderer knows the shape of `window.api` exposed by the bridge.
- **`composite: true`**.
- **`paths`** — `@renderer/*` → `src/renderer/src/*`, `@shared/*` → `src/shared/*`.

### Implication

Shared types in `src/shared/` are visible to **all three** Electron contexts. Main, preload, and renderer all type-check against the same `ChatMessage`, `SetupStatus`, etc. This is correct and important — it's the only mechanism keeping IPC contracts coherent across process boundaries.

---

## 1.5 `.gitignore` (filesystem hints for runtime)

**Path:** `.gitignore` (41 lines)

Most entries are unremarkable (`node_modules/`, `out/`, build artifacts). Two entries reveal runtime filesystem behavior the app depends on:

- `workspaces/` — **A runtime-managed directory.** Holds per-conversation working directories (the `c_<timestamp>_<rand>` dirs created by `src/main/workspace.ts`). Gitignored because it's user data, not source.
- `mlx-venv/` — **The auto-provisioned Python venv.** Created at runtime by `src/main/mlx.ts`'s `installMLX()` in the Electron `userData` directory (not in the repo root). Listed in `.gitignore` defensively in case any developer accidentally creates one inside the repo.
- Model-weight extensions (`*.gguf`, `*.safetensors`, `*.onnx`, `*.bin`, `*.pt`, `*.pth`) — defensive ignore. The app downloads weights via HuggingFace to the HF cache directory, not into the repo, so these are unlikely to appear here in practice, but the ignore prevents accidents.

---

## 1.6 `src/shared/types.ts` — The Contract Surface

**Path:** `src/shared/types.ts` (124 lines)

**Role:** Single source of truth for every type that crosses a process boundary. Imported by main, preload, and renderer alike. **If this file is wrong, the whole IPC system is wrong.**

### `SetupStage` (lines 1–7)

```ts
type SetupStage = 'checking' | 'installing-mlx' | 'starting-mlx'
  | 'downloading-model' | 'ready' | 'error'
```

The six legal values for `SetupStatus.stage`. **This is the state machine the Setup screen visualizes.** Every transition must come from `main/index.ts` over the `mlx:status` IPC channel (to be verified in §2). Anything the renderer thinks is a stage that isn't in this union is a bug.

**Observation for §7 / §9:** The lying-spinner bug means the renderer reports `downloading-model` with progress while the actual subprocess has died. The state machine itself is fine — the *liveness signal* feeding the state machine is the gap.

### `SetupStatus` (lines 9–16)

```ts
interface SetupStatus {
  stage: SetupStage
  message: string
  progress?: number       // 0..1
  bytesDone?: number
  bytesTotal?: number
  error?: string
}
```

The full payload sent on `mlx:status`. `progress` is a fraction; `message` is human-readable. `error` is populated only when `stage === 'error'` (convention — not type-enforced).

### `ToolCall` (lines 18–25)

```ts
interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
  running?: boolean
}
```

Tool/function-calling payload. **`args` is `Record<string, unknown>` — no schema enforcement at the type layer.** Validation lives in `src/main/tools.ts` (verify in §4 deep dive). `running` is set true while the tool is in-flight, cleared when `result` or `error` populates. The shape supports the streaming-tool-use pattern (model emits a call, we execute and stream back the result).

### `Role` and `ChatMessage` (lines 27–38)

```ts
type Role = 'user' | 'assistant' | 'system' | 'tool'
interface ChatMessage {
  id: string
  role: Role
  content: string
  toolCalls?: ToolCall[]
  createdAt: number       // unix ms
  model?: string
  done?: boolean
  activity?: AgentActivity
}
```

The conversation atom. Note `activity` is a per-message live indicator (see `AgentActivity` below), which is why the Composer can show "thinking" / "generating" / "calling tool X" inline.

### `AgentMode` and `ChatRequest` (lines 40–48)

```ts
type AgentMode = 'chat' | 'code'
interface ChatRequest {
  conversationId: string
  messages: Array<{ role: Role; content: string; toolCalls?: ToolCall[] }>
  model: string
  enableTools: boolean
  mode: AgentMode
}
```

The IPC payload that fires inference. **`mode: 'code'` is the Canvas/Build tab path** — different system prompt, different tool subset (verify in §7 Canvas + §4 tools). `conversationId` ties everything: workspace lookup, message persistence, file-change events.

### `WorkspaceInfo`, `WorkspaceFile`, `FileChangeEvent` (lines 50–64)

```ts
interface WorkspaceInfo { conversationId; path; previewUrl }
interface WorkspaceFile { path; kind: 'file'|'dir'; size? }
interface FileChangeEvent { conversationId }
```

The workspace contract. `previewUrl` strongly suggests the Canvas tab serves the workspace via a local HTTP server (verify in §5 workspace.ts and §7 Canvas.tsx) — likely how generated HTML/JS gets previewed in-app. **This is directly relevant to the goal of "filesystem access on an approved basis"**: the workspace abstraction is the existing primitive we'd extend.

### `AgentActivity` (lines 66–70)

```ts
type AgentActivity =
  | { kind: 'idle' }
  | { kind: 'thinking'; chars?: number }
  | { kind: 'generating'; chars?: number }
  | { kind: 'tool'; tool: string; target?: string; chars?: number }
```

Discriminated union for the live activity strip under each message. `chars` lets the UI estimate progress within a phase. `tool.target` is e.g. the filename being edited when the active tool is a file-write tool.

### `StreamChunk` (lines 72–78)

```ts
type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; result?; error? }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'done' }
  | { type: 'error'; error: string }
```

**The streaming inference protocol.** Every chunk emitted by main → renderer during an in-progress chat takes one of these six shapes. The renderer's stream consumer (in `Chat.tsx`, to be deep-dived in §7) switches on `type`.

**Important contract:** The stream is terminated by exactly one of `{ type: 'done' }` or `{ type: 'error' }`. If neither arrives (which is what happens during the silent-jetsam failure mode), the renderer's stream consumer hangs indefinitely. **This is the structural root of the lying-spinner symptom** — not in this file, but the contract here is what allows it.

### `ModelInfo` and `AVAILABLE_MODELS` (lines 80–123)

```ts
interface ModelInfo {
  /** HuggingFace repo ID — used internally for mlx_lm */    // ← STALE comment
  name: string
  label: string
  size: string         // human-readable
  sizeBytes: number    // for download progress %
  description: string
  recommended?: boolean
}
```

**STALE comment:** `name` is "used internally for mlx_lm" — should now read `mlx_vlm` after Patch 4. Captured in §Hardening Roadmap. (Trivial one-word fix, but the kind of drift that compounds.)

`AVAILABLE_MODELS` (Gemma 4 lineup):

| `name` (HF repo) | `label` | `size` | `sizeBytes` | `recommended` |
|---|---|---|---|---|
| `mlx-community/gemma-4-e2b-it-4bit` | Gemma 4 E2B | 1.5 GB | 1.5×10⁹ | — |
| `mlx-community/gemma-4-e4b-it-4bit` | Gemma 4 E4B | 3 GB | 3.0×10⁹ | ✓ |
| `mlx-community/gemma-4-26b-a4b-it-4bit` | Gemma 4 27B MoE | 16 GB | 16×10⁹ | — |
| `mlx-community/gemma-4-31b-it-4bit` | Gemma 4 31B | 18 GB | 18×10⁹ | — |

All four are **4-bit quantized**, served from `mlx-community/` on HuggingFace. All four are described as multimodal ("Text + image + audio" in the E2B/E4B descriptions), consistent with `mlx-vlm` as the serving layer (Patch 4).

`DEFAULT_MODEL = 'mlx-community/gemma-4-e4b-it-4bit'` — the recommended E4B. First-run downloads ~3 GB to the HF cache.

**Side-effect to verify in §3 mlx.ts deep dive:** `sizeBytes` is a *user-friendly approximation* (1.5×10⁹ ≠ actual on-disk size). The Setup screen uses it to compute the download `progress` fraction. If actual download bytes diverge from `sizeBytes` materially, progress can read >100% or stall <100% even on success. This may contribute to the lying-spinner perception even when nothing has actually crashed.

---

## §1 Synthesis — what this layer tells us about the rest

1. **Three Electron contexts, one type vocabulary.** The `@shared` alias + `src/shared/types.ts` is the spine. Everything downstream is just code that pushes those types across IPC boundaries.
2. **Build outputs are flat and predictable** (`out/main/index.js`, `out/preload/index.js`, `out/renderer/`). When a patch doesn't seem to take effect, the rebuild step is the prime suspect — there is no caching layer that could mask source changes.
3. **The app is Apple-Silicon-only and assumes a managed Python venv at runtime.** This narrows the failure surface considerably but creates a hard floor (no Intel Macs, no Linux experiments) and adds a runtime install dance (the venv provisioning in `mlx.ts`).
4. **Auto-update, tests, lint, notarization, and macOS code-signing are all either placeholder or absent.** The current operational model is "build → run from your own machine." Shipping to another user requires §Hardening Roadmap items first.
5. **Stale upstream attribution everywhere:** `author: Ammaar`, `description: ... Gemma 3`, `appId: com.ammaar.gemmachat`, `ModelInfo.name` comment referencing `mlx_lm`. None are functional bugs but they're drift markers — the kind of thing that, when there's enough of it, makes a codebase feel un-owned.

Section 1 complete. Section 2 (`src/main/index.ts`) is next.

---

## (Sections 2–7 and 9–10 will be filled in as the file-by-file deep dive continues.)
