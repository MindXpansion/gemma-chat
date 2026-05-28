/**
 * Wave A1 — AVAILABLE_MODELS registry invariants.
 *
 * AVAILABLE_MODELS and DEFAULT_MODEL are consumed by the renderer (Models
 * tab), the model-loader path (MLX subprocess), and the recommended-on-first-
 * launch flow. A broken entry here (missing field, sizeBytes set to a string,
 * providerId pointing at a provider that doesn't exist) doesn't fail to
 * compile — it ships, the renderer renders a "ghost" model, and the loader
 * fails at runtime when Bear clicks Download.
 *
 * These tests would catch:
 *  • a new entry missing label/size/sizeBytes/description/providerId
 *  • a model whose providerId drifts to a value not in PROVIDERS
 *  • DEFAULT_MODEL pointing at a name no entry has (typo regression)
 *  • two entries silently flagged recommended:true (Models tab UX assumes one)
 *  • sizeBytes regressing to 0, negative, or NaN
 */
import { describe, it, expect } from 'vitest'
import { AVAILABLE_MODELS, DEFAULT_MODEL, PROVIDERS } from '../../src/shared/types'
import { isValidModelInfo } from '../helpers/shape-validators'

describe('AVAILABLE_MODELS shape', () => {
  it('every entry passes the ModelInfo shape predicate', () => {
    // Arrange — the registry itself.
    // Act / Assert — each entry satisfies the runtime shape.
    for (const m of AVAILABLE_MODELS) {
      expect(isValidModelInfo(m), `model ${JSON.stringify(m)} failed shape check`).toBe(true)
    }
  })

  it('contains at least one entry', () => {
    expect(AVAILABLE_MODELS.length).toBeGreaterThan(0)
  })

  it('every providerId resolves to a Provider in PROVIDERS', () => {
    const knownIds = new Set(PROVIDERS.map(p => p.id))
    for (const m of AVAILABLE_MODELS) {
      expect(knownIds.has(m.providerId), `model ${m.name} → unknown providerId ${m.providerId}`).toBe(true)
    }
  })

  it('sizeBytes is a positive finite number for every entry', () => {
    for (const m of AVAILABLE_MODELS) {
      expect(Number.isFinite(m.sizeBytes)).toBe(true)
      expect(m.sizeBytes).toBeGreaterThan(0)
    }
  })

  it('model names are unique', () => {
    const names = AVAILABLE_MODELS.map(m => m.name)
    expect(new Set(names).size).toBe(names.length)
  })

  it('labels are unique (UI disambiguation)', () => {
    const labels = AVAILABLE_MODELS.map(m => m.label)
    expect(new Set(labels).size).toBe(labels.length)
  })

  it('at most one entry is marked recommended:true', () => {
    // The Models tab assumes a single recommended model. If two ever ship
    // marked recommended, the "recommended" badge will appear on multiple
    // rows and Bear's first-launch UX gets ambiguous.
    const recommended = AVAILABLE_MODELS.filter(m => m.recommended === true)
    expect(recommended.length).toBeLessThanOrEqual(1)
  })
})

describe('DEFAULT_MODEL', () => {
  it('is a non-empty string', () => {
    expect(typeof DEFAULT_MODEL).toBe('string')
    expect(DEFAULT_MODEL.length).toBeGreaterThan(0)
  })

  it('exists in AVAILABLE_MODELS', () => {
    // Would catch a typo regression where DEFAULT_MODEL points at a name
    // no registry entry has — the first-launch loader would 404.
    const names = AVAILABLE_MODELS.map(m => m.name)
    expect(names).toContain(DEFAULT_MODEL)
  })

  it('matches the recommended entry when one exists', () => {
    // Sanity: if a model is marked recommended, DEFAULT_MODEL should be it.
    // If this ever drifts, either the recommended flag is stale or the
    // default is wrong — both worth a human glance.
    const rec = AVAILABLE_MODELS.find(m => m.recommended === true)
    if (rec) {
      expect(DEFAULT_MODEL).toBe(rec.name)
    }
  })
})
