import { useCallback, useEffect, useRef, useState } from 'react'
import type { HeartbeatState, HeartbeatJournalEntry, HeartbeatGoal } from '@shared/types'

/**
 * Patch 34 — the Heartbeat panel. A journal-backed view over the
 * autonomous research ticks: enable/disable, cadence, manual run, a live
 * stream while a tick runs, the goal queue (propose / ratify), and a
 * reader for the dated journal files in ~/GemmaWorkspace/research/ticks/.
 *
 * The journal is rendered as plain preformatted text (React-escaped). It
 * is a markdown research log written partly from model output; rendering
 * it as HTML would be an XSS vector, and monospace suits a log anyway.
 */
export default function Heartbeat() {
  const [state, setState] = useState<HeartbeatState | null>(null)
  const [goals, setGoals] = useState<HeartbeatGoal[]>([])
  const [entries, setEntries] = useState<HeartbeatJournalEntry[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [content, setContent] = useState('')
  const [busy, setBusy] = useState(false)
  const [live, setLive] = useState<string[]>([])
  const [cadenceDraft, setCadenceDraft] = useState('')
  const selectedRef = useRef<string | null>(null)
  selectedRef.current = selected

  const refreshEntries = useCallback(async () => {
    const e = await window.api.heartbeatListJournal()
    setEntries(e)
    if (!selectedRef.current && e.length > 0) {
      setSelected(e[0].name)
      setContent(await window.api.heartbeatReadJournal(e[0].name))
    }
  }, [])

  useEffect(() => {
    window.api.heartbeatGetState().then((s) => {
      setState(s)
      setCadenceDraft(String(s.cadenceMinutes))
    })
    window.api.heartbeatGetGoals().then(setGoals)
    void refreshEntries()
    const unsub = window.api.onHeartbeatEvent((ev) => {
      if (ev.type === 'state') {
        setState(ev.state)
      } else if (ev.type === 'goals') {
        setGoals(ev.goals)
      } else if (ev.type === 'tick-start') {
        setLive([`Tick #${ev.tick} started — ${ev.objective}`])
      } else if (ev.type === 'tick-tool') {
        setLive((l) => [...l, `ran ${ev.tool}`])
      } else if (ev.type === 'tick-end') {
        setLive((l) => [
          ...l,
          ev.status === 'ok'
            ? `Tick #${ev.tick} complete`
            : `Tick #${ev.tick} ${ev.status}: ${ev.error ?? 'error'}`
        ])
        void refreshEntries()
      }
    })
    return unsub
  }, [refreshEntries])

  const openEntry = useCallback(async (name: string) => {
    setSelected(name)
    setContent(await window.api.heartbeatReadJournal(name))
  }, [])

  async function toggleEnabled(): Promise<void> {
    if (!state) return
    setState(await window.api.heartbeatSetEnabled(!state.enabled))
  }

  async function saveCadence(): Promise<void> {
    const n = parseInt(cadenceDraft, 10)
    if (!Number.isFinite(n)) {
      if (state) setCadenceDraft(String(state.cadenceMinutes))
      return
    }
    const s = await window.api.heartbeatSetCadence(n)
    setState(s)
    setCadenceDraft(String(s.cadenceMinutes))
  }

  async function runNow(): Promise<void> {
    setBusy(true)
    setLive(['Starting a tick…'])
    try {
      const r = await window.api.heartbeatTickNow()
      if (r.status === 'skipped') {
        setLive([`Skipped: ${r.error ?? 'unknown reason'}`])
      }
      await refreshEntries()
    } finally {
      setBusy(false)
    }
  }

  async function ratify(id: string, status: 'queued' | 'skipped'): Promise<void> {
    setGoals(await window.api.heartbeatSetGoalStatus(id, status))
  }

  const ticking = busy || !!state?.ticking
  const enabled = !!state?.enabled
  const proposed = goals.filter((g) => g.status === 'proposed')
  const queued = goals.filter((g) => g.status === 'queued')
  const inProgress = goals.filter((g) => g.status === 'in_progress')
  const done = goals.filter((g) => g.status === 'done')

  // Patch 44: rolling-60min count of promoted primaries (must match
  // MAX_PRIMARIES_PER_HOUR in heartbeat.ts).
  const HOUR_CAP = 7
  const now = Date.now()
  const rollingPrimaries = (state?.primaryGoalLedger ?? []).filter(
    (e) => now - e.promotedAt < 60 * 60 * 1000
  ).length

  // Group follow-ups under their primary parent for tree rendering.
  const followUpsByParent = new Map<string, HeartbeatGoal[]>()
  for (const g of goals) {
    if (g.kind === 'follow_up' && g.parentId) {
      const arr = followUpsByParent.get(g.parentId) ?? []
      arr.push(g)
      followUpsByParent.set(g.parentId, arr)
    }
  }

  const lra = state?.lastReviewAttempt

  // Patch 45 (Tier 1.4): rolling-24h supersede count, refresh-cheap.
  const supersedes24h = (state?.supersedeLedger ?? []).filter(
    (e) => now - e.at < 24 * 60 * 60 * 1000
  ).length
  const lastSupersedeAt = state?.lastSupersedeAt

  // Patch 60 (Tier 1.6): sentinel 24h status counts.
  const sentinelStatus = state?.sentinelStatusLast24h ?? { ok: 0, warn: 0, critical: 0 }
  const lastAuditAt = state?.lastAuditAt

  return (
    <div className="anim-fade-in flex min-w-0 flex-1 flex-col">
      {/* Title bar */}
      <div className="drag flex h-11 shrink-0 items-center gap-2 border-b border-white/[0.06] px-4">
        <span
          className={`inline-block h-1.5 w-1.5 rounded-full ${enabled ? 'bg-emerald-400' : 'bg-ink-400/40'}`}
        />
        <span className="text-[13px] font-medium text-white">Heartbeat</span>
        <span className="text-[12px] text-ink-400">— autonomous research</span>
      </div>

      {/* Controls */}
      <div className="no-drag shrink-0 border-b border-white/[0.06] px-5 py-4">
        <div className="flex flex-wrap items-center gap-3">
          <button
            onClick={toggleEnabled}
            className={`flex items-center gap-2 rounded-lg px-3 py-1.5 text-[12.5px] font-medium transition ${
              enabled
                ? 'bg-emerald-400/15 text-emerald-200 hover:bg-emerald-400/25'
                : 'bg-white/[0.05] text-ink-300 hover:bg-white/[0.09]'
            }`}
          >
            <span
              className={`flex h-3.5 w-6 items-center rounded-full px-0.5 transition ${
                enabled ? 'bg-emerald-400/70' : 'bg-white/15'
              }`}
            >
              <span
                className={`h-2.5 w-2.5 rounded-full bg-white transition-transform ${
                  enabled ? 'translate-x-2.5' : ''
                }`}
              />
            </span>
            {enabled ? 'Enabled' : 'Disabled'}
          </button>

          <div className="flex items-center gap-1.5 text-[12.5px] text-ink-300">
            <span className="text-ink-400">every</span>
            <input
              value={cadenceDraft}
              onChange={(e) => setCadenceDraft(e.target.value.replace(/[^0-9]/g, ''))}
              onBlur={saveCadence}
              onKeyDown={(e) => {
                if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
              }}
              className="w-12 rounded-md border border-white/10 bg-white/[0.04] px-1.5 py-1 text-center text-ink-100 outline-none focus:border-white/25"
            />
            <span className="text-ink-400">min</span>
          </div>

          <button
            onClick={runNow}
            disabled={ticking}
            className="flex items-center gap-1.5 rounded-lg border border-white/10 bg-white/[0.04] px-3 py-1.5 text-[12.5px] font-medium text-white transition hover:border-white/20 hover:bg-white/[0.08] disabled:cursor-not-allowed disabled:opacity-50"
          >
            {ticking ? (
              <svg className="h-3.5 w-3.5 animate-spin" viewBox="0 0 24 24" fill="none">
                <circle
                  cx="12"
                  cy="12"
                  r="10"
                  stroke="currentColor"
                  strokeWidth="3"
                  strokeDasharray="40 100"
                />
              </svg>
            ) : (
              <span className="text-[13px]">♥</span>
            )}
            {ticking ? 'Tick running…' : 'Run a tick now'}
          </button>

          {/* Patch 44: rolling-hour gauge — primaries promoted in the last 60min. */}
          <div
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-ink-300"
            title="Primaries promoted in the last 60 minutes (cap enforces $0/offline-safe pacing)"
          >
            <span className="text-ink-400">hour</span>
            <span
              className={`font-mono ${rollingPrimaries >= HOUR_CAP ? 'text-amber-300' : 'text-emerald-300'}`}
            >
              {rollingPrimaries}/{HOUR_CAP}
            </span>
            <span className="text-ink-400">primaries</span>
          </div>

          {/* Patch 60 (Tier 1.6): sentinel 24h status counts. */}
          <div
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-ink-300"
            title="Sentinel firings in the last 24h. Sentinels are scheduled read-only audits over Gemma's own KG."
          >
            <span className="text-ink-400">sentinels 24h</span>
            <span className={`font-mono ${sentinelStatus.ok > 0 ? 'text-emerald-300' : 'text-ink-400/70'}`}>{sentinelStatus.ok} ok</span>
            <span className="text-ink-400/60">·</span>
            <span className={`font-mono ${sentinelStatus.warn > 0 ? 'text-amber-300' : 'text-ink-400/70'}`}>{sentinelStatus.warn} warn</span>
            <span className="text-ink-400/60">·</span>
            <span className={`font-mono ${sentinelStatus.critical > 0 ? 'text-red-400' : 'text-ink-400/70'}`}>{sentinelStatus.critical} crit</span>
            {lastAuditAt && (
              <span className="text-ink-400/70">· last {new Date(lastAuditAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
            )}
          </div>

          {/* Patch 45 (Tier 1.4): revisions gauge — SUPERSEDES writes in last 24h. */}
          <div
            className="flex items-center gap-2 rounded-lg border border-white/10 bg-white/[0.04] px-2.5 py-1 text-[11.5px] text-ink-300"
            title="Contradictions Gemma flagged in her own observations in the last 24h — auto-SUPERSEDES edges"
          >
            <span className="text-ink-400">revisions 24h</span>
            <span
              className={`font-mono ${supersedes24h > 0 ? 'text-violet-300' : 'text-ink-400/70'}`}
            >
              {supersedes24h}
            </span>
            {lastSupersedeAt && (
              <span className="text-ink-400/70">
                · last{' '}
                {new Date(lastSupersedeAt).toLocaleTimeString([], {
                  hour: '2-digit',
                  minute: '2-digit'
                })}
              </span>
            )}
          </div>

          <div className="ml-auto text-right text-[11.5px] leading-tight text-ink-400">
            <div>
              {state ? `${state.tickCount} tick${state.tickCount === 1 ? '' : 's'} run` : '…'}
            </div>
            {state?.lastTickAt && (
              <div>
                last: {new Date(state.lastTickAt).toLocaleString()}
                {state.lastTickStatus && state.lastTickStatus !== 'ok'
                  ? ` (${state.lastTickStatus})`
                  : ''}
              </div>
            )}
          </div>
        </div>

        {state?.lastError && (
          <div className="mt-2 text-[11.5px] text-amber-300/80">last error: {state.lastError}</div>
        )}

        {/* Patch 44: last review-tick attempt — including silent skips. */}
        {lra && (
          <div className="mt-2 text-[11.5px] leading-snug text-ink-400">
            <span className="text-ink-400/80">last review:</span>{' '}
            <span
              className={
                lra.status === 'ok'
                  ? 'text-emerald-300/90'
                  : lra.status === 'error'
                    ? 'text-amber-300/80'
                    : 'text-ink-300/80'
              }
            >
              {lra.status}
            </span>{' '}
            <span>
              at {new Date(lra.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} ·{' '}
              {lra.candidates} candidate{lra.candidates === 1 ? '' : 's'} · in-window {lra.inWindowObs} obs,
              oldest {lra.oldestAgeHours === null ? '—' : `${lra.oldestAgeHours}h`} (gate {lra.gateHours}h)
            </span>
            {lra.reason && <span className="text-ink-400/70"> — {lra.reason}</span>}
          </div>
        )}

        {live.length > 0 && (
          <div className="mt-3 rounded-lg border border-white/[0.06] bg-black/30 px-3 py-2 font-mono text-[11.5px] text-ink-300">
            {live.map((l, i) => (
              <div key={i} className={i === live.length - 1 && ticking ? 'shimmer-text' : ''}>
                {l}
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Goals */}
      <div className="no-drag shrink-0 border-b border-white/[0.06] px-5 py-3">
        <div className="mb-2 flex items-center gap-2 text-[10.5px] font-medium uppercase tracking-wider text-ink-400">
          <span>Goals</span>
          <span className="text-ink-400/60">
            {proposed.length > 0 ? `${proposed.length} proposed · ` : ''}
            {inProgress.length} in-progress · {queued.length} queued · {done.length} done
          </span>
        </div>

        {/* In-progress goals (Patch 40 phase-machine surface). */}
        {inProgress.length > 0 && (
          <div className="mb-2 space-y-1">
            {inProgress.map((g) => {
              const fups = followUpsByParent.get(g.id) ?? []
              return (
                <div key={g.id}>
                  <div className="flex items-center gap-2 px-1 text-[12px] text-ink-100">
                    <span className="text-sky-400/90 shimmer-text">●</span>
                    <span
                      className="min-w-0 flex-1 truncate"
                      title={g.instruction}
                    >
                      {g.title}
                    </span>
                    {g.phase && (
                      <span className="shrink-0 rounded-md bg-sky-400/15 px-1.5 py-0.5 text-[10.5px] font-medium text-sky-200">
                        {g.phase}
                      </span>
                    )}
                  </div>
                  {fups.map((f) => (
                    <div
                      key={f.id}
                      className="ml-5 flex items-center gap-2 px-1 text-[11.5px] text-ink-400"
                      title={f.instruction}
                    >
                      <span className="text-ink-400/60">└─</span>
                      <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      <span className="text-[10.5px] text-ink-400/70">{f.status}</span>
                    </div>
                  ))}
                </div>
              )
            })}
          </div>
        )}

        {proposed.length > 0 && (
          <div className="space-y-1.5">
            {proposed.map((g) => (
              <div
                key={g.id}
                className="flex items-center gap-2 rounded-lg border border-amber-400/20 bg-amber-400/[0.06] px-3 py-1.5"
              >
                <span className="min-w-0 flex-1 truncate text-[12.5px] text-ink-100" title={g.instruction}>
                  {g.title}
                </span>
                <button
                  onClick={() => ratify(g.id, 'queued')}
                  className="rounded-md bg-emerald-400/15 px-2 py-0.5 text-[11px] font-medium text-emerald-200 transition hover:bg-emerald-400/25"
                >
                  Approve
                </button>
                <button
                  onClick={() => ratify(g.id, 'skipped')}
                  className="rounded-md px-2 py-0.5 text-[11px] text-ink-400 transition hover:bg-white/10 hover:text-white"
                >
                  Skip
                </button>
              </div>
            ))}
          </div>
        )}

        {queued.length > 0 && (
          <div className={`space-y-1 ${proposed.length > 0 ? 'mt-2' : ''}`}>
            {queued
              .filter((g) => g.kind !== 'follow_up')
              .map((g) => {
                const fups = (followUpsByParent.get(g.id) ?? []).filter(
                  (f) => f.status === 'queued'
                )
                return (
                  <div key={g.id}>
                    <div className="flex items-center gap-2 px-1 text-[12px] text-ink-300">
                      <span className="text-emerald-400/70">▸</span>
                      <span className="min-w-0 flex-1 truncate" title={g.instruction}>
                        {g.title}
                      </span>
                      <button
                        onClick={() => ratify(g.id, 'skipped')}
                        className="text-[11px] text-ink-400 transition hover:text-white"
                      >
                        cancel
                      </button>
                    </div>
                    {fups.map((f) => (
                      <div
                        key={f.id}
                        className="ml-5 flex items-center gap-2 px-1 text-[11.5px] text-ink-400"
                        title={f.instruction}
                      >
                        <span className="text-ink-400/60">└─</span>
                        <span className="min-w-0 flex-1 truncate">{f.title}</span>
                      </div>
                    ))}
                  </div>
                )
              })}
            {/* Orphan queued follow-ups (parent already done) */}
            {queued
              .filter((g) => g.kind === 'follow_up' && !goals.some((p) => p.id === g.parentId))
              .map((g) => (
                <div
                  key={g.id}
                  className="ml-5 flex items-center gap-2 px-1 text-[11.5px] text-ink-400"
                  title={g.instruction}
                >
                  <span className="text-ink-400/60">└─</span>
                  <span className="min-w-0 flex-1 truncate">{g.title}</span>
                </div>
              ))}
          </div>
        )}

        {proposed.length === 0 && queued.length === 0 && inProgress.length === 0 && (
          <div className="text-[12px] text-ink-400">
            No goals queued. The next tick will be a planning tick — Gemma proposes goals from
            her roadmap, then you approve them here.
          </div>
        )}
      </div>

      {/* Journal split */}
      <div className="flex min-h-0 flex-1">
        <div className="w-64 shrink-0 overflow-y-auto border-r border-white/[0.06] py-2">
          {entries.length === 0 ? (
            <div className="px-4 py-6 text-[12px] text-ink-400">
              No ticks yet. Run one to get started.
            </div>
          ) : (
            entries.map((e) => (
              <button
                key={e.name}
                onClick={() => openEntry(e.name)}
                className={`block w-full px-4 py-2 text-left transition ${
                  selected === e.name ? 'bg-white/[0.07]' : 'hover:bg-white/[0.03]'
                }`}
              >
                <div className="text-[12.5px] text-ink-100">
                  {new Date(e.mtimeMs).toLocaleString([], {
                    month: 'short',
                    day: 'numeric',
                    hour: 'numeric',
                    minute: '2-digit'
                  })}
                </div>
                <div className="text-[11px] text-ink-400">{(e.size / 1024).toFixed(1)} KB</div>
              </button>
            ))
          )}
        </div>

        <div className="min-w-0 flex-1 overflow-y-auto px-6 py-5">
          {selected && content ? (
            <pre className="selectable whitespace-pre-wrap break-words font-mono text-[12px] leading-relaxed text-ink-200">
              {content}
            </pre>
          ) : (
            <div className="flex h-full items-center justify-center text-[12.5px] text-ink-400">
              Select a tick to read its journal.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
