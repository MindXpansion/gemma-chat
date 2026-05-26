/**
 * Patch 63 / Block D #130 — shared types for the Settings Dashboard
 * Observability tab. Lives in `shared/` so both preload + renderer can
 * type the IPC payload without crossing into main/.
 */

export interface ConversationStateRow {
  conversationId: string
  started_at: string | null
  last_turn_at: string | null
  turn_count: number
  current_strategy: string | null
  last_user_emotion: string | null
  rapport_arc_avg: number
  rapport_arc_peak: number
  open_threads: string[]
}

export interface UmmRow {
  uuid: string
  at: string
  user_emotion: string
  emotion_intensity: number
  user_intention: string
  rapport_level: number
  analyzer_confidence: number
  message_text: string
  psv_strategy: string | null
  psv_empathy: number | null
  psv_agreeableness: number | null
}

export interface SentinelFindingRow {
  name: string
  severity: string
  summary: string
  observed: number | null
  threshold: number | null
  created_at: string
}

export interface SentinelRegistryRow {
  name: string
  severity: string
  description: string
  cadence_ticks: number
  file_path: string
  enabled: boolean
}

export interface SentinelDetail extends SentinelRegistryRow {
  query: string
  comparator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
  threshold: number | string
  summary_template: string
  follow_up_prompt: string | null
  action_on_cross: 'log_only' | 'journal_appended' | 'follow_up_enqueued'
  /** Last N findings for THIS sentinel, newest first. */
  recent_findings: SentinelFindingRow[]
}

export interface SentinelDryRun {
  ok: boolean
  observed: number | string | boolean | null
  crossed: boolean
  summary: string
  elapsed_ms: number
  error?: string
}

export interface ObservabilitySnapshot {
  conversationState: ConversationStateRow | null
  recentUmms: UmmRow[]
  sentinelRegistry: SentinelRegistryRow[]
  recentFindings: SentinelFindingRow[]
}
