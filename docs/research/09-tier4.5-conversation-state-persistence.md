---
title: 09 — Tier 4.5 — Conversation-state persistence (PSV + ToM + Adaptation, cross-session)
authors:
  - neo4j-kg-architect agent (schema + edges + Cypher + write-helper sketches)
  - Claude Code on gemma-chat (implementation hooks — to author after Bear ratifies)
  - Bear / Daryl Lantz (operator, approval + binding principles)
target_graph: gemma-chat-memory on bolt://localhost:7687
target_db_kernel: Neo4j Enterprise 2025.10.1 (per precedent docs 05/06/07/08)
embedding_model: voyage-3-large @ 1024d cosine (ADR-20260516; used selectively — see §3)
status: DESIGN — ready for Bear review. Schema migration in §6 is idempotent.
date: 2026-05-25
related:
  - docs/research/05-neo4j-voyageai-rag-design.md (base schema + voyage-3-large @ 1024d cosine)
  - docs/research/06-patch40-heartbeat-learning-loop.md (HeartbeatTick / Observation / Insight conventions)
  - src/shared/psv.ts (DEFAULT_PSV, selectStrategy, shiftPSV — Patch 61)
  - src/main/tom.ts (UserMentalModel analyzer — currently in-memory + NDJSON only)
  - src/main/index.ts (handleChat — adaptation read site, write site for this tier)
---

# 09 — Tier 4.5 — Conversation-state persistence

**Persist `:ConversationState` (mutable, one per conversation), `:UserMentalModel` (append-only, one per ToM firing), and `:PSVState` (append-only, one per shifted-PSV computation) to `gemma-chat-memory` so Tier 4 survives restart and becomes cross-session signal.**

---

## TL;DR

