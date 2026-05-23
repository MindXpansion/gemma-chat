---
title: 06 — Patch 40 — Heartbeat Learning Loop (Schema + Orchestration)
authors:
  - neo4j-kg-architect agent (§§1–7)
  - Claude Code on gemma-chat (§8)
  - Bear / Daryl Lantz (operator, approval + budget)
target_graph: gemma-chat-memory on bolt://localhost:7687
target_db_kernel: Neo4j Enterprise 2025.10.1 (verified live, 2026-05-23)
status: DESIGN — approved 2026-05-23 by Bear. Constraints idempotent, ready to run. Code implementation follows.
date: 2026-05-23
related:
  - docs/research/05-neo4j-voyageai-rag-design.md (foundation — §1 conforms to it)
  - ~/.claude/agent-memory/neo4j-kg-architect/runs/run_20260523_gemma-chat-patch-lineage.md (SUPERSEDES convention transplanted into §2 + §7.4)
  - src/main/heartbeat.ts (Patch 40 modifies this)
  - src/main/aios-rag.ts + aios-voyage.ts (embedding pipeline reused unchanged)
---

# 06 — Patch 40 — Heartbeat Learning Loop

**Schema + Orchestration design for turning Gemma Chat's autonomous heartbeat from observe-and-evaporate into a genuine compounding learning loop, with the architect's existing `gemma-chat-memory` schema preserved (specialized, not forked) and an operator-bounded auto-approval policy on top.**

---

## TL;DR

