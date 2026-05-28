/**
 * Wave A1 — personaBlock (src/shared/psv.ts) coverage top-up.
 *
 * personaBlock translates a PSV into the system-prompt PRESENCE paragraph.
 * The behavior is threshold-driven (HIGH = 0.7 for most traits; neuroticism
 * uses 1 - HIGH = 0.3 as the LOW cutoff). Each trait crossing its threshold
 * appends a load-bearing sentence — silent removal of a clause (e.g. the
 * Patch 52 anti-deflection clause inside the self_awareness branch) would
 * regress Gemma's repair behavior without any other test catching it.
 *
 * These tests would catch:
 *  • a threshold drifting off 0.7 (e.g. 0.8) causing default-PSV personas
 *    to silently drop guidance
 *  • the Patch 52 anti-deflection clause being removed from the
 *    self_awareness branch
 *  • the neuroticism branch flipping its comparison direction (>= vs <=)
 *  • personaBlock returning an empty string when given the zero PSV
 *    (the opening + closing sentences should always appear)
 */
import { describe, it, expect } from 'vitest'
import { personaBlock, DEFAULT_PSV, type PSV } from '../../src/shared/psv'

const ZERO_PSV: PSV = {
  empathy: 0,
  agreeableness: 0,
  social_skills: 0,
  self_awareness: 0,
  openness: 0,
  conscientiousness: 0,
  neuroticism: 1,
  motivation: 0,
  extraversion: 0
}

describe('personaBlock', () => {
  it('uses DEFAULT_PSV when called with no argument', () => {
    expect(personaBlock()).toBe(personaBlock(DEFAULT_PSV))
  })

  it('always includes the PRESENCE opener and closing line', () => {
    const out = personaBlock(ZERO_PSV)
    expect(out).toContain('PRESENCE')
    expect(out).toContain("None of this is performative")
  })

  it('high empathy or high agreeableness triggers the warmth clause', () => {
    const psv: PSV = { ...ZERO_PSV, empathy: 0.9 }
    expect(personaBlock(psv)).toContain('acknowledge')
  })

  it('high self_awareness emits BOTH the hedging clause AND the Patch 52 repair clause', () => {
    // Would catch silent removal of either clause — they are both load-
    // bearing for Bear's vision of honest, non-deflecting repair.
    const psv: PSV = { ...ZERO_PSV, self_awareness: 0.9 }
    const out = personaBlock(psv)
    expect(out).toContain('hedging')
    expect(out).toContain('repair')
    expect(out).toContain('deflect')
  })

  it('high social_skills emits the rhythm clause', () => {
    const psv: PSV = { ...ZERO_PSV, social_skills: 0.9 }
    expect(personaBlock(psv)).toContain('rhythm')
  })

  it('high openness emits the curiosity clause', () => {
    const psv: PSV = { ...ZERO_PSV, openness: 0.9 }
    expect(personaBlock(psv)).toContain('curious')
  })

  it('high conscientiousness emits the follow-through clause', () => {
    const psv: PSV = { ...ZERO_PSV, conscientiousness: 0.9 }
    expect(personaBlock(psv)).toContain('confirm what you did')
  })

  it('LOW neuroticism (<= 0.3) emits the stay-steady clause', () => {
    const psv: PSV = { ...ZERO_PSV, neuroticism: 0.2 }
    expect(personaBlock(psv)).toContain('Stay steady')
  })

  it('high neuroticism does NOT emit the stay-steady clause', () => {
    // Would catch a regression that flips the comparator direction
    // (high neuroticism is the opposite of "steady").
    const psv: PSV = { ...ZERO_PSV, neuroticism: 0.9 }
    expect(personaBlock(psv)).not.toContain('Stay steady')
  })

  it('returns a single space-joined string (no newlines or list markup)', () => {
    // The function is explicit that the paragraph is plain English with
    // no headers/lists — markdown crept in would change Gemma's tone.
    const out = personaBlock(DEFAULT_PSV)
    expect(out).not.toMatch(/\n/)
    expect(out).not.toMatch(/^[-*•]/m)
  })
})
