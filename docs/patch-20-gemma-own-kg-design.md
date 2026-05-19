# Patch 20 — Gemma's Own Integrated Neo4j KG (GOAT/SOTA)

> **Status:** DESIGN ONLY — awaits Bear's answers to §3 open questions + sign-off on phasing.
> **Author:** Claude (Opus 4.7) for Bear, 2026-05-18 (mid-Patch-19 pivot)
> **Anchored to:** `docs/research/05-neo4j-voyageai-rag-design.md` (1029 lines, implementation-ready)
> **Goal in one sentence:** Stand up Gemma Chat's own RAG-grade Neo4j KG inside the existing `kg-arch-enterprise` DBMS, with native vector indexes, voyageai embeddings, full ingestion/recall/citation tooling — phased so the foundation ships in hours, not weeks.

---

## 1. What we're building (TL;DR, distilled from research-05)

1. **New isolated database `gemma-chat-memory`** inside the existing `kg-arch-enterprise` DBMS at `bolt://localhost:7687`. Multi-database is Enterprise — one DBMS, two DBs, hard isolation, shared heap. **Do not** spin up a new DBMS (port-collision risk per architect anti-pattern #1, 2026-05-16). **Do not** use the default `neo4j` DB (that's the partnership KG — write-deny enforced at the auth layer).
2. **Dedicated Neo4j user `gemma-chat`** with grants ONLY on `gemma-chat-memory`. Defense in depth: even if Gemma emits malicious Cypher targeting the partnership KG, Neo4j auth refuses it.
3. **Schema:** 8 core labels, 10 relationship types, every node temporally grounded with `created_at` (+ optional `valid_from`/`valid_to`). Vector embeddings on `:Chunk`, `:Image`, `:Summary`, `:Observation`, `:Pattern`. All uniqueness constraints applied BEFORE first MERGE (per architect anti-pattern #2).
4. **Native Neo4j 5.x HNSW vector indexes** (vector-2.0 provider, 1024 dims). No Qdrant/Weaviate sidecar — one DB, one backup, one query plane.
5. **voyageai embeddings:** voyage-3-large (or voyage-4-large per §3.Q1) at 1024 dim for prose, voyage-code-3 for code, voyage-multimodal-3 for images. Shared 1024-dim namespace → one vector index per node label suffices.
6. **Four canonical tools:** `aios.recall`, `aios.cite`, `aios.search_kg` (read-only Cypher with safety lint), `aios.index`. Plus `aios.observe` and `aios.distill` bridges to the existing AIOS surfaces.

Boundary: this DB **does not read or write** the partnership KG (`neo4j` database within `kg-arch-enterprise`). Cross-references happen at handoff-file level, never Cypher.

## 2. Phasing (from research-05 §12 — pinned)

| Patch | Phase | Scope | Effort | $$ | Ships when |
|---|---|---|---|---|---|
| **20** | **2.7.0 Foundation** | DB + user + roles + constraints + indexes + driver wired to gemma-chat-memory | **2-3 hrs** | $0 | Today, after sign-off |
| 21 | 2.7.1 Ingestion v1 | Parsers (md/txt/pdf/code), allowlist UI, chunk + embed pipeline, idempotent writes | 4-5 days | ~$0.04 (4 research docs) | Bear approves |
| 22 | 2.7.2 Recall v1 | `aios.recall` ToolSpec, query embed, vector ANN, rerank-2, citation packaging | 3-4 days | per-query | After P21 |
| 23 | 2.7.3 Graph tools | `aios.cite`, `aios.search_kg`, `aios.index` | 2-3 days | $0 | After P22 |
| 24 | 2.7.4 Conversation memory | `:Conversation`/`:Turn`/`:Summary` autowrites + distillation pass | 4-5 days | per-conversation | After P23 |
| 25 | 2.7.5 Hardening | Backup launchd, ingest queue, UI badges, voyageai spend tracker | 2-3 days | $0 | After P24 |

**Total time-to-"fully wired and utilized": ~17-23 dev-days** for the full arc; **the foundation ships in 2-3 hours** and gives Gemma a working private graph immediately (writable via the existing `aios_kg_query` from Patch 19, just pointed at the new DB).

**My recommendation:** ship Patch 20 (Foundation) tonight on your sign-off, get Patch 21+ approved as separate weekly increments. This gets the architectural piece in place immediately while keeping voyageai spend off the books until you've actually decided which corpus to embed first.

## 3. Open questions from research-05 §11 that gate Patch 20+

These need your answer before I code. Most are one-word; a couple are real decisions.

| # | Question | Research-05 recommendation | My recommendation |
|---|---|---|---|
| Q1 | **voyage-3-large vs voyage-4-large** for prose default | voyage-4-large ($0.12/M vs $0.18/M, slightly better benchmarks) | **voyage-4-large** — newer, cheaper, free-tier eligible. Lower-stakes call than it looks (you can re-embed later, `embedding_model` is per-chunk) |
| Q2 | **Pre-embed all 100GB or grow demand-driven?** | Demand-driven ($10 bootstrap → grow) | **Demand-driven.** Pre-embedding ~$3K of content you may never query is wasteful. Start with the 4 research docs ($0.04) and grow |
| Q3 | **Should Gemma read the partnership KG too?** | No in v1 | **No** in Patch 20-25. Revisit when a concrete use case appears — Patch 19's `aios_kg_query` already gave her read+write to kg-arch-enterprise, so this is moot unless you want to revoke that |
| Q4 | **Hindsight write-through** from distillation? | Handoffs only in v1 | **Handoffs only** for now. Hindsight wire-up is still a separate Patch with its own MCP-architecture investigation |
| Q5 | **Expose direct Cypher (`aios.search_kg`) to Gemma 4?** | Ship + log + retract if quality is poor | **Ship it.** Patch 19 already gave her `aios_kg_query` against partnership KG — symmetric decision |
| Q6 | **Backup destination:** local vs T9-1 | Local daily, T9-1 weekly | **Same** — and the T9-1 SMB sandbox limit doesn't apply to launchd-as-user |
| Q7 | **voyageai key via safeStorage?** | Yes, same pattern as fal.ai | **Yes** — and I'll add a one-time setup modal when first ingestion is requested |
| Q8 | **Enable `:Entity` label in v1?** | Defer until >10GB indexed | **Defer** — no entity-resolution engine = duplicate proliferation risk |

**The only real fork: Q1, Q2.** Everything else is "yes recommended".

## 4. Patch 20 (Foundation) — exact deliverable

If you greenlight: in one commit I will:

1. **Pre-flight** (safety-first per architect anti-patterns):
   - Verify Enterprise edition via `CALL dbms.components()` — refuse to proceed if Community
   - Dump current partnership KG to `~/claude-tracks/Knowledge_Base/migrations/<timestamp>-pre-patch-20.dump`
   - `lsof -nP -iTCP:7687 -sTCP:LISTEN` — refuse to proceed if more than one listener
2. **Create** `gemma-chat-memory` database via `system` DB (your `kg-arch-enterprise` connection runs the CREATE; I provide the Cypher, you click)
3. **Create** Neo4j user `gemma-chat` and role `gemma-chat-rw` with grants ONLY on `gemma-chat-memory`, denies on `neo4j` and `system`. Password generated, stored via Electron `safeStorage` (Keychain-backed)
4. **Apply schema:** all 10 uniqueness constraints + 5 range indexes + 2 full-text indexes (per research-05 §2.3)
5. **Create vector indexes** (1 per embeddable label: `:Chunk`, `:Summary`, `:Observation`, `:Pattern`, `:Image`) — 1024 dim, cosine, vector-2.0 provider
6. **Add to env-loader:** new keys `NEO4J_GEMMA_USER`, `NEO4J_GEMMA_PASSWORD`, `NEO4J_GEMMA_DATABASE`
7. **Extend `aios-neo4j.ts`:** second driver instance pointed at `gemma-chat-memory` with the dedicated user. Existing `aios_kg_query` / `aios_kg_schema` get a `database` param to choose which graph
8. **New tools:** `gemma_kg_schema` / `gemma_kg_query` (rw to gemma-chat-memory) — symmetric to the partnership-KG tools
9. **System-prompt update:** explain the two-graph model to Gemma — partnership KG = read-write-with-architect-discipline; her own KG = her workspace, write freely
10. **Smoke test:** create one `:Document` node, query it back, drop it. Verify constraints fire (try to MERGE the same doc twice).

No voyageai key needed yet (Patch 21 surface). No embedding cost. No partnership-KG mutation.

## 5. What Patch 20 does NOT include (defers cleanly to P21+)

- voyageai client integration → P21
- File parsers (md/txt/pdf/code) → P21
- Allowlist UI → P21
- Chunk embed pipeline → P21
- `aios.recall` ToolSpec → P22
- Reranker → P22
- Citation parser in Message.tsx → P22 + UI work
- Auto-conversation-ingestion → P24
- Backup launchd job → P25

## 6. Risk assessment

| Risk | Likelihood | Mitigation |
|---|---|---|
| `CREATE DATABASE` against `kg-arch-enterprise` blocks the partnership KG mid-Claude-Code-session | Very low (multi-DB is parallel) | Pre-dump anyway; do it at a quiet moment for your other work |
| Constraint creation fails mid-batch | Low | Each constraint wrapped in `IF NOT EXISTS`; failures surface clearly per-constraint |
| Vector index creation fails on Enterprise 2025.10.1 | Low | vector-2.0 provider is GA in 5.x; documented support to 4096 dims |
| Disk space — gemma-chat-memory grows unbounded | Real but distant | At Patch 20 the graph is empty; Patch 25 wires the size badge. Plan for ~135 GB ceiling at full 100 GB corpus |
| Wrong DBMS connected via `bolt://localhost:7687` (architect anti-pattern #1) | Low — that was the Docker/Homebrew issue resolved 2026-05-16 | Pre-flight `lsof` check refuses if multiple listeners on :7687 |

## 7. Awaiting your decisions

Three quick answers from you and I ship Patch 20 tonight:

- **A.** Q1: voyage-3-large or **voyage-4-large** (research-05 + I both recommend the latter)
- **B.** Q2: pre-embed-100GB or **demand-driven** (both recommend demand-driven)
- **C.** Phase 20 only tonight, or queue Phase 21+ as a multi-commit arc this session?

If you say "yes to all defaults," I'll ship Patch 20 immediately and Patch 21 (ingestion) on top before sleep — that gets you a real working "index the four research docs and recall from them" loop in this same session for ~$0.04.

---

*Awaiting decisions A / B / C. No code changes against `gemma-chat-memory` until your sign-off.*