- **Schema:** Reuse the architect's existing `:Observation` and `:Pattern` labels (research-05). Specialize via a `:HeartbeatObservation` sub-label discriminator — same convention as `:ExtractedDecision` on the partnership KG. Do not fork.
- **Property contract:** `text` + `embedding` (1024-d voyage-3-large) + `topic` + `instruction` + `tool_name` + `tool_args_json` (stringified) + `tool_result_excerpt` + `model` + `tick_id` + optional `confidence` + optional `superseded_by`.
- **Dedupe:** vector-first with topic-equality boost. Two thresholds: cosine ≥0.92 = COVERED (redirect, never refuse); 0.85–0.92 = ADJACENT (reshape to gap); <0.85 = NOVEL. 14-day window. **Dedupe-check-tick is read-only.**
- **Synthesis:** every 20th tick. ≥3 observations at cosine ≥0.88, across ≥2 distinct topics, spanning ≥48h, with no existing `:Pattern` already within 0.90.
- **Pattern lineage:** when a new pattern contradicts an old one, `[:SUPERSEDES {reversal_condition}]` rather than overwrite. Same convention as the partnership KG Patch 37→39 lineage.
- **Autonomous policy (§8):** auto-approve up to **7 primary goals per rolling 60-minute window**, with up to **4 follow-up searches per primary**. Worst-case 35 probes/hour ≈ 840 observations/day ≈ **$0.15/day** voyage spend.
- **NotebookLM "Neo4j KG Mastery":** not needed for this design (architect's explicit call).

---

> **§§1–7 below are the neo4j-kg-architect's response verbatim** to the Patch 40 design brief on 2026-05-23. Only edits are section-number normalization and light formatting. Content unchanged. Persisted via the agent's own MEMORY directory.

## 1. Schema confirmation

**Keep `:Observation` and `:Pattern`.** Both labels are already declared in research-05 with uniqueness on `uuid`, vector indexes provisioned, and a `[:SUPPORTS]` relationship from `:Observation → :Pattern` for the 3-data-point evidence chain. Inventing `:Insight` / `:Finding` / `:HeartbeatNote` would (a) duplicate the schema authored 6 days ago, (b) fragment the vector index already created, and (c) recreate the *exact* "session-family label naming inconsistency" anti-pattern logged for the AIOS KG on 2026-05-16 (where four labels — `Session`, `ConversationSession`, `Session_Event`, `SessionStart` — exist for one concept). **Don't fork. Specialize.**

Specialize via a **discriminator sub-label** (the same convention used on the partnership KG to separate curated `:Decision` from `:ExtractedDecision`):

- `:Observation` — all observations.
- `:Observation:HeartbeatObservation` — those written by a consolidate-tick. The base label keeps them in the same vector index and same `[:SUPPORTS]` chain; the sub-label lets queries filter to/away from heartbeat noise (`WHERE NOT o:HeartbeatObservation` for human-grade observations, the inverse for autonomy diagnostics).
- `:Pattern` — unchanged.

This is the **load-bearing lesson** from the partnership-KG cleanup (logged 2026-05-23): once a high-volume autonomous writer is pointed at a label, you will *immediately* want a way to separate its output from curated entries. Build the discriminator in **before** Gemma writes the first observation, not after 4,000 of them dilute the namespace.

## 2. Property contract for `:Observation:HeartbeatObservation`

| Property | Type | Req? | Notes |
|---|---|---|---|
| `uuid` | string | **yes** | Natural key; existing UNIQUE constraint covers it. Generate client-side (crypto.randomUUID). |
| `created_at` | datetime | **yes** | `datetime()` at write. Existing RANGE index. |
| `text` | string | **yes** | Aligns with research-05's `:Observation { text }`. The existing `observation_embedding` vector index (built `ON o.embedding`) and any future fulltext on `o.text` work uniformly across heartbeat and non-heartbeat observations. |
| `embedding` | list<float> (1024) | **yes** | `voyage-3-large` of `text` via existing `embedTexts()`. Required because the vector index expects it; without it the observation is unreachable to dedupe-check-tick. |
| `topic` | string | **yes** | Short canonical subject string (lowercased, stripped, ≤80 chars). *Coarse* dedupe key. |
| `instruction` | string | **yes** | The plan-tick goal text verbatim. |
| `tool_name` | string | **yes** | E.g. `gemma_kg_query`, `web_search`. |
| `tool_args_json` | string | **yes** | **Stringified JSON, not a map.** Neo4j map properties don't support nesting; flatten now or fight serialization later. Cap at 4KB. |
| `tool_result_excerpt` | string | **yes** | First 2KB of raw tool output for grounding/forensics. Cap enforced. |
| `journal_path` | string | optional | Absolute path. Optional because a tick may fail to write a journal but still produce an Observation. |
| `model` | string | **yes** | `gemma-e4b` / `gemma-27b-moe` / etc. For model-vs-quality analysis. |
| `tick_id` | string | **yes** | UUID of the heartbeat tick record. Indexed (see §5). |
| `confidence` | float (0–1) | optional | Self-rated confidence. Optional now; required when calibration lands in a later patch. |
| `superseded_by` | string (uuid) | optional | If a later observation on the same `topic` materially corrects this one. Mirrors the SUPERSEDES convention from the partnership KG. Backed by a relationship. |

### Relationships

- `(:HeartbeatTick {uuid})-[:PRODUCED]->(:Observation)` — tick record as audit anchor. One per tick (cheap).
- `(:Observation)-[:ABOUT]->(:Workspace)` — single attachment to current workspace.
- `(:Observation)-[:DERIVED_FROM]->(:Chunk|:Document)` — **only when the probe-tick actually read a corpus node**. Walkable provenance.
- `(:Observation)-[:SUPERSEDES]->(:Observation)` — when consolidate-tick determines the new observation materially corrects a prior one on the same topic (cosine ≥ 0.92 AND narration contradicts). Optional `reversal_condition: string` property on the edge.
- `(:Observation)-[:SUPPORTS]->(:Pattern)` — already in research-05. Keep.

**Do NOT add** an automatic `[:RELATED]` between observations of the same `topic`. Cosine similarity already answers that question on demand; materializing it as edges creates write-amplification and edge-noise.

## 3. Dedupe semantics (the load-bearing question)

**Use BOTH signals, in a defined order, with hard thresholds.** Pure lexical equality misses paraphrase; pure vector similarity has tail noise. The combo is cheap and explainable.

### Dedupe-check-tick decision procedure

```
Input: candidate topic T, candidate instruction I
1. Compute embedding e = embedTexts(T + " :: " + I)
2. Query top-K=5 neighbors:
     CALL db.index.vector.queryNodes('observation_embedding', 5, e)
     YIELD node, score
     WHERE score >= 0.85
       AND node.created_at > datetime() - duration('P14D')
     RETURN node, score
3. Classify:
     - score >= 0.92 AND topic equals (case-insensitive) → COVERED
     - score in [0.85, 0.92) → ADJACENT (reshape goal to the gap, do not skip)
     - no hits → NOVEL (proceed as planned)
```

**Thresholds rationale:** voyage-3-large on 1024d normalized embeddings, in this corpus, places semantically identical paraphrases ≥0.92 and same-topic-different-angle in ~0.85–0.91. Empirical recommendation: log `(score, was_actually_dup)` for the first 100 dedupe decisions and re-tune at Patch 41.

**14-day time window:** older observations may be stale enough that re-investigation is valuable; without a window, Gemma will refuse to ever revisit a topic. Tune by volume — 200/day → drop to 7d; 20/day → extend to 30d.

### Anti-patterns to avoid here (explicit)

1. **Dedupe-check-tick writing its own `:Observation`.** It must NOT. Otherwise every dedupe check pollutes the very index it's querying, and you get exponential noise. Dedupe-check-tick is **read-only on the KG**; its output is a reshaped (or cancelled) plan, not a graph write.
2. **Hard-blocking on COVERED.** Don't make COVERED a refusal; make it a *redirect* — "you already know X about T; investigate the open sub-question Y." Keeps Gemma curious instead of frozen.
3. **Topic strings as free-form sentences.** Enforce ≤80 chars + lowercase. Otherwise `topic =` never matches and you're 100% reliant on vector similarity.
4. **No corpus floor.** Until ≥10 `:HeartbeatObservation` exist in-window, skip dedupe entirely — the index is too sparse to be meaningful and you'll waste tokens.

## 4. Pattern synthesis trigger (review-tick)

**Concrete rule:** Run review-tick every **20th** heartbeat (tunable). Trigger a `:Pattern` proposal when **all** of:

1. ≥3 `:HeartbeatObservation` nodes within cosine ≥ 0.88 of a centroid candidate (cluster density).
2. Across **≥2 distinct `topic`** values (synthesis requires breadth — same-topic-only is just repetition).
3. Spanning **≥48 hours** (avoids same-session echo-chambers).
4. No existing `:Pattern` already covers the centroid at cosine ≥ 0.90.

### Sample candidate-surfacing Cypher (read-only)

```cypher
// Find observation clusters that meet synthesis criteria.
MATCH (o:HeartbeatObservation)
WHERE o.created_at > datetime() - duration('P14D')
  AND o.embedding IS NOT NULL
CALL (o) {
  WITH o
  CALL db.index.vector.queryNodes('observation_embedding', 6, o.embedding)
  YIELD node AS n, score
  WHERE n:HeartbeatObservation
    AND n.uuid <> o.uuid
    AND score >= 0.88
  RETURN collect(DISTINCT n) AS neighbors, collect(DISTINCT n.topic) AS topics
}
WITH o, neighbors, topics
WHERE size(neighbors) >= 3
  AND size(topics) >= 2
  AND duration.between(
        reduce(mn = o.created_at, x IN neighbors | CASE WHEN x.created_at < mn THEN x.created_at ELSE mn END),
        datetime()
      ).hours >= 48
OPTIONAL CALL db.index.vector.queryNodes('pattern_embedding', 1, o.embedding)
YIELD node AS p, score AS pscore
WITH o, neighbors, topics, pscore
WHERE pscore IS NULL OR pscore < 0.90
RETURN o.uuid AS seed_uuid, o.topic AS seed_topic,
       [n IN neighbors | n.uuid] AS supporting_uuids,
       topics AS distinct_topics
ORDER BY size(supporting_uuids) DESC
LIMIT 5;
```

The review-tick turns each candidate into a **probe** ("here are 4 related observations; synthesize the pattern they share"). The resulting narration becomes the `:Pattern.text`, embedded the same way, with `[:SUPPORTS]` edges to the supporting observations and `evidence_count = size(supporting_uuids)`.

This is the right place for the **"don't claim finality"** convention: `:Pattern.text` should be written hypothesis-first ("Across these N observations, the apparent regularity is…"), never as a closed fact. Add a `confidence: float` on `:Pattern` and decay it if subsequent observations contradict.

## 5. Constraint / index additions (`CREATE … IF NOT EXISTS`)

All idempotent. To run in `gemma-chat-memory` database.

```cypher
-- Heartbeat-specific labels (uniqueness on tick)
CREATE CONSTRAINT heartbeat_tick_uuid IF NOT EXISTS
  FOR (t:HeartbeatTick) REQUIRE t.uuid IS UNIQUE;

-- Observation lookup paths used by dedupe-check-tick & review-tick
CREATE INDEX observation_topic IF NOT EXISTS
  FOR (o:Observation) ON (o.topic);

CREATE INDEX observation_tick_id IF NOT EXISTS
  FOR (o:Observation) ON (o.tick_id);

-- Composite: "recent observations on this topic" as a single index seek
CREATE INDEX observation_topic_created_at IF NOT EXISTS
  FOR (o:Observation) ON (o.topic, o.created_at);

-- Optional fulltext on narration text for grep-style audits & UI
CREATE FULLTEXT INDEX observation_text_ft IF NOT EXISTS
  FOR (o:Observation) ON EACH [o.text];
```

**Deliberately NOT proposed:**
- No new vector index — `observation_embedding` already exists at 1024d cosine and serves both `:Observation` and `:HeartbeatObservation` (sub-label inherits base-label index).
- No range index on `embedding` — meaningless on vector data.
- No constraint on `text` uniqueness — paraphrases would defeat it; the topic+tick guard above is the right granularity.

**Future consideration (Enterprise):** `REQUIRE (o.tick_id, o.topic) IS NODE KEY` to enforce one-Observation-per-tick-per-topic in the kernel rather than application-side. Deferred from Patch 40.

## 6. NotebookLM "Neo4j KG Mastery" — not needed for this task

Between (a) the agent's own definition (canonical patterns for label discrimination, dedupe thresholds, write-amplification, vector-filter strategies, lock-contention, SUPERSEDES convention), (b) research-05 design (schema + indexes + `[:SUPPORTS]` semantics), and (c) the live graph state, the design is fully determined.

If a notebook-backed second opinion were wanted on something narrow, the only question worth consulting is: **"What's the empirical recall@5 of voyage-3-large cosine at score ≥0.85 vs ≥0.92 for paraphrase-vs-different-topic classification on small corpora (<1k chunks)?"** — because the §3 thresholds are educated estimates, not measured. Everything else is already determined.

## 7. Load-bearing flags

1. **Consolidate-tick must `await` the voyage embed (~200–800ms) + write before the next plan-tick fires.** Otherwise dedupe-check races and misses the just-written observation, defeating the whole loop. Orchestration constraint, not schema, but ignoring it makes the schema moot.

2. **Write-amplification cost is real.** At 1 tick/min that's 1,440 observations/day. Within a week, 10k vectors in HNSW. Fine for Neo4j 2025.10 (scales to millions). Voyage-3-large API spend at 1k tokens/observation ≈ **$0.18/day**. Confirm intentional or batch consolidate to every Kth probe. **[Bear answered 2026-05-23: every probe. Reasoning in §8.1.]**

3. **Backpressure when Gemma is wrong a lot.** If she goes off-rails and writes low-quality observations, dedupe-check-tick starts matching them and reshapes future probes around her own hallucinations. **Mitigation:** optional `confidence` floor in the dedupe query (`WHERE node.confidence IS NULL OR node.confidence >= 0.4`). Weak signal but better than nothing; tune cutoff after observation.

4. **Patch lineage on `:Pattern` nodes.** When a review-tick proposes a pattern that *contradicts* an existing one, write `(new)-[:SUPERSEDES {reversal_condition: '...'}]->(old)` rather than updating in place. Transplant of today's partnership-KG convention. Cross-applicable: pattern revisions become a first-class part of Gemma's intellectual history rather than silent overwrites.

5. **The `:Workspace` node.** Ensure exactly one exists per Gemma-chat conversation/workspace and that `[:ABOUT]` always attaches. Otherwise observations float and `MATCH (w:Workspace {id: $wid})<-[:ABOUT]-(o)` won't scope correctly. Biggest "I forgot to wire this" risk in the loop.

6. **NOT recommending** GraphRAG-style community detection (GDS Leiden) on observations yet. With <10k observations and a 4-tick autonomous loop, the §4 synthesis rule is sufficient and explainable. Add Leiden in a future patch only if §4 produces too few or too noisy candidates after empirical observation.

---

> **§8 below is by Claude Code on `gemma-chat`** (not the architect). It designs the orchestration policy for *when and how often* Gemma is allowed to launch ticks, per Bear's 2026-05-23 directive. The graph schema is the architect's domain (§§1–7); cadence + auto-approval is the app's.

## 8. Autonomous policy — auto-approve goals + follow-ups

### 8.1 Budget contract

- **Primary goals:** up to **7 per rolling 60-minute window**, auto-promoted from `queued` → active without operator ratification.
- **Follow-up searches:** up to **4 per primary goal**, emitted by the consolidate-tick when the narration surfaces a worthy thread.
- **Worst-case probe budget:** 7 + (7 × 4) = **35 probes/hour**, ≈ 840 observations/day. **Below the architect's 1,440/day write-amplification ceiling.** Voyage-3-large API cost at this rate: **≈ $0.15/day** (~$4.50/month).
- **Bear's choice (2026-05-23):** consolidate every probe (not every Kth) — *"We don't want to lose anything."* Reasoning: $0.15/day for genuine compounding learning is cheap; slowing consolidation slows the very thing this patch fixes.

### 8.2 Goal lifecycle (post-Patch 40)

```
plan-tick                            ← fires when (active + queued primaries) < 2
  ↓ proposes 3–6 primary goals
auto-promoter                        ← gate: rolling-60min primary count < 7
  ↓ promotes up to (7 − used) goals: queued → active
dedupe-check-tick                    ← per goal (read-only on KG)
  ↓ classifies COVERED | ADJACENT | NOVEL
  ↓ if COVERED → redirect goal text to open sub-question (never refuse)
probe-tick                           ← one tool call, narrate
  ↓
consolidate-tick                     ← awaits voyage embed, writes :HeartbeatObservation
  ↓ narration may emit "FOLLOW_UP: <instruction>" lines (0..K)
follow-up enqueue                    ← gate: parent's follow-up count < 4
  ↓ loop back to dedupe-check-tick for each follow-up
       (follow-ups count against parent's 4-cap, NOT against primary 7/hour cap)
```

### 8.3 Rate-limiter implementation

- **Storage:** `heartbeat-state.json` (existing) gains a `primaryGoalLedger: Array<{ id: string; promoted_at: ISO8601 }>` field. Each promotion check evicts entries older than 60 minutes; counts what remains; promotes `min(remaining_capacity, queued_primary_count)` goals.
- **Promotion atomicity:** ledger update + goal status transition is a single in-process critical section. Heartbeat is single-threaded (single MLX server + `isBusy` guard).
- **Race:** none, because ticks are serial by construction.

### 8.4 Follow-up emission

The consolidate-tick's narration prompt gains an appendix:

> *If — and only if — the tool result surfaces a specific concrete sub-question that would meaningfully extend this finding, append up to **N** lines of the form:*
>
> `FOLLOW_UP: <one-tool instruction>`
>
> *N is the remaining follow-up budget for this goal (provided in your context). Each follow-up must (a) be specific (not "investigate further"), (b) name a HEARTBEAT_TOOL it would use, (c) be answerable in one tool call. Otherwise output nothing.*

**Parser:** regex `^FOLLOW_UP:\s*(.+)$`, line-by-line, hard cap of 4 captures per consolidate-tick regardless of N. Each enqueued as `{ parent_id, instruction, status: 'queued' }`. The resulting `:HeartbeatObservation` (after its own probe + consolidate) gets a `[:SPAWNED_FROM]` edge to the parent observation.

### 8.5 Safety rails (composed with §§3, 7)

1. **Dedupe-check-tick is read-only** (§3). Follow-ups can't pollute the dedupe corpus.
2. **Confidence floor in dedupe** (§7.3). Hallucination feedback can't compound.
3. **Hard cap on follow-ups per primary (4).** Even if Gemma wants 10, only the first 4 enqueue.
4. **Hard cap on primaries per hour (7).** Plan-tick may propose 12 — only 7/hour promote.
5. **Existing kill-switch.** Bear can disable heartbeat at any time; the loop respects `isBusy` and the enabled flag.
6. **Cadence backstop.** At 1 tick/min, theoretical throughput is 60 ticks/hour. Each probe consumes 3 ticks (dedupe + probe + consolidate), so ~20 probes/hour at 1-min cadence — well below the 35-probe ceiling. **Cadence is the soft cap; the 7/4 ledger is the hard cap.** If Bear sets cadence to 30s, the 7/4 cap kicks in.

### 8.6 Operator visibility

The existing Heartbeat UI panel grows:
- A **rolling-hour gauge** showing X/7 primaries used (color-coded, resets as ledger evicts).
- A **goal tree** view: primary goals as roots, follow-ups as children, observation count per node. Lets Bear see what threads compounded vs. what stayed shallow.

Both read existing IPC + the new ledger field. No new IPC surface beyond `heartbeat:goals-get` returning the enriched shape.

### 8.7 Out of scope for Patch 40 (defer)

- **Cross-primary follow-ups** — a follow-up of primary A can't trigger one for primary B. Keeps the tree shallow and the budget arithmetic obvious.
- **Auto-mission promotion** — if Gemma identifies a 7-step research mission, Patch 40 does NOT auto-launch it via the mission engine (Patch 35's territory; stays operator-gated).
- **Cross-day learning rollups** — a daily `:Pattern` synthesis report is a clean Patch 41 extension once observation volume justifies it.

---

## Provenance + decision lineage

- **Schema design (§§1–7):** `neo4j-kg-architect` agent, 2026-05-23. Transcript persisted in `~/.claude/agent-memory/neo4j-kg-architect/` (run log + patterns updated).
- **Orchestration policy (§8):** Claude Code on `gemma-chat`, 2026-05-23, per Bear's auto-approve directive.
- **Approved by Bear 2026-05-23:** budget = every probe consolidates ($0.15/day); design doc saved as research-06; schema additions in §5 to run as `IF NOT EXISTS`.
- **Conforms to:** `docs/research/05-neo4j-voyageai-rag-design.md`. Schema not forked.
- **Transplants from partnership KG:** SUPERSEDES + claimed-finality convention ratified today via Patch 37→38→39 lineage. See `run_20260523_gemma-chat-patch-lineage.md`.
- **Repo HEAD at design time:** `43f538f` (Patch 39 — orphan-proof MLX port clear).
