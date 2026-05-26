/**
 * Patch 63 / Block D #130 — Observability tab.
 *
 * Surfaces what Phronesis is already doing autonomously that the operator
 * otherwise can't see:
 *   • Tier 4.5 ConversationState rollup (turn count, strategy, rapport arc)
 *   • Tier 4.5 recent UMM stream + the PSV shift each one drove
 *   • Tier 1.6 Sentinel registry (what's armed) + recent findings
 *
 * Read-only. Refresh button + auto-load on open.
 */

import { useEffect, useState } from 'react'
import type { ObservabilitySnapshot } from '../../../../shared/observability-types'

interface Props {
  conversationId: string
}

export default function ObservabilityTab({ conversationId }: Props) {
  const [snapshot, setSnapshot] = useState<ObservabilitySnapshot | null>(null)
  const [loading, setLoading] = useState(false)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const snap = await window.api.observabilitySnapshot(conversationId)
      setSnapshot(snap)
    } catch (e) {
      console.warn('observability snapshot failed', e)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId])

  return (
    <div className="space-y-6 px-1">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-ink-400">
          Live state · conversation {conversationId.slice(0, 12)}…
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <ConversationStateSection snapshot={snapshot} />
      <SentinelSection snapshot={snapshot} />
      <UmmStreamSection snapshot={snapshot} />
    </div>
  )
}

function ConversationStateSection({ snapshot }: { snapshot: ObservabilitySnapshot | null }) {
  const cs = snapshot?.conversationState
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-medium text-white">Conversation state</h3>
      {!cs ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-ink-400">
          {snapshot == null
            ? 'Loading…'
            : 'No state written yet for this conversation. The first multi-turn chat with a non-trivial ToM read will populate this.'}
        </div>
      ) : (
        <div className="grid grid-cols-2 gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px]">
          <Stat label="Turns logged" value={String(cs.turn_count)} />
          <Stat label="Current strategy" value={cs.current_strategy ?? '—'} />
          <Stat label="Last emotion" value={cs.last_user_emotion ?? '—'} />
          <Stat label="Last turn at" value={cs.last_turn_at?.slice(0, 19).replace('T', ' ') ?? '—'} />
          <Stat label="Rapport avg" value={cs.rapport_arc_avg.toFixed(2)} />
          <Stat label="Rapport peak" value={cs.rapport_arc_peak.toFixed(2)} />
          <Stat
            label="Open threads"
            value={cs.open_threads.length === 0 ? '0' : `${cs.open_threads.length} · ${cs.open_threads.slice(0, 2).join(' · ')}`}
            wide
          />
        </div>
      )}
    </section>
  )
}

function Stat({ label, value, wide }: { label: string; value: string; wide?: boolean }) {
  return (
    <div className={wide ? 'col-span-2' : undefined}>
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 text-[13px] text-white">{value}</div>
    </div>
  )
}

function SentinelSection({ snapshot }: { snapshot: ObservabilitySnapshot | null }) {
  const reg = snapshot?.sentinelRegistry ?? []
  const findings = snapshot?.recentFindings ?? []
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-medium text-white">Sentinels</h3>
      <div className="space-y-2">
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-400">
            Armed ({reg.length})
          </div>
          {reg.length === 0 ? (
            <div className="text-[12px] text-ink-400">No sentinels in ~/GemmaWorkspace/sentinels/.</div>
          ) : (
            <ul className="space-y-1">
              {reg.map((s) => (
                <li key={s.name} className="flex items-center justify-between text-[12px]">
                  <div className="min-w-0">
                    {severityChip(s.severity)}{' '}
                    <span className="text-white">{s.name}</span>
                  </div>
                  <div className="text-[11px] text-ink-400">every {s.cadence_ticks} tick(s)</div>
                </li>
              ))}
            </ul>
          )}
        </div>
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
          <div className="mb-1.5 text-[10px] uppercase tracking-wider text-ink-400">
            Recent findings ({findings.length})
          </div>
          {findings.length === 0 ? (
            <div className="text-[12px] text-ink-400">
              No findings yet. Sentinels run on the heartbeat audit cadence (every 6 ticks).
            </div>
          ) : (
            <ul className="space-y-1.5">
              {findings.slice(0, 10).map((f, i) => (
                <li key={i} className="text-[12px]">
                  {severityChip(f.severity)}{' '}
                  <span className="text-white">{f.name}</span>{' '}
                  <span className="text-ink-400">— {f.summary || `observed ${f.observed} vs ${f.threshold}`}</span>
                  <div className="text-[10px] text-ink-400">{f.created_at.slice(0, 19).replace('T', ' ')}</div>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </section>
  )
}

function severityChip(s: string) {
  const color =
    s === 'critical'
      ? 'bg-red-500/20 text-red-300'
      : s === 'warn'
        ? 'bg-amber-500/20 text-amber-300'
        : 'bg-white/10 text-ink-200'
  return <span className={`rounded px-1.5 py-[1px] text-[10px] font-medium uppercase ${color}`}>{s}</span>
}

function UmmStreamSection({ snapshot }: { snapshot: ObservabilitySnapshot | null }) {
  const umms = snapshot?.recentUmms ?? []
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-medium text-white">
        Recent ToM reads ({umms.length})
      </h3>
      {umms.length === 0 ? (
        <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-ink-400">
          No UserMentalModel rows written for this conversation yet.
        </div>
      ) : (
        <div className="space-y-1.5">
          {umms.map((u) => (
            <div key={u.uuid} className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5">
              <div className="flex items-center justify-between text-[11px] text-ink-400">
                <span>{u.at.slice(0, 19).replace('T', ' ')}</span>
                <span>
                  conf {u.analyzer_confidence.toFixed(2)} · rapport {u.rapport_level.toFixed(2)}
                </span>
              </div>
              <div className="mt-1 text-[12px] text-white">
                <span className="text-amber-300">{u.user_emotion || '—'}</span>
                <span className="text-ink-400"> ({u.emotion_intensity.toFixed(2)})</span>
                <span className="text-ink-400"> · {u.user_intention || '—'}</span>
              </div>
              {u.message_text && (
                <div className="mt-1 truncate text-[11.5px] italic text-ink-300">
                  "{u.message_text}"
                </div>
              )}
              {u.psv_strategy ? (
                <div className="mt-1 text-[11px] text-ink-400">
                  drove shift: <span className="text-emerald-300">{u.psv_strategy}</span>
                  {u.psv_empathy != null && ` · empathy ${u.psv_empathy.toFixed(2)}`}
                  {u.psv_agreeableness != null && ` · agreeable ${u.psv_agreeableness.toFixed(2)}`}
                </div>
              ) : (
                <div className="mt-1 text-[11px] text-ink-400">no PSV shift recorded for this turn</div>
              )}
            </div>
          ))}
        </div>
      )}
    </section>
  )
}
