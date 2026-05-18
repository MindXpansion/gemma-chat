# 05 — Neo4j 5.x + voyageai RAG Memory Tier Design

> **Research document — design only, no code yet.**
> Purpose: define the architecture, schema, embeddings, retrieval, ingestion, and operational footprint of the Phase 2.7 RAG memory tier for Gemma Chat.
> Target: 100 GB of user-curated content, all Gemma 4 variants (E2B / E4B / 26B-MoE / 31B-Dense) as queriers, E4B default.
> Owner: Bear (Daryl Lantz) · MindXpansion.ai
> Author: Claude (Opus 4.7, 1M context, neo4j-kg-architect agent) · 2026-05-17
> Status: DRAFT — implementation-ready. No Cypher executed against `kg-arch-enterprise`. All schema decisions are proposals for Bear's review.

---

## TL;DR — Top architectural decisions (under 300 words)

1. **Isolation:** New database `gemma-chat-memory` inside the existing `kg-arch-enterprise` Neo4j Desktop Enterprise DBMS (`bolt://localhost:7687`). Multi-database is an Enterprise feature; one DBMS, two databases, hard isolation, shared heap. **Do not** spin up a separate DBMS (port-collision risk per the 2026-05-16 incident logged in `~/.claude/agent-memory/neo4j-kg-architect/`). **Do not** use Aura (latency, cost, and the data is local-private by design).
2. **Schema:** A small, opinionated ontology — `:Document → :Chunk` for the corpus, `:Conversation → :Turn → :Summary` for chat memory, `:Workspace → :Observation → :Pattern` for AIOS surfaces, `:Citation` for cross-references. Vector embeddings live on `:Chunk`, `:Summary`, `:Observation`, and `:Image`. Every node carries `created_at` and `valid_from`/`valid_to` for temporal grounding (RISE).
3. **Vector index:** Neo4j 5.x **native** HNSW vector indexes (vector-2.0 provider, up to 4096 dims). No Qdrant/Weaviate sidecar — one DB, one backup, one query plane. At 100 GB the projected vector count (~5–20 M chunks) is well within native-index limits.
4. **Embeddings:** **voyage-3-large @ 1024 dim** as the prose default; **voyage-code-3 @ 1024 dim** for code; **voyage-multimodal-3 @ 1024 dim** for images and image-bearing PDFs. All three share a 1024-dim namespace so one vector index per node label is enough. Honest cost: ingesting 100 GB of prose with voyage-3-large ≈ **$4,500 one-time** (≈25 B tokens × $0.18/M).
5. **Retrieval:** Default = **vector → rerank-2 → optional 1-hop Cypher expansion → top-K with citations**. Hybrid BM25+vector via Neo4j's full-text index is the v2 default; pure vector is the v1 default for shipping speed.
6. **Tool surface:** Four ToolSpecs — `aios.recall`, `aios.cite`, `aios.search_kg`, `aios.index` — all using the §10.2.1 Zod-shaped `tool()` helper. `aios.search_kg` is read-only Cypher with a parameter allowlist.
7. **AIOS boundary:** This DB is **Gemma Chat's own**. It **does not** read or write `kg-arch-enterprise`'s default database (the partnership KG). Cross-references happen at the handoff-file level, never at the Cypher level.

Doc path: `/Users/bear/Development/gemma-chat/docs/research/05-neo4j-voyageai-rag-design.md`

---

## Table of contents

1. Decision 1 — Database isolation
2. Decision 2 — Schema and ontology
3. Decision 3 — Vector index strategy
4. Decision 4 — Embedding strategy with voyageai
5. Decision 5 — Hybrid retrieval
6. Decision 6 — Ingestion pipeline
7. Decision 7 — Tool API for Gemma
8. Decision 8 — Bootstrapping (zero → useful)
9. Decision 9 — Operational concerns
10. Decision 10 — AIOS integration boundaries
11. Open questions for Bear
12. Phased rollout map
13. Appendix A — Worked retrieval example end-to-end
14. Appendix B — Source citations

---

## 1. Decision 1 — Database isolation

**Recommendation:** Create a new database named `gemma-chat-memory` inside the existing `kg-arch-enterprise` Neo4j Desktop Enterprise DBMS (`bolt://localhost:7687`, Enterprise 2025.10.1).

**Cypher to execute (against `system` database, Bear approval required):**

```cypher
CREATE DATABASE `gemma-chat-memory` IF NOT EXISTS WAIT;
SHOW DATABASES;
```

### Why this and not the alternatives

| Option | Verdict | Reasoning |
|---|---|---|
| **New DB in `kg-arch-enterprise`** | **CHOSEN** | Enterprise edition supports unlimited databases per DBMS; full isolation of data, indexes, and constraints; shared JVM heap and page cache (cheaper than two DBMSes); single backup target via `neo4j-admin database dump gemma-chat-memory`; zero risk to the partnership KG (different database name = different store files) |
| Separate DBMS on a new port | Rejected | Port management is fragile — Bear's filesystem-truth doc already enumerates three Neo4j instances on this machine (7687, 7689, 7693). Adding a fourth invites the 2026-05-16 port-binding ambiguity incident to recur. Also wastes heap (each JVM = ~2 GB minimum) |
| Default DB of `kg-arch-enterprise` (i.e., share the partnership graph) | **REFUSED** | Hard violation of the integration philosophy in research doc 04. Pollutes the partnership KG with chunks, summaries, and Gemma-generated observations. Backup/restore becomes entangled. Schema migrations on one app risk breaking the other. The §10 boundary table in research 04 explicitly forbids autonomous writes to `kg-arch-enterprise`'s partnership graph |
| Neo4j Aura (managed cloud) | Rejected | Latency: ~50–200 ms round-trip kills interactive recall vs ~1–5 ms on localhost. Cost: $65–$2,000+/mo for the 100 GB tier. Privacy: the corpus is "Bear's documents, books, code repos" — local-private by design. Aura forbids the `system` admin commands we'd want. Multi-database is not available on Aura per Neo4j docs |
| Separate vector DB (Qdrant/Weaviate/Chroma) alongside Neo4j | Rejected for v1 | Two stores, two backups, two ops surfaces. The hybrid retrieval (§5) is cleaner when the graph and the vectors are co-located — `db.index.vector.queryNodes()` + `MATCH (n)-[:CITES]->(m)` in one Cypher statement. Native Neo4j vector at 5–20 M vectors is well within its proven scale. Revisit only if recall@10 < 0.85 at the 100 GB ceiling |

### Pre-flight checks before the `CREATE DATABASE`

1. Verify Enterprise edition: `CALL dbms.components() YIELD name, versions, edition` must return `edition = 'enterprise'`. The filesystem-truth doc says it is; verify anyway.
2. Confirm the partnership KG dump exists at `/Users/bear/claude-tracks/Knowledge_Base/migrations/2026-05-16-pre-desktop-migration.dump`. If anything goes sideways with the multi-DB setup, this is the rollback anchor.
3. Capture a fresh dump of the default `kg-arch-enterprise` database **before** creating `gemma-chat-memory`. Two-second insurance against any cross-database transaction-log surprise.

### Connection string the Gemma Chat process uses

```
NEO4J_URI=bolt://localhost:7687
NEO4J_USER=gemma-chat
NEO4J_PASSWORD=<from electron safeStorage>
NEO4J_DATABASE=gemma-chat-memory
```

Create a dedicated Neo4j user (`gemma-chat`) with rights only on `gemma-chat-memory`:

```cypher
// Against `system` database:
CREATE USER `gemma-chat` SET PASSWORD '<generated>' CHANGE NOT REQUIRED;
CREATE ROLE `gemma-chat-rw`;
GRANT ALL ON DATABASE `gemma-chat-memory` TO `gemma-chat-rw`;
DENY ALL ON DATABASE `neo4j` TO `gemma-chat-rw`;     // partnership KG default
DENY ALL ON DATABASE `system` TO `gemma-chat-rw`;
GRANT ROLE `gemma-chat-rw` TO `gemma-chat`;
```

This is **defense in depth**. Even if the Gemma agent emits a malicious or hallucinated Cypher statement targeting the partnership KG, the auth layer refuses it. The Electron `safeStorage` encrypts the password at rest (same pattern as the fal.ai API key in research doc 02).