- **Three new labels.** `:ConversationState` is the hub (mutable). `:UserMentalModel` and `:PSVState` are append-only leaves, both edge-anchored to their `:ConversationState`. UMM → PSVState is also linked so we can answer "which UMM drove this shift" without a graph join through the hub.
- **Edges:** `(:ConversationState)-[:HAS_UMM]->(:UserMentalModel)`, `(:ConversationState)-[:HAS_PSV_STATE]->(:PSVState)`, and `(:UserMentalModel)-[:DROVE_SHIFT]->(:PSVState)`. The third is the only non-hub-spoke edge; it earns its place because adaptation provenance is a first-class query (§7.2).
- **Embeddings: NO at this tier.** `:UserMentalModel.knowledge_gap` and `:ConversationState.open_threads` are tempting but neither has a query today that needs semantic recall. Adding embeddings now means a voyage-3-large round-trip on every chat turn — a real latency tax for speculative recall. Defer; revisit when Tier 4.8 (per-user distillation) is scoped (§3).
- **Write cadence:** 1 `:ConversationState` upsert + 1 `:UserMentalModel` insert + 1 `:PSVState` insert per chat turn after the first. ~3 writes/turn. At Bear's usage rates this is well under index-bloat territory (§8).
- **Rapport arc:** stored as `rapport_arc_avg` (rolling mean over the conversation's UMMs) AND `rapport_arc_peak` (high-water mark). Both are cheap to maintain on upsert; both answer different questions ("is this conversation warm overall?" vs "did we ever connect?"). Keep both.
- **`open_threads`:** stored as a string array on `:ConversationState`. Append-only within a conversation. No embedding for now. Updates happen in handleChat when Gemma's response defers a user question (detection logic is a separate concern; this tier just makes the storage available).
- **No partnership-KG cross-references.** Per scope: this is `gemma-chat-memory` only.

---

## 1. Architectural decisions (with the alternatives I rejected)

### 1.1 Hub-and-spoke vs full mesh

| Approach | Pros | Cons | Verdict |
|---|---|---|---|
| **Pure hub-and-spoke:** every leaf links only to `:ConversationState` | Simplest. One edge per leaf write. | "Which UMM drove which PSVState?" requires matching on `source_umm_uuid` property, not edge traversal. Adaptation provenance is one of the top-3 queries this tier exists to serve. | Reject — provenance is core. |
| **Full mesh:** also `(UMM)-[:OCCURRED_AT_TURN]->(PSVState)`, `(PSVState)-[:NEXT]->(PSVState)`, etc. | Many queries become pure traversals. | 5+ edges per turn. Index/edge-count growth gets expensive quickly. Most of those edges have no current query. | Reject — Karpathy: no speculative edges. |
| **Hub-and-spoke + one provenance edge** (`UMM-[:DROVE_SHIFT]->PSVState`) | Adaptation provenance is a direct traversal. Everything else stays cheap. | Slightly more code in `writePSVState` (it has to look up the UMM node, not just store the uuid as a property). | **Accept.** |

We also keep `source_umm_uuid` as a property on `:PSVState` for the case where the UMM node hasn't been written yet (race-free in our single-process Electron writer, but defensive). The edge is the queryable contract; the property is the audit trail.

### 1.2 `:ConversationState` mutability strategy

`:ConversationState` is the only mutable node in this tier. Options considered:

- **A: Mutate in place.** `MERGE (cs:ConversationState {conversationId}) SET cs.turn_count = cs.turn_count + 1, cs.last_turn_at = datetime()`. Simple. Loses history of intermediate states.
- **B: Versioned nodes.** Each turn creates a new `:ConversationState` node, chained `[:NEXT_STATE]`. Bitemporal. Heavy.
- **C: Mutate in place + rely on `:UserMentalModel`/`:PSVState` append-only stream for history.**

**Choose C.** The history is in the leaves. `:ConversationState` is a rolled-up view; rebuilding it from the leaves is a single Cypher query (§7.3). No need to version the hub.

### 1.3 Rapport arc representation

`rapport_level` is in `[0..1]` per UMM. "Rapport arc" can mean three things:

- The *trajectory* (sequence over time) — already captured in the `:UserMentalModel` stream.
- The *summary* — needed for fast read at conversation resume.

Store TWO summary numbers on `:ConversationState`:
- `rapport_arc_avg: float` — running mean. Updated by `upsertConversationState` (incremental mean formula, no full re-scan).
- `rapport_arc_peak: float` — max ever observed. `GREATEST(coalesce(cs.rapport_arc_peak, 0.0), $new)`.

Both answer real questions; both are O(1) to maintain. Drop the median / EWMA / etc. — speculative.

---

## 2. Schema additions

### 2.1 `:ConversationState` (mutable, one per conversation)

| Property | Type | Req? | Notes |
|---|---|---|---|
| `conversationId` | string | **yes** | Stable id minted by the chat app. Uniqueness constraint. |
| `started_at` | datetime | **yes** | Set on first write only (`ON CREATE SET`). |
| `last_turn_at` | datetime | **yes** | Updated every turn. |
| `turn_count` | int | **yes** | Increments by 1 each turn. Defaults 0 on create. |
| `current_strategy` | string | **yes** | Enum `'mirror' \| 'complement' \| 'goal'`. The strategy chosen for the most recent shift. |
| `last_user_emotion` | string | no | The most recent UMM's `user_emotion`. Cheap denormalization for resume-read. |
| `rapport_arc_avg` | float | **yes** | Running mean over UMMs. Default 0.0. |
| `rapport_arc_peak` | float | **yes** | Max ever seen. Default 0.0. |
| `open_threads` | string[] | **yes** | Append-only within the conversation. Each entry is a short string (one deferred question / topic). Default `[]`. Cap at 32 entries to bound size; oldest dropped on overflow (logged). |

**No `embedding` on this node.** Even `open_threads` doesn't earn it yet — there's no "find conversations with similar open threads" query in scope.

### 2.2 `:UserMentalModel` (append-only, one per ToM firing)

| Property | Type | Req? | Notes |
|---|---|---|---|
| `uuid` | string | **yes** | App-minted UUIDv4. Uniqueness constraint. |
| `conversationId` | string | **yes** | Denormalized for fast filter without hub join. Composite index with `at`. |
| `at` | datetime | **yes** | `datetime()` at write. |
| `user_emotion` | string | **yes** | Free-string today (analyzer doesn't enum-constrain). Indexed. |
| `emotion_intensity` | float | **yes** | `[0..1]`. |
| `user_intention` | string | **yes** | Free-string. |
| `knowledge_gap` | string | no | May be empty. ≤500 chars (truncate at write). |
| `rapport_level` | float | **yes** | `[0..1]`. |
| `analyzer_confidence` | float | **yes** | `[0..1]`. |
| `message_text` | string | **yes** | The user's message, truncated to ≤1000 chars at write. Stored verbatim so we can re-analyze if the prompt changes. |

**No embedding.** See §3.

### 2.3 `:PSVState` (append-only, one per shifted-PSV computation)

| Property | Type | Req? | Notes |
|---|---|---|---|
| `uuid` | string | **yes** | App-minted UUIDv4. Uniqueness constraint. |
| `conversationId` | string | **yes** | Denormalized; composite index with `at`. |
| `at` | datetime | **yes** | `datetime()` at write. |
| `strategy` | string | **yes** | `'mirror' \| 'complement' \| 'goal'`. |
| `source_umm_uuid` | string | **yes** | The UMM that drove this shift. Also reified as `[:DROVE_SHIFT]` edge. |
| `openness` | float | **yes** | All 5 Big Five traits as separate floats. |
| `conscientiousness` | float | **yes** | |
| `extraversion` | float | **yes** | |
| `agreeableness` | float | **yes** | |
| `neuroticism` | float | **yes** | |
| `self_awareness` | float | **yes** | All 5 Goleman EI traits as separate floats. |
| `self_regulation` | float | **yes** | |
| `motivation` | float | **yes** | |
| `empathy` | float | **yes** | |
| `social_skill` | float | **yes** | |

Storing the 10 floats as named properties (not a map/JSON blob) lets us query "average agreeableness over 30 days" directly in Cypher (§7.4) without unpacking.

### 2.4 Edges

| Edge | Direction | Cardinality | Purpose |
|---|---|---|---|
| `(:ConversationState)-[:HAS_UMM]->(:UserMentalModel)` | hub → leaf | 1 cs → N umm | Stream membership. |
| `(:ConversationState)-[:HAS_PSV_STATE]->(:PSVState)` | hub → leaf | 1 cs → N psv | Stream membership. |
| `(:UserMentalModel)-[:DROVE_SHIFT]->(:PSVState)` | umm → psv | 1 → 1 | Adaptation provenance. Earns its place via §7.2. |

No `[:NEXT]` chains. No reverse edges. If we want "next UMM" we order by `at`.

---

## 3. Embedding decision (no, for now)

Tempting embedding targets:
- `:UserMentalModel.knowledge_gap` — "find past gaps about Cypher" sounds nice.
- `:ConversationState.open_threads` — "find conversations with similar open threads" sounds nice.

**Why I'm saying no at this tier:**

1. **No query that needs it exists today.** Tier 4 just shipped; the operator queries on its persistence are structural (strategy distribution, emotion-this-week, agreeableness drift). All §7 queries are structural, not similarity.
2. **Latency tax is real.** voyage-3-large is a network call. Adding 1 embed/turn on `knowledge_gap` adds latency to the post-chat write path. Even moved off the critical path it costs API quota for speculative recall.
3. **Index bloat.** A 1024d vector index on a high-volume label (one per turn) grows fast. Cheaper to add later than to remove later.
4. **Tier 4.8 (per-user preference distillation) is the natural moment.** If 4.8 wants "find me times Bear was frustrated about Cypher specifically," that's when embedding earns its place. At that point we know the query shape and can pick the right field. Adding it now is guessing.

**What I'd embed if forced to pick one:** `:UserMentalModel.knowledge_gap` — it's the only field where free-text + semantic-search is plausibly useful for Gemma's future "I notice I keep failing to explain X" introspection. But again: defer.

**Karpathy check:** does the schema *preclude* future embedding? No. `CREATE VECTOR INDEX umm_knowledge_gap_embedding FOR (u:UserMentalModel) ON u.knowledge_gap_embedding ...` adds a property + index without rewriting anything.

---

## 4. Write semantics

### 4.1 Per-turn write sequence (in handleChat, after the response is composed)

```
1. ToM analyzer produces UMM             → writeUserMentalModel(umm, conversationId) → uuid
2. selectStrategy(umm) → strategy
3. shiftPSV(base, strategy, umm) → psv   → writePSVState(psv, strategy, ummUuid, conversationId) → uuid
4. upsertConversationState(conversationId, { turn_count++, last_turn_at, current_strategy: strategy,
                                              last_user_emotion: umm.user_emotion,
                                              rapport: umm.rapport_level,        // for arc maintenance
                                              new_open_thread?: string })
```

Order matters: UMM must exist before PSVState's `[:DROVE_SHIFT]` edge can be MERGE'd. Step 4 (upsert) runs last so it reflects the just-written turn.

### 4.2 `:ConversationState` upsert (incremental rapport arc)

The arc summary must update without a full re-scan. Incremental mean formula:

```
new_avg = old_avg + (new_value - old_avg) / new_count
```

Done inline in the Cypher (§6.3 helper).

### 4.3 Open-threads handling

`open_threads` accumulation logic (detecting that Gemma deferred a question) lives in handleChat — out of scope for this tier. This tier exposes the storage: `upsertConversationState({ new_open_thread: 'how does X work' })` appends; if length > 32, drop the oldest entry and log.

### 4.4 Race conditions

Electron main process is single-threaded for these writes. No concurrent writers per conversation. The uniqueness constraint on `conversationId` is belt-and-suspenders.

---

## 5. Cypher migration (idempotent — Bear runs via cypher-shell)

```cypher
// ── 5.1 Constraints (uniqueness)
CREATE CONSTRAINT cs_conversationId_unique IF NOT EXISTS
  FOR (cs:ConversationState) REQUIRE cs.conversationId IS UNIQUE;

CREATE CONSTRAINT umm_uuid_unique IF NOT EXISTS
  FOR (u:UserMentalModel) REQUIRE u.uuid IS UNIQUE;

CREATE CONSTRAINT psv_uuid_unique IF NOT EXISTS
  FOR (p:PSVState) REQUIRE p.uuid IS UNIQUE;

// ── 5.2 Range / composite indexes (query-driven; one per §7 query that filters)
// "UMMs in this conversation, ordered in time" + "UMMs this week"
CREATE INDEX umm_conv_at IF NOT EXISTS
  FOR (u:UserMentalModel) ON (u.conversationId, u.at);

CREATE INDEX umm_at IF NOT EXISTS
  FOR (u:UserMentalModel) ON (u.at);

CREATE INDEX umm_user_emotion IF NOT EXISTS
  FOR (u:UserMentalModel) ON (u.user_emotion);

// "PSV history in this conversation" + "PSV drift over time"
CREATE INDEX psv_conv_at IF NOT EXISTS
  FOR (p:PSVState) ON (p.conversationId, p.at);

CREATE INDEX psv_at IF NOT EXISTS
  FOR (p:PSVState) ON (p.at);

// "Recent conversations" rollup
CREATE INDEX cs_last_turn_at IF NOT EXISTS
  FOR (cs:ConversationState) ON (cs.last_turn_at);
```

No text indexes (no LIKE/CONTAINS queries in scope). No vector indexes (per §3).

---

## 6. Write-helper sketches (TypeScript)

These are sketches — Claude Code on gemma-chat will implement against the existing Neo4j driver wrapper (whatever pattern §5/§6 of research-05 already established).

### 6.1 `writeUserMentalModel`

```ts
import { randomUUID } from 'node:crypto';
import type { UserMentalModel } from '../shared/types';

export async function writeUserMentalModel(
  umm: UserMentalModel,
  conversationId: string,
  messageText: string,
): Promise<{ uuid: string }> {
  const uuid = randomUUID();
  const params = {
    uuid,
    conversationId,
    user_emotion: umm.user_emotion,
    emotion_intensity: clamp01(umm.emotion_intensity),
    user_intention: umm.user_intention,
    knowledge_gap: (umm.knowledge_gap ?? '').slice(0, 500),
    rapport_level: clamp01(umm.rapport_level),
    analyzer_confidence: clamp01(umm.analyzer_confidence),
    message_text: messageText.slice(0, 1000),
  };
  await runCypher(`
    MERGE (cs:ConversationState {conversationId: $conversationId})
      ON CREATE SET cs.started_at = datetime(), cs.turn_count = 0,
                    cs.rapport_arc_avg = 0.0, cs.rapport_arc_peak = 0.0,
                    cs.open_threads = [], cs.current_strategy = 'mirror',
                    cs.last_turn_at = datetime()
    CREATE (u:UserMentalModel {
      uuid: $uuid, conversationId: $conversationId, at: datetime(),
      user_emotion: $user_emotion, emotion_intensity: $emotion_intensity,
      user_intention: $user_intention, knowledge_gap: $knowledge_gap,
      rapport_level: $rapport_level, analyzer_confidence: $analyzer_confidence,
      message_text: $message_text
    })
    MERGE (cs)-[:HAS_UMM]->(u)
  `, params);
  return { uuid };
}
```

### 6.2 `writePSVState`

```ts
import type { PSV } from '../shared/psv';

export async function writePSVState(
  psv: PSV,
  strategy: 'mirror' | 'complement' | 'goal',
  sourceUmmUuid: string,
  conversationId: string,
): Promise<{ uuid: string }> {
  const uuid = randomUUID();
  await runCypher(`
    MATCH (cs:ConversationState {conversationId: $conversationId})
    MATCH (u:UserMentalModel {uuid: $sourceUmmUuid})
    CREATE (p:PSVState {
      uuid: $uuid, conversationId: $conversationId, at: datetime(),
      strategy: $strategy, source_umm_uuid: $sourceUmmUuid,
      openness: $openness, conscientiousness: $conscientiousness,
      extraversion: $extraversion, agreeableness: $agreeableness,
      neuroticism: $neuroticism,
      self_awareness: $self_awareness, self_regulation: $self_regulation,
      motivation: $motivation, empathy: $empathy, social_skill: $social_skill
    })
    MERGE (cs)-[:HAS_PSV_STATE]->(p)
    MERGE (u)-[:DROVE_SHIFT]->(p)
  `, { uuid, sourceUmmUuid, conversationId, strategy, ...psv });
  return { uuid };
}
```

Uses `MATCH` (not `MERGE`) for `cs` and `u` — both must exist (the UMM was just written in 6.1, and the upsert in 6.1 created the `cs`). If either is missing, fail loudly: that's a real bug, not a data race.

### 6.3 `upsertConversationState`

```ts
export interface UpsertConvFields {
  current_strategy?: 'mirror' | 'complement' | 'goal';
  last_user_emotion?: string;
  rapport_observation?: number;       // appends to running mean + updates peak
  new_open_thread?: string;           // appends if absent; trims to 32
}

export async function upsertConversationState(
  conversationId: string,
  fields: UpsertConvFields,
): Promise<void> {
  await runCypher(`
    MERGE (cs:ConversationState {conversationId: $conversationId})
      ON CREATE SET cs.started_at = datetime(), cs.turn_count = 0,
                    cs.rapport_arc_avg = 0.0, cs.rapport_arc_peak = 0.0,
                    cs.open_threads = [], cs.current_strategy = 'mirror'
    SET cs.last_turn_at = datetime(),
        cs.turn_count = cs.turn_count + 1,
        cs.current_strategy = coalesce($current_strategy, cs.current_strategy),
        cs.last_user_emotion = coalesce($last_user_emotion, cs.last_user_emotion)
    // Incremental mean for rapport, only if a new observation was supplied
    FOREACH (_ IN CASE WHEN $rapport_observation IS NULL THEN [] ELSE [1] END |
      SET cs.rapport_arc_avg = cs.rapport_arc_avg
                                + ($rapport_observation - cs.rapport_arc_avg) / cs.turn_count,
          cs.rapport_arc_peak = CASE
                                  WHEN $rapport_observation > cs.rapport_arc_peak
                                    THEN $rapport_observation
                                  ELSE cs.rapport_arc_peak
                                END
    )
    // Append open_thread if non-null and not already present; trim to 32 (oldest dropped)
    FOREACH (_ IN CASE WHEN $new_open_thread IS NULL OR $new_open_thread IN cs.open_threads
                       THEN [] ELSE [1] END |
      SET cs.open_threads = (cs.open_threads + $new_open_thread)[-32..]
    )
  `, {
    conversationId,
    current_strategy: fields.current_strategy ?? null,
    last_user_emotion: fields.last_user_emotion ?? null,
    rapport_observation: fields.rapport_observation ?? null,
    new_open_thread: fields.new_open_thread ?? null,
  });
}
```

Note: turn_count increments BEFORE the incremental-mean division, which gives the correct denominator (1 for the first observation, 2 for the second, etc.).

---

## 7. Operator-facing queries

### 7.1 Last N conversations rollup

```cypher
MATCH (cs:ConversationState)
RETURN cs.conversationId AS conv,
       cs.started_at     AS started,
       cs.last_turn_at   AS last,
       cs.turn_count     AS turns,
       cs.current_strategy AS strategy,
       cs.last_user_emotion AS last_emotion,
       cs.rapport_arc_avg  AS rapport_avg,
       cs.rapport_arc_peak AS rapport_peak,
       size(cs.open_threads) AS open_threads_n
ORDER BY cs.last_turn_at DESC
LIMIT 20;
```

Strategy distribution across recent conversations:

```cypher
MATCH (cs:ConversationState)
WHERE cs.last_turn_at > datetime() - duration({days: 7})
RETURN cs.current_strategy AS strategy, count(*) AS n
ORDER BY n DESC;
```

### 7.2 "All UMMs where I appeared frustrated this week" (+ which PSV shift each drove)

```cypher
MATCH (u:UserMentalModel)
WHERE u.user_emotion CONTAINS 'frust'
  AND u.at > datetime() - duration({days: 7})
OPTIONAL MATCH (u)-[:DROVE_SHIFT]->(p:PSVState)
RETURN u.at, u.conversationId, u.user_emotion, u.emotion_intensity,
       u.message_text, p.strategy, p.agreeableness, p.empathy
ORDER BY u.at DESC;
```

The `[:DROVE_SHIFT]` edge is what makes this readable as a single hop.

### 7.3 Agreeableness drift over the last 30 days

```cypher
MATCH (p:PSVState)
WHERE p.at > datetime() - duration({days: 30})
RETURN date(p.at) AS day,
       avg(p.agreeableness) AS avg_agreeable,
       min(p.agreeableness) AS min_agreeable,
       max(p.agreeableness) AS max_agreeable,
       count(*) AS n
ORDER BY day;
```

The same shape works for any of the 10 traits. This is exactly the "is Gemma drifting?" query Tier 4.8 will build on.

### 7.4 Reconstruct `:ConversationState` from leaves (sanity check / repair)

```cypher
MATCH (cs:ConversationState {conversationId: $conv})-[:HAS_UMM]->(u:UserMentalModel)
WITH cs, count(u) AS umm_count, avg(u.rapport_level) AS avg_rapport,
     max(u.rapport_level) AS peak_rapport
RETURN cs.turn_count = umm_count          AS turn_count_ok,
       abs(cs.rapport_arc_avg - avg_rapport) < 0.001 AS avg_ok,
       abs(cs.rapport_arc_peak - peak_rapport) < 0.001 AS peak_ok;
```

Useful when investigating an arc that "feels wrong."

---

## 8. Risks / verification

| Risk | Severity | Mitigation / what to verify |
|---|---|---|
| **Write volume.** 3 writes/turn (1 upsert + 2 inserts + 2 MERGE edges). At ~100 turns/day = 300 writes/day. Trivial for Neo4j. Verify p95 write latency stays < 50ms over the first 2 weeks. | Low | Add a `query_ms` log on the write path (mirror the pattern from `:SentinelFinding.query_ms`). |
| **Index bloat.** 7 indexes added. Each composite index has cost on write. Verify via `SHOW INDEXES YIELD name, populationPercent, lastRead` after a week to confirm they're actually being used. Drop any with `lastRead IS NULL`. | Low | Re-run §7 queries with `PROFILE` to confirm index hits, not full scans. |
| **`open_threads` growth.** Capped at 32 entries per conversation. Verify the cap fires. | Low | Add a unit test for the 32→33 trim behavior in the upsert helper. |
| **Edge-count growth.** 3 edges per turn (`HAS_UMM`, `HAS_PSV_STATE`, `DROVE_SHIFT`). At 100 turns/day = 300 edges/day = ~110k edges/year. Within healthy range for a personal KG. | Low | No action needed; revisit if turn rate jumps 10×. |
| **UMM `user_emotion` is a free string.** Today's analyzer outputs vary ('frustrated' / 'frustration' / 'mildly frustrated'). §7.2 uses `CONTAINS 'frust'` to paper over this; doesn't scale. | Medium | Out of scope for this tier — but flag Tier 4.6 to normalize the emotion vocabulary (controlled list or LLM-canonicalized post-write). |
| **Rapport-arc incremental mean drift.** Floating-point accumulation can drift over thousands of turns. The §7.4 reconstruction query catches it. | Low | Run §7.4 as a Tier 1.6 sentinel (composes cleanly — `gemma-chat-memory` has Sentinels live per research-08). |
| **`conversationId` collision across users.** Single-user app today, so not a concern. If the schema ever spans users, add `userId` as a composite-key component. | Low | No action needed today. |
| **No `[:DROVE_SHIFT]` if writePSVState's MATCH on UMM fails.** Today writePSVState runs immediately after writeUserMentalModel in the same handleChat call — if the UMM didn't write, that's a bug to surface, not to paper over. The `MATCH` (vs `MERGE`) is the explicit fail-loud. | Low | Verify error path in integration test. |

---

## 9. Open questions for Bear

1. **Does `conversationId` already exist on any existing `:Observation` / `:HeartbeatTick` / other node on `gemma-chat-memory`?** This design assumes `:ConversationState.conversationId` is the *first* authoritative home for that identifier. If it's already on `:Observation`, we may want an optional `(:ConversationState)-[:INCLUDES_OBSERVATION]->(:Observation)` edge later — but I deliberately did NOT add it in this tier (no current query, Karpathy).
2. **Open-threads detection.** This tier exposes `open_threads` storage but does NOT decide *when* a thread gets appended. Is that handleChat logic ("Gemma's response contained 'I'll come back to that' / didn't directly answer the question") on the table for this tier, or is it explicitly a future patch?
3. **Sentinel composition.** Should §7.4 (reconstruction check) be wired in as a Tier 1.6 sentinel now, or wait until we've observed drift in the wild? I lean: wire it now, severity `warn`, cadence weekly — it's nearly free.

---

## 10. Composition with prior tiers

- **Tier 1.6 Sentinels:** §7.4 reconstruction is a natural sentinel. §7.3 ("agreeableness drift") could also be one — alert if 30-day avg moves > 0.10 from DEFAULT_PSV.
- **Tier 1.4 SUPERSEDES:** No interaction. Different label space (Decisions vs ConversationState).
- **Patch 40 heartbeat:** No interaction. `:HeartbeatTick` and `:ConversationState` are independent. Deliberately so.
- **Tier 4.8 (per-user distillation, future):** The §7.3 query shape is precisely the input. If 4.8 wants embeddings, `knowledge_gap_embedding` is added then; the schema doesn't preclude it.
