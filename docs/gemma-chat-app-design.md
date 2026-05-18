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

## (Sections 1–7 and 9–10 will be filled in via the file-by-file deep dive.)
