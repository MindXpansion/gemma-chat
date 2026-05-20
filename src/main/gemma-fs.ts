import { app } from 'electron'
import { mkdir, readFile, writeFile, rm, rename, stat, readdir, realpath } from 'fs/promises'
import { join, resolve, relative, dirname, isAbsolute, basename } from 'path'
import { homedir } from 'os'
import { spawn } from 'child_process'
import { assertInWorkspace } from './workspace'

/**
 * Patch 31 — Gemma filesystem access. Two surfaces:
 *   • Home  — ~/GemmaWorkspace/, persistent, always read-write. Hers.
 *   • Mounts — N user-pointed folders, each with a posture mode.
 *
 * Layer 1 (this file's first cut): Home + the multi-mount registry +
 * state persistence + a path-safe resolver + generic file ops. The mount
 * PICKER UI and mount-scoped tool wiring land in Layer 2; write/bash
 * gating in Layer 3; indexing in Layer 4.
 *
 * Path safety: every op goes through safeResolve(), which runs the
 * existing assertInWorkspace guard (rejects `..` and absolute paths) AND
 * a post-realpath containment re-check (defeats symlink escape).
 */

export type MountMode = 'ro' | 'rw-confirm' | 'rw-free'

export interface Mount {
  id: string
  name: string
  path: string
  mode: MountMode
  indexed: boolean
  indexedAt?: number
}

interface FsState {
  mounts: Mount[]
}

export interface ResolvedRoot {
  absRoot: string
  mode: MountMode // 'home' resolves as rw-free
  label: string
}

const HOME_DIR = join(homedir(), 'GemmaWorkspace')

/** Single-file read cap — protects the context window (design §6 Q3). */
export const MAX_FILE_BYTES = 256 * 1024
/** Tree/list node cap for a single call. */
const MAX_TREE_NODES = 600

let state: FsState = { mounts: [] }
let loaded = false

function statePath(): string {
  return join(app.getPath('userData'), 'gemma-fs-state.json')
}

export async function loadFsState(): Promise<void> {
  if (loaded) return
  try {
    const raw = await readFile(statePath(), 'utf-8')
    const parsed = JSON.parse(raw) as Partial<FsState>
    if (parsed && Array.isArray(parsed.mounts)) {
      state = { mounts: parsed.mounts.filter((m): m is Mount => !!m && typeof m.path === 'string') }
    }
  } catch {
    // no state file yet — first run
  }
  loaded = true
}

async function saveFsState(): Promise<void> {
  await writeFile(statePath(), JSON.stringify(state, null, 2), 'utf-8')
}

export async function ensureGemmaHome(): Promise<string> {
  await mkdir(HOME_DIR, { recursive: true })
  return HOME_DIR
}

// --- Mount registry --------------------------------------------------------

export function listMounts(): Mount[] {
  return state.mounts.slice()
}

function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'mount'
}

export async function addMount(absPath: string, mode: MountMode): Promise<Mount> {
  const resolved = resolve(absPath)
  const existing = state.mounts.find((m) => m.path === resolved)
  if (existing) {
    existing.mode = mode
    await saveFsState()
    return existing
  }
  const name = basename(resolved)
  let id = slugify(name)
  let n = 2
  while (state.mounts.some((m) => m.id === id)) id = `${slugify(name)}-${n++}`
  const mount: Mount = { id, name, path: resolved, mode, indexed: false }
  state.mounts.push(mount)
  await saveFsState()
  return mount
}

export async function removeMount(id: string): Promise<boolean> {
  const before = state.mounts.length
  state.mounts = state.mounts.filter((m) => m.id !== id)
  if (state.mounts.length !== before) {
    await saveFsState()
    return true
  }
  return false
}

export async function setMountMode(id: string, mode: MountMode): Promise<boolean> {
  const m = state.mounts.find((x) => x.id === id)
  if (!m) return false
  m.mode = mode
  await saveFsState()
  return true
}

