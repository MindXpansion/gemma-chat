import type { ConfirmPayload } from '@shared/types'

// Patch 31 L3 — approval card for a write/bash op on an rw-confirm mount.

interface Props {
  payload: ConfirmPayload
  onApprove: () => void
  onDeny: () => void
}

export default function ConfirmCard({ payload, onApprove, onDeny }: Props) {
  return (
    <div className="no-drag px-4 pb-2">
      <div className="mx-auto max-w-3xl rounded-xl border border-amber-500/30 bg-amber-500/[0.06] p-3">
        <div className="flex items-center gap-2 text-[12px] font-medium text-amber-200">
          <svg viewBox="0 0 16 16" className="h-3.5 w-3.5" fill="none" stroke="currentColor" strokeWidth="1.5">
            <path d="M8 1l7 13H1z" />
            <path d="M8 6v4M8 12v.5" />
          </svg>
          Gemma wants to change a workspace
        </div>
        <div className="mt-1.5 text-[13px] text-ink-100">
          <span className="font-medium">{payload.action}</span>
          <span className="text-ink-400">
            {' '}
            on <span className="text-ink-200">{payload.root}</span> via{' '}
            <code className="rounded bg-white/[0.06] px-1 py-0.5 text-[11px]">{payload.tool}</code>
          </span>
        </div>
        {payload.detail && (
          <pre className="mt-1.5 max-h-32 overflow-auto whitespace-pre-wrap rounded-md bg-black/30 p-2 text-[11px] leading-relaxed text-ink-300">
            {payload.detail}
          </pre>
        )}
        <div className="mt-2.5 flex justify-end gap-2">
          <button
            onClick={onDeny}
            className="rounded-lg border border-white/10 px-3 py-1.5 text-[12px] text-ink-200 transition hover:bg-white/[0.06]"
          >
            Deny
          </button>
          <button
            onClick={onApprove}
            className="rounded-lg bg-emerald-500/90 px-3 py-1.5 text-[12px] font-medium text-black transition hover:bg-emerald-400"
          >
            Approve
          </button>
        </div>
      </div>
    </div>
  )
}
