import { spawnSync } from 'child_process'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Patch 17 (AIOS integration): bridges Gemma into Bear's existing AIOS
 * subsystems — temporal-intelligence (grounding), intelligence-partner-v3
 * (memory + relationship), and RISE (cognition). Replaces Patch 16's
 * standalone reinventions.
 *
 * HYBRID write boundaries (Bear 2026-05-18 revision):
 *   READ:  ~/Skills/temporal-intelligence (via Python), ~/.intelligence_partner/*.md
 *   WRITE: ~/.intelligence_partner/*.md (section-based patches, whitelist enforced)
 *   NOT:   ~/Skills/* (sacrosanct), partnership_state.py invocations (files yes, state machine no)
 */

const TEMPORAL_SCRIPT = join(
  homedir(),
  'Skills/temporal-intelligence/scripts/temporal_context.py'
)
const WEATHER_SCRIPT = join(
  homedir(),
  'Skills/temporal-intelligence/scripts/get_weather.py'
)
const MAPS_SCRIPT = join(
  homedir(),
  'Skills/temporal-intelligence/scripts/google_maps.py'
)
const IPP_DIR = join(homedir(), '.intelligence_partner')
const ARCHITECT_PATTERNS_DIR = join(
  homedir(),
  '.claude/agent-memory/neo4j-kg-architect/patterns'
)

export const IPP_FILES = ['memory', 'preferences', 'comms', 'soul', 'ideals'] as const
export type IppFile = (typeof IPP_FILES)[number]

function ippPath(file: IppFile): string {
  return join(IPP_DIR, `${file}.md`)
}

// ── Temporal Intelligence ───────────────────────────────────────────────

let temporalCache: { text: string; ts: number } | null = null
const TEMPORAL_TTL_MS = 60_000

/**
 * Invoke `python3 temporal_context.py --summary --no-weather` and return
 * the produced block. Cached for 60s. Silent fallback to empty string on
 * any failure — caller decides what to do with that.
 */
export function loadTemporalContext(): string {
  const now = Date.now()
  if (temporalCache && now - temporalCache.ts < TEMPORAL_TTL_MS) {
    return temporalCache.text
  }
  if (!existsSync(TEMPORAL_SCRIPT)) {
    return ''
  }
  try {
    const r = spawnSync('python3', [TEMPORAL_SCRIPT, '--summary', '--no-weather'], {
      timeout: 5000,
      encoding: 'utf-8'
    })
    if (r.status !== 0 || !r.stdout) {
      return ''
    }
    const text = r.stdout.trim()
    temporalCache = { text, ts: now }
    return text
  } catch {
    return ''
  }
}

// ── Intelligence Partner Profile ────────────────────────────────────────

let partnerProfileCache: string | null = null

/**
 * Read soul + preferences + comms + ideals from ~/.intelligence_partner/
 * and concat into one block. Skips memory.md (Bear-and-Claude session log,
 * heavy, not Gemma's context). Cached for app session — re-loaded only on
 * explicit refreshPartnerProfile().
 */
export function loadPartnerProfile(): string {
  if (partnerProfileCache !== null) return partnerProfileCache
  const sections: string[] = []
  // Order: identity → preferences → communication → principles
  for (const file of ['soul', 'preferences', 'comms', 'ideals'] as const) {
    const p = ippPath(file)
    if (!existsSync(p)) continue
    try {
      const body = readFileSync(p, 'utf-8').trim()
      sections.push(`### IPP/${file}.md\n\n${body}`)
    } catch {
      // skip file on read error
    }
  }
  partnerProfileCache = sections.join('\n\n---\n\n')
  return partnerProfileCache
}

export function refreshPartnerProfile(): void {
  partnerProfileCache = null
}

// ── IPP file writes (whitelist-enforced) ────────────────────────────────

function isIppFile(name: string): name is IppFile {
  return (IPP_FILES as readonly string[]).includes(name)
}

/**
 * Read one IPP file by short name (e.g. "memory", "preferences"). Returns
 * file body or an error string. Used by Gemma's `ipp_read` tool to fetch
 * current state before editing.
 */
export function readIppFile(name: string): string {
  if (!isIppFile(name)) {
    return `Error: "${name}" is not an IPP file. Allowed: ${IPP_FILES.join(', ')}`
  }
  const p = ippPath(name)
  if (!existsSync(p)) return `Error: ${p} does not exist.`
  try {
    return readFileSync(p, 'utf-8')
  } catch (e) {
    return `Error reading ${p}: ${(e as Error).message}`
  }
}

/**
 * Surgical section-based patch on an IPP file (matches IPP ideal #6:
 * "Section-Based Patching — never full rewrites"). old_string must appear
 * exactly once or the call is rejected. Refreshes the profile cache so
 * subsequent system prompts see the change.
 */
