/**
 * Phase 1 — ToM parser unit tests.
 *
 * Pure logic over model output. Fixtures are real captured outputs from
 * Gemma 4 (including the Patch 68 regression where the model emitted
 * "clarifying" outside the closed enum). Tests cover:
 *   • clean happy-path output → full UserMentalModel
 *   • out-of-enum intention → coerce to 'other' (Patch 68 behavior)
 *   • missing required fields → null (fail-safe guard)
 *   • field clipping (knowledge_gap length)
 *   • numeric range clamping
 *   • case-insensitive field labels
 *   • trailing punctuation on emotion stripped
 *   • all default values populated when optional fields missing
 */
import { describe, it, expect } from 'vitest'
import { parseToM } from '../../src/main/tom'

describe('parseToM — happy path', () => {
  it('parses a complete, well-formed analyzer output', () => {
    const raw = [
      'USER_EMOTION: curious',
      'EMOTION_INTENSITY: 0.7',
      'USER_INTENTION: exploring',
      'KNOWLEDGE_GAP: unfamiliar with the new sampling profile names',
      'RAPPORT_LEVEL: 0.8',
      'ANALYZER_CONFIDENCE: 0.9'
    ].join('\n')

    const parsed = parseToM(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.user_emotion).toBe('curious')
    expect(parsed!.emotion_intensity).toBe(0.7)
    expect(parsed!.user_intention).toBe('exploring')
    expect(parsed!.knowledge_gap).toBe('unfamiliar with the new sampling profile names')
    expect(parsed!.rapport_level).toBe(0.8)
    expect(parsed!.analyzer_confidence).toBe(0.9)
    expect(parsed!.at).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })
})

describe('parseToM — Patch 68 out-of-enum coercion', () => {
  it('coerces "clarifying" → "other" (the actual Patch 68 regression case)', () => {
    const raw = [
      'USER_EMOTION: friendly',
      'EMOTION_INTENSITY: 0.4',
      'USER_INTENTION: clarifying',
      'KNOWLEDGE_GAP: none',
      'RAPPORT_LEVEL: 0.7',
      'ANALYZER_CONFIDENCE: 0.95'
    ].join('\n')

    const parsed = parseToM(raw)
    expect(parsed).not.toBeNull()
    expect(parsed!.user_intention).toBe('other')
    // The rest of the read survives — that's the whole point of Patch 68
    expect(parsed!.user_emotion).toBe('friendly')
    expect(parsed!.rapport_level).toBe(0.7)
  })

  it.each([
    ['thanking', 'other'],
    ['agreeing', 'other'],
    ['questioning', 'other'],
    ['unknown_verb', 'other']
  ])('coerces invented intention "%s" → "%s"', (input, expected) => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      `USER_INTENTION: ${input}`,
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    const parsed = parseToM(raw)
    expect(parsed?.user_intention).toBe(expected)
  })

  it('accepts all eight legal intentions verbatim', () => {
    const legal = [
      'debugging',
      'exploring',
      'venting',
      'planning',
      'asking',
      'celebrating',
      'directing',
      'other'
    ]
    for (const verb of legal) {
      const raw = [
        'USER_EMOTION: neutral',
        'EMOTION_INTENSITY: 0.5',
        `USER_INTENTION: ${verb}`,
        'RAPPORT_LEVEL: 0.5',
        'ANALYZER_CONFIDENCE: 0.5'
      ].join('\n')
      const parsed = parseToM(raw)
      expect(parsed?.user_intention, `failed on ${verb}`).toBe(verb)
    }
  })
})

describe('parseToM — required-field guard', () => {
  it('returns null when USER_EMOTION is missing', () => {
    const raw = [
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)).toBeNull()
  })

  it('returns null when USER_INTENTION line is missing entirely', () => {
    // Note: invalid INTENTION value is coerced to 'other'; only missing
    // the line entirely should null. This distinguishes Patch 68 behavior.
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)).toBeNull()
  })

  it('returns null when RAPPORT_LEVEL is missing', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)).toBeNull()
  })

  it('returns null when ANALYZER_CONFIDENCE is missing', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5'
    ].join('\n')
    expect(parseToM(raw)).toBeNull()
  })

  it('returns null on empty input', () => {
    expect(parseToM('')).toBeNull()
  })

  it('returns null on garbage input', () => {
    expect(parseToM('hello world this is not structured output')).toBeNull()
  })
})

describe('parseToM — defaults for missing optional fields', () => {
  it('emotion_intensity defaults to 0.5 when missing', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)?.emotion_intensity).toBe(0.5)
  })

  it('knowledge_gap defaults to empty string when missing', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)?.knowledge_gap).toBe('')
  })
})

describe('parseToM — field validation / normalization', () => {
  it('strips trailing punctuation from emotion', () => {
    const raw = [
      'USER_EMOTION: curious.',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)?.user_emotion).toBe('curious')
  })

  it('lowercases emotion', () => {
    const raw = [
      'USER_EMOTION: EXCITED',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    expect(parseToM(raw)?.user_emotion).toBe('excited')
  })

  it('clips knowledge_gap to 500 chars', () => {
    const long = 'x'.repeat(2000)
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      `KNOWLEDGE_GAP: ${long}`,
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    const parsed = parseToM(raw)
    expect(parsed?.knowledge_gap.length).toBe(500)
  })

  it('drops out-of-range intensity (>1)', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 1.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    // Out-of-range is rejected by regex guard; defaults to 0.5.
    expect(parseToM(raw)?.emotion_intensity).toBe(0.5)
  })

  it('drops negative rapport (parsed as missing → null)', () => {
    const raw = [
      'USER_EMOTION: neutral',
      'EMOTION_INTENSITY: 0.5',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: -0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    // -0.5 fails range check → rapport_level stays undefined → required-guard null
    expect(parseToM(raw)).toBeNull()
  })

  it('case-insensitive field labels', () => {
    const raw = [
      'user_emotion: neutral',
      'Emotion_Intensity: 0.5',
      'USER_intention: asking',
      'Rapport_Level: 0.5',
      'analyzer_confidence: 0.5'
    ].join('\n')
    const parsed = parseToM(raw)
    expect(parsed).not.toBeNull()
    expect(parsed?.user_emotion).toBe('neutral')
  })

  it('handles extra whitespace around values', () => {
    const raw = [
      'USER_EMOTION:    curious   ',
      'EMOTION_INTENSITY:  0.7  ',
      'USER_INTENTION:   asking  ',
      'RAPPORT_LEVEL:  0.5',
      'ANALYZER_CONFIDENCE: 0.5'
    ].join('\n')
    const parsed = parseToM(raw)
    expect(parsed?.user_emotion).toBe('curious')
    expect(parsed?.emotion_intensity).toBe(0.7)
  })

  it('ignores lines that do not match any known field', () => {
    const raw = [
      'Here is my analysis:',
      'USER_EMOTION: curious',
      'EMOTION_INTENSITY: 0.7',
      'Reasoning: blah blah blah',
      'USER_INTENTION: asking',
      'RAPPORT_LEVEL: 0.5',
      'ANALYZER_CONFIDENCE: 0.5',
      'End.'
    ].join('\n')
    expect(parseToM(raw)?.user_emotion).toBe('curious')
  })
})
