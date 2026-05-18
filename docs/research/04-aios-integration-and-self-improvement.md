# 04 — AIOS Integration and Self-Improvement Workspace

> **Research document — integration design, not implementation.**
> Purpose: identify the seams where Gemma Chat plugs INTO Bear's existing MindXpansion AIOS rather than reinventing parallel infrastructure.
> Owner: Bear (Daryl Lantz) · MindXpansion.ai
> Author: Claude (Opus 4.7, 1M context) · 2026-05-17
> Status: DRAFT — Part 1 grounded in fully-loaded source (RISE, persistence-discipline, filesystem-truth, Gemma Chat design doc). Part 1's Skill v3.1 manifest section is inferred from the runtime skill registry visible in this session; sections marked **[VERIFY]** should be cross-checked against `/Users/bear/Skills/_readme_first_/MindXpansion_Skill_Development_Standard_v3.1.md` and `MindXpansion-CLAUDE-Standards.md` before any code is written. Two `Read` calls into `/Users/bear/Skills/_readme_first_/` were denied during research; the standards documents themselves were not directly read for this draft.

---

## TL;DR

Gemma Chat already has the right shape to become a first-class AIOS citizen — it has per-conversation workspaces, a tools layer, an MLX runtime, and an Electron host with full filesystem access. What it lacks is **vocabulary**. Every primitive it needs (memory, patterns, skills, handoffs, trust state, persistence triggers) already exists in Bear's AIOS, governed by published standards, and lives in well-known directories.

The integration thesis of this document is:

> **Gemma Chat should not invent a self-improvement system. It should adopt RISE's four pillars as its operational loop, store its patterns in the same `successful-patterns.md` / `anti-patterns.md` convention the Skills library already uses, write session handoffs into Bear's `claude-tracks/Knowledge_Base/`, and read Skills directly from `/Users/bear/Skills/` (read-only) so a single skill works for both Claude Code and Gemma Chat.**

The single-largest unlock is making the per-conversation workspace dual-purpose:
1. A scratchpad for the model and the user (already exists today).
2. A capture surface that, at conversation close, distills into AIOS-shaped artifacts (handoff, pattern updates, Hindsight writes) that Bear's existing infrastructure already knows how to ingest.

---

## Part 1 — The AIOS, summarized for Gemma Chat

### 1.1 The cognitive layer: RISE Framework v1.0

Source of truth: `/Users/bear/Skills/rise-framework/rise-framework.md` (auto-loaded into every Claude Code session via `@import` in `/Users/bear/.claude/CLAUDE.md`).

RISE is a four-pillar cognitive enhancement layer that sits **beneath** any agent's domain logic and **above** the grounding layer (temporal-intelligence). It is model-agnostic and explicitly designed to be implemented in any LLM agent — including, by Bear's own framing in the framework doc, "any LLM agent" beyond the LangGraph/Claude Code reference implementations.

The four pillars and their operational primitives:

| Pillar | Purpose | Operational primitives Gemma Chat must implement |
|---|---|---|
| **[R] Reasoning** | Prevent confident hallucination | Temporal grounding *first*; structured thought chain (Observation → Orientation → Hypothesis → Evaluation → Selection → Confidence); multi-hypothesis generation; counterfactual testing |
| **[I] Insights** | Transform observations into actionable intelligence | Pattern recognition (≥3 data points before naming a pattern); anomaly detection; cross-domain synthesis; explicit insight capture (name → evidence → context → route) |
| **[S] Self-Improvement** | Close the feedback loop | Outcome evaluation (goal → result → delta → root cause → lesson); feedback integration (corrections / confirmations / silence); pattern accumulation in **append-only** `successful-patterns.md` and `anti-patterns.md`; cross-system learning propagation; confidence calibration |
| **[E] Execution** | Deliver with precision and resilience | Task decomposition; resource-aware processing (delegate before 50% context); parallel execution; error classification (transient / structural / external); graceful degradation; verification before completion |

**Critical RISE behaviors Gemma Chat should mirror immediately:**

- **Temporal grounding before reasoning.** The framework explicitly identifies this as the single highest-impact change ever made in Bear's ecosystem: it "effectively dropped temporal hallucination to zero." Gemma Chat already exposes system time to the renderer; it must inject `now()` into every system prompt and every conversation summary.
- **The 3-data-point rule for patterns.** The Insights pillar prohibits calling something a "pattern" before three observations. This rule must be enforced in any self-improvement file Gemma Chat writes — otherwise the patterns file becomes noise.
- **Append-only pattern files.** Both `successful-patterns.md` and `anti-patterns.md` are explicitly append-only. Gemma Chat must never overwrite or "consolidate" them autonomously.
- **Compress for trivial, expand for complex.** RISE has explicit guidance that not every task needs full ceremony. Gemma Chat should not run the full R→I→S→E cycle for "rename this variable" — that itself is an anti-pattern in the framework.

The "feedback loop back to R" arrow in the pillar interaction diagram is what makes RISE a *learning* system rather than a *templating* system. Gemma Chat must persist between sessions for that loop to close.

### 1.2 The relationship layer: IPP v3 (Intelligence Partnership Protocol)

IPP v3 is not directly readable here without `/Users/bear/Skills/intelligence-partner-v3/` access **[VERIFY]**, but it is referenced throughout the loaded global instructions and the skill registry exposes its commands: `ipp:status`, `ipp:heartbeat`, `ipp:checkpoint`.