---

## 2. Decision 2 — Schema and ontology

**Recommendation:** A small, opinionated, append-friendly schema. Eight node labels, ten relationship types, every node temporally grounded. Designed so a single Cypher pattern (`MATCH (q)-[:CITES|MENTIONS|SUMMARIZES*1..2]->(target)`) gets you from any conversation utterance to any source-of-truth chunk in ≤2 hops.

### 2.1 Node labels

| Label | Purpose | Key properties | Has embedding? |
|---|---|---|---|
| `:Document` | A source-of-truth file (PDF, MD, code file, image, web page) | `uri`, `sha256`, `mime`, `title`, `bytes`, `created_at`, `indexed_at`, `source_path`, `acl` | No |
| `:Chunk` | A retrievable slice of a Document | `uuid`, `text`, `token_count`, `chunk_index`, `chunk_strategy`, `embedding_model`, `embedding`, `created_at` | **Yes** (1024-dim) |
| `:Image` | An image (own node, not just a Chunk) — supports multimodal recall | `uuid`, `mime`, `width`, `height`, `path`, `caption`, `embedding`, `created_at` | **Yes** (1024-dim, multimodal) |
| `:Conversation` | A Gemma Chat conversation (= one workspace) | `uuid`, `workspace_id`, `title`, `model_id`, `started_at`, `closed_at`, `operator` | No |
| `:Turn` | One user-or-assistant message in a conversation | `uuid`, `role`, `text`, `token_count`, `created_at` | Optional (only embed if turn ≥ N tokens) |
| `:Summary` | A distilled summary of a window of turns | `uuid`, `text`, `window_start`, `window_end`, `created_at`, `embedding` | **Yes** |
| `:Workspace` | The Gemma Chat per-conversation workspace (1:1 with Conversation but exposed separately for AIOS observations to attach) | `id`, `path`, `created_at` | No |
| `:Observation` | An AIOS observation (per the `.aios/observations.md` convention in research 04) | `uuid`, `text`, `created_at`, `embedding` | **Yes** |
| `:Pattern` | An accumulated pattern that crossed the 3-data-point threshold | `uuid`, `kind` (successful/anti), `name`, `text`, `created_at`, `evidence_count` | **Yes** |
| `:Entity` | An optional reified entity (person, project, concept) for ERKG-style dedup | `uuid`, `kind`, `canonical_name`, `aliases`, `created_at` | Optional |

Eight core labels + `:Entity` for entity-resolution work later. The `:Entity` label is **deliberately optional** for v1; introducing it without an ER engine (Senzing or equivalent) creates duplicate-proliferation. Defer until the corpus is big enough to matter (>10 GB indexed).

### 2.2 Relationship types

| Relationship | From → To | Meaning |
|---|---|---|
| `[:HAS_CHUNK]` | `:Document → :Chunk` | Document contains chunk; preserves chunk order via `chunk_index` |
| `[:HAS_IMAGE]` | `:Document → :Image` | PDF/HTML doc embedded image extracted as own node |
| `[:NEXT]` | `:Chunk → :Chunk`, `:Turn → :Turn` | Sequential ordering (for sliding-window retrieval) |
| `[:HAS_TURN]` | `:Conversation → :Turn` | Conversation contains turn |
| `[:SUMMARIZES]` | `:Summary → :Turn` (many) | Summary covers a window of turns |
| `[:OBSERVED_IN]` | `:Observation → :Conversation` | Observation came from this conversation |
| `[:SUPPORTS]` | `:Observation → :Pattern` | Observation contributes to a pattern's evidence (the 3-data-point chain) |
| `[:CITES]` | `:Turn → :Chunk`, `:Summary → :Chunk` | Chat reference to source chunk — the retrieval-grounding edge |
| `[:MENTIONS]` | `:Chunk → :Entity`, `:Turn → :Entity` | Entity mention (when `:Entity` is enabled) |
| `[:DERIVED_FROM]` | `:Document → :Document` | Provenance for transformed docs (e.g., PDF page → cleaned text) |

### 2.3 Constraints and indexes

**Uniqueness constraints (mandatory before MERGE):**

```cypher
CREATE CONSTRAINT document_uri_unique IF NOT EXISTS
  FOR (d:Document) REQUIRE d.uri IS UNIQUE;
CREATE CONSTRAINT document_sha256_unique IF NOT EXISTS
  FOR (d:Document) REQUIRE d.sha256 IS UNIQUE;
CREATE CONSTRAINT chunk_uuid_unique IF NOT EXISTS
  FOR (c:Chunk) REQUIRE c.uuid IS UNIQUE;
CREATE CONSTRAINT image_uuid_unique IF NOT EXISTS
  FOR (i:Image) REQUIRE i.uuid IS UNIQUE;
CREATE CONSTRAINT conversation_uuid_unique IF NOT EXISTS
  FOR (c:Conversation) REQUIRE c.uuid IS UNIQUE;
CREATE CONSTRAINT turn_uuid_unique IF NOT EXISTS
  FOR (t:Turn) REQUIRE t.uuid IS UNIQUE;
CREATE CONSTRAINT summary_uuid_unique IF NOT EXISTS
  FOR (s:Summary) REQUIRE s.uuid IS UNIQUE;
CREATE CONSTRAINT workspace_id_unique IF NOT EXISTS
  FOR (w:Workspace) REQUIRE w.id IS UNIQUE;
CREATE CONSTRAINT observation_uuid_unique IF NOT EXISTS
  FOR (o:Observation) REQUIRE o.uuid IS UNIQUE;
CREATE CONSTRAINT pattern_uuid_unique IF NOT EXISTS
  FOR (p:Pattern) REQUIRE p.uuid IS UNIQUE;
```

**Range indexes for time-window queries:**

```cypher
CREATE INDEX chunk_created_at IF NOT EXISTS FOR (c:Chunk) ON (c.created_at);
CREATE INDEX turn_created_at IF NOT EXISTS FOR (t:Turn) ON (t.created_at);
CREATE INDEX observation_created_at IF NOT EXISTS FOR (o:Observation) ON (o.created_at);
CREATE INDEX summary_created_at IF NOT EXISTS FOR (s:Summary) ON (s.created_at);
CREATE INDEX conversation_started_at IF NOT EXISTS FOR (c:Conversation) ON (c.started_at);
```

**Full-text indexes for hybrid retrieval (v2 — see §5):**

```cypher
CREATE FULLTEXT INDEX chunk_text_ft IF NOT EXISTS
  FOR (c:Chunk) ON EACH [c.text];
CREATE FULLTEXT INDEX summary_text_ft IF NOT EXISTS
  FOR (s:Summary) ON EACH [s.text];
```

**Vector indexes:** see §3.

### 2.4 Temporal grounding (RISE compliance)

Per `rise-framework.md` and the §2.5 temporal-grounding mandate in research 04, every retrievable node carries:

- `created_at` — when the node was created in this DB (always required).
- `valid_from` / `valid_to` — optional bitemporal pair for documents that have an intrinsic effective period (e.g., a contract, a policy, a dated meeting note).
- `source_modified_at` — for `:Document`, the upstream file's mtime. Enables incremental reindex (§6).

Default Cypher pattern for temporal queries (cited in agent tool prompts):

```cypher
MATCH (c:Chunk)
WHERE c.created_at >= datetime($since) AND c.created_at < datetime($until)
RETURN c LIMIT 100;
```

### 2.5 Why not GRAPH TYPE (Neo4j 2026.02+)?

The new declarative `GRAPH TYPE` schema enforcement is attractive but the running DBMS is **2025.10.1** (Enterprise). `GRAPH TYPE` requires the 2026.02+ kernel. Capture as a Phase 2.7+ refactor candidate; for v1 use the constraints-and-indexes pattern above.

---

## 3. Decision 3 — Vector index strategy

**Recommendation:** Neo4j 5.x **native HNSW vector indexes**, one per embedded node label, all 1024-dim, cosine similarity. No external vector DB.

### 3.1 Why native and not Lucene/external

