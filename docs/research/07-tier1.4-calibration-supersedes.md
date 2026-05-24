---
title: 07 — Tier 1.4 — Contradiction-SUPERSEDES + Confidence Calibration
authors:
  - neo4j-kg-architect agent (schema + detection + Cypher)
  - Claude Code on gemma-chat (implementation hooks — to author after Bear ratifies)
  - Bear / Daryl Lantz (operator, approval + binding principles)
target_graph: gemma-chat-memory on bolt://localhost:7687
target_db_kernel: Neo4j Enterprise 2025.10.1 (verified live by precedent docs 05 + 06)
embedding_model: voyage-3-large @ 1024d cosine (ADR-20260516; do NOT mix)
status: DESIGN — ready for Bear review. Schema migration in §4 is idempotent.
date: 2026-05-24
related:
  - docs/research/06-patch40-heartbeat-learning-loop.md (§7.4 ratified SUPERSEDES on :Pattern; this doc extends to :Observation and adds detection mechanism)
  - ~/.claude/agent-memory/neo4j-kg-architect/runs/run_20260523_gemma-chat-patch-lineage.md (partnership-KG SUPERSEDES precedent: Patch 39 → Patch 37)
  - src/main/heartbeat.ts (runConsolidate at L961, runReview at L1250 — hook sites)
  - src/shared/types.ts (HeartbeatState at L141 — gauge surface)
---

# 07 — Tier 1.4 — Contradiction-SUPERSEDES + Confidence Calibration

**Auto-detect when a new Observation contradicts an existing one, capture the supersession with a reason and evidence, and make Gemma's self-rated `confidence` calibration answerable with a single Cypher query.**

---

## TL;DR

- **Edge:** `(new:Observation)-[:SUPERSEDES { reason, detection_method, judge_confidence, created_at, supersede_kind }]->(old:Observation)`. Same shape for `(:Pattern)-[:SUPERSEDES]->(:Pattern)` — extends research-06 §7.4.
- **Trigger:** **inline at end of `runConsolidate`**, after the new Observation is written. Read-only KG probe (top-K vector neighbors) → cheap rule prefilter → single local-Gemma judgment call. No new tick kind; no extra MLX load (reuses the model already warm).
- **Threshold:** candidates only when cosine ≥ 0.88 AND same `topic` AND ≥1h apart (no same-tick self-supersession). LLM judgment is the gate that actually fires the edge.
- **Volume guard:** at most **1 SUPERSEDES write per consolidate** (the strongest candidate). Bounded cost regardless of corpus growth.
- **Calibration:** **queryable on demand** — no `:Calibration` audit node. A single Cypher (§5) buckets `:Observation.confidence` and reports supersede-rate per bucket. Cheap because the supersede count is a graph property (degree), not a scan.
- **Operator surface:** `HeartbeatState` gains `lastSupersedeAt?: number` + `supersedesLast24h?: number`. UI gauge: "Revisions (24h): N" next to the Pattern count.
- **Risk #1 to track:** the judge is local Gemma 4 — same model that wrote the observation. Worst-case: she rarely disagrees with herself. Mitigation in §7.

---

## 1. Schema additions

### 1.1 Edge type — `[:SUPERSEDES]`

Applies to **both** `(:Observation)→(:Observation)` and `(:Pattern)→(:Pattern)`. Same property contract; the endpoint labels distinguish.

| Property | Type | Req? | Notes |
|---|---|---|---|
| `created_at` | datetime | **yes** | `datetime()` at write. |
| `reason` | string | **yes** | One-sentence LLM-supplied rationale. Cap 500 chars. E.g. *"New observation reports MLX server returns 200 on /v1/models; prior reported 404 — endpoint was added in 0.24.0."* |
| `detection_method` | string | **yes** | Enum: `'vector+topic+llm'` (Tier 1.4 default), `'vector+rule'` (future), `'manual'` (operator-flagged). |
| `judge_confidence` | float (0–1) | **yes** | The local Gemma judge's own confidence that the two contradict (separate from either node's `confidence`). Lets us later filter weak supersessions. |
| `supersede_kind` | string | **yes** | Enum: `'contradicts'` (logical disagreement), `'refines'` (same direction, more precise), `'invalidates'` (the old observation is now believed wrong wholesale). Gives downstream queries a typed handle. |
| `tick_id` | string | **yes** | The consolidate-tick UUID that triggered detection — audit trail. |

