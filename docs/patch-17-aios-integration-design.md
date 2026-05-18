# Patch 17 — AIOS Integration Design

> **Status:** APPROVED 2026-05-18 — Option A (LITE) with **write access** to all five IPP files. No Skills writes. No partnership_state.py invocations.
> **Author:** Claude (Opus 4.7) for Bear, 2026-05-18 (continuing 17:23 handoff)
> **Supersedes:** Patch 16 (`aios_observe` + `aios_now`) — partially reinvented existing systems

## Revised boundary (Bear's 2026-05-18 decision, overriding original design)

| Operation | Path | Allowed? |
|---|---|---|
| READ | `~/Skills/temporal-intelligence/scripts/*` (via Python invocation) | ✅ |
| READ | `~/.intelligence_partner/*.md` (all five files including memory.md) | ✅ |
| WRITE | `~/.intelligence_partner/*.md` — **section-based patches only**, honor file header write-permission tiers | ✅ (NEW) |
| INVOKE | `partnership_state.py trust\|checkpoint\|...` | ❌ (files yes, state-machine no) |
| WRITE | `~/Skills/*` | ❌ (sacrosanct) |
| WRITE | `<appData>/gemma-chat/.aios/observations.md` | ✅ |

`about-partner.md` updated in same commit to reflect this.

---

## What this patch is, in one sentence

Wire Gemma into the three AIOS subsystems she should be using instead of reinventing — **temporal-intelligence** (grounding), **intelligence-partner-v3** (memory + relationship), and **RISE** (cognition) — while strictly honoring HYBRID write boundaries (read-only on `~/Skills/` and `~/.intelligence_partner/`).

## Why now

