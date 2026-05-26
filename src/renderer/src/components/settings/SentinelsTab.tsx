/**
 * Patch 65 / Block D #137 — Sentinels tab.
 *
 * Per-sentinel detail surface: name, severity, query, threshold + comparator,
 * cadence, on-cross action, recent findings. Two operator actions:
 *   • Toggle enabled (edits the YAML's `enabled` field in place)
 *   • Dry-run (executes the query right now without writing a finding to KG)
 *
 * Real findings still only land via the heartbeat audit tick. This tab gives
 * Bear visibility + a manual test path without polluting the SentinelFinding
 * history with bench-test rows.
 */

import { useEffect, useState } from 'react'
import type {
  SentinelRegistryRow,
  SentinelDetail,
  SentinelDryRun
} from '../../../../shared/observability-types'

export default function SentinelsTab() {
  const [registry, setRegistry] = useState<SentinelRegistryRow[]>([])
  const [selectedName, setSelectedName] = useState<string | null>(null)
  const [detail, setDetail] = useState<SentinelDetail | null>(null)
  const [loadingList, setLoadingList] = useState(false)
  const [loadingDetail, setLoadingDetail] = useState(false)
  const [busy, setBusy] = useState(false)
  const [dryRun, setDryRun] = useState<SentinelDryRun | null>(null)

  async function refreshRegistry(): Promise<void> {
    setLoadingList(true)
    try {
      // Reuse observabilitySnapshot for the registry — it's already cached
      // server-side via loadSentinels and is the canonical list source.
      const snap = await window.api.observabilitySnapshot('__sentinels_tab__')
      setRegistry(snap.sentinelRegistry)
      if (snap.sentinelRegistry.length > 0 && !selectedName) {
        setSelectedName(snap.sentinelRegistry[0].name)
      }
    } finally {
      setLoadingList(false)
    }
  }

  async function refreshDetail(name: string): Promise<void> {
    setLoadingDetail(true)
    setDryRun(null)
    try {
      const d = await window.api.sentinelDetail(name)
      setDetail(d)
    } finally {
      setLoadingDetail(false)
    }
  }

  useEffect(() => {
    void refreshRegistry()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useEffect(() => {
    if (selectedName) void refreshDetail(selectedName)
  }, [selectedName])

  async function handleToggleEnabled(): Promise<void> {
    if (!detail) return
    setBusy(true)
    try {
      const ok = await window.api.sentinelSetEnabled(detail.name, !detail.enabled)
      if (ok) {
        await refreshRegistry()
        await refreshDetail(detail.name)
      }
    } finally {
      setBusy(false)
    }
  }

  async function handleDryRun(): Promise<void> {
    if (!detail) return
    setBusy(true)
    setDryRun(null)
    try {
      const r = await window.api.sentinelDryRun(detail.name)
      setDryRun(r)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex h-full min-h-0 gap-3">
      {/* Sentinel list */}
      <div className="w-56 shrink-0 overflow-y-auto rounded-lg border border-white/[0.06] bg-white/[0.02] p-2">
        <div className="mb-1 px-2 py-1 text-[10px] uppercase tracking-wider text-ink-400">
          Sentinels ({registry.length})
        </div>
        {loadingList && registry.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-ink-400">Loading…</div>
        ) : registry.length === 0 ? (
          <div className="px-2 py-1 text-[12px] text-ink-400">
            No sentinels in ~/GemmaWorkspace/sentinels/
          </div>
        ) : (
          registry.map((s) => (
            <button
              key={s.name}
              onClick={() => setSelectedName(s.name)}
              className={`flex w-full flex-col items-start rounded-md px-2 py-1.5 text-left text-[12px] transition ${
                selectedName === s.name
                  ? 'bg-white/[0.07] text-white'
                  : 'text-ink-200 hover:bg-white/[0.04]'
              }`}
            >
              <div className="flex w-full items-center justify-between gap-1">
                <span className="truncate">{s.name}</span>
                {!s.enabled && (
                  <span className="rounded bg-white/10 px-1 py-[1px] text-[9px] uppercase text-ink-400">
                    off
                  </span>
                )}
              </div>
              <div className="mt-0.5 flex items-center gap-1.5 text-[10px] text-ink-400">
                {severityChip(s.severity)}
                <span>every {s.cadence_ticks} tick(s)</span>
              </div>
            </button>
          ))
        )}
      </div>

      {/* Detail pane */}
      <div className="min-w-0 flex-1 overflow-y-auto">
        {!selectedName ? (
          <div className="text-[12px] text-ink-400">Pick a sentinel from the left.</div>
        ) : loadingDetail && !detail ? (
          <div className="text-[12px] text-ink-400">Loading detail…</div>
        ) : !detail ? (
          <div className="text-[12px] text-ink-400">No detail available.</div>
        ) : (
          <div className="space-y-4">
            <header>
              <div className="flex items-center gap-2">
                {severityChip(detail.severity)}
                <h3 className="text-[14px] font-medium text-white">{detail.name}</h3>
                {!detail.enabled && (
                  <span className="rounded bg-white/10 px-1.5 py-[1px] text-[10px] uppercase text-ink-400">
                    disabled
                  </span>
                )}
              </div>
              <p className="mt-1 text-[12px] text-ink-300">{detail.description}</p>
              <div className="mt-2 flex gap-2">
                <button
                  onClick={handleToggleEnabled}
                  disabled={busy}
                  className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-ink-100 transition hover:bg-white/[0.05] disabled:opacity-50"
                >
                  {detail.enabled ? 'Disable' : 'Enable'}
                </button>
                <button
                  onClick={handleDryRun}
                  disabled={busy}
                  className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-2.5 py-1 text-[11.5px] text-emerald-200 transition hover:bg-emerald-500/[0.1] disabled:opacity-50"
                >
                  {busy ? 'Running…' : 'Dry-run now'}
                </button>
              </div>
            </header>

            {/* Dry-run result */}
            {dryRun && (
              <section className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-400">
                  Dry-run result ({dryRun.elapsed_ms}ms)
                </div>
                {dryRun.error ? (
                  <div className="text-[12px] text-red-300">{dryRun.error}</div>
                ) : (
                  <div className="text-[12px] text-white">
                    Observed:{' '}
                    <span className="font-mono">{String(dryRun.observed)}</span>{' '}
                    {dryRun.crossed ? (
                      <span className="rounded bg-amber-500/20 px-1.5 py-[1px] text-[10px] uppercase text-amber-300">
                        crossed
                      </span>
                    ) : (
                      <span className="rounded bg-emerald-500/20 px-1.5 py-[1px] text-[10px] uppercase text-emerald-300">
                        ok
                      </span>
                    )}
                    {dryRun.summary && (
                      <div className="mt-1 text-[11.5px] italic text-ink-300">{dryRun.summary}</div>
                    )}
                  </div>
                )}
              </section>
            )}

            {/* Config */}
            <section className="space-y-2">
              <div className="grid grid-cols-2 gap-2 rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px]">
                <Stat label="Comparator" value={detail.comparator} />
                <Stat label="Threshold" value={String(detail.threshold)} />
                <Stat label="Cadence" value={`every ${detail.cadence_ticks} tick(s)`} />
                <Stat label="On cross" value={detail.action_on_cross} />
              </div>
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-400">Cypher</div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-[11px] font-mono text-ink-200">
                  {detail.query.trim()}
                </pre>
              </div>
              <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-400">
                  Summary template
                </div>
                <pre className="overflow-x-auto whitespace-pre-wrap text-[11.5px] font-mono text-ink-200">
                  {detail.summary_template}
                </pre>
              </div>
              {detail.follow_up_prompt && (
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
                  <div className="mb-1 text-[10px] uppercase tracking-wider text-ink-400">
                    Follow-up prompt
                  </div>
                  <div className="text-[11.5px] italic text-ink-200">{detail.follow_up_prompt}</div>
                </div>
              )}
              <div className="text-[10px] text-ink-400">{detail.file_path}</div>
            </section>

            {/* Recent findings */}
            <section>
              <div className="mb-1 text-[12.5px] font-medium text-white">
                Recent findings ({detail.recent_findings.length})
              </div>
              {detail.recent_findings.length === 0 ? (
                <div className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3 text-[12px] text-ink-400">
                  No findings yet for this sentinel.
                </div>
              ) : (
                <ul className="space-y-1.5">
                  {detail.recent_findings.map((f, i) => (
                    <li
                      key={i}
                      className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-2.5 text-[12px]"
                    >
                      <div className="flex items-center gap-2">
                        {severityChip(f.severity)}
                        <span className="text-ink-400">
                          {f.created_at.slice(0, 19).replace('T', ' ')}
                        </span>
                      </div>
                      <div className="mt-1 text-white">
                        {f.summary || `observed ${f.observed} vs ${f.threshold}`}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>
        )}
      </div>
    </div>
  )
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wider text-ink-400">{label}</div>
      <div className="mt-0.5 font-mono text-[12px] text-white">{value}</div>
    </div>
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
