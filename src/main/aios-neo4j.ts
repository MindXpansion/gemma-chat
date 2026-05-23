import neo4j, { Driver, Session, QueryResult } from 'neo4j-driver'

/**
 * Patch 19 (Neo4j integration): gives Gemma read+write Cypher access to
 * Bear's partnership KG (the `kg-arch-enterprise` DBMS at
 * bolt://localhost:7687). Credentials loaded at app boot by env-loader.ts
 * from ~/.intelligence_partner/neo4j-creds.env.
 *
 * Distinction (Bear clarified 2026-05-18):
 *   • `kg-arch-enterprise` = the DBMS (this is what we connect to)
 *   • `neo4j-kg-architect` = the SUBAGENT that operates on it (lives in
 *     Claude Code, not callable from gemma-chat). Its pattern memory at
 *     ~/.claude/agent-memory/neo4j-kg-architect/patterns/ is injected
 *     into Gemma's system prompt by loadArchitectPatterns() in
 *     aios-integration.ts so she inherits its institutional knowledge.
 *
 * Write boundary REVISED (Bear, 2026-05-18 Patch 19 design): Gemma may
 * write to kg-arch-enterprise. She is guided by the architect's
 * anti-patterns in her prompt to be careful (e.g., add uniqueness
 * constraints with MERGE, never trust internal id(n), preflight port
 * conflicts).
 */

export type GraphTarget = 'partnership' | 'gemma'

interface GraphConfig {
  uriKey: string
  userKey: string
  passKey: string
  databaseKey?: string // explicit database; if absent, server's default is used
  label: string
}

const GRAPH_CONFIGS: Record<GraphTarget, GraphConfig> = {
  partnership: {
    uriKey: 'NEO4J_URI',
    userKey: 'NEO4J_USER',
    passKey: 'NEO4J_PASSWORD',
    label: 'partnership KG (kg-arch-enterprise, default neo4j DB)'
  },
  gemma: {
    uriKey: 'NEO4J_GEMMA_URI',
    userKey: 'NEO4J_GEMMA_USER',
    passKey: 'NEO4J_GEMMA_PASSWORD',
    databaseKey: 'NEO4J_GEMMA_DATABASE',
    label: 'gemma-chat-memory (your own KG)'
  }
}

const driverCache: Partial<Record<GraphTarget, Driver>> = {}
const driverFailures: Partial<Record<GraphTarget, string>> = {}

interface DriverStatus {
  ok: boolean
  uri?: string
  user?: string
  database?: string
  label: string
  reason?: string
}

function tryInitDriver(target: GraphTarget): DriverStatus {
  const cfg = GRAPH_CONFIGS[target]
  if (driverCache[target]) {
    return {
      ok: true,
      label: cfg.label,
      uri: process.env[cfg.uriKey],
      user: process.env[cfg.userKey],
      database: cfg.databaseKey ? process.env[cfg.databaseKey] : undefined
    }
  }
  if (driverFailures[target]) {
    return { ok: false, label: cfg.label, reason: driverFailures[target] }
  }

  const uri = process.env[cfg.uriKey]
  const user = process.env[cfg.userKey]
  const password = process.env[cfg.passKey]
  if (!uri || !user || !password) {
    const reason = `${cfg.uriKey} / ${cfg.userKey} / ${cfg.passKey} not set. env-loader reads from ~/.intelligence_partner/neo4j-creds.env (partnership) and ~/.gemma-chat.env (gemma-chat-memory) at boot.`
    driverFailures[target] = reason
    return { ok: false, label: cfg.label, reason }
  }
  try {
    driverCache[target] = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5000,
      maxConnectionPoolSize: 5
    })
    return {
      ok: true,
      label: cfg.label,
      uri,
      user,
      database: cfg.databaseKey ? process.env[cfg.databaseKey] : undefined
    }
  } catch (e) {
    const reason = (e as Error).message
    driverFailures[target] = reason
    return { ok: false, label: cfg.label, reason }
  }
}

function sessionFor(target: GraphTarget): Session | { error: string } {
  const status = tryInitDriver(target)
  if (!status.ok) return { error: `Neo4j driver for ${status.label} not initialized. ${status.reason}` }
  const driver = driverCache[target]!
  if (status.database) {
    return driver.session({ database: status.database })
  }
  return driver.session()
}

