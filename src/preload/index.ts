import { contextBridge, ipcRenderer, IpcRendererEvent } from 'electron'
import type {
  ChatRequest,
  SetupStatus,
  StreamChunk,
  WorkspaceInfo,
  WorkspaceFile
} from '../shared/types'

const api = {
  startSetup: (model: string): Promise<void> => ipcRenderer.invoke('setup:start', model),

  switchModel: (model: string): Promise<void> => ipcRenderer.invoke('model:switch', model),

  checkMLX: (): Promise<{ hasMLX: boolean }> => ipcRenderer.invoke('setup:status'),

  onSetupStatus: (cb: (s: SetupStatus) => void): (() => void) => {
    const listener = (_: IpcRendererEvent, s: SetupStatus): void => cb(s)
    ipcRenderer.on('setup:status', listener)
    return () => ipcRenderer.removeListener('setup:status', listener)
  },

  listLocalModels: (): Promise<string[]> => ipcRenderer.invoke('models:list-local'),

  sendChat: async (req: ChatRequest, onChunk: (c: StreamChunk) => void): Promise<void> => {
    const { channel } = (await ipcRenderer.invoke('chat:send', req)) as { channel: string }
    // Patch 7: client-side dead-man timer. If 90s pass without ANY chunk
    // from main (token, tool, activity, anything), assume main-side hang
    // and synthesize an error so the renderer's existing handler unblocks.
    // Pairs with the abortChat invocation to ensure the main-side
    // AbortController fires too.
    const TIMEOUT_MS = 90_000
    return new Promise((resolve) => {
      let timer: ReturnType<typeof setTimeout> | null = null
      const armTimer = (): void => {
        if (timer != null) clearTimeout(timer)
        timer = setTimeout(() => {
          ipcRenderer.removeListener(channel, listener)
          ipcRenderer.invoke('chat:abort', req.conversationId).catch(() => { /* best effort */ })
          onChunk({
            type: 'error',
            error: `No response from model in ${TIMEOUT_MS / 1000}s — the request was aborted. The model server may be hung or out of memory.`
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
    ipcRenderer.invoke('audio:transcribe', { base64, model })
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
