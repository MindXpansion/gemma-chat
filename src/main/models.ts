/**
 * Patch 67 (Block D #132) — Models tab backend helpers.
 *
 * Two responsibilities:
 *   1. Inspect the HuggingFace cache to determine which AVAILABLE_MODELS are
 *      on disk and how much space each one occupies.
 *   2. Safely delete a model's cache directory (with name-shape validation
 *      so we never `rm -rf` something we shouldn't).
 *
 * The HF cache layout is well-defined: `~/.cache/huggingface/hub/models--{org}--{repo}`
 * (slashes in repo IDs become `--`). HF_HOME env var can relocate it.
 */

import { promises as fs } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import { AVAILABLE_MODELS, type ModelStatus, type ProviderId } from '@shared/types'

function hubDir(): string {
  const hfHome = process.env.HF_HOME
  if (hfHome) return join(hfHome, 'hub')
  return join(homedir(), '.cache', 'huggingface', 'hub')
}

/** "mlx-community/gemma-4-e4b-it-4bit" -> "models--mlx-community--gemma-4-e4b-it-4bit" */
function cacheDirNameFor(hfRepoId: string): string {
  return 'models--' + hfRepoId.replace(/\//g, '--')
}

async function dirSize(dir: string): Promise<number> {
  let total = 0
  const stack: string[] = [dir]
  while (stack.length > 0) {
    const cur = stack.pop()!
    let entries: import('fs').Dirent[]
    try {
      entries = await fs.readdir(cur, { withFileTypes: true })
    } catch {
      continue
    }
    for (const ent of entries) {
      const p = join(cur, ent.name)
      if (ent.isSymbolicLink()) {
        // Follow the symlink to count the blob it points at (HF cache uses
        // snapshots/ as symlinks into blobs/). lstat-then-stat avoids
        // double-counting the link entry itself.
        try {
          const st = await fs.stat(p)
          if (st.isFile()) total += st.size
        } catch {
          /* dangling link */
        }
      } else if (ent.isDirectory()) {
        stack.push(p)
      } else if (ent.isFile()) {
        try {
          const st = await fs.lstat(p)
          total += st.size
        } catch {
          /* gone mid-scan */
        }
      }
    }
  }
  return total
}

export async function getModelStatuses(activeModel: string | null): Promise<ModelStatus[]> {
  const hub = hubDir()
  const results: ModelStatus[] = []
  for (const m of AVAILABLE_MODELS) {
    const dir = join(hub, cacheDirNameFor(m.name))
    let downloaded = false
    let sizeBytesOnDisk: number | undefined
    try {
      const st = await fs.stat(dir)
      if (st.isDirectory()) {
        downloaded = true
        sizeBytesOnDisk = await dirSize(dir)
      }
    } catch {
      /* not downloaded */
    }
    results.push({
      name: m.name,
      providerId: m.providerId as ProviderId,
      downloaded,
      sizeBytesOnDisk,
      isActive: activeModel === m.name
    })
  }
  return results
}

/**
 * Safety-first delete: only removes a directory inside HF hub that matches the
 * exact `models--{org}--{repo}` shape for a name listed in AVAILABLE_MODELS.
 * Refuses anything else. Caller is responsible for stopping the MLX server
 * first if the deleted model is currently loaded.
 */
export async function deleteModelFromCache(name: string): Promise<{ ok: boolean; reason?: string }> {
  const known = AVAILABLE_MODELS.find((m) => m.name === name)
  if (!known) return { ok: false, reason: 'unknown model' }

  const dirName = cacheDirNameFor(name)
  // Defense in depth: the shape must be models--<single-org>--<repo>, no path traversal.
  if (!/^models--[A-Za-z0-9._-]+--[A-Za-z0-9._-]+$/.test(dirName)) {
    return { ok: false, reason: 'name shape rejected by safety check' }
  }

  const target = join(hubDir(), dirName)
  try {
    const st = await fs.stat(target)
    if (!st.isDirectory()) return { ok: false, reason: 'cache entry is not a directory' }
  } catch {
    return { ok: true, reason: 'already absent' }
  }

  await fs.rm(target, { recursive: true, force: true })
  return { ok: true }
}
