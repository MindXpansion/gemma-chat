import { useCallback, useEffect, useRef, useState } from 'react'
import type { HeartbeatState, HeartbeatJournalEntry } from '@shared/types'

/**
 * Patch 34 L2 — the Heartbeat panel. A journal-backed view over the
 * autonomous research ticks: enable/disable, cadence, manual run, a live
 * stream while a tick runs, and a reader for the dated journal files in
 * ~/GemmaWorkspace/research/ticks/.
 *
 * The journal is rendered as plain preformatted text (React-escaped). It
 * is a markdown research log written partly from model output; rendering
 * it as HTML would be an XSS vector, and monospace suits a log anyway.
 */
export default function Heartbeat() {
  const [state, setState] = useState<HeartbeatState | null>(null)
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
    void refreshEntries()
    const unsub = window.api.onHeartbeatEvent((ev) => {
      if (ev.type === 'state') {
        setState(ev.state)
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

  const ticking = busy || !!state?.ticking
  const enabled = !!state?.enabled

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
