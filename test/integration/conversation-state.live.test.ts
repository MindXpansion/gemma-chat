/**
 * Phase 1.5 — first LIVE integration test.
 *
 * Bear's rule: live tests by default. This hits the real Neo4j
 * gemma-chat-memory database via the same driver path the app uses.
 * No mocks. Establishes the live-test pattern for future integration
 * tests + gives a real runtime baseline.
 *
 * Hygiene:
 *   • All test data uses a unique conversationId per run (`test-<uuid>`)
 *     so we never collide with real conversation state.
 *   • afterAll cleans up via DETACH DELETE on the test conversationId.
 *   • Skips gracefully if NEO4J_GEMMA_* env vars aren't loaded
 *     (e.g., running in a fresh shell without ~/.gemma-chat.env access).
 *
 * Coverage: exercises all three exports from conversation-state.ts:
 *   • writeUserMentalModel
 *   • writePSVState (with [:DROVE_SHIFT] edge from UMM)
 *   • upsertConversationState (CREATE + UPDATE paths, rapport stats)
 */
import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import { randomUUID } from 'crypto'
import { loadAiosEnv } from '../../src/main/env-loader'
import {
  writeUserMentalModel,
  writePSVState,
  upsertConversationState
} from '../../src/main/conversation-state'
import { runCypherRaw, closeNeo4j } from '../../src/main/aios-neo4j'
import { DEFAULT_PSV } from '../../src/shared/psv'
import type { UserMentalModel } from '../../src/main/tom'

// Load env at MODULE SCOPE (synchronous) — `it.skipIf(cond)` evaluates `cond`
// at collection time, before any beforeAll runs. Loading here means envOk has
// a real value by the time the skipIf gate is checked.
loadAiosEnv()
const envOk =
  !!process.env.NEO4J_GEMMA_URI &&
  !!process.env.NEO4J_GEMMA_USER &&
  !!process.env.NEO4J_GEMMA_PASSWORD
if (!envOk) {
  console.warn(
    '[conversation-state.live] SKIPPING — NEO4J_GEMMA_* env not loaded. ' +
      'Tests pass trivially; check ~/.gemma-chat.env to enable.'
  )
}

const testConvId = `test-${randomUUID()}`

beforeAll(() => {
  /* env loaded at module scope; nothing to do here */
})

afterAll(async () => {
  if (envOk) {
    // Clean up everything tied to this test's conversation.
    await runCypherRaw(
      'gemma',
      `
      MATCH (cs:ConversationState {conversationId: $conversationId})
      OPTIONAL MATCH (cs)-[:HAS_UMM]->(u)
      OPTIONAL MATCH (cs)-[:HAS_PSV_STATE]->(p)
      DETACH DELETE cs, u, p
      `,
      { conversationId: testConvId }
    )
  }
  await closeNeo4j()
})

describe('conversation-state.ts — live Neo4j integration', () => {
  it.skipIf(!envOk)(
    'writeUserMentalModel creates :UserMentalModel + :ConversationState + edge',
    async () => {
      const umm: UserMentalModel = {
        at: new Date().toISOString(),
        user_emotion: 'curious',
        emotion_intensity: 0.7,
        user_intention: 'exploring',
        knowledge_gap: 'integration testing patterns for Electron apps',
        rapport_level: 0.6,
        analyzer_confidence: 0.85
      }

      const { uuid } = await writeUserMentalModel(umm, testConvId, 'how do live tests work?')
      expect(uuid).toMatch(/^[0-9a-f-]{36}$/)

      // Verify the node landed with correct properties via the HAS_UMM edge.
      const rows = await runCypherRaw(
        'gemma',
        `
        MATCH (cs:ConversationState {conversationId: $cid})-[:HAS_UMM]->(u:UserMentalModel {uuid: $uuid})
        RETURN u.user_emotion AS emotion, u.user_intention AS intention,
               u.rapport_level AS rapport, cs.conversationId AS cid
        `,
        { uuid, cid: testConvId }
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].emotion).toBe('curious')
      expect(rows[0].intention).toBe('exploring')
      expect(rows[0].rapport).toBe(0.6)
      expect(rows[0].cid).toBe(testConvId)
    }
  )

  it.skipIf(!envOk)(
    'writePSVState creates :PSVState linked to its source UMM via [:DROVE_SHIFT]',
    async () => {
      // First create a UMM to source from.
      const umm: UserMentalModel = {
        at: new Date().toISOString(),
        user_emotion: 'focused',
        emotion_intensity: 0.6,
        user_intention: 'planning',
        knowledge_gap: '',
        rapport_level: 0.7,
        analyzer_confidence: 0.8
      }
      const { uuid: ummUuid } = await writeUserMentalModel(
        umm,
        testConvId,
        'planning the next phase'
      )

      const { uuid: psvUuid } = await writePSVState(DEFAULT_PSV, 'goal', ummUuid, testConvId)
      expect(psvUuid).toMatch(/^[0-9a-f-]{36}$/)

      // Verify [:DROVE_SHIFT] edge + properties.
      const rows = await runCypherRaw(
        'gemma',
        `
        MATCH (u:UserMentalModel {uuid: $ummUuid})-[:DROVE_SHIFT]->(p:PSVState {uuid: $psvUuid})
        RETURN p.strategy AS strategy, p.openness AS openness, p.social_skill AS social_skill
        `,
        { ummUuid, psvUuid }
      )
      expect(rows).toHaveLength(1)
      expect(rows[0].strategy).toBe('goal')
      expect(rows[0].openness).toBe(DEFAULT_PSV.openness)
      // social_skills (PSV) -> social_skill (schema) mapping at boundary
      expect(rows[0].social_skill).toBe(DEFAULT_PSV.social_skills)
    }
  )

  it.skipIf(!envOk)(
    'upsertConversationState rolls up turn count, strategy, rapport mean+peak',
    async () => {
      // Use a fresh conversationId for this test so the rapport stats are isolated.
      const localCid = `test-upsert-${randomUUID()}`
      try {
        await upsertConversationState(localCid, {
          current_strategy: 'mirror',
          last_user_emotion: 'curious',
          rapport_observation: 0.6
        })
        await upsertConversationState(localCid, {
          current_strategy: 'goal',
          last_user_emotion: 'excited',
          rapport_observation: 0.9
        })

        const rows = await runCypherRaw(
          'gemma',
          `
          MATCH (cs:ConversationState {conversationId: $cid})
          RETURN cs.turn_count AS turns, cs.current_strategy AS strategy,
                 cs.last_user_emotion AS emotion, cs.rapport_arc_peak AS peak,
                 cs.rapport_arc_avg AS avg
          `,
          { cid: localCid }
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].turns).toBe(2)
        expect(rows[0].strategy).toBe('goal')
        expect(rows[0].emotion).toBe('excited')
        expect(rows[0].peak).toBe(0.9)
        // Incremental mean: (0.6 + 0.9) / 2 = 0.75
        expect(rows[0].avg).toBeCloseTo(0.75, 5)
      } finally {
        // Local cleanup since we used a different conversationId.
        await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid}) DETACH DELETE cs`,
          { cid: localCid }
        )
      }
    }
  )
})
