export type SetupStage =
  | 'checking'
  | 'installing-mlx'
  | 'starting-mlx'
  | 'downloading-model'
  | 'ready'
  | 'error'

export interface SetupStatus {
  stage: SetupStage
  message: string
  progress?: number
  bytesDone?: number
  bytesTotal?: number
  error?: string
}

export interface ToolCall {
  id: string
  name: string
  args: Record<string, unknown>
  result?: string
  error?: string
  running?: boolean
}

export type Role = 'user' | 'assistant' | 'system' | 'tool'

export interface ChatMessage {
  id: string
  role: Role
  content: string
  toolCalls?: ToolCall[]
  createdAt: number
  model?: string
  done?: boolean
  activity?: AgentActivity
  /** Patch 13: data URLs (data:image/...;base64,...) attached to user messages for multimodal input */
  images?: string[]
}

export type AgentMode = 'chat' | 'code'

export interface ChatRequest {
  conversationId: string
  messages: Array<{ role: Role; content: string; toolCalls?: ToolCall[]; images?: string[] }>
  model: string
  enableTools: boolean
  mode: AgentMode
}

export interface WorkspaceInfo {
  conversationId: string
  path: string
  previewUrl: string
}

export interface WorkspaceFile {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

export interface FileChangeEvent {
  conversationId: string
}

export type AgentActivity =
  | { kind: 'idle' }
  | { kind: 'thinking'; chars?: number }
  | { kind: 'generating'; chars?: number }
  | { kind: 'tool'; tool: string; target?: string; chars?: number }

/** Patch 31 L3: a write/bash op on an rw-confirm mount, awaiting Bear's call. */
export interface ConfirmPayload {
  tool: string
  root: string
  action: string
  detail?: string
}

export type StreamChunk =
  | { type: 'token'; text: string }
  | { type: 'tool_call'; call: ToolCall }
  | { type: 'tool_result'; id: string; result?: string; error?: string }
  | { type: 'activity'; activity: AgentActivity }
  | { type: 'tool_confirm'; id: string; payload: ConfirmPayload }
  | { type: 'done' }
  | { type: 'error'; error: string }

export interface ModelInfo {
  /** HuggingFace repo ID — used internally for mlx_vlm */
  name: string
  /** Short, user-friendly display name */
  label: string
  size: string
  sizeBytes: number
  description: string
  recommended?: boolean
}

export const AVAILABLE_MODELS: ModelInfo[] = [
  {
    name: 'mlx-community/gemma-4-e2b-it-4bit',
    label: 'Gemma 4 E2B',
    size: '1.5 GB',
    sizeBytes: 1_500_000_000,
    description: 'Edge-sized. Fast & lightweight. Text + image + audio. Runs on 8GB+ Macs.'
  },
  {
    name: 'mlx-community/gemma-4-e4b-it-4bit',
    label: 'Gemma 4 E4B',
    size: '3 GB',
    sizeBytes: 3_000_000_000,
    description: 'Best all-rounder. Text + image + audio. Runs on 8GB+ Macs.',
    recommended: true
  },
  {
    name: 'mlx-community/gemma-4-26b-a4b-it-4bit',
    label: 'Gemma 4 27B MoE',
    size: '16 GB',
    sizeBytes: 16_000_000_000,
    description: 'Mixture-of-Experts (26B, 4B active). 16GB+ RAM recommended.'
  },
  {
    name: 'mlx-community/gemma-4-31b-it-4bit',
    label: 'Gemma 4 31B',
    size: '18 GB',
    sizeBytes: 18_000_000_000,
    description: 'Frontier dense model. Best quality. 32GB+ RAM recommended.'
  }
]

export const DEFAULT_MODEL = 'mlx-community/gemma-4-e4b-it-4bit'

/**
 * Patch 34: Autonomous Heartbeat. A main-process timer fires self-directed
 * research ticks on a cadence. Each tick runs a fresh-context, offline-safe
 * tool loop and appends a dated journal file to ~/GemmaWorkspace/research/.
 */
export interface HeartbeatState {
  enabled: boolean
  cadenceMinutes: number
  tickCount: number
  lastTickAt?: number
  lastTickStatus?: 'ok' | 'skipped' | 'error'
  lastError?: string
  /** true while a tick is currently running */
  ticking: boolean
  /** Patch 40: rolling-60min ledger of auto-promoted primary goals (rate cap). */
  primaryGoalLedger?: Array<{ id: string; promotedAt: number }>
  /** Patch 40: ticks since the last review (synthesis) tick. */
  ticksSinceReview?: number
  /** Patch 43 (adaptive cadence): MINIMUM delay between ticks when work is
   *  pending (in-progress goal, queued follow-up, or queued primary with
   *  ledger room). cadenceMinutes now acts as the MAX (idle) delay; this
   *  is the floor when she's actively researching. */
  minCadenceSeconds?: number
}

export interface HeartbeatTickResult {
  status: 'ok' | 'skipped' | 'error'
  journalPath?: string
  summary?: string
  error?: string
}

export interface HeartbeatJournalEntry {
  name: string
  mtimeMs: number
  size: number
}

/**
 * Patch 34 L3: a goal in the heartbeat's queue. Gemma proposes goals on a
 * planning tick; Bear ratifies them (proposed -> queued / skipped); a work
 * tick runs the oldest queued goal as a probe.
 */
export interface HeartbeatGoal {
  id: string
  title: string
  instruction: string
  status: 'proposed' | 'queued' | 'in_progress' | 'done' | 'skipped'
  createdAt: number
  completedAt?: number
  journalFile?: string
  summary?: string
  /** Patch 40 — optional, backward compatible with pre-Patch-40 persisted goals. */
  /** primary = from plan-tick; follow_up = emitted by a consolidate-tick. */
  kind?: 'primary' | 'follow_up'
  /** For follow-ups: id of the primary that spawned this. */
  parentId?: string
  /** For primaries: how many follow-ups spawned so far (cap = 4). */
  followUpCount?: number
  /** Sub-stage when status='in_progress'. */
  phase?: 'dedupe' | 'probe' | 'consolidate'
  /** Patch 41: tool that ran in the probe phase, preserved for the
   *  consolidate phase to write the real tool_name on the :HeartbeatObservation
   *  (previously hardcoded "(prior probe)"). */
  lastToolUsed?: string
  /** Cached dedupe-check classification, set during the dedupe phase. */
  dedupe?: {
    classification: 'COVERED' | 'ADJACENT' | 'NOVEL' | 'SPARSE'
    topScore: number
    topUuid?: string
    topText?: string
    topTopic?: string
  }
  /** Set after the consolidate phase writes the :HeartbeatObservation. */
  observationUuid?: string
}

/**
 * Patch 35 — Mission Mode. A mission is an objective Bear assigns; the
 * engine decomposes it into probe-sized steps and executes them
 * back-to-back, unattended, until done or stuck.
 */
export interface MissionStep {
  id: string
  instruction: string
  status: 'pending' | 'running' | 'done' | 'failed'
  journalFile?: string
  summary?: string
}

export interface Mission {
  id: string
  objective: string
  status: 'decomposing' | 'running' | 'done' | 'stuck' | 'aborted'
  steps: MissionStep[]
  model: string
  createdAt: number
  startedAt?: number
  completedAt?: number
  error?: string
}

export type MissionEvent =
  | { type: 'missions'; missions: Mission[] }
  | { type: 'mission-tool'; missionId: string; tool: string }

export type HeartbeatEvent =
  | { type: 'state'; state: HeartbeatState }
  | { type: 'goals'; goals: HeartbeatGoal[] }
  | { type: 'tick-start'; tick: number; objective: string }
  | { type: 'tick-tool'; tick: number; tool: string }
  | {
      type: 'tick-end'
      tick: number
      status: 'ok' | 'skipped' | 'error'
      journalPath?: string
      summary?: string
      error?: string
    }

