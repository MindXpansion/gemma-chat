import { spawn } from 'child_process'
import { existsSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Patch 33: NotebookLM CLI bridge. Wraps the `notebooklm` binary the same
 * way aios-integration wraps the temporal-intelligence Python scripts.
 *
 * Auth: the CLI authenticates via a browser session persisted to
 * ~/.notebooklm/storage_state.json. `notebooklm login` is interactive
 * (opens a browser) — Gemma cannot do it. When a command fails on auth,
 * runNotebookLM surfaces a clean "session expired" message so Gemma can
 * tell Bear to re-run `notebooklm login` in a terminal.
 *
 * Latency: `ask`/`summary` are browser-automation slow (10-30s); artifact
 * generation can take minutes. Per-call timeouts are set by each tool.
 */

const BIN_CANDIDATES = [
  join(homedir(), 'miniforge3/bin/notebooklm'),
  '/Library/Frameworks/Python.framework/Versions/3.13/bin/notebooklm'
]

let cachedBin: string | null = null

function notebooklmBin(): string {
  if (cachedBin) return cachedBin
  cachedBin = BIN_CANDIDATES.find((p) => existsSync(p)) ?? 'notebooklm'
  return cachedBin
}

const AUTH_FAIL_RE = /not (?:authenticated|logged in)|please log ?in|session (?:expired|invalid)|storage_state|sign in to/i

export interface NlmResult {
  ok: boolean
  stdout: string
  stderr: string
  authExpired: boolean
}

/**
 * Run a notebooklm CLI command. `args` is the argv after the binary.
 * Output is capped; a non-zero exit with an auth-shaped error sets
 * authExpired so callers can return a clean re-login prompt.
 */
export function runNotebookLM(
  args: string[],
  timeoutMs = 90_000,
  cwd?: string
): Promise<NlmResult> {
  return new Promise((resolve) => {
    const proc = spawn(notebooklmBin(), args, {
      env: process.env,
      cwd,
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stdout = ''
    let stderr = ''
    // Generous — `list` over a large library is sizable. Memory-safety cap
    // only; each tool is responsible for what it returns to the model.
    const MAX = 400_000
    let killed = false
    const timer = setTimeout(() => {
      killed = true
      proc.kill('SIGKILL')
    }, timeoutMs)

    proc.stdout.on('data', (d: Buffer) => {
      if (stdout.length < MAX) stdout += d.toString('utf-8')
    })
    proc.stderr.on('data', (d: Buffer) => {
      if (stderr.length < MAX) stderr += d.toString('utf-8')
    })
    proc.on('error', (e) => {
      clearTimeout(timer)
      resolve({ ok: false, stdout, stderr: String(e), authExpired: false })
    })
    proc.on('close', (code) => {
      clearTimeout(timer)
      if (killed) {
        resolve({
          ok: false,
          stdout: stdout.slice(0, MAX),
          stderr: `notebooklm timed out after ${Math.round(timeoutMs / 1000)}s`,
          authExpired: false
        })
        return
      }
      const combined = stdout + '\n' + stderr
      resolve({
        ok: code === 0,
        stdout: stdout.slice(0, MAX),
        stderr: stderr.slice(0, MAX),
        authExpired: code !== 0 && AUTH_FAIL_RE.test(combined)
      })
    })
  })
}

/** Standard failure text for callers — keeps the auth message consistent. */
export function nlmErrorText(r: NlmResult): string {
  if (r.authExpired) {
    return 'NotebookLM session expired. Bear needs to run `notebooklm login` in a terminal to re-authenticate (it opens a browser — you cannot do it yourself).'
  }
  const msg = (r.stderr || r.stdout || 'unknown error').trim()
  return `NotebookLM CLI error: ${msg.slice(0, 600)}`
}

export interface NotebookRef {
  id: string
  title: string
}

/** Pull a usable id + title out of a CLI JSON row, field-name-agnostic. */
export function rowIdTitle(n: Record<string, unknown>): NotebookRef {
  const id = String(n.id ?? n.notebook_id ?? n.notebookId ?? n.uuid ?? '?')
  const title = String(n.title ?? n.name ?? '(untitled)')
  return { id, title }
}

/**
 * Pull an array of rows out of a CLI JSON payload. The notebooklm CLI
 * wraps lists in an object — `list --json` returns
 * { "notebooks": [...], "count": N } — so a bare-array assumption fails.
 * Handles both a top-level array and the common wrapper keys.
 */
export function extractRows(data: unknown): Record<string, unknown>[] {
  if (Array.isArray(data)) return data as Record<string, unknown>[]
  if (data && typeof data === 'object') {
    const obj = data as Record<string, unknown>
    for (const key of ['notebooks', 'sources', 'artifacts', 'items', 'results', 'data']) {
      if (Array.isArray(obj[key])) return obj[key] as Record<string, unknown>[]
    }
  }
  return []
}

// 60s cache so resolveNotebook doesn't re-list on every nlm call.
let nbListCache: { at: number; list: NotebookRef[] } | null = null

/** Fetch (and cache) the full notebook list as {id,title} rows. */
export async function getNotebookList(force = false): Promise<NotebookRef[]> {
  if (!force && nbListCache && Date.now() - nbListCache.at < 60_000) {
    return nbListCache.list
  }
  const r = await runNotebookLM(['list', '--json'], 45_000)
  if (!r.ok) throw new Error(nlmErrorText(r))
  const rows = extractRows(parseNlmJson(r.stdout))
  const list = rows.map(rowIdTitle)
  // Don't cache an empty result — likely a transient parse/RPC miss.
  if (list.length > 0) nbListCache = { at: Date.now(), list }
  return list
}

/**
 * Resolve a notebook the way a human refers to one: by TITLE (full or
 * partial, case-insensitive) or by id (full or prefix). This is the fix
 * for "work with notebooks naturally" — Gemma should never need an exact
 * UUID. Returns the matched notebook, or a clear error on no/ambiguous
 * match.
 */
export async function resolveNotebook(
  query: string
): Promise<NotebookRef | { error: string }> {
  const q = query
    .replace(/[<>"'`]/g, '')
    .replace(/[.…\s]+$/, '')
    .trim()
  if (!q) return { error: 'no notebook specified' }

  let list: NotebookRef[]
  try {
    list = await getNotebookList()
  } catch (e) {
    return { error: (e as Error).message }
  }

  // 1. exact id
  const exactId = list.find((n) => n.id === q)
  if (exactId) return exactId
  // 2. id prefix (unique)
  const idPre = list.filter((n) => n.id.startsWith(q))
  if (idPre.length === 1) return idPre[0]
  // 3. exact title (case-insensitive)
  const ql = q.toLowerCase()
  const exactTitle = list.find((n) => n.title.toLowerCase() === ql)
  if (exactTitle) return exactTitle
  // 4. title substring (case-insensitive, unique)
  const titleSub = list.filter((n) => n.title.toLowerCase().includes(ql))
  if (titleSub.length === 1) return titleSub[0]
  if (titleSub.length > 1) {
    return {
      error: `"${query}" matches ${titleSub.length} notebooks — be more specific. Candidates: ${titleSub
        .slice(0, 6)
        .map((n) => `"${n.title}"`)
        .join(', ')}`
    }
  }
  if (idPre.length > 1) {
    return { error: `id prefix "${q}" matches ${idPre.length} notebooks — give more characters.` }
  }
  return { error: `no notebook matches "${query}". Use nlm_notebooks to see the list.` }
}

/** Try to parse JSON the CLI emitted; returns null if it isn't JSON. */
export function parseNlmJson<T = unknown>(stdout: string): T | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  try {
    return JSON.parse(trimmed) as T
  } catch {
    // Some commands print a banner line before the JSON — grab the first
    // {...} or [...] block.
    const match = trimmed.match(/(\{[\s\S]*\}|\[[\s\S]*\])\s*$/)
    if (match) {
      try {
        return JSON.parse(match[1]) as T
      } catch {
        return null
      }
    }
    return null
  }
}
