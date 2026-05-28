/**
 * Wave A2 — sentinels.ts YAML loader unit tests.
 *
 * Covers loadSentinels(), parseOne (indirectly), interpolate(), and
 * comparatorFn(). Uses real on-disk YAML fixtures (test/fixtures/sentinels/)
 * copied into an isolated temp directory shaped like the real sentinels
 * dir (~/GemmaWorkspace/sentinels/). loadSentinels() derives that path
 * from os.homedir(), so the test redirects homedir() to point at the
 * temp playground for the duration of each scenario.
 *
 * Mocks:
 *   • vi.mock('os', ...) — the sentinels loader hard-codes
 *     ~/GemmaWorkspace/sentinels/ as its only discovery path (via
 *     os.homedir()). There is no injection seam. A live test cannot
 *     point the loader at a temp fixture dir without either modifying
 *     the real user's sentinel directory (forbidden — would race with
 *     concurrent test agents and pollute the live audit-tick) or
 *     refactoring sentinels.ts to accept a path. The mock swaps only
 *     the homedir() function (everything else is the real os module via
 *     importActual) so each test can scope its own playground via
 *     setHomedirOverride(). This is the smallest possible mock.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdirSync, copyFileSync, writeFileSync, readdirSync } from 'fs'
import { join, resolve } from 'path'

// Hoisted-safe override slot. vi.mock factories are hoisted ABOVE the
// module-scope `let` declarations and cannot close over local bindings,
// so we stash the value on globalThis.
;(globalThis as Record<string, unknown>).__PHRONESIS_HOMEDIR_OVERRIDE__ = null
function setHomedirOverride(p: string | null) {
  ;(globalThis as Record<string, unknown>).__PHRONESIS_HOMEDIR_OVERRIDE__ = p
}

vi.mock('os', async () => {
  const actual = await vi.importActual<typeof import('os')>('os')
  return {
    ...actual,
    homedir: () => {
      const o = (globalThis as Record<string, unknown>).__PHRONESIS_HOMEDIR_OVERRIDE__
      return typeof o === 'string' ? o : actual.homedir()
    }
  }
})

import { uniqueTempDir, type TempDir } from '../helpers/fs-temp'
import {
  loadSentinels,
  interpolate,
  comparatorFn,
  sentinelsDir
} from '../../src/main/sentinels'

const FIXTURE_DIR = resolve(__dirname, '..', 'fixtures', 'sentinels')

/** Copy named fixture files into a fresh fake-homedir shaped like
 *  <tmp>/GemmaWorkspace/sentinels/, and redirect os.homedir() to <tmp>. */
function withFakeSentinelsDir(fixtureNames: string[]): TempDir & { sentinelsAt: string } {
  const tmp = uniqueTempDir('phronesis-sentinels-')
  const target = join(tmp.path, 'GemmaWorkspace', 'sentinels')
  mkdirSync(target, { recursive: true })
  for (const name of fixtureNames) {
    copyFileSync(join(FIXTURE_DIR, name), join(target, name))
  }
  setHomedirOverride(tmp.path)
  return { ...tmp, sentinelsAt: target }
}

afterEach(() => {
  setHomedirOverride(null)
  vi.restoreAllMocks()
})

describe('sentinelsDir', () => {
  it('joins ~/GemmaWorkspace/sentinels — would catch a regression that moves the discovery path', () => {
    setHomedirOverride('/synthetic/home')
    expect(sentinelsDir()).toBe('/synthetic/home/GemmaWorkspace/sentinels')
  })
})

describe('loadSentinels — happy path against real captured fixtures', () => {
  let dir: TempDir

  beforeEach(() => {
    dir = withFakeSentinelsDir(['real-calibration-drift.yaml', 'real-orphan-node-rate.yaml'])
  })
  afterEach(() => dir?.cleanup())

  it('loads both production sentinels and parses every required field — would catch loader output drifting from the on-disk schema operators maintain', async () => {
    const all = await loadSentinels()
    expect(all).toHaveLength(2)

    const calib = all.find((s) => s.name === 'calibration-high-confidence-drift')!
    expect(calib).toBeDefined()
    expect(calib.severity).toBe('critical')
    expect(calib.cadenceTicks).toBe(12)
    expect(calib.threshold).toBe(0.15)
    expect(calib.comparator).toBe('gt')
    expect(calib.actionOnCross).toBe('follow_up_enqueued')
    expect(calib.followUpPrompt).toMatch(/Sentinel calibration-high-confidence-drift fired/)
    expect(calib.query).toMatch(/AS observed/)
    expect(calib.enabled).toBe(true)

    const orphan = all.find((s) => s.name === 'orphan-node-rate')!
    expect(orphan).toBeDefined()
    expect(orphan.severity).toBe('warn')
    expect(orphan.actionOnCross).toBe('journal_appended') // severity-default mapping
    expect(orphan.followUpPrompt).toBeUndefined()
  })
})

describe('loadSentinels — missing directory', () => {
  it('returns [] when the sentinels dir does not exist — would catch loader throwing on first-boot before operator creates the dir', async () => {
    const tmp = uniqueTempDir('phronesis-sentinels-empty-')
    // do NOT create GemmaWorkspace/sentinels under tmp.path
    setHomedirOverride(tmp.path)
    try {
      const out = await loadSentinels()
      expect(out).toEqual([])
    } finally {
      tmp.cleanup()
    }
  })
})

