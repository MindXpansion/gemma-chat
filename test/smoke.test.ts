/**
 * Phase 0 smoke test — proves vitest pipeline is wired correctly.
 * If this passes, `npm test` works; first real tests go in test/unit/.
 */
import { describe, it, expect } from 'vitest'

describe('test infrastructure', () => {
  it('vitest runs and assertions work', () => {
    expect(1 + 1).toBe(2)
  })

  it('async assertions work', async () => {
    const result = await Promise.resolve('hello')
    expect(result).toBe('hello')
  })
})
