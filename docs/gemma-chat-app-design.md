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

## (Sections 3–7 and 9–10 will be filled in as the file-by-file deep dive continues.)
