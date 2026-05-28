/**
 * Shared test helper for live Neo4j integration tests.
 *
 * The withTestRun pattern:
 *   • Generates a unique runId (UUID) per test scope.
 *   • Generates a unique conversationId (`test-${runId}`) for the test.
 *   • Yields { runId, conversationId } to the test body.
 *   • After the body returns (success or failure), deletes every node and
 *     relationship in the gemma-chat-memory database that has a property
 *     `_test_run_id = <this runId>`.
 *
 * Why a _test_run_id tag (not just conversationId)?
 *   Multiple agent worktrees may run live tests concurrently. Two tests
 *   could generate identical conversationIds by coincidence (unlikely with
 *   UUIDs, but the safety property matters). A per-run tag stamped onto
 *   EVERY node a test creates guarantees cleanup of exactly what this run
 *   created — and only that. Concurrent test runs are isolated.
 *
 * Important: production code (writeUserMentalModel, writePSVState,
 * upsertConversationState) does NOT stamp this tag. Tests that exercise
 * those functions get the conversationId-based cleanup as a fallback.
 * Tests that write raw Cypher should set _test_run_id explicitly.
 */
import { randomUUID } from 'crypto'
import { runCypherRaw } from '../../src/main/aios-neo4j'

export interface TestRunContext {
  /** Unique tag for this test invocation. Stamp onto raw-Cypher nodes you
   *  create so cleanup catches them. */
  runId: string
  /** Convenience: `test-<runId>` — use as conversationId in tests that
   *  exercise the production write helpers. */
  conversationId: string
}

/**
 * Run a live-Neo4j test body with automatic cleanup.
 *
 * @example
 *   await withTestRun(async ({ conversationId }) => {
 *     await writeUserMentalModel(umm, conversationId, 'msg')
 *     // ... assertions ...
 *   })
 *   // Helper cleans up automatically.
 */
export async function withTestRun<T>(
  body: (ctx: TestRunContext) => Promise<T>
): Promise<T> {
  const runId = randomUUID()
  const conversationId = `test-${runId}`
  try {
    return await body({ runId, conversationId })
  } finally {
    await cleanupByRunId(runId, conversationId)
  }
}

async function cleanupByRunId(runId: string, conversationId: string): Promise<void> {
  // Two passes:
  // 1. Anything stamped with _test_run_id matching this run.
  // 2. Conversation-state graph for the conversationId (catches nodes
  //    written by production helpers that don't carry the tag).
  try {
    await runCypherRaw(
      'gemma',
      `MATCH (n) WHERE n._test_run_id = $runId DETACH DELETE n`,
      { runId }
    )
    await runCypherRaw(
      'gemma',
      `
      MATCH (cs:ConversationState {conversationId: $cid})
      OPTIONAL MATCH (cs)-[:HAS_UMM]->(u)
      OPTIONAL MATCH (cs)-[:HAS_PSV_STATE]->(p)
      DETACH DELETE cs, u, p
      `,
      { cid: conversationId }
    )
  } catch (err) {
    // Cleanup failures are warnings, not test failures — the next afterAll
    // or manual sweep can clean residual data. Surface so it's visible.
    console.warn(
      `[neo4j-cleanup] failed for runId=${runId.slice(0, 8)} cid=${conversationId}:`,
      (err as Error).message
    )
  }
}

/**
 * Sweep ALL test data (anything with conversationId starting with `test-`).
 * Use sparingly — intended for after-suite cleanup or development reset,
 * NOT per-test (would interfere with concurrent runs).
 */
export async function sweepAllTestData(): Promise<{ removed: number }> {
  const rows = await runCypherRaw(
    'gemma',
    `
    MATCH (n) WHERE n.conversationId IS NOT NULL AND n.conversationId STARTS WITH 'test-'
    WITH count(n) AS c
    MATCH (n) WHERE n.conversationId IS NOT NULL AND n.conversationId STARTS WITH 'test-'
    DETACH DELETE n
    RETURN c AS removed
    `,
    {}
  )
  return { removed: (rows[0]?.removed as number) ?? 0 }
}
