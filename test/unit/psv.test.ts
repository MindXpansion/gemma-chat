/**
 * Phase 1 — PSV selectStrategy + shiftPSV unit tests.
 *
 * Pure deterministic math over the ToM signal → adaptation strategy →
 * bounded PSV shift. No external dependencies. Tests cover:
 *   • strategy selection across each emotion/intention branch
 *   • shift directionality for each strategy
 *   • clamping (PERSONALITY_SHIFT_CONSTRAINT, EMPATHY_ADJUSTMENT_FACTOR)
 *   • intensity scaling (k factor)
 *   • rapport-driven social_skills bump
 *   • immutability of the base PSV
 */
import { describe, it, expect } from 'vitest'
import {
  selectStrategy,
  shiftPSV,
  DEFAULT_PSV,
  PERSONALITY_SHIFT_CONSTRAINT,
  EMPATHY_ADJUSTMENT_FACTOR,
  type ToMSignal,
  type PSV
} from '../../src/shared/psv'

function signal(overrides: Partial<ToMSignal> = {}): ToMSignal {
  return {
    user_emotion: 'neutral',
    emotion_intensity: 0.5,
    user_intention: 'asking',
    rapport_level: 0.5,
    ...overrides
  }
}

describe('selectStrategy', () => {
  it('emotional load → mirror', () => {
    for (const emo of ['frustrated', 'tired', 'anxious', 'sad', 'overwhelmed']) {
      expect(selectStrategy(signal({ user_emotion: emo }))).toBe('mirror')
    }
  })

  it('venting intention → mirror regardless of emotion', () => {
    expect(selectStrategy(signal({ user_intention: 'venting', user_emotion: 'curious' }))).toBe(
      'mirror'
    )
  })

  it('task intentions → complement', () => {
    for (const intent of ['asking', 'debugging', 'directing']) {
      expect(selectStrategy(signal({ user_intention: intent }))).toBe('complement')
    }
  })

  it('focused emotion → complement', () => {
    expect(selectStrategy(signal({ user_emotion: 'focused' }))).toBe('complement')
  })

  it('exploring/planning intention → goal', () => {
    for (const intent of ['exploring', 'planning']) {
      expect(selectStrategy(signal({ user_intention: intent }))).toBe('goal')
    }
  })

  it('curious/excited emotion → goal', () => {
    for (const emo of ['curious', 'excited']) {
      expect(selectStrategy(signal({ user_emotion: emo, user_intention: 'other' }))).toBe('goal')
    }
  })

  it('falls back to mirror on unrecognized signal', () => {
    expect(
      selectStrategy(signal({ user_emotion: 'whatever', user_intention: 'other' }))
    ).toBe('mirror')
  })

  it('case-insensitive on emotion + intention', () => {
    expect(
      selectStrategy(signal({ user_emotion: 'FRUSTRATED', user_intention: 'VENTING' }))
    ).toBe('mirror')
  })

  it('priority: emotional load beats task intention', () => {
    // frustrated + asking — emotion wins, even though asking would be complement.
    expect(
      selectStrategy(signal({ user_emotion: 'frustrated', user_intention: 'asking' }))
    ).toBe('mirror')
  })
})

