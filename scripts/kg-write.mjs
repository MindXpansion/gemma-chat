#!/usr/bin/env node
/**
 * Patch 42 — CLI wrapper around the write-with-embedding contract.
 *
 * Reads a JSON WriteSpec from stdin, executes MERGE + embed + write +
 * verification, prints a JSON WriteResult / WriteError to stdout. Non-zero
 * exit code on failure.
 *
 * Use cases:
 *   - Calling Claude / architect invokes this from bash to write curated
 *     KG nodes (especially :Decision) without the externally-embed-first dance.
 *   - Dev/test of the contract from the shell.
 *
 * This script MIRRORS the TypeScript core in src/main/kg-write.ts +
 * src/main/kg-embedding-contract.ts. They share the same contract but
 * have separate implementations because the TS core lives inside the
 * Electron main process and isn't easily importable from a plain Node
 * script without a build step. If you change one, change the other.
 *
 * Usage:
 *   cat spec.json | node scripts/kg-write.mjs
 *   echo '{...}' | node scripts/kg-write.mjs
 */

import { createRequire } from 'module'
import { readFileSync } from 'fs'
import { createHash } from 'crypto'
import { resolve as resolvePath } from 'path'
import { homedir } from 'os'
import { request as httpsRequest } from 'https'

const require = createRequire(import.meta.url)
const neo4j = require('neo4j-driver')

// --- Contract (MIRROR of src/main/kg-embedding-contract.ts) ----------------

const KG_TARGETS = Object.freeze({
  partnership: {
    target: 'partnership',
    bolt: 'bolt://localhost:7687',
    database: 'neo4j',
    credsEnvPath: '~/.intelligence_partner/neo4j-creds.env',
    userKey: 'NEO4J_USER',
    passKey: 'NEO4J_PASSWORD',
    embeddingModel: 'voyage-3',
    embeddingDim: 1024,
    similarityFn: 'cosine'
  },
  gemma: {
    target: 'gemma',
    bolt: 'bolt://localhost:7687',
    database: 'gemma-chat-memory',
    credsEnvPath: '~/.gemma-chat.env',
    userKey: 'NEO4J_GEMMA_USER',
    passKey: 'NEO4J_GEMMA_PASSWORD',
    embeddingModel: 'voyage-3-large',
    embeddingDim: 1024,
    similarityFn: 'cosine'
  }
})

const DEFAULT_EMBED_TEXT = {
  Decision: (p) => `${p.title ?? ''} :: ${p.what ?? ''} — ${p.why ?? ''}`.trim(),
  HeartbeatObservation: (p) => String(p.text ?? '').trim(),
  Observation: (p) => String(p.text ?? '').trim(),
  Pattern: (p) => [p.title, p.text].filter(Boolean).join(' :: ').trim()
}

const VOYAGE_USD_PER_M_TOKENS = 0.18

// --- Helpers ---------------------------------------------------------------

function sha256(text) {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

function expandTilde(p) {
  return p.startsWith('~') ? resolvePath(homedir(), p.slice(1).replace(/^[/\\]/, '')) : p
}

function loadEnvFile(path) {
  try {
    const txt = readFileSync(expandTilde(path), 'utf-8')
    for (const line of txt.split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*"?([^"\n]*?)"?\s*$/)
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2]
    }
  } catch (e) {
    // best-effort; missing creds will surface as connection error later
  }
}

