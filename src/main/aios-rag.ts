import { createHash } from 'crypto'
import { existsSync, readFileSync, statSync, readdirSync } from 'fs'
import { extname, join, resolve, basename } from 'path'
import { randomUUID } from 'crypto'
import neo4j from 'neo4j-driver'
import { embedTexts } from './aios-voyage'

/**
 * Patch 21: ingestion + recall for gemma-chat-memory.
 *
 * Schema per docs/research/05-neo4j-voyageai-rag-design.md:
 *   :Document { uri, sha256, mime, title, bytes, created_at, indexed_at, ...}
 *   :Chunk    { uuid, text, token_count, chunk_index, embedding_model, embedding, created_at }
 *   relationships: :HAS_CHUNK (Document→Chunk), :NEXT (Chunk→Chunk)
 *
 * Idempotency: ingestion is keyed on sha256 of file content. If a
 * Document with the same sha already exists, ingestion is a no-op.
 */

// Patch 31 L4: prose + code. The paragraph chunker handles both — code
// splits cleanly on blank lines. (voyage-code-3 routing is a future
// refinement; voyage-3-large is one shared 1024-dim space for now.)
const SUPPORTED_EXT = new Set([
  '.md', '.markdown', '.txt', '.rst',
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php', '.swift', '.kt', '.scala',
  '.c', '.cpp', '.cc', '.h', '.hpp', '.cs',
  '.sh', '.bash', '.sql', '.json', '.yaml', '.yml', '.toml',
  '.html', '.css', '.scss', '.vue', '.svelte'
])

// Directories never worth embedding — dependency trees, build output, VCS.
const SKIP_INGEST_DIRS = new Set([
  'node_modules', '.git', 'dist', 'build', '.next', 'out', 'target',
  '.venv', 'venv', '__pycache__', '.cache', 'coverage', '.turbo', 'vendor'
])

// Skip files that are large, generated, or otherwise low-value to embed.
const MAX_INGEST_FILE_BYTES = 256 * 1024
function isLowValueFile(name: string): boolean {
  return (
    /-lock\.(json|yaml)$/.test(name) ||
    /\.min\.(js|css)$/.test(name) ||
    name === 'package-lock.json' ||
    name === 'yarn.lock' ||
    name === 'pnpm-lock.yaml'
  )
}

// Chunking knobs — paragraph-based, ~500 token target per chunk
const TARGET_CHUNK_TOKENS = 500
const MAX_CHUNK_TOKENS = 800

interface GemmaSession {
  run: (cypher: string, params?: Record<string, unknown>) => Promise<any>
  close: () => Promise<void>
}