const WRITE_VERBS_RE = /\b(CREATE|MERGE|SET|DELETE|REMOVE|DROP|FOREACH|CALL\s+apoc\.\w+\.write)\b/i
const MAX_RESULT_ROWS = 50

function isWriteQuery(cypher: string): boolean {
  return WRITE_VERBS_RE.test(cypher)
}

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return 'null'
  if (typeof v === 'string') return v
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  if (neo4j.isInt(v)) return v.toString()
  if (Array.isArray(v)) return '[' + v.map(formatValue).join(', ') + ']'
  if (typeof v === 'object') {
    // Node or Relationship or generic object
    const obj = v as Record<string, unknown> & {
      labels?: string[]
      type?: string
      properties?: Record<string, unknown>
    }
    if (obj.labels && obj.properties) {
      return `(:${obj.labels.join(':')} ${JSON.stringify(obj.properties)})`
    }
    if (obj.type && obj.properties) {
      return `[:${obj.type} ${JSON.stringify(obj.properties)}]`
    }
    try {
      return JSON.stringify(v)
    } catch {
      return String(v)
    }
  }
  return String(v)
}

function formatResult(result: QueryResult, cypher: string): string {
  const records = result.records
  const summary = result.summary
  const counters = summary.counters.updates()
  const lines: string[] = []

  if (isWriteQuery(cypher)) {
    const changes = [
      counters.nodesCreated && `nodes+${counters.nodesCreated}`,
      counters.nodesDeleted && `nodes-${counters.nodesDeleted}`,
      counters.relationshipsCreated && `rels+${counters.relationshipsCreated}`,
      counters.relationshipsDeleted && `rels-${counters.relationshipsDeleted}`,
      counters.propertiesSet && `props=${counters.propertiesSet}`,
      counters.labelsAdded && `labels+${counters.labelsAdded}`,
      counters.constraintsAdded && `constraints+${counters.constraintsAdded}`,
      counters.indexesAdded && `indexes+${counters.indexesAdded}`
    ]
      .filter(Boolean)
      .join(' ')
    lines.push(`[WRITE] ${changes || '(no changes)'}`)
  }

  if (records.length === 0) {
    if (lines.length === 0) lines.push('(no rows returned)')
    return lines.join('\n')
  }

  const keys = records[0].keys.map(String)
  lines.push(keys.join(' | '))
  lines.push(keys.map(() => '---').join(' | '))

  const shown = records.slice(0, MAX_RESULT_ROWS)
  for (const rec of shown) {
    lines.push(keys.map((k) => formatValue(rec.get(k))).join(' | '))
  }
  if (records.length > MAX_RESULT_ROWS) {
    lines.push(`… ${records.length - MAX_RESULT_ROWS} more rows truncated (limit ${MAX_RESULT_ROWS}).`)
  }
  lines.push(`[${records.length} row(s) in ${summary.resultAvailableAfter.toNumber()}ms]`)
  return lines.join('\n')
}

/**
 * Run a Cypher query against the targeted graph (partnership | gemma).
 * Accepts both read and write queries; write counters are surfaced in
 * the response. Result rows are capped at 50.
 */