async function postJson(host, path, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body)
    const req = httpsRequest(
      {
        method: 'POST',
        host,
        path,
        headers: {
          authorization: `Bearer ${process.env.VOYAGE_API_KEY}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString()
        }
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          if (res.statusCode >= 200 && res.statusCode < 300) {
            try {
              resolve(JSON.parse(buf))
            } catch (e) {
              reject(new Error(`bad JSON from voyage: ${e.message}`))
            }
          } else {
            reject(new Error(`voyage HTTP ${res.statusCode}: ${buf.slice(0, 500)}`))
          }
        })
      }
    )
    req.on('error', reject)
    req.write(payload)
    req.end()
  })
}

async function embedOne(text, model) {
  const resp = await postJson('api.voyageai.com', '/v1/embeddings', {
    input: [text],
    model,
    input_type: 'document',
    output_dimension: 1024
  })
  return {
    vector: resp.data?.[0]?.embedding,
    tokens: resp.usage?.total_tokens ?? 0
  }
}

function escapeIdent(s) {
  return '`' + String(s).replace(/`/g, '') + '`'
}

// --- Main ------------------------------------------------------------------

async function readStdin() {
  return new Promise((resolve, reject) => {
    let buf = ''
    process.stdin.setEncoding('utf-8')
    process.stdin.on('data', (chunk) => (buf += chunk))
    process.stdin.on('end', () => resolve(buf))
    process.stdin.on('error', reject)
  })
}

function fail(stage, reason, retryable) {
  process.stdout.write(JSON.stringify({ ok: false, stage, reason, retryable }) + '\n')
  process.exit(1)
}

async function main() {
  const raw = await readStdin()
  let spec
  try {
    spec = JSON.parse(raw)
  } catch (e) {
    fail('config', `bad JSON spec on stdin: ${e.message}`, false)
  }

  const cfg = KG_TARGETS[spec.target]
  if (!cfg) fail('config', `unknown target: ${spec.target}`, false)

  loadEnvFile(cfg.credsEnvPath)
  // VOYAGE_API_KEY also lives in gemma-chat.env regardless of target
  loadEnvFile('~/.gemma-chat.env')

  const label = spec.label
  const builder = DEFAULT_EMBED_TEXT[label]
  let embedText = spec.embedText
  if (!embedText && builder) embedText = builder(spec.properties)
  if (!embedText && !spec.allowLexicalOnly) {
    fail('config', `no DEFAULT_EMBED_TEXT for label "${label}" and no embedText provided`, false)
  }
  embedText = embedText ?? ''

  const lexicalOnly = !!spec.allowLexicalOnly
  if (!embedText.trim() && !lexicalOnly) {
    fail('config', 'embedText empty and allowLexicalOnly false', false)
  }

  const hash = sha256(embedText)
  const skipIfEmbedded = spec.skipIfEmbedded !== false

  const userVar = process.env[cfg.userKey]
  const passVar = process.env[cfg.passKey]
  if (!userVar || !passVar) {
    fail('config', `creds missing: ${cfg.userKey} / ${cfg.passKey} not in env after sourcing ${cfg.credsEnvPath}`, false)
  }

  const driver = neo4j.driver(cfg.bolt, neo4j.auth.basic(userVar, passVar))
  const ses = driver.session({ database: cfg.database })

  try {
    const labelEsc = escapeIdent(label)
    const keyEsc = escapeIdent(spec.mergeKey.property)

    // Precheck for idempotency
    let skipEmbed = false
    let preexisted = false
    if (skipIfEmbedded && !lexicalOnly) {
      try {
        const r = await ses.run(
          `MATCH (n:${labelEsc} {${keyEsc}: $value})
           RETURN n.embedding_text_hash AS h, n.embedding IS NOT NULL AS hasE`,
          { value: spec.mergeKey.value }
        )
        if (r.records[0]) {
          preexisted = true
          const h = r.records[0].get('h')
          const hasE = r.records[0].get('hasE')
          if (h === hash && hasE === true) skipEmbed = true
        }
      } catch {
        // non-fatal — re-embed
      }
    }

    // Embed
    let vector
    let tokens = 0
    if (!skipEmbed && !lexicalOnly) {
      if (!process.env.VOYAGE_API_KEY) {
        fail('config', 'VOYAGE_API_KEY not set after sourcing ~/.gemma-chat.env', false)
      }
      try {
        const out = await embedOne(embedText, cfg.embeddingModel)
        vector = out.vector
        tokens = out.tokens
      } catch (e) {
        fail('embed', `voyage embed failed: ${e.message}`, !/\b(400|401|403|404)\b/.test(e.message))
      }
      if (!vector || vector.length !== cfg.embeddingDim) {
        fail('embed', `embed returned wrong dim ${vector?.length} (expected ${cfg.embeddingDim})`, false)
      }
    }

    // Write
    const embedClause =
      !skipEmbed && vector
        ? `WITH n
           WHERE size($embedding) = $expectedDim
           SET n.embedding = $embedding,
               n.embedding_model = $embeddingModel,
               n.embedding_text_hash = $embeddingHash,
               n.embedding_written_at = datetime()`
        : 'WITH n'

    const writeCypher = `
      MERGE (n:${labelEsc} {${keyEsc}: $value})
      ON CREATE SET n.created_at = datetime(), n += $props
      ON MATCH  SET n += $props
      ${embedClause}
      RETURN elementId(n) AS nodeId,
             n.embedding IS NOT NULL AS hasE,
             coalesce(size(n.embedding), 0) AS dim,
             n.embedding_model AS model,
             n.embedding_text_hash AS hash
    `
    const params = {
      value: spec.mergeKey.value,
      props: spec.properties,
      embedding: vector ?? null,
      embeddingModel: cfg.embeddingModel,
      embeddingHash: hash,
      expectedDim: cfg.embeddingDim
    }
    const wr = await ses.run(writeCypher, params)
    if (!wr.records[0]) fail('write', 'no rows returned', true)
    const rec = wr.records[0]
    const nodeId = String(rec.get('nodeId'))
    const dim = Number(rec.get('dim')) || 0
    const model = rec.get('model')
    const resultHash = rec.get('hash')

    if (!lexicalOnly) {
      if (dim !== cfg.embeddingDim) fail('verify', `post-write dim=${dim}, expected ${cfg.embeddingDim}`, false)
      if (model !== cfg.embeddingModel) fail('verify', `post-write model=${model}, expected ${cfg.embeddingModel}`, false)
      if (resultHash !== hash) fail('verify', 'post-write hash mismatch', false)
    }

    // Lineage (optional, non-fatal)
    let lineageWritten = false
    if (spec.lineage) {
      const ln = spec.lineage
      const tgtLabel = escapeIdent(ln.targetLabel)
      const tgtKey = escapeIdent(ln.targetMergeKey.property)
      const verb = ln.requireTarget ? 'MATCH' : 'MERGE'
      const pattern =
        ln.direction === 'out'
          ? '(src)-[r:`' + ln.rel + '`]->(tgt)'
          : '(tgt)-[r:`' + ln.rel + '`]->(src)'
      try {
        const lr = await ses.run(
          `MATCH (src:${labelEsc} {${keyEsc}: $value})
           ${verb} (tgt:${tgtLabel} {${tgtKey}: $tgtValue})
           MERGE ${pattern}
           ON CREATE SET r += $relProps, r.created_at = datetime()
           RETURN elementId(r) AS relId`,
          { value: spec.mergeKey.value, tgtValue: ln.targetMergeKey.value, relProps: ln.relProps ?? {} }
        )
        lineageWritten = lr.records.length > 0
      } catch (e) {
        process.stderr.write(`[kg-write] lineage write failed (non-fatal): ${e.message}\n`)
      }
    }

    const result = {
      ok: true,
      target: cfg.target,
      label,
      nodeId,
      embeddingDim: dim,
      embeddingModel: model ?? cfg.embeddingModel,
      embeddingHash: resultHash ?? hash,
      tokensUsed: tokens,
      costUsd: (tokens / 1_000_000) * VOYAGE_USD_PER_M_TOKENS,
      created: !preexisted,
      lineageWritten,
      ...(skipEmbed ? { skippedEmbedReason: 'hash_match' } : {}),
      ...(lexicalOnly ? { skippedEmbedReason: 'lexical_only_opt_in' } : {})
    }
    process.stdout.write(JSON.stringify(result) + '\n')
  } finally {
    await ses.close()
    await driver.close()
  }
}

main().catch((e) => {
  process.stderr.write(`[kg-write] unexpected: ${e.stack || e.message}\n`)
  fail('write', `unexpected: ${e.message}`, false)
})
