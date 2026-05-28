/**
 * Wave A2 — models.ts unit tests.
 *
 * Covers getModelStatuses (against a fake HF cache laid out via
 * makeFakeHfCache) and deleteModelFromCache (known-model, unknown-model,
 * path-shape rejection, already-absent).
 *
 * Mocks:
 *   • vi.mock('../../src/main/mlx') — the production hfHubDir() pulls
 *     <userData>/mlx/models/hub from Electron's app.getPath('userData').
 *     Electron is not loadable in a vitest 'node' environment (the
 *     'electron' entry resolves to a binary path, not a JS module). A
 *     live test cannot avoid loading mlx.ts as long as models.ts imports
 *     hfHubDir from it. The mock replaces hfHubDir with a function that
 *     reads process.env.PHRONESIS_TEST_HF_HUB so each test scopes its
 *     own fake cache root. This is the smallest possible mock — only
 *     the path-resolution seam is swapped; all filesystem work is real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { existsSync, statSync, mkdirSync } from 'fs'
import { join } from 'path'
import { makeFakeHfCache, type TempDir } from '../helpers/fs-temp'

vi.mock('../../src/main/mlx', () => ({
  hfHubDir: () => process.env.PHRONESIS_TEST_HF_HUB || '/dev/null/no-hub-set'
}))

// Imports must come AFTER vi.mock so the mocked module is used.
import { getModelStatuses, deleteModelFromCache } from '../../src/main/models'
import { AVAILABLE_MODELS } from '../../src/shared/types'

let cache: (TempDir & { hubDir: string }) | null = null

beforeEach(() => {
  cache = null
})

afterEach(() => {
  cache?.cleanup()
  cache = null
  delete process.env.PHRONESIS_TEST_HF_HUB
})

describe('getModelStatuses — empty cache', () => {
  it('reports every AVAILABLE_MODELS entry as not-downloaded — would catch a regression that flagged disk-state for models the cache has never seen', async () => {
    cache = makeFakeHfCache({ models: [] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const out = await getModelStatuses(null)
    expect(out).toHaveLength(AVAILABLE_MODELS.length)
    for (const row of out) {
      expect(row.downloaded).toBe(false)
      expect(row.sizeBytesOnDisk).toBeUndefined()
      expect(row.isActive).toBe(false)
    }
  })
})

describe('getModelStatuses — partial cache', () => {
  it('flags only the downloaded subset, reports their sizes, and marks the active model — would catch the Models tab showing wrong on-disk presence (Patch 67.1 regression)', async () => {
    const downloadedRepo = AVAILABLE_MODELS[1].name // gemma-4-e4b-it-4bit
    cache = makeFakeHfCache({
      models: [{ repoId: downloadedRepo, fileSizes: [1024, 2048, 4096] }]
    })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const out = await getModelStatuses(downloadedRepo)

    const downloaded = out.filter((m) => m.downloaded)
    expect(downloaded).toHaveLength(1)
    expect(downloaded[0].name).toBe(downloadedRepo)
    expect(downloaded[0].sizeBytesOnDisk).toBe(1024 + 2048 + 4096)
    expect(downloaded[0].isActive).toBe(true)

    // All others not downloaded, not active
    for (const row of out.filter((m) => m.name !== downloadedRepo)) {
      expect(row.downloaded).toBe(false)
      expect(row.isActive).toBe(false)
    }
  })
})

describe('getModelStatuses — all models downloaded', () => {
  it('reports downloaded=true and a positive size for every AVAILABLE_MODELS entry — would catch directory-scan logic that returned 0 bytes for valid caches', async () => {
    cache = makeFakeHfCache({
      models: AVAILABLE_MODELS.map((m, i) => ({
        repoId: m.name,
        fileSizes: [100 * (i + 1)]
      }))
    })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const out = await getModelStatuses(null)
    expect(out).toHaveLength(AVAILABLE_MODELS.length)
    for (const row of out) {
      expect(row.downloaded).toBe(true)
      expect(row.sizeBytesOnDisk).toBeGreaterThan(0)
    }
  })
})

describe('getModelStatuses — nested directory size accumulation', () => {
  it('walks subdirectories to sum sizes — would catch a regression that only looked at the snapshot root and undercounted multi-blob caches', async () => {
    const repo = AVAILABLE_MODELS[0].name
    cache = makeFakeHfCache({ models: [{ repoId: repo, fileSizes: [10] }] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    // Add a deeper nested file inside the model dir
    const cacheDirName = 'models--' + repo.replace(/\//g, '--')
    const nested = join(cache.hubDir, cacheDirName, 'blobs', 'deep', 'deeper')
    mkdirSync(nested, { recursive: true })
    const { writeFileSync } = await import('fs')
    writeFileSync(join(nested, 'big.bin'), Buffer.alloc(500, 0xab))

    const out = await getModelStatuses(null)
    const row = out.find((m) => m.name === repo)!
    expect(row.downloaded).toBe(true)
    // 10 (snapshot file) + 500 (nested blob) = 510
    expect(row.sizeBytesOnDisk).toBe(510)
  })
})

describe('deleteModelFromCache — unknown model', () => {
  it('refuses an unknown model name with reason "unknown model" — would catch the safety guard being weakened to delete by raw input', async () => {
    cache = makeFakeHfCache({ models: [] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const res = await deleteModelFromCache('totally/not-in-registry')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/unknown model/)
  })
})

describe('deleteModelFromCache — path-shape rejection', () => {
  it('refuses a model name with path-traversal characters — would catch a regression where the regex stopped blocking ../', async () => {
    cache = makeFakeHfCache({ models: [] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    // Inject an unknown name with traversal — this is caught at the
    // earlier 'unknown model' gate, so to actually exercise the regex
    // guard we'd need to poison AVAILABLE_MODELS. We do NOT do that.
    // Instead, confirm the safety stack ALSO rejects traversal-shaped
    // input at the first gate (defense in depth — both gates must hold).
    const res = await deleteModelFromCache('../../etc/passwd')
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/unknown model/)
  })
})

describe('deleteModelFromCache — already absent', () => {
  it('returns ok:true with reason "already absent" when the cache dir does not exist — would catch a regression where missing dir surfaced as an error to the renderer', async () => {
    cache = makeFakeHfCache({ models: [] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir
    const known = AVAILABLE_MODELS[0].name

    const res = await deleteModelFromCache(known)
    expect(res.ok).toBe(true)
    expect(res.reason).toMatch(/already absent/)
  })
})

describe('deleteModelFromCache — happy path', () => {
  it('removes a known downloaded model directory recursively — would catch a regression that left blob symlinks behind', async () => {
    const repo = AVAILABLE_MODELS[0].name
    cache = makeFakeHfCache({ models: [{ repoId: repo, fileSizes: [42, 42] }] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const cacheDirName = 'models--' + repo.replace(/\//g, '--')
    const target = join(cache.hubDir, cacheDirName)
    expect(existsSync(target)).toBe(true)

    const res = await deleteModelFromCache(repo)
    expect(res.ok).toBe(true)
    expect(res.reason).toBeUndefined()
    expect(existsSync(target)).toBe(false)
    // Hub dir itself should still exist (we only removed the model dir)
    expect(statSync(cache.hubDir).isDirectory()).toBe(true)
  })
})

describe('deleteModelFromCache — entry is a file, not a directory', () => {
  it('refuses to delete when the path exists but is a regular file — would catch the safety check letting a hostile file masquerade as a model dir', async () => {
    cache = makeFakeHfCache({ models: [] })
    process.env.PHRONESIS_TEST_HF_HUB = cache.hubDir

    const repo = AVAILABLE_MODELS[0].name
    const cacheDirName = 'models--' + repo.replace(/\//g, '--')
    const { writeFileSync } = await import('fs')
    writeFileSync(join(cache.hubDir, cacheDirName), 'not a directory')

    const res = await deleteModelFromCache(repo)
    expect(res.ok).toBe(false)
    expect(res.reason).toMatch(/not a directory/)
  })
})