export function editIppFile(name: string, oldString: string, newString: string): string {
  if (!isIppFile(name)) {
    return `Error: "${name}" is not an IPP file. Allowed: ${IPP_FILES.join(', ')}`
  }
  if (!oldString) return 'Error: old_string is required (no full-file rewrites).'
  const p = ippPath(name)
  if (!existsSync(p)) return `Error: ${p} does not exist.`
  let body: string
  try {
    body = readFileSync(p, 'utf-8')
  } catch (e) {
    return `Error reading ${p}: ${(e as Error).message}`
  }
  const occurrences = body.split(oldString).length - 1
  if (occurrences === 0) {
    return `Error: old_string not found in ${name}.md. Read the file first with ipp_read.`
  }
  if (occurrences > 1) {
    return `Error: old_string matches ${occurrences} times in ${name}.md — provide more surrounding context for a unique match.`
  }
  const next = body.replace(oldString, newString)
  try {
    writeFileSync(p, next, 'utf-8')
  } catch (e) {
    return `Error writing ${p}: ${(e as Error).message}`
  }
  refreshPartnerProfile()
  return `Edited ${name}.md (1 replacement, ${oldString.length}→${newString.length} chars).`
}

/**
 * Append a timestamped entry to an IPP file. Convenience for the common
 * memory.md case ("auto-write after conversations" per its own header)
 * but works on any whitelisted IPP file.
 */
export function appendIppFile(name: string, content: string): string {
  if (!isIppFile(name)) {
    return `Error: "${name}" is not an IPP file. Allowed: ${IPP_FILES.join(', ')}`
  }
  const text = content.trim()
  if (!text) return 'Error: content is empty.'
  const p = ippPath(name)
  if (!existsSync(p)) return `Error: ${p} does not exist.`
  const stamp = new Date().toISOString().slice(0, 10)
  const entry = `\n\n---\n\n## ${stamp} — Gemma\n\n${text}\n`
  let body: string
  try {
    body = readFileSync(p, 'utf-8')
  } catch (e) {
    return `Error reading ${p}: ${(e as Error).message}`
  }
  try {
    writeFileSync(p, body.replace(/\n+$/, '') + entry, 'utf-8')
  } catch (e) {
    return `Error writing ${p}: ${(e as Error).message}`
  }
  refreshPartnerProfile()
  return `Appended to ${name}.md (${text.length} chars under heading "${stamp} — Gemma").`
}

// ── AIOS capability tools (Patch 18) ────────────────────────────────────

/**
 * Generic helper to run a Python script with bounded timeout and return
 * stdout. process.env is inherited (so GOOGLE_MAPS_API_KEY loaded at boot
 * by env-loader.ts is visible to the child). Returns a user-facing error
 * string on failure; never throws.
 */
function runPython(script: string, args: string[], timeoutMs: number): string {
  if (!existsSync(script)) {
    return `Error: required AIOS script not found at ${script}.`
  }
  try {
    const r = spawnSync('python3', [script, ...args], {
      timeout: timeoutMs,
      encoding: 'utf-8',
      env: process.env
    })
    if (r.status !== 0) {
      const tail = (r.stderr || r.stdout || '').trim().split('\n').slice(-5).join('\n')
      return `Error (exit ${r.status ?? 'killed'}): ${tail || 'no output'}`
    }
    const out = (r.stdout || '').trim()
    return out || '(no output)'
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

/**
 * Wraps get_weather.py. Default location resolves to geo-config home
 * (Colorado Springs). No API key needed (Open-Meteo + wttr.in fallback).
 */
export function getWeather(location?: string): string {
  const args = ['--format', 'brief']
  if (location && location.trim()) args.push('--location', location.trim())
  return runPython(WEATHER_SCRIPT, args, 10_000)
}

/**
 * Wraps google_maps.py --directions. Requires GOOGLE_MAPS_API_KEY in env.
 */
export function getDirections(origin: string, destination: string, mode = 'driving'): string {
  if (!origin || !destination) return 'Error: origin and destination are both required.'
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return 'Error: GOOGLE_MAPS_API_KEY not set. Add `GOOGLE_MAPS_API_KEY="..."` to ~/.gemma-chat.env or ~/.zshenv and restart the app.'
  }
  return runPython(
    MAPS_SCRIPT,
    ['--directions', origin, destination, '--mode', mode, '--format', 'text'],
    15_000
  )
}

/**
 * Wraps google_maps.py --distance-matrix. First arg is origin, rest are
 * destinations. Requires GOOGLE_MAPS_API_KEY.
 */
export function getDistance(origin: string, destinations: string[]): string {
  if (!origin || destinations.length === 0) {
    return 'Error: origin and at least one destination are required.'
  }
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return 'Error: GOOGLE_MAPS_API_KEY not set. Add `GOOGLE_MAPS_API_KEY="..."` to ~/.gemma-chat.env or ~/.zshenv and restart the app.'
  }
  return runPython(
    MAPS_SCRIPT,
    ['--distance-matrix', origin, ...destinations, '--format', 'text'],
    15_000
  )
}

