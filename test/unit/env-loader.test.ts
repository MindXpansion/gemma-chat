/**
 * Patch 18 — env-loader unit tests.
 *
 * Covers parseDotenv (via loadAiosEnv side-effect, since parseDotenv is
 * module-private), file-discovery precedence, the KEYS_WE_NEED whitelist,
 * and the "don't overwrite existing process.env" rule.
 *
 * env-loader computes its source paths at module load from os.homedir().
 * That makes the homedir an immutable constant of the module instance, so
 * we mock os.homedir BEFORE each dynamic import and re-import the module
 * to point it at a fresh temp directory per test. Without this, tests
 * would either pollute the developer's real ~/.gemma-chat.env or read
 * stale files from a prior run.
 *
 * Mocks:
 *   • vi.mock('os', ...) with a per-test homedir() return value — this is
 *     the conventions.md "necessary because we cannot write to the user's
 *     real home dir in tests" case. There is no DI hook in env-loader
 *     (paths are top-level consts), so swapping homedir is the smallest
 *     viable seam. We restore the real os.tmpdir for fs-temp.ts.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { writeFileSync } from 'fs'
import { join } from 'path'
import * as realOs from 'os'
import { uniqueTempDir, type TempDir } from '../helpers/fs-temp'

const WHITELIST = [
  'GOOGLE_MAPS_API_KEY',
  'NEO4J_URI',
  'NEO4J_USER',
  'NEO4J_PASSWORD',
  'NEO4J_GEMMA_URI',
  'NEO4J_GEMMA_USER',
  'NEO4J_GEMMA_PASSWORD',
  'NEO4J_GEMMA_DATABASE',
  'VOYAGE_API_KEY'
] as const

// Snapshot env-keys we touch so we can restore between tests.
function snapshotEnv(): Record<string, string | undefined> {
  const snap: Record<string, string | undefined> = {}
  for (const k of WHITELIST) snap[k] = process.env[k]
  return snap
}

function restoreEnv(snap: Record<string, string | undefined>): void {
  for (const k of WHITELIST) {
    if (snap[k] === undefined) delete process.env[k]
    else process.env[k] = snap[k]
  }
}

let tmp: TempDir
let envSnapshot: Record<string, string | undefined>

beforeEach(() => {
  envSnapshot = snapshotEnv()
  for (const k of WHITELIST) delete process.env[k]
  tmp = uniqueTempDir('phronesis-envloader-')

  vi.resetModules()
  vi.doMock('os', () => ({
    ...realOs,
    homedir: () => tmp.path
  }))
})

afterEach(() => {
  vi.doUnmock('os')
  vi.resetModules()
  tmp.cleanup()
  restoreEnv(envSnapshot)
})

async function loadFreshEnvLoader(): Promise<typeof import('../../src/main/env-loader')> {
  return import('../../src/main/env-loader')
}

function writeGemmaEnv(body: string): void {
  writeFileSync(join(tmp.path, '.gemma-chat.env'), body)
}
function writeZshenv(body: string): void {
  writeFileSync(join(tmp.path, '.zshenv'), body)
}

describe('loadAiosEnv — file discovery', () => {
  it('returns empty list when no source files exist', async () => {
    // Would catch a regression where loadAiosEnv throws on missing files
    // instead of returning [], which it must when launched on a fresh box.
    const { loadAiosEnv } = await loadFreshEnvLoader()
    expect(loadAiosEnv()).toEqual([])
  })

  it('loads keys from ~/.gemma-chat.env (preferred source)', async () => {
    // Would catch a regression where the gemma-chat env file stops being
    // consulted — the primary supported config surface for the app.
    writeGemmaEnv('GOOGLE_MAPS_API_KEY=map-key-123\nVOYAGE_API_KEY=voy-key-456\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toContain('GOOGLE_MAPS_API_KEY')
    expect(populated).toContain('VOYAGE_API_KEY')
    expect(process.env.GOOGLE_MAPS_API_KEY).toBe('map-key-123')
    expect(process.env.VOYAGE_API_KEY).toBe('voy-key-456')
  })

  it('loads keys from ~/.zshenv when no gemma-chat env exists', async () => {
    // Would catch a regression where the zshenv fallback is dropped — that
    // breaks users who only define their keys in zsh login env.
    writeZshenv('export NEO4J_URI="bolt://localhost:7687"\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toContain('NEO4J_URI')
    expect(process.env.NEO4J_URI).toBe('bolt://localhost:7687')
  })

  it('gemma-chat env takes precedence over zshenv for the same key', async () => {
    // Would catch a regression where source ordering flips and a stale
    // zshenv key overrides the canonical gemma-chat.env value.
    writeGemmaEnv('NEO4J_PASSWORD=from-gemma\n')
    writeZshenv('export NEO4J_PASSWORD="from-zshenv"\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_PASSWORD).toBe('from-gemma')
  })

  it('does not overwrite an already-set process.env value', async () => {
    // Would catch a regression where loadAiosEnv clobbers env vars that the
    // launching shell (or CI) already injected — surprising and dangerous.
    process.env.VOYAGE_API_KEY = 'pre-existing'
    writeGemmaEnv('VOYAGE_API_KEY=should-not-win\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toContain('VOYAGE_API_KEY')
    expect(process.env.VOYAGE_API_KEY).toBe('pre-existing')
  })

  it('only mirrors whitelisted KEYS_WE_NEED, ignores everything else', async () => {
    // Would catch a regression where the whitelist filter is removed — every
    // key in ~/.zshenv would leak into the Electron process env, including
    // unrelated secrets like AWS_SECRET_ACCESS_KEY.
    writeGemmaEnv('GOOGLE_MAPS_API_KEY=ok\nNOT_WHITELISTED=should-be-ignored\nAWS_SECRET_ACCESS_KEY=leak\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toContain('GOOGLE_MAPS_API_KEY')
    expect(populated).not.toContain('NOT_WHITELISTED')
    expect(populated).not.toContain('AWS_SECRET_ACCESS_KEY')
    expect(process.env.NOT_WHITELISTED).toBeUndefined()
    expect(process.env.AWS_SECRET_ACCESS_KEY).toBeUndefined()
  })
})

describe('parseDotenv (exercised via loadAiosEnv)', () => {
  it('handles empty file', async () => {
    // Would catch a regression where an empty config file crashes the parser.
    writeGemmaEnv('')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    expect(loadAiosEnv()).toEqual([])
  })

  it('parses plain KEY=VALUE lines', async () => {
    // Would catch a regression where the simplest dotenv form stops parsing.
    writeGemmaEnv('NEO4J_USER=neo4j\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_USER).toBe('neo4j')
  })

  it('strips double-quoted values', async () => {
    // Would catch a regression where the quote-strip logic flips so values
    // arrive in process.env wrapped in literal quotes.
    writeGemmaEnv('NEO4J_URI="bolt://localhost:7687"\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_URI).toBe('bolt://localhost:7687')
  })

  it('strips single-quoted values', async () => {
    // Would catch a regression where single-quote handling is removed,
    // breaking users with single-quoted secrets.
    writeGemmaEnv("NEO4J_USER='neo4j'\n")
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_USER).toBe('neo4j')
  })

  it('handles export prefix (zshenv style)', async () => {
    // Would catch a regression where the `export ` prefix stops being
    // stripped — the entire zshenv fallback would silently fail.
    writeZshenv('export GOOGLE_MAPS_API_KEY="abc"\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.GOOGLE_MAPS_API_KEY).toBe('abc')
  })

  it('ignores comments and blank lines', async () => {
    // Would catch a regression where comment lines are parsed as keys (which
    // would inject "#" prefixed garbage into process.env).
    writeGemmaEnv('# a comment\n\n   \nVOYAGE_API_KEY=v1\n# another\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toEqual(['VOYAGE_API_KEY'])
    expect(process.env.VOYAGE_API_KEY).toBe('v1')
  })

  it('trims surrounding whitespace around key and value', async () => {
    // Would catch a regression where whitespace handling is dropped, so
    // " NEO4J_USER " never matches the whitelist lookup.
    writeGemmaEnv('   NEO4J_USER   =   neo4j   \n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_USER).toBe('neo4j')
  })

  it('ignores lines without =', async () => {
    // Would catch a regression where malformed lines crash the parser or
    // emit truthy garbage into process.env.
    writeGemmaEnv('JUST_A_WORD\nNEO4J_USER=neo4j\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toContain('NEO4J_USER')
    expect(populated).not.toContain('JUST_A_WORD')
  })

  it('preserves = signs inside values (e.g. base64, query strings)', async () => {
    // Would catch a regression where the parser splits on EVERY `=` instead
    // of the first one — corrupting base64/JWT-style values.
    writeGemmaEnv('NEO4J_PASSWORD=abc=def==\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    loadAiosEnv()
    expect(process.env.NEO4J_PASSWORD).toBe('abc=def==')
  })

  it('ignores lines that start with = (no key)', async () => {
    // Would catch a regression where `=value` creates an empty-key entry,
    // throwing or corrupting the output dict.
    writeGemmaEnv('=orphan\nNEO4J_USER=neo4j\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    expect(populated).toEqual(['NEO4J_USER'])
  })
})

describe('loadAiosEnv — return shape', () => {
  it('returns the list of keys that ended up populated, in whitelist order', async () => {
    // Would catch a regression where the return value diverges from the
    // actual state of process.env after the call (the contract callers rely
    // on for boot-time logging of which keys made it).
    writeGemmaEnv('VOYAGE_API_KEY=v\nGOOGLE_MAPS_API_KEY=g\nNEO4J_URI=u\n')
    const { loadAiosEnv } = await loadFreshEnvLoader()
    const populated = loadAiosEnv()
    // Whitelist order: GOOGLE_MAPS_API_KEY, NEO4J_URI, ..., VOYAGE_API_KEY (last).
    expect(populated.indexOf('GOOGLE_MAPS_API_KEY')).toBeLessThan(
      populated.indexOf('NEO4J_URI')
    )
    expect(populated.indexOf('NEO4J_URI')).toBeLessThan(populated.indexOf('VOYAGE_API_KEY'))
  })
})
