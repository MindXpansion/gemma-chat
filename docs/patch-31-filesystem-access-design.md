# Patch 31 — Gemma Filesystem Access (Home + Multi-Mount Workspaces)

> **Status:** DESIGN — Bear answered Q1/Q2/Q4/Q5 (2026-05-19). Awaits final phasing sign-off.
> **Author:** Claude (Opus 4.7) for Bear, 2026-05-19
> **Builds on:** Patch 28/28.5 (native tool-result routing), Patch 20/21 (gemma-chat-memory KG + voyageai RAG), `src/main/workspace.ts` (`assertInWorkspace` path guard, sandboxed bash)
> **Goal in one sentence:** Give Gemma a persistent Home plus multiple simultaneously-mounted workspaces — each with selectable read/write posture and optional semantic indexing — so she can read, search, traverse, run commands in, and (when authorized) modify any set of codebases or document trees Bear points her at.
> **Prerequisite for:** Patch 32 (GSD-native methodology layer).

---

## 1. What we're building (TL;DR)

Filesystem surfaces available in **chat mode** (today's file tools are Build/code-mode only and per-conversation ephemeral):

1. **Gemma's Home** — `~/GemmaWorkspace/` (Bear's choice — visible in Finder, droppable). Always read-write. Persists across every conversation. Her `.md` notes, generated images, shared documents, working files.

2. **Multiple Mounted Workspaces** — Bear points her at *N* folders (codebases, projects, docs trees) via a picker. Each mount is independent: its own posture mode, its own optional index. Path-traversal locked to its root.

3. **Two traversal strategies, both available** (Bear: "Both"):
   - **Direct** — `fs_read` / `fs_list` / `fs_tree` / `fs_search` operate live on disk for active work.
   - **Indexed** — Bear (or Gemma) can *index a mount*: chunk + embed it into `gemma-chat-memory` (reusing Patch 21's pipeline). Then `gemma_recall` does semantic search across the *whole* codebase regardless of size. Direct tools handle the active working set; the index handles "total traversal."

**Posture modes** per mount (Bear: RW-confirm default):
- **Read-only** — read/search/list/traverse; zero writes; no `run_bash`.
- **Read-write, confirm-per-write** — edits + bash gated by a confirmation card. *Default the picker pre-selects.*
- **Read-write, free** — full agentic editing + bash, no prompts.

**Traversal depth:** unlimited by default; optional `max_depth` on listing/search tools.

**Context discipline:** fs results are budget-aware — capped so filesystem content never exceeds ~80% of the model's context window (Bear's directive). Beyond the cap, tools paginate/truncate with a notice and point Gemma at `fs_search` or the index instead of blindly filling context.

## 2. Current state

| Capability | Scope | Mode |
|---|---|---|
| `write_file`/`read_file`/`edit_file`/`list_files`/`delete_file`/`run_bash` | Per-conversation sandbox `{userData}/workspaces/{conversationId}/` | Build/code only |
| `ipp_read`/`ipp_append`/`ipp_edit` | 5 IPP `.md` files in `~/.intelligence_partner/` | chat |
| `gemma_ingest` | Any absolute path → ingest into KG (read-only, one-directional) | chat |

Reusable foundation in `workspace.ts`: `assertInWorkspace` (path-escape guard), `listTree` (recursive walk, skips dotfiles/`node_modules`), `wsReadFile/wsWriteFile/wsEditFile` (atomic tmp+rename), `wsRunBash` (deny-regex + timeout + output cap). Patch 21 `aios-rag.ts`: `ingestPath`, `recall`, `chunkMarkdown` — reused for mount indexing.

## 3. Architecture

### 3.1 Mount registry

New module `src/main/gemma-fs.ts`:

```ts
type MountMode = 'ro' | 'rw-confirm' | 'rw-free'

interface Mount {
  id: string            // stable slug, e.g. 'gemma-chat' or 'client-portal'
  name: string          // display name (basename, dedup-suffixed)
  path: string          // absolute root
  mode: MountMode
  indexed: boolean       // has it been chunked+embedded into gemma-chat-memory?
  indexedAt?: number
}

interface FsState {
  mounts: Mount[]        // multiple, simultaneous
}
```

`home` is implicit — always present, always `rw-free`, root `~/GemmaWorkspace/`. State persists to `{userData}/gemma-fs-state.json`, restored on boot.

### 3.2 Root resolution