What we can infer from the references:

- **Trust phases** — Calibration → (intermediate) → Deep Partnership. RISE explicitly states "Reasoning quality adapts to trust phase — deeper chains in Calibration, streamlined in Deep Partnership." This means an agent's verbosity and ceremony are a *function of relationship maturity*, not a constant.
- **Heartbeat memory writes every 3–9 minutes.** Both the RISE doc ("Memory updates every 3-9 minutes — insights feed directly into Hindsight retention") and persistence-discipline confirm this cadence.
- **Checkpoint protocol on interruption.** Cited in RISE's Execution pillar integration hooks.
- **Partnership state file** stored at `/Users/bear/.intelligence_partner/` per filesystem-truth.
- **Trust events** are explicit (build / break / repair) and recorded via `partnership_state.py trust <event>` per persistence-discipline.

For Gemma Chat: IPP is a **Bear-and-Claude** protocol. Gemma Chat is not a partnership peer with Bear in the IPP sense — it is a tool Bear uses. **Gemma Chat should NOT write trust events.** It should respect IPP's cadence guidance (heartbeat writes), but trust state is out of scope.

### 1.3 The client layer: COI (Client-Operations-Intelligence)

Same caveat — not directly readable, referenced via global instructions and persistence-discipline. What matters for Gemma Chat:

- COI owns the `/Volumes/T9-1/claude-tracks/Trackers/<CLIENT>/` directory structure for per-client tracker files.
- COI is referenced in RISE's Execution pillar: "Client operations follow execution engine patterns for delivery reliability."

For Gemma Chat: **COI is out of scope**. Gemma Chat is a general-purpose local-model app, not a client-operations tool. If Bear later uses a Gemma Chat conversation to draft a client deliverable, the *handoff artifact* may land in a COI tracker — but Gemma Chat itself doesn't need to model COI.

### 1.4 The Skill library — what a Skill *is* in this ecosystem

**[VERIFY against v3.1 standard.]** The Skill v3.1 standard is at `/Users/bear/Skills/_readme_first_/MindXpansion_Skill_Development_Standard_v3.1.md` and was not directly read. What follows is the working model derived from:

