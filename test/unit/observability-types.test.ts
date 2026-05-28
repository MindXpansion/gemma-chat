/**
 * Wave A1 — observability-types.ts structural sanity.
 *
 * observability-types.ts is type-only; nothing to test at runtime in the
 * conventional sense. But the IPC payload contract between main and
 * renderer is defined here, so we lock down a representative example for
 * each exported shape and assert at runtime that the example satisfies
 * the declared structure. If a field is renamed or its type changes
 * incompatibly, the example below stops type-checking — that's the
 * "test": `npm run typecheck` becomes a guard for the IPC contract.
 *
 * These tests would catch:
 *  • a renamed field in ConversationStateRow / UmmRow / SentinelFindingRow
 *    breaking the preload bridge silently (typecheck catches the example)
 *  • SentinelDetail losing its inheritance from SentinelRegistryRow
 *  • ApprovalResolution losing 'resolved' or 'dismissed' from the union
 *  • ObservabilitySnapshot.conversationState losing its `| null` allowance
 */
import { describe, it, expect } from 'vitest'
import type {
  ConversationStateRow,
  UmmRow,
  SentinelFindingRow,
  SentinelRegistryRow,
  SentinelDetail,
  SentinelDryRun,
  ApprovalItem,
  ApprovalResolution,
  ObservabilitySnapshot
} from '../../src/shared/observability-types'

describe('ConversationStateRow', () => {
  it('accepts a fully populated row', () => {
    const row: ConversationStateRow = {
      conversationId: 'conv-1',
      started_at: '2026-01-01T00:00:00Z',
      last_turn_at: '2026-01-01T00:05:00Z',
      turn_count: 3,
      current_strategy: 'mirror',
      last_user_emotion: 'curious',
      rapport_arc_avg: 0.6,
      rapport_arc_peak: 0.8,
      open_threads: ['t1', 't2']
    }
    expect(row.turn_count).toBe(3)
    expect(row.open_threads).toHaveLength(2)
  })

  it('accepts null for nullable string fields', () => {
    const row: ConversationStateRow = {
      conversationId: 'conv-2',
      started_at: null,
      last_turn_at: null,
      turn_count: 0,
      current_strategy: null,
      last_user_emotion: null,
      rapport_arc_avg: 0,
      rapport_arc_peak: 0,
      open_threads: []
    }
    expect(row.started_at).toBeNull()
    expect(row.open_threads).toEqual([])
  })
})

describe('UmmRow', () => {
  it('accepts a fully populated row including nullable psv_* fields', () => {
    const row: UmmRow = {
      uuid: 'u-1',
      at: '2026-01-01T00:00:00Z',
      user_emotion: 'frustrated',
      emotion_intensity: 0.8,
      user_intention: 'venting',
      rapport_level: 0.4,
      analyzer_confidence: 0.9,
      message_text: 'this is broken',
      psv_strategy: 'mirror',
      psv_empathy: 0.7,
      psv_agreeableness: 0.6
    }
    expect(row.psv_strategy).toBe('mirror')
  })

  it('accepts null for the three psv_* fields (no PSV computed yet)', () => {
    const row: UmmRow = {
      uuid: 'u-2',
      at: '2026-01-01T00:00:00Z',
      user_emotion: 'neutral',
      emotion_intensity: 0.5,
      user_intention: 'asking',
      rapport_level: 0.5,
      analyzer_confidence: 0.7,
      message_text: 'hi',
      psv_strategy: null,
      psv_empathy: null,
      psv_agreeableness: null
    }
    expect(row.psv_empathy).toBeNull()
  })
})