**Direction convention:** `new → old`. Read as "new SUPERSEDES old." Same as the partnership-KG Patch 39 → Patch 37 precedent.

**No `:Contradiction` audit node.** The edge IS the audit record. Adding a node would (a) double the storage cost, (b) require a third hop to traverse provenance, (c) repeat the "session-family label sprawl" anti-pattern logged on 2026-05-16. The edge's `reason` + `judge_confidence` + `tick_id` are sufficient for forensics; if we ever need richer audit, add it then.

### 1.2 Property additions

- `:Observation.superseded_at` — datetime, optional. Stamped on the OLD observation when a SUPERSEDES edge is written into it. Denormalized (the edge is the source of truth) but lets the calibration query in §5 skip a relationship hop. Cheap.
- `:Observation.supersede_count` — int, optional, default 0. Incremented on the OLD observation. Same denormalization rationale.
- Same two properties added to `:Pattern` for symmetry.

These two are the load-bearing denormalization that makes calibration a single index seek instead of a graph traversal across 800+ observations/day.

### 1.3 Constraints & indexes (idempotent)

```cypher
-- Edge property index lets us answer "show me the 10 weakest recent supersessions"
-- without scanning. Relationship range index, Cypher 25.
CREATE INDEX supersedes_created_at IF NOT EXISTS
  FOR ()-[r:SUPERSEDES]-() ON (r.created_at);

CREATE INDEX supersedes_judge_confidence IF NOT EXISTS
  FOR ()-[r:SUPERSEDES]-() ON (r.judge_confidence);

-- Denormalized supersede markers — lets calibration query in §5 stay O(buckets)
CREATE INDEX observation_superseded_at IF NOT EXISTS
  FOR (o:Observation) ON (o.superseded_at);

CREATE INDEX observation_confidence IF NOT EXISTS
  FOR (o:Observation) ON (o.confidence);
```

No new vector index. No new uniqueness constraint (uniqueness on the EDGE between two specific UUIDs is enforced application-side via `MERGE` on both endpoint UUIDs — see §4.2).

---

## 2. Detection: trigger, method, action

### 2.1 Trigger point — end of `runConsolidate`

After the new Observation is written and its `[:PRODUCED]`/`[:ABOUT]`/`[:SPAWNED_FROM]` edges are committed (heartbeat.ts L1014–L1042), and **before** `runConsolidate` returns, fire a single contradiction check.

