/**
 * Wave B2 — mission decompose parser + missionNotes unit tests.
 *
 * Scope: only the pure-logic surface of src/main/mission.ts.
 *   • parseMissionSteps — the regex extractor that converts the model's raw
 *     decompose output into an ordered list of step instructions.
 *   • missionNotes — formats the mission objective + completed-step summaries
 *     into the context block each probe sees.
 *   • MAX_MISSION_STEPS — the bound the engine enforces.
 *
 * The end-to-end decompose() function (which runs a live MLX turn) is
 * intentionally NOT exercised here — that is Wave C2's territory, since C2
 * owns the MLX subprocess. We work from captured fixtures of what real model
 * output looks like (see test/fixtures/mission/) so the parser can be proven
 * without paying the cost or the contention of a live MLX round-trip.
 *
 * Mocks: none. parseMissionSteps and missionNotes are pure functions; the
 * fixtures are static text on disk read by the test harness itself.
 */
import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import { join } from 'path'
import {
  parseMissionSteps,
  missionNotes,
  decomposeSystemPrompt,
  MAX_MISSION_STEPS
} from '../../src/main/mission'
import type { Mission } from '../../src/shared/types'

const fx = (name: string): string =>
  readFileSync(join(__dirname, '../fixtures/mission', name), 'utf-8')

describe('parseMissionSteps — happy paths from real-looking fixtures', () => {
  it('extracts three steps in order from a clean 3-step decompose', () => {
    // Would catch a regression that broke basic STEP-line extraction (e.g.
    // tightening the regex from `STEP\s*:` to `STEP:` only, or losing the
    // `.+` capture group).
    const steps = parseMissionSteps(fx('clean-three-step.txt'))
    expect(steps).toHaveLength(3)
    expect(steps[0]).toMatch(/^Use gemma_kg_schema/)
    expect(steps[1]).toMatch(/^Use gemma_kg_query/)
    expect(steps[2]).toMatch(/^Use fs_write/)
  })

  it('accepts a one-step plan (minimum legal output)', () => {
    // Would catch a regex that required at least N matches before yielding
    // any results — the engine treats 1 step as a valid plan.
    const steps = parseMissionSteps(fx('single-step.txt'))
    expect(steps).toEqual([
      'Use gemma_kg_schema to inspect the structure of the knowledge graph.'
    ])
  })

  it('extracts STEP lines from output surrounded by prose noise', () => {
    // Would catch a parser that anchored to start-of-buffer (^) instead of
    // start-of-line (multiline flag), which would drop every step under any
    // model preamble or commentary.
    const steps = parseMissionSteps(fx('with-prose-noise.txt'))
    expect(steps).toHaveLength(2)
    expect(steps[0]).toMatch(/gemma_kg_schema/)
    expect(steps[1]).toMatch(/gemma_kg_query/)
  })

  it('strips leading bullets / numbering off STEP lines', () => {
    // Would catch removal of the `[\s\-*\d.]*` prefix character-class that
    // tolerates the model wrapping STEP: lines in numbered or bulleted lists.
    const steps = parseMissionSteps(fx('numbered-bulleted.txt'))
    expect(steps).toHaveLength(4)
    // None of the extracted instructions should still carry the bullet/number.
    for (const s of steps) {
      expect(s.startsWith('Use ')).toBe(true)
    }
  })
})

describe('parseMissionSteps — boundary and failure modes', () => {
  it('returns [] for output containing no STEP: lines', () => {
    // Would catch a parser that synthesized fake steps from the prose to
    // avoid an empty list — but the engine RELIES on [] here to mark the
    // mission `stuck` honestly (see executeMission in mission.ts).
    const steps = parseMissionSteps(fx('malformed-no-steps.txt'))
    expect(steps).toEqual([])
  })

  it('returns [] for an empty buffer', () => {
    // Would catch a regex that returned [undefined] or threw on empty input.
    expect(parseMissionSteps('')).toEqual([])
  })

  it('caps output at MAX_MISSION_STEPS when the model overproduces', () => {
    // Would catch removal of `.slice(0, MAX_STEPS)` — without the cap, an
    // overzealous model could push an unattended run past its safe bound.
    const steps = parseMissionSteps(fx('oversized-twelve-steps.txt'))
    expect(steps).toHaveLength(MAX_MISSION_STEPS)
    expect(MAX_MISSION_STEPS).toBe(10) // tied to mission.ts MAX_STEPS=10
  })

  it('is case-insensitive across STEP, Step, step', () => {
    // Would catch dropping the `i` flag on the regex — the system prompt
    // demands uppercase but the model occasionally drifts case.
    const mixed = 'STEP: do alpha\nStep: do beta\nstep: do gamma\n'
    expect(parseMissionSteps(mixed)).toEqual(['do alpha', 'do beta', 'do gamma'])
  })

  it('tolerates whitespace around the colon (STEP : foo)', () => {
    // Would catch tightening the colon match from `STEP\s*:` to `STEP:`,
    // breaking outputs where the model put a space before the colon.
    const out = 'STEP : do the thing\nSTEP:do the next thing'
    expect(parseMissionSteps(out)).toEqual(['do the thing', 'do the next thing'])
  })

  it('never emits an empty-string instruction (engine would execute "")', () => {
    // Would catch a regression that dropped the `if (t) steps.push(t)` guard
    // — bare `STEP:` lines must not turn into empty step instructions, or
    // the runner would try to execute "" as a probe instruction.
    // Trailing whitespace alone (no real instruction) should be dropped.
    const out = 'STEP:   '
    expect(parseMissionSteps(out)).toEqual([])
  })

  it('ignores STEP without a colon (not a step declaration)', () => {
    // Would catch loosening the regex to match `STEP foo` — only `STEP:`
    // followed by text is a step declaration per the system prompt.
    const out = 'STEP missing colon\nThe first STEP of the journey\n'
    expect(parseMissionSteps(out)).toEqual([])
  })

  it('trims whitespace from the captured instruction', () => {
    // Would catch removal of the .trim() call that normalizes the captured
    // instruction; downstream journal/UI rendering depends on clean text.
    expect(parseMissionSteps('STEP:    hello world    ')).toEqual(['hello world'])
  })
})

