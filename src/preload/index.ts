import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  ChatRequest,
  SetupStatus,
  StreamChunk,
  WorkspaceInfo,
  WorkspaceFile,
  HeartbeatState,
  HeartbeatEvent,
  HeartbeatTickResult,
  HeartbeatJournalEntry,
  HeartbeatGoal,
  Mission,
  MissionEvent
} from '../shared/types'
import type { ObservabilitySnapshot } from '../shared/observability-types'

const api = {
  startSetup: (model: string): Promise<void> => ipcRenderer.invoke('setup:start', model),

  switchModel: (model: string): Promise<void> => ipcRenderer.invoke('model:switch', model),

  // Patch 9: explicit Reconnect — restart the currently-loaded MLX server
  // when the model has died or is unresponsive (paired with Patch 7's 90s
  // timeout error). Main emits setup:status during restart.
  reconnectMLX: (): Promise<{ ok: true }> => ipcRenderer.invoke('mlx:reconnect'),

  checkMLX: (): Promise<{ hasMLX: boolean }> => ipcRenderer.invoke('setup:status'),

  onSetupStatus: (cb: (s: SetupStatus) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, s: SetupStatus): void => cb(s)
    ipcRenderer.on('setup:status', listener)
    return () => ipcRenderer.removeListener('setup:status', listener)
  },

  listLocalModels: (): Promise<string[]> => ipcRenderer.invoke('models:list-local'),

  sendChat: async (req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<void> => {
    const { channel } = (await ipcRenderer.invoke('chat:send', req)) as { channel: string }
    // Patch 7: client-side dead-man timer. If TIMEOUT_MS passes without ANY
    // chunk from main (token, tool, activity, anything), assume a main-side
    // hang and synthesize an error so the renderer's handler unblocks.
    // Pairs with the abortChat invocation so the main-side AbortController
    // fires too.
    //
    // The dense 31B model runs all 31B params per token, so first-token
    // latency on a large prompt can run into minutes. It gets a 7-minute
    // budget; the fast E4B / 27B-MoE models keep the 90s budget, where a
    // long silence genuinely means something is wrong.
    const TIMEOUT_MS = req.model.includes('31b') ? 420_000 : 90_000
    const TIMEOUT_LABEL =
      TIMEOUT_MS >= 120_000
        ? `${Math.round(TIMEOUT_MS / 60_000)} min`
        : `${TIMEOUT_MS / 1000}s`
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const armTimer = (): void => {
        if (timer != null) clearTimeout(timer)
        timer = setTimeout(() => {
          ipcRenderer.removeListener(channel, listener)
          ipcRenderer.invoke('chat:abort', req.conversationId).catch(() => { /* best effort */ })
          onChunk({
            type: 'error',
            error: `No response from model in ${TIMEOUT_LABEL} — the request was aborted. The model server may be hung or out of memory.`
          })
          resolve()
        }, TIMEOUT_MS)
      }
      const listener = (_: IpcRendererEvent, chunk: StreamChunk): void => {
        armTimer()
        onChunk(chunk)
        if (chunk.type === 'done' || chunk.type === 'error') {
          if (timer != null) clearTimeout(timer)
          ipcRenderer.removeListener(channel, listener)
          resolve()
        }
      }
      ipcRenderer.on(channel, listener)
      armTimer()
    })
  },

  abortChat: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke('chat:abort', conversationId),

  listTools: (): Promise<Array<{ name: string; description: string; mode: string }>> =>
    ipcRenderer.invoke('tools:list'),

  getWorkspace: (conversationId: string): Promise<WorkspaceInfo> =>
    ipcRenderer.invoke('workspace:info', conversationId),

  listWorkspace: (conversationId: string): Promise<WorkspaceFile[]> =>
    ipcRenderer.invoke('workspace:list', conversationId),

  openWorkspace: (conversationId: string): Promise<void> =>
    ipcRenderer.invoke('workspace:open-external', conversationId),

  workspaceServerPort: (): Promise<number> => ipcRenderer.invoke('workspace:server-port'),

  onWorkspaceChanged: (cb: (ev: { conversationId: string }) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, ev: { conversationId: string }): void => cb(ev)
    ipcRenderer.on('workspace:changed', listener)
    return () => ipcRenderer.removeListener('workspace:changed', listener)
  },

  onRawChunk: (
    cb: (ev: { conversationId: string; chunk: string }) => void
  ): (() => void) => {
    const listener = (
      _: IpcRendererEvent,
      ev: { conversationId: string; chunk: string }
    ): void => cb(ev)
    ipcRenderer.on('chat:raw', listener)
    return () => ipcRenderer.removeListener('chat:raw', listener)
  },

  onFileStreaming: (
    cb: (ev: { conversationId: string; path: string; content: string; done: boolean }) => void
  ): (() => void) => {
    const listener = (
      _: IpcRendererEvent,
      ev: { conversationId: string; path: string; content: string; done: boolean }
    ): void => cb(ev)
    ipcRenderer.on('file:streaming', listener)
    return () => ipcRenderer.removeListener('file:streaming', listener)
  },

  transcribeAudio: (base64: string, model: string): Promise<{ text: string }> =>
    ipcRenderer.invoke('audio:transcribe', { base64, model }),

  // Patch 31 L2: Gemma filesystem mount management
  listMounts: (): Promise<GemmaMount[]> => ipcRenderer.invoke('gemmafs:list-mounts'),
  pickFolder: (): Promise<string | null> => ipcRenderer.invoke('gemmafs:pick-folder'),
  addMount: (path: string, mode: MountMode): Promise<GemmaMount> =>
    ipcRenderer.invoke('gemmafs:add-mount', { path, mode }),
  removeMount: (id: string): Promise<boolean> =>
    ipcRenderer.invoke('gemmafs:remove-mount', id),
  setMountMode: (id: string, mode: MountMode): Promise<boolean> =>
    ipcRenderer.invoke('gemmafs:set-mode', { id, mode }),

  // Patch 31 L3: answer an rw-confirm prompt
  replyToolConfirm: (id: string, approved: boolean): Promise<void> =>
    ipcRenderer.invoke('tool:confirm-reply', { id, approved }),

  // Patch 34: Autonomous Heartbeat controls
  heartbeatGetState: (): Promise<HeartbeatState> =>
    ipcRenderer.invoke('heartbeat:get-state'),
  heartbeatSetEnabled: (on: boolean): Promise<HeartbeatState> =>
    ipcRenderer.invoke('heartbeat:set-enabled', on),
  heartbeatSetCadence: (minutes: number): Promise<HeartbeatState> =>
    ipcRenderer.invoke('heartbeat:set-cadence', minutes),
  heartbeatTickNow: (): Promise<HeartbeatTickResult> =>
    ipcRenderer.invoke('heartbeat:tick-now'),
  heartbeatListJournal: (): Promise<HeartbeatJournalEntry[]> =>
    ipcRenderer.invoke('heartbeat:journal-list'),
  heartbeatReadJournal: (name: string): Promise<string> =>
    ipcRenderer.invoke('heartbeat:journal-read', name),
  heartbeatGetGoals: (): Promise<HeartbeatGoal[]> =>
    ipcRenderer.invoke('heartbeat:goals-get'),
  heartbeatSetGoalStatus: (
    id: string,
    status: 'queued' | 'skipped'
  ): Promise<HeartbeatGoal[]> =>
    ipcRenderer.invoke('heartbeat:goal-set-status', { id, status }),
  onHeartbeatEvent: (cb: (ev: HeartbeatEvent) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, ev: HeartbeatEvent): void => cb(ev)
    ipcRenderer.on('heartbeat:event', listener)
    return () => ipcRenderer.removeListener('heartbeat:event', listener)
  },

  // Patch 35: Mission Mode
  missionStart: (
    objective: string
  ): Promise<{ ok: boolean; missionId?: string; error?: string }> =>
    ipcRenderer.invoke('mission:start', objective),
  missionAbort: (): Promise<boolean> => ipcRenderer.invoke('mission:abort'),
  missionList: (): Promise<Mission[]> => ipcRenderer.invoke('mission:list'),
  onMissionEvent: (cb: (ev: MissionEvent) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, ev: MissionEvent): void => cb(ev)
    ipcRenderer.on('mission:event', listener)
    return () => ipcRenderer.removeListener('mission:event', listener)
  },

  // Patch 63 (Block D #130): Settings Dashboard observability snapshot.
  observabilitySnapshot: (conversationId: string): Promise<ObservabilitySnapshot> =>
    ipcRenderer.invoke('observability:snapshot', conversationId)
}

export type MountMode = 'ro' | 'rw-confirm' | 'rw-free'
export interface GemmaMount {
  id: string
  name: string
  path: string
  mode: MountMode
  indexed: boolean
  indexedAt?: number
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