export async function runCypher(
  target: GraphTarget,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<string> {
  const trimmed = cypher.trim()
  if (!trimmed) return 'Error: cypher query is empty.'

  const sessOrErr = sessionFor(target)
  if ('error' in sessOrErr) return `Error: ${sessOrErr.error}`
  const session = sessOrErr
  try {
    const result = await session.run(trimmed, params)
    return formatResult(result, trimmed)
  } catch (e) {
    return `Cypher error: ${(e as Error).message}`
  } finally {
    await session.close()
  }
}

/**
 * Lightweight schema dump (labels, rels, constraints) for the targeted
 * graph. Read-only. Useful first-call for Gemma to understand the graph
 * before crafting a query.
 */
export async function getSchemaSummary(target: GraphTarget): Promise<string> {
  const status = tryInitDriver(target)
  if (!status.ok) return `Error: ${status.label} driver not initialized. ${status.reason}`

  const sessOrErr = sessionFor(target)
  if ('error' in sessOrErr) return `Error: ${sessOrErr.error}`
  const session = sessOrErr
  try {
    // Patch 24: SEQUENTIAL, not Promise.all. Neo4j sessions don't support
    // concurrent transactions — parallel session.run() calls error with
    // "Queries cannot be run directly on a session with an open transaction".
    const labels = await session.run('CALL db.labels() YIELD label RETURN collect(label) AS labels')
    const rels = await session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS rels')
    const constraints = await session.run('SHOW CONSTRAINTS')

    const lines: string[] = []
    lines.push(`GRAPH: ${status.label}`)
    lines.push(`URI: ${status.uri}  USER: ${status.user}${status.database ? '  DB: ' + status.database : ''}`)
    lines.push('')
    lines.push('LABELS:')
    const labelList = (labels.records[0].get('labels') as string[]).sort()
    lines.push('  ' + (labelList.length ? labelList.join(', ') : '(none yet)'))
    lines.push('')
    lines.push('RELATIONSHIP TYPES:')
    const relList = (rels.records[0].get('rels') as string[]).sort()
    lines.push('  ' + (relList.length ? relList.join(', ') : '(none yet)'))
    lines.push('')
    lines.push('CONSTRAINTS:')
    if (constraints.records.length === 0) {
      lines.push('  (none)')
    } else {
      for (const r of constraints.records) {
        const name = r.get('name')
        const type = r.get('type')
        const entityType = r.get('entityType')
        const labelsOrTypes = r.get('labelsOrTypes')
        const properties = r.get('properties')
        lines.push(`  ${name}: ${type} on ${entityType} ${formatValue(labelsOrTypes)} ${formatValue(properties)}`)
      }
    }
    return lines.join('\n')
  } catch (e) {
    return `Schema query error: ${(e as Error).message}`
  } finally {
    await session.close()
  }
}

/**
 * Patch 40: structured-results variant of runCypher. Returns each Neo4j
 * record as a plain object keyed by RETURN aliases, with Integer normalized
 * to JS number, Node/Relationship to a tagged-property object, arrays
 * preserved. Use when the caller needs to consume values programmatically
 * (e.g., vector-search scores) rather than display them.
 *
 * Result rows are NOT capped here — that's runCypher's display concern.
 * Callers must include LIMIT in the query if they want one.
 */
export async function runCypherRaw(
  target: GraphTarget,
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<Array<Record<string, unknown>>> {
  const trimmed = cypher.trim()
  if (!trimmed) throw new Error('cypher query is empty')

  const sessOrErr = sessionFor(target)
  if ('error' in sessOrErr) throw new Error(sessOrErr.error)
  const session = sessOrErr
  try {
    const result = await session.run(trimmed, params)
    const out: Array<Record<string, unknown>> = []
    for (const rec of result.records) {
      const obj: Record<string, unknown> = {}
      for (const key of rec.keys) {
        obj[String(key)] = normalizeNeoValue(rec.get(key))
      }
      out.push(obj)
    }
    return out
  } finally {
    await session.close()
  }
}

function normalizeNeoValue(v: unknown): unknown {
  if (v === null || v === undefined) return v
  if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') return v
  if (neo4j.isInt(v)) {
    const n = (v as { toNumber: () => number }).toNumber()
    return Number.isFinite(n) ? n : (v as { toString: () => string }).toString()
  }
  if (Array.isArray(v)) return v.map(normalizeNeoValue)
  if (typeof v === 'object') {
    const obj = v as Record<string, unknown> & {
      labels?: string[]
      type?: string
      properties?: Record<string, unknown>
    }
    if (obj.labels && obj.properties) {
      return { __kind: 'node', labels: obj.labels, ...obj.properties }
    }
    if (obj.type && obj.properties) {
      return { __kind: 'rel', type: obj.type, ...obj.properties }
    }
    const out: Record<string, unknown> = {}
    for (const [k, vv] of Object.entries(v as Record<string, unknown>)) {
      out[k] = normalizeNeoValue(vv)
    }
    return out
  }
  return v
}

export async function closeNeo4j(): Promise<void> {
  for (const target of Object.keys(driverCache) as GraphTarget[]) {
    const d = driverCache[target]
    if (d) {
      await d.close()
      delete driverCache[target]
    }
  }
}