| Option | Verdict | Reasoning |
|---|---|---|
| **Neo4j native vector index (HNSW)** | **CHOSEN** | Vector-2.0 provider (Neo4j 5.18+) supports up to 4096 dims; HNSW gives sub-100 ms top-10 at 5–20 M vectors on the local Mac. One query plane: vector + Cypher graph in the same statement. One backup. Production-proven |
| Lucene-backed vector | Rejected | Slower than HNSW above ~100k vectors; legacy path; native is the documented forward direction |
| External (Qdrant local, Weaviate local, Chroma) | Rejected for v1 | Two stores, two backups, two memory budgets, two ops surfaces. The whole point of co-locating with the graph is post-retrieval Cypher (`SUPPORTS`, `CITES`, `NEXT` traversal) in one statement |
| External (Pinecone, Voyage's hosted vector store) | Rejected | Latency (network), cost ($), privacy (corpus is private) |

### 3.2 Index definitions

```cypher
// Prose / general chunks
CREATE VECTOR INDEX chunk_embedding IF NOT EXISTS
FOR (c:Chunk)
ON c.embedding
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};

// Image (multimodal) embeddings
CREATE VECTOR INDEX image_embedding IF NOT EXISTS
FOR (i:Image)
ON i.embedding
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};

// Conversation summaries (long-term memory)
CREATE VECTOR INDEX summary_embedding IF NOT EXISTS
FOR (s:Summary)
ON s.embedding
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};

// AIOS observations (workspace-derived insights)
CREATE VECTOR INDEX observation_embedding IF NOT EXISTS
FOR (o:Observation)
ON o.embedding
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};

// Patterns (3-data-point distillations)
CREATE VECTOR INDEX pattern_embedding IF NOT EXISTS
FOR (p:Pattern)
ON p.embedding
OPTIONS { indexConfig: {
  `vector.dimensions`: 1024,
  `vector.similarity_function`: 'cosine'
}};
```

**Five vector indexes, one per embedded label, all same dimension.** Same dim means one embedding model output works across all of them (modulo content type — code vs prose, see §4).

### 3.3 Dimension choice — why 1024

| Dim | Models that support it | Trade-off |
|---|---|---|
| **1024** | voyage-3-large, voyage-3, voyage-code-3, voyage-multimodal-3, voyage-4-*, voyage-multimodal-3.5 | **CHOSEN**: the natural meeting point. All five voyageai models we'll consider can produce 1024-dim. One index schema works across all of them |
| 512 | voyage-3-lite, voyage-4-* (Matryoshka), voyage-3-large (Matryoshka) | Half the storage and ~30% faster query, but quality penalty is real for prose retrieval at 100 GB scale |
| 2048 | voyage-3-large, voyage-4-* (Matryoshka), voyage-code-3 (Matryoshka) | Marginal recall@10 gain (~1–2 pp), 2× storage, slower index build. Not worth it |
| 256 | voyage-*-Matryoshka | Only for "preview-tier" or constrained-memory deployments |

**1024 is the sweet spot.** Matryoshka representation learning (built into voyage-3-large and voyage-4) means the same model can output 256 / 512 / 1024 / 2048 dims with graceful degradation — but we standardize on 1024 to avoid re-embedding if we later add lower-dim "quick scan" or higher-dim "premium" indexes.

### 3.4 Hardware sizing at 100 GB target

Assumptions for the projection:
- 100 GB of input → after parsing, ≈25 B tokens of indexable text (PDF/HTML/MD strip)
- Chunk size 512 tokens, ~25% overlap → effective ~640 tokens per stored chunk, ~640 chunk-overhead bytes (metadata + uuid + relationships) → **~40 M `:Chunk` nodes max**
- Realistic ceiling for a personal corpus: **5–20 M chunks** (Bear's "100 GB" likely includes binary attachments, images, dupes)

Per Neo4j docs and the GraphRAG manual, HNSW vector index sizing at 20 M × 1024-dim × float32:

- **Vectors on disk:** 20 M × 1024 × 4 bytes ≈ **80 GB** (`.vector_idx` file)
- **HNSW graph overhead:** ~30% of vector size → ~24 GB
- **Total index footprint:** ~104 GB for vectors alone
- **Plus node/relationship store:** at 20 M chunks + 1 M docs + ~50 M relationships, expect ~30 GB for the property store
- **Grand total disk:** **~135 GB** for the fully populated `gemma-chat-memory` database

**Heap and page cache (the live-memory levers):**

Neo4j's official sizing guidance: page cache should hold the store files + indexes (or a working set thereof) for hot performance. For Bear's Mac (assume 64 GB RAM):

```properties
# neo4j.conf — applied DBMS-wide (kg-arch-enterprise)
server.memory.heap.initial_size=8g
server.memory.heap.max_size=8g
server.memory.pagecache.size=32g
server.jvm.additional=--add-modules=jdk.incubator.vector   # required for HNSW perf
```

8 GB heap + 32 GB page cache = 40 GB resident for Neo4j. Leaves the rest for MLX (Gemma E4B alone wants 8–16 GB), Electron, etc.

**If the 100 GB corpus saturates page cache:** queries that hit the cold portion of the index degrade from ~10 ms to ~100 ms. Still acceptable for an interactive chat tool. The vector index has good locality (HNSW neighbors are spatially co-resident on disk) so cold-cache penalties are softer than for B-tree-only workloads.

### 3.5 Vector index quantization (future)

Neo4j 2026.04+ supports `vector.quantization: 'int8'` on vector indexes, cutting disk footprint by ~75% (1024 × 4 bytes → 1024 × 1 byte = 1 KB/vector) at a small recall cost. The current DBMS is 2025.10.1 — quantization is a Phase 3 upgrade candidate, not v1.

---

## 4. Decision 4 — Embedding strategy with voyageai

**Recommendation:** Three-model strategy by content type, all targeting 1024-dim:

| Content type | Model | Dim | Cost per 1M tokens |
|---|---|---|---|
| Prose / general text / chat turns / summaries | **voyage-3-large** | 1024 | **$0.18** |
| Code (source files, code blocks ≥10 lines) | **voyage-code-3** | 1024 | **$0.18** |
| Images (own + PDF-extracted) | **voyage-multimodal-3** | 1024 | text: $0.12 / **pixels: $0.60 per 1B px** |

(All three share the same 1024-dim vector space *structurally* — they can write to the same indexes — but they are **NOT interchangeable for similarity comparison**. A code embedding and a prose embedding are not in the same semantic manifold even though both are 1024 floats. We separate by node label and/or by tagging `:Chunk { embedding_model: 'voyage-code-3' }` and route at query time. See §5.)

### 4.1 Why these three models

**voyage-3-large for prose** — the published quality leader for English + multilingual general retrieval. The newer `voyage-4-large` ($0.12/M) and `voyage-4` ($0.06/M) are tempting and probably the right Phase 3 upgrade, but `voyage-3-large` has 6+ months of production track record, is what most existing community GraphRAG / RAG benchmarks compare to, and has a generous **200M-free-tokens** allowance is NOT applicable here (voyage-3-* is "older models, no free tier" per the voyageai pricing page). **voyage-4-large at $0.12/M for the same 1024-dim is the lower-cost alternative** and worth Bear's call (see §11 open questions).

**voyage-code-3 for code** — purpose-built for code retrieval, materially better than prose embeddings on code search (≈10–20 pp recall@10 in published benchmarks). Same $0.18/M as voyage-3-large. Same 1024-dim. No reason not to use it for code.

**voyage-multimodal-3 for images** — the only voyageai model that produces a unified text+image embedding space. Critical for "find the diagram about X" queries where the query is text but the target is an image inside a PDF. Pricing has a pixels component: $0.60 per 1 billion pixels processed. A typical 1024×768 image = 786,432 px = $0.00047. 100,000 images at that resolution ≈ $47. Cheap.

### 4.2 Why NOT mix more models

It is tempting to add `voyage-3-lite` for high-volume low-value content (e.g., every chat turn) to save 9× on cost ($0.02 vs $0.18). **Don't.** The pain isn't the embedding cost; it's the embedding-space fragmentation. Two models = two query embeddings per recall call = two `db.index.vector.queryNodes` calls = duplicated reranking. Pick three (prose / code / multimodal), tag each chunk with `embedding_model`, route queries by intent.

### 4.3 Honest cost projection for the 100 GB target

Assumption: 100 GB raw → ~25 B post-extraction tokens (typical PDF/HTML→text ratio of ~25%).

- **All prose with voyage-3-large @ $0.18/M:** 25,000 M × $0.18 / M = **$4,500** one-time embed cost.
- **All prose with voyage-4-large @ $0.12/M:** 25,000 M × $0.12 / M = **$3,000** one-time embed cost (better numbers; consider).
- **All prose with voyage-3-lite @ $0.02/M (quality penalty):** **$500** — *cheap but the wrong call for a "this is my permanent memory" corpus.*
- **All prose with voyage-4 @ $0.06/M (compromise):** **$1,500** — solid middle path.

Add code (assume 5 GB / ~1 B tokens of code) at $0.18/M = **$180**.
Add multimodal images (assume 200k images, avg 1 MP) at $0.60/B px = **$120**.

**Realistic total to fully embed 100 GB of mixed corpus with voyage-3-large: ~$4,800.**
**With voyage-4 default: ~$1,800.**

Recurring cost (just chat turns + observations being embedded as Bear uses the app): 1000 turns/day × 500 tokens/turn × 30 days = 15 M tokens/mo × $0.18/M = **$2.70/mo**. Trivial.

### 4.4 Rate limits and batching

From voyageai docs (Tier 1 — payment method added):

| Model | TPM | RPM |
|---|---|---|
| voyage-3-large, voyage-code-3 | 3 M | 2000 |
| voyage-4-large | 3 M | 2000 |
| voyage-4 | 8 M | 2000 |
| voyage-multimodal-3 | 2 M | 2000 |

At 3 M TPM, embedding the full 25 B token corpus single-tenant takes **25,000 M / 3 M = ~138 hours of pure pipe-time (~5.7 days)**. Not blocking — ingestion is a background activity. Tier 2 (≥$100 paid) doubles this; the $4,500 embed cost will push Bear into Tier 2 immediately, so realistic wall-clock is **~3 days** for a full reindex.

**Batching strategy:**
- Embed in batches of 128 chunks per HTTP call (voyageai supports up to 1000 inputs/call but 128 is the sweet spot — keeps individual request size manageable, allows clean retry on failure).
- Concurrency: 8 in-flight requests. At ~640 tokens/chunk × 128 chunks/batch × 8 batches = ~650k tokens in-flight → well under 3 M TPM.
- Exponential backoff on 429.
- Persistence: write each batch to Neo4j before requesting the next (avoids losing embedded-but-not-stored work on crash).

### 4.5 Embedding-model tagging on `:Chunk`

Every chunk node carries `embedding_model: 'voyage-3-large' | 'voyage-code-3' | 'voyage-multimodal-3'`. This makes future re-embedding (when voyageai releases voyage-5) trivially auditable: `MATCH (c:Chunk) WHERE c.embedding_model = 'voyage-3-large' RETURN count(c)` tells you the scope of the migration.

---

## 5. Decision 5 — Hybrid retrieval

**Recommendation (v1, shipping default):** **Pure vector → rerank-2 → optional Cypher 1-hop expansion**.
**Recommendation (v2, after metrics):** **Hybrid (vector + BM25 full-text) → external RRF → rerank-2 → Cypher expansion**.

### 5.1 The retrieval cascade (v1)

For an interactive chat tool, the retrieval cascade for a user query Q is:

1. **Intent route.** Cheap LLM classifier (or rule-based on Q's content) decides which embedding model to query: prose, code, or multimodal. Default: prose.
2. **Embed Q.** Single voyageai call, `input_type='query'` (voyageai accepts a query/document hint that materially improves quality).
3. **Vector ANN.** `CALL db.index.vector.queryNodes('chunk_embedding', 50, $queryEmbedding)` — fetch top-50 candidates.
4. **Rerank.** Top-50 → voyageai `rerank-2` with the original Q text + the 50 chunk texts. Take top-10.
5. **Optional 1-hop expansion.** For each of the top-10 chunks, fetch the surrounding chunks via `[:NEXT]` (±1) and the parent `:Document` metadata. This is what makes the "graph" part actually matter — chunks aren't islands.
6. **Citation packaging.** Return as `[{ chunk_uuid, document_uri, text, score, neighbors: [...] }, ...]`.

**Latency budget (interactive chat — target <2 s for retrieval):**
- Step 2: ~80 ms (voyageai embed call)
- Step 3: ~30 ms (HNSW top-50 on warm cache, 10 M chunks)
- Step 4: ~300 ms (voyageai rerank-2 on 50 docs)
- Step 5: ~10 ms (graph traversal on warm cache)
- Step 6: ~5 ms
- **Total: ~425 ms**. Comfortable.

### 5.2 Why pure vector first, not hybrid

For v1 simplicity. Pure vector + a strong reranker (`rerank-2`) is the documented best practice in voyageai's own RAG guidance and is what most production systems ship. BM25 hybrid adds:
- Another index to maintain (`chunk_text_ft`)
- Fusion logic (RRF or weighted) to externalize
- More query latency (~50 ms for the BM25 hit)
- And only ~3–5 pp recall@10 improvement on average prose retrieval

Worth it eventually, especially for queries with exact-string or proper-noun matches (e.g., function names, file paths). Ship v1 without it; add in v2 if metrics show a gap.

### 5.3 The hybrid v2 design (deferred)

When v2 is built, the recommended pattern (per the agent's anti-pattern card "**Hybrid retrieval architecture**"):

1. Vector ANN top-50 (as above)
2. BM25 full-text top-50 via `CALL db.index.fulltext.queryNodes('chunk_text_ft', $queryString)`
3. **External RRF fusion** in JS/TS (NOT inside Cypher — keeps the fusion auditable and tunable per query) → combined top-50
4. Rerank-2 → top-10
5. Cypher expansion → return with citations

Externalize the RRF because:
- Bear and Gemma may want different weights for different query types
- Multi-stage chains become easier when fusion is its own step in the code
- Governance (logging which sub-ranker contributed which result)

### 5.4 Reranker choice

`rerank-2` over `rerank-2-lite`:
- rerank-2 query token cap: 4000 (vs 2000 for lite) — comfortable for long queries
- rerank-2 query+doc cap: 16,000 tokens (vs 8000 for lite) — handles full-chunk reranking
- Cost: $0.05/M tokens (vs $0.02/M for lite). For a typical recall (50 chunks × 640 tokens = 32k tokens reranked per query, plus the query itself, call it 35k tokens), that is **$0.00175 per recall** with rerank-2 vs **$0.0007 per recall with rerank-2-lite**. Both negligible; the quality difference is non-negligible. Default to rerank-2.

### 5.5 GraphRAG vs simple RAG — when to escalate

The agent's "RAG vs GraphRAG routing" anti-pattern card says: treat them as complementary, route by query type. For Gemma Chat v1:

- **Single-hop factual** ("what does voyage-3-large dim?"): pure vector retrieval is enough.
- **Multi-hop reasoning** ("what did I decide about MLX subprocess restart, and why?"): vector retrieval + Cypher traversal to walk `:Observation -[:SUPPORTS]-> :Pattern` chains, optionally LazyGraphRAG-style.

For v1, **default to single-hop vector + 1-hop Cypher expansion** (cascade above). LazyGraphRAG-style community-detection iterative deepening is a Phase 3+ feature. Not needed at 100 GB; absolutely needed at 1 TB.

---

## 6. Decision 6 — Ingestion pipeline

**Recommendation:** Allowlist-gated, content-type-aware, semantic-where-possible, incremental.

### 6.1 The allowlist gate

**This mirrors the Phase 2.5 filesystem-approval pattern in research doc 03.** No path is indexed without Bear's explicit consent. Per-path-prefix approval, stored in:

```
userData/aios/rag-allowlist.json
```

Example:

```json
{
  "version": 1,
  "allowlist": [
    {
      "path": "/Users/bear/Documents/MindXpansion-Library",
      "approved_at": "2026-05-17T14:32:00Z",
      "include_globs": ["**/*.pdf", "**/*.md"],
      "exclude_globs": ["**/.git/**", "**/node_modules/**", "**/*.pem"],
      "max_file_mb": 100,
      "embedding_model_override": null
    },
    {
      "path": "/Users/bear/Development/gemma-chat",
      "approved_at": "2026-05-17T14:33:00Z",
      "include_globs": ["**/*.{ts,tsx,js,jsx,py,md}"],
      "exclude_globs": ["**/node_modules/**", "**/out/**", "**/.git/**"],
      "max_file_mb": 5,
      "embedding_model_override": "voyage-code-3"
    }
  ]
}
```

**No path is added without a UI confirmation modal.** Same UX pattern as the filesystem-write approval surface in research 03.

### 6.2 Content type routing

| File pattern | Parser | Chunker | Embedder |
|---|---|---|---|
| `*.md`, `*.txt`, `*.rst` | (none — read raw) | Semantic (markdown-headers-aware) → fallback to 512-token fixed | voyage-3-large |
| `*.pdf` | `pdf-parse` or `unstructured.io` local (text + image extraction) | Page-aware → semantic within page → 512-token fallback | text→voyage-3-large; images→voyage-multimodal-3 |
| `*.html`, `*.htm` | `cheerio` + readability extraction | Semantic (per major section) | voyage-3-large |
| `*.{ts,tsx,js,jsx,py,go,rs,...}` | Tree-sitter for function/class boundary detection | Function/class scope → fallback to 512-token | voyage-code-3 |
| `*.{png,jpg,jpeg,webp,gif}` | (none — pass bytes) | N/A (one chunk per image) | voyage-multimodal-3 |
| `*.json`, `*.yaml`, `*.toml` | JSON/YAML parse, flatten to text representation | 512-token fixed | voyage-3-large |
| `*.{docx,xlsx,pptx}` | `mammoth` / `xlsx` / `pptx-parser` | Section-aware | voyage-3-large (xlsx may need special handling) |

### 6.3 Chunking strategy

**Default: ~512 tokens per chunk with ~64-token (~12.5%) overlap. Semantic-boundary-aware where the parser supports it.**

Justification (per the agent's "Embedding/chunking strategy" anti-pattern card and NVIDIA's published benchmarks):
- **Page-level chunking** has the highest accuracy and lowest variance for PDF retrieval. For non-PDF: semantic (section-aware) is second-best.
- **Fixed 512-token chunks** are the universal fallback. ~512 hits a sweet spot — long enough for context, short enough that any single chunk fits comfortably in `rerank-2`'s 16k-token query+doc cap with room.
- **Overlap** prevents the "isolated chunk" problem at section boundaries. 12.5% is conservative; 25% works for high-recall tighter chunks but doubles index size.

**Contextual Embeddings (Anthropic) — Phase 2.7+ upgrade path:**

When the corpus matures, prepend per-chunk document-level context before embedding. Pseudocode:

```
for chunk in document.chunks:
  context = llm_summarize(f"Given the document '{document.title}': in 1-2 sentences, what is this chunk about?\n\n{chunk.text}")
  chunk.contextualized_text = f"{context}\n\n{chunk.text}"
  chunk.embedding = voyage.embed(chunk.contextualized_text)
```

This materially improves recall for chunks that lose meaning without document-level context (e.g., "It was 4.2%" — what was?). The Anthropic post uses prompt caching to keep cost reasonable. For v1, **skip this** — adds ~$50–$200 per 100 GB of LLM calls and delays shipping. Capture as v2.

### 6.4 Incremental indexing

Every `:Document` carries `sha256` and `source_modified_at`. The ingestion job's idempotency check:

```cypher
MATCH (d:Document {uri: $uri})
RETURN d.sha256 AS existing_sha, d.indexed_at AS indexed_at;
```

- If no match: full ingest.
- If match and `existing_sha != new_sha`: delete child `:Chunk` / `:Image` nodes, re-parse, re-chunk, re-embed.
- If match and `existing_sha == new_sha`: skip entirely.

**The expensive embedding call only happens when content actually changed.** This makes "re-scan my Documents folder" cheap after the initial bulk load.

For partial re-embed (only chunks whose text changed within a doc, not the whole doc): chunk-level sha256 too. Phase 2 optimization.

### 6.5 The transactional pattern

Use Cypher-native `CALL { ... } IN TRANSACTIONS OF N ROWS` for batched writes (the agent's catalog explicitly notes `apoc.periodic.iterate` is deprecated as of APOC 2026.04):

```cypher
UNWIND $chunks AS chunk_data
CALL {
  WITH chunk_data
  MATCH (d:Document {uri: chunk_data.doc_uri})
  CREATE (c:Chunk {
    uuid: chunk_data.uuid,
    text: chunk_data.text,
    token_count: chunk_data.token_count,
    chunk_index: chunk_data.chunk_index,
    chunk_strategy: chunk_data.chunk_strategy,
    embedding_model: chunk_data.embedding_model,
    embedding: chunk_data.embedding,
    created_at: datetime()
  })
  CREATE (d)-[:HAS_CHUNK]->(c)
} IN TRANSACTIONS OF 500 ROWS;
```

### 6.6 The ingestion process — runtime

A background worker in the Electron main process, NOT in the renderer. Steps:

1. Watch allowlist roots with `chokidar` (debounced 5 s).
2. On change: enqueue file path in a persistent SQLite queue (`userData/aios/ingest-queue.sqlite`).
3. Worker drains queue: parse → chunk → embed → write to Neo4j.
4. Throttle to keep voyageai TPM under 2 M (leave headroom for chat-time embeds).
5. UI surface: ingestion progress badge in the status bar; per-document last-indexed-at queryable.

---

## 7. Decision 7 — Tool API for Gemma

**Recommendation:** Four ToolSpec entries in `src/main/tools.ts`, following the §10.2.1 Vercel AI SDK v5 shape (`name`, `description`, `inputSchema` with Zod, `execute`).

The four tools cover the full retrieval surface: recall, search-graph, cite, and explicit index control.

### 7.1 `aios.recall`

```typescript
import { z } from 'zod';
import { tool } from './tool';

export const aiosRecall = tool({
  name: 'aios.recall',
  description:
    'Recall relevant information from your long-term memory (Neo4j RAG). ' +
    'Use this when the user asks about prior conversations, indexed documents, ' +
    'patterns, or any content you may have seen before. Returns up to top-K ' +
    'chunks with citations.',
  mode: 'both', // chat + code modes
  inputSchema: z.object({
    query: z.string().min(2).max(2000).describe('Natural-language query'),
    k: z.number().int().min(1).max(20).default(5)
      .describe('How many results to return after reranking'),
    intent: z.enum(['prose', 'code', 'multimodal', 'auto']).default('auto')
      .describe('Which embedding space to query; "auto" classifies'),
    since: z.string().datetime().optional()
      .describe('Optional ISO datetime — restrict to content created after this time'),
    workspace_scoped: z.boolean().default(false)
      .describe('If true, only recall from the current conversation/workspace'),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      chunk_uuid: z.string().uuid(),
      document_uri: z.string(),
      text: z.string(),
      score: z.number(),
      created_at: z.string().datetime(),
      neighbors: z.array(z.object({
        chunk_uuid: z.string().uuid(),
        text: z.string(),
      })).optional(),
    })),
    total_candidates: z.number().int(),
    latency_ms: z.number(),
  }),
  execute: async (args, ctx) => {
    // 1. Embed query via voyageai (intent-routed)
    // 2. Vector ANN top-50 via db.index.vector.queryNodes
    // 3. rerank-2 → top-k
    // 4. 1-hop NEXT expansion
    // 5. return shaped result
  },
});
```

**Example XML action emitted by Gemma:**

```xml
<action name="aios.recall">
  <query>What did I decide about MLX subprocess restart strategy?</query>
  <k>5</k>
  <intent>auto</intent>
</action>
```

### 7.2 `aios.cite`

```typescript
export const aiosCite = tool({
  name: 'aios.cite',
  description:
    'Re-fetch a specific chunk by its UUID — use after aios.recall to pull more ' +
    'context around a hit. Returns the full chunk plus its parent document metadata ' +
    'and ±2 neighboring chunks.',
  mode: 'both',
  inputSchema: z.object({
    chunk_uuid: z.string().uuid(),
    neighborhood: z.number().int().min(0).max(5).default(2)
      .describe('How many ±chunks to include via [:NEXT] traversal'),
  }),
  outputSchema: z.object({
    chunk: z.object({
      uuid: z.string().uuid(),
      text: z.string(),
      chunk_index: z.number().int(),
      created_at: z.string().datetime(),
    }),
    document: z.object({
      uri: z.string(),
      title: z.string(),
      mime: z.string(),
      indexed_at: z.string().datetime(),
    }),
    neighbors: z.array(z.object({
      chunk_uuid: z.string().uuid(),
      chunk_index: z.number().int(),
      text: z.string(),
    })),
  }),
  execute: async (args, ctx) => {
    // Single Cypher: MATCH chunk, doc, neighbors via [:NEXT*0..2]
  },
});
```

**Example XML:**

```xml
<action name="aios.cite">
  <chunk_uuid>0193f8b2-7c4d-7000-a000-000000000123</chunk_uuid>
  <neighborhood>2</neighborhood>
</action>
```

### 7.3 `aios.search_kg`

```typescript
export const aiosSearchKg = tool({
  name: 'aios.search_kg',
  description:
    'Run a read-only Cypher query against your memory graph. Use this when you need ' +
    'structural information that vector recall cannot provide (e.g., "what observations ' +
    'support pattern X?", "list all conversations from last week", "find the chunks ' +
    'that cite document Y"). MUST be read-only — write Cypher is rejected.',
  mode: 'both',
  inputSchema: z.object({
    cypher: z.string().min(8).max(4000)
      .describe('Read-only Cypher query (must start with MATCH/CALL/SHOW; cannot contain CREATE/MERGE/SET/DELETE/REMOVE/DROP)'),
    params: z.record(z.unknown()).default({})
      .describe('Named parameters for the query'),
    limit_hint: z.number().int().min(1).max(500).default(50),
  }),
  outputSchema: z.object({
    columns: z.array(z.string()),
    rows: z.array(z.record(z.unknown())),
    row_count: z.number().int(),
    truncated: z.boolean(),
  }),
  execute: async (args, ctx) => {
    // 1. Lint Cypher for write keywords (reject if found)
    // 2. Auto-append LIMIT if missing
    // 3. Run as the `gemma-chat-readonly` role (NOT gemma-chat-rw)
    // 4. Cap result rows at 500
  },
});
```

**Critical:** `aios.search_kg` uses a **separate Neo4j role** (`gemma-chat-readonly`, ACCESS-only) so the auth layer enforces read-only even if the lint misses something. Defense in depth.

**Example XML:**

```xml
<action name="aios.search_kg">
  <cypher>MATCH (p:Pattern {kind: 'successful'})&lt;-[:SUPPORTS]-(o:Observation) RETURN p.name, count(o) AS evidence ORDER BY evidence DESC LIMIT 10</cypher>
  <params>{}</params>
</action>
```

### 7.4 `aios.index`

```typescript
export const aiosIndex = tool({
  name: 'aios.index',
  description:
    'Request indexing of a file or directory path into long-term memory. The path ' +
    'must already be in the user-approved allowlist (configured in app settings) — ' +
    'this tool will fail with a clear message if not. Use sparingly; this is ' +
    'expensive (embedding cost + ingest time).',
  mode: 'both',
  inputSchema: z.object({
    path: z.string().min(1).describe('Absolute path to a file or directory'),
    recursive: z.boolean().default(true),
    force_reembed: z.boolean().default(false)
      .describe('If true, re-embed even if SHA256 matches existing index'),
  }),
  outputSchema: z.object({
    enqueued: z.boolean(),
    file_count: z.number().int(),
    estimated_tokens: z.number().int(),
    estimated_cost_usd: z.number(),
    queue_position: z.number().int(),
    reason_if_rejected: z.string().optional(),
  }),
  execute: async (args, ctx) => {
    // 1. Check path is in allowlist (rag-allowlist.json)
    // 2. Enumerate matching files
    // 3. Estimate token count (cheap, file-size heuristic)
    // 4. Enqueue in SQLite ingest queue
    // 5. Return summary
  },
});
```

**Example XML:**

```xml
<action name="aios.index">
  <path>/Users/bear/Documents/MindXpansion-Library/operations</path>
  <recursive>true</recursive>
</action>
```

### 7.5 Two more tools worth scoping (deferred to Phase 2.8)

- `aios.observe(text)` — already proposed in research doc 04 Increment 1. Writes to both `<workspace>/.aios/observations.md` AND creates an `:Observation` node in the RAG graph. Bridges file-based and graph-based memory.
- `aios.distill(conversation_id)` — runs the conversation-close distillation pass: summarize turns → `:Summary` node, check 3-data-point pattern threshold → maybe create `:Pattern` node, write `SESSION_HANDOFF_gemma_*.md`. Already specified in research doc 04 Increment 3; just gains the graph-write side here.

---

## 8. Decision 8 — Bootstrapping (zero → useful)

**Recommendation:** A 4-step bootstrap that proves the system works in <1 hour and gives Bear immediate value.

### 8.1 The "smallest meaningful corpus"

**The single best starter content:** the four existing Gemma Chat research docs themselves (~5000 lines total, ~50k tokens). 8¢ to embed. Indexed in 60 seconds. And it lets Bear test recall immediately with queries he knows the answers to, against content he wrote.

After that succeeds, the next escalations:

| Step | Corpus | Size | Embed cost | Time | Why this next |
|---|---|---|---|---|---|
| 1 | `/Users/bear/Development/gemma-chat/docs/` | ~200k tokens | ~$0.04 | 2 min | Smoke test. Bear knows this content cold |
| 2 | `/Users/bear/Skills/_readme_first_/` + `/Users/bear/.claude/rules/` | ~100k tokens | ~$0.02 | 1 min | The AIOS governance docs — high signal, immediate utility |
| 3 | `/Users/bear/claude-tracks/Knowledge_Base/` (SESSION_HANDOFF_*.md, ADRs, BEAR_PROFILE.md) | ~5M tokens | ~$1 | 30 min | Bear's accumulated session history — immediately useful for "what did we decide last week about X" |
| 4 | A first real chunk of "Bear's library" — pick **one** subject (e.g., `MindXpansion-Library/operations/`) | ~50M tokens | ~$10 | 4 hr | Proves scale before committing to the full 100 GB |
| 5+ | Full opt-in expansion per allowlist | up to 100 GB | up to ~$4,800 | days | Background |

### 8.2 The five acceptance tests for "the system works"

Before declaring v1 done, all five must pass:

1. **Smoke recall:** `aios.recall("What is voyage-3-large's dimension?")` returns the answer from THIS research doc with the cited chunk text.
2. **Self-reference:** `aios.recall("What does Bear say about the 30-minute rule?")` returns content from `persistence-discipline.md` after step 2 is indexed.
3. **Recency filter:** `aios.recall("decisions from this week", since="<7-days-ago>")` returns only recent docs.
4. **Graph traversal:** `aios.search_kg("MATCH (p:Pattern) RETURN p.name LIMIT 10")` works after at least 3 conversations + a distillation pass that produced a pattern.
5. **Citation:** Gemma's response includes inline citation tokens (e.g., `[chunk:0193f8b2...]`) that the renderer recognizes and turns into clickable links to the source.

If 1–5 all pass on Bear's machine with the seeded corpus from §8.1, the system is real.

---

## 9. Decision 9 — Operational concerns

### 9.1 Backup

**Daily dump cron (launchd, user agent at `~/Library/LaunchAgents/com.mindxpansion.gemma-chat.neo4j-backup.plist`):**

```bash
neo4j-admin database dump gemma-chat-memory \
  --to-path="/Users/bear/claude-tracks/Knowledge_Base/migrations/gemma-chat-memory/" \
  --overwrite-destination=true
```

Then rotate (keep 7 daily, 4 weekly, 12 monthly). Total backup footprint at 135 GB DB: ~300–500 GB on disk for a year of rotated dumps. Acceptable on a Mac with the existing T9 storage.

**Critical:** **STOP the DBMS or use online-backup before dumping** if `kg-arch-enterprise` is running. Neo4j 5.x supports online backup via `neo4j-admin database backup` (Enterprise feature). Use that, not offline dump, since the partnership KG must stay live for Claude Code.

```bash
# Online backup — does not require stopping the DBMS
neo4j-admin database backup gemma-chat-memory \
  --to-path="/Users/bear/claude-tracks/Knowledge_Base/migrations/gemma-chat-memory/" \
  --include-metadata=all
```

### 9.2 Reindexing cost when voyageai releases a new model

The painful one. When voyageai ships voyage-5 or some new SOTA model with different dimensions or substantially better quality, the full corpus may need re-embedding:

- Full 100 GB re-embed at current pricing: ~$4,800 (voyage-3-large) or ~$3,000 (voyage-4-large).
- Process can be incremental — embed the new model in parallel onto a sibling vector index (`chunk_embedding_v2`), run dual-recall during a comparison window, swap once metrics confirm improvement.
- The `embedding_model` property on every chunk makes this trivially scriptable: `MATCH (c:Chunk) WHERE c.embedding_model = 'voyage-3-large' RETURN c.uuid, c.text` → re-embed → `SET c.embedding = $new_vec, c.embedding_model = 'voyage-5'`.

**Annual reindexing budget recommendation:** plan for one re-embed per year (~$3–5k). Voyageai's model cadence is roughly that — voyage-3 in 2024, voyage-4 in 2025, voyage-5 likely late 2026.

### 9.3 Memory pressure

Already detailed in §3.4. Recap:
- DBMS heap: 8 GB
- DBMS page cache: 32 GB
- MLX/Electron/OS: rest of 64 GB
- If Bear's Mac is 32 GB: drop page cache to 16 GB, heap to 4 GB, accept colder vector queries (~100 ms p95 instead of ~30 ms)
- If Bear's Mac is 128 GB: pump page cache to 80 GB, heap to 16 GB; expect ~10 ms vector queries even at 100 GB

### 9.4 Disk space

- Source corpus: 100 GB (user's data, already on disk somewhere)
- Neo4j store + indexes: ~135 GB (§3.4)
- Backups: ~300–500 GB if keeping a year of rotated dumps
- voyageai cache (the per-chunk embeddings cached to disk before being written to Neo4j, just for safety): ~80 GB
- **Total Gemma-Chat-specific disk usage at full 100 GB target: ~500–700 GB**

A 2 TB external (T9 or successor) is comfortable. A 1 TB internal SSD is tight but workable if backups go to T9-1.

### 9.5 Monitoring

Three metrics to expose in the Gemma Chat UI (status-bar badges):

1. **Indexed corpus size** (`MATCH (c:Chunk) RETURN count(c)` updated nightly)
2. **Avg recall latency p95** (rolling 100-call window)
3. **voyageai spend this month** (sum of token counts × per-model rate)

---

## 10. Decision 10 — AIOS integration boundaries

This section re-states the integration constraints from research doc 04, sharpened by the schema and tools defined here.

### 10.1 What this DB does NOT touch

- **`kg-arch-enterprise` default database (the partnership KG):** never read, never written. The `gemma-chat` Neo4j user has `DENY ALL ON DATABASE neo4j`. The DBs share JVM heap and page cache, nothing else.
- **`/Users/bear/Skills/`:** read-only, optionally indexed via allowlist. Promoted patterns from Gemma Chat go through Bear, manually.
- **`/Users/bear/.intelligence_partner/`:** never touched.
- **`/Users/bear/.claude/agent-memory/`:** never touched.

### 10.2 How this DB INTERACTS with existing AIOS surfaces

- **Hindsight memory bank:** No direct integration in v1. If Bear wants chat content to land in Hindsight, the existing `SESSION_HANDOFF_gemma_*.md` mechanism is the bridge (research 04 §2.4). The handoff file gets summarized into Hindsight by Claude Code in a subsequent session — same pattern as everything else.
- **`.aios/observations.md` / `successful-patterns.md` / `anti-patterns.md`:** these `.md` files **remain the source of truth**. The graph nodes (`:Observation`, `:Pattern`) are a **searchable mirror**, not a replacement. Writes go to both: `.md` file (for human readability and Claude Code compatibility) AND graph node (for recall). On any divergence, the file wins.
- **Session handoffs:** the distillation step at conversation close (research 04 Increment 2) ALSO creates a `:Summary` node summarizing the conversation, embeds it, and links it via `[:SUMMARIZES]->(:Turn)` to the conversation's turns. Future `aios.recall("what did I do on May 17?")` can find the conversation directly.
- **Skill registry:** Skill `SKILL.md` files in `/Users/bear/Skills/` can be indexed into the RAG via the allowlist mechanism. This means Gemma can answer "what skills do I have for X?" via `aios.recall` — but it does not invoke them. Skill invocation is the existing tool-call surface (research 04 §2.2).

### 10.3 The cross-database read question

Bear may eventually want: "Gemma, what's in the partnership KG about [topic]?"

For v1: **No.** Cross-database queries (`USE neo4j MATCH (d:Decision) ...`) are technically possible from the `gemma-chat-readonly` role if granted ACCESS on the `neo4j` database, but:
- Schema drift risk (partnership KG schema is maintained by Claude Code; changes without warning)
- Confusion risk (recalled content from two namespaces with different conventions)
- The handoff bridge already solves this — Claude can summarize partnership KG content into handoff files Gemma can index

Capture as an open question for Bear (§11).

---

## 11. Open questions for Bear

1. **voyage-3-large vs voyage-4-large for prose default.** voyage-4-large is $0.12/M (vs $0.18/M) and benchmarks slightly better. The downside: it's newer, less production track record, and the 200M free-token tier is for "current models" which includes voyage-4-*. **Recommendation:** start with voyage-4-large for cost ($3,000 instead of $4,500 to embed 100 GB) and the free-tier bootstrap; document choice; reassess at v2.

2. **Embed Bear's whole 100 GB upfront, or grow into it?** $3,000–4,800 at once is real money. Alternative: bootstrap with steps 1–4 from §8.1 (~$10) and grow demand-driven from there. **Recommendation:** demand-driven. Don't pre-embed content Bear hasn't actually asked questions about.

3. **Should Gemma be able to read the partnership KG (`bolt://localhost:7687`, default `neo4j` database)?** Read-only, via a separate Neo4j role with `ACCESS`-only grant. Bear can pull partnership-KG context into Gemma chats. Risk: schema drift, confusion between which graph holds what. **Recommendation:** no in v1; revisit when a concrete use case appears.

4. **Hindsight write-through.** If a Gemma conversation produces something pattern-worthy, should the distillation step ALSO write to Hindsight `shared-knowledge`? Or stay in handoffs only? **Recommendation:** handoffs only in v1 (per research 04). Bear can opt-in Hindsight later.

5. **`aios.search_kg` exposure to the model.** Direct Cypher in the model's tool surface is powerful but risky — Gemma 4 (especially E4B) may emit nonsensical Cypher. **Recommendation:** ship it but log every query for review; if quality is poor, retract and replace with a constrained query-builder DSL.

6. **Backup destination — local disk vs T9-1.** Per filesystem-truth, T9-1 has the sandboxed-process limitation. The Neo4j backup process runs in launchd as Bear's user (not sandboxed) so T9-1 writes work. But the file is large (~135 GB). **Recommendation:** local disk for daily, T9-1 for weekly archives.

7. **The `voyageai` API key — same `safeStorage` pattern as fal.ai key?** Yes obviously, just confirming the symmetry. **Recommendation:** identical pattern to the image-gen key in research 02.

8. **The `:Entity` label — enable in v1 or defer?** Defer per §2.1 (no entity-resolution engine in v1 risks duplicate proliferation). Revisit at >10 GB indexed.

---

## 12. Phased rollout map

| Phase | Scope | Effort | Dependencies | Exit criteria |
|---|---|---|---|---|
| **Phase 2.7.0 — Foundation** | Create DB, user, roles, constraints, vector indexes; voyageai key in safeStorage; basic Neo4j driver wired in main process | 2–3 days | None | `cypher-shell` round-trip from main process works; all constraints/indexes show |
| **Phase 2.7.1 — Ingestion v1** | Parsers for md/txt/pdf/code; allowlist UI; chunk + embed pipeline; idempotent `:Document`/`:Chunk` writes | 4–5 days | 2.7.0 | The four research docs indexed; chunk count matches expected (~100); embed cost matches projection |
| **Phase 2.7.2 — Retrieval v1 (pure vector)** | `aios.recall` ToolSpec; query embed; vector ANN; rerank-2; 1-hop expansion; citation packaging | 3–4 days | 2.7.1 | All five acceptance tests in §8.2 pass |
| **Phase 2.7.3 — Graph tools** | `aios.cite`, `aios.search_kg` (with safety lint + readonly role), `aios.index` | 2–3 days | 2.7.2 | Sample queries from each tool succeed; safety lint rejects writes |
| **Phase 2.7.4 — Conversation memory** | `:Conversation`/`:Turn`/`:Summary` writes from chat loop; conversation-close distillation; `:Workspace`/`:Observation`/`:Pattern` graph mirroring of research 04's `.aios/` files | 4–5 days | 2.7.3 + research 04 Increment 3 | After 3+ conversations, `MATCH (p:Pattern) RETURN p` shows a pattern; `aios.recall` over conversation history works |
| **Phase 2.7.5 — Operational hardening** | Backup launchd job; ingest queue persistence; UI status badges; voyageai spend tracker | 2–3 days | 2.7.4 | Daily backups verified; queue survives app restart; spend metric matches voyageai dashboard |
| **Phase 2.8+ — Defer** | Hybrid BM25+vector; Contextual Embeddings; entity resolution; vector quantization; cross-DB partnership KG read | — | Real metrics from v1 | — |

Total Phase 2.7 estimated effort: **~17–23 dev-days** (3–5 weeks at a relaxed pace for a side project, 2–3 weeks at full focus).

---

## 13. Appendix A — Worked retrieval example end-to-end

To make the abstractions concrete:

**Scenario:** Bear has been using Gemma Chat for 3 weeks. The corpus indexed is: the four research docs, the AIOS rules dir, `~/claude-tracks/Knowledge_Base/`, and `/Users/bear/Documents/MindXpansion-Library/operations/`. Total: ~5 M chunks. He opens a new conversation and asks:

> "Last month I figured out a fix for the MLX cold-start EPIPE crash. What was the actual code change, and have I seen the same class of bug elsewhere since?"

**Step 1 — Gemma reasons (RISE [R]):**
The model sees this requires recall. It considers two approaches: (a) ask Bear to remind it (Calibration default), (b) call `aios.recall`. With temporal grounding ("last month") and the question shape ("what was the actual code change"), the model picks (b) with High confidence.

**Step 2 — Tool call:**

```xml
<action name="aios.recall">
  <query>MLX cold-start EPIPE crash fix code change</query>
  <k>8</k>
  <intent>auto</intent>
  <since>2026-04-17T00:00:00Z</since>
</action>
```

**Step 3 — Tool execution (in main process):**

1. Intent router classifies "code change" + technical vocabulary → routes to BOTH prose embed (for conversation summaries) and code embed (for actual code). Two parallel vector queries.
2. voyageai embed call: 80 ms.
3. `db.index.vector.queryNodes('chunk_embedding', 25, $query_vec_prose)` returns 25 prose hits (with `WHERE c.created_at >= $since` pre-filter).
4. `db.index.vector.queryNodes('chunk_embedding', 25, $query_vec_code) WHERE c.embedding_model = 'voyage-code-3'` returns 25 code hits.
5. Merge 50 candidates, dedupe by `chunk_uuid`.
6. voyageai rerank-2 with the original query + 50 chunk texts → top 8.
7. For each of the top 8, fetch ±1 `[:NEXT]` neighbors and the `:Document` metadata.
8. Return shaped results.

**Step 4 — Gemma composes its reply with citations:**

> Yes — on 2026-04-23 you patched `src/main/mlx.ts:182` to wrap the parent's chunk-write in a try/catch that swallows EPIPE specifically [chunk:0193abc...]. The fix was: instead of `process.stdout.write(chunk)`, the wrapped form `try { process.stdout.write(chunk) } catch (e) { if (e.code !== 'EPIPE') throw e; }` [chunk:0193def...].
>
> Since then, you've seen the same class of bug in two other places:
> 1. In `src/main/imageGen.ts` on 2026-05-02 — fal.ai stream cancellation triggered the same parent-write-to-dead-child pattern [chunk:0193ghi...].
> 2. In a Hindsight MCP retry path on 2026-05-10 — discussed in `SESSION_HANDOFF_hindsight-retries_20260510.md` [chunk:0193jkl...].

**Step 5 — Renderer:** the `[chunk:...]` tokens are recognized by Message.tsx's citation parser, rendered as inline links that expand on click to show the source chunk text (via a `aios.cite` call under the hood). Bear clicks one to verify.

**Step 6 — Background (RISE [I] + [S]):** the conversation distillation step at close notices that this Q&A pattern ("recall + cross-reference + cite") has now happened 5 times this week — promotes to `:Pattern { kind: 'successful', name: 'Cross-reference recall with citation', evidence_count: 5 }`. The next time Bear asks something similar, the pattern node is itself in the recall, helping Gemma reason about its own past successful approaches.

The loop closes.

---

## 14. Appendix B — Source citations

**Neo4j authoritative docs:**

- Vector indexes: <https://neo4j.com/docs/cypher-manual/current/indexes/semantic-indexes/vector-indexes/> — syntax, similarity functions, dim limits (vector-2.0 / vector-3.0 providers up to 4096 dims), `db.index.vector.queryNodes` example, Java Vector API requirement
- Multi-database admin: <https://neo4j.com/docs/operations-manual/current/database-administration/standard-databases/create-databases/> — `CREATE DATABASE` syntax, multi-DB confirmed Enterprise feature, "Not available on Aura"
- Backup: `neo4j-admin database backup` and `dump` (Neo4j 5.x Operations Manual)
- APOC 2026.04 release notes: `apoc.periodic.iterate` deprecated; use `CALL { ... } IN TRANSACTIONS OF N ROWS`

**voyageai authoritative docs:**

- Embeddings model list: <https://docs.voyageai.com/docs/embeddings> — dimensions, context lengths, Matryoshka support per model
- Pricing: <https://docs.voyageai.com/docs/pricing> — voyage-3-large $0.18/M, voyage-4-large $0.12/M, voyage-code-3 $0.18/M, voyage-multimodal-3 $0.12/M text + $0.60/B pixels, rerank-2 $0.05/M, rerank-2-lite $0.02/M
- Multimodal: <https://docs.voyageai.com/docs/multimodal-embeddings> — voyage-multimodal-3 1024-dim, 32k-token context, interleaved text+image input
- Reranker: <https://docs.voyageai.com/docs/reranker> — rerank-2 query≤4k tok, query+doc≤16k tok, ≤1000 docs/call, total ≤600k tok
- Rate limits: <https://docs.voyageai.com/docs/rate-limits> — Tier 1 voyage-3-large 3M TPM / 2000 RPM; Tier 2 (>$100) is 2×

**Project docs read for this research:**

- `/Users/bear/Development/gemma-chat/docs/research/01-mlx-vlm-and-gemma-4.md`
- `/Users/bear/Development/gemma-chat/docs/research/02-image-generation-strategy.md` (skimmed for safeStorage key pattern)
- `/Users/bear/Development/gemma-chat/docs/research/03-sota-electron-and-skills-architecture.md` (skimmed for ToolSpec/IPC patterns)
- `/Users/bear/Development/gemma-chat/docs/research/04-aios-integration-and-self-improvement.md` (fully read — integration philosophy, §10 boundary table, three-tier promotion model)
- `/Users/bear/Development/gemma-chat/docs/gemma-chat-app-design.md` (§10.2.1 ToolSpec shape, §10.2.6 self-improvement workspace)
- `/Users/bear/.claude/rules/persistence-discipline.md` (persistence triggers, 30-min rule)
- `/Users/bear/.claude/rules/mindxpansion-filesystem-truth.md` (`kg-arch-enterprise` location, three claude-tracks locations, T9-1 sandbox limitation, four Neo4j instances on this machine)
- `/Users/bear/Skills/rise-framework/rise-framework.md` (temporal grounding, 3-data-point rule, append-only patterns)

**Agent-memory references (neo4j-kg-architect):**

- `~/.claude/agent-memory/neo4j-kg-architect/patterns/anti-patterns.md` — particularly the 2026-05-16 "multiple Neo4j instances on the same port" entry that motivates §1's "no new DBMS" choice
- `~/.claude/agent-memory/neo4j-kg-architect/MEMORY.md` — running log of partnership-KG decisions, none of which this design affects

---

*End of document. ~1,030 lines. Next step: Bear's review of §11 open questions, then begin Phase 2.7.0 from §12.*
