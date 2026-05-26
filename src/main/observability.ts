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

import { readFile, writeFile } from 'fs/promises'
import yaml from 'js-yaml'
import { loadSentinels, comparatorFn, interpolate, type Sentinel } from './sentinels'
import { runCypherRaw } from './aios-neo4j'
import type {
  ConversationStateRow,
  UmmRow,
  SentinelFindingRow,
  SentinelRegistryRow,
  SentinelDetail,
  SentinelDryRun,
  ObservabilitySnapshot
} from '../shared/observability-types'

export type {
  ConversationStateRow,
  UmmRow,
  SentinelFindingRow,
  SentinelRegistryRow,
  SentinelDetail,
  SentinelDryRun,
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
      // Patch 64: collapse to one row per UMM. A single UMM occasionally has
      // multiple [:DROVE_SHIFT] edges (fast double-send / re-render race)
      // and the prior OPTIONAL MATCH produced a Cartesian product. Take the
      // most-recent PSVState per UMM via ORDER + head(collect).
      MATCH (u:UserMentalModel {conversationId: $conversationId})
      OPTIONAL MATCH (u)-[:DROVE_SHIFT]->(p:PSVState)
      WITH u, p ORDER BY p.at DESC
      WITH u, head(collect(p)) AS p
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
      file_path: s.filePath,
      enabled: s.enabled
    }))
  } catch (e) {
    console.warn(`[observability] getSentinelRegistry failed: ${(e as Error).message}`)
    return []
  }
}

async function findSentinelByName(name: string): Promise<Sentinel | null> {
  const all = await loadSentinels()
  return all.find((s) => s.name === name) ?? null
}

export async function getSentinelDetail(name: string): Promise<SentinelDetail | null> {
  try {
    const s = await findSentinelByName(name)
    if (!s) return null
    const findingRows = await runCypherRaw(
      'gemma',
      `
      MATCH (f:SentinelFinding {name: $name})
      RETURN f.name AS name, f.severity AS severity, coalesce(f.summary,'') AS summary,
             f.observed AS observed, f.threshold AS threshold,
             toString(f.created_at) AS created_at
      ORDER BY f.created_at DESC LIMIT toInteger(10)
      `,
      { name }
    )
    const recent_findings: SentinelFindingRow[] = findingRows.map((r) => ({
      name: String(r.name),
      severity: String(r.severity ?? 'info'),
      summary: String(r.summary ?? ''),
      observed: r.observed == null ? null : Number(r.observed),
      threshold: r.threshold == null ? null : Number(r.threshold),
      created_at: String(r.created_at ?? '')
    }))
    return {
      name: s.name,
      severity: s.severity,
      description: s.description,
      cadence_ticks: s.cadenceTicks,
      file_path: s.filePath,
      enabled: s.enabled,
      query: s.query,
      comparator: s.comparator,
      threshold: s.threshold,
      summary_template: s.summaryTemplate,
      follow_up_prompt: s.followUpPrompt ?? null,
      action_on_cross: s.actionOnCross,
      recent_findings
    }
  } catch (e) {
    console.warn(`[observability] getSentinelDetail failed: ${(e as Error).message}`)
    return null
  }
}

/**
 * Dry-run a sentinel: execute its Cypher and compute the cross verdict
 * WITHOUT writing a SentinelFinding to the KG or affecting the audit
 * cadence. Gives Bear instant feedback on what the sentinel sees right
 * now. Real findings still only come from the heartbeat audit tick.
 */
export async function dryRunSentinel(name: string): Promise<SentinelDryRun> {
  const t0 = Date.now()
  try {
    const s = await findSentinelByName(name)
    if (!s) {
      return { ok: false, observed: null, crossed: false, summary: '', elapsed_ms: 0, error: `sentinel '${name}' not found` }
    }
    const rows = await runCypherRaw('gemma', s.query, s.params)
    const elapsed_ms = Date.now() - t0
    const observedRaw = rows[0]?.observed
    if (observedRaw == null) {
      return {
        ok: false,
        observed: null,
        crossed: false,
        summary: '',
        elapsed_ms,
        error: "query returned no 'observed' column"
      }
    }
    const observed =
      typeof observedRaw === 'number' || typeof observedRaw === 'string' || typeof observedRaw === 'boolean'
        ? observedRaw
        : String(observedRaw)
    const cmp = comparatorFn(s.comparator)
    const crossed = typeof observed === 'number' && typeof s.threshold === 'number'
      ? cmp(observed, s.threshold)
      : observed === s.threshold
    const summary = interpolate(s.summaryTemplate, {
      observed,
      threshold: s.threshold,
      name: s.name
    })
    return { ok: true, observed, crossed, summary, elapsed_ms }
  } catch (e) {
    return {
      ok: false,
      observed: null,
      crossed: false,
      summary: '',
      elapsed_ms: Date.now() - t0,
      error: (e as Error).message
    }
  }
}

/**
 * Toggle a sentinel's `enabled` field by editing its YAML in place.
 * No file rename — runAudit honors the `enabled` boolean on its own
 * (heartbeat.ts:1813 `sentinels.filter(s => s.enabled)`).
 *
 * Limitation: js-yaml.dump loses comments. Sentinel YAMLs are small
 * and machine-tidy so this is acceptable; the operator can always
 * hand-edit if they need rich comments.
 */
export async function setSentinelEnabled(name: string, enabled: boolean): Promise<boolean> {
  try {
    const s = await findSentinelByName(name)
    if (!s) {
      console.warn(`[observability] setSentinelEnabled: '${name}' not found`)
      return false
    }
    const raw = await readFile(s.filePath, 'utf-8')
    const doc = yaml.load(raw) as Record<string, unknown>
    if (!doc || typeof doc !== 'object') {
      console.warn(`[observability] setSentinelEnabled: '${name}' YAML did not parse to object`)
      return false
    }
    doc.enabled = enabled
    const out = yaml.dump(doc, { lineWidth: 120, noRefs: true })
    await writeFile(s.filePath, out, 'utf-8')
    return true
  } catch (e) {
    console.warn(`[observability] setSentinelEnabled failed: ${(e as Error).message}`)
    return false
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
