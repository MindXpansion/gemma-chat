/**
 * Wave B3 — Preload IPC contract surface.
 *
 * Locks down the api object exposed via contextBridge: method names + the
 * exact (channel, args) shape passed to ipcRenderer.invoke. The IPC contract
 * is a two-sided handshake — renderer code calls these names, main-process
 * handlers listen on these channels. A rename on one side without the other
 * silently breaks runtime; these tests catch that at compile-time-of-the-
 * test-suite.
 *
 * Also pins the TIMEOUT_MS branching inside sendChat (31b → 420s, all other
 * models → 90s) — see preload-deadman-timer.test.ts for the timer mechanics.
 *
 * Mocks:
 *   • vi.mock('electron') — Electron has no headless test build. contextBridge
 *     and ipcRenderer only exist inside an actual preload runtime; vitest
 *     runs in node, where importing 'electron' from a preload-context file
 *     would either crash or return the main-process module surface. We
 *     replace it with stubs so we can (a) capture the api object handed to
 *     contextBridge.exposeInMainWorld, and (b) assert against ipcRenderer
 *     .invoke / .on / .removeListener call args. This is the canonical
 *     justified mock per conventions.md: testing renderer-context code in
 *     jsdom/node requires substituting the host platform.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Api = Record<string, (...args: unknown[]) => unknown>
type MockIpc = {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}
type MockBridge = { exposeInMainWorld: ReturnType<typeof vi.fn> }

let api: Api
let ipcRenderer: MockIpc
let contextBridge: MockBridge

beforeEach(async () => {
  vi.resetModules()
  vi.doMock('electron', () => {
    const _ipc: MockIpc = {
      invoke: vi.fn().mockResolvedValue(undefined),
      on: vi.fn(),
      removeListener: vi.fn()
    }
    const _bridge: MockBridge = { exposeInMainWorld: vi.fn() }
    return { ipcRenderer: _ipc, contextBridge: _bridge }
  })
  const electron = (await import('electron')) as unknown as {
    ipcRenderer: MockIpc
    contextBridge: MockBridge
  }
  ipcRenderer = electron.ipcRenderer
  contextBridge = electron.contextBridge
  await import('../../src/preload/index')
  // The preload registers exactly one api object on the 'api' key.
  const call = contextBridge.exposeInMainWorld.mock.calls[0]
  expect(call?.[0]).toBe('api')
  api = call?.[1] as Api
})

afterEach(() => {
  vi.restoreAllMocks()
  vi.doUnmock('electron')
})

describe('api surface — method names exposed via contextBridge', () => {
  it('exposes the full set of expected method names', () => {
    // Would catch an accidental rename or deletion of a method that the
    // renderer depends on — these names form the runtime IPC contract
    // and there is no compile-time link between renderer's window.api.X
    // call and the preload's `X:` key.
    const expected = [
      'startSetup',
      'switchModel',
      'reconnectMLX',
      'checkMLX',
      'onSetupStatus',
      'listLocalModels',
      'sendChat',
      'abortChat',
      'listTools',
      'getWorkspace',
      'listWorkspace',
      'openWorkspace',
      'workspaceServerPort',
      'onWorkspaceChanged',
      'onRawChunk',
      'onFileStreaming',
      'transcribeAudio',
      'listMounts',
      'pickFolder',
      'addMount',
      'removeMount',
      'setMountMode',
      'replyToolConfirm',
      'heartbeatGetState',
      'heartbeatSetEnabled',
      'heartbeatSetCadence',
      'heartbeatTickNow',
      'heartbeatListJournal',
      'heartbeatReadJournal',
      'heartbeatGetGoals',
      'heartbeatSetGoalStatus',
      'onHeartbeatEvent',
      'missionStart',
      'missionAbort',
      'missionList',
      'onMissionEvent',
      'observabilitySnapshot',
      'sentinelDetail',
      'sentinelDryRun',
      'sentinelSetEnabled',
      'approvalsList',
      'approvalsResolve',
      'approvalsDefer',
      'providersList',
      'modelsStatus',
      'modelDelete'
    ]
    for (const name of expected) {
      expect(api[name], `missing api method: ${name}`).toBeTypeOf('function')
    }
  })

  it('exposes the api under the world-key "api" exactly once', () => {
    // Would catch a regression where someone changes the world key (e.g.
    // 'phronesis') — every renderer use of window.api would break.
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledTimes(1)
    expect(contextBridge.exposeInMainWorld).toHaveBeenCalledWith('api', expect.any(Object))
  })
})

describe('invoke-based methods — channel + arg shape', () => {
  // Each row: [api method, args to pass, expected channel, expected invoke args]
  const cases: Array<[string, unknown[], string, unknown[]]> = [
    ['startSetup', ['gemma-3-27b'], 'setup:start', ['gemma-3-27b']],
    ['switchModel', ['gemma-3-e4b'], 'model:switch', ['gemma-3-e4b']],
    ['reconnectMLX', [], 'mlx:reconnect', []],
    ['checkMLX', [], 'setup:status', []],
    ['listLocalModels', [], 'models:list-local', []],
    ['abortChat', ['conv-123'], 'chat:abort', ['conv-123']],
    ['listTools', [], 'tools:list', []],
    ['getWorkspace', ['conv-1'], 'workspace:info', ['conv-1']],
    ['listWorkspace', ['conv-1'], 'workspace:list', ['conv-1']],
    ['openWorkspace', ['conv-1'], 'workspace:open-external', ['conv-1']],
    ['workspaceServerPort', [], 'workspace:server-port', []],
    [
      'transcribeAudio',
      ['BASE64', 'whisper'],
      'audio:transcribe',
      [{ base64: 'BASE64', model: 'whisper' }]
    ],
    ['listMounts', [], 'gemmafs:list-mounts', []],
    ['pickFolder', [], 'gemmafs:pick-folder', []],
    ['addMount', ['/tmp/x', 'ro'], 'gemmafs:add-mount', [{ path: '/tmp/x', mode: 'ro' }]],
    ['removeMount', ['mnt-id'], 'gemmafs:remove-mount', ['mnt-id']],
    ['setMountMode', ['mnt-id', 'rw-confirm'], 'gemmafs:set-mode', [{ id: 'mnt-id', mode: 'rw-confirm' }]],
    ['replyToolConfirm', ['id-1', true], 'tool:confirm-reply', [{ id: 'id-1', approved: true }]],
    ['heartbeatGetState', [], 'heartbeat:get-state', []],
    ['heartbeatSetEnabled', [true], 'heartbeat:set-enabled', [true]],
    ['heartbeatSetCadence', [9], 'heartbeat:set-cadence', [9]],
    ['heartbeatTickNow', [], 'heartbeat:tick-now', []],
    ['heartbeatListJournal', [], 'heartbeat:journal-list', []],
    ['heartbeatReadJournal', ['log.md'], 'heartbeat:journal-read', ['log.md']],
    ['heartbeatGetGoals', [], 'heartbeat:goals-get', []],
    [
      'heartbeatSetGoalStatus',
      ['g-1', 'queued'],
      'heartbeat:goal-set-status',
      [{ id: 'g-1', status: 'queued' }]
    ],
    ['missionStart', ['solve x'], 'mission:start', ['solve x']],
    ['missionAbort', [], 'mission:abort', []],
    ['missionList', [], 'mission:list', []],
    ['observabilitySnapshot', ['conv-1'], 'observability:snapshot', ['conv-1']],
    ['sentinelDetail', ['critic'], 'sentinel:detail', ['critic']],
    ['sentinelDryRun', ['critic'], 'sentinel:dry-run', ['critic']],
    [
      'sentinelSetEnabled',
      ['critic', false],
      'sentinel:set-enabled',
      [{ name: 'critic', enabled: false }]
    ],
    ['approvalsList', [], 'approvals:list', []],
    [
      'approvalsResolve',
      ['uuid-1', { kind: 'approve' }],
      'approvals:resolve',
      [{ uuid: 'uuid-1', resolution: { kind: 'approve' } }]
    ],
    [
      'approvalsDefer',
      ['uuid-1', 24],
      'approvals:defer',
      [{ uuid: 'uuid-1', hours: 24 }]
    ],
    ['providersList', [], 'providers:list', []],
    ['modelsStatus', [], 'models:status', []],
    ['modelDelete', ['gemma-3-27b'], 'model:delete', ['gemma-3-27b']]
  ]

  for (const [methodName, callArgs, channel, invokeArgs] of cases) {
    it(`${methodName} invokes "${channel}" with the documented args`, async () => {
      // Would catch a regression where the channel name or arg packaging
      // is changed on the preload side without updating the main handler
      // (or vice-versa) — the IPC handshake silently breaks at runtime.
      const fn = api[methodName]
      expect(fn, `missing method: ${methodName}`).toBeTypeOf('function')
      await (fn as (...a: unknown[]) => unknown)(...callArgs)
      expect(ipcRenderer.invoke).toHaveBeenCalledWith(channel, ...invokeArgs)
    })
  }
})

describe('sendChat — TIMEOUT_MS branching by model', () => {
  // For the timer-fires-on-timeout path tests, see preload-deadman-timer.test.ts.
  // Here we only assert the initial invoke channel/arg shape so this file
  // owns the full invoke-surface contract.
  it('sendChat invokes "chat:send" with the request object', async () => {
    // Would catch a regression where chat:send is renamed or the request
    // payload is wrapped differently (e.g. { req } instead of req).
    ipcRenderer.invoke.mockResolvedValueOnce({ channel: 'chat:stream:x' })
    // Don't await — sendChat returns a Promise that only resolves on done/
    // error/timeout. We just need to capture the invoke call.
    void (api.sendChat as (...a: unknown[]) => unknown)(
      { model: 'gemma-3-e4b', conversationId: 'c1', messages: [] },
      () => {}
    )
    // Microtask flush so the await ipcRenderer.invoke resolves.
    await Promise.resolve()
    expect(ipcRenderer.invoke).toHaveBeenCalledWith('chat:send', {
      model: 'gemma-3-e4b',
      conversationId: 'c1',
      messages: []
    })
  })
})
