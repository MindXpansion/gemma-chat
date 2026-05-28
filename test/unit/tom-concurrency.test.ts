/**
 * Wave B1 — ToM concurrency guard (Patch 55).
 *
 * Verifies the `tomRunning` module flag prevents two parallel analyzer
 * passes against the single warm MLX server (Bear's binding rule:
 * no two MLX models concurrent).
 *
 * Mocks (justified — no live alternative possible for this guard):
 *   • vi.spyOn(mlx, 'chatStream') — to hold the first call inside the
 *     `chatStream` await long enough for a second call to race in. Live
 *     MLX would (a) be Wave C2's exclusive territory per the parallel
 *     rollout plan and (b) provide no deterministic way to keep the
 *     first call in-flight for the race window.
 *   • vi.spyOn(convState, 'writeUserMentalModel') — the post-parse KG
 *     write is incidental to the guard under test. Stubbing it keeps
 *     the test off live Neo4j (covered in conv-state.live tests) and
 *     avoids cross-suite Neo4j contention.
 *   • vi.spyOn(console, 'warn') — to observe the "[tom] skipped" line
 *     emitted by the skipped second call (the only externally observable
 *     signal of the guard firing).
 *
 * Why unit/ not integration/: this test exercises a pure in-process flag.
 * The mocks remove all I/O; there is no live system being tested.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import * as mlx from '../../src/main/mlx'
import * as convState from '../../src/main/conversation-state'
import { analyzeUserMentalModel, getLatestUMM, getLatestUMMUuid } from '../../src/main/tom'

// Fixture: parsable analyzer output. Stand-in for what chatStream would yield.
const CLEAN_RAW = [
  'USER_EMOTION: curious',
  'EMOTION_INTENSITY: 0.7',
  'USER_INTENTION: exploring',
  'KNOWLEDGE_GAP: none',
  'RAPPORT_LEVEL: 0.7',
  'ANALYZER_CONFIDENCE: 0.9'
].join('\n')

function makeSlowStream(raw: string, holdMs: number) {
  return async function* () {
    // Hold long enough for the racing call to slip in before we yield.
    await new Promise((r) => setTimeout(r, holdMs))
    yield { content: raw }
    yield { done: true }
  }
}

describe('analyzeUserMentalModel — concurrency guard (Patch 55)', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>
  let logSpy: ReturnType<typeof vi.spyOn>
  let chatStreamSpy: ReturnType<typeof vi.spyOn>
  let writeUmmSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})
    // Stand-in for KG write — return a fixed uuid so the cache hydration
    // path is exercised without touching Neo4j.
    writeUmmSpy = vi
      .spyOn(convState, 'writeUserMentalModel')
      .mockResolvedValue({ uuid: '00000000-0000-0000-0000-000000000001' })
  })

  afterEach(() => {
    warnSpy.mockRestore()
    logSpy.mockRestore()
    chatStreamSpy?.mockRestore()
    writeUmmSpy.mockRestore()
  })

  it('second parallel call short-circuits with "[tom] skipped" log — would catch a regression where the tomRunning flag was removed or moved below the await', async () => {
    // Hold the first call ~150ms in chatStream so the second has time to race.
    chatStreamSpy = vi
      .spyOn(mlx, 'chatStream')
      .mockImplementation(makeSlowStream(CLEAN_RAW, 150) as unknown as typeof mlx.chatStream)

    const cid = 'test-tom-guard-A'

    const p1 = analyzeUserMentalModel({
      conversationId: cid,
      model: 'fake-model',
      userMessage: 'first call'
    })
    // Yield a microtask so call 1 can enter the function body and set
    // tomRunning = true before call 2 fires. Without this, both calls
    // could check the guard simultaneously on the same tick.
    await Promise.resolve()
    const p2 = analyzeUserMentalModel({
      conversationId: cid,
      model: 'fake-model',
      userMessage: 'second call'
    })

    await Promise.all([p1, p2])

    const skippedLines = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[tom] skipped'))
    expect(skippedLines).toHaveLength(1)
    expect(skippedLines[0]).toContain(cid)
  })

  it('after a successful analysis the cache is hydrated for that conversationId — would catch a bug where Patch 61 cache writes were dropped or keyed wrong', async () => {
    chatStreamSpy = vi
      .spyOn(mlx, 'chatStream')
      .mockImplementation(makeSlowStream(CLEAN_RAW, 0) as unknown as typeof mlx.chatStream)

    const cid = 'test-tom-guard-B'
    await analyzeUserMentalModel({
      conversationId: cid,
      model: 'fake-model',
      userMessage: 'hydrate me'
    })

    const umm = getLatestUMM(cid)
    expect(umm).toBeDefined()
    expect(umm!.user_emotion).toBe('curious')
    expect(umm!.user_intention).toBe('exploring')
    expect(umm!.rapport_level).toBe(0.7)

    const uuid = getLatestUMMUuid(cid)
    expect(uuid).toBe('00000000-0000-0000-0000-000000000001')
  })

  it('cache isolation: hydrating conversation A does not leak into conversation B — would catch a bug where the cache key collapsed to a constant', async () => {
    chatStreamSpy = vi
      .spyOn(mlx, 'chatStream')
      .mockImplementation(makeSlowStream(CLEAN_RAW, 0) as unknown as typeof mlx.chatStream)

    const cidA = 'test-tom-guard-isoA'
    const cidB = 'test-tom-guard-isoB'

    await analyzeUserMentalModel({
      conversationId: cidA,
      model: 'fake-model',
      userMessage: 'A only'
    })

    expect(getLatestUMM(cidA)).toBeDefined()
    expect(getLatestUMM(cidB)).toBeUndefined()
    expect(getLatestUMMUuid(cidA)).toBeDefined()
    expect(getLatestUMMUuid(cidB)).toBeUndefined()
  })

  it('parse-failed analyzer output does not hydrate cache — would catch a bug where a null parse silently wrote undefined into the cache', async () => {
    chatStreamSpy = vi
      .spyOn(mlx, 'chatStream')
      .mockImplementation(makeSlowStream('garbage non-structured output', 0) as unknown as typeof mlx.chatStream)

    const cid = 'test-tom-guard-parsefail'
    await analyzeUserMentalModel({
      conversationId: cid,
      model: 'fake-model',
      userMessage: 'this will not parse'
    })

    expect(getLatestUMM(cid)).toBeUndefined()
    expect(getLatestUMMUuid(cid)).toBeUndefined()
    // The parse-failed warn fires
    const parseFailLines = warnSpy.mock.calls
      .map((c) => String(c[0]))
      .filter((s) => s.includes('[tom] parse-failed'))
    expect(parseFailLines.length).toBeGreaterThanOrEqual(1)
  })
})
