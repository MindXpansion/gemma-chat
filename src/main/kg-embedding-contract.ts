import { createHash } from 'crypto'

/**
 * Patch 42 — write-time embedding contract (single source of truth).
 *
 * The whole point of this module: make "wrong embedding model written to wrong
 * KG" structurally impossible. Callers pass a `target` (an enum); the model,
 * dim, similarity function, database, and creds path are looked up. No public
 * function accepts a `model` parameter — that's the load-bearing constraint.
 *
 * See docs/research/06-patch40-... and the architect's ADR-20260523 for the
 * design rationale; see ADR-20260516 for why mixing voyage-3 and voyage-3-large
 * on the same vector index silently corrupts cosine semantics.
 */

export type KGTarget = 'partnership' | 'gemma'

export interface KGTargetConfig {
  readonly target: KGTarget
  readonly bolt: string
  readonly database: string
  readonly credsEnvPath: string
  readonly embeddingModel: string
  readonly embeddingDim: 1024
  readonly similarityFn: 'cosine'
}

/**
 * Frozen per-target config. The model lookup here is the canonical answer to
 * "which embedding goes with which graph." Do NOT change without a
 * DROP-INDEX + REMOVE-property + re-embed migration (see ADR-20260516).
 */
export const KG_TARGETS: Readonly<Record<KGTarget, KGTargetConfig>> = Object.freeze({
  partnership: {
    target: 'partnership',
    bolt: 'bolt://localhost:7687',
    database: 'neo4j',
    credsEnvPath: '~/.intelligence_partner/neo4j-creds.env',
    embeddingModel: 'voyage-3',
    embeddingDim: 1024,
    similarityFn: 'cosine'
  },
  gemma: {
    target: 'gemma',
    bolt: 'bolt://localhost:7687',
    database: 'gemma-chat-memory',
    credsEnvPath: '~/.gemma-chat.env',
    embeddingModel: 'voyage-3-large',
    embeddingDim: 1024,
    similarityFn: 'cosine'
  }
})

export type NodeShape = Record<string, unknown>
export type EmbedTextBuilder = (props: NodeShape) => string

/**
 * Default embed-text composition per node label. Callers can override with
 * `WriteSpec.embedText`. If a label isn't registered, callers MUST provide
 * an explicit `embedText` — the helper refuses to guess.
 */
export const DEFAULT_EMBED_TEXT: Readonly<Record<string, EmbedTextBuilder>> = Object.freeze({
  Decision: (p) => `${p.title ?? ''} :: ${p.what ?? ''} — ${p.why ?? ''}`.trim(),
  HeartbeatObservation: (p) => String(p.text ?? '').trim(),
  Observation: (p) => String(p.text ?? '').trim(),
  Pattern: (p) => [p.title, p.text].filter(Boolean).join(' :: ').trim()
})

export function hashEmbedText(text: string): string {
  return createHash('sha256').update(text, 'utf-8').digest('hex')
}

export function defaultEmbedText(label: string, props: NodeShape): string {
  const builder = DEFAULT_EMBED_TEXT[label]
  if (!builder) {
    throw new Error(
      `No DEFAULT_EMBED_TEXT registered for label "${label}". ` +
        `Provide an explicit embedText in WriteSpec or extend DEFAULT_EMBED_TEXT.`
    )
  }
  return builder(props)
}

/** Approximate voyage cost (Patch 42 ADR — recheck quarterly). */
export const VOYAGE_USD_PER_M_TOKENS = 0.18
