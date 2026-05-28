/**
 * Shared test helper for filesystem-touching tests.
 *
 * uniqueTempDir() returns a fresh, empty directory under the OS temp dir,
 * prefixed for easy identification. Caller is responsible for cleanup via
 * the returned cleanup function (or relying on OS temp eviction).
 *
 * Rationale: tests must NEVER write inside src/ or the app's userData
 * directory (~/Library/Application Support/Phronesis/). Concurrent agent
 * worktrees writing to a shared real path would corrupt each other's
 * state. uniqueTempDir gives each test (or each test file's beforeAll)
 * an isolated playground.
 */
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

export interface TempDir {
  /** Absolute path to the freshly-created directory. */
  path: string
  /** Recursively delete the directory. Safe to call multiple times. */
  cleanup: () => void
}

/**
 * Create a unique temp directory under the OS temp root.
 * @param prefix Short label that appears in the directory name for debugging
 *               (e.g., "phronesis-fs-test-"). The OS appends randomness.
 */
export function uniqueTempDir(prefix = 'phronesis-test-'): TempDir {
  const path = mkdtempSync(join(tmpdir(), prefix))
  let removed = false
  return {
    path,
    cleanup: () => {
      if (removed) return
      removed = true
      try {
        rmSync(path, { recursive: true, force: true })
      } catch {
        /* best effort */
      }
    }
  }
}

/**
 * Simulate a HuggingFace cache layout under a temp dir, for testing
 * getModelStatuses without touching the real cache.
 *
 * Creates: <root>/hub/models--<org>--<repo>/snapshots/<sha>/<file>
 * Each file gets the given size in bytes (random-ish content).
 */
export function makeFakeHfCache(opts: {
  models: Array<{ repoId: string; fileSizes: number[] }>
}): TempDir & { hubDir: string } {
  const dir = uniqueTempDir('phronesis-hfcache-')
  const hubDir = join(dir.path, 'hub')
  const fs = require('fs') as typeof import('fs')
  fs.mkdirSync(hubDir, { recursive: true })

  for (const m of opts.models) {
    const cacheDirName = 'models--' + m.repoId.replace(/\//g, '--')
    const snapDir = join(hubDir, cacheDirName, 'snapshots', 'abcdef0123456789')
    fs.mkdirSync(snapDir, { recursive: true })
    m.fileSizes.forEach((bytes, idx) => {
      fs.writeFileSync(join(snapDir, `file-${idx}.bin`), Buffer.alloc(bytes, 0xaa))
    })
  }

  return { ...dir, hubDir }
}
