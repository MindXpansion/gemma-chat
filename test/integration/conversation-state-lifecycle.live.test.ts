/**
 * Wave B1 — extended lifecycle coverage for conversation-state.ts.
 *
 * Phase 1.5 already covers the three write helpers' happy paths
 * (test/integration/conversation-state.live.test.ts). This file extends
 * with the multi-turn, dedup, cap-enforcement, edge-count, and defensive
 * coercion scenarios called out in the Wave B1 plan row.
 *
 * Hygiene: every test uses `withTestRun` from test/helpers/neo4j-cleanup
 * so concurrent agent worktrees never collide.
 *
 * Skips gracefully if NEO4J_GEMMA_* env not loaded (same pattern as Phase 1.5).
 *
 * Mocks: none. All writes go to live gemma-chat-memory.
 */
import { describe, it, expect } from 'vitest'
import { loadAiosEnv } from '../../src/main/env-loader'
import {
  writeUserMentalModel,
  writePSVState,
  upsertConversationState
} from '../../src/main/conversation-state'
import { runCypherRaw } from '../../src/main/aios-neo4j'
import { DEFAULT_PSV } from '../../src/shared/psv'
import { withTestRun } from '../helpers/neo4j-cleanup'
import type { UserMentalModel } from '../../src/main/tom'

loadAiosEnv()
const envOk =
  !!process.env.NEO4J_GEMMA_URI &&
  !!process.env.NEO4J_GEMMA_USER &&
  !!process.env.NEO4J_GEMMA_PASSWORD
if (!envOk) {
  console.warn(
    '[conversation-state-lifecycle.live] SKIPPING — NEO4J_GEMMA_* env not loaded.'
  )
}

const makeUmm = (overrides: Partial<UserMentalModel> = {}): UserMentalModel => ({
  at: new Date().toISOString(),
  user_emotion: 'curious',
  emotion_intensity: 0.5,
  user_intention: 'exploring',
  knowledge_gap: '',
  rapport_level: 0.6,
  analyzer_confidence: 0.8,
  ...overrides
})

describe('conversation-state lifecycle — sequential turns', () => {
  it.skipIf(!envOk)(
    '10 sequential turns drive turn_count to 10 — would catch a regression where turn_count increment was moved out of upsertConversationState',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        for (let i = 0; i < 10; i++) {
          await upsertConversationState(conversationId, {
            current_strategy: 'mirror',
            last_user_emotion: 'curious',
            rapport_observation: 0.6
          })
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})
           RETURN cs.turn_count AS turns, cs.rapport_arc_avg AS avg`,
          { cid: conversationId }
        )
        expect(rows).toHaveLength(1)
        expect(rows[0].turns).toBe(10)
        // Constant 0.6 observations → mean stays at 0.6
        expect(rows[0].avg).toBeCloseTo(0.6, 5)
      })
    }
  )

  it.skipIf(!envOk)(
    'rapport mean follows incremental formula across 5 observations [0.5,0.6,0.7,0.8,0.9] — would catch a bug where the mean formula divided by a wrong factor',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const obs = [0.5, 0.6, 0.7, 0.8, 0.9]
        for (const r of obs) {
          await upsertConversationState(conversationId, { rapport_observation: r })
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})
           RETURN cs.rapport_arc_avg AS avg, cs.rapport_arc_peak AS peak`,
          { cid: conversationId }
        )
        // Arithmetic mean of those five = 0.7
        expect(rows[0].avg).toBeCloseTo(0.7, 5)
        expect(rows[0].peak).toBeCloseTo(0.9, 5)
      })
    }
  )

  it.skipIf(!envOk)(
    'rapport peak is monotonic — declining series [0.9,0.7,0.5] keeps peak at 0.9 — would catch a bug where peak got replaced by the latest observation',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        for (const r of [0.9, 0.7, 0.5]) {
          await upsertConversationState(conversationId, { rapport_observation: r })
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})
           RETURN cs.rapport_arc_peak AS peak`,
          { cid: conversationId }
        )
        expect(rows[0].peak).toBeCloseTo(0.9, 5)
      })
    }
  )
})

describe('conversation-state lifecycle — open_threads behavior', () => {
  it.skipIf(!envOk)(
    'open_threads dedupes: appending the same topic 3x yields one entry — would catch a regression where the IN-membership guard was dropped',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        for (let i = 0; i < 3; i++) {
          await upsertConversationState(conversationId, {
            new_open_thread: 'rapport calibration'
          })
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})
           RETURN cs.open_threads AS threads`,
          { cid: conversationId }
        )
        expect(rows[0].threads).toEqual(['rapport calibration'])
      })
    }
  )

  it.skipIf(!envOk)(
    'open_threads caps at 32 and drops oldest after 35 distinct appends — would catch a regression where the [-32..] slice was removed or off-by-one',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        for (let i = 0; i < 35; i++) {
          await upsertConversationState(conversationId, {
            new_open_thread: `topic-${String(i).padStart(2, '0')}`
          })
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})
           RETURN cs.open_threads AS threads`,
          { cid: conversationId }
        )
        const threads = rows[0].threads as string[]
        expect(threads).toHaveLength(32)
        // First three (topic-00..topic-02) should have been dropped
        expect(threads).not.toContain('topic-00')
        expect(threads).not.toContain('topic-01')
        expect(threads).not.toContain('topic-02')
        // Newest must be present
        expect(threads[threads.length - 1]).toBe('topic-34')
        expect(threads[0]).toBe('topic-03')
      })
    }
  )
})

describe('conversation-state lifecycle — edge counts', () => {
  it.skipIf(!envOk)(
    'after 5 writeUserMentalModel calls the [:HAS_UMM] edge count is 5 — would catch a regression where MERGE collapsed distinct UMM nodes',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        for (let i = 0; i < 5; i++) {
          await writeUserMentalModel(makeUmm(), conversationId, `msg ${i}`)
        }
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})-[:HAS_UMM]->(u)
           RETURN count(u) AS c`,
          { cid: conversationId }
        )
        expect(rows[0].c).toBe(5)
      })
    }
  )

  it.skipIf(!envOk)(
    'after 5 writePSVState calls the [:HAS_PSV_STATE] edge count is 5 and each [:DROVE_SHIFT] edge connects its source UMM — would catch a regression where DROVE_SHIFT provenance was lost',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const ummUuids: string[] = []
        for (let i = 0; i < 5; i++) {
          const { uuid } = await writeUserMentalModel(makeUmm(), conversationId, `msg ${i}`)
          ummUuids.push(uuid)
          await writePSVState(DEFAULT_PSV, 'mirror', uuid, conversationId)
        }
        const countRows = await runCypherRaw(
          'gemma',
          `MATCH (cs:ConversationState {conversationId: $cid})-[:HAS_PSV_STATE]->(p)
           RETURN count(p) AS c`,
          { cid: conversationId }
        )
        expect(countRows[0].c).toBe(5)

        // Each UMM should DROVE_SHIFT exactly one PSVState.
        for (const ummUuid of ummUuids) {
          const r = await runCypherRaw(
            'gemma',
            `MATCH (u:UserMentalModel {uuid: $u})-[:DROVE_SHIFT]->(p:PSVState)
             RETURN count(p) AS c`,
            { u: ummUuid }
          )
          expect(r[0].c).toBe(1)
        }
      })
    }
  )
})

