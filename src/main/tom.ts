import { mkdir, writeFile } from 'fs/promises'
import { join } from 'path'
import { ensureGemmaHome } from './gemma-fs'
import { chatStream, type MLXChatMessage } from './mlx'

/**
 * Tier 4.2 (Patch 49) — Theory of Mind analyzer, OBSERVE-ONLY.
 *
 * After every chat turn in 'chat' mode, fire a single analyzer pass over
 * the user's latest message + (lightly) recent context. The analyzer
 * extracts a UserMentalModel — what is this person feeling, what are they
 * trying to do, where's their knowledge gap, how's the rapport reading.
 *
 * Tier 4.2 is OBSERVE-ONLY by design (Bear's "validate-before-over-
 * engineering" rule, 2026-05-24):
 *   • One model call per chat turn, fire-and-forget, sequential AFTER the
 *     main chat stream completes — no UX latency, no second MLX load.
 *   • Result is logged to console + appended to ~/GemmaWorkspace/tom/.
 *   • NOT yet fed into adaptation or generation. That's Tier 4.3 + 4.4,
 *     gated on Bear judging these reads as accurate.
 *
 * Hard constraints (Bear's binding rules):
 *   • No two MLX models concurrent — reuses the warm Gemma model.
 *   • Best-effort — must NEVER fail or block the chat turn.
 *   • Offline-safe — no network, no frontier-model calls.
 */

export type UserIntention =
  | 'debugging'
  | 'exploring'
  | 'venting'
  | 'planning'
  | 'asking'
  | 'celebrating'
  | 'directing'
  | 'other'

export interface UserMentalModel {
  /** ISO timestamp of the analysis. */
  at: string
  /** Free-text emotion label, lowercase. Empty string if not detected. */
  user_emotion: string
  /** 0–1. How intense is the emotion (0 = flat, 1 = strong). */
  emotion_intensity: number
  /** Best guess at what the user is trying to do this turn. */
  user_intention: UserIntention
  /** Domain knowledge the user appears to lack relative to their question. */
  knowledge_gap: string
  /** 0–1. How warm/trusting the user reads (0 = cold, 1 = high rapport). */
  rapport_level: number
  /** Analyzer's confidence in the whole read, 0–1. */
  analyzer_confidence: number
}

const ANALYZER_SYSTEM = [
  "You are an analyst reading a single user message in a conversation with Gemma (an AI assistant).",
  '',
  'Your job: produce a STRUCTURED read of what is going on for the user this turn.',
  'You are not responding to the user. You are not giving advice. You are observing.',
  '',
  'STRICT OUTPUT FORMAT — output ONLY these lines, nothing else:',
  '',
  '  USER_EMOTION: <single lowercase word, or "neutral">',
  '  EMOTION_INTENSITY: <0.0–1.0>',
  '  USER_INTENTION: <debugging | exploring | venting | planning | asking | celebrating | directing | other>',
  '  KNOWLEDGE_GAP: <one sentence — what does this user appear NOT to know that is relevant? "none" if no gap.>',
  '  RAPPORT_LEVEL: <0.0–1.0>',
  '  ANALYZER_CONFIDENCE: <0.0–1.0 — how sure are you about this whole read>',
  '',
  'Notes:',
  '- USER_EMOTION examples: frustrated, curious, tired, excited, focused, anxious, grateful, neutral.',
  '- EMOTION_INTENSITY: 0.1 is barely-there, 0.5 is clearly present, 0.9 is overwhelming.',
  '- RAPPORT_LEVEL: 0.3 is transactional, 0.6 is friendly working relationship, 0.9 is warm partner energy.',
  '- ANALYZER_CONFIDENCE: lower this if the message is short, ambiguous, or you are guessing.'
].join('\n')

export async function tomDir(): Promise<string> {
  const dir = join(await ensureGemmaHome(), 'tom')
  await mkdir(dir, { recursive: true })
  return dir
}