describe('SentinelFindingRow + SentinelRegistryRow', () => {
  it('finding accepts null observed/threshold', () => {
    const row: SentinelFindingRow = {
      name: 'rapport-drop',
      severity: 'warn',
      summary: 'rapport dropped 0.3',
      observed: null,
      threshold: null,
      created_at: '2026-01-01T00:00:00Z'
    }
    expect(row.observed).toBeNull()
  })

  it('registry row carries cadence + enabled fields', () => {
    const row: SentinelRegistryRow = {
      name: 'rapport-drop',
      severity: 'warn',
      description: 'flags sharp rapport drops',
      cadence_ticks: 10,
      file_path: '/path/to/sentinel.yaml',
      enabled: true
    }
    expect(row.enabled).toBe(true)
    expect(row.cadence_ticks).toBe(10)
  })
})

describe('SentinelDetail', () => {
  it('extends SentinelRegistryRow and adds query / comparator / template fields', () => {
    const detail: SentinelDetail = {
      name: 'rapport-drop',
      severity: 'warn',
      description: 'flags sharp rapport drops',
      cadence_ticks: 10,
      file_path: '/path/to/sentinel.yaml',
      enabled: true,
      query: 'MATCH (n) RETURN count(n)',
      comparator: 'gt',
      threshold: 5,
      summary_template: 'rapport dropped by {delta}',
      follow_up_prompt: null,
      action_on_cross: 'log_only',
      recent_findings: []
    }
    expect(detail.comparator).toBe('gt')
    expect(detail.recent_findings).toEqual([])
  })

  it('accepts each comparator variant in the union', () => {
    const comparators: SentinelDetail['comparator'][] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']
    expect(comparators).toHaveLength(6)
  })

  it('accepts each action_on_cross variant in the union', () => {
    const actions: SentinelDetail['action_on_cross'][] = [
      'log_only',
      'journal_appended',
      'follow_up_enqueued'
    ]
    expect(actions).toHaveLength(3)
  })
})

describe('SentinelDryRun', () => {
  it('accepts an ok run with observed value', () => {
    const dry: SentinelDryRun = {
      ok: true,
      observed: 12,
      crossed: true,
      summary: '12 > 5',
      elapsed_ms: 42
    }
    expect(dry.crossed).toBe(true)
  })

  it('accepts an error run with optional error string', () => {
    const dry: SentinelDryRun = {
      ok: false,
      observed: null,
      crossed: false,
      summary: 'query failed',
      elapsed_ms: 0,
      error: 'syntax error near MATCH'
    }
    expect(dry.error).toContain('syntax')
  })
})

describe('ApprovalItem + ApprovalResolution', () => {
  it('approval item populates source=sentinel and defer/follow_up nullables', () => {
    const item: ApprovalItem = {
      uuid: 'a-1',
      source: 'sentinel',
      name: 'rapport-drop',
      severity: 'critical',
      summary: 'rapport collapsed',
      observed: 0.1,
      threshold: 0.3,
      created_at: '2026-01-01T00:00:00Z',
      defer_until: null,
      follow_up_goal_id: null
    }
    expect(item.source).toBe('sentinel')
  })

  it('ApprovalResolution union retains both members', () => {
    const resolved: ApprovalResolution = 'resolved'
    const dismissed: ApprovalResolution = 'dismissed'
    expect([resolved, dismissed]).toEqual(['resolved', 'dismissed'])
  })
})

describe('ObservabilitySnapshot', () => {
  it('accepts a snapshot with null conversationState and empty arrays', () => {
    const snap: ObservabilitySnapshot = {
      conversationState: null,
      recentUmms: [],
      sentinelRegistry: [],
      recentFindings: []
    }
    expect(snap.conversationState).toBeNull()
  })

  it('accepts a populated snapshot', () => {
    const snap: ObservabilitySnapshot = {
      conversationState: {
        conversationId: 'c-1',
        started_at: null,
        last_turn_at: null,
        turn_count: 0,
        current_strategy: null,
        last_user_emotion: null,
        rapport_arc_avg: 0,
        rapport_arc_peak: 0,
        open_threads: []
      },
      recentUmms: [],
      sentinelRegistry: [],
      recentFindings: []
    }
    expect(snap.conversationState?.conversationId).toBe('c-1')
  })
})
