/**
 * Wave B3 — sendChat dead-man timer behavior.
 *
 * The dead-man timer at src/preload/index.ts:48-87 is the subject of
 * Patches 7, 71, and 71.1. It is the user-facing failure mode when MLX is
 * slow or wedged: if NO chunk (token / tool / activity / done / error)
 * arrives within TIMEOUT_MS, the renderer would otherwise hang on
 * `await api.sendChat(...)` forever. The timer synthesizes an 'error' chunk
 * and invokes chat:abort to unblock both sides.
 *
 * This file exhaustively covers:
 *   • Timer fires after TIMEOUT_MS with no chunks → emits "no response" error
 *   • Every received chunk resets the timer (the Patch 7 invariant)
 *   • Timer cancelled on 'done' chunk; listener removed
 *   • Timer cancelled on 'error' chunk; listener removed
 *   • abortChat invocation on timeout (with the right conversationId)
 *   • Listener cleanup on every terminal path
 *   • TIMEOUT_MS branching: 31b → 420_000ms, other → 90_000ms (Patch 71-era)
 *
 * Mocks:
 *   • vi.mock('electron') — see preload-api.test.ts docstring; same
 *     justification, Electron is not embeddable in vitest's node env.
 *   • vi.useFakeTimers() — the timer under test is 90_000ms (or 420_000ms
 *     for 31b). Real wall-clock would make a single test take 90+ seconds,
 *     which is exactly the bug we're testing against. Fake timers are the
 *     only correct way to assert "the timer fires at exactly TIMEOUT_MS,
 *     not before, not after". Per conventions.md, time-dependent behavior
 *     is an explicitly listed mock-justified case.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

type Api = Record<string, (...args: unknown[]) => unknown>
type Listener = (event: unknown, chunk: unknown) => void
type MockIpc = {
  invoke: ReturnType<typeof vi.fn>
  on: ReturnType<typeof vi.fn>
  removeListener: ReturnType<typeof vi.fn>
}

const TIMEOUT_DEFAULT = 90_000
const TIMEOUT_31B = 420_000

let api: Api
let ipcRenderer: MockIpc

async function loadPreload(): Promise<void> {
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
}

/**
 * Helper: starts a sendChat call, returns the registered chunk-listener and
 * the chunks delivered to the consumer. Caller controls timing via
 * vi.advanceTimersByTimeAsync() and invokes `listener(null, chunk)` to
 * simulate chunks arriving from main.
 */
async function startChat(
  model: string,
  conversationId = 'conv-1'
): Promise<{
  donePromise: Promise<void>
  listener: Listener
  received: unknown[]
  channel: string
}> {
  const channel = 'chat:stream:x'
  ipcRenderer.invoke.mockResolvedValueOnce({ channel })
  const received: unknown[] = []
  const donePromise = (api.sendChat as (req: unknown, cb: (c: unknown) => void) => Promise<void>)(
    { model, conversationId, messages: [] },
    (c) => received.push(c)
  )
  // Let the initial `await ipcRenderer.invoke('chat:send', req)` resolve and
  // the listener get registered.
  await vi.advanceTimersByTimeAsync(0)
  await Promise.resolve()
  await Promise.resolve()
  const onCall = ipcRenderer.on.mock.calls.find((c) => c[0] === channel)
  if (!onCall) throw new Error('listener was not registered on the stream channel')
  const listener = onCall[1] as Listener
  return { donePromise, listener, received, channel }
}

beforeEach(async () => {
  vi.useFakeTimers()
  await loadPreload()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  vi.doUnmock('electron')
})

describe('dead-man timer — fires on silence', () => {
  it('fires after exactly TIMEOUT_MS with no chunks and emits a synthetic error chunk', async () => {
    // Would catch a regression where Patch 7's safety net is broken — e.g.
    // armTimer() isn't called on initial setup, or the timeout duration is
    // wrong, or the synthetic error chunk isn't delivered. Without this
    // chunk the renderer's `await api.sendChat()` hangs forever.
    const { donePromise, received } = await startChat('gemma-3-e4b')

    // Just before timeout: no error chunk yet.
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT - 1)
    expect(received).toHaveLength(0)

    // Cross the threshold.
    await vi.advanceTimersByTimeAsync(1)
    await donePromise

    expect(received).toHaveLength(1)
    const chunk = received[0] as { type: string; error: string }
    expect(chunk.type).toBe('error')
    expect(chunk.error).toMatch(/no response/i)
    expect(chunk.error).toMatch(/90s/)
  })

  it('on timeout, invokes chat:abort with the conversationId (best-effort)', async () => {
    // Would catch a regression where the timer fires but main-side cleanup
    // is skipped — orphaning the MLX request and leaking the scheduler lock
    // (the original Patch 7 motivation: dual-sided teardown).
    const { donePromise } = await startChat('gemma-3-e4b', 'conv-xyz')
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT)
    await donePromise

    expect(ipcRenderer.invoke).toHaveBeenCalledWith('chat:abort', 'conv-xyz')
  })

  it('on timeout, removes the stream listener', async () => {
    // Would catch a leak where the listener is left attached after a
    // timeout — subsequent chunks (if main eventually unwedges) would
    // fire the onChunk callback after the consumer has moved on.
    const { donePromise, listener, channel } = await startChat('gemma-3-e4b')
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT)
    await donePromise

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)
  })

  it('still resolves the sendChat promise on timeout (does not reject)', async () => {
    // Would catch a regression where someone changes resolve(...) to
    // reject(...) inside the timer callback — the renderer's await would
    // throw instead of receiving the error chunk through onChunk, breaking
    // the contract Patch 7 established.
    const { donePromise } = await startChat('gemma-3-e4b')
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT)
    await expect(donePromise).resolves.toBeUndefined()
  })
})

