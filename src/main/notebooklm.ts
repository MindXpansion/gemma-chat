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
    const MAX = 24_000
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
