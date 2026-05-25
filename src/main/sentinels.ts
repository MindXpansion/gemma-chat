import { readdir, readFile } from 'fs/promises'
import { join } from 'path'
import { homedir } from 'os'
import * as yaml from 'js-yaml'

/**
 * Tier 1.6 — Sentinel registry + YAML loader.
 *
 * Design: docs/research/08-tier1.6-sentinel-audit-tick.md
 *
 * Originator: Gemma's in-chat "Sentinel pattern" proposal (sentinel
 * scripts + sentinel_log.md). Reframed by Bear from launchd to
 * heartbeat-native; architect-designed the schema; this is the impl.
 *
 * Each sentinel is a YAML file under ~/GemmaWorkspace/sentinels/.
 * Hot-reloaded on every audit-tick (cheap, ≤20 files expected).
 * Each file = one read-only Cypher check + threshold + severity +
 * what to do on crossing. See design §5 for full schema.
 *
 * Hard constraints (enforced at parse-time, loud failures, logged):
 *   • Query must be read-only — regex rejects CREATE/MERGE/DELETE/
 *     SET/REMOVE/DROP plus APOC write procs
 *   • Query must return a column named `observed` with a scalar value
 *   • All required fields present, enums validated
 *   • A bad file is skipped; other sentinels still load
 *   • Loader NEVER throws to the audit-tick caller
 */

export type Severity = 'info' | 'warn' | 'critical'
export type Comparator = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
export type Action = 'log_only' | 'journal_appended' | 'follow_up_enqueued'

export interface Sentinel {
  name: string
  description: string
  enabled: boolean
  severity: Severity
  cadenceTicks: number
  query: string
  params: Record<string, unknown>
  threshold: number | string
  comparator: Comparator
  summaryTemplate: string
  actionOnCross: Action
  followUpPrompt?: string
  /** Path to the YAML this was loaded from. Diagnostic. */
  filePath: string
}

export function sentinelsDir(): string {
  return join(homedir(), 'GemmaWorkspace', 'sentinels')
}

// Severity → default action mapping (design §7). May be overridden by
// the YAML's optional `action_on_cross:` key.
const DEFAULT_ACTION_BY_SEVERITY: Record<Severity, Action> = {
  info: 'log_only',
  warn: 'journal_appended',
  critical: 'follow_up_enqueued'
}

const NAME_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/
const SEVERITIES: Severity[] = ['info', 'warn', 'critical']
const COMPARATORS: Comparator[] = ['gt', 'gte', 'lt', 'lte', 'eq', 'neq']
const ACTIONS: Action[] = ['log_only', 'journal_appended', 'follow_up_enqueued']

// Conservative write-keyword reject (design §5.3). False-positive over
// false-negative. If a legit read query trips this, the YAML author
// rewrites. APOC write procs caught via apoc.<write|create|delete|...>.
const WRITE_KEYWORD_RE = /\b(CREATE|MERGE|DELETE|SET|REMOVE|DROP)\b/i
const APOC_WRITE_RE = /\bapoc\.(create|merge|delete|refactor|periodic|export|trigger)\./i

function rejectIfNotReadOnly(query: string): string | null {
  if (WRITE_KEYWORD_RE.test(query)) {
    const match = query.match(WRITE_KEYWORD_RE)
    return `query contains write keyword '${match?.[0]}'`
  }
  if (APOC_WRITE_RE.test(query)) {
    const match = query.match(APOC_WRITE_RE)
    return `query contains APOC write proc '${match?.[0]}'`
  }
  return null
}

function rejectIfNoObservedColumn(query: string): string | null {
  // Best-effort: look for an alias 'observed' in the final RETURN.
  // Not perfect (a complex query with subqueries could fool it), but
  // catches the obvious "I forgot to alias the column" case.
  if (!/\bAS\s+observed\b/i.test(query)) {
    return "query missing 'AS observed' alias on a returned column"
  }
  return null
}

