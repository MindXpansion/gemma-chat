/**
 * Patch 57 — AgentScheduler unit tests.
 *
 * Single-process priority queue gating MLX server access. Pure deterministic
 * logic — no I/O, no subprocesses. Tests cover acquire/release pairing,
 * priority ordering, FIFO within priority, run() try/finally semantics,
 * register(), telemetry emission (Patch 69), and edge cases including
 * release-by-wrong-caller, empty-queue dispatch no-op, and a 1000-caller
 * stress run.
 *
 * Note: AgentScheduler is not exported as a class — only the `scheduler`
 * singleton and the `PRIORITY` constants are. To get isolated instances per
 * test we reload the module via vi.resetModules() + dynamic import. This
 * keeps each test's queue/running state independent without modifying source.
 *
 * Mocks:
 *   • vi.spyOn(console, 'log') — Patch 69 telemetry is intentionally
 *     emitted via console.log lines. Verifying the format is the ONLY way
 *     to assert the dispatch/release telemetry contract — there is no
 *     return-value or event payload that carries the raw log string. This
 *     is the "justified mock" case per conventions.md (verifying the
 *     observable side-effect of the module under test).
 *   • vi.spyOn(console, 'warn') — same justification, for the release-
 *     mismatch warning, which is also a pure console side-effect.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type {
  PRIORITY as PriorityConst,
  Priority,
  SchedulerStatus
} from '../../src/main/scheduler'
// Static import ensures the file is included in v8 coverage even though our
// per-test instances come from dynamic vi.resetModules() reloads.
import '../../src/main/scheduler'

// Per-test fresh module so the singleton's state doesn't leak across tests.
type SchedulerModule = typeof import('../../src/main/scheduler')
let mod: SchedulerModule
let PRIORITY: typeof PriorityConst

beforeEach(async () => {
  vi.resetModules()
  mod = await import('../../src/main/scheduler')
  PRIORITY = mod.PRIORITY
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('PRIORITY enum', () => {
  it('exposes named priorities with the documented numeric ordering', () => {
    // Would catch a regression where someone reorders the priority numbers
    // (e.g. swaps USER_CHAT and MISSION) — that would silently demote user
    // chat behind background work.
    expect(PRIORITY.USER_CHAT).toBe(1)
    expect(PRIORITY.MISSION).toBe(2)
    expect(PRIORITY.HEARTBEAT).toBe(3)
    expect(PRIORITY.TOM).toBe(4)
    expect(PRIORITY.BACKGROUND).toBe(5)
  })
})

describe('single caller', () => {
  it('acquire → release transitions running ↔ null and status reflects it', async () => {
    // Would catch a regression where release() forgets to clear `running`,
    // leaving the queue permanently blocked.
    const { scheduler } = mod
    expect(scheduler.isBusy()).toBe(false)

    await scheduler.acquire('caller-a', PRIORITY.USER_CHAT)
    expect(scheduler.isBusy()).toBe(true)
    const busy = scheduler.getStatus()
    expect(busy.running?.callerId).toBe('caller-a')
    expect(busy.running?.priority).toBe(PRIORITY.USER_CHAT)
    expect(busy.queued).toEqual([])

    scheduler.release('caller-a')
    expect(scheduler.isBusy()).toBe(false)
    expect(scheduler.getStatus().running).toBeNull()
  })

  it('getStatus returns copies, not internal references', async () => {
    // Would catch a regression where getStatus exposes the internal RunningJob
    // object, letting a caller mutate scheduler state from outside.
    const { scheduler } = mod
    await scheduler.acquire('caller-a', PRIORITY.USER_CHAT)
    const s1 = scheduler.getStatus()
    const s2 = scheduler.getStatus()
    expect(s1.running).not.toBe(s2.running)
    expect(s1.queued).not.toBe(s2.queued)
  })
})

describe('FIFO within same priority', () => {
  it('two callers same priority: first wins, second waits, second dispatches on release', async () => {
    // Would catch a regression where the queue sorts unstably (e.g. removing
    // the `queuedAt` tiebreaker) so identical-priority work runs out of order.
    const { scheduler } = mod
    await scheduler.acquire('first', PRIORITY.MISSION)

    let secondGotIt = false
    const p = scheduler.acquire('second', PRIORITY.MISSION).then(() => {
      secondGotIt = true
    })

    // Yield a microtask — second should still be waiting.
    await Promise.resolve()
    expect(secondGotIt).toBe(false)
    const status = scheduler.getStatus()
    expect(status.running?.callerId).toBe('first')
    expect(status.queued).toHaveLength(1)
    expect(status.queued[0].callerId).toBe('second')

    scheduler.release('first')
    await p
    expect(secondGotIt).toBe(true)
    expect(scheduler.getStatus().running?.callerId).toBe('second')

    scheduler.release('second')
  })

  it('three callers same priority dispatch in queue order', async () => {
    // Would catch a regression where the sort comparator becomes
    // non-deterministic for equal priorities.
    const { scheduler } = mod
    const order: string[] = []
    await scheduler.acquire('a', PRIORITY.HEARTBEAT)

    const pB = scheduler.acquire('b', PRIORITY.HEARTBEAT).then(() => order.push('b'))
    const pC = scheduler.acquire('c', PRIORITY.HEARTBEAT).then(() => order.push('c'))

    scheduler.release('a')
    await pB
    scheduler.release('b')
    await pC
    scheduler.release('c')

    expect(order).toEqual(['b', 'c'])
  })
})

describe('priority ordering', () => {
  it('lower-number priority wins even if it queued AFTER a higher number', async () => {
    // Would catch a regression where the queue degenerates into pure FIFO
    // (ignoring priority) — exactly the failure mode Patch 57 was built to fix.
    const { scheduler } = mod
    const order: string[] = []
    await scheduler.acquire('blocker', PRIORITY.BACKGROUND)

    const pTom = scheduler.acquire('tom', PRIORITY.TOM).then(() => order.push('tom'))
    const pHb = scheduler.acquire('hb', PRIORITY.HEARTBEAT).then(() => order.push('hb'))
    const pUser = scheduler.acquire('user', PRIORITY.USER_CHAT).then(() => order.push('user'))

    scheduler.release('blocker')
    // Drain the chain by releasing each as they take the lock.
    await pUser
    scheduler.release('user')
    await pHb
    scheduler.release('hb')
    await pTom
    scheduler.release('tom')

    expect(order).toEqual(['user', 'hb', 'tom'])
  })
})

describe('Patch 69 telemetry', () => {
  it('dispatch emits caller / priority / waited_ms / queue_depth line', async () => {
    // Would catch a regression where the dispatch telemetry format changes
    // and the log scraper used for the 90s-timeout investigation goes blind.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { scheduler } = mod

    await scheduler.acquire('cap-a', PRIORITY.USER_CHAT)

    const dispatchCall = logSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('[scheduler] dispatch ')
    )
    expect(dispatchCall).toBeDefined()
    expect(String(dispatchCall![0])).toMatch(
      /^\[scheduler\] dispatch caller=cap-a priority=1 waited_ms=\d+ queue_depth=0$/
    )

    scheduler.release('cap-a')
  })

  it('release emits caller / held_ms line', async () => {
    // Would catch a regression where release telemetry drops the held_ms
    // field, killing the long-hold detection needed to find slow callers.
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { scheduler } = mod

    await scheduler.acquire('cap-b', PRIORITY.MISSION)
    logSpy.mockClear()
    scheduler.release('cap-b')

    const releaseCall = logSpy.mock.calls.find((c) =>
      String(c[0]).startsWith('[scheduler] release ')
    )
    expect(releaseCall).toBeDefined()
    expect(String(releaseCall![0])).toMatch(
      /^\[scheduler\] release caller=cap-b held_ms=\d+$/
    )
  })
})

describe('run() convenience', () => {
  it('acquire → fn → release happens in order; returns fn result', async () => {
    // Would catch a regression where run() forgets to await fn() or returns
    // before fn resolves.
    const { scheduler } = mod
    let ran = false
    const result = await scheduler.run('cap', PRIORITY.MISSION, async () => {
      expect(scheduler.isBusy()).toBe(true)
      ran = true
      return 42
    })
    expect(ran).toBe(true)
    expect(result).toBe(42)
    expect(scheduler.isBusy()).toBe(false)
  })

  it('release fires even when fn throws (try/finally semantics)', async () => {
    // Would catch a regression where someone replaces try/finally with
    // a then() chain, leaving the lock held on rejection — exactly the bug
    // the scheduler was built to prevent.
    const { scheduler } = mod
    await expect(
      scheduler.run('cap', PRIORITY.MISSION, async () => {
        throw new Error('boom')
      })
    ).rejects.toThrow('boom')
    expect(scheduler.isBusy()).toBe(false)
  })
})

describe('register()', () => {
  it('is idempotent and does not affect scheduling', async () => {
    // Would catch a regression where register() leaks state into priority
    // calculation or rejects duplicate registrations.
    const { scheduler } = mod
    scheduler.register('cap')
    scheduler.register('cap')
    scheduler.register('cap')
    await scheduler.acquire('cap', PRIORITY.USER_CHAT)
    expect(scheduler.isBusy()).toBe(true)
    scheduler.release('cap')
  })
})

describe('edge cases', () => {
  it('release() called by wrong caller emits the mismatch warning', async () => {
    // Would catch a regression where the mismatch warning is dropped — losing
    // the only signal that pairs are crossed, which silently corrupts queue
    // accounting.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { scheduler } = mod

    await scheduler.acquire('right', PRIORITY.MISSION)
    scheduler.release('wrong')

    const mismatch = warnSpy.mock.calls.find((c) =>
      String(c[0]).includes('release mismatch')
    )
    expect(mismatch).toBeDefined()
    expect(String(mismatch![0])).toContain("running='right'")
    expect(String(mismatch![0])).toContain("releaser='wrong'")
    // Lock was still cleared (the release proceeds anyway).
    expect(scheduler.isBusy()).toBe(false)
  })

  it('release with no running caller emits mismatch warning and is a no-op', async () => {
    // Would catch a regression where releasing while idle throws or leaves
    // running in a bad state.
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    const { scheduler } = mod
    scheduler.release('ghost')
    expect(warnSpy.mock.calls.some((c) => String(c[0]).includes('release mismatch'))).toBe(
      true
    )
    expect(scheduler.isBusy()).toBe(false)
  })

  it('tryDispatch is a no-op with empty queue (releasing on idle does nothing)', async () => {
    // Would catch a regression where tryDispatch crashes on an empty
    // waiters array (e.g. waiters.shift()! → undefined.callerId).
    const { scheduler } = mod
    expect(() => scheduler.release('nobody')).not.toThrow()
    expect(scheduler.isBusy()).toBe(false)
    expect(scheduler.getStatus().queued).toEqual([])
  })

  it('1000 queued callers all dispatch in correct order (stress)', async () => {
    // Would catch a regression where sort stability or queue mutation
    // breaks at scale — typical of off-by-one errors in shift/sort logic.
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { scheduler } = mod
    const N = 1000

    await scheduler.acquire('lead', PRIORITY.BACKGROUND)
    const order: number[] = []
    const promises: Promise<void>[] = []

    for (let i = 0; i < N; i++) {
      // All same priority — FIFO order expected.
      const id = `w-${i}`
      promises.push(
        scheduler.acquire(id, PRIORITY.HEARTBEAT).then(() => {
          order.push(i)
        })
      )
    }

    scheduler.release('lead')
    // Drain: each waiter, once dispatched, must be released so the next runs.
    for (let i = 0; i < N; i++) {
      await promises[i]
      scheduler.release(`w-${i}`)
    }

    expect(order).toHaveLength(N)
    for (let i = 0; i < N; i++) expect(order[i]).toBe(i)
  })
})

describe('events', () => {
  it('emits "change" with SchedulerStatus on every transition', async () => {
    // Would catch a regression where the UI subscription stops receiving
    // updates because emitChange is dropped from a code path.
    const { scheduler } = mod
    const events: SchedulerStatus[] = []
    scheduler.events.on('change', (s: SchedulerStatus) => events.push(s))

    await scheduler.acquire('cap', PRIORITY.USER_CHAT as Priority)
    scheduler.release('cap')

    // At minimum: enqueue, dispatch (running set), release (running cleared).
    expect(events.length).toBeGreaterThanOrEqual(3)
    expect(events[events.length - 1].running).toBeNull()
  })
})
