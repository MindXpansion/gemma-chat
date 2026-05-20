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

export type HeartbeatEvent =
  | { type: 'state'; state: HeartbeatState }
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

