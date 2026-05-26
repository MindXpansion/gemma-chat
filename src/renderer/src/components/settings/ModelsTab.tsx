/**
 * Patch 67 / Block D #132 — Models tab.
 *
 * Provider abstraction surface. Models grouped by provider; each row shows
 * label / size / status badges (active, downloaded) and offers operator actions:
 *   • Use         — switch the MLX server to this model (loads from disk)
 *   • Download    — same call as Use; mlx-vlm downloads on demand
 *   • Delete      — remove the cached weights (with confirm). Stops the
 *                   server first if the deleted model is currently loaded.
 *
 * Download/switch progress streams over the existing setup:status channel —
 * this tab subscribes to it so the user sees percent + bytes inline.
 *
 * Bear's binding rule: 100% local by default. Only enabled providers render;
 * disabled providers appear as "coming soon" so the abstraction's shape is
 * visible without ever surfacing a non-local action by accident.
 */

import { useEffect, useState } from 'react'
import type { Provider, ModelInfo, ModelStatus, SetupStatus } from '../../../../shared/types'
import { AVAILABLE_MODELS } from '../../../../shared/types'

function fmtBytes(n: number | undefined): string {
  if (n == null) return '—'
  if (n < 1_000_000) return `${(n / 1024).toFixed(0)} KB`
  if (n < 1_000_000_000) return `${(n / 1_000_000).toFixed(0)} MB`
  return `${(n / 1_000_000_000).toFixed(1)} GB`
}

export default function ModelsTab() {
  const [providers, setProviders] = useState<Provider[]>([])
  const [statuses, setStatuses] = useState<ModelStatus[]>([])
  const [loading, setLoading] = useState(false)
  const [busyName, setBusyName] = useState<string | null>(null)
  const [progress, setProgress] = useState<SetupStatus | null>(null)
  const [confirmDeleteName, setConfirmDeleteName] = useState<string | null>(null)

  async function refresh(): Promise<void> {
    setLoading(true)
    try {
      const [ps, ss] = await Promise.all([
        window.api.providersList(),
        window.api.modelsStatus()
      ])
      setProviders(ps)
      setStatuses(ss)
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    void refresh()
    // Subscribe to download/switch progress so the active row shows live status.
    const off = window.api.onSetupStatus((s) => {
      setProgress(s)
      // When we transition to 'ready', re-fetch statuses so the active marker
      // and downloaded sizes reflect the new state.
      if (s.stage === 'ready' || s.stage === 'error') {
        void refresh()
        setBusyName(null)
      }
    })
    return off
  }, [])

  async function handleUseOrDownload(name: string): Promise<void> {
    setBusyName(name)
    setProgress({ stage: 'downloading-model', message: 'Starting…' })
    try {
      await window.api.switchModel(name)
    } catch (e) {
      setProgress({
        stage: 'error',
        message: 'Switch failed',
        error: (e as Error).message
      })
      setBusyName(null)
    }
    // refresh + busy-clear happen in the onSetupStatus handler on 'ready'/'error'.
  }

  async function handleDelete(name: string): Promise<void> {
    setBusyName(name)
    try {
      const res = await window.api.modelDelete(name)
      if (!res.ok) {
        // eslint-disable-next-line no-alert
        alert(`Delete refused: ${res.reason ?? 'unknown reason'}`)
      }
    } finally {
      setBusyName(null)
      setConfirmDeleteName(null)
      await refresh()
    }
  }

  const totalDownloaded = statuses.filter((s) => s.downloaded).length
  const totalDiskBytes = statuses.reduce((acc, s) => acc + (s.sizeBytesOnDisk ?? 0), 0)

  return (
    <div className="space-y-4 px-1">
      <div className="flex items-center justify-between">
        <div className="text-[11px] uppercase tracking-wider text-ink-400">
          {totalDownloaded} of {AVAILABLE_MODELS.length} models on disk · {fmtBytes(totalDiskBytes)} used
        </div>
        <button
          onClick={refresh}
          disabled={loading}
          className="rounded-md border border-white/10 px-2 py-1 text-[11px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
        >
          {loading ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      {progress && progress.stage !== 'ready' && (
        <div className="rounded-lg border border-white/[0.08] bg-white/[0.03] px-3 py-2 text-[12px] text-ink-100">
          <div className="flex items-center justify-between">
            <span>{progress.message}</span>
            {progress.progress != null && (
              <span className="text-ink-400">{Math.round(progress.progress * 100)}%</span>
            )}
          </div>
          {progress.error && (
            <div className="mt-1 text-[11.5px] text-red-300">{progress.error}</div>
          )}
        </div>
      )}

      {providers.map((p) => {
        const models = AVAILABLE_MODELS.filter((m) => m.providerId === p.id)
        return (
          <section key={p.id}>
            <header className="mb-2 flex items-baseline gap-2">
              <h3 className="text-[12.5px] font-medium text-white">{p.label}</h3>
              <span
                className={`rounded px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider ${
                  p.runtime === 'local'
                    ? 'bg-emerald-500/15 text-emerald-300'
                    : 'bg-amber-500/15 text-amber-300'
                }`}
              >
                {p.runtime}
              </span>
              {!p.enabled && (
                <span className="rounded bg-white/5 px-1.5 py-[1px] text-[9px] uppercase tracking-wider text-ink-400">
                  soon
                </span>
              )}
              <span className="text-[11px] text-ink-400">— {p.description}</span>
            </header>

            {p.enabled && models.length > 0 ? (
              <ul className="space-y-2">
                {models.map((m) => (
                  <ModelRow
                    key={m.name}
                    model={m}
                    status={statuses.find((s) => s.name === m.name)}
                    busy={busyName === m.name}
                    anyBusy={busyName !== null}
                    onUseOrDownload={() => handleUseOrDownload(m.name)}
                    onDeleteRequest={() => setConfirmDeleteName(m.name)}
                  />
                ))}
              </ul>
            ) : !p.enabled ? (
              <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] px-3 py-2 text-[11.5px] text-ink-400">
                Provider not yet wired up.
              </div>
            ) : null}
          </section>
        )
      })}

      {confirmDeleteName && (
        <ConfirmDelete
          name={confirmDeleteName}
          status={statuses.find((s) => s.name === confirmDeleteName)}
          onCancel={() => setConfirmDeleteName(null)}
          onConfirm={() => handleDelete(confirmDeleteName)}
        />
      )}
    </div>
  )
}

