#!/usr/bin/env node
/**
 * Patch 20 — Gemma Chat's own KG: foundation setup
 *
 * Idempotent: safe to re-run. Each step uses IF NOT EXISTS where Neo4j
 * supports it, otherwise checks existence first.
 *
 * Run from gemma-chat repo root:
 *   node scripts/patch-20-foundation.js
 *
 * Reads admin creds from ~/.intelligence_partner/neo4j-creds.env.
 * Writes new gemma-chat creds to ~/.gemma-chat.env (mode 600).
 */

const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const os = require('os')

function parseDotenv(body) {
  const out = {}
  for (const raw of body.split('\n')) {
    const line = raw.trim().replace(/^export\s+/, '')
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let val = line.slice(eq + 1).trim()
    if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
      val = val.slice(1, -1)
    }
    if (key) out[key] = val
  }
  return out
}

const IPP_CREDS = path.join(os.homedir(), '.intelligence_partner/neo4j-creds.env')
const GEMMA_ENV = path.join(os.homedir(), '.gemma-chat.env')

const adminEnv = parseDotenv(fs.readFileSync(IPP_CREDS, 'utf-8'))
const URI = adminEnv.NEO4J_URI
const ADMIN_USER = adminEnv.NEO4J_USER
const ADMIN_PASS = adminEnv.NEO4J_PASSWORD

const neo4j = require(path.join(__dirname, '..', 'node_modules/neo4j-driver'))

const GEMMA_USER = 'gemma-chat'
const GEMMA_ROLE = 'gemma_chat_rw'
const GEMMA_DB = 'gemma-chat-memory'

