import { app } from 'electron'
import { mkdirSync, existsSync, appendFileSync, writeFileSync } from 'fs'
import { join } from 'path'

/**
 * Patch 16 (AIOS init): Gemma's bridge into the broader AIOS pattern surface.
 *
 * Provides a persistent observations log (append-only) and a temporal
 * grounding tool. These are scoped to gemma-chat's own app-data directory,
 * NOT to the partnership KG or master Skills lib (HYBRID write boundaries
 * per about-partner.md). The observations file is shared across all
 * conversations in this Gemma Chat install — one running log, not
 * per-conversation, so patterns can accumulate across sessions.
 */

function aiosDir(): string {
  return join(app.getPath('userData'), '.aios')
}

export function observationsPath(): string {
  return join(aiosDir(), 'observations.md')
}

const OBSERVATIONS_HEADER = `# Gemma Observations Log

> Append-only log of observations, patterns, and things worth remembering
> across sessions. Written by Gemma via the \`aios_observe\` tool.
>
> Per the HYBRID write boundaries (see about-partner.md): Gemma may add
> to this file freely. Bear may review and curate. Past entries are not
> modified — only appended.

---

`

function ensureObservationsFile(): void {
  const dir = aiosDir()
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  const path = observationsPath()
  if (!existsSync(path)) writeFileSync(path, OBSERVATIONS_HEADER, 'utf-8')
}

function formatNow(): { iso: string; day: string; tz: string; date: string; time: string } {
  const now = new Date()
  const iso = now.toISOString()
  const day = now.toLocaleDateString('en-US', { weekday: 'long' })
  const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
  const date = now.toLocaleDateString('en-US', {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  })
  const time = now.toLocaleTimeString('en-US', {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    timeZoneName: 'short'
  })
  return { iso, day, tz, date, time }
}

/**
 * Append a Gemma-written observation. Stamps with timestamp + conversation id.
 * Returns a short confirmation suitable for surfacing back to the model.
 */
export function appendObservation(text: string, conversationId: string): string {
  const t = text.trim()
  if (!t) return 'Error: observation text is empty.'
  ensureObservationsFile()
  const { iso, day } = formatNow()
  const entry = `## ${iso} (${day}) — conv:${conversationId}\n\n${t}\n\n---\n\n`
  appendFileSync(observationsPath(), entry, 'utf-8')
  return `Observation saved at ${iso}.`
}

/**
 * Return the current date/time/timezone in a few useful formats.
 * Gemma already gets the date in the system prompt, but this tool lets
 * the model confirm currency at any point (useful for long-running
 * conversations or when reasoning about elapsed time).
 */
export function getNow(): string {
  const { iso, day, tz, date, time } = formatNow()
  return JSON.stringify({ iso, day, tz, date, time }, null, 2)
}
