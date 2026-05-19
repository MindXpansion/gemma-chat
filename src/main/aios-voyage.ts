import { request } from 'https'

/**
 * Patch 21: voyageai HTTPS client. Plain Node — no SDK dependency.
 * Reads VOYAGE_API_KEY from process.env (populated by env-loader from
 * ~/.gemma-chat.env at app boot).
 *
 * Models used (per docs/research/05-neo4j-voyageai-rag-design.md §4):
 *   • voyage-3-large @ 1024 dim — prose default
 *   • voyage-code-3  @ 1024 dim — code (deferred to Patch 22+)
 *   • voyage-multimodal-3 @ 1024 dim — images (deferred to Patch 22+)
 *   • rerank-2 — retrieval reranker (deferred to Patch 22)
 */

const API_BASE = 'api.voyageai.com'
const EMBED_PATH = '/v1/embeddings'
const DEFAULT_DIM = 1024
const DEFAULT_MODEL = 'voyage-3-large'

// voyageai limits per https://docs.voyageai.com/docs/rate-limits
// voyage-3-large: 120k tokens per request, 1000 texts per batch
const MAX_TEXTS_PER_BATCH = 128
const MAX_TOKENS_PER_REQUEST = 110_000 // safety margin under 120k

function estimateTokens(text: string): number {
  // Rough estimate for English prose. Voyageai uses BPE-ish tokenization;
  // chars/4 is a decent floor. We're below the request limit so this only
  // needs to be approximately right.
  return Math.ceil(text.length / 4)
}

interface EmbedResponse {
  data: Array<{ embedding: number[]; index: number }>
  model: string
  usage: { total_tokens: number }
}

function postJson<T>(path: string, body: unknown): Promise<T> {
  const key = process.env.VOYAGE_API_KEY
  if (!key) {
    return Promise.reject(
      new Error(
        'VOYAGE_API_KEY not set. Add `VOYAGE_API_KEY="..."` to ~/.gemma-chat.env and restart.'
      )
    )
  }
  const payload = JSON.stringify(body)
  return new Promise((resolve, reject) => {
    const req = request(
      {
        method: 'POST',
        host: API_BASE,
        path,
        headers: {
          authorization: `Bearer ${key}`,
          'content-type': 'application/json',
          'content-length': Buffer.byteLength(payload).toString()
        }
      },
      (res) => {
        let buf = ''
        res.on('data', (c) => (buf += c))
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`voyageai ${res.statusCode}: ${buf.slice(0, 500)}`))
            return
          }
          try {
            resolve(JSON.parse(buf) as T)
          } catch (e) {
            reject(e)
          }
        })
      }
    )
    req.on('error', reject)
    req.setTimeout(30_000, () => req.destroy(new Error('voyageai request timeout (30s)')))
    req.write(payload)
    req.end()
  })
}

export interface EmbedResult {
  vectors: number[][]
  totalTokens: number
  model: string
}

/**
 * Embed an array of texts. Auto-batches if input exceeds voyage's per-call
 * limits. Returns vectors in same order as input. Cost: $0.18/M tokens
 * for voyage-3-large (per voyageai pricing 2026-05).
 */
export async function embedTexts(
  texts: string[],
  opts: { model?: string; inputType?: 'document' | 'query' } = {}
): Promise<EmbedResult> {
  if (texts.length === 0) return { vectors: [], totalTokens: 0, model: opts.model ?? DEFAULT_MODEL }

  const model = opts.model ?? DEFAULT_MODEL
  const inputType = opts.inputType ?? 'document'

  // Split into batches respecting BOTH count and token limits
  const batches: string[][] = []
  let current: string[] = []
  let currentTokens = 0
  for (const t of texts) {
    const tokens = estimateTokens(t)
    if (
      current.length >= MAX_TEXTS_PER_BATCH ||
      (currentTokens + tokens > MAX_TOKENS_PER_REQUEST && current.length > 0)
    ) {
      batches.push(current)
      current = []
      currentTokens = 0
    }
    current.push(t)
    currentTokens += tokens
  }
  if (current.length > 0) batches.push(current)

  const allVectors: number[][] = []
  let totalTokens = 0

  for (const batch of batches) {
    const resp = await postJson<EmbedResponse>(EMBED_PATH, {
      input: batch,
      model,
      input_type: inputType,
      output_dimension: DEFAULT_DIM
    })
    // voyageai returns embeddings indexed; sort defensively
    const sorted = resp.data.slice().sort((a, b) => a.index - b.index)
    for (const item of sorted) allVectors.push(item.embedding)
    totalTokens += resp.usage.total_tokens
  }

  return { vectors: allVectors, totalTokens, model }
}

/**
 * Estimate cost for embedding a body of text. Returns USD.
 * Pricing (voyage-3-large): $0.18 per 1M tokens.
 */
export function estimateEmbedCost(text: string): { tokens: number; usd: number } {
  const tokens = estimateTokens(text)
  return { tokens, usd: (tokens / 1_000_000) * 0.18 }
}