async function main() {
  const driver = neo4j.driver(URI, neo4j.auth.basic(ADMIN_USER, ADMIN_PASS))

  // ── PHASE 1: system DB — create database, user, role, grants ──
  console.log('═══ PHASE 1: system DB setup ═══')
  let gemmaPassword
  {
    const sys = driver.session({ database: 'system' })
    try {
      // 1a. Create database
      console.log(`Creating database ${GEMMA_DB}...`)
      await sys.run(`CREATE DATABASE \`${GEMMA_DB}\` IF NOT EXISTS WAIT`)
      console.log('  ✓ database ready')

      // 1b. User: check if exists; if not create with generated password
      const users = await sys.run(`SHOW USERS YIELD user RETURN collect(user) AS users`)
      const existingUsers = users.records[0].get('users')
      if (existingUsers.includes(GEMMA_USER)) {
        console.log(`User ${GEMMA_USER} already exists — rotating password`)
        gemmaPassword = crypto.randomBytes(24).toString('base64url')
        await sys.run(
          `ALTER USER \`${GEMMA_USER}\` SET PASSWORD $pw CHANGE NOT REQUIRED`,
          { pw: gemmaPassword }
        )
        console.log('  ✓ password rotated')
      } else {
        gemmaPassword = crypto.randomBytes(24).toString('base64url')
        console.log(`Creating user ${GEMMA_USER}...`)
        await sys.run(
          `CREATE USER \`${GEMMA_USER}\` SET PASSWORD $pw CHANGE NOT REQUIRED`,
          { pw: gemmaPassword }
        )
        console.log('  ✓ user created')
      }

      // 1c. Role: idempotent CREATE
      console.log(`Creating role ${GEMMA_ROLE}...`)
      await sys.run(`CREATE ROLE \`${GEMMA_ROLE}\` IF NOT EXISTS`)
      console.log('  ✓ role ready')

      // 1d. Grant ALL on gemma-chat-memory
      console.log(`Granting ALL on ${GEMMA_DB} to ${GEMMA_ROLE}...`)
      await sys.run(`GRANT ALL ON DATABASE \`${GEMMA_DB}\` TO \`${GEMMA_ROLE}\``)
      console.log('  ✓ grant applied')

      // 1e. Grant graph-level privileges (GRANT ALL ON DATABASE covers admin
      // but NOT graph reads/writes — those are separate privileges)
      console.log(`Granting ALL ON GRAPH ${GEMMA_DB} to ${GEMMA_ROLE}...`)
      await sys.run(`GRANT ALL ON GRAPH \`${GEMMA_DB}\` TO \`${GEMMA_ROLE}\``)
      console.log('  ✓ graph grant applied')

      // 1f. Deny on partnership KG and system
      console.log(`Denying access to partnership KG and system...`)
      await sys.run(`DENY ACCESS ON DATABASE neo4j TO \`${GEMMA_ROLE}\``)
      await sys.run(`DENY ACCESS ON DATABASE system TO \`${GEMMA_ROLE}\``)
      console.log('  ✓ denies applied')

      // 1f. Grant role to user
      console.log(`Granting role to user...`)
      await sys.run(`GRANT ROLE \`${GEMMA_ROLE}\` TO \`${GEMMA_USER}\``)
      console.log('  ✓ role granted')
    } finally {
      await sys.close()
    }
  }

  // ── PHASE 2: gemma-chat-memory — schema (constraints, indexes) ──
  // Use a fresh driver authenticated as the gemma-chat user to verify
  // permissions work, AND to perform the schema work.
  console.log('\n═══ PHASE 2: gemma-chat-memory schema ═══')
  const gemmaDriver = neo4j.driver(URI, neo4j.auth.basic(GEMMA_USER, gemmaPassword))
  try {
    const ses = gemmaDriver.session({ database: GEMMA_DB })
    try {
      // 2a. Uniqueness constraints (10)
      const constraints = [
        ['document_uri_unique', 'Document', 'uri'],
        ['document_sha256_unique', 'Document', 'sha256'],
        ['chunk_uuid_unique', 'Chunk', 'uuid'],
        ['image_uuid_unique', 'Image', 'uuid'],
        ['conversation_uuid_unique', 'Conversation', 'uuid'],
        ['turn_uuid_unique', 'Turn', 'uuid'],
        ['summary_uuid_unique', 'Summary', 'uuid'],
        ['workspace_id_unique', 'Workspace', 'id'],
        ['observation_uuid_unique', 'Observation', 'uuid'],
        ['pattern_uuid_unique', 'Pattern', 'uuid']
      ]
      console.log('Applying uniqueness constraints...')
      for (const [name, label, prop] of constraints) {
        await ses.run(
          `CREATE CONSTRAINT ${name} IF NOT EXISTS FOR (n:${label}) REQUIRE n.${prop} IS UNIQUE`
        )
        console.log(`  ✓ ${name}`)
      }

      // 2b. Range indexes (5)
      const rangeIndexes = [
        ['chunk_created_at', 'Chunk', 'created_at'],
        ['turn_created_at', 'Turn', 'created_at'],
        ['observation_created_at', 'Observation', 'created_at'],
        ['summary_created_at', 'Summary', 'created_at'],
        ['conversation_started_at', 'Conversation', 'started_at']
      ]
      console.log('Applying range indexes...')
      for (const [name, label, prop] of rangeIndexes) {
        await ses.run(
          `CREATE INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.${prop})`
        )
        console.log(`  ✓ ${name}`)
      }

      // 2c. Full-text indexes (2)
      console.log('Applying full-text indexes...')
      await ses.run(
        `CREATE FULLTEXT INDEX chunk_text_ft IF NOT EXISTS FOR (c:Chunk) ON EACH [c.text]`
      )
      console.log('  ✓ chunk_text_ft')
      await ses.run(
        `CREATE FULLTEXT INDEX summary_text_ft IF NOT EXISTS FOR (s:Summary) ON EACH [s.text]`
      )
      console.log('  ✓ summary_text_ft')

      // 2d. Vector indexes (5) — 1024 dim, cosine, native provider
      const vectorIndexes = [
        ['chunk_embedding', 'Chunk'],
        ['image_embedding', 'Image'],
        ['summary_embedding', 'Summary'],
        ['observation_embedding', 'Observation'],
        ['pattern_embedding', 'Pattern']
      ]
      console.log('Applying vector indexes (1024 dim, cosine)...')
      for (const [name, label] of vectorIndexes) {
        await ses.run(
          `CREATE VECTOR INDEX ${name} IF NOT EXISTS FOR (n:${label}) ON (n.embedding) ` +
            `OPTIONS { indexConfig: { \`vector.dimensions\`: 1024, \`vector.similarity_function\`: 'cosine' }}`
        )
        console.log(`  ✓ ${name}`)
      }

      // 2e. Verification — write/read smoke test
      console.log('\nSmoke test: writing + reading a probe :Document...')
      const probeUri = `probe://patch-20/${Date.now()}`
      await ses.run(
        `MERGE (d:Document {uri: $uri}) SET d.sha256 = $sha, d.title = 'patch-20-probe', d.created_at = datetime() RETURN d`,
        { uri: probeUri, sha: 'probe-' + Date.now() }
      )
      const probe = await ses.run(`MATCH (d:Document {uri: $uri}) RETURN d.title AS t`, { uri: probeUri })
      console.log('  ✓ wrote+read:', probe.records[0].get('t'))
      await ses.run(`MATCH (d:Document {uri: $uri}) DETACH DELETE d`, { uri: probeUri })
      console.log('  ✓ cleaned up probe')

      // 2f. Verify constraint actually fires
      console.log('Verifying uniqueness constraint fires...')
      const u = 'constraint-test://' + Date.now()
      const sh = 'csha-' + Date.now()
      await ses.run(
        `CREATE (d:Document {uri: $u, sha256: $sh, title: 'c1', created_at: datetime()})`,
        { u, sh }
      )
      let constraintFired = false
      try {
        await ses.run(
          `CREATE (d:Document {uri: $u, sha256: 'different', title: 'c2', created_at: datetime()})`,
          { u }
        )
      } catch (e) {
        constraintFired = /already exists|ConstraintValidationFailed/i.test(e.message)
      }
      await ses.run(`MATCH (d:Document {uri: $u}) DETACH DELETE d`, { u })
      console.log(constraintFired ? '  ✓ constraint blocked duplicate' : '  ✗ constraint did NOT fire (BUG)')
    } finally {
      await ses.close()
    }
  } finally {
    await gemmaDriver.close()
  }

  // ── PHASE 3: persist creds to ~/.gemma-chat.env ──
  console.log('\n═══ PHASE 3: persist creds ═══')
  const envBody =
    `# Gemma Chat — written by scripts/patch-20-foundation.js on ${new Date().toISOString()}\n` +
    `# Loaded at app boot by src/main/env-loader.ts. Mode 600.\n` +
    `NEO4J_GEMMA_URI="${URI}"\n` +
    `NEO4J_GEMMA_USER="${GEMMA_USER}"\n` +
    `NEO4J_GEMMA_PASSWORD="${gemmaPassword}"\n` +
    `NEO4J_GEMMA_DATABASE="${GEMMA_DB}"\n`

  // Merge with any existing content (preserve GOOGLE_MAPS_API_KEY etc.)
  let existing = ''
  if (fs.existsSync(GEMMA_ENV)) {
    existing = fs.readFileSync(GEMMA_ENV, 'utf-8')
    // Strip any prior NEO4J_GEMMA_* lines
    existing = existing
      .split('\n')
      .filter((l) => !l.match(/^(export\s+)?NEO4J_GEMMA_/))
      .join('\n')
      .replace(/\n+$/, '\n')
  }
  fs.writeFileSync(GEMMA_ENV, (existing + '\n' + envBody).replace(/^\n+/, ''), { mode: 0o600 })
  console.log(`  ✓ wrote ${GEMMA_ENV} (mode 600)`)

  await driver.close()
  console.log('\n═══ DONE ═══')
  console.log(`gemma-chat-memory is live. ${GEMMA_USER} user can read/write it.`)
  console.log('Next: restart Gemma Chat so env-loader picks up the new credentials.')
}

main().catch((e) => {
  console.error('\n✗ FAILED:', e.message)
  console.error(e.stack)
  process.exit(1)
})