function ippGemmaSession(): GemmaSession {
  const uri = process.env.NEO4J_GEMMA_URI
  const user = process.env.NEO4J_GEMMA_USER
  const pass = process.env.NEO4J_GEMMA_PASSWORD
  const db = process.env.NEO4J_GEMMA_DATABASE
  if (!uri || !user || !pass || !db) {
    throw new Error(
      'gemma-chat-memory creds missing (NEO4J_GEMMA_URI/USER/PASSWORD/DATABASE). Run scripts/patch-20-foundation.cjs first.'
    )
  }
  const driver = neo4j.driver(uri, neo4j.auth.basic(user, pass), { maxConnectionPoolSize: 4 })
  const session = driver.session({ database: db })
  return {
    run: (cypher, params = {}) => session.run(cypher, params),
    close: async () => {
      await session.close()
      await driver.close()
    }
  }
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

/**
 * Paragraph-aware chunker. Splits on blank lines; greedily fills chunks
 * up to TARGET_CHUNK_TOKENS, never exceeding MAX_CHUNK_TOKENS even if
 * that means breaking a paragraph.
 */
function chunkMarkdown(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((p) => p.trim())
    .filter((p) => p.length > 0)

  const chunks: string[] = []
  let current = ''
  let currentTokens = 0

  for (const p of paragraphs) {
    const ptokens = estimateTokens(p)

    if (ptokens > MAX_CHUNK_TOKENS) {
      // Paragraph itself too big — flush current, then hard-split
      if (current) {
        chunks.push(current)
        current = ''
        currentTokens = 0
      }
      // Hard split by sentences (rough)
      const sentences = p.split(/(?<=[.!?])\s+/)
      let buf = ''
      let bufT = 0
      for (const s of sentences) {
        const st = estimateTokens(s)
        if (bufT + st > MAX_CHUNK_TOKENS && buf) {
          chunks.push(buf)
          buf = s
          bufT = st
        } else {
          buf = buf ? buf + ' ' + s : s
          bufT += st
        }
      }
      if (buf) chunks.push(buf)
      continue
    }

    if (currentTokens + ptokens > TARGET_CHUNK_TOKENS && current) {
      chunks.push(current)
      current = p
      currentTokens = ptokens
    } else {
      current = current ? current + '\n\n' + p : p
      currentTokens += ptokens
    }
  }
  if (current) chunks.push(current)
  return chunks
}

function fileToUri(filepath: string): string {
  return 'file://' + resolve(filepath)
}

function sha256(buf: string | Buffer): string {
  return createHash('sha256').update(buf).digest('hex')
}

export interface IngestResult {
  uri: string
  status: 'indexed' | 'skipped-existing' | 'error'
  chunks?: number
  tokens?: number
  cost_usd?: number
  message?: string
}

/**
 * Ingest a single markdown / text file into gemma-chat-memory.
 * Idempotent on sha256. Returns a status row.
 */
export async function ingestFile(filepath: string, mount?: string): Promise<IngestResult> {
  const uri = fileToUri(filepath)
  if (!existsSync(filepath)) {
    return { uri, status: 'error', message: `file does not exist: ${filepath}` }
  }
  const ext = extname(filepath).toLowerCase()
  if (!SUPPORTED_EXT.has(ext)) {
    return { uri, status: 'error', message: `unsupported extension ${ext}; supported: ${[...SUPPORTED_EXT].join(', ')}` }
  }

  const stat = statSync(filepath)
  if (stat.size > MAX_INGEST_FILE_BYTES) {
    return { uri, status: 'error', message: `file too large to index (${stat.size} bytes, cap ${MAX_INGEST_FILE_BYTES})` }
  }

  let text: string
  try {
    text = readFileSync(filepath, 'utf-8')
  } catch (e) {
    return { uri, status: 'error', message: `read failed: ${(e as Error).message}` }
  }
  const sha = sha256(text)

  const ses = ippGemmaSession()
  try {
    // Idempotency check
    const existing = await ses.run(
      `MATCH (d:Document {sha256: $sha}) RETURN d.uri AS uri LIMIT 1`,
      { sha }
    )
    if (existing.records.length > 0) {
      return {
        uri,
        status: 'skipped-existing',
        message: `already indexed (sha matches doc ${existing.records[0].get('uri')})`
      }
    }

    // Chunk + embed
    const chunks = chunkMarkdown(text)
    if (chunks.length === 0) {
      return { uri, status: 'error', message: 'no chunks produced (empty file?)' }
    }

    const embedResult = await embedTexts(chunks, { inputType: 'document' })
    const cost = (embedResult.totalTokens / 1_000_000) * 0.18

    // Write Document + Chunks + relationships atomically
    const title = basename(filepath)
    const docResult = await ses.run(
      `MERGE (d:Document {uri: $uri})
       ON CREATE SET d.sha256 = $sha, d.mime = 'text/markdown', d.title = $title,
                     d.bytes = $bytes, d.source_path = $path, d.mount = $mount,
                     d.created_at = datetime(), d.indexed_at = datetime(),
                     d.source_modified_at = datetime({epochMillis: $mtime})
       ON MATCH SET d.sha256 = $sha, d.indexed_at = datetime(), d.mount = $mount,
                    d.source_modified_at = datetime({epochMillis: $mtime})
       RETURN d`,
      {
        uri,
        sha,
        title,
        bytes: neo4j.int(stat.size),
        path: resolve(filepath),
        mount: mount ?? null,
        mtime: neo4j.int(stat.mtimeMs)
      }
    )
    if (docResult.records.length === 0) {
      return { uri, status: 'error', message: 'document write returned no record' }
    }

    // Write chunks one batch. UUIDs minted here for stable references.
    const chunkUuids: string[] = chunks.map(() => randomUUID())
    await ses.run(
      `MATCH (d:Document {uri: $uri})
       UNWIND $chunks AS row
       MERGE (c:Chunk {uuid: row.uuid})
       ON CREATE SET c.text = row.text, c.chunk_index = row.idx,
                     c.token_count = row.tokens, c.embedding = row.embedding,
                     c.embedding_model = $model, c.chunk_strategy = 'paragraph-target500',
                     c.created_at = datetime()
       MERGE (d)-[:HAS_CHUNK]->(c)`,
      {
        uri,
        model: embedResult.model,
        chunks: chunks.map((text, i) => ({
          uuid: chunkUuids[i],
          text,
          idx: neo4j.int(i),
          tokens: neo4j.int(estimateTokens(text)),
          embedding: embedResult.vectors[i]
        }))
      }
    )

    // :NEXT chain
    if (chunks.length > 1) {
      await ses.run(
        `UNWIND $pairs AS pair
         MATCH (a:Chunk {uuid: pair.a}), (b:Chunk {uuid: pair.b})
         MERGE (a)-[:NEXT]->(b)`,
        {
          pairs: chunkUuids.slice(0, -1).map((a, i) => ({ a, b: chunkUuids[i + 1] }))
        }
      )
    }

    return {
      uri,
      status: 'indexed',
      chunks: chunks.length,
      tokens: embedResult.totalTokens,
      cost_usd: cost
    }
  } catch (e) {
    return { uri, status: 'error', message: (e as Error).message }
  } finally {
    await ses.close()
  }
}

/**
 * Ingest a path: either a single file or a directory (non-recursive
 * by default; pass recursive=true to walk). Returns a list of results.
 */
export async function ingestPath(
  filepath: string,
  recursive = false,
  mount?: string
): Promise<IngestResult[]> {
  if (!existsSync(filepath)) {
    return [{ uri: filepath, status: 'error', message: 'path does not exist' }]
  }
  const stat = statSync(filepath)
  if (stat.isFile()) {
    return [await ingestFile(filepath, mount)]
  }
  // Directory
  const results: IngestResult[] = []
  const entries = readdirSync(filepath, { withFileTypes: true })
  for (const entry of entries) {
    if (entry.name.startsWith('.') && entry.name !== '.') continue
    const full = join(filepath, entry.name)
    if (entry.isDirectory()) {
      if (recursive && !SKIP_INGEST_DIRS.has(entry.name)) {
        results.push(...(await ingestPath(full, true, mount)))
      }
      continue
    }
    if (
      entry.isFile() &&
      SUPPORTED_EXT.has(extname(entry.name).toLowerCase()) &&
      !isLowValueFile(entry.name)
    ) {
      results.push(await ingestFile(full, mount))
    }
  }
  return results
}

// ── RECALL ──────────────────────────────────────────────────────────────

export interface RecallHit {
  score: number
  chunk_uuid: string
  chunk_index: number
  text: string
  document_title: string
  document_uri: string
}

/**
 * Minimum-viable semantic recall: embed the query, vector-search the
 * Chunk index, return top K with document context. No reranker yet
 * (Patch 22 will add rerank-2).
 */
export async function recall(query: string, k = 5, mount?: string): Promise<RecallHit[]> {
  if (!query.trim()) return []
  const embedResult = await embedTexts([query], { inputType: 'query' })
  const queryVec = embedResult.vectors[0]

  const ses = ippGemmaSession()
  try {
    // When scoping to a mount, over-fetch from the vector index then filter
    // and LIMIT — the ANN call itself can't post-filter on a property.
    const fetch = mount ? Math.min(k * 8, 200) : k
    const cypher = mount
      ? `CALL db.index.vector.queryNodes('chunk_embedding', $fetch, $vec)
         YIELD node, score
         MATCH (d:Document)-[:HAS_CHUNK]->(node)
         WHERE d.mount = $mount
         RETURN score, node.uuid AS chunk_uuid, node.chunk_index AS chunk_index,
                node.text AS text, d.title AS document_title, d.uri AS document_uri
         ORDER BY score DESC LIMIT $k`
      : `CALL db.index.vector.queryNodes('chunk_embedding', $fetch, $vec)
         YIELD node, score
         MATCH (d:Document)-[:HAS_CHUNK]->(node)
         RETURN score, node.uuid AS chunk_uuid, node.chunk_index AS chunk_index,
                node.text AS text, d.title AS document_title, d.uri AS document_uri
         ORDER BY score DESC`
    const result = await ses.run(cypher, {
      fetch: neo4j.int(fetch),
      k: neo4j.int(k),
      vec: queryVec,
      mount: mount ?? null
    })
    return result.records.map((r) => ({
      score: r.get('score'),
      chunk_uuid: r.get('chunk_uuid'),
      chunk_index: (r.get('chunk_index') as { toNumber: () => number }).toNumber(),
      text: r.get('text'),
      document_title: r.get('document_title'),
      document_uri: r.get('document_uri')
    }))
  } finally {
    await ses.close()
  }
}

export function formatRecallHits(hits: RecallHit[]): string {
  if (hits.length === 0) return '(no matches in gemma-chat-memory)'
  return hits
    .map(
      (h, i) =>
        `[${i + 1}] score=${h.score.toFixed(3)} · ${h.document_title} · chunk ${h.chunk_index}\n${h.text.slice(0, 600)}${h.text.length > 600 ? '…' : ''}`
    )
    .join('\n\n---\n\n')
}