describe('loadSentinels — edge case rejections (warn-and-skip)', () => {
  let dir: TempDir
  let warnSpy: ReturnType<typeof vi.spyOn>

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    dir?.cleanup()
    warnSpy.mockRestore()
  })

  it('skips an empty YAML file and continues loading other valid files — would catch loader throwing on a 0-byte file', async () => {
    dir = withFakeSentinelsDir(['edge-empty.yaml', 'edge-valid-minimal.yaml'])
    const out = await loadSentinels()
    expect(out.map((s) => s.name)).toEqual(['valid-minimal'])
  })

  it('skips a malformed YAML and logs a parse-error warning — would catch loader crashing the audit-tick on bad YAML', async () => {
    dir = withFakeSentinelsDir(['edge-malformed.yaml', 'edge-valid-minimal.yaml'])
    const out = await loadSentinels()
    expect(out.map((s) => s.name)).toEqual(['valid-minimal'])
    // At least one warn line should mention the bad file
    const calls = warnSpy.mock.calls.flat().join('\n')
    expect(calls).toMatch(/edge-malformed\.yaml/)
  })

  it('skips a YAML missing required fields — would catch the loader emitting half-constructed Sentinel objects', async () => {
    dir = withFakeSentinelsDir(['edge-missing-fields.yaml', 'edge-valid-minimal.yaml'])
    const out = await loadSentinels()
    expect(out.map((s) => s.name)).toEqual(['valid-minimal'])
  })

  it('rejects a query containing a write keyword — would catch a regression where sentinels could mutate the KG', async () => {
    dir = withFakeSentinelsDir(['edge-write-keyword.yaml'])
    const out = await loadSentinels()
    expect(out).toEqual([])
    const calls = warnSpy.mock.calls.flat().join('\n')
    expect(calls).toMatch(/write keyword/i)
  })

  it('rejects a query calling an APOC write procedure — would catch the keyword-regex missing the APOC bypass', async () => {
    dir = withFakeSentinelsDir(['edge-apoc-write.yaml'])
    const out = await loadSentinels()
    expect(out).toEqual([])
    const calls = warnSpy.mock.calls.flat().join('\n')
    expect(calls).toMatch(/APOC write proc/i)
  })

  it('rejects a query that does not alias a column as observed — would catch loader allowing queries the runner cannot evaluate', async () => {
    dir = withFakeSentinelsDir(['edge-no-observed.yaml'])
    const out = await loadSentinels()
    expect(out).toEqual([])
  })

  it('rejects a non-kebab-case name — would catch loader accepting names that break filename / id conventions', async () => {
    dir = withFakeSentinelsDir(['edge-bad-name.yaml'])
    const out = await loadSentinels()
    expect(out).toEqual([])
  })

  it("rejects 'follow_up_enqueued' action without a follow_up_prompt — would catch Gemma being enqueued with an empty goal", async () => {
    dir = withFakeSentinelsDir(['edge-followup-no-prompt.yaml'])
    const out = await loadSentinels()
    expect(out).toEqual([])
  })

  it('ignores files whose extension is not .yaml/.yml or ends in .disabled — would catch loader trying to parse stray text/notes files', async () => {
    const tmp = uniqueTempDir('phronesis-sentinels-mixed-')
    const target = join(tmp.path, 'GemmaWorkspace', 'sentinels')
    mkdirSync(target, { recursive: true })
    copyFileSync(join(FIXTURE_DIR, 'edge-valid-minimal.yaml'), join(target, 'valid.yaml'))
    // Stray non-YAML and a soft-disabled YAML
    writeFileSync(join(target, 'README.md'), '# notes\n')
    copyFileSync(join(FIXTURE_DIR, 'edge-valid-minimal.yaml'), join(target, 'someone.yaml.disabled'))
    setHomedirOverride(tmp.path)
    try {
      const out = await loadSentinels()
      expect(out).toHaveLength(1)
      expect(out[0].name).toBe('valid-minimal')
      // Sanity: directory really does contain the extra files
      expect(readdirSync(target).sort()).toEqual(
        ['README.md', 'someone.yaml.disabled', 'valid.yaml'].sort()
      )
    } finally {
      tmp.cleanup()
    }
  })
})

describe('interpolate', () => {
  it('replaces {token} with the matching context value — would catch summary templates rendering literally with braces', () => {
    expect(interpolate('hello {name}, observed={observed}', { name: 'world', observed: 0.42 })).toBe(
      'hello world, observed=0.42'
    )
  })

  it('replaces missing tokens with empty string — would catch undefined rendering as the string "undefined"', () => {
    expect(interpolate('a={a}, b={b}', { a: 1 })).toBe('a=1, b=')
  })

  it('treats null as empty — would catch null rendering as the string "null"', () => {
    expect(interpolate('v={x}', { x: null })).toBe('v=')
  })

  it('leaves unknown bracket sequences untouched if they do not match \\w+ — would catch over-aggressive regex eating real braces', () => {
    expect(interpolate('keep { spaces } intact, replace {x}', { x: 'OK' })).toBe(
      'keep { spaces } intact, replace OK'
    )
  })
})

describe('comparatorFn', () => {
  it.each([
    ['gt', 2, 1, true],
    ['gt', 1, 1, false],
    ['gte', 1, 1, true],
    ['lt', 0, 1, true],
    ['lte', 1, 1, true],
    ['eq', 5, 5, true],
    ['neq', 5, 6, true]
  ] as const)('numeric %s(%s, %s) → %s', (c, a, b, expected) => {
    expect(comparatorFn(c)(a, b)).toBe(expected)
  })

  it('falls back to string compare when either side is non-numeric — would catch a regression that coerces "abc" to NaN and silently passes', () => {
    expect(comparatorFn('eq')('hello', 'hello')).toBe(true)
    expect(comparatorFn('neq')('a', 'b')).toBe(true)
    expect(comparatorFn('gt')('b', 'a')).toBe(true)
  })
})
