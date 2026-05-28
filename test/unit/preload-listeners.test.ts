/**
 * Wave B3 — Preload event-listener registration methods.
 *
 * The on* methods (onSetupStatus, onHeartbeatEvent, onMissionEvent,
 * onWorkspaceChanged, onRawChunk, onFileStreaming) each follow the same
 * shape: register an ipcRenderer.on listener on a specific channel, return
 * a cleanup function that removeListener's the exact same handler. The
 * cleanup contract is critical — renderer components call these in
 * useEffect setup and expect the returned function to fully detach on
 * unmount. A regression where the wrong listener reference is removed (or
 * the wrong channel) would leak handlers and cause memory growth or
 * duplicate-event delivery.
 *
 * Mocks:
 *   • vi.mock('electron') — same justification as preload-api.test.ts;
 *     Electron preload APIs are not present in vitest's node environment.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Api = Record<string, (cb: (...a: unknown[]) => unknown) => () => void>
type MockIpc = {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

let api: Api
let ipcRenderer: MockIpc

beforeEach(async () => {
  vi.resetModules()
  vi.doMock('electron', () => {
    const _ipc: MockIpc = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const _bridge = { exposeInMainWorld: vi.fn() }
    return { ipcRenderer: _ipc, contextBridge: _bridge }
  })
  const electron = (await import('electron')) as unknown as {
    ipcRenderer: MockIpc
    contextBridge: { exposeInMainWorld: ReturnType<typeof vi.fn> }
  }
  ipcRenderer = electron.ipcRenderer
  await import('../../src/preload/index')
  api = electron.contextBridge.exposeInMainWorld.mock.calls[0]?.[1] as Api
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
})

// Each row: [api method, expected channel name]
const cases: Array<[string, string]> = [
  ['onSetupStatus', 'setup:status'],
  ['onWorkspaceChanged', 'workspace:changed'],
  ['onRawChunk', 'chat:raw'],
  ['onFileStreaming', 'file:streaming'],
  ['onHeartbeatEvent', 'heartbeat:event'],
  ['onMissionEvent', 'mission:event']
]

describe('listener registration — channel correctness', () => {
  for (const [methodName, channel] of cases) {
    it(`${methodName} registers on the "${channel}" channel`, () => {
      // Would catch a regression where the channel string drifts from
      // what the main process emits — the renderer would silently never
      // receive the event.
      const cb = vi.fn()
      api[methodName](cb)
      const onCall = ipcRenderer.on.mock.calls.find((c) => c[0] === channel)
      expect(onCall, `no listener registered on ${channel}`).toBeDefined()
    })
  }
})

describe('listener cleanup — returned disposer removes the exact handler', () => {
  for (const [methodName, channel] of cases) {
    it(`${methodName} returns a disposer that removeListener's the original handler`, () => {
      // Would catch a regression where the cleanup function passes a
      // different function reference (e.g. wrapping again) — removeListener
      // would be a no-op and the listener would leak across mount/unmount
      // cycles.
      const cb = vi.fn()
      const dispose = api[methodName](cb)
      const registeredHandler = ipcRenderer.on.mock.calls.find((c) => c[0] === channel)?.[1]
      expect(registeredHandler).toBeTypeOf('function')

      expect(dispose).toBeTypeOf('function')
      dispose()

      expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, registeredHandler)
    })
  }
})

describe('listener invocation — strips IpcRendererEvent before user callback', () => {
  for (const [methodName, channel] of cases) {
    it(`${methodName} forwards the event payload (not the IpcRendererEvent) to the user callback`, () => {
      // Would catch a regression where the listener wrapper passes the
      // raw (event, payload) signature through to the user callback,
      // breaking every renderer consumer's type expectations.
      const cb = vi.fn()
      api[methodName](cb)
      const registered = ipcRenderer.on.mock.calls.find((c) => c[0] === channel)?.[1] as (
        ...a: unknown[]
      ) => unknown
      const fakeEvent = { sender: 'ipc-event-stub' }
      const payload = { hello: 'world' }
      registered(fakeEvent, payload)
      expect(cb).toHaveBeenCalledTimes(1)
      expect(cb).toHaveBeenCalledWith(payload)
    })
  }
})
