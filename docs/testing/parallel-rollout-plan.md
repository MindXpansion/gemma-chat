# Test Coverage Initiative — Parallel Sub-Agent Rollout Plan

**Started:** 2026-05-27 (evening)
**Target:** ~80% line/function/statement coverage, ~70% branch coverage, plus
adversarial suite + Playwright E2E baseline + full lint hygiene.
**Approach:** parallel sub-agents in isolated git worktrees, fanned out by
file ownership to prevent edit conflicts. Live tests by default per Bear's
binding rule. See `docs/testing/conventions.md` for the SOTA bar each agent
must meet.

---

## Wave structure

Waves are sequential. Agents *within* a wave run in parallel. The main agent
(orchestrator) merges each agent's worktree back to `main` after they return,
runs `npm test` + `npm run typecheck` between merges, and raises the coverage
gate in `vitest.config.ts` per the schedule in conventions.md.

### Wave A — non-MLX parallel (3 agents)

All Wave A agents touch only pure logic or live Neo4j. No MLX subprocess.
Safe to run concurrently.

| Agent | Branch | Files owned | Targets |
|---|---|---|---|
| **A1 — Shared types** | `tests/wave-a/shared-types` | `src/shared/types.ts`, `src/shared/observability-types.ts`, plus any helpers in `src/shared/` not already covered by `psv.test.ts` | Type predicates, AVAILABLE_MODELS shape invariants, SAMPLING_PROFILES shape, PROVIDERS registry validation, ModelStatus shape |
| **A2 — Observability + models** | `tests/wave-a/observability` | `src/main/observability.ts`, `src/main/models.ts` (HF cache scan), `src/main/sentinels.ts` (YAML loader) | Live Neo4j: getObservabilitySnapshot, getSentinelDetail (with sentinel yaml fixtures), getApprovalsQueue / resolve / defer. Filesystem: getModelStatuses against a fixture cache dir, deleteModelFromCache safety guard. YAML: sentinel loader edge cases (malformed, empty, missing fields) |
| **A3 — Scheduler + env** | `tests/wave-a/scheduler` | `src/main/scheduler.ts`, `src/main/env-loader.ts` | Pure-logic + fs: priority ordering, FIFO within priority, release-mismatch warning, queue-depth telemetry, run() convenience wrapper. env-loader: dotenv parsing edge cases (quoted values, comments, malformed lines), file precedence, KEY whitelist enforcement |

### Wave B — non-MLX parallel (3 agents)

Wave B builds on Wave A. Still no MLX (deferred to Wave C2). Each agent
extends modules whose parsers are already partially covered.

| Agent | Branch | Files owned | Targets |
|---|---|---|---|
| **B1 — ToM analyzer + conv-state** | `tests/wave-b/tom-extras` | `src/main/tom.ts` (non-MLX paths: concurrency guard, UUID cache, getters, ToMInput validation), `src/main/conversation-state.ts` (additional live-Neo4j lifecycle cases beyond Phase 1.5) | Concurrency: two parallel analyzeUserMentalModel calls — second one skips. Cache: latestUMMByConversation hydration. Live Neo4j: upsert across many sequential turns, rapport mean stability over 10+ observations, open_threads dedup + cap-at-32 behavior |
| **B2 — Mission + aios-neo4j** | `tests/wave-b/mission-aios` | `src/main/mission.ts` (decompose parsing from captured outputs — NO live MLX), `src/main/aios-neo4j.ts` (driver mgmt, runCypher, runCypherRaw, normalizeNeoValue) | Mission decompose parser: well-formed three-step, with-noise, malformed STEP lines, missing STEP lines (should fall back). Live Neo4j: driver lazy init, double-init returns cached, runCypher result shape, normalizeNeoValue across Int / Date / Node / Relationship / nested arrays, runCypherRaw error path (invalid Cypher) |
| **B3 — Preload IPC contract** | `tests/wave-b/preload-ipc` | `src/preload/index.ts` (IPC api surface), plus minor renderer-shared logic if discovered | Verify the `Api` type exposed via contextBridge has correct shape (TypeScript-level + runtime). Test the sendChat dead-man timer behavior with `vi.useFakeTimers()` (one of the few mocks justified — see conventions). Test that listener cleanup on done/error properly removes the listener. Test that aborting via abortChat causes proper teardown. |

### Wave C — sequential live-MLX work (2 agents, NOT parallel)