Every fs tool takes a `root` argument: the literal string `home`, or a mount `id`. The resolver:
1. `root === 'home'` → `~/GemmaWorkspace/`
2. else → look up `mounts[id].path`; unknown id → clear error listing valid roots
3. `assertInWorkspace(base, relPath)` — rejects `..`, absolute paths
4. realpath the result, re-check containment (symlink-escape guard)

### 3.3 Write + bash gating

| Mode | `fs_write`/`fs_edit`/`fs_delete` | `fs_bash` |
|---|---|---|
| `ro` | Rejected: "read-only mount, re-mount RW to edit" | Rejected entirely |
| `rw-confirm` | Confirmation card (path + diff preview) before write lands | Confirmation card (command preview) before run |
| `rw-free` | Executes immediately | Executes immediately |

`home` is always `rw-free`. The existing `BASH_DENY` regex (`rm -rf /`, `sudo`, fork-bomb, `mkfs`, `dd`, `shutdown`…) applies on **every** bash call regardless of mode. `.git/` directory writes refused even in `rw-free` (corruption risk — git changes go through `fs_bash`).

Confirm flow: new `emit({type:'tool_confirm', payload})` event; renderer shows the card; main process awaits the approve/deny reply before completing the tool.

### 3.4 Tool surface (chat + code mode, all `root`-aware)

| Tool | Args | Notes |
|---|---|---|
| `fs_tree` | `root`, `max_depth?` | Structure overview. Skips `.git`, `node_modules`, dotfiles. Budget-capped. |
| `fs_list` | `root`, `path`, `max_depth?` | One directory (or subtree). |
| `fs_read` | `root`, `path` | Read a file. 256 KB cap → truncate + notice. Binary detection → notice, not garbage. |
| `fs_search` | `root`, `query`, `path?`, `max_depth?` | Content grep. Returns `file:line` + context. Budget-capped, paginated. |
| `fs_write` | `root`, `path`, `content` | Create/overwrite. Mode-gated. |
| `fs_edit` | `root`, `path`, `old_string`, `new_string`, `replace_all?` | Surgical edit. Mode-gated. |
| `fs_delete` | `root`, `path` | Mode-gated. `.git/` always refused. |
| `fs_bash` | `root`, `command` | Run in the mount's directory. Mode-gated. `BASH_DENY` always on. 60s timeout, 16KB output cap. |
| `fs_index` | `root` | Chunk+embed the mount into `gemma-chat-memory`, tagged by mount id. Reuses Patch 21 `ingestPath`. Enables semantic recall across the whole codebase. |
| `fs_mounts` | — | List active mounts (id, name, path, mode, indexed). Gemma's self-orientation. |

Indexed mounts: `gemma_recall` gains an optional `mount` filter so semantic search can scope to one codebase.

### 3.5 Context budget

A lightweight accumulator tracks bytes of fs content emitted into the current turn's context. Soft ceiling = 80% of the active model's context window (E4B 32K; 27B-MoE per its config). Approaching the ceiling: `fs_tree`/`fs_search`/`fs_read` truncate with an explicit notice — *"Output capped at context budget. Use fs_search to narrow, or fs_index for semantic recall across the full tree."* This makes "total codebase traversal" safe: the index is the unbounded store, context is the bounded working set.

### 3.6 UI

- **Workspace bar** — `🏠 Home` always; one chip per mount: `📁 <name> · [mode badge] · [indexed dot]`. Click a chip → mode change / unmount / index.
- **Mount picker** — button → `dialog.showOpenDialog({properties:['openDirectory']})` → 3-way mode selector (pre-selects **RW-confirm**) → mount activates.
- **Confirm card** — for `rw-confirm` writes and bash: path/command, diff or command preview, Approve / Deny.

### 3.7 System prompt

~35 lines in `chatSystemPrompt`/code prompt: the Home + multi-mount model, the `root` argument convention, a **live-injected list of current mounts** (id, mode, indexed), the direct-vs-indexed traversal guidance, and the discipline note (surgical edits, respect mode, prefer `fs_search`/index over dumping large trees into context).

## 4. Phasing (layered, each independently verifiable)