describe('missionNotes — formats objective + completed-step context', () => {
  const baseMission = (steps: Mission['steps']): Mission => ({
    id: 'm_test',
    objective: 'audit the partnership KG for orphaned Decision nodes',
    status: 'running',
    steps,
    model: 'gemma-test',
    createdAt: 0
  })

  it('returns only the objective when no steps are done yet', () => {
    // Would catch a regression that started emitting a "Progress so far:"
    // header even when nothing has completed — the first probe would then
    // see misleading empty progress context.
    const out = missionNotes(baseMission([
      { id: 's1', instruction: 'do alpha', status: 'pending' },
      { id: 's2', instruction: 'do beta', status: 'running' }
    ]))
    expect(out).toBe(
      'Mission objective: audit the partnership KG for orphaned Decision nodes'
    )
    expect(out).not.toContain('Progress so far:')
  })

  it('includes a numbered list of completed step summaries when present', () => {
    // Would catch a regression where completed steps stopped being threaded
    // into the next probe's context, breaking mission coherence.
    const out = missionNotes(baseMission([
      { id: 's1', instruction: 'inspect schema', status: 'done', summary: 'found 3 labels' },
      { id: 's2', instruction: 'count nodes', status: 'done', summary: 'found 12 :Decision' },
      { id: 's3', instruction: 'write report', status: 'running' }
    ]))
    expect(out).toContain('Mission objective:')
    expect(out).toContain('Progress so far:')
    expect(out).toContain('1. inspect schema')
    expect(out).toContain('→ found 3 labels')
    expect(out).toContain('2. count nodes')
    expect(out).toContain('→ found 12 :Decision')
    // The still-running step must NOT appear in the completed-context block.
    expect(out).not.toContain('write report')
  })

  it('skips done steps that have no summary recorded', () => {
    // Would catch a regression that started rendering "→ undefined" or empty
    // arrow lines for steps that completed but produced no narrative.
    const out = missionNotes(baseMission([
      { id: 's1', instruction: 'silent step', status: 'done' /* no summary */ },
      { id: 's2', instruction: 'real step', status: 'done', summary: 'real summary' }
    ]))
    expect(out).toContain('1. real step')
    expect(out).not.toContain('silent step')
    expect(out).not.toContain('undefined')
  })

  it('excludes failed steps from the progress context', () => {
    // Would catch a regression where failed steps leaked into the progress
    // block as if they had succeeded, biasing the next probe's plan.
    const out = missionNotes(baseMission([
      { id: 's1', instruction: 'fine step', status: 'done', summary: 'ok' },
      { id: 's2', instruction: 'bad step', status: 'failed', summary: 'error: boom' }
    ]))
    expect(out).toContain('1. fine step')
    expect(out).not.toContain('bad step')
    expect(out).not.toContain('error: boom')
  })
})

describe('decomposeSystemPrompt — the contract the parser consumes', () => {
  it('demands the exact STEP: format parseMissionSteps expects', () => {
    // Would catch a drift between the prompt's required output format and
    // the regex in parseMissionSteps — if the prompt switched to "1) ..."
    // and the regex still expected "STEP:", every mission would mark
    // `stuck` until both sides re-aligned.
    const sp = decomposeSystemPrompt()
    expect(sp).toContain('STEP:')
    expect(sp).toContain('only STEP: lines')
  })

  it('caps the requested step count to MAX_MISSION_STEPS', () => {
    // Would catch the prompt advertising more steps than the engine will
    // actually retain — a wasted half-prompt of model effort.
    const sp = decomposeSystemPrompt()
    expect(sp).toContain(`3 to ${MAX_MISSION_STEPS} steps`)
  })

  it('enumerates only offline-safe heartbeat tools', () => {
    // Would catch a regression where the system prompt advertised online
    // tools (web search, etc.) that the engine cannot actually run — Bear's
    // hard constraint is offline-safe, $0.
    const sp = decomposeSystemPrompt()
    expect(sp).toContain('offline-safe local tools')
  })
})

describe('MAX_MISSION_STEPS — engine bound', () => {
  it('is a positive integer the runner can rely on', () => {
    // Would catch a regression that exported MAX_STEPS as undefined or NaN.
    expect(Number.isInteger(MAX_MISSION_STEPS)).toBe(true)
    expect(MAX_MISSION_STEPS).toBeGreaterThan(0)
  })
})