**Why here, not in a separate tick:**
- The just-written Observation's embedding is already computed and indexed.
- The Gemma model is already warm in MLX (Bear's binding rule: no two MLX models at once).
- One round-trip vs. another whole tick = lower latency budget impact (~+300–800ms per consolidate).
- Per research-06 §7.1 the consolidate-tick already awaits the voyage embed; we're piggybacking on that synchronous moment.

**Why not on review-tick / new Pattern:** Pattern-vs-Pattern supersession is rarer and lower-volume. We support the same edge shape there (§6) but don't add a dedicated trigger in Tier 1.4 — the next review-tick that produces a contradicting Pattern will run the same detection inline.

### 2.2 Detection procedure

```
Input: newly written observation N (uuid, text, topic, embedding, confidence)

1. Rule prefilter (Cypher, read-only):
   - Top-5 vector neighbors of N from observation_embedding.
   - WHERE node.uuid <> N.uuid
     AND node.topic = N.topic            -- coarse but cheap; matches research-06 dedupe convention
     AND node.created_at < N.created_at - duration('PT1H')   -- no self-/burst-supersession
     AND node.superseded_at IS NULL      -- don't supersede an already-superseded node
     AND score >= 0.88                   -- candidate similarity floor
   - LIMIT 3.
   - If 0 candidates → return (no detection).

2. LLM judgment (local Gemma, single call):
   Prompt the warm model with:
     - N.text (the new observation)
     - For each candidate C: C.text + C.uuid + cosine score
   Ask for STRICT output:
     VERDICT: <NONE | CONTRADICTS:<uuid> | REFINES:<uuid> | INVALIDATES:<uuid>>
     CONFIDENCE: <0.0–1.0>
     REASON: <one sentence, ≤500 chars>

3. Action on positive verdict:
   - Only fire if CONFIDENCE >= 0.6 (tunable; log first 50 for tuning).
   - Write SUPERSEDES edge with supersede_kind = lowercase(verdict word).
   - Stamp old.superseded_at + increment old.supersede_count.
   - Update state.lastSupersedeAt = Date.now().
   - At most ONE edge per consolidate (the highest-confidence verdict if model returns multiple; the prompt forces single-target by construction).
```

### 2.3 The judge prompt (sketch — actual wording for §6 implementation)

```
You wrote a new observation. You are now reviewing whether it disagrees with
one of your earlier observations on the same topic.

NEW OBSERVATION:
  <N.text>

EARLIER OBSERVATIONS (most similar first):
  [1] uuid=<C1.uuid> (cos=<score>): <C1.text>
  [2] uuid=<C2.uuid> (cos=<score>): <C2.text>
  [3] uuid=<C3.uuid> (cos=<score>): <C3.text>

If the NEW observation materially disagrees with, refines, or invalidates
exactly ONE of the earlier ones, respond:

  VERDICT: <CONTRADICTS|REFINES|INVALIDATES>:<uuid-of-that-one>
  CONFIDENCE: <your confidence 0.0–1.0 that this is a real disagreement>
  REASON: <one sentence explaining what changed>

If none of them disagree (they are merely related, or they say the same thing
in different words), respond:

  VERDICT: NONE
  CONFIDENCE: 1.0
  REASON: <one sentence; e.g. "Same finding, paraphrased.">

Output nothing else.
```

The strict-output format is the same pattern research-06 §8.4 uses for `FOLLOW_UP:` lines — proven parsable.

---

## 3. Calibration: queryable on demand

**Decision:** no `:Calibration` audit node. Calibration is answerable in a single Cypher because (a) the relevant signal — supersede count per observation — is denormalized as `supersede_count` and `superseded_at`, (b) `confidence` has a range index, (c) the corpus is small (≤10k observations within 6 months at 840/day cap).

### 3.1 The calibration query

```cypher
// Confidence-calibration buckets for :HeartbeatObservation
// "Of observations Gemma rated at confidence X, what fraction were later superseded?"
WITH [0.0, 0.2, 0.4, 0.6, 0.8, 1.01] AS edges
MATCH (o:HeartbeatObservation)
WHERE o.confidence IS NOT NULL
  AND o.created_at < datetime() - duration('P3D')   -- give time for contradiction to appear
WITH edges, o,
     [i IN range(0, size(edges) - 2)
        WHERE o.confidence >= edges[i] AND o.confidence < edges[i + 1]
        | i][0] AS bucket_idx
WITH edges, bucket_idx,
     count(*) AS total,
     count(CASE WHEN o.superseded_at IS NOT NULL THEN 1 END) AS superseded
RETURN
  toString(edges[bucket_idx]) + '–' + toString(edges[bucket_idx + 1]) AS confidence_bucket,
  total,
  superseded,
  round(toFloat(superseded) / total * 1000) / 10.0 AS supersede_pct
ORDER BY confidence_bucket;
```

**Reading the output (well-calibrated case):**

```
confidence_bucket | total | superseded | supersede_pct
0.0–0.2           |   12  |     8      |    66.7
0.2–0.4           |   34  |    14      |    41.2
0.4–0.6           |   78  |    21      |    26.9
0.6–0.8           |  152  |    18      |    11.8
0.8–1.01          |  240  |    11      |     4.6
```

Monotonically decreasing supersede_pct as confidence rises → Gemma is well-calibrated. Inversions, flat lines, or U-shapes are the signal to retrain the judge prompt or add a confidence-floor on writes.

### 3.2 Why not a `:Calibration` node

- Calibration is an aggregate question; the underlying data is what's authoritative. A stored aggregate decays the moment a new supersedes is written.
- Storage cost of recomputing on demand: a single bucketed aggregation over ~10k nodes with an index on `confidence` — sub-100ms at expected scale. Verified by precedent: research-06 §4 synthesis query has similar shape and ran in <50ms during the 06 design phase.
- Calibration of `:Pattern.confidence` works with the same query — swap `:HeartbeatObservation` for `:Pattern` and `'P3D'` for `'P7D'` (patterns superseded less often, need longer window). Symmetric, no extra schema.

### 3.3 Companion diagnostic queries (for the design doc — Bear may want to run)

```cypher
// Recent supersessions with full provenance (the "what just got revised" view)
MATCH (new:Observation)-[r:SUPERSEDES]->(old:Observation)
WHERE r.created_at > datetime() - duration('P7D')
RETURN new.uuid, old.uuid, r.supersede_kind, r.judge_confidence, r.reason,
       new.confidence AS new_conf, old.confidence AS old_conf, r.created_at
ORDER BY r.created_at DESC
LIMIT 25;

// Weak supersessions worth auditing (low judge confidence — false-positive candidates)
MATCH ()-[r:SUPERSEDES]->()
WHERE r.judge_confidence < 0.7
RETURN r.reason, r.judge_confidence, r.created_at
ORDER BY r.judge_confidence ASC
LIMIT 20;
```

---

## 4. Cypher migration scripts

Run these via cypher-shell against the `gemma-chat-memory` database. All idempotent.

### 4.1 Schema migration (one shot)

```cypher
-- Edge indexes on :SUPERSEDES
CREATE INDEX supersedes_created_at IF NOT EXISTS
  FOR ()-[r:SUPERSEDES]-() ON (r.created_at);

CREATE INDEX supersedes_judge_confidence IF NOT EXISTS
  FOR ()-[r:SUPERSEDES]-() ON (r.judge_confidence);

-- Denormalized markers for fast calibration
CREATE INDEX observation_superseded_at IF NOT EXISTS
  FOR (o:Observation) ON (o.superseded_at);

CREATE INDEX observation_confidence IF NOT EXISTS
  FOR (o:Observation) ON (o.confidence);

-- Symmetric for :Pattern (used in §6 future)
CREATE INDEX pattern_superseded_at IF NOT EXISTS
  FOR (p:Pattern) ON (p.superseded_at);

CREATE INDEX pattern_confidence IF NOT EXISTS
  FOR (p:Pattern) ON (p.confidence);
```

### 4.2 Application-side write pattern (illustrative — Claude Code will implement)

```cypher
// Inside runConsolidate, after the new Observation is committed.
// Parameters: $newUuid, $oldUuid, $reason, $detectionMethod, $judgeConfidence,
//             $supersedeKind, $tickId
MATCH (newO:Observation {uuid: $newUuid})
MATCH (oldO:Observation {uuid: $oldUuid})
WHERE oldO.superseded_at IS NULL                 -- guard: don't re-supersede
MERGE (newO)-[r:SUPERSEDES]->(oldO)
ON CREATE SET
  r.created_at = datetime(),
  r.reason = $reason,
  r.detection_method = $detectionMethod,
  r.judge_confidence = $judgeConfidence,
  r.supersede_kind = $supersedeKind,
  r.tick_id = $tickId
SET oldO.superseded_at = datetime(),
    oldO.supersede_count = coalesce(oldO.supersede_count, 0) + 1
RETURN newO.uuid AS new_uuid, oldO.uuid AS old_uuid, r.supersede_kind AS kind;
```

The `MERGE` on `(newO)-[r:SUPERSEDES]->(oldO)` makes the write idempotent against accidental retries. The `WHERE oldO.superseded_at IS NULL` guard makes the old-observation update single-shot.

### 4.3 Rollback (in case Tier 1.4 needs to be withdrawn)

```cypher
-- Drop indexes (data preserved; only the read paths are removed)
DROP INDEX supersedes_created_at IF EXISTS;
DROP INDEX supersedes_judge_confidence IF EXISTS;
DROP INDEX observation_superseded_at IF EXISTS;
DROP INDEX observation_confidence IF EXISTS;
DROP INDEX pattern_superseded_at IF EXISTS;
DROP INDEX pattern_confidence IF EXISTS;

-- If we need to remove all SUPERSEDES edges + denormalized markers (destructive)
-- ⚠️ ONLY run if Bear explicitly approves.
-- MATCH ()-[r:SUPERSEDES]->() DELETE r;
-- MATCH (o:Observation) REMOVE o.superseded_at, o.supersede_count;
-- MATCH (p:Pattern) REMOVE p.superseded_at, p.supersede_count;
```

---

## 5. Implementation notes for Claude Code

### 5.1 Hook site in `src/main/heartbeat.ts`

- **Where:** new helper `await runContradictionCheck(observationUuid, observationText, topic, embedding, tickUuid, model, signal)` called at the **very end of `runConsolidate`**, after the `runCypher` write that creates the Observation (currently L1014–L1042), and **before** the function returns its `ConsolidateOutcome`.
- **Failure semantics:** contradiction check is **best-effort**. If the prefilter query errors, the LLM call times out, or the parser fails, log + continue. A failed contradiction check must NEVER fail the consolidate-tick that produced a valid Observation. Wrap the whole helper in `try { ... } catch (e) { console.warn(`[heartbeat] contradiction-check skipped: ${e}`) }`.
- **Reuse `embedTexts` / `runCypher` / `collectStream`** — no new infra.

### 5.2 `HeartbeatState` additions (`src/shared/types.ts`)

```ts
export interface HeartbeatState {
  // ... existing fields ...

  /** Tier 1.4: ms timestamp of last SUPERSEDES write (any kind). */
  lastSupersedeAt?: number

  /** Tier 1.4: rolling 24h count of SUPERSEDES edges Gemma wrote. */
  supersedesLast24h?: number
}
```

Both updated inline after a successful supersede write. `supersedesLast24h` is computed lazily — on each contradiction-check that fires, evict-and-recount from an in-memory ring buffer (same pattern as Patch 40's `primaryGoalLedger`).

### 5.3 Operator-visible surface (gauge)

Single line in the existing Heartbeat panel, next to the Pattern count:

> **Revisions (24h): N** — _last 12m ago_

Click-through later (out of scope for Tier 1.4): a "revisions log" view that runs the §3.3 query and renders the most recent supersessions with `reason` and both observation texts side by side. **Defer to Tier 1.5** — the gauge is enough for now to confirm the loop is firing.

### 5.4 Parser

Three-line block matching the strict-output spec in §2.3. Same robustness rules as Patch 40's `parseConsolidateOutput` / `parseReviewOutput`:
- Be strict about the VERDICT enum.
- Treat any parse failure as `VERDICT: NONE` (fail-safe — never fire a SUPERSEDES from garbled output).
- Cap REASON at 500 chars (truncate, don't reject).

### 5.5 Telemetry to log (no DB writes)

Per contradiction check, console.log a single structured line:
```
[heartbeat][supersede] tick=<tickUuid> candidates=<n> verdict=<NONE|...> judge_conf=<x> fired=<true|false>
```

This is the raw material for empirically tuning the `0.88` similarity floor and `0.6` judge-confidence floor after the first 50 checks. No DB persistence — operator/dev reads the log.

---

## 6. Symmetry: `:Pattern` SUPERSEDES `:Pattern`

Already ratified in research-06 §7.4. Tier 1.4 makes it operational by:
- The same `[:SUPERSEDES]` edge type works on `(:Pattern)→(:Pattern)`.
- Same property contract.
- **Detection trigger:** inline at end of `runReview` (heartbeat.ts L1250+), AFTER the new Pattern is written, mirroring §2.1.
- **Cost:** review-ticks fire every 20th heartbeat, so volume is ~1/40 of consolidate-tick volume. Cheap.

Implementing pattern-side detection in Tier 1.4 is optional — Bear may want to ship observation-side first, validate the calibration query produces meaningful buckets, then add pattern-side as Tier 1.4.1. The schema supports both; only the wiring differs.

**Recommendation:** ship observation-side first. Pattern volume (1 today, ~10/week at steady state) won't produce meaningful contradictions for weeks; observation volume (~840/day at cap) will exercise the loop on day one.

---

## 7. Risks & things to verify

| # | Risk | Mitigation in this design | Track / verify by |
|---|---|---|---|
| 1 | **Self-judgment bias.** Same Gemma 4 model that wrote N is judging whether N contradicts C. Worst case: she rarely disagrees with herself; supersede_count stays near 0; calibration is meaningless. | None inside Tier 1.4 — this is the binding-MLX-rule cost. The §5.5 telemetry will surface this within 50 checks (if fired-rate is <2%, raise it). | Operator: after first week, run `MATCH ()-[r:SUPERSEDES]->() RETURN count(r)`; if <5/week with >100 consolidates/day, escalate prompt or threshold. |
| 2 | **False-positive contradictions.** Two observations on the same topic that say compatible things in different framings — judge calls it CONTRADICTS. Pollutes calibration. | `judge_confidence` is stored per edge; §3.3 query surfaces weak supersessions for audit; calibration query can be re-run with `WHERE r.judge_confidence >= 0.8` filter. | Operator review pass after first 20 supersessions. |
| 3 | **Latency added to every consolidate.** Vector prefilter (~30ms) + Gemma judgment (~300–800ms) = +0.3–1.0s per probe. | Bounded by single-call budget; wrapped in try/catch so it can never fail the parent tick. Cadence backstop (research-06 §8.5) still holds. | Log judge-call wall time per check; if p95 >1.5s, defer to async post-write task. |
| 4 | **Pre-existing observations have no `superseded_at` property.** Calibration query treats them as not-superseded (correct), but if any were *actually* contradicted historically that signal is lost. | Acceptable. Tier 1.4 is forward-looking. The 39 existing observations are a tiny baseline; calibration becomes meaningful at ~200+ observations regardless. | None — design accepts this limitation. |
| 5 | **`topic =` equality is brittle.** Different consolidates may normalize topic strings slightly differently → candidate set shrinks to zero. | Topic normalization is already enforced (research-06 §3 anti-pattern 3 — lowercase, ≤80 chars, strip). Pre-flight: after schema migration, run `MATCH (o:HeartbeatObservation) RETURN o.topic, count(*) ORDER BY count(*) DESC LIMIT 20;` to confirm clean topic vocabulary. | Operator: run before enabling the hook. |
| 6 | **Write-amplification on `:SUPERSEDES` rel index.** Two new edge indexes + two new node-property updates per supersede write. At observed rates (~5–10 supersessions/day expected) this is trivial. | Documented. Reassess at Tier 2 if volume jumps. | Monitor — re-check at first Tier 2 design pass. |
| 7 | **Pattern-supersede precedent is from a different graph.** Partnership KG's Patch 39→37 lineage was hand-authored, not auto-detected; auto-detection is novel here. | Acknowledged. Observation-side rollout in Tier 1.4 is the safer first surface; Pattern-side follows once observation-side behaves well. | Sequence: ship observation-side, watch a week, then enable pattern-side. |

---

## Provenance + decision lineage

- **Schema + detection design:** neo4j-kg-architect agent, 2026-05-24. Will be persisted as ADR-20260524-tier1.4-supersedes-calibration in `~/.claude/agent-memory/neo4j-kg-architect/decisions/` after Bear ratifies.
- **Conforms to:**
  - ADR-20260516 (voyage-3-large @ 1024d cosine, no mixing).
  - research-05 (base `:Observation` / `:Pattern` schema).
  - research-06 §§1–7 (heartbeat learning loop schema, SUPERSEDES on Pattern).
  - karpathy-principles (no speculative abstractions; calibration is queryable not materialized).
- **Extends research-06 by:** adding the auto-detection mechanism that research-06 §7.4 left as a convention; adding the calibration signal that research-06 deferred to a "later patch when calibration lands."
- **Binding-rule compliance:**
  - No new MLX model loads — judge reuses warm Gemma.
  - No mixing of embedding models — reuses `observation_embedding` (voyage-3-large).
  - No frontier-model calls — all local.
  - No writes to partnership KG — `gemma-chat-memory` only.
