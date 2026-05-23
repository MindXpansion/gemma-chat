import { embedTexts } from './aios-voyage'
import { runCypherRaw } from './aios-neo4j'
import {
  KG_TARGETS,
  KGTarget,
  defaultEmbedText,
  hashEmbedText,
  VOYAGE_USD_PER_M_TOKENS
} from './kg-embedding-contract'

/**
 * Patch 42 — write-time embedding helper.
 *
 * Single canonical path for "MERGE a curated KG node + write its embedding +
 * verify it landed" in one atomic operation. Replaces the externally-embed-
 * then-hand-to-architect pattern that produced lexical-only orphans in Phase E
 * (the three Patch 37/38/39 :Decision nodes written 2026-05-23 without
 * embeddings; backfilled later same day).
 *
 * Public API: writeNodeWithEmbedding(spec) → WriteResult | WriteError.
 * Caller never passes a model name; model is looked up from KG_TARGETS by
 * `spec.target`. Cross-model contamination is structurally impossible.
 */

export interface WriteSpecLineage {
  rel: 'SUPERSEDES' | 'DERIVED_FROM' | 'RELATES_TO' | 'SPAWNED_FROM' | 'SUPPORTS'
  direction: 'out' | 'in'
  targetLabel: string
  targetMergeKey: { property: string; value: string | number }
  relProps?: Record<string, unknown>
  /** false (default): MERGE the target if absent. true: MATCH only, fail if missing. */
  requireTarget?: boolean
}

export interface WriteSpec {
  target: KGTarget
  label: string
  mergeKey: { property: string; value: string | number }
  properties: Record<string, unknown>
  /** Override default embed-text composition for this label. */
  embedText?: string
  /** Optional second statement: relationship to another node, same transaction. */
  lineage?: WriteSpecLineage
  /** Default true: skip re-embed if persisted embedding_text_hash matches current text hash. */
  skipIfEmbedded?: boolean
  /** Default false: refuse to write without embedding. Opt-in audited escape hatch. */
  allowLexicalOnly?: boolean
}

export interface WriteResult {
  ok: true
  target: KGTarget
  label: string
  nodeId: string
  embeddingDim: number
  embeddingModel: string
  embeddingHash: string
  tokensUsed: number
  costUsd: number
  created: boolean
  lineageWritten: boolean
  skippedEmbedReason?: 'hash_match' | 'lexical_only_opt_in'
}

export interface WriteError {
  ok: false
  stage: 'config' | 'embed' | 'write' | 'verify'
  reason: string
  retryable: boolean
}

async function withRetry<T>(fn: () => Promise<T>, attempts: number, baseMs: number): Promise<T> {
  let lastErr: unknown
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn()
    } catch (e) {
      lastErr = e
      const msg = (e as Error).message || ''
      // Don't retry hard errors (auth / bad input)
      if (/\b(400|401|403|404)\b/.test(msg)) throw e
      if (i < attempts - 1) {
        await new Promise((r) => setTimeout(r, baseMs * Math.pow(4, i)))
      }
    }
  }
  throw lastErr
}

