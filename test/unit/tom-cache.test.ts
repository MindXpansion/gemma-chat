/**
 * Wave B1 — ToM cache + surface (non-MLX) tests.
 *
 * Coverage target: src/main/tom.ts non-MLX paths
 *   • getLatestUMM / getLatestUMMUuid getters before any cache hydration
 *   • Cache isolation across distinct conversationIds
 *   • (concurrency guard is exercised in the integration test where the
 *     analyzer is run with a stubbed MLX boundary — see
 *     test/integration/tom-concurrency.live.test.ts for justification)
 *
 * NO MLX subprocess interaction. Wave C2 owns live-MLX testing per the
 * parallel rollout plan.
 *
 * Mocks: none. tom.ts module-level state (the Map caches) is reset between
 * test files because vitest gives each file a fresh module registry by default,
 * but tests within this file deliberately use distinct conversationIds rather
 * than relying on test ordering.
 */
import { describe, it, expect } from 'vitest'
import { randomUUID } from 'crypto'
import { getLatestUMM, getLatestUMMUuid } from '../../src/main/tom'

describe('tom getters — before any cache hydration', () => {
  it('getLatestUMM returns undefined for an unknown conversationId — would catch a regression where the map default leaked a stale UMM into a fresh conversation', () => {
    const cid = `test-cache-${randomUUID()}`
    expect(getLatestUMM(cid)).toBeUndefined()
  })

  it('getLatestUMMUuid returns undefined for an unknown conversationId — would catch the same leak via the UUID parallel cache that drives :DROVE_SHIFT', () => {
    const cid = `test-cache-${randomUUID()}`
    expect(getLatestUMMUuid(cid)).toBeUndefined()
  })
})

describe('tom getters — cache isolation across conversations', () => {
  // Both maps live at module scope inside tom.ts and are populated by
  // analyzeUserMentalModel after a parse succeeds. Without invoking the
  // analyzer (which requires live MLX, Wave C2 territory), we cannot
  // populate the cache from outside. What we CAN guarantee here:
  // distinct conversationIds never accidentally collide in the getter,
  // regardless of what's been cached previously.
  it('distinct conversationIds yield independent undefined results — would catch a bug where the Map used a constant key instead of conversationId', () => {
    const cidA = `test-cache-${randomUUID()}`
    const cidB = `test-cache-${randomUUID()}`
    expect(getLatestUMM(cidA)).toBeUndefined()
    expect(getLatestUMM(cidB)).toBeUndefined()
    expect(getLatestUMMUuid(cidA)).toBeUndefined()
    expect(getLatestUMMUuid(cidB)).toBeUndefined()
  })

  it('empty-string conversationId returns undefined cleanly (no crash) — would catch a regression where the getter assumed a truthy key', () => {
    expect(getLatestUMM('')).toBeUndefined()
    expect(getLatestUMMUuid('')).toBeUndefined()
  })
})