| Agent | Branch | Files owned | Targets |
|---|---|---|---|
| **C1 — gemma-fs + tools security** | `tests/wave-c/fs-security` | `src/main/gemma-fs.ts`, `src/main/tools.ts` (tool registry, argument parsing, no actual MLX calls) | Path traversal: `../`, `~/`, absolute paths outside mount, symlink escape. Mount mode enforcement: ro denies write, rw-confirm prompts (mock the confirm IPC — justified). Tool registry: lookup by name, unknown tool rejection. Argument parsing: malformed XML, oversized args, nested action tags. Posture gating: HEARTBEAT_TOOLS_ONLINE filter. |
| **C2 — MLX live + heartbeat** | `tests/wave-c/mlx-live` | `src/main/mlx.ts` (SSE parser + chatStream + listLocalModels), `src/main/heartbeat.ts` (probe state machine, collectStream) | OWNS the MLX subprocess for all live tests. Uses E2B (smallest model). SSE parser unit tests with captured streams (no live MLX needed). Live MLX: chatStream end-to-end with short prompt, listLocalModels round-trip, model:switch flow. Heartbeat: full probe tick (probe → narrate → journal write), abort propagation, scheduler integration. Mission decompose live end-to-end. ToM analyzer end-to-end. |

### Wave D — adversarial suite (1 agent)

| Agent | Branch | Targets |
|---|---|---|
| **D1 — Adversarial** | `tests/wave-d/adversarial` | Cross-cutting attack surface. Prompt injection in user messages (verify nothing escapes to fs/tool execution). Oversized inputs (10MB user messages, 8192-token analyzer outputs). Malformed model outputs (random bytes, nested JSON, prompt-injection-shaped tool calls). Path traversal across every fs surface. Schema deviation (model writes wrong types into Neo4j params — current Patch 62.1 guards). Scheduler chaos (1000 queued callers, abort while waiting, priority inversion attempts). KG: invalid Cypher injection via param values. MLX: timeout chaos with fake timers, SSE stream truncation mid-chunk, EOF mid-data. |

### Wave E — E2E + lint (2 agents, can run in parallel)

| Agent | Branch | Targets |
|---|---|---|
| **E1 — Playwright E2E** | `tests/wave-e/e2e` | Install `@playwright/test` + Electron support. Boot app, switch model to E2B, send chat + receive response, open Settings, navigate all 5 tabs, dry-run a sentinel, resolve an approval, enable/disable heartbeat. Each flow under 30s. |
| **E2 — Lint + format sweep** | `tests/wave-e/lint` | Run `npm run lint` across full codebase, categorize warnings (auto-fix vs needs-rule-tune vs real-issue). Apply auto-fixes via `lint:fix`. Run `npm run format` (prettier write). Commit cleanup with detailed per-rule summary. |

---

## Coverage gate schedule

`vitest.config.ts` thresholds raised at each merge point. From conventions.md:

| Phase | lines | functions | branches | statements |
|---|---|---|---|---|
| Phase 0 (shipped) | 5 | 5 | 5 | 5 |
| After Wave A merged | 25 | 25 | 20 | 25 |
| After Wave B merged | 45 | 45 | 35 | 45 |
| After Wave C merged | 65 | 65 | 55 | 65 |
| After Wave D merged | 70 | 70 | 60 | 70 |
| After Wave E merged | 80 | 80 | 70 | 80 |

If a wave can't hit its gate, raise the issue back to main; don't lower the
threshold. The threshold is contractual.

---

## Orchestrator (main agent) responsibilities

1. **Spawn** each wave's agents in parallel via `Agent` tool with
   `isolation: "worktree"` and `subagent_type: "general-purpose"`.
2. **Brief** each agent precisely: link to `docs/testing/conventions.md`,
   list files owned, list helpers available, state the wave's coverage gate.
3. **Verify** each returned agent's work: read the diff in their worktree
   (don't trust the agent's summary), run `npm test` + `npm run typecheck`
   in the worktree.
4. **Merge** clean worktrees to `main`, run full test suite + coverage
   between merges, bump the threshold per the schedule, commit.
5. **Iterate** with `SendMessage` if an agent's tests fail or are flaky.
   Don't spawn fresh agents for retries — continue the existing one.
6. **Proceed** to next wave only after current wave is fully merged and
   green on `main` with the bumped threshold.

---

## Risk register

| Risk | Mitigation |
|---|---|
| Two Wave A agents write conflicting helpers | Helpers committed in foundation patch BEFORE agents spawn; agents told "do not add new helpers without coordination" |
| Live Neo4j test data leaks between agent worktrees | `_test_run_id` tag on every node; helpers enforce; each agent gets a unique runId |
| MLX subprocess conflicts | Only C2 owns MLX live tests; A/B/C1/D briefed explicitly NOT to touch MLX live |
| Coverage gate fails after merge | Run `npm run coverage` BEFORE bumping the threshold; bump only if the new number is met |
| Flaky tests sneak in | Each agent runs their tests 3× to verify determinism; if flaky on main after merge, kick back to author |
| Worktree merge conflicts | Strict file ownership — agents that need to modify cross-owned files must report back, not unilateral |
| `npm install` per worktree adds 30s startup | Each agent's first action; one-time cost, acceptable |