function parseOne(raw: unknown, filePath: string): Sentinel | { error: string } {
  if (!raw || typeof raw !== 'object') {
    return { error: 'YAML root is not an object' }
  }
  const obj = raw as Record<string, unknown>

  // Required strings
  for (const key of ['name', 'description', 'query', 'summary_template']) {
    if (typeof obj[key] !== 'string' || !(obj[key] as string).trim()) {
      return { error: `missing required string field '${key}'` }
    }
  }
  if (typeof obj.enabled !== 'boolean') {
    return { error: "missing required boolean field 'enabled'" }
  }

  const name = (obj.name as string).trim()
  if (!NAME_RE.test(name) || name.length > 80) {
    return { error: `'name' must be kebab-case, lowercase, ≤80 chars (got '${name}')` }
  }

  const severity = obj.severity as Severity
  if (!SEVERITIES.includes(severity)) {
    return { error: `'severity' must be one of ${SEVERITIES.join('|')}` }
  }

  const comparator = obj.comparator as Comparator
  if (!COMPARATORS.includes(comparator)) {
    return { error: `'comparator' must be one of ${COMPARATORS.join('|')}` }
  }

  const threshold = obj.threshold
  if (typeof threshold !== 'number' && typeof threshold !== 'string') {
    return { error: "'threshold' must be a number or string scalar" }
  }

  const query = (obj.query as string).trim()
  const writeErr = rejectIfNotReadOnly(query)
  if (writeErr) return { error: writeErr }
  const obsErr = rejectIfNoObservedColumn(query)
  if (obsErr) return { error: obsErr }

  const cadenceTicks =
    typeof obj.cadence_ticks === 'number' && obj.cadence_ticks >= 1
      ? Math.floor(obj.cadence_ticks)
      : 1

  let actionOnCross: Action
  if (obj.action_on_cross !== undefined) {
    if (!ACTIONS.includes(obj.action_on_cross as Action)) {
      return { error: `'action_on_cross' must be one of ${ACTIONS.join('|')}` }
    }
    actionOnCross = obj.action_on_cross as Action
  } else {
    actionOnCross = DEFAULT_ACTION_BY_SEVERITY[severity]
  }

  const followUpPrompt =
    typeof obj.follow_up_prompt === 'string' ? obj.follow_up_prompt.trim() : undefined
  if (actionOnCross === 'follow_up_enqueued' && !followUpPrompt) {
    return {
      error: "'action_on_cross: follow_up_enqueued' requires non-empty 'follow_up_prompt'"
    }
  }

  const params =
    obj.params && typeof obj.params === 'object' && !Array.isArray(obj.params)
      ? (obj.params as Record<string, unknown>)
      : {}

  return {
    name,
    description: (obj.description as string).trim(),
    enabled: obj.enabled,
    severity,
    cadenceTicks,
    query,
    params,
    threshold,
    comparator,
    summaryTemplate: (obj.summary_template as string).trim(),
    actionOnCross,
    followUpPrompt,
    filePath
  }
}

export async function loadSentinels(): Promise<Sentinel[]> {
  const dir = sentinelsDir()
  let entries: string[]
  try {
    entries = await readdir(dir)
  } catch {
    // Dir doesn't exist yet — zero sentinels. Audit tick will skip
    // gracefully. Operator creates dir + files when ready.
    return []
  }

  const out: Sentinel[] = []
  for (const entry of entries) {
    if (!/\.ya?ml$/i.test(entry)) continue
    if (entry.endsWith('.disabled')) continue // operator soft-disable convention
    const filePath = join(dir, entry)
    let raw: unknown
    try {
      const text = await readFile(filePath, 'utf-8')
      raw = yaml.load(text)
    } catch (e) {
      console.warn(`[heartbeat][sentinel][parse] ${entry}: YAML error: ${(e as Error).message}`)
      continue
    }
    const result = parseOne(raw, filePath)
    if ('error' in result) {
      console.warn(`[heartbeat][sentinel][parse] ${entry}: ${result.error}`)
      continue
    }
    out.push(result)
  }
  return out
}

/** Simple {token} replacement. No nested logic, no Mustache. */
export function interpolate(template: string, ctx: Record<string, unknown>): string {
  return template.replace(/\{(\w+)\}/g, (_, k) => {
    const v = ctx[k]
    if (v === undefined || v === null) return ''
    return String(v)
  })
}

export function comparatorFn(c: Comparator) {
  return (observed: number | string, threshold: number | string): boolean => {
    // Numeric compare if both sides parse as finite numbers; otherwise
    // string compare (lexicographic for gt/lt; equality for eq/neq).
    const oNum = Number(observed)
    const tNum = Number(threshold)
    const numeric =
      Number.isFinite(oNum) && Number.isFinite(tNum) && typeof observed !== 'boolean'
    const a = numeric ? oNum : String(observed)
    const b = numeric ? tNum : String(threshold)
    switch (c) {
      case 'gt':
        return a > b
      case 'gte':
        return a >= b
      case 'lt':
        return a < b
      case 'lte':
        return a <= b
      case 'eq':
        return a === b
      case 'neq':
        return a !== b
    }
  }
}