function parseToM(raw: string): UserMentalModel | null {
  const out: Partial<UserMentalModel> = {}
  for (const rawLine of raw.split('\n')) {
    const line = rawLine.trim()
    let m: RegExpMatchArray | null

    if ((m = line.match(/^USER_EMOTION\s*:\s*(.+)$/i))) {
      out.user_emotion = m[1].trim().toLowerCase().replace(/[.,;!?]+$/, '')
    } else if ((m = line.match(/^EMOTION_INTENSITY\s*:\s*([\d.]+)/i))) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v) && v >= 0 && v <= 1) out.emotion_intensity = v
    } else if ((m = line.match(/^USER_INTENTION\s*:\s*(\w+)/i))) {
      const verb = m[1].toLowerCase() as UserIntention
      if (
        ['debugging', 'exploring', 'venting', 'planning', 'asking', 'celebrating', 'directing', 'other'].includes(
          verb
        )
      ) {
        out.user_intention = verb
      }
    } else if ((m = line.match(/^KNOWLEDGE_GAP\s*:\s*(.+)$/i))) {
      out.knowledge_gap = m[1].trim().slice(0, 500)
    } else if ((m = line.match(/^RAPPORT_LEVEL\s*:\s*([\d.]+)/i))) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v) && v >= 0 && v <= 1) out.rapport_level = v
    } else if ((m = line.match(/^ANALYZER_CONFIDENCE\s*:\s*([\d.]+)/i))) {
      const v = parseFloat(m[1])
      if (Number.isFinite(v) && v >= 0 && v <= 1) out.analyzer_confidence = v
    }
  }

  // Required-field guard: if we couldn't parse the core fields, fail-safe.
  if (
    out.user_emotion === undefined ||
    out.user_intention === undefined ||
    out.rapport_level === undefined ||
    out.analyzer_confidence === undefined
  ) {
    return null
  }

  return {
    at: new Date().toISOString(),
    user_emotion: out.user_emotion,
    emotion_intensity: out.emotion_intensity ?? 0.5,
    user_intention: out.user_intention,
    knowledge_gap: out.knowledge_gap ?? '',
    rapport_level: out.rapport_level,
    analyzer_confidence: out.analyzer_confidence
  }
}

/** Collect a non-streaming response from the chat model. */
async function collect(
  model: string,
  messages: MLXChatMessage[],
  signal: AbortSignal
): Promise<string> {
  let buf = ''
  for await (const chunk of chatStream({ model, messages, signal })) {
    if (chunk.content) buf += chunk.content
    if (chunk.done) break
  }
  return buf
}

export interface ToMInput {
  conversationId: string
  model: string
  /** The user's latest message text. */
  userMessage: string
  /** Up to ~3 prior turns of light context (role + truncated content). */
  recentContext?: Array<{ role: 'user' | 'assistant'; content: string }>
}

/**
 * Fire-and-forget ToM analysis. Always best-effort: any failure is
 * swallowed with a console.warn. Must NEVER throw out of this function.
 *
 * Latency: this typically takes 1–3s on E4B / 4–8s on 31B. Because it
 * runs after the chat stream completes (sequential, MLX free), the user
 * sees no impact.
 */
export async function analyzeUserMentalModel(input: ToMInput): Promise<void> {
  const t0 = Date.now()
  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), 30_000)

  try {
    const contextLines = (input.recentContext ?? [])
      .slice(-3)
      .map((m) => `[${m.role}] ${m.content.slice(0, 400)}`)
      .join('\n')

    const messages: MLXChatMessage[] = [
      { role: 'system', content: ANALYZER_SYSTEM },
      {
        role: 'user',
        content: [
          contextLines ? `Recent context:\n${contextLines}\n` : '',
          `USER MESSAGE TO ANALYZE:\n${input.userMessage}`
        ].join('\n').trim()
      }
    ]

    const raw = await collect(input.model, messages, abort.signal)
    const parsed = parseToM(raw)
    const wallMs = Date.now() - t0

    if (!parsed) {
      console.warn(
        `[tom] parse-failed conversationId=${input.conversationId} wall=${wallMs}ms raw="${raw.slice(0, 200).replace(/\n/g, ' ')}"`
      )
      return
    }

    // Console summary — one line for quick scanning.
    console.log(
      `[tom] conversationId=${input.conversationId} emotion=${parsed.user_emotion}(${parsed.emotion_intensity.toFixed(2)}) intention=${parsed.user_intention} rapport=${parsed.rapport_level.toFixed(2)} conf=${parsed.analyzer_confidence.toFixed(2)} wall=${wallMs}ms`
    )

    // Journal append — newline-delimited JSON, dated daily file.
    try {
      const today = new Date().toISOString().slice(0, 10)
      const path = join(await tomDir(), `tom-${today}.ndjson`)
      const line =
        JSON.stringify({
          conversationId: input.conversationId,
          userMessage: input.userMessage.slice(0, 1000),
          ...parsed
        }) + '\n'
      // Append by reading-then-writing is overkill for ndjson; use writeFile
      // with the append flag indirectly via 'a' mode.
      const fs = await import('fs')
      await new Promise<void>((resolve, reject) =>
        fs.appendFile(path, line, 'utf-8', (err) => (err ? reject(err) : resolve()))
      )
      void writeFile // suppress unused-import warning if appendFile path changes
    } catch (e) {
      console.warn(`[tom] journal-write failed: ${(e as Error).message}`)
    }
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      console.warn(`[tom] timed out after 30s conversationId=${input.conversationId}`)
    } else {
      console.warn(`[tom] failed: ${(e as Error).message}`)
    }
  } finally {
    clearTimeout(killTimer)
  }
}