Patch 16 shipped `aios_now` (duplicates temporal-intelligence) and `aios_observe` (partially duplicates IPP's memory layer). You caught it. The fix isn't to revert — it's to plug Gemma into the real subsystems so she shares grounding, memory, and cognitive protocol with the rest of your AIOS instead of building parallel ones.

## What I read during investigation (~30 min, today)

| Source | What I learned |
|---|---|
| `~/Skills/temporal-intelligence/SKILL.md` | Skill is hook-driven. CLI: `python3 temporal_context.py --summary --no-weather` (5s timeout) returns a clean multi-line block (TODAY/TIME/TIMEZONE/WEEK/date-reference-map/geo). Auto-skips weather for speed. Spawnable from any process. |
| `~/Skills/temporal-intelligence/scripts/session-grounding.js` | Reference pattern: Node hook spawns Python via `execFileSync`, returns `{continue, systemMessage}`. Silent failure if Python missing. Electron main can adopt the same pattern with the existing safe-spawn utilities. |
| `~/Skills/intelligence-partner-v3/SKILL.md` | IPP is the **relationship layer** above RISE. Phase 3, trust 0.93, 354+ sessions with you. Owns partnership state, memory continuity, theory-of-mind, disagreement protocol. |
| `~/.intelligence_partner/soul.md` (52 lines) | Compact identity record — Phase 3, trust 0.93, who Bear is, who Claude-as-IPP is. **Worth reading into Gemma's prompt verbatim.** |
| `~/.intelligence_partner/preferences.md` (59 lines) | Working style + tech preferences. **Worth reading verbatim.** |
| `~/.intelligence_partner/comms.md` | Signal-reading table ("=)", "!!", "Let's do it", "Is that the right choice?") + tone adaptation. **Worth reading verbatim.** |
| `~/.intelligence_partner/ideals.md` | 10 non-negotiable principles. **Worth reading verbatim.** |
| `~/.intelligence_partner/memory.md` | Bear-and-Claude session/learning history. Heavy (~100+ lines, AIOS-specific). **Skip for Gemma** — not her context. |
| `~/Skills/rise-framework/rise-framework.md` | Already @imported in global CLAUDE.md. 4 pillars: Reasoning / Insights / Self-Improvement / Execution. **Teach Gemma the protocol via prompt — fits in ~25 lines.** |

## What Patch 17 does NOT do (out of scope)

- ❌ **Does not write** to `~/.intelligence_partner/`, `~/Skills/`, or the partnership KG. Read-only access only.
- ❌ Does not invoke `partnership_state.py trust <event>` (those are Bear-and-Claude trust events, not Gemma's).
- ❌ Does not pull TaskFlow data, Calendar, Apple Notes (Phase 2.x territory if ever).
- ❌ Does not wire Hindsight `shared-knowledge` writes (deferred to Phase 2.6 session-handoff work).
- ❌ Does not query Neo4j (Phase 2.7 RAG work).

---

## Two options for your decision

### Option A — Patch 17 LITE (~1.5 hrs, 1 commit)

**Scope:** Read-only integration at chat start. Inject temporal-intelligence block, partner profile, and RISE protocol into system prompt. Reframe (don't remove) Patch 16's `aios_observe`/`aios_now`.

**Code surface (estimated ~250 lines net):**

1. **New: `src/main/aios-integration.ts` (~150 lines)**
   - `loadTemporalContext()` — invoke `python3 ~/Skills/temporal-intelligence/scripts/temporal_context.py --summary --no-weather` via safe argv-spawn with 5s timeout. Return text or empty string on failure. Silent fallback to JS-side `formatNow()` (Patch 16 code) if Python missing.
   - `loadPartnerProfile()` — read `~/.intelligence_partner/{soul,preferences,comms,ideals}.md`, concat with H2 dividers, ~200 lines total. Cache for session.
   - `risePrinciples()` — hardcoded ~25-line summary of the 4 pillars + activation triggers + grounding checks. Sourced verbatim from `rise-framework.md` Part 1 condensed view.
   - All three read-only. No writes anywhere outside `<appData>/gemma-chat/.aios/`.

2. **Modify: `src/main/tools.ts`**
   - Replace `aiosSubsystem()` content with a new composite: temporal block + partner-profile reference + RISE 4-pillar teach + the existing local-observation-log section (renamed "YOUR LOCAL NOTEBOOK" to clarify Gemma's write surface is local-only, not IPP).
   - Keep `aios_observe` tool (writes to local `<appData>/gemma-chat/.aios/observations.md` per HYBRID boundaries — IPP files are read-only to her).
   - Deprecate `aios_now` → wrap it to invoke `loadTemporalContext()` so Gemma gets the rich block, not just `Date()`.

3. **Modify: `src/main/index.ts`**
   - Call `loadTemporalContext()` + `loadPartnerProfile()` at chat-start (once per chat, not per turn). Cache results on the conversation object.
   - System-prompt builder threads cached blocks into the prompt.

**What Gemma gains:**
- Knows exactly what time/day/week it is via the canonical temporal source (no drift from system clock).
- Knows you as IPP knows you — Phase 3, trust 0.93, signal-reading table, the 10 ideals — not just the about-partner.md summary.
- Carries the RISE cognitive protocol as behavioral spec (grounded reasoning, multi-hypothesis, counterfactual testing, pattern capture, etc.).
- Stops reinventing temporal grounding.

**What's left for FULL:**
- Pattern files (successful/anti-patterns under `<appData>/gemma-chat/.aios/patterns/`).
- Periodic RISE Self-Improvement reflection cycle.
- Partnership state read (e.g., displaying current trust phase to Gemma at chat start).

**Risk:** Low. All reads are non-destructive. Python timeout is bounded. Silent fallback preserves Patch 16's behavior if any subsystem unavailable.

**Estimated effort:** 1.5 hrs implementation + ~30 min testing (E4B + 26B-MoE verifying they now reference IPP-level details about you).

---

### Option B — Patch 17 FULL (~6-10 hrs, 3-4 commits)

Everything in LITE, plus:

1. **Pattern accumulation infrastructure** (~2-3 hrs, 1 commit)
   - `<appData>/gemma-chat/.aios/patterns/successful-patterns.md` + `anti-patterns.md`
   - Auto-loaded into system prompt at chat start (last N entries, token-budgeted)
   - `aios_observe` reroutes: tagged "pattern-success" / "pattern-anti" go to the pattern files; untagged stay in observations.md
   - Mirrors AIOS skill `patterns/` structure exactly

2. **RISE Self-Improvement cycle** (~1-2 hrs, 1 commit)
   - New tool `aios_reflect`: triggers a meta-prompt asking Gemma to evaluate the last turn against goal/result, capture lesson, route to pattern file
   - UI surface: small "reflect" button next to Regenerate (optional)
   - Or: auto-trigger every N exchanges (configurable, off by default)

3. **Partnership-state read** (~1 hr, 1 commit)
   - Invoke `python3 ~/Skills/intelligence-partner-v3/scripts/partnership_state.py --status` at chat start, read-only
   - Surface to Gemma as: "Your partner Bear is in Phase 3 (Deep Partnership, trust 0.93, 354+ sessions) with his primary AI partner. You're his local-first counterpart — operate at that level."
   - Lets Gemma calibrate initiative-level appropriately

4. **Hindsight `shared-knowledge` write integration** (~1-2 hrs, 1 commit)
   - Tool `aios_share`: writes a tagged observation to Hindsight `shared-knowledge` bank via MCP (when available)
   - **Caveat:** requires Hindsight MCP available in Electron renderer — needs investigation; may be a Phase 2.6 prerequisite rather than Patch 17 scope

**Risk:** Medium. More moving parts. Pattern files grow unbounded without curation (mitigation: 10% growth cap per your anti-bloat preference, max 500 lines per pattern file).

**Estimated effort:** 6-10 hrs split across 3-4 sessions.

---

## My recommendation

**Ship LITE now. Validate live. Decide FULL based on what LITE surfaces.**

Reasoning:
1. LITE delivers the architectural correction immediately — Gemma stops reinventing, starts plugging in. That's the conceptual win.
2. LITE is small enough to verify in one session: load E4B → ask "what do you know about Bear?" → expect IPP-level depth, not just about-partner.md surface. Ask "what time is it?" → expect temporal-intelligence block.
3. The pattern/reflection infrastructure in FULL has real design questions (auto vs manual reflection, how to curate without bloat, when to summarize old patterns) — better to defer until LITE is in your hands and you can feel where the gaps actually are.
4. Hindsight write integration is genuinely a Phase 2.6 dependency — don't smuggle it into Phase 1 closeout.
5. Matches your stated "lite-first" preference from the handoff.

## Boundary contract (both options)

| Operation | Path | Allowed? |
|---|---|---|
| READ | `~/Skills/temporal-intelligence/scripts/*` (via Python invocation) | ✅ |
| READ | `~/Skills/intelligence-partner-v3/scripts/partnership_state.py --status` (FULL only) | ✅ |
| READ | `~/.intelligence_partner/{soul,preferences,comms,ideals}.md` | ✅ |
| READ | `~/.intelligence_partner/memory.md` | ❌ (skip — Bear-and-Claude specific) |
| WRITE | `~/.intelligence_partner/*` | ❌ (IPP-owned) |
| WRITE | `~/Skills/*` | ❌ (sacrosanct) |
| WRITE | `<appData>/gemma-chat/.aios/observations.md` | ✅ (Gemma's local notebook) |
| WRITE | `<appData>/gemma-chat/.aios/patterns/*` (FULL only) | ✅ (Gemma's local pattern files) |
| WRITE | Partnership KG (`kg-arch-enterprise`) | ❌ |
| INVOKE | `partnership_state.py trust <event>` | ❌ (Bear's territory) |

## Open decisions for Bear

1. **LITE or FULL?** Recommend LITE-first; defer FULL until LITE is live and gaps are visible.
2. **For LITE: keep `aios_now` as a tool wrapping the temporal-intelligence call, or remove it entirely** (let the system prompt's pre-loaded block do the job)? Recommend: **wrap it** — gives Gemma a way to refresh time mid-long-conversation.
3. **For LITE: include weather in the temporal block?** Default is `--no-weather` for speed (5s vs 8s). Recommend: **no weather** at chat start; expose `aios_weather` as a separate tool if you want it on demand.
4. **For FULL: auto-reflect cadence?** If we go FULL, recommend off-by-default with a manual button; auto-cadence is a Phase 2 design question.

## Verification plan (post-LITE-ship)

1. Cold start app, load E4B
2. Ask "What time is it and what timezone?" → expect temporal-intelligence block in answer (TODAY/TIME/WEEK)
3. Ask "What do you know about Bear?" → expect IPP-level: Phase 3, trust 0.93, signal-reading patterns, 10 ideals
4. Ask "How should we approach this task?" (generic) → expect RISE-flavored response (grounding, hypotheses, counterfactuals)
5. Repeat with 26B-MoE for cross-variant verification

## What I will NOT touch (preserving your rules)

- Won't modify any file under `~/Skills/` or `~/.intelligence_partner/`
- Won't change Karpathy principles' "surgical changes" pattern — Patch 17 only adds the integration module + edits system-prompt section in `tools.ts` + small `index.ts` wiring
- Won't bundle unrelated work into this patch (audio gating stays separate as Patch 1.5)
- Won't ship without your approval of this design

---

*Awaiting your decision: A (LITE), B (FULL), or modifications.*
