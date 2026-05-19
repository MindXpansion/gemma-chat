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

let driverCache: Driver | null = null
let driverInitTried = false

interface DriverStatus {
  ok: boolean
  uri?: string
  user?: string
  reason?: string
}

function tryInitDriver(): DriverStatus {
  if (driverCache) {
    return { ok: true, uri: process.env.NEO4J_URI, user: process.env.NEO4J_USER }
  }
  if (driverInitTried) {
    return { ok: false, reason: 'Driver init already failed this session.' }
  }
  driverInitTried = true

  const uri = process.env.NEO4J_URI
  const user = process.env.NEO4J_USER
  const password = process.env.NEO4J_PASSWORD
  if (!uri || !user || !password) {
    return {
      ok: false,
      reason:
        'NEO4J_URI / NEO4J_USER / NEO4J_PASSWORD not set. env-loader reads from ~/.intelligence_partner/neo4j-creds.env at boot.'
    }
  }
  try {
    driverCache = neo4j.driver(uri, neo4j.auth.basic(user, password), {
      connectionTimeout: 5000,
      maxConnectionPoolSize: 5
    })
    return { ok: true, uri, user }
  } catch (e) {
    return { ok: false, reason: (e as Error).message }
  }
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
 * Run a Cypher query against the kg-arch-enterprise DBMS. Accepts both
 * read and write queries; write counters are surfaced in the response.
 * Result rows are capped at 50 to keep Gemma's context manageable.
 */
export async function runCypher(
  cypher: string,
  params: Record<string, unknown> = {}
): Promise<string> {
  const trimmed = cypher.trim()
  if (!trimmed) return 'Error: cypher query is empty.'

  const status = tryInitDriver()
  if (!status.ok) return `Error: Neo4j driver not initialized. ${status.reason}`

  let session: Session | null = null
  try {
    session = driverCache!.session()
    const result = await session.run(trimmed, params)
    return formatResult(result, trimmed)
  } catch (e) {
    return `Cypher error: ${(e as Error).message}`
  } finally {
    if (session) await session.close()
  }
}

/**
 * Lightweight schema dump: labels, relationship types, and constraints.
 * Read-only. Useful first-call for Gemma to understand what's in the graph
 * before crafting a query.
 */
export async function getSchemaSummary(): Promise<string> {
  const status = tryInitDriver()
  if (!status.ok) return `Error: Neo4j driver not initialized. ${status.reason}`

  let session: Session | null = null
  try {
    session = driverCache!.session()
    const [labels, rels, constraints] = await Promise.all([
      session.run('CALL db.labels() YIELD label RETURN collect(label) AS labels'),
      session.run('CALL db.relationshipTypes() YIELD relationshipType RETURN collect(relationshipType) AS rels'),
      session.run('SHOW CONSTRAINTS')
    ])

    const lines: string[] = []
    lines.push(`URI: ${status.uri}  USER: ${status.user}`)
    lines.push('')
    lines.push('LABELS:')
    lines.push('  ' + (labels.records[0].get('labels') as string[]).sort().join(', '))
    lines.push('')
    lines.push('RELATIONSHIP TYPES:')
    lines.push('  ' + (rels.records[0].get('rels') as string[]).sort().join(', '))
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
    if (session) await session.close()
  }
}

export async function closeNeo4j(): Promise<void> {
  if (driverCache) {
    await driverCache.close()
    driverCache = null
  }
}