/**
 * Wraps google_maps.py --places. `near` biases the search location.
 */
export function searchPlaces(query: string, near?: string): string {
  if (!query) return 'Error: query is required.'
  if (!process.env.GOOGLE_MAPS_API_KEY) {
    return 'Error: GOOGLE_MAPS_API_KEY not set. Add `GOOGLE_MAPS_API_KEY="..."` to ~/.gemma-chat.env or ~/.zshenv and restart the app.'
  }
  const args = ['--places', query, '--format', 'text']
  if (near && near.trim()) args.push('--near', near.trim())
  return runPython(MAPS_SCRIPT, args, 15_000)
}

/**
 * Wraps temporal_context.py --day. Episodic recall against TaskFlow Pro
 * SQLite. day_expr accepts "yesterday", "last monday", "2026-05-12", etc.
 */
export function episodicRecall(dayExpr: string, client?: string): string {
  if (!dayExpr) return 'Error: day_expr is required (e.g. "yesterday", "last monday", "2026-05-12").'
  const args = ['--day', dayExpr]
  if (client && client.trim()) args.push('--client', client.trim())
  return runPython(TEMPORAL_SCRIPT, args, 10_000)
}

/**
 * Wraps temporal_context.py --week. Returns this week's TaskFlow activity
 * grouped by day.
 */
export function weekSummary(): string {
  return runPython(TEMPORAL_SCRIPT, ['--week'], 10_000)
}

// ── neo4j-kg-architect institutional knowledge (Patch 19) ──────────────

let architectPatternsCache: string | null = null

/**
 * Read the architect subagent's successful + anti pattern files and
 * concat for injection into Gemma's system prompt. The architect is a
 * Claude Code subagent Gemma can't summon directly; this gives her the
 * lessons it has learned across 354+ sessions so she can wield Cypher
 * with the same discipline.
 *
 * Cached for app session — restart to refresh.
 */
export function loadArchitectPatterns(): string {
  if (architectPatternsCache !== null) return architectPatternsCache
  const sections: string[] = []
  for (const file of ['anti-patterns.md', 'successful-patterns.md']) {
    const p = join(ARCHITECT_PATTERNS_DIR, file)
    if (!existsSync(p)) continue
    try {
      const body = readFileSync(p, 'utf-8').trim()
      sections.push(`### neo4j-kg-architect / ${file}\n\n${body}`)
    } catch {
      // skip
    }
  }
  architectPatternsCache = sections.join('\n\n---\n\n')
  return architectPatternsCache
}

// ── RISE cognitive protocol (taught via system prompt) ──────────────────

/**
 * Compact teaching of the 4-pillar RISE protocol. Sourced from
 * /Users/bear/Skills/rise-framework/rise-framework.md (already @imported
 * in Bear's global CLAUDE.md). This is the cognitive layer Bear wants
 * Gemma to operate within.
 */
export function risePrinciples(): string {
  return [
    'RISE — your cognitive protocol (4 pillars, applies to every non-trivial task)',
    '',
    '[R] REASONING — how you think',
    '  1. Ground first: anchor to current date/time/context (see TEMPORAL block above) before reasoning.',
    '  2. For non-trivial questions, generate 2-3 hypotheses, weigh evidence, then select. Never settle on the first plausible answer.',
    '  3. Counterfactual: ask "what would have to be true for this to be wrong?" before committing.',
    '  4. State confidence explicitly (Low/Medium/High). Hedge honestly — fluent confidence isn\'t worth anything if wrong.',
    '',
    '[I] INSIGHTS — what you notice',
    '  - Watch for recurring patterns (3+ data points), anomalies, cross-domain connections.',
    '  - When you spot one worth keeping, capture it (ipp_append memory or aios_observe). Insights that aren\'t recorded evaporate.',
    '',
    '[S] SELF-IMPROVEMENT — how you get better',
    '  - After meaningful interactions: what was the goal, what was the result, what\'s the delta, what\'s the lesson?',
    '  - Treat Bear\'s corrections as anti-pattern signals; treat his confirmations as successful-pattern signals. Both deserve capture.',
    '  - When uncertain about your own confidence, say so — calibration matters.',
    '',
    '[E] EXECUTION — how you deliver',
    '  - Decompose multi-step tasks into atomic units before doing them.',
    '  - Verify against the original request, not your interpretation of it. If you can\'t verify, say so.',
    '  - Classify failures: transient (retry) vs structural (redesign) vs external (ask). Never retry the same failing approach twice without changing something.',
    '',
    'Scale the protocol to the task: trivial = implicit, complex = expanded. The judgment of when to expand vs compress is itself a skill.'
  ].join('\n')
}