describe('shiftPSV', () => {
  it('returns a new PSV (does not mutate base)', () => {
    const base = { ...DEFAULT_PSV }
    const baseCopy = { ...DEFAULT_PSV }
    const result = shiftPSV(base, 'mirror', signal({ user_emotion: 'sad', emotion_intensity: 0.8 }))
    expect(base).toEqual(baseCopy) // unmutated
    expect(result).not.toBe(base) // new object
  })

  describe('mirror strategy', () => {
    it('raises empathy + agreeableness, lowers conscientiousness', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'mirror',
        signal({ user_emotion: 'sad', emotion_intensity: 1.0 })
      )
      expect(result.empathy).toBeGreaterThan(DEFAULT_PSV.empathy)
      expect(result.agreeableness).toBeGreaterThan(DEFAULT_PSV.agreeableness)
      expect(result.conscientiousness).toBeLessThan(DEFAULT_PSV.conscientiousness)
    })
  })

  describe('complement strategy', () => {
    it('raises conscientiousness, lowers neuroticism + agreeableness', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'complement',
        signal({ user_intention: 'debugging', emotion_intensity: 1.0 })
      )
      expect(result.conscientiousness).toBeGreaterThan(DEFAULT_PSV.conscientiousness)
      expect(result.neuroticism).toBeLessThan(DEFAULT_PSV.neuroticism)
      expect(result.agreeableness).toBeLessThan(DEFAULT_PSV.agreeableness)
    })
  })

  describe('goal strategy', () => {
    it('raises openness, motivation, extraversion', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'curious', emotion_intensity: 1.0 })
      )
      expect(result.openness).toBeGreaterThan(DEFAULT_PSV.openness)
      expect(result.motivation).toBeGreaterThan(DEFAULT_PSV.motivation)
      expect(result.extraversion).toBeGreaterThan(DEFAULT_PSV.extraversion)
    })
  })

  describe('clamping', () => {
    it('empathy never moves more than EMPATHY_ADJUSTMENT_FACTOR from default in one call', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'mirror',
        signal({ user_emotion: 'sad', emotion_intensity: 1.0 })
      )
      expect(Math.abs(result.empathy - DEFAULT_PSV.empathy)).toBeLessThanOrEqual(
        EMPATHY_ADJUSTMENT_FACTOR + 1e-9
      )
    })

    it('no trait moves more than PERSONALITY_SHIFT_CONSTRAINT from its default', () => {
      // Apply mirror compounding via a far-from-default base
      const drifted: PSV = {
        ...DEFAULT_PSV,
        conscientiousness: 0.2 // way below default 0.7
      }
      const result = shiftPSV(
        drifted,
        'mirror',
        signal({ user_emotion: 'sad', emotion_intensity: 1.0 })
      )
      const defaultC = DEFAULT_PSV.conscientiousness
      expect(result.conscientiousness).toBeGreaterThanOrEqual(defaultC - PERSONALITY_SHIFT_CONSTRAINT - 1e-9)
      expect(result.conscientiousness).toBeLessThanOrEqual(defaultC + PERSONALITY_SHIFT_CONSTRAINT + 1e-9)
    })

    it('all returned values are in [0, 1]', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'excited', emotion_intensity: 1.0, rapport_level: 0.9 })
      )
      for (const [k, v] of Object.entries(result)) {
        expect(v, `${k} out of [0,1]`).toBeGreaterThanOrEqual(0)
        expect(v, `${k} out of [0,1]`).toBeLessThanOrEqual(1)
      }
    })
  })

  describe('intensity scaling', () => {
    it('low intensity shifts less than high intensity', () => {
      const low = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'curious', emotion_intensity: 0.2 })
      )
      const high = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'curious', emotion_intensity: 1.0 })
      )
      const lowDelta = low.openness - DEFAULT_PSV.openness
      const highDelta = high.openness - DEFAULT_PSV.openness
      expect(highDelta).toBeGreaterThan(lowDelta)
    })

    it('intensity below 0.2 is floored to 0.2 (min k)', () => {
      const tiny = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'curious', emotion_intensity: 0.0 })
      )
      const min = shiftPSV(
        DEFAULT_PSV,
        'goal',
        signal({ user_emotion: 'curious', emotion_intensity: 0.2 })
      )
      // Both should produce the SAME shift since k = max(0.2, ...) for both.
      expect(tiny.openness).toBeCloseTo(min.openness, 9)
    })
  })

  describe('rapport bonus', () => {
    it('rapport >= 0.7 bumps social_skills up', () => {
      const high = shiftPSV(
        DEFAULT_PSV,
        'complement',
        signal({ rapport_level: 0.9, emotion_intensity: 0.5 })
      )
      const low = shiftPSV(
        DEFAULT_PSV,
        'complement',
        signal({ rapport_level: 0.3, emotion_intensity: 0.5 })
      )
      expect(high.social_skills).toBeGreaterThan(low.social_skills)
    })

    it('rapport < 0.7 leaves social_skills untouched', () => {
      const result = shiftPSV(
        DEFAULT_PSV,
        'complement',
        signal({ rapport_level: 0.6, emotion_intensity: 0.5 })
      )
      expect(result.social_skills).toBe(DEFAULT_PSV.social_skills)
    })
  })
})
