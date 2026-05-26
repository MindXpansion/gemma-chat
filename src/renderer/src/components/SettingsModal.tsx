/**
 * Patch 63 / Block D #130 — Settings Dashboard.
 *
 * Tabbed modal opened from a gear icon in the Chat header. Patch 63 ships the
 * scaffold + Observability tab (the load-bearing tab — gives operator eyes-on
 * for Tier 4.5 + Sentinels). Other tabs are stubs that announce what's coming:
 *   • Models, Heartbeat, Sentinels (full editor), HITL, About — Patches 64+.
 *
 * Deliberately minimal styling — matches the existing dropdown vocabulary
 * (rounded panels, white/0.06 borders, ink-* tones).
 */

import { useEffect, useState } from 'react'
import ObservabilityTab from './settings/ObservabilityTab'
import Heartbeat from './Heartbeat'

export type TabId = 'observability' | 'models' | 'heartbeat' | 'sentinels' | 'hitl' | 'about'

const TABS: Array<{ id: TabId; label: string; stub?: boolean }> = [
  { id: 'observability', label: 'Observability' },
  { id: 'heartbeat', label: 'Heartbeat' },
  { id: 'models', label: 'Models', stub: true },
  { id: 'sentinels', label: 'Sentinels', stub: true },
  { id: 'hitl', label: 'Approvals', stub: true },
  { id: 'about', label: 'About', stub: true }
]

interface Props {
  conversationId: string
  initialTab?: TabId
  onClose: () => void
}

export default function SettingsModal({ conversationId, initialTab = 'observability', onClose }: Props) {
  const [tab, setTab] = useState<TabId>(initialTab)

  // Escape to close
  useEffect(() => {
    function onKey(e: KeyboardEvent): void {
      if (e.key === 'Escape') onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])

  return (
    <div
      className="fixed inset-0 z-[100] flex items-center justify-center bg-black/60 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="anim-fade-scale flex h-[80vh] max-h-[720px] w-[88vw] max-w-[960px] overflow-hidden rounded-2xl border border-white/[0.08] bg-[#0d0d0d] shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Tab rail */}
        <div className="flex w-44 shrink-0 flex-col border-r border-white/[0.06] bg-white/[0.02] p-2">
          <div className="mb-1 px-2 py-1 text-[10px] font-medium uppercase tracking-wider text-ink-400">
            Settings
          </div>
          {TABS.map((t) => (
            <button
              key={t.id}
              onClick={() => setTab(t.id)}
              className={`flex items-center justify-between rounded-lg px-2.5 py-1.5 text-left text-[12.5px] transition-all duration-150 ${
                tab === t.id
                  ? 'bg-white/[0.07] text-white'
                  : 'text-ink-300 hover:bg-white/[0.04] hover:text-white'
              }`}
            >
              <span>{t.label}</span>
              {t.stub && (
                <span className="rounded bg-white/5 px-1 py-[1px] text-[9px] uppercase tracking-wider text-ink-400">
                  soon
                </span>
              )}
            </button>
          ))}
        </div>

        {/* Content */}
        <div className="flex min-w-0 flex-1 flex-col">
          <div className="flex h-11 shrink-0 items-center justify-between border-b border-white/[0.06] px-4">
            <div className="text-[13px] font-medium text-white">
              {TABS.find((t) => t.id === tab)?.label ?? ''}
            </div>
            <button
              onClick={onClose}
              className="rounded-md p-1 text-ink-400 transition hover:bg-white/[0.05] hover:text-white"
              title="Close (Esc)"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
                <path d="M3 3l10 10M13 3L3 13" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            {tab === 'observability' ? (
              <ObservabilityTab conversationId={conversationId} />
            ) : tab === 'heartbeat' ? (
              // Patch 64: full-bleed Heartbeat panel inside the tab.
              // Negative margin offsets the parent's p-4 so the heartbeat
              // chrome reaches the edges (it has its own padding).
              <div className="-m-4 h-[calc(100%+2rem)]">
                <Heartbeat />
              </div>
            ) : (
              <StubPanel id={tab} />
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

function StubPanel({ id }: { id: TabId }) {
  const copy: Record<TabId, string> = {
    observability: '',
    heartbeat: '',
    models: 'Model provider config + posture-gated cloud integrations. Patch 65 (#132).',
    sentinels:
      'Full sentinel editor — enable/disable, edit thresholds, validate YAMLs. Patch 65.',
    hitl: 'Approval queue: proposals from Mission / heartbeat that need a "go" before they execute. Patch 65.',
    about: 'App version, model versions, KG stats, link to source.'
  }
  return (
    <div className="rounded-lg border border-dashed border-white/[0.08] bg-white/[0.02] p-4 text-[12.5px] text-ink-300">
      <div className="text-ink-400">{copy[id]}</div>
    </div>
  )
}
