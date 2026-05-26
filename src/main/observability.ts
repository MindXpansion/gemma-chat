/**
 * Patch 63 / Block D #130 — Settings Dashboard backend reads.
 *
 * Surfaces the autonomy that Phronesis ALREADY runs (Tier 4.5 ConversationState,
 * Tier 1.6 Sentinels, ToM analyzer) so the operator can see it. Bear's framing:
 * "you can't safely turn up the autonomy dial on systems you can't observe."
 *
 * Strictly read-only. Cheap. Fire on tab-open + manual refresh. The KG queries
 * are all O(small) — UMM stream limited to 20, sentinel findings to 20.
 */

import { loadSentinels, type Sentinel } from './sentinels'
import { runCypherRaw } from './aios-neo4j'
import type {
  ConversationStateRow,
  UmmRow,
  SentinelFindingRow,
  SentinelRegistryRow,
  ObservabilitySnapshot
} from '../shared/observability-types'

export type {
  ConversationStateRow,
  UmmRow,
  SentinelFindingRow,
  SentinelRegistryRow,
  ObservabilitySnapshot
}

function isoFromMaybeDateTime(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') return v
  // Neo4j DateTime normalized to a tagged object by normalizeNeoValue would
  // arrive as { __kind: ..., ... } — but our default formatter calls toString.
  try {
    return String(v)
  } catch {
    return null
  }
}

async function getConversationState(
  conversationId: string
): Promise<ConversationStateRow | null> {
  try {
    const rows = await runCypherRaw(
      'gemma',
      `
      MATCH (cs:ConversationState {conversationId: $conversationId})
      RETURN cs.conversationId AS conversationId,
             toString(cs.started_at) AS started_at,
             toString(cs.last_turn_at) AS last_turn_at,
             coalesce(cs.turn_count, 0) AS turn_count,
             cs.current_strategy AS current_strategy,
             cs.last_user_emotion AS last_user_emotion,
             coalesce(cs.rapport_arc_avg, 0.0) AS rapport_arc_avg,
             coalesce(cs.rapport_arc_peak, 0.0) AS rapport_arc_peak,
             coalesce(cs.open_threads, []) AS open_threads
      `,
      { conversationId }
    )
    const r = rows[0]
    if (!r) return null
    return {
      conversationId: String(r.conversationId),
      started_at: isoFromMaybeDateTime(r.started_at),
      last_turn_at: isoFromMaybeDateTime(r.last_turn_at),
      turn_count: Number(r.turn_count) || 0,
      current_strategy: (r.current_strategy as string | null) ?? null,
      last_user_emotion: (r.last_user_emotion as string | null) ?? null,
      rapport_arc_avg: Number(r.rapport_arc_avg) || 0,
      rapport_arc_peak: Number(r.rapport_arc_peak) || 0,
      open_threads: Array.isArray(r.open_threads) ? (r.open_threads as string[]) : []
    }
  } catch (e) {
    console.warn(`[observability] getConversationState failed: ${(e as Error).message}`)
    return null
  }
}

async function getRecentUmms(conversationId: string, limit = 20): Promise<UmmRow[]> {
  try {
    // Patch 63.1: toInteger($limit) — Neo4j 5.x rejects JS-number params for
    // LIMIT because they arrive as Float (20.0) and LIMIT requires Integer.
    // Same fix in getRecentSentinelFindings below. Caller still passes a
    // normal JS number; the Cypher coerces.
    const rows = await runCypherRaw(
      'gemma',
      `
      MATCH (u:UserMentalModel {conversationId: $conversationId})
      OPTIONAL MATCH (u)-[:DROVE_SHIFT]->(p:PSVState)
      RETURN u.uuid AS uuid,
             toString(u.at) AS at,
             u.user_emotion AS user_emotion,
             coalesce(u.emotion_intensity, 0.0) AS emotion_intensity,
             u.user_intention AS user_intention,
             coalesce(u.rapport_level, 0.0) AS rapport_level,
             coalesce(u.analyzer_confidence, 0.0) AS analyzer_confidence,
             coalesce(u.message_text, '') AS message_text,
             p.strategy AS psv_strategy,
             p.empathy AS psv_empathy,
             p.agreeableness AS psv_agreeableness
      ORDER BY u.at DESC
      LIMIT toInteger($limit)
      `,
      { conversationId, limit }
    )
    return rows.map((r) => ({
      uuid: String(r.uuid),
      at: isoFromMaybeDateTime(r.at) ?? '',
      user_emotion: String(r.user_emotion ?? ''),
      emotion_intensity: Number(r.emotion_intensity) || 0,
      user_intention: String(r.user_intention ?? ''),
      rapport_level: Number(r.rapport_level) || 0,
      analyzer_confidence: Number(r.analyzer_confidence) || 0,
      message_text: String(r.message_text ?? ''),
      psv_strategy: (r.psv_strategy as string | null) ?? null,
      psv_empathy: r.psv_empathy == null ? null : Number(r.psv_empathy),
      psv_agreeableness: r.psv_agreeableness == null ? null : Number(r.psv_agreeableness)
    }))
  } catch (e) {
    console.warn(`[observability] getRecentUmms failed: ${(e as Error).message}`)
    return []
  }
}

async function getRecentSentinelFindings(limit = 20): Promise<SentinelFindingRow[]> {
  try {
    const rows = await runCypherRaw(
      'gemma',
      `
      MATCH (f:SentinelFinding)
      RETURN f.name AS name,
             f.severity AS severity,
             coalesce(f.summary, '') AS summary,
             f.observed AS observed,
             f.threshold AS threshold,
             toString(f.created_at) AS created_at
      ORDER BY f.created_at DESC
      LIMIT toInteger($limit)
      `,
      { limit }
    )
    return rows.map((r) => ({
      name: String(r.name),
      severity: String(r.severity ?? 'info'),
      summary: String(r.summary ?? ''),
      observed: r.observed == null ? null : Number(r.observed),
      threshold: r.threshold == null ? null : Number(r.threshold),
      created_at: isoFromMaybeDateTime(r.created_at) ?? ''
    }))
  } catch (e) {
    console.warn(`[observability] getRecentSentinelFindings failed: ${(e as Error).message}`)
    return []
  }
}

async function getSentinelRegistry(): Promise<SentinelRegistryRow[]> {
  try {
    const sentinels = await loadSentinels()
    return sentinels.map((s: Sentinel) => ({
      name: s.name,
      severity: s.severity,
      description: s.description,
      cadence_ticks: s.cadenceTicks,
      file_path: s.filePath
    }))
  } catch (e) {
    console.warn(`[observability] getSentinelRegistry failed: ${(e as Error).message}`)
    return []
  }
}

export async function getObservabilitySnapshot(
  conversationId: string
): Promise<ObservabilitySnapshot> {
  const [conversationState, recentUmms, sentinelRegistry, recentFindings] = await Promise.all([
    getConversationState(conversationId),
    getRecentUmms(conversationId),
    getSentinelRegistry(),
    getRecentSentinelFindings()
  ])
  return { conversationState, recentUmms, sentinelRegistry, recentFindings }
}