describe('dead-man timer — re-armed by every chunk', () => {
  it('re-arms on each chunk: chunks at TIMEOUT-1 keep the call alive indefinitely', async () => {
    // The Patch 7 invariant: ANY signal of life resets the clock. Without
    // re-arming, a slow-but-progressing stream would be killed mid-token.
    // Would catch a regression where armTimer() is removed from the chunk
    // path or the timer isn't actually cleared before the new setTimeout.
    const { donePromise, listener, received } = await startChat('gemma-3-e4b')

    // Three "almost timed out, then a chunk" cycles.
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT - 1)
      listener(null, { type: 'token', text: `t${i}` })
      // No timeout chunk should appear.
      expect(received.some((c) => (c as { type: string }).type === 'error')).toBe(false)
    }
    // Three real tokens delivered, zero error chunks.
    expect(received.filter((c) => (c as { type: string }).type === 'token')).toHaveLength(3)

    // Now go silent — the timer should fire after one full TIMEOUT_MS.
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT)
    await donePromise
    expect((received.at(-1) as { type: string }).type).toBe('error')
  })

  it('a chunk that arrives just before timeout still resets the clock fully', async () => {
    // Would catch an off-by-one where the timer is cleared but not re-armed,
    // or re-armed with the remaining budget instead of a fresh TIMEOUT_MS.
    const { donePromise, listener, received } = await startChat('gemma-3-e4b')

    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT - 1)
    listener(null, { type: 'activity', activity: 'thinking' })

    // After the chunk, advancing by TIMEOUT_DEFAULT - 1 again must NOT fire.
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT - 1)
    expect(received.filter((c) => (c as { type: string }).type === 'error')).toHaveLength(0)

    // One more ms crosses the threshold.
    await vi.advanceTimersByTimeAsync(1)
    await donePromise
    expect((received.at(-1) as { type: string }).type).toBe('error')
  })
})

describe('dead-man timer — terminal chunks cancel cleanly', () => {
  it("cancels the timer on a 'done' chunk and removes the listener", async () => {
    // Would catch a regression where the timer continues to run after
    // 'done', firing later and either calling abortChat on a completed
    // request or hitting an already-detached listener (no-op but noisy).
    const { donePromise, listener, channel, received } = await startChat('gemma-3-e4b')

    listener(null, { type: 'token', text: 'hi' })
    listener(null, { type: 'done' })
    await donePromise

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)

    // Advance well past TIMEOUT_MS to confirm the timer was actually cleared.
    const invokeCallsAtDone = ipcRenderer.invoke.mock.calls.length
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT * 2)
    // No extra chat:abort invocation, no extra error chunk.
    expect(ipcRenderer.invoke.mock.calls.length).toBe(invokeCallsAtDone)
    expect(received.filter((c) => (c as { type: string }).type === 'error')).toHaveLength(0)
  })

  it("cancels the timer on an 'error' chunk and removes the listener", async () => {
    // Would catch a regression where main-side errors don't tear down the
    // renderer-side timer — leading to a phantom second 'error' chunk
    // ~TIMEOUT_MS later.
    const { donePromise, listener, channel, received } = await startChat('gemma-3-e4b')

    listener(null, { type: 'error', error: 'main blew up' })
    await donePromise

    expect(ipcRenderer.removeListener).toHaveBeenCalledWith(channel, listener)
    expect(received).toEqual([{ type: 'error', error: 'main blew up' }])

    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT * 2)
    expect(received).toHaveLength(1)
  })
})

describe('dead-man timer — TIMEOUT_MS branching by model id', () => {
  it('non-31b model uses the 90s budget', async () => {
    // Would catch a regression that flips the includes('31b') check or
    // changes the default budget — fast models would either time out too
    // late or too early.
    const { donePromise, received } = await startChat('gemma-3-e4b')
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT - 1)
    expect(received).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(1)
    await donePromise
    expect((received[0] as { error: string }).error).toMatch(/90s/)
  })

  it('non-31b model does NOT fire at the 31b budget (must use 90s, not 420s)', async () => {
    // Would catch a regression where the ternary is inverted — non-31b
    // models would get the 7-minute budget and slow MLX hangs would go
    // undetected for 5+ minutes longer than designed.
    const { donePromise, received } = await startChat('gemma-3-e4b')
    // Past the 90s budget — must already have timed out.
    await vi.advanceTimersByTimeAsync(TIMEOUT_DEFAULT + 1)
    await donePromise
    expect(received).toHaveLength(1)
  })

  it('31b model uses the 420s budget and the label reads "7 min"', async () => {
    // Would catch a regression where 31b loses its extended budget — first-
    // token latency on a dense 31B model under load can exceed 90s
    // legitimately (see Patch 7 commit), so a 90s ceiling would falsely
    // abort real work.
    const { donePromise, received } = await startChat('gemma-3-31b')

    // Just before the extended timeout: nothing fired.
    await vi.advanceTimersByTimeAsync(TIMEOUT_31B - 1)
    expect(received).toHaveLength(0)
    // At 90s (the default budget), still nothing.
    expect(received).toHaveLength(0)

    await vi.advanceTimersByTimeAsync(1)
    await donePromise
    const chunk = received[0] as { type: string; error: string }
    expect(chunk.type).toBe('error')
    // TIMEOUT_LABEL formats >=120_000ms as minutes: 420_000/60_000 = 7.
    expect(chunk.error).toMatch(/7 min/)
  })
})