export async function setMountIndexed(id: string, indexed: boolean): Promise<void> {
  const m = state.mounts.find((x) => x.id === id)
  if (!m) return
  m.indexed = indexed
  m.indexedAt = indexed ? Date.now() : undefined
  await saveFsState()
}

// --- Root resolution -------------------------------------------------------

export function resolveRoot(root: string): ResolvedRoot | { error: string } {
  // Tolerate what small models actually emit: placeholder <brackets>
  // anywhere (Gemma wraps values like /Users/bear/<_Autonomous>),
  // surrounding quotes, stray whitespace.
  let r = (root || 'home')
    .replace(/[<>]/g, '')
    .replace(/^["'`\s]+|["'`\s]+$/g, '')

  if (r === 'home' || r === HOME_DIR || r === '~/GemmaWorkspace' || r === '~') {
    return { absRoot: HOME_DIR, mode: 'rw-free', label: 'Home (~/GemmaWorkspace)' }
  }

  // Exact mount id or display name.
  let m = state.mounts.find((x) => x.id === r || x.name === r)

  // Forgiving: a small model often passes a full path or basename instead
  // of the short mount id. Match those against the registry too.
  if (!m && (r.includes('/') || r.startsWith('~'))) {
    const resolved = resolve(r.replace(/^~(?=\/|$)/, homedir()))
    const base = basename(resolved)
    if (resolved === HOME_DIR || base === 'GemmaWorkspace') {
      return { absRoot: HOME_DIR, mode: 'rw-free', label: 'Home (~/GemmaWorkspace)' }
    }
    m = state.mounts.find(
      (x) => x.path === resolved || basename(x.path) === base || x.name === base
    )
  }

  if (!m) {
    const valid = ['home', ...state.mounts.map((x) => x.id)].join(', ')
    return { error: `Unknown root "${root}". Valid roots: ${valid}` }
  }
  return { absRoot: m.path, mode: m.mode, label: m.name }
}

/**
 * Path-safe resolution. `mustExist=true` realpaths the target itself;
 * `false` (for writes) realpaths the parent dir and creates it. Either
 * way the resolved real path must stay inside the realpath'd root.
 */
async function safeResolve(absRoot: string, relPath: string, mustExist: boolean): Promise<string> {
  const target = assertInWorkspace(absRoot, relPath)
  const realRoot = await realpath(absRoot)
  if (mustExist) {
    const realTarget = await realpath(target)
    const rel = relative(realRoot, realTarget)
    if (rel.startsWith('..') || isAbsolute(rel)) {
      throw new Error('Path escapes root via symlink')
    }
    return realTarget
  }
  const parent = dirname(target)
  await mkdir(parent, { recursive: true })
  const realParent = await realpath(parent)
  const relP = relative(realRoot, realParent)
  if (relP.startsWith('..') || isAbsolute(relP)) {
    throw new Error('Path escapes root via symlink')
  }
  return join(realParent, basename(target))
}

// --- Generic file ops ------------------------------------------------------

const SKIP_DIRS = new Set(['.git', 'node_modules', '.DS_Store'])

export interface FsTreeEntry {
  path: string
  kind: 'file' | 'dir'
  size?: number
}

export async function fsTree(
  absRoot: string,
  startRel: string,
  maxDepth: number
): Promise<{ entries: FsTreeEntry[]; truncated: boolean }> {
  const start = startRel ? await safeResolve(absRoot, startRel, true) : await realpath(absRoot)
  const entries: FsTreeEntry[] = []
  let truncated = false

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || entries.length >= MAX_TREE_NODES) {
      if (entries.length >= MAX_TREE_NODES) truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    dirents.sort((a, b) => {
      if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    for (const d of dirents) {
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue
      if (entries.length >= MAX_TREE_NODES) {
        truncated = true
        return
      }
      const rel = prefix ? `${prefix}/${d.name}` : d.name
      const abs = join(dir, d.name)
      if (d.isDirectory()) {
        entries.push({ path: rel, kind: 'dir' })
        await walk(abs, rel, depth + 1)
      } else {
        try {
          const s = await stat(abs)
          entries.push({ path: rel, kind: 'file', size: s.size })
        } catch {
          entries.push({ path: rel, kind: 'file' })
        }
      }
    }
  }

  await walk(start, startRel, 1)
  return { entries, truncated }
}

export async function fsList(
  absRoot: string,
  relPath: string
): Promise<FsTreeEntry[]> {
  const dir = relPath ? await safeResolve(absRoot, relPath, true) : await realpath(absRoot)
  const dirents = await readdir(dir, { withFileTypes: true })
  dirents.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  const out: FsTreeEntry[] = []
  for (const d of dirents) {
    if (d.name === '.DS_Store') continue
    const abs = join(dir, d.name)
    if (d.isDirectory()) {
      out.push({ path: d.name, kind: 'dir' })
    } else {
      try {
        const s = await stat(abs)
        out.push({ path: d.name, kind: 'file', size: s.size })
      } catch {
        out.push({ path: d.name, kind: 'file' })
      }
    }
  }
  return out
}

export interface FsReadResult {
  content: string
  truncated: boolean
  binary: boolean
  bytes: number
}

export async function fsRead(absRoot: string, relPath: string): Promise<FsReadResult> {
  const target = await safeResolve(absRoot, relPath, true)
  const s = await stat(target)
  if (s.isDirectory()) {
    throw new Error(`${relPath} is a directory — use fs_list`)
  }
  const buf = await readFile(target)
  // Binary detection: a NUL byte in the first 8KB.
  const sample = buf.subarray(0, 8192)
  const binary = sample.includes(0)
  if (binary) {
    return { content: '', truncated: false, binary: true, bytes: s.size }
  }
  const truncated = buf.length > MAX_FILE_BYTES
  const slice = truncated ? buf.subarray(0, MAX_FILE_BYTES) : buf
  return {
    content: slice.toString('utf-8'),
    truncated,
    binary: false,
    bytes: s.size
  }
}

export async function fsWrite(absRoot: string, relPath: string, content: string): Promise<void> {
  const target = await safeResolve(absRoot, relPath, false)
  const tmp = `${target}.tmp-${Date.now()}`
  await writeFile(tmp, content, 'utf-8')
  await rename(tmp, target)
}

export async function fsEdit(
  absRoot: string,
  relPath: string,
  oldString: string,
  newString: string,
  replaceAll: boolean
): Promise<number> {
  const target = await safeResolve(absRoot, relPath, true)
  const content = await readFile(target, 'utf-8')
  if (replaceAll) {
    const parts = content.split(oldString)
    if (parts.length === 1) throw new Error(`old_string not found in ${relPath}`)
    await fsWrite(absRoot, relPath, parts.join(newString))
    return parts.length - 1
  }
  const idx = content.indexOf(oldString)
  if (idx < 0) throw new Error(`old_string not found in ${relPath}`)
  if (content.indexOf(oldString, idx + oldString.length) >= 0) {
    throw new Error(`old_string appears multiple times in ${relPath}. Use replace_all or add context.`)
  }
  await fsWrite(absRoot, relPath, content.slice(0, idx) + newString + content.slice(idx + oldString.length))
  return 1
}

export async function fsDelete(absRoot: string, relPath: string): Promise<void> {
  if (/(^|\/)\.git(\/|$)/.test(relPath)) {
    throw new Error('Refused: cannot delete inside a .git directory')
  }
  const target = await safeResolve(absRoot, relPath, true)
  await rm(target, { recursive: true, force: true })
}

// --- Content search --------------------------------------------------------

export interface SearchHit {
  path: string
  line: number
  text: string
}

/** Per-call caps — keep a search result well inside the context budget. */
const MAX_SEARCH_HITS = 80
const MAX_SEARCH_FILE_BYTES = 512 * 1024

/**
 * Case-insensitive substring search across text files under a root.
 * Skips dotfiles, .git, node_modules, binary files, and oversized files.
 */
export async function fsSearch(
  absRoot: string,
  query: string,
  startRel: string,
  maxDepth: number
): Promise<{ hits: SearchHit[]; truncated: boolean }> {
  const start = startRel ? await safeResolve(absRoot, startRel, true) : await realpath(absRoot)
  const needle = query.toLowerCase()
  const hits: SearchHit[] = []
  let truncated = false

  async function walk(dir: string, prefix: string, depth: number): Promise<void> {
    if (depth > maxDepth || hits.length >= MAX_SEARCH_HITS) {
      if (hits.length >= MAX_SEARCH_HITS) truncated = true
      return
    }
    let dirents
    try {
      dirents = await readdir(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const d of dirents) {
      if (hits.length >= MAX_SEARCH_HITS) {
        truncated = true
        return
      }
      if (d.name.startsWith('.') || SKIP_DIRS.has(d.name)) continue
      const rel = prefix ? `${prefix}/${d.name}` : d.name
      const abs = join(dir, d.name)
      if (d.isDirectory()) {
        await walk(abs, rel, depth + 1)
        continue
      }
      let buf
      try {
        const s = await stat(abs)
        if (s.size > MAX_SEARCH_FILE_BYTES) continue
        buf = await readFile(abs)
      } catch {
        continue
      }
      if (buf.subarray(0, 8192).includes(0)) continue // binary
      const lines = buf.toString('utf-8').split('\n')
      for (let i = 0; i < lines.length; i++) {
        if (lines[i].toLowerCase().includes(needle)) {
          hits.push({ path: rel, line: i + 1, text: lines[i].trim().slice(0, 200) })
          if (hits.length >= MAX_SEARCH_HITS) {
            truncated = true
            return
          }
        }
      }
    }
  }

  await walk(start, startRel, 1)
  return { hits, truncated }
}

// --- Shell --------------------------------------------------------------

const BASH_DENY =
  /\b(rm\s+-rf\s+\/|sudo|:\(\)\s*\{|chmod\s+777\s+\/|mkfs|dd\s+if=|shutdown|reboot)\b/i

export interface BashResult {
  exitCode: number | null
  stdout: string
  stderr: string
  truncated: boolean
  durationMs: number
}

/** Run a shell command inside a root's directory. Deny-pattern screened. */
export async function fsBash(
  absRoot: string,
  command: string,
  timeoutMs = 60_000,
  maxBytes = 16_000
): Promise<BashResult> {
  if (BASH_DENY.test(command)) {
    throw new Error('Blocked by safety policy: command contains a denied pattern.')
  }
  const cwd = await realpath(absRoot)
  const start = Date.now()
  return new Promise((resolveP) => {
    const proc = spawn('/bin/bash', ['-lc', command], {
      cwd,
      env: { ...process.env, FORCE_COLOR: '0', NO_COLOR: '1' }
    })
    let stdout = ''
    let stderr = ''
    let truncated = false
    const killTimer = setTimeout(() => {
      proc.kill('SIGKILL')
      truncated = true
    }, timeoutMs)
    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length < maxBytes) {
        stdout += d.toString('utf-8')
        if (stdout.length >= maxBytes) {
          stdout = stdout.slice(0, maxBytes) + '\n[…output truncated]'
          truncated = true
        }
      }
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < maxBytes) {
        stderr += d.toString('utf-8')
        if (stderr.length >= maxBytes) {
          stderr = stderr.slice(0, maxBytes) + '\n[…stderr truncated]'
          truncated = true
        }
      }
    })
    proc.on('close', (code) => {
      clearTimeout(killTimer)
      resolveP({ exitCode: code, stdout, stderr, truncated, durationMs: Date.now() - start })
    })
    proc.on('error', (e) => {
      clearTimeout(killTimer)
      resolveP({
        exitCode: -1,
        stdout,
        stderr: (stderr + '\n' + String(e)).trim(),
        truncated,
        durationMs: Date.now() - start
      })
    })
  })
}
