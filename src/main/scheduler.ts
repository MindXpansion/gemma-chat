import { EventEmitter } from 'events'

/**
 * Patch 57 — Agent Scheduler.
 *
 * Single-queue gatekeeper for MLX server access. As Phronesis grew from
 * one MLX caller (chat) to many (chat, mission, heartbeat consolidate/
 * review/probe/contradiction-check, ToM analyzer, soon Tier 4.3 adaptation
 * + Tier 4.4 PSV-conditioned generation + Sentinel), the implicit "first
 * caller blocks the rest" pattern stopped scaling. Third-party reviewer
 * (2026-05-25) flagged this as the next coordination cliff before adding
 * more callers.
 *
 * MVP scope (what this DOES):
 *   • Single exclusive lock on MLX access — only one caller streams at a time.
 *   • Priority queue: lower priority NUMBER wins. FIFO within priority.
 *   • acquire() / release() pattern, must pair in try/finally.
 *   • Status accessor + EventEmitter for UI subscription.
 *   • Caller registration (audit-only today; future-ready for rate limits).
 *
 * Out of scope for MVP (explicit upgrade hooks, do later):
 *   • Preemption (a USER_CHAT cutting in mid-stream of a BACKGROUND job).
 *     For now jobs run to completion; high-priority callers queue behind
 *     a long low-priority stream. Acceptable because long streams are
 *     bounded by TICK_TIMEOUT_MS etc.
 *   • Per-caller rate limits — knownCallers tracks identities so this is
 *     a one-line addition when needed.
 *   • Backpressure (drop / coalesce queued jobs when queue is deep).
 *   • Caller-side abort propagation — caller still owns its AbortSignal;
 *     scheduler only gates WHEN the work starts. Future runExclusive()
 *     wrapper can take an AbortSignal and call back on preemption.
 *
 * Bear's binding rules honored:
 *   • Single MLX server, single concurrent caller — enforced here.
 *   • No two MLX models concurrent — enforced here.
 *   • Karpathy MVP — single file, ~120 LOC, no premature framework class
 *     hierarchy. Extensibility = clean register() + named priorities, not
 *     "BaseSchedulableJob extends AbstractScheduledCaller".
 */

export type Priority = 1 | 2 | 3 | 4 | 5

/** Named priority constants — use these, never inline numbers. */
export const PRIORITY = {
  USER_CHAT: 1 as Priority,      // direct user message; latency-sensitive
  MISSION: 2 as Priority,         // Patch 35 mission steps
  HEARTBEAT: 3 as Priority,       // autonomous research ticks (consolidate, review, probe, contradiction-check)
  TOM: 4 as Priority,             // ToM analyzer (post-turn, no user waiting)
  BACKGROUND: 5 as Priority       // reserved for future low-priority work
} as const

interface Waiter {
  callerId: string
  priority: Priority
  queuedAt: number
  resolve: () => void
}

export interface RunningJob {
  callerId: string
  priority: Priority
  startedAt: number
}

export interface QueuedJob {
  callerId: string
  priority: Priority
  queuedAt: number
}

export interface SchedulerStatus {
  running: RunningJob | null
  queued: QueuedJob[]
}

class AgentScheduler {
  private running: RunningJob | null = null
  private waiters: Waiter[] = []
  private knownCallers = new Set<string>()

  /** EventEmitter that fires 'change' with SchedulerStatus on every transition. */
  readonly events = new EventEmitter()

  /**
   * Register a caller. Currently informational/audit-only — future
   * versions can use this for per-caller rate limits, registered abort
   * callbacks, etc. Safe to call multiple times with the same callerId
   * (idempotent).
   */
  register(callerId: string): void {
    this.knownCallers.add(callerId)
  }

  isBusy(): boolean {
    return this.running !== null
  }

  getStatus(): SchedulerStatus {
    return {
      running: this.running ? { ...this.running } : null,
      queued: this.waiters.map((w) => ({
        callerId: w.callerId,
        priority: w.priority,
        queuedAt: w.queuedAt
      }))
    }
  }

  /**
   * Wait for an exclusive turn on the MLX server. Resolves when this
   * caller is dispatched.
   *
   * MUST be paired with release() in a try/finally — failure to release
   * will starve the queue.
   *
   * Selection: lowest priority NUMBER wins (USER_CHAT=1 beats MISSION=2),
   * FIFO within the same priority.
   */
  acquire(callerId: string, priority: Priority): Promise<void> {
    return new Promise((resolve) => {
      const waiter: Waiter = {
        callerId,
        priority,
        queuedAt: Date.now(),
        resolve
      }
      this.waiters.push(waiter)
      this.emitChange()
      this.tryDispatch()
    })
  }

  release(callerId: string): void {
    if (this.running?.callerId !== callerId) {
      console.warn(
        `[scheduler] release mismatch: running='${this.running?.callerId ?? 'none'}' releaser='${callerId}'`
      )
    }
    this.running = null
    this.emitChange()
    this.tryDispatch()
  }

  /**
   * Convenience wrapper: acquire → run fn → release, always paired.
   * fn receives no args; if the caller needs an AbortSignal, manage it
   * externally (scheduler MVP doesn't own caller-side abort).
   */
  async run<T>(callerId: string, priority: Priority, fn: () => Promise<T>): Promise<T> {
    await this.acquire(callerId, priority)
    try {
      return await fn()
    } finally {
      this.release(callerId)
    }
  }

  private tryDispatch(): void {
    if (this.running !== null) return
    if (this.waiters.length === 0) return

    // Lowest priority number first, FIFO within priority.
    this.waiters.sort((a, b) => a.priority - b.priority || a.queuedAt - b.queuedAt)
    const next = this.waiters.shift()!

    this.running = {
      callerId: next.callerId,
      priority: next.priority,
      startedAt: Date.now()
    }
    this.emitChange()
    next.resolve()
  }

  private emitChange(): void {
    this.events.emit('change', this.getStatus())
  }
}

/** Singleton — one MLX server, one scheduler. */
export const scheduler = new AgentScheduler()
