/**
 * Runtime shape validators for shared types. Used by unit tests to verify
 * that constant tables (AVAILABLE_MODELS, PROVIDERS) and example values
 * (observability rows) satisfy their declared TS shapes at runtime — TS
 * types alone don't catch a constant entry that drifts out of shape.
 */
import type { ModelInfo, Provider, ProviderId } from '../../src/shared/types'

const VALID_PROVIDER_IDS: ReadonlyArray<ProviderId> = [
  'mlx-vlm',
  'ollama',
  'openai',
  'anthropic'
]

const VALID_RUNTIMES = ['local', 'cloud'] as const

export function isValidProvider(value: unknown): value is Provider {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.id === 'string' &&
    VALID_PROVIDER_IDS.includes(v.id as ProviderId) &&
    typeof v.label === 'string' &&
    v.label.length > 0 &&
    typeof v.runtime === 'string' &&
    (VALID_RUNTIMES as readonly string[]).includes(v.runtime as string) &&
    typeof v.enabled === 'boolean' &&
    typeof v.description === 'string' &&
    v.description.length > 0
  )
}

export function isValidModelInfo(value: unknown): value is ModelInfo {
  if (typeof value !== 'object' || value === null) return false
  const v = value as Record<string, unknown>
  return (
    typeof v.name === 'string' &&
    v.name.length > 0 &&
    typeof v.label === 'string' &&
    v.label.length > 0 &&
    typeof v.size === 'string' &&
    v.size.length > 0 &&
    typeof v.sizeBytes === 'number' &&
    Number.isFinite(v.sizeBytes) &&
    v.sizeBytes > 0 &&
    typeof v.description === 'string' &&
    v.description.length > 0 &&
    typeof v.providerId === 'string' &&
    VALID_PROVIDER_IDS.includes(v.providerId as ProviderId) &&
    (v.recommended === undefined || typeof v.recommended === 'boolean')
  )
}
