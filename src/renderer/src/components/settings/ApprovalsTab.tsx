/**
 * Patch 66 / Block D #138 — Approvals tab.
 *
 * V1 producer: critical + warn :SentinelFinding rows with no resolved_at,
 * whose defer_until is null or in the past. Per-row actions:
 *   • Mark resolved  — SET f.resolved_at + f.resolution = 'resolved'
 *   • Dismiss        — same but resolution = 'dismissed' (semantic split
 *                      for future learning loops; both remove from queue)
 *   • Defer 24h      — push out of queue for a day
 *
 * Designed to be widened later: when Mission / Tier 5/6 start producing
 * proposals, the backend just UNIONs them into the same ApprovalItem
 * stream and this UI keeps working — `source` is already part of the type.
 */

import { useEffect, useState } from 'react'
import type { ApprovalItem } from '../../../../shared/observability-types'

export default function ApprovalsTab() {
  const [items, setItems] = useState<ApprovalItem[]>([])
  const [loading, setLoading] = useState(false)
  const [busy, setBusy] = useState<string | null>(null) // uuid currently being acted on

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const q = await window.api.approvalsList()
      setItems(q)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
  }, [])

  async function handleResolve(uuid: string, resolution: 'resolved' | 'dismissed'): Promise<void> {
    setBusy(uuid)
    try {
      const ok = await window.api.approvalsResolve(uuid, resolution)
      if (ok) await refresh()
    } finally {
      setBusy(null)
    }
  }

  async function handleDefer(uuid: string, hours: number): Promise<void> {
    setBusy(uuid)
    try {
      const ok = await window.api.approvalsDefer(uuid, hours)
      if (ok) await refresh()
    } finally {
      setBusy(null)
    }
  }

  const crit = items.filter((i) => i.severity === 'critical')
  const warn = items.filter((i) => i.severity === 'warn')

  return (
    <div className="space-y-4 px-1">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-ink-400">
          Pending — {items.length}
          {crit.length > 0 && (
            <span className="ml-2 text-red-300">· {crit.length} critical</span>
          )}
          {warn.length > 0 && <span className="ml-2 text-amber-300">· {warn.length} warn</span>}
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {items.length === 0 ? (
        <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-6 text-center">
          <div className="text-[13px] text-white">Inbox zero.</div>
          <div className="mt-1 text-[11.5px] text-ink-400">
            No critical or warn findings need attention. Triage items will appear here when
            sentinels cross thresholds during heartbeat audit ticks. Mission and Tier 5/6
            proposal sources will surface here too as they come online.
          </div>
        </div>
      ) : (
        <>
          {crit.length > 0 && (
            <Section title="Critical" items={crit} busy={busy} onResolve={handleResolve} onDefer={handleDefer} />
          )}
          {warn.length > 0 && (
            <Section title="Warn" items={warn} busy={busy} onResolve={handleResolve} onDefer={handleDefer} />
          )}
        </>
      )}
    </div>
  )
}

interface SectionProps {
  title: string
  items: ApprovalItem[]
  busy: string | null
  onResolve: (uuid: string, r: 'resolved' | 'dismissed') => void
  onDefer: (uuid: string, hours: number) => void
}

function Section({ title, items, busy, onResolve, onDefer }: SectionProps) {
  return (
    <section>
      <h3 className="mb-2 text-[12.5px] font-medium text-white">{title}</h3>
      <ul className="space-y-2">
        {items.map((it) => (
          <li
            key={it.uuid}
            className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3"
          >
            <div className="flex items-center gap-2">
              {severityChip(it.severity)}
              <span className="text-[12.5px] font-medium text-white">{it.name}</span>
              <span className="ml-auto text-[10.5px] text-ink-400">
                {it.created_at.slice(0, 19).replace('T', ' ')}
              </span>
            </div>
            <div className="mt-1.5 text-[12px] text-ink-100">
              {it.summary || `observed ${String(it.observed)} vs ${String(it.threshold)}`}
            </div>
            {it.follow_up_goal_id && (
              <div className="mt-1 text-[10.5px] text-ink-400">
                follow-up goal enqueued: {it.follow_up_goal_id}
              </div>
            )}
            <div className="mt-2 flex gap-2">
              <button
                onClick={() => onResolve(it.uuid, 'resolved')}
                disabled={busy === it.uuid}
                className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-2.5 py-1 text-[11.5px] text-emerald-200 transition hover:bg-emerald-500/[0.12] disabled:opacity-50"
              >
                Mark resolved
              </button>
              <button
                onClick={() => onResolve(it.uuid, 'dismissed')}
                disabled={busy === it.uuid}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
              >
                Dismiss
              </button>
              <button
                onClick={() => onDefer(it.uuid, 24)}
                disabled={busy === it.uuid}
                className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
              >
                Defer 24h
              </button>
            </div>
          </li>
        ))}
      </ul>
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
  return (
    <span className={`rounded px-1.5 py-[1px] text-[10px] font-medium uppercase ${color}`}>{s}</span>
  )
}