interface RowProps {
  model: ModelInfo
  status: ModelStatus | undefined
  busy: boolean
  anyBusy: boolean
  onUseOrDownload: () => void
  onDeleteRequest: () => void
}

function ModelRow({ model, status, busy, anyBusy, onUseOrDownload, onDeleteRequest }: RowProps) {
  const downloaded = status?.downloaded ?? false
  const active = status?.isActive ?? false
  return (
    <li className="rounded-lg border border-white/[0.06] bg-white/[0.02] p-3">
      <div className="flex items-center gap-2">
        <span className="text-[12.5px] font-medium text-white">{model.label}</span>
        {model.recommended && (
          <span className="rounded bg-emerald-500/15 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-emerald-300">
            recommended
          </span>
        )}
        {active && (
          <span className="rounded bg-sky-500/15 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-sky-300">
            active
          </span>
        )}
        {downloaded ? (
          <span className="rounded bg-white/10 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-ink-200">
            on disk · {fmtBytes(status?.sizeBytesOnDisk)}
          </span>
        ) : (
          <span className="rounded bg-amber-500/15 px-1.5 py-[1px] text-[9px] font-medium uppercase tracking-wider text-amber-300">
            not downloaded
          </span>
        )}
        <span className="ml-auto text-[10.5px] text-ink-400">{model.size}</span>
      </div>
      <div className="mt-1 text-[11.5px] text-ink-300">{model.description}</div>
      <div className="mt-0.5 text-[10.5px] text-ink-500">{model.name}</div>
      <div className="mt-2 flex gap-2">
        {active ? (
          <span className="rounded-md border border-sky-500/30 bg-sky-500/[0.05] px-2.5 py-1 text-[11.5px] text-sky-200">
            In use
          </span>
        ) : downloaded ? (
          <button
            onClick={onUseOrDownload}
            disabled={anyBusy}
            className="rounded-md border border-sky-500/30 bg-sky-500/[0.05] px-2.5 py-1 text-[11.5px] text-sky-200 transition hover:bg-sky-500/[0.12] disabled:opacity-50"
          >
            {busy ? 'Switching…' : 'Use this model'}
          </button>
        ) : (
          <button
            onClick={onUseOrDownload}
            disabled={anyBusy}
            className="rounded-md border border-emerald-500/30 bg-emerald-500/[0.05] px-2.5 py-1 text-[11.5px] text-emerald-200 transition hover:bg-emerald-500/[0.12] disabled:opacity-50"
          >
            {busy ? 'Downloading…' : 'Download'}
          </button>
        )}
        {downloaded && (
          <button
            onClick={onDeleteRequest}
            disabled={anyBusy}
            className="rounded-md border border-white/10 px-2.5 py-1 text-[11.5px] text-ink-200 transition hover:bg-white/[0.05] disabled:opacity-50"
          >
            Delete
          </button>
        )}
      </div>
    </li>
  )
}

interface ConfirmProps {
  name: string
  status: ModelStatus | undefined
  onCancel: () => void
  onConfirm: () => void
}

function ConfirmDelete({ name, status, onCancel, onConfirm }: ConfirmProps) {
  const model = AVAILABLE_MODELS.find((m) => m.name === name)
  return (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onCancel}
    >
      <div
        className="anim-fade-scale w-[420px] max-w-[90vw] rounded-xl border border-white/[0.08] bg-[#0d0d0d] p-4 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <h3 className="text-[13px] font-medium text-white">Delete {model?.label ?? name}?</h3>
        <p className="mt-2 text-[12px] text-ink-300">
          This removes {fmtBytes(status?.sizeBytesOnDisk)} of cached weights from
          <code className="ml-1 rounded bg-white/[0.05] px-1 text-[11px] text-ink-200">
            ~/.cache/huggingface/hub
          </code>
          . You can re-download anytime.
          {status?.isActive && (
            <span className="mt-1 block text-amber-300">
              The MLX server will be stopped before delete — you&apos;ll need to pick another
              model after.
            </span>
          )}
        </p>
        <div className="mt-3 flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="rounded-md border border-white/10 px-3 py-1 text-[11.5px] text-ink-200 transition hover:bg-white/[0.05]"
          >
            Cancel
          </button>
          <button
            onClick={onConfirm}
            className="rounded-md border border-red-500/30 bg-red-500/[0.08] px-3 py-1 text-[11.5px] text-red-200 transition hover:bg-red-500/[0.15]"
          >
            Delete
          </button>
        </div>
      </div>
    </div>
  )
}
