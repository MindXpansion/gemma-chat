import { useEffect, useState, useCallback } from 'react'

// Patch 31 L2 — Gemma's filesystem workspaces: persistent Home + mounts.

type MountMode = 'ro' | 'rw-confirm' | 'rw-free'

interface GemmaMount {
  id: string
  name: string
  path: string
  mode: MountMode
  indexed: boolean
}

const MODE_LABEL: Record<MountMode, string> = {
  ro: 'read-only',
  'rw-confirm': 'confirm',
  'rw-free': 'free'
}

const MODE_CYCLE: Record<MountMode, MountMode> = {
  ro: 'rw-confirm',
  'rw-confirm': 'rw-free',
  'rw-free': 'ro'
}

function FolderIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 4h4l1.5 1.5H14V12H2z" />
    </svg>
  )
}

function HomeIcon() {
  return (
    <svg viewBox="0 0 16 16" className="h-3.5 w-3.5 shrink-0" fill="none" stroke="currentColor" strokeWidth="1.4">
      <path d="M2 7l6-5 6 5M4 6.5V13h8V6.5" />
    </svg>
  )
}

export default function WorkspaceBar() {
  const [mounts, setMounts] = useState<GemmaMount[]>([])
  const [pendingPath, setPendingPath] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const refresh = useCallback(async () => {
    try {
      setMounts(await window.api.listMounts())
    } catch {
      /* main not ready yet */
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function onMountClick(): Promise<void> {
    if (busy) return
    setBusy(true)
    try {
      const path = await window.api.pickFolder()
      if (path) setPendingPath(path)
    } finally {
      setBusy(false)
    }
  }

  async function confirmMount(mode: MountMode): Promise<void> {
    if (!pendingPath) return
    await window.api.addMount(pendingPath, mode)
    setPendingPath(null)
    refresh()
  }

  async function cycleMode(m: GemmaMount): Promise<void> {
    await window.api.setMountMode(m.id, MODE_CYCLE[m.mode])
    refresh()
  }

  async function unmount(id: string): Promise<void> {
    await window.api.removeMount(id)
    refresh()
  }

  return (
    <div className="no-drag border-t border-white/[0.06] px-2 py-3">
      <div className="px-1 pb-1.5 text-[10px] font-medium uppercase tracking-[0.08em] text-ink-400">
        Workspaces
      </div>

      <div className="flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-200">
        <HomeIcon />
        <span className="truncate">Home</span>
        <span className="ml-auto text-[10px] text-ink-400">~/GemmaWorkspace</span>
      </div>

      {mounts.map((m) => (
        <div
          key={m.id}
          className="group flex items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-200 hover:bg-white/[0.03]"
        >
          <FolderIcon />
          <span className="truncate" title={m.path}>
            {m.name}
          </span>
          <button
            onClick={() => cycleMode(m)}
            title="Click to change posture mode"
            className={`ml-auto rounded px-1.5 py-0.5 text-[10px] ${
              m.mode === 'ro'
                ? 'bg-white/[0.06] text-ink-400'
                : m.mode === 'rw-confirm'
                  ? 'bg-amber-500/15 text-amber-300'
                  : 'bg-emerald-500/15 text-emerald-300'
            }`}
          >
            {MODE_LABEL[m.mode]}
          </button>
          <button
            onClick={() => unmount(m.id)}
            title="Unmount"
            className="hidden h-5 w-5 items-center justify-center rounded text-ink-400 hover:bg-white/10 hover:text-white group-hover:flex"
          >
            <svg viewBox="0 0 16 16" className="h-3 w-3" fill="none" stroke="currentColor" strokeWidth="1.5">
              <path d="M4 4l8 8M12 4L4 12" />
            </svg>
          </button>
        </div>
      ))}

      {pendingPath ? (
        <div className="mt-1.5 rounded-lg border border-white/10 bg-white/[0.03] p-2">
          <div className="px-1 pb-1.5 text-[10px] text-ink-400">
            Mount <span className="text-ink-200">{pendingPath.split('/').pop()}</span> as:
          </div>
          <div className="flex flex-col gap-1">
            <button
              onClick={() => confirmMount('ro')}
              className="rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-white/[0.06]"
            >
              <span className="text-ink-100">Read-only</span>
              <span className="text-ink-400"> — read, search, traverse; no writes</span>
            </button>
            <button
              onClick={() => confirmMount('rw-confirm')}
              className="rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-white/[0.06]"
            >
              <span className="text-amber-300">Read-write, confirm</span>
              <span className="text-ink-400"> — each write asks first</span>
            </button>
            <button
              onClick={() => confirmMount('rw-free')}
              className="rounded px-2 py-1 text-left text-[11px] text-ink-200 hover:bg-white/[0.06]"
            >
              <span className="text-emerald-300">Read-write, free</span>
              <span className="text-ink-400"> — full agentic editing</span>
            </button>
          </div>
          <button
            onClick={() => setPendingPath(null)}
            className="mt-1 w-full rounded px-2 py-1 text-[10px] text-ink-400 hover:bg-white/[0.04]"
          >
            Cancel
          </button>
        </div>
      ) : (
        <button
          onClick={onMountClick}
          disabled={busy}
          className="mt-1 flex w-full items-center gap-1.5 rounded-lg px-2 py-1.5 text-[12px] text-ink-400 transition hover:bg-white/[0.03] hover:text-ink-200 disabled:opacity-50"
        >
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 3v10M3 8h10" />
          </svg>
          Mount a folder
        </button>
      )}
    </div>
  )
}
