/**
 * Wave B2 — mission state / lifecycle guard unit tests.
 *
 * Covers the input-validation branches of the public mission API that fire
 * BEFORE any disk write or MLX call (and therefore work in a plain Node test
 * environment with no Electron `app` and no MLX subprocess):
 *   • isMissionActive  — singleton activeAbort sentinel.
 *   • getMissions      — pure (returns a defensive deep-ish copy of state).
 *   • abortMission     — no-op when no mission is active.
 *   • startMission     — the four early-return guards (empty objective,
 *                        another mission already running, no model loaded,
 *                        chat is streaming).
 *
 * Mocks: none. The module's `initMission` hook is normally what wires
 * `getModel` / `isChatBusy` from the chat layer; since we never call
 * initMission here, the defaults (`() => null` and `() => false`) are
 * exactly the conditions we want to assert against — startMission's
 * "no model" branch fires naturally without any mocking.
 *
 * Why this file exists separately from mission-parser.test.ts: the parser
 * tests cover only pure-string logic; this file covers the singleton state
 * machine, which needs its own module reload between tests to keep one
 * test's `activeAbort` from leaking into the next.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

type MissionModule = typeof import('../../src/main/mission')
let mod: MissionModule

beforeEach(async () => {
  // Fresh module each test so `activeAbort`, `missions`, and the hook
  // closures don't leak between tests.
  vi.resetModules()
  mod = await import('../../src/main/mission')
})

describe('isMissionActive', () => {
  it('returns false before any mission has been started', () => {
    // Would catch a regression where the activeAbort sentinel was
    // initialized to a non-null value, making the UI think the engine was
    // perpetually busy on a fresh app boot.
    expect(mod.isMissionActive()).toBe(false)
  })
})

describe('getMissions', () => {
  it('returns an empty array on a fresh module (no history loaded)', () => {
    // Would catch a regression where the initial state was undefined or a
    // non-array — the renderer assumes .map() works on the result.
    const ms = mod.getMissions()
    expect(Array.isArray(ms)).toBe(true)
    expect(ms).toHaveLength(0)
  })

  it('returns a defensive copy — caller mutations do not leak into state', () => {
    // Would catch a regression that returned the internal missions array
    // by reference; a stray push() in the renderer would then silently
    // corrupt the engine's history list.
    const a = mod.getMissions()
    const b = mod.getMissions()
    expect(a).not.toBe(b)
    a.push({
      id: 'fake',
      objective: 'should not appear',
      status: 'done',
      steps: [],
      model: 'm',
      createdAt: 0
    })
    expect(mod.getMissions()).toHaveLength(0)
  })
})

describe('abortMission', () => {
  it('returns false when no mission is currently active', () => {
    // Would catch a regression that returned true unconditionally — the IPC
    // surface uses the boolean to decide whether to surface "aborted" UI.
    expect(mod.abortMission()).toBe(false)
  })
})

describe('startMission — input-validation guards (no MLX needed)', () => {
  it('rejects an empty objective with a structured error', async () => {
    // Would catch a regression where empty input slipped through to
    // executeMission and the model was asked to plan "" — a real waste of
    // a model turn and a confusing UX.
    const r = await mod.startMission('')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/empty/i)
    expect(r.missionId).toBeUndefined()
  })

  it('rejects an objective that is whitespace-only after trim()', async () => {
    // Would catch removing the .trim() pre-check — whitespace-only input
    // is the same UX bug as empty input.
    const r = await mod.startMission('   \n\t  ')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/empty/i)
  })

  it('rejects when no model is loaded (default hook returns null)', async () => {
    // Would catch a regression where the no-model guard was removed; the
    // engine would then call chatStream with `null` as the model name and
    // get an opaque 404 from mlx-vlm.
    const r = await mod.startMission('do something useful')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/no model/i)
  })

  it('rejects when the chat layer reports it is currently streaming', async () => {
    // Would catch removal of the chat-busy guard. Concurrent MLX calls
    // (one from chat, one from mission decompose) compete for the single
    // mlx-vlm server slot and produce nondeterministic latency.
    await mod.initMission({
      getModel: () => 'gemma-test-model',
      isChatBusy: () => true
    })
    const r = await mod.startMission('do something useful')
    expect(r.ok).toBe(false)
    expect(r.error).toMatch(/chat is currently streaming/i)
  })
})

describe('missionEvents emitter', () => {
  it('is a live EventEmitter exposed for renderer subscriptions', () => {
    // Would catch a regression where the export was replaced with a stub
    // or an undefined — the renderer subscribes via `missionEvents.on('event', …)`
    // and would crash on boot if .on were missing.
    expect(typeof mod.missionEvents.on).toBe('function')
    expect(typeof mod.missionEvents.emit).toBe('function')
  })
})