- The skill registry exposed in this session (200+ skills across plugins like `gsd-*`, `vercel:*`, `superpowers:*`, plus Bear's first-party skills `bear-voice`, `bear-writer`, `intelligence-partner`, `company-lookup`, `orient`, etc.)
- References in the RISE doc to skill structure (`patterns/`, `successful-patterns.md`, `anti-patterns.md`, `program.md`, `train.py`)
- References in persistence-discipline to `patterns/SUMMARY.md`

**Working model of a v3.1 Skill:**

```
/Users/bear/Skills/<skill-name>/
├── SKILL.md                      # The skill manifest + operational protocol (THE one file Claude reads)
├── program.md                    # Scenario catalog used by train.py autoresearch
├── train.py                      # Autoresearch loop — execute scenarios → evaluate → update patterns
├── patterns/
│   ├── SUMMARY.md                # Append-only digest of upgrade summaries, test counts, surfaced anti-patterns
│   ├── successful-patterns.md    # Append-only catalog of approaches that work, with evidence
│   └── anti-patterns.md          # Append-only catalog of approaches that fail, with WHY
└── references/                   # Domain-specific reference docs the skill cites
```

The **SKILL.md** is the contract. Inferred minimum structure based on observed behavior:

```yaml
---
name: <kebab-case-id>
description: <triggering sentence(s) — when this skill should activate>
# possibly: model, tools, scope, version
---

# <Skill name>
## Purpose
## Activation triggers
## Operational protocol
## Integration hooks
## RISE Integration  (per the recommended template in rise-framework.md)
```

The RISE doc itself provides the recommended **RISE Integration** section template for skill manifests:

```markdown
## RISE Integration
This skill follows the RISE Framework (see /Users/bear/Skills/rise-framework/rise-framework.md).
- Reasoning: [...]
- Insights: [...]
- Self-Improvement: [...]
- Execution: [...]
```

**Skills directly relevant to Gemma Chat** (from the skill registry):

| Skill | Relevance |
|---|---|
| `orient` | "Quick orientation to current project." Gemma Chat could expose an `/orient` equivalent that maps the active workspace. |
| `session-start` / `session:resume` / `session:handoff` | Direct templates for Gemma Chat session bootstrap and handoff generation. |
| `verify-env` | Pattern for verifying the local environment is functional — Gemma Chat already does this for MLX/Python/HF; could surface as a structured skill. |
| `intelligence-partner` | The collaborative-work skill. Activates on starting tasks, code, research, or resuming. Gemma Chat would *not* invoke this directly (it's Bear's partnership skill with Claude), but its structure is the template for what a "Gemma partnership protocol" would look like if one is later needed. |
| `bear-voice` / `bear-writer` | Communication-style skills. If Gemma Chat is ever used to draft Bear's communications, these become directly applicable — but require model capability Gemma may not have. **Likely out of scope.** |
| `skill-creator` / `skill:new` | Patterns for scaffolding skills. If Gemma Chat ever needs to *write* a skill, this is the reference. |
| `hookify:*` | Hook system patterns. Not directly applicable to Electron, but the *idea* of "rules that fire on triggers" is reusable in Gemma Chat's IPC layer. |
| `gsd-*` (large family) | A full project-management workflow. **Out of scope for the local chat surface** — these are for managed software projects. |

Notable: there is **no existing skill for MLX, local-model hosting, Electron apps, or Gemma specifically.** This is a gap Gemma Chat itself could fill (see Part 3.3).

### 1.5 Persistence conventions

From `/Users/bear/.claude/rules/persistence-discipline.md` (fully loaded):

The **persistence triggers** Gemma Chat should respect:

| Trigger | Destination | Capture |
|---|---|---|
| Report or document generated | Hindsight `shared-knowledge` | 2–3 sentence summary + artifact path + key decisions |
| Major decision made | Neo4j KG | `Decision` node: what / why / alternatives / reversal conditions |
| Phase / wave completed | Hindsight `claude-code` + claude-tracks | Phase name, scope closed, test status, what opens next |
| Skill built / upgraded / debugged | Hindsight `claude-code` + skill's `patterns/SUMMARY.md` | Upgrade summary, test count, anti-patterns surfaced |
| Session close | `SESSION_HANDOFF_<topic>_<YYYYMMDD>.md` → `Knowledge_Base/` | What got done, what's next, paths, critical context |

**The 30-Minute Rule:** during active work, if ≥30 min have elapsed since last persistence save, save now. The nudge lives in this rules file; the timer lives in IPP heartbeat infrastructure (`partnership_state.py`). Gemma Chat does not need to implement the timer — but it should respect the rule by writing snapshot files on a similar cadence during long conversations.

**Anti-patterns called out explicitly:**

1. **Batching to session close** — "A crash at minute 89 loses 89 minutes."
2. **"I'll remember without writing it down."** — You won't.
3. **Waiting for user to request handoff** — between handoffs the discipline is the agent's, not Bear's.
4. **Overwriting instead of appending** — memory stores are **append-only by intent**.

This last point is the single most important constraint on Gemma Chat's self-improvement workspace design: **the workspace .md files must be append-only with timestamped sections, not living documents that get rewritten.**

### 1.6 Filesystem truth — where Gemma Chat is allowed to write

From `/Users/bear/.claude/rules/mindxpansion-filesystem-truth.md` (fully loaded):

Three claude-tracks locations exist:

1. **Local working copy** — `/Users/bear/claude-tracks/` — active reads + writes during a session. **This is where Gemma Chat session handoffs should land.** Specifically:
   - Session handoffs → `/Users/bear/claude-tracks/Knowledge_Base/SESSION_HANDOFF_*.md`
   - (Currently no Gemma-Chat-specific subdirectory exists; Part 3 recommends creating one.)
2. **T9-1 (SMB sync target)** — `/Volumes/T9-1/claude-tracks/` — **DO NOT write here from Gemma Chat.** It has a documented sandboxed-process limitation (`Operation not permitted` from background processes). A launchd `sync` agent every 15 min handles propagation from the local copy.
3. **T9 (legacy local)** — read-only legacy reference. Out of scope.

**Other relevant fixed paths Gemma Chat should know about:**

- Skills root: `/Users/bear/Skills/` — **read-only for Gemma Chat.**
- RISE source of truth: `/Users/bear/Skills/rise-framework/rise-framework.md`
- Standards: `/Users/bear/Skills/_readme_first_/` — read-only reference.
- Agent memory: `/Users/bear/.claude/agent-memory/` — **owned by Claude Code subagents; Gemma Chat should NOT write here.**
- Intelligence Partner state: `/Users/bear/.intelligence_partner/` — **owned by IPP; Gemma Chat should NOT write here.**
- Neo4j partnership KG: `bolt://localhost:7687` (kg-arch-enterprise) — write access is a deliberate decision (see §2.3).

### 1.7 Gemma Chat as it exists today

For reference, the integration surface in the current codebase (per `docs/gemma-chat-app-design.md` and a direct read of `src/main/workspace.ts`):

- **Per-conversation workspace** at `app.getPath('userData')/workspaces/c_<timestamp>_<rand>/` — already exists. Sanitized IDs. Path-escape guard (`assertInWorkspace`). HTTP server for serving workspace files to the renderer.
- **Tools layer** at `src/main/tools.ts` (593 lines) — already implements function calling. **This is the natural place to bolt on AIOS-aware tools** (e.g., `aios.recall`, `aios.write_pattern`, `aios.handoff`).
- **MLX runtime lifecycle** at `src/main/mlx.ts` — manages the `mlx_lm.server` subprocess. Independent of AIOS concerns.
- **IPC contract** main↔preload↔renderer — every AIOS surface needs an IPC channel; this is where the integration ergonomics live.

---

## Part 2 — Mapping AIOS primitives onto Gemma Chat features

### 2.1 The "self-improvement workspace where the model saves .md files"

Bear's described feature — a workspace where the model writes `.md` files to "improve itself and communicate other improvements, learning, optimizations" — maps almost exactly onto two existing AIOS conventions:

**(a) RISE's append-only pattern files** — `successful-patterns.md` and `anti-patterns.md`
**(b) The Skills library's `patterns/SUMMARY.md`** — the upgrade-summary digest

The mapping is direct but requires three design decisions:

#### 2.1.1 Where do the files live?

There are three plausible locations, and the answer is "all three, for different purposes":

| Location | Scope | Owner | Lifecycle |
|---|---|---|---|
| **Per-conversation workspace** `userData/workspaces/c_<id>/.aios/` | One conversation | Gemma model writes during chat | Created with workspace, archived with workspace |
| **App-level "Gemma Chat skill"** `userData/aios/skills/gemma-chat-runtime/patterns/` | All Gemma Chat conversations | Gemma model writes at conversation close (distillation step) | Append-only, persists across conversations, survives app reinstalls if backed up |
| **Bear's master Skills library** `/Users/bear/Skills/gemma-chat-runtime/patterns/` | Cross-tool (Claude Code + Gemma Chat) | Bear (manually) or via an explicit "promote to skills lib" action | Append-only; only promoted after Bear reviews the app-level patterns |

**Critical:** Gemma Chat should *never* autonomously write to `/Users/bear/Skills/`. That directory is the master library and its integrity matters. The promotion path is **per-conversation → app-level → (explicit Bear review) → master library**.

#### 2.1.2 What format do they use?

The format should match the existing AIOS convention so a pattern surfaced in Gemma Chat is legible to Claude Code and vice versa. Inferred convention (each entry):

```markdown
## YYYY-MM-DD HH:MM — <short pattern name>

**Context:** <one-line situation>
**Pattern:** <the actual reusable approach>
**Evidence:** <≥3 observations supporting this — required per RISE's 3-data-point rule>
**Why it works (or fails):** <causal story, not just "it worked">
**Applicable beyond:** <what other contexts this applies to, if any>
**Source:** conversation c_<id> (<workspace path>) | line ranges or excerpt
```

For `anti-patterns.md`, swap "Why it works" for "Why it fails" and add a **Counter-pattern** field — "what to do instead" — because anti-patterns without remediations are noise.

Both files should have a stable header that establishes their append-only nature:

```markdown
# <Skill / Workspace> — Successful Patterns

> Append-only. Do not edit existing entries. Newest at bottom. Each entry must have ≥3 supporting observations before being recorded (RISE Insights pillar, 3-data-point rule).
```

#### 2.1.3 When does the model write to them?

Three trigger types, matching the RISE pillar that fires them:

1. **In-conversation insight (per-workspace file)** — when the model notices something worth capturing mid-conversation. Goes to `<workspace>/.aios/observations.md`. Not yet a pattern (it's just one observation). Append timestamped entry.
2. **Conversation-close distillation (app-level file)** — at conversation close (or on a 30-min heartbeat per persistence-discipline), run a distillation pass: scan the conversation transcript + observations.md, decide if anything has crossed the 3-data-point threshold, and if so append to the app-level `patterns/successful-patterns.md` (or `anti-patterns.md`).
3. **Explicit promotion (master library)** — user-driven only. Surfaces as a UI action: "Promote this pattern to my Skills library." Writes to `/Users/bear/Skills/gemma-chat-runtime/` with Bear's review.

This three-tier promotion pattern mirrors how Bear's autoresearch loop works in `train.py` (scenarios → evaluation → patterns), but adapted for the conversational interface.

### 2.2 The Skills loading mechanism inside Gemma Chat

Bear's master Skills library at `/Users/bear/Skills/` contains 200+ skills already, with rich conventions. The integration question is: **does Gemma Chat have its own skill registry, or does it consume the existing one?**

**Recommendation: consume the existing one, read-only, with filtering.**

Reasoning:

1. **Single source of truth.** If a skill exists in `/Users/bear/Skills/`, it has been written once, with one SKILL.md, governed by the v3.1 standard. Forking the registry into a Gemma-Chat-specific lib creates drift the moment Bear updates a skill.
2. **Filtering is mandatory.** Most skills are not Gemma-applicable. The skill registry visible in this session includes 50+ `gsd-*` skills, `vercel:*` skills, `mcp__*` integrations — Gemma cannot meaningfully use these. Filtering by metadata is cheaper than re-curation.
3. **A small set of skills is the bridge.** Realistically, Gemma Chat should expose 5–15 skills max in its UI: `orient`, `session-start`, `verify-env`, `nano-banana` (maybe), and a handful of Gemma-Chat-native skills not yet in the library.

**How filtering works (proposed):**

Each SKILL.md frontmatter gains an optional field **[VERIFY this is acceptable to the v3.1 standard — may need a Standard amendment]**:

```yaml
---
name: orient
description: Quick orientation to the current project or directory.
runtime: [claude-code, gemma-chat]   # NEW — runtimes this skill is compatible with
model_min: gemma-3-4b                # NEW — minimum model class required, optional
---
```

Default if absent: `runtime: [claude-code]` (preserves current behavior for the existing 200+ skills).

Gemma Chat at startup scans `/Users/bear/Skills/*/SKILL.md`, parses frontmatter, and includes only skills where `gemma-chat` ∈ `runtime` and the active model satisfies `model_min`.

**Alternative if amending the standard is undesirable:** Gemma Chat maintains a tiny allowlist file at `userData/aios/skill-allowlist.json` that names the skills it exposes. Lower coupling, slightly less elegant.

### 2.3 Memory and persistence boundaries

The boundary question is fundamental: **what is Gemma Chat allowed to write to Bear's persistent infrastructure?**

The principle should be: **Gemma Chat writes to surfaces Bear-the-user can explicitly review and revert. It does not write to surfaces that are part of Claude's partnership with Bear.**

| Surface | Gemma Chat permission | Rationale |
|---|---|---|
| `userData/workspaces/c_<id>/` (workspace) | **Read + write** | This is Gemma Chat's own surface. |
| `userData/aios/` (proposed new directory) | **Read + write** | App-level AIOS surface — patterns digest, skill allowlist, distillations. |
| `/Users/bear/claude-tracks/Knowledge_Base/SESSION_HANDOFF_*.md` | **Write (file create only)** | Handoffs are the explicit bridge artifact. Per persistence-discipline, every session should produce one. Gemma Chat should write `SESSION_HANDOFF_gemma_<topic>_<YYYYMMDD>.md` with the `gemma_` prefix so the artifact is auditable. |
| `/Users/bear/claude-tracks/Trackers/<CLIENT>/` | **No autonomous write.** | COI surface. If a Gemma Chat conversation produces tracker-worthy content, it goes into the workspace + handoff, and Bear (or Claude Code) promotes it. |
| Hindsight `shared-knowledge` bank | **Write (via explicit MCP tool exposure)** | If Gemma Chat is configured with Hindsight MCP access, it can write — but the trigger should be an explicit user/model "retain this" action, not autonomous. |
| Hindsight `claude-code` bank | **No.** | That bank is for Claude Code's own learnings. Gemma writes go in a separate bank: `gemma-chat` (new) or `shared-knowledge` (existing). |
| Neo4j KG (`bolt://localhost:7687`) | **No autonomous write.** | The partnership KG is Claude+Bear's epistemic spine. Gemma can *read* (if exposed via MCP) but should not write `Decision` nodes. If a Gemma conversation produces a decision worth a `Decision` node, the handoff carries it and Claude Code creates the node. |
| `/Users/bear/.claude/agent-memory/` | **No.** | Subagent-owned. |
| `/Users/bear/.intelligence_partner/` | **No.** | IPP-owned. |
| `/Users/bear/Skills/<skill>/patterns/*.md` | **No autonomous write.** | Master library integrity. Only Bear-initiated promotion writes here. |

The shape of this table is: **Gemma Chat owns its own surfaces fully; touches the bridge artifacts (handoffs, optionally Hindsight shared-knowledge) under controlled conditions; reads but does not write to Claude's surfaces.**

### 2.4 Session handoffs from Gemma Chat

Per persistence-discipline, every session should produce a `SESSION_HANDOFF_<topic>_<YYYYMMDD>.md`. Gemma Chat conversations are sessions, and they should produce these too — with conventions:

**Filename:** `SESSION_HANDOFF_gemma_<topic-slug>_<YYYYMMDD>.md`
- The `gemma_` prefix makes the source auditable at a glance.
- `<topic-slug>` derived from the conversation's title (already exists in Gemma Chat) or a model-generated 2–4-word summary.
- `<YYYYMMDD>` from temporal grounding.

**Location:** `/Users/bear/claude-tracks/Knowledge_Base/` (local working copy, NOT T9-1).

**Content template** (mirrors what persistence-discipline asks for):

```markdown
# SESSION_HANDOFF — Gemma Chat — <topic> — <YYYY-MM-DD>

**Source:** Gemma Chat (model: <model-id>, workspace: <c_id>)
**Started:** <ISO timestamp>
**Closed:** <ISO timestamp>
**Operator:** Bear

## What got done
- <bullets — concrete artifacts produced, decisions made>

## What's open
- <bullets — what didn't close, what's next>

## Paths touched
- <workspace path>
- <any external paths referenced>

## Critical context for next session
- <model-written narrative summary, 3–8 sentences>

## Patterns surfaced (if any crossed 3-data-point threshold)
- <link to app-level patterns file entries written this session>

## Handoff target
- [ ] Reviewed by Bear
- [ ] Promoted to Skills lib (if applicable)
- [ ] Closed
```

**Trigger:** conversation close (user closes the conversation, archives it, or app shutdown). Also on the 30-minute heartbeat for long conversations, written as `SESSION_HANDOFF_gemma_<topic>_<YYYYMMDD>_partial.md` and overwritten by the final version at close.

The handoff is the **single most important integration artifact**. It is the canonical bridge between Gemma Chat sessions and the rest of the AIOS. Everything else (patterns, KG nodes, skill upgrades) can be derived from the handoff after the fact. Without it, work in Gemma Chat is invisible to the rest of the system.

### 2.5 Temporal grounding and the start-of-session hook

RISE puts temporal grounding above everything: "An agent that knows *when* it is can reason about *what* is." Gemma Chat must do this on every conversation start.

Mechanism:

1. On conversation create, the main process resolves `new Date()` and the system timezone.
2. The first system message injected into the model context includes:
   ```
   Current date: 2026-05-17 (Saturday)
   Current time: 14:32 MT (UTC-6)
   Workspace: c_<id> at <path>
   Operator: Bear (Daryl Lantz)
   Runtime: Gemma Chat (Electron, MLX, model: <model-id>)
   ```
3. On every system-level event (model swap, workspace reset), re-inject a temporal-grounding update.

This is cheap (one extra system message) and aligns the Gemma model with the same grounding discipline every Claude Code session runs.

### 2.6 The reasoning loop inside a Gemma response

For non-trivial requests, Gemma Chat should run a *light* R→I→S→E cycle. RISE explicitly warns against over-applying ceremony — "you don't need full multi-hypothesis reasoning to rename a variable." But for any conversation involving a decision, code change, or research task:

- **[R]** Before composing the reply, the model is prompted to consider 2–3 approaches and pick one with stated confidence.
- **[I]** After the reply (or as part of it), the model is prompted to flag anything unexpected or worth capturing.
- **[S]** At conversation close, the distillation pass evaluates outcomes.
- **[E]** During the reply, the model uses the tools layer to actually execute (file writes, code runs, etc.) and is prompted to verify before claiming completion.

This is implemented via **prompt scaffolding**, not architecture changes — the existing `tools.ts` and IPC layer already support it. The scaffolding is conditional: trivial requests skip it (`/quick` mode), substantive ones get the full cycle.

---

## Part 3 — Concrete recommendations

### 3.1 Should Gemma Chat read Skills from `/Users/bear/Skills/` directly?

**Yes — read-only, with filtering.**

- **Read** from `/Users/bear/Skills/*/SKILL.md` at startup; parse frontmatter; filter by `runtime: gemma-chat` (proposed standard amendment) OR by a local allowlist file (no amendment needed).
- **Never write** to `/Users/bear/Skills/` from the running app. Promotion to the master library is a Bear-mediated action only.
- **Cache** the filtered registry in `userData/aios/skill-registry.cache.json` for cold-start speed. Invalidate on `/Users/bear/Skills/` mtime change.

A separate, app-internal Skills library at `userData/aios/skills/` exists for **Gemma-Chat-native skills** that haven't (or shouldn't) be promoted to the master library. These follow the same v3.1 structure so promotion is a `cp -r` operation when the time comes.

### 3.2 What's the right surface for the self-improvement .md workspace?

**Both** a per-conversation surface and a shared one, with a promotion path:

```
userData/
├── workspaces/c_<id>/                    # existing
│   └── .aios/                            # NEW — per-conversation AIOS scratch
│       ├── observations.md               # append-only, mid-conversation insights
│       ├── reasoning-trace.md            # optional — R-pillar structured chains
│       └── handoff-draft.md              # builds toward the session handoff
└── aios/                                 # NEW — app-level AIOS surface
    ├── skill-registry.cache.json
    ├── skill-allowlist.json
    └── skills/
        └── gemma-chat-runtime/           # the meta-skill that IS Gemma Chat's self-improvement
            ├── SKILL.md
            └── patterns/
                ├── SUMMARY.md
                ├── successful-patterns.md
                └── anti-patterns.md
```

**Why both:**

- **Per-conversation** captures context-bound observations (what worked *in this conversation*). High volume, low signal density.
- **App-level** captures distilled patterns that have crossed the 3-data-point threshold across conversations. Low volume, high signal density.
- **Promotion path** (per-conv → app-level → master library) is the same shape as Bear's autoresearch loop and matches his existing mental model.

The `gemma-chat-runtime` "skill" being app-level rather than in the master library is deliberate: it's the **dogfooded self-improvement record of Gemma Chat itself.** When Bear is ready, he promotes it to `/Users/bear/Skills/gemma-chat-runtime/` as a real first-class skill that any Claude Code session can also read (e.g., "what does Gemma Chat know about MLX failure modes?").

### 3.3 What integration pieces are net-additive to the AIOS?

These are the contributions Gemma Chat is uniquely positioned to make to the broader AIOS:

1. **An MLX / local-model skill.** The skill library currently has zero MLX-specific content. Gemma Chat is the place where MLX patterns get discovered (port collisions, EPIPE crashes, mlx-lm → mlx-vlm migration as already documented in `docs/gemma-chat-app-design.md`). These should accumulate in `patterns/anti-patterns.md` and be promoted as a `mlx-runtime` skill when mature.

2. **A "local-first agent" reference implementation.** Bear's AIOS is largely cloud-coupled (Claude Code, Hindsight MCP via cloud, Neo4j local but coupled to Claude sessions). Gemma Chat is the proof that the same conventions work entirely offline. Document this. The patterns surfaced are valuable for any future air-gapped agent work.

3. **The "session handoff from a non-Claude agent" convention.** This document proposes `SESSION_HANDOFF_gemma_*` files. If the convention works, it generalizes: any future agent (a local LLama, a fine-tuned domain model, an MCP-hosted agent) can produce `SESSION_HANDOFF_<agent>_*` files and feed into the same Knowledge_Base. **This is a real extension to persistence-discipline that should be proposed as an update once proven.**

4. **An Electron-AIOS bridge pattern.** Gemma Chat will be the first AIOS-integrated Electron app. The IPC bridge between the renderer and the AIOS surfaces (Hindsight, KG, filesystem-truth paths) is a reusable pattern. Worth documenting.

### 3.4 The smallest integration that proves the pattern works end-to-end

**Minimum viable AIOS integration — 4 increments, each independently shippable:**

#### Increment 1 — Temporal grounding + workspace `.aios/` scratch (1–2 days)

- On conversation create, inject the temporal-grounding system message.
- Create `<workspace>/.aios/observations.md` with the append-only header.
- Expose two tools in `src/main/tools.ts`:
  - `aios.observe(text)` → appends a timestamped entry to `observations.md`.
  - `aios.now()` → returns current temporal grounding (date, time, tz, workspace id, operator).
- Model is prompted (system message) to use `aios.observe` whenever it notices something worth capturing.

**Verification:** start a conversation, ask Gemma something substantive, close the conversation. `observations.md` should exist with at least one timestamped entry. No other AIOS surfaces touched.

#### Increment 2 — Session handoff on conversation close (1–2 days)

- On conversation close (or 30-min heartbeat), trigger a distillation pass: the model summarizes the conversation into the `SESSION_HANDOFF_gemma_<topic>_<YYYYMMDD>.md` template.
- Write the file to `/Users/bear/claude-tracks/Knowledge_Base/`.
- Surface a UI confirmation: "Handoff written to <path>. Open?"

**Verification:** a closed conversation produces a handoff file. Bear can read it. The file conforms to persistence-discipline conventions.

#### Increment 3 — App-level pattern accumulation (2–3 days)

- Create `userData/aios/skills/gemma-chat-runtime/` with the patterns/ subdirectory.
- Distillation pass at conversation close also evaluates whether any observation has crossed the 3-data-point threshold (by looking back across recent `observations.md` files).
- If so, append to `successful-patterns.md` or `anti-patterns.md` with the standard entry format.
- Surface a UI "Patterns" tab where Bear can review recent additions.

**Verification:** after 3+ conversations exhibiting a pattern, an entry appears in the app-level patterns file. Bear can read it. Append-only is enforced (no editing existing entries from the app).

#### Increment 4 — Skill registry consumption (2–3 days)

- At startup, scan `/Users/bear/Skills/*/SKILL.md`, parse frontmatter, filter by allowlist (initially: `orient`, `verify-env`, `session-start`, `session:resume`).
- Expose filtered skills in a UI surface (sidebar / command palette).
- Invoking a skill injects its operational protocol into the conversation as a system message.

**Verification:** the four allowlisted skills appear in the UI; invoking `orient` runs its protocol on the current workspace; the result is captured in `observations.md`.

**After these four increments are landed and stable**, the higher-risk integrations (Hindsight MCP write access, Neo4j read, promotion-to-master-library UI) can be considered. None of them are needed to prove the integration pattern works.

---

## Part 4 — Open questions for Bear

These are questions whose answers shape the integration but cannot be resolved without Bear's input:

1. **Skill v3.1 standard amendment.** Adding `runtime:` and `model_min:` frontmatter fields touches the standard. Is amending the standard preferred over a local allowlist? (Recommendation: allowlist first, propose amendment after Increment 4 is proven.)

2. **Hindsight write access for Gemma Chat.** Should Gemma Chat be a Hindsight client at all? If yes, which bank? (`shared-knowledge`, or a new `gemma-chat` bank?) (Recommendation: no Hindsight integration in v1; bridge via handoff files, let Claude Code ingest if relevant.)

3. **Neo4j read access.** Should Gemma Chat be able to query the partnership KG? Useful for context but adds dependency on Neo4j running. (Recommendation: no in v1; revisit if a real use case emerges.)

4. **Where does the "promote to Skills library" action actually write?** Directly to `/Users/bear/Skills/`, or to a staging area that Bear copies manually? (Recommendation: staging area at `~/claude-tracks/Knowledge_Base/skill-promotion-staging/`, manual copy by Bear or by Claude Code on Bear's say-so.)

5. **Are Gemma Chat handoffs first-class for IPP heartbeat counting?** If Bear had a 4-hour Gemma Chat session and no Claude Code session, should that count toward the 7-day-handoff IPP nudge? (Recommendation: yes, but that's IPP's call, not Gemma's. The handoff file is named distinctively; IPP can choose to count it.)

6. **The `gemma-chat-runtime` meta-skill — does it stay app-local forever, or graduate to `/Users/bear/Skills/`?** If it graduates, it becomes a skill that both Claude Code and Gemma Chat consume (Claude Code reads Gemma's learned patterns about itself). That's powerful. (Recommendation: stay app-local until 30+ pattern entries accumulate, then graduate.)

---

## Part 5 — What this document deliberately does NOT propose

To keep the integration disciplined and avoid over-coupling:

- **No IPP trust events from Gemma Chat.** That protocol is Bear-and-Claude only.
- **No COI integration.** Out of scope.
- **No autonomous writes to `/Users/bear/Skills/`.** Master library integrity is sacrosanct.
- **No autonomous writes to the Neo4j KG.** Decision nodes are Claude's responsibility based on Bear's say-so.
- **No new memory store invented for Gemma Chat.** Hindsight + the local filesystem are sufficient.
- **No replacement for the existing Gemma Chat workspace.** The `.aios/` subdirectory is *additive* to the existing workspace, not a redesign.
- **No T9-1 writes from background processes.** Documented sandbox limitation.
- **No bear-voice / bear-writer skill invocation from Gemma.** Communication-style skills require model capability Gemma may not have, and the risk of off-voice content under Bear's name is real.

---

## Part 6 — Cross-references and source paths

**Read for this research:**
- `/Users/bear/Skills/rise-framework/rise-framework.md` (fully loaded via `@import`)
- `/Users/bear/.claude/rules/persistence-discipline.md` (fully loaded via `@import`)
- `/Users/bear/.claude/rules/mindxpansion-filesystem-truth.md` (fully loaded via `@import`)
- `/Users/bear/Development/gemma-chat/docs/gemma-chat-app-design.md` (read directly)
- `/Users/bear/Development/gemma-chat/src/main/workspace.ts` (read directly)
- Runtime skill registry (200+ skills, visible via session reminder)

**Cited but not directly read (require verification):**
- `/Users/bear/Skills/_readme_first_/MindXpansion-CLAUDE-Standards.md` — read attempt denied; cited at the level of "this exists and governs CLAUDE.md structure"
- `/Users/bear/Skills/_readme_first_/MindXpansion_Skill_Development_Standard_v3.1.md` — read attempt denied; the SKILL.md structure and patterns/ convention in §1.4 is inferred from skill registry and RISE references, not the standard itself. **Verify §1.4 and §2.2 against the standard before implementing.**
- `/Users/bear/Skills/intelligence-partner-v3/` — IPP details are inferred from references in loaded docs and the `ipp:*` skill registry entries.
- COI v3.0 — referenced in filesystem-truth (see SESSION_HANDOFF_20260317b.md mentioned there); not loaded for this doc.

**Companion docs in this research folder** (anticipated, not yet written):
- `01-current-architecture.md` (presumed)
- `02-...` (presumed)
- `03-...` (presumed)
- `04-aios-integration-and-self-improvement.md` ← *this document*

---

## Appendix A — A worked example end-to-end

To make the abstractions concrete, here is what a Gemma Chat session would look like under this integration design:

**1. Bear opens Gemma Chat.** App starts. Skill registry scan runs. `userData/aios/skill-allowlist.json` lists `orient, verify-env, session-start, session:resume`. These appear in the command palette.

**2. Bear creates a new conversation** titled "Debugging MLX EPIPE crash on cold start."

- Workspace `c_1747476120_a3f8` is created at `~/Library/Application Support/gemma-chat/workspaces/c_1747476120_a3f8/`.
- `.aios/observations.md` is created with header.
- First system message includes temporal grounding: "Current date: 2026-05-17 (Saturday), 14:32 MT, workspace c_1747476120_a3f8, operator Bear."

**3. Bear asks** "When MLX server crashes on cold start with EPIPE, what's the most reliable fix?"

- Gemma considers 2 approaches (per [R]): (a) port reassignment, (b) stdout guard. Picks (b), confidence Medium.
- Replies with the fix.
- Calls `aios.observe("Cold-start EPIPE is reliably resolved by guarding stdout writes in the parent's chunk handler — observed across multiple conversations now.")`.

**4. Conversation continues** for 35 minutes. At minute 30, the heartbeat fires:

- A partial handoff is written: `SESSION_HANDOFF_gemma_mlx-epipe_20260517_partial.md`.

**5. Bear closes the conversation.**

- Distillation pass runs. The observation about EPIPE is correlated with two earlier observations in the app-level pattern store (one from 2026-05-13, one from 2026-05-15). **Three data points — threshold met.**
- An entry is appended to `userData/aios/skills/gemma-chat-runtime/patterns/successful-patterns.md`:

  ```markdown
  ## 2026-05-17 15:07 — Guard parent-process stdout writes to prevent MLX cold-start EPIPE

  **Context:** MLX subprocess can exit between when the parent writes a chunk and when the chunk hits the wire.
  **Pattern:** Wrap stdout writes in the parent's chunk handler with try/catch on EPIPE and bail silently.
  **Evidence:**
    - 2026-05-13: First observed in EPIPE diagnostic session (workspace c_1747...)
    - 2026-05-15: Same pattern observed on different model swap (workspace c_1747...)
    - 2026-05-17: Confirmed reliable fix in current session (workspace c_1747476120_a3f8)
  **Why it works:** EPIPE is racy — the subprocess can exit between flush and write. Treating it as expected (not error) is correct.
  **Applicable beyond:** Any Node parent-child IPC where the child may exit during a stream.
  **Source:** conversation c_1747476120_a3f8 (workspace path)
  ```

- The final handoff is written: `~/claude-tracks/Knowledge_Base/SESSION_HANDOFF_gemma_mlx-epipe_20260517.md`. The partial is deleted.
- UI surfaces a confirmation: "Handoff written. Patterns updated (1 new entry)."

**6. Next morning,** Bear starts a Claude Code session. The session-start protocol reads the latest handoff in `Knowledge_Base/` — including the Gemma-Chat handoff. Claude knows about the EPIPE pattern without Bear having to re-explain it.

**7. A week later,** the `gemma-chat-runtime` patterns file has 12 entries. Bear decides to promote it. He runs (or asks Claude Code to run) the promotion script — copies the skill to `/Users/bear/Skills/gemma-chat-runtime/`, adds frontmatter `runtime: [claude-code, gemma-chat]`, commits. Now both Claude Code and Gemma Chat consume the same skill.

This is the integration loop closing. Gemma Chat's local self-improvement compounds into Bear's master library, becomes available to every future Claude Code session, and the AIOS as a whole gets smarter from a tool that wasn't even a Claude session.

---

*End of document. ~700 lines. Next step: Bear's review of Part 4 open questions, then begin Increment 1 from Part 3.4.*