export async function writeNodeWithEmbedding(
  spec: WriteSpec
): Promise<WriteResult | WriteError> {
  const cfg = KG_TARGETS[spec.target]
  if (!cfg) {
    return { ok: false, stage: 'config', reason: `unknown target: ${spec.target}`, retryable: false }
  }

  // Compose embed text (default builder OR caller override)
  let embedText: string
  try {
    embedText = spec.embedText ?? defaultEmbedText(spec.label, spec.properties)
  } catch (e) {
    return { ok: false, stage: 'config', reason: (e as Error).message, retryable: false }
  }
  const lexicalOnly = !!spec.allowLexicalOnly
  if (!embedText.trim() && !lexicalOnly) {
    return {
      ok: false,
      stage: 'config',
      reason:
        'embedText is empty and allowLexicalOnly is false; refusing to write a lexical-only orphan',
      retryable: false
    }
  }
  const hash = hashEmbedText(embedText)
  const skipIfEmbedded = spec.skipIfEmbedded !== false

  const labelEsc = '`' + spec.label.replace(/`/g, '') + '`'
  const keyEsc = '`' + spec.mergeKey.property.replace(/`/g, '') + '`'

  // Idempotency precheck: if persisted hash matches and embedding present, skip embed.
  let skipEmbed = false
  let preexisted = false
  if (skipIfEmbedded && !lexicalOnly) {
    try {
      const rows = await runCypherRaw(
        spec.target,
        `MATCH (n:${labelEsc} {${keyEsc}: $value})
         RETURN n.embedding_text_hash AS h, n.embedding IS NOT NULL AS hasE`,
        { value: spec.mergeKey.value }
      )
      if (rows[0]) {
        preexisted = true
        if (rows[0].h === hash && rows[0].hasE === true) skipEmbed = true
      }
    } catch {
      // Precheck failure is non-fatal; fall through and re-embed.
    }
  }

  // Embed
  let embedding: number[] | undefined
  let tokensUsed = 0
  if (!skipEmbed && !lexicalOnly) {
    if (!process.env.VOYAGE_API_KEY) {
      return {
        ok: false,
        stage: 'config',
        reason: 'VOYAGE_API_KEY not set in process env; refusing to write a lexical-only orphan',
        retryable: false
      }
    }
    try {
      const res = await withRetry(
        () => embedTexts([embedText], { model: cfg.embeddingModel, inputType: 'document' }),
        3,
        250
      )
      embedding = res.vectors?.[0]
      tokensUsed = res.totalTokens ?? 0
    } catch (e) {
      const msg = (e as Error).message
      return {
        ok: false,
        stage: 'embed',
        reason: `voyage embed failed: ${msg}`,
        retryable: !/\b(400|401|403|404)\b/.test(msg)
      }
    }
    if (!embedding || embedding.length !== cfg.embeddingDim) {
      return {
        ok: false,
        stage: 'embed',
        reason: `embed returned wrong dim ${embedding?.length} (expected ${cfg.embeddingDim} for ${cfg.embeddingModel})`,
        retryable: false
      }
    }
  }

  // Build the write Cypher. Embedding clause is conditional.
  const embedClause =
    !skipEmbed && embedding
      ? `WITH n
         WHERE size($embedding) = $expectedDim
         SET n.embedding = $embedding,
             n.embedding_model = $embeddingModel,
             n.embedding_text_hash = $embeddingHash,
             n.embedding_written_at = datetime()`
      : 'WITH n'

  const cypher = `
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
  const params: Record<string, unknown> = {
    value: spec.mergeKey.value,
    props: spec.properties,
    embedding: embedding ?? null,
    embeddingModel: cfg.embeddingModel,
    embeddingHash: hash,
    expectedDim: cfg.embeddingDim
  }

  let nodeId: string
  let dim: number
  let model: string | null
  let resultHash: string | null
  try {
    const rows = await runCypherRaw(spec.target, cypher, params)
    if (!rows[0]) {
      return { ok: false, stage: 'write', reason: 'no rows returned from write', retryable: true }
    }
    nodeId = String(rows[0].nodeId)
    dim = Number(rows[0].dim) || 0
    model = (rows[0].model as string | null) ?? null
    resultHash = (rows[0].hash as string | null) ?? null
  } catch (e) {
    return {
      ok: false,
      stage: 'write',
      reason: `cypher failed: ${(e as Error).message}`,
      retryable: false
    }
  }

  // Verify (only when an embedding was expected)
  if (!lexicalOnly) {
    if (dim !== cfg.embeddingDim) {
      return {
        ok: false,
        stage: 'verify',
        reason: `post-write dim=${dim}, expected ${cfg.embeddingDim}`,
        retryable: false
      }
    }
    if (model !== cfg.embeddingModel) {
      return {
        ok: false,
        stage: 'verify',
        reason: `post-write model=${model}, expected ${cfg.embeddingModel}`,
        retryable: false
      }
    }
    if (resultHash !== hash) {
      return {
        ok: false,
        stage: 'verify',
        reason: `post-write hash mismatch (param vs persisted)`,
        retryable: false
      }
    }
  }

  // Lineage (optional second statement, same target — best-effort, non-fatal)
  let lineageWritten = false
  if (spec.lineage) {
    const ln = spec.lineage
    const targetLabel = '`' + ln.targetLabel.replace(/`/g, '') + '`'
    const targetKey = '`' + ln.targetMergeKey.property.replace(/`/g, '') + '`'
    const targetVerb = ln.requireTarget ? 'MATCH' : 'MERGE'
    const relPattern =
      ln.direction === 'out'
        ? '(src)-[r:`' + ln.rel + '`]->(tgt)'
        : '(tgt)-[r:`' + ln.rel + '`]->(src)'
    const lnCypher = `
      MATCH (src:${labelEsc} {${keyEsc}: $value})
      ${targetVerb} (tgt:${targetLabel} {${targetKey}: $tgtValue})
      MERGE ${relPattern}
      ON CREATE SET r += $relProps, r.created_at = datetime()
      RETURN elementId(r) AS relId
    `
    try {
      const lnRows = await runCypherRaw(spec.target, lnCypher, {
        value: spec.mergeKey.value,
        tgtValue: ln.targetMergeKey.value,
        relProps: ln.relProps ?? {}
      })
      lineageWritten = lnRows.length > 0
    } catch (e) {
      console.warn('[kg-write] lineage write failed (non-fatal):', (e as Error).message)
    }
  }

  return {
    ok: true,
    target: spec.target,
    label: spec.label,
    nodeId,
    embeddingDim: dim,
    embeddingModel: model ?? cfg.embeddingModel,
    embeddingHash: resultHash ?? hash,
    tokensUsed,
    costUsd: (tokensUsed / 1_000_000) * VOYAGE_USD_PER_M_TOKENS,
    created: !preexisted,
    lineageWritten,
    skippedEmbedReason: skipEmbed ? 'hash_match' : lexicalOnly ? 'lexical_only_opt_in' : undefined
  }
}
