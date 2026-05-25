/**
 * Patch 62 / Tier 4.5 — KG persistence for conversation state.
 *
 * Three write helpers backing the schema designed in
 * docs/research/09-tier4.5-conversation-state-persistence.md (architect):
 *
 *   • writeUserMentalModel — one CREATE per ToM firing, edge-anchored to
 *     a MERGE'd :ConversationState hub.
 *   • writePSVState        — one CREATE per shifted-PSV computation, edges
 *     to both the hub and the source UMM ([:DROVE_SHIFT] provenance).
 *   • upsertConversationState — mutable hub: increments turn_count,
 *     updates rolling rapport mean + peak, appends open_threads (cap 32).
 *
 * Target: gemma-chat-memory (the 'gemma' driver in aios-neo4j.ts).
 * Migration §5 ratified by neo4j-kg-architect on 2026-05-25 (run log:
 * ~/.claude/agent-memory/neo4j-kg-architect/runs/run_20260525_tier4.5-migration.md).
 *
 * Write cadence: ~3 writes per chat turn after the first. All best-effort —
 * caller MUST tolerate failure (KG hiccups must never block the chat path).
 */

import { randomUUID } from 'node:crypto'
import { runCypherRaw } from './aios-neo4j'
import type { PSV } from '../shared/psv'
import type { AdaptationStrategy } from '../shared/psv'
import type { UserMentalModel } from './tom'

const clamp01 = (n: number): number => Math.max(0, Math.min(1, n))

export async function writeUserMentalModel(
  umm: UserMentalModel,
  conversationId: string,
  messageText: string
): Promise<{ uuid: string }> {
  const uuid = randomUUID()
  await runCypherRaw(
    'gemma',
    `
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
    `,
    {
      uuid,
      conversationId,
      user_emotion: umm.user_emotion,
      emotion_intensity: clamp01(umm.emotion_intensity),
      user_intention: umm.user_intention,
      knowledge_gap: (umm.knowledge_gap ?? '').slice(0, 500),
      rapport_level: clamp01(umm.rapport_level),
      analyzer_confidence: clamp01(umm.analyzer_confidence),
      message_text: messageText.slice(0, 1000)
    }
  )
  return { uuid }
}

export async function writePSVState(
  psv: PSV,
  strategy: AdaptationStrategy,
  sourceUmmUuid: string,
  conversationId: string
): Promise<{ uuid: string }> {
  const uuid = randomUUID()
  // NOTE: PSV uses `social_skills` (plural); schema names this `social_skill`
  // (singular) per architect's design. Map at the boundary.
  await runCypherRaw(
    'gemma',
    `
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
    `,
    {
      uuid,
      sourceUmmUuid,
      conversationId,
      strategy,
      openness: psv.openness,
      conscientiousness: psv.conscientiousness,
      extraversion: psv.extraversion,
      agreeableness: psv.agreeableness,
      neuroticism: psv.neuroticism,
      self_awareness: psv.self_awareness,
      self_regulation: psv.self_regulation,
      motivation: psv.motivation,
      empathy: psv.empathy,
      social_skill: psv.social_skills
    }
  )
  return { uuid }
}

export interface UpsertConvFields {
  current_strategy?: AdaptationStrategy
  last_user_emotion?: string
  /** When supplied, contributes to the running mean and peak. */
  rapport_observation?: number
  /** When supplied, appended to open_threads if absent; oldest dropped past 32. */
  new_open_thread?: string
}

export async function upsertConversationState(
  conversationId: string,
  fields: UpsertConvFields
): Promise<void> {
  await runCypherRaw(
    'gemma',
    `
    MERGE (cs:ConversationState {conversationId: $conversationId})
      ON CREATE SET cs.started_at = datetime(), cs.turn_count = 0,
                    cs.rapport_arc_avg = 0.0, cs.rapport_arc_peak = 0.0,
                    cs.open_threads = [], cs.current_strategy = 'mirror'
    SET cs.last_turn_at = datetime(),
        cs.turn_count = cs.turn_count + 1,
        cs.current_strategy = coalesce($current_strategy, cs.current_strategy),
        cs.last_user_emotion = coalesce($last_user_emotion, cs.last_user_emotion)
    FOREACH (_ IN CASE WHEN $rapport_observation IS NULL THEN [] ELSE [1] END |
      SET cs.rapport_arc_avg = cs.rapport_arc_avg
                                + ($rapport_observation - cs.rapport_arc_avg) / cs.turn_count,
          cs.rapport_arc_peak = CASE
                                  WHEN $rapport_observation > cs.rapport_arc_peak
                                    THEN $rapport_observation
                                  ELSE cs.rapport_arc_peak
                                END
    )
    FOREACH (_ IN CASE WHEN $new_open_thread IS NULL OR $new_open_thread IN cs.open_threads
                       THEN [] ELSE [1] END |
      SET cs.open_threads = (cs.open_threads + $new_open_thread)[-32..]
    )
    `,
    {
      conversationId,
      current_strategy: fields.current_strategy ?? null,
      last_user_emotion: fields.last_user_emotion ?? null,
      rapport_observation: fields.rapport_observation ?? null,
      new_open_thread: fields.new_open_thread ?? null
    }
  )
}
