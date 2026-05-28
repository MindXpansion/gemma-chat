/**
 * Wave A1 — PROVIDERS registry invariants.
 *
 * PROVIDERS drives the Models-tab provider grouping AND gates the
 * "100% local by default" posture (Patch 67 binding rule). Adding a cloud
 * provider that ships enabled:true is a security regression — Bear's rule
 * is cloud providers must be runtime:'cloud' AND start enabled:false.
 *
 * These tests would catch:
 *  • a duplicate provider id silently shadowing another in the Models tab
 *  • a cloud provider shipped enabled by default (posture-flag bypass)
 *  • a runtime value that isn't 'local' or 'cloud'
 *  • an enabled provider with no models in AVAILABLE_MODELS (dead group)
 *  • the registry being emptied entirely (no providers means no app)
 */
import { describe, it, expect } from 'vitest'
import { AVAILABLE_MODELS, PROVIDERS } from '../../src/shared/types'
import { isValidProvider } from '../helpers/shape-validators'

describe('PROVIDERS shape', () => {
  it('every entry passes the Provider shape predicate', () => {
    for (const p of PROVIDERS) {
      expect(isValidProvider(p), `provider ${JSON.stringify(p)} failed shape check`).toBe(true)
    }
  })

  it('contains at least one provider', () => {
    expect(PROVIDERS.length).toBeGreaterThan(0)
  })

  it('provider ids are unique', () => {
    const ids = PROVIDERS.map(p => p.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('every runtime is one of local | cloud', () => {
    for (const p of PROVIDERS) {
      expect(['local', 'cloud']).toContain(p.runtime)
    }
  })

  it('at least one provider is enabled', () => {
    expect(PROVIDERS.some(p => p.enabled)).toBe(true)
  })
})

describe('PROVIDERS × AVAILABLE_MODELS', () => {
  it('every enabled provider has at least one model', () => {
    // An enabled provider with no models renders an empty group in the
    // Models tab — confusing UX and likely a wiring bug (forgot to add
    // the model entry, or forgot to flip enabled:false).
    for (const p of PROVIDERS.filter(p => p.enabled)) {
      const models = AVAILABLE_MODELS.filter(m => m.providerId === p.id)
      expect(models.length, `enabled provider ${p.id} has zero models`).toBeGreaterThan(0)
    }
  })
})

describe('PROVIDERS posture rule (Patch 67)', () => {
  it('no cloud provider is enabled by default', () => {
    // Bear's binding rule: cloud = runtime:'cloud' + must start
    // enabled:false until the user explicitly flips a posture flag.
    // This test would catch a future PR that adds a cloud provider
    // and mistakenly ships it enabled.
    for (const p of PROVIDERS) {
      if (p.runtime === 'cloud') {
        expect(p.enabled, `cloud provider ${p.id} shipped enabled — violates posture rule`).toBe(false)
      }
    }
  })
})