describe('conversation-state lifecycle — defensive coercion (Patch 62.1)', () => {
  it.skipIf(!envOk)(
    'NaN rapport_level is clamped to 0 instead of crashing the driver — would catch a regression where Patch 62.1 clamp01 stopped guarding NaN',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const broken = makeUmm({ rapport_level: NaN as unknown as number })
        const { uuid } = await writeUserMentalModel(broken, conversationId, 'nan rapport')
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (u:UserMentalModel {uuid: $uuid}) RETURN u.rapport_level AS r`,
          { uuid }
        )
        expect(rows[0].r).toBe(0)
      })
    }
  )

  it.skipIf(!envOk)(
    'out-of-range rapport_level (1.5) is clamped to 1.0 — would catch a regression where clamp01 stopped enforcing the upper bound',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const broken = makeUmm({ rapport_level: 1.5 })
        const { uuid } = await writeUserMentalModel(broken, conversationId, 'oob rapport')
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (u:UserMentalModel {uuid: $uuid}) RETURN u.rapport_level AS r`,
          { uuid }
        )
        expect(rows[0].r).toBe(1)
      })
    }
  )

  it.skipIf(!envOk)(
    'empty user_emotion string is coerced to "unknown" in the stored node — would catch a regression where the safeStr || "unknown" fallback was removed',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const broken = makeUmm({ user_emotion: '' })
        const { uuid } = await writeUserMentalModel(broken, conversationId, 'empty emotion')
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (u:UserMentalModel {uuid: $uuid}) RETURN u.user_emotion AS e`,
          { uuid }
        )
        expect(rows[0].e).toBe('unknown')
      })
    }
  )

  it.skipIf(!envOk)(
    'non-string user_emotion (number-shaped) coerces to "unknown" — would catch a regression where safeStr stopped checking typeof',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const broken = makeUmm({ user_emotion: 42 as unknown as string })
        const { uuid } = await writeUserMentalModel(broken, conversationId, 'numeric emotion')
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (u:UserMentalModel {uuid: $uuid}) RETURN u.user_emotion AS e`,
          { uuid }
        )
        expect(rows[0].e).toBe('unknown')
      })
    }
  )

  it.skipIf(!envOk)(
    'knowledge_gap longer than 500 chars is clipped — would catch a regression where safeStr stopped enforcing max length',
    async () => {
      await withTestRun(async ({ conversationId }) => {
        const broken = makeUmm({ knowledge_gap: 'x'.repeat(2000) })
        const { uuid } = await writeUserMentalModel(broken, conversationId, 'long kgap')
        const rows = await runCypherRaw(
          'gemma',
          `MATCH (u:UserMentalModel {uuid: $uuid}) RETURN size(u.knowledge_gap) AS n`,
          { uuid }
        )
        expect(rows[0].n).toBe(500)
      })
    }
  )
})