| Layer | Scope | Effort |
|---|---|---|
| **L1 — Home + resolver** | `gemma-fs.ts`, `~/GemmaWorkspace/`, multi-mount registry + persistence, generalized `ws*File` helpers, `fs_read`/`fs_write`/`fs_list`/`fs_tree`/`fs_mounts` on `home` | ~3.5 hrs |
| **L2 — Mounts (read-only)** | Folder picker UI, workspace bar, mount state, read tools across all mounts, `fs_search`, context budget | ~3.5 hrs |
| **L3 — Write + bash gating** | `rw-confirm`/`rw-free`, confirm-card IPC + UI, `fs_write`/`fs_edit`/`fs_delete`/`fs_bash` on mounts | ~4 hrs |
| **L4 — Indexing** | `fs_index` → `gemma-chat-memory` (Patch 21 pipeline, mount-tagged), `gemma_recall` mount filter, "index" UI action | ~3 hrs |
| **L5 — Polish** | `fs_search` ranking, binary/size handling, live mount injection in prompt, `max_depth` everywhere, prompt-budget audit | ~2 hrs |

**Total ~16 hrs.** L1 ships a persistent Home immediately. L2 makes codebases readable. L3 unlocks agentic editing + bash. L4 unlocks whole-codebase semantic recall. Karpathy-sequenced: verify each layer before the next.

## 5. Security model

- **Path-escape:** `assertInWorkspace` + post-realpath containment re-check (symlink guard) on every op, every root.
- **Roots only:** nothing outside Home and the active mounts is reachable.
- **Posture explicit per mount:** Bear picks RO / RW-confirm / RW-free at mount time; default RW-confirm.
- **`BASH_DENY` always on:** every `fs_bash` call screened regardless of mode.
- **`.git/` writes refused** even in `rw-free` (git ops go through `fs_bash`).
- **Sensitive-dir warning** at mount time if the root is/contains `~/.ssh`, `~/.intelligence_partner`, `~/.aws`, `~/Skills` (sacrosanct), or another sensitive tree — warn, don't hard-block.
- **Home is hers:** always `rw-free`, no gating.

## 6. Open questions — RESOLVED

| # | Question | Answer |
|---|---|---|
| Q1 | Home location | **`~/GemmaWorkspace/`** (Bear) |
| Q2 | One mount or multiple | **Multi-mount** (Bear) |
| Q3 | `fs_read` size cap | 256 KB, truncate + notice |
| Q4 | Default mount mode | **RW-confirm** (Bear) |
| Q5 | `run_bash` on external mounts | **Include now**, as `fs_bash`, mode-gated (Bear) |
| Q6 | fs tools auto-ingest into KG | No auto-coupling — explicit `fs_index` action instead |
| Q7 | Persist mounts across restarts | Yes — `gemma-fs-state.json`, shown in workspace bar |
| Q8 | Keep Build per-conversation sandbox | Yes — separate purpose, no conflict |

## 7. What this unlocks

- Gemma reads/searches/traverses/runs-commands-in any set of codebases Bear mounts.
- RW modes: agentic editing + bash on real projects, posture chosen per mount.
- `fs_index` + `gemma_recall`: semantic search across codebases far larger than any context window.
- Persistent Home: her notes, artifacts, shared docs survive between conversations.
- **Patch 32 (GSD-native):** `.planning/` lives in a mounted workspace; the phase methodology operates on the mounted codebase, with `fs_index` feeding whole-repo comprehension.

## 8. Files touched

- **NEW** `src/main/gemma-fs.ts` — mount registry, root resolver, state persistence, context budget (~220 lines)
- **EDIT** `src/main/workspace.ts` — generalize `ws*File` from `conversationId` to `(absRoot, relPath)` (~70 lines)
- **EDIT** `src/main/tools.ts` — 10 new `fs_*` ToolSpecs + handlers (~340 lines)
- **EDIT** `src/main/aios-rag.ts` — mount-tagged ingestion, `recall` mount filter (~40 lines)
- **EDIT** `src/main/index.ts` — `tool_confirm` IPC for `rw-confirm` (~50 lines)
- **NEW** `src/renderer/src/components/WorkspaceBar.tsx` — mount chips, picker, mode selector, index action (~200 lines)
- **EDIT** renderer — confirm-card UI + IPC (~90 lines)
- **EDIT** `src/main/tools.ts` system prompts — Home+multi-mount model, live mount injection (~35 lines)

---

*Patch 31 design — all open questions resolved. On phasing sign-off, L1 ships first (~3.5 hrs) and gives Gemma a persistent Home + the multi-mount registry immediately.*
