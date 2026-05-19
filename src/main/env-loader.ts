import { existsSync, readFileSync } from 'fs'
import { homedir } from 'os'
import { join } from 'path'

/**
 * Patch 18: when Gemma Chat is launched from the Dock/Finder, Electron's
 * main process does NOT inherit a login shell's env vars. So API keys
 * defined in ~/.zshenv (like GOOGLE_MAPS_API_KEY) are invisible to the
 * Python scripts we spawn from temporal-intelligence.
 *
 * Strategy:
 *   1. Look for ~/.gemma-chat.env (clean KEY=VALUE / dotenv format) — preferred
 *   2. Fall back to parsing ~/.zshenv for `export KEY="VALUE"` lines
 *   3. Mirror requested keys into process.env so child_process.spawn inherits
 *
 * Only mirrors a whitelist of keys we actually use. Does NOT echo values.
 */

const KEYS_WE_NEED = [
  'GOOGLE_MAPS_API_KEY',
  'NEO4J_URI',
  'NEO4J_USER',
  'NEO4J_PASSWORD'
] as const

const GEMMA_ENV_FILE = join(homedir(), '.gemma-chat.env')
const ZSHENV = join(homedir(), '.zshenv')
const IPP_NEO4J_CREDS = join(homedir(), '.intelligence_partner/neo4j-creds.env')

function parseDotenv(body: string): Record<string, string> {
  const out: Record<string, string> = {}
  for (const rawLine of body.split('\n')) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const stripped = line.replace(/^export\s+/, '')
    const eq = stripped.indexOf('=')
    if (eq <= 0) continue
    const key = stripped.slice(0, eq).trim()
    let value = stripped.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (key) out[key] = value
  }
  return out
}

function readFileSafely(path: string): string {
  try {
    return readFileSync(path, 'utf-8')
  } catch {
    return ''
  }
}

/**
 * Load env vars from config sources and mirror needed keys into
 * process.env. Returns the list of keys that ended up populated.
 */
export function loadAiosEnv(): string[] {
  const sources: Record<string, string>[] = []
  if (existsSync(GEMMA_ENV_FILE)) sources.push(parseDotenv(readFileSafely(GEMMA_ENV_FILE)))
  if (existsSync(IPP_NEO4J_CREDS)) sources.push(parseDotenv(readFileSafely(IPP_NEO4J_CREDS)))
  if (existsSync(ZSHENV)) sources.push(parseDotenv(readFileSafely(ZSHENV)))

  const populated: string[] = []
  for (const key of KEYS_WE_NEED) {
    if (process.env[key]) {
      populated.push(key)
      continue
    }
    for (const src of sources) {
      if (src[key]) {
        process.env[key] = src[key]
        populated.push(key)
        break
      }
    }
  }
  return populated
}
