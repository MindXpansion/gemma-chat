import { app } from 'electron'
import { EventEmitter } from 'events'
import { mkdir, readFile, writeFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { chatStream, type MLXChatMessage } from './mlx'
import { TOOLS, findNextAction, runTool, type ToolContext, type ParsedAction } from './tools'
import { ensureGemmaHome } from './gemma-fs'
import { embedTexts } from './aios-voyage'
import { runCypher, runCypherRaw } from './aios-neo4j'
import type {
  HeartbeatState,
  HeartbeatEvent,
  HeartbeatTickResult,
  HeartbeatJournalEntry,
  HeartbeatGoal
} from '../shared/types'

/**
 * Patch 34 — Autonomous Heartbeat.
 *
 * A main-process timer fires self-directed research ticks on a cadence.
 *
 * Tick model — ONE PROBE PER TICK. E4B cannot free-chain tools: after a
 * <|tool_response> it reverts to its trained "narrate to the user"
 * behavior and will not emit a second <action>. So each tick runs exactly
 * ONE tool, then narrates the result — the tool->narrate->done flow that
 * handleChat is proven to drive. Breadth builds across successive ticks.
 *
 * L3 — goal queue. Instead of a fixed probe rotation the heartbeat works a
 * queue of goals. A *planning* tick has Gemma propose probe-sized goals
 * from her 5-step roadmap; Bear ratifies them (proposed -> queued); a
 * *work* tick runs the oldest queued goal. If goals are proposed but not
 * yet ratified, ticks skip — the heartbeat never works un-ratified goals.
 *
 * Hard constraints (Bear's, non-negotiable):
 *   • Offline-safe / $0 — enforced by HEARTBEAT_TOOLS, not just prompting.
 *   • Codebase mounts stay read-only — requestConfirm auto-denies, so only
 *     Home (rw-free) is writable.
 */

// --- Tunables ---------------------------------------------------------------

/** Chat parity (0.7). Lower temperatures make the model deterministically
 *  emit a stop token right after a <|tool_response>, ending a tick early. */
const HEARTBEAT_TEMP = 0.7
/** A runaway tick is aborted after this long. */
const TICK_TIMEOUT_MS = 6 * 60 * 1000
const MIN_CADENCE_MIN = 5
const MAX_CADENCE_MIN = 720
const DEFAULT_CADENCE_MIN = 30

// Patch 43 — adaptive cadence floors/defaults.
const MIN_CADENCE_SECONDS_DEFAULT = 30
const MIN_CADENCE_SECONDS_FLOOR = 10
const MIN_CADENCE_SECONDS_CEIL = 300

// --- Patch 40 tunables (heartbeat learning loop) ---------------------------

/** Rolling-60min cap on primary goals promoted from queued → in_progress. */
const MAX_PRIMARIES_PER_HOUR = 7
/** Hard cap on follow-ups any single primary goal can spawn. */
const MAX_FOLLOWUPS_PER_PRIMARY = 4
/** Every Nth tick, attempt a review (synthesis of recent observations). */
const REVIEW_EVERY_N_TICKS = 20
/** Patch 44: minimum age (hours) of the oldest observation in a synthesis
 *  cluster for a review to be eligible. Was 48 (architect's conservative
 *  default); 12 better matches Gemma's actual tick cadence — at ~2 obs/hour
 *  she has ample evidence-breadth in 12h, and the OTHER gates (≥3 neighbors
 *  at ≥0.88 cosine, ≥2 distinct topics) carry the real anti-noise weight.
 *  Premature patterns are self-corrected by Tier 1.4 auto-SUPERSEDES. */
const REVIEW_MIN_CLUSTER_AGE_HOURS = 12
/** Top-K vector neighbors retrieved during a dedupe-check. */
const DEDUPE_TOP_K = 5
/** Cosine score above which a topic is COVERED (with topic match). */
const DEDUPE_COVERED_THRESHOLD = 0.92
/** Cosine score above which a topic is ADJACENT (reshape, don't skip). */
const DEDUPE_ADJACENT_THRESHOLD = 0.85
/** Observations older than this fall out of the dedupe window. */
const DEDUPE_WINDOW_DAYS = 14
/** Skip dedupe entirely until at least this many in-window observations exist. */
const DEDUPE_CORPUS_FLOOR = 10
/** Single :Workspace anchor for autonomous-heartbeat observations. */
const HEARTBEAT_WORKSPACE_ID = 'gemma-home'

/**
 * The offline-safe, $0 tool subset. Every name here resolves to a tool
 * that touches only the local machine — no network, no paid API.
 *
 * NOTE on Patch 40: voyage-3-large embeddings (used by the consolidate-tick
 * to write :HeartbeatObservation nodes) ARE a network call, but the same
 * key Gemma's existing gemma_ingest uses, and the per-observation cost is
 * fractions of a cent. Counted as part of the learning-loop compounding
 * budget (~$0.15/day at the 7-primary cap; see research-06 §8.1), not as
 * a forbidden cloud tool.
 */
export const HEARTBEAT_TOOLS = new Set<string>([
  'aios_now',
  'aios_observe',
  'calc',
  'aios_kg_schema',
  'aios_kg_query',
  'gemma_kg_schema',
  'gemma_kg_query',
  'ipp_read',
  'fs_mounts',
  'fs_tree',
  'fs_list',
  'fs_search',
  'fs_read',
  'fs_write'
])

/** Gemma's 5-step self-mastery roadmap — the planning tick's north star. */
const ROADMAP = [
  '1. Master your own Neo4j knowledge graph (the gemma-chat-memory database).',
  '2. Perfect your .md files — your workspace docs and research notes.',
  '3. Learn your NotebookLM tools and what your notebooks contain.',
  '4. Master all of your current tools before building new ones.',
  '5. Identify whether your goals need new tools — and say so.'
].join('\n')

/**
 * Fallback goals — seeded as `proposed` if a planning tick yields nothing
 * parseable. They mirror Gemma's own proposed first diagnostic sweep.
 */
const SEED_GOALS = [
  'Inspect your knowledge graph — call gemma_kg_schema and report its node labels and relationship types.',
  'Survey your Home workspace — call fs_tree on root "home" and report what files and folders it holds.',
  'Review your mounted workspaces — call fs_mounts and report which codebases are mounted and their access mode.'
]

function rand(): string {
  return Math.random().toString(36).slice(2, 8)
}

// --- State ------------------------------------------------------------------

const heartbeatEvents = new EventEmitter()
export { heartbeatEvents }

let state: HeartbeatState = {
  enabled: false,
  cadenceMinutes: DEFAULT_CADENCE_MIN,
  tickCount: 0,
  ticking: false,
  primaryGoalLedger: [],
  ticksSinceReview: 0,
  minCadenceSeconds: MIN_CADENCE_SECONDS_DEFAULT
}
let goals: HeartbeatGoal[] = []

let timer: NodeJS.Timeout | null = null
let getModel: () => string | null = () => null
let isBusy: () => boolean = () => false

function statePath(): string {
  return join(app.getPath('userData'), 'heartbeat-state.json')
}

async function loadState(): Promise<void> {
  try {
    const raw = await readFile(statePath(), 'utf-8')
    const p = JSON.parse(raw) as Partial<HeartbeatState>
    state = {
      enabled: !!p.enabled,
      cadenceMinutes: clampCadence(p.cadenceMinutes ?? DEFAULT_CADENCE_MIN),
      tickCount: typeof p.tickCount === 'number' ? p.tickCount : 0,
      lastTickAt: p.lastTickAt,
      lastTickStatus: p.lastTickStatus,
      lastError: p.lastError,
      ticking: false,
      primaryGoalLedger: Array.isArray(p.primaryGoalLedger) ? p.primaryGoalLedger : [],
      ticksSinceReview: typeof p.ticksSinceReview === 'number' ? p.ticksSinceReview : 0,
      minCadenceSeconds: clampMinCadence(p.minCadenceSeconds ?? MIN_CADENCE_SECONDS_DEFAULT),
      lastReviewAttempt: p.lastReviewAttempt
    }
  } catch {
    // no state file yet — first run, defaults stand
  }
}

async function saveState(): Promise<void> {
  // `ticking` is runtime-only — never persist a true value.
  const persist = { ...state, ticking: false }
  try {
    await writeFile(statePath(), JSON.stringify(persist, null, 2), 'utf-8')
  } catch {
    // best-effort
  }
}

function clampCadence(min: number): number {
  if (!Number.isFinite(min)) return DEFAULT_CADENCE_MIN
  return Math.max(MIN_CADENCE_MIN, Math.min(MAX_CADENCE_MIN, Math.round(min)))
}

function clampMinCadence(sec: number): number {
  if (!Number.isFinite(sec)) return MIN_CADENCE_SECONDS_DEFAULT
  return Math.max(MIN_CADENCE_SECONDS_FLOOR, Math.min(MIN_CADENCE_SECONDS_CEIL, Math.round(sec)))
}

function snapshot(): HeartbeatState {
  return { ...state }
}

function emit(ev: HeartbeatEvent): void {
  heartbeatEvents.emit('event', ev)
}

function emitState(): void {
  emit({ type: 'state', state: snapshot() })
}

// --- Goals ------------------------------------------------------------------

export async function researchDir(): Promise<string> {
  const dir = join(await ensureGemmaHome(), 'research')
  await mkdir(dir, { recursive: true })
  return dir
}

function isGoal(g: unknown): g is HeartbeatGoal {
  return (
    !!g &&
    typeof g === 'object' &&
    typeof (g as HeartbeatGoal).id === 'string' &&
    typeof (g as HeartbeatGoal).instruction === 'string'
  )
}

async function loadGoals(): Promise<void> {
  try {
    const raw = await readFile(join(await researchDir(), 'goals.json'), 'utf-8')
    const p = JSON.parse(raw) as { goals?: unknown }
    if (p && Array.isArray(p.goals)) {
      goals = p.goals.filter(isGoal)
    }
  } catch {
    // no goals file yet — first run
  }
}

async function saveGoals(): Promise<void> {
  try {
    await writeFile(
      join(await researchDir(), 'goals.json'),
      JSON.stringify({ goals }, null, 2),
      'utf-8'
    )
  } catch {
    // best-effort
  }
}

function emitGoals(): void {
  emit({ type: 'goals', goals: getGoals() })
}

export function getGoals(): HeartbeatGoal[] {
  return goals.map((g) => ({ ...g }))
}

/** Bear's ratification: a proposed/queued goal can be queued or skipped. */
export async function setGoalStatus(
  id: string,
  status: 'queued' | 'skipped'
): Promise<HeartbeatGoal[]> {
  const g = goals.find((x) => x.id === id)
  if (g && (g.status === 'proposed' || g.status === 'queued')) {
    g.status = status
    await saveGoals()
    emitGoals()
  }
  return getGoals()
}

// --- Timer ------------------------------------------------------------------

/**
 * Patch 43 — adaptive cadence scheduler. Replaces the fixed setInterval
 * with a self-re-arming setTimeout whose delay depends on queue state:
 *
 * - In-progress goal with phase != null  → MIN cadence (fire ASAP).
 * - Queued follow-up exists              → MIN cadence (follow-ups are
 *                                          rate-cap-free, advance fast).
 * - Queued primary AND ledger has room   → MIN cadence (start the dedupe-
 *                                          probe-consolidate sequence).
 * - Queued primary AND ledger is full    → wait until oldest ledger entry
 *                                          would evict (clamped to [MIN, MAX]).
 * - Idle (no work, planning needed)      → MAX cadence (cadenceMinutes).
 *
 * The reason: at fixed 5-min cadence a primary takes 15 wall-clock min
 * (3 phases) and the 7/hour cap never engages. Adaptive cadence lets the
 * 7/4 ledger actually be the binding rate cap while staying idle when
 * there's nothing to do.
 */
function computeNextDelayMs(): number {
  const minMs = (state.minCadenceSeconds ?? MIN_CADENCE_SECONDS_DEFAULT) * 1000
  const maxMs = state.cadenceMinutes * 60_000

  const inProgress = goals.some((g) => g.status === 'in_progress' && g.phase)
  if (inProgress) return minMs

  const queuedFollowUps = goals.some((g) => g.status === 'queued' && g.kind === 'follow_up')
  if (queuedFollowUps) return minMs

  const queuedPrimaries = goals.filter(
    (g) => g.status === 'queued' && (g.kind === 'primary' || !g.kind)
  )
  if (queuedPrimaries.length > 0 && canPromotePrimary()) return minMs

  // Queued primaries but ledger full → wait for ledger to evict.
  if (queuedPrimaries.length > 0 && !canPromotePrimary()) {
    const ledger = state.primaryGoalLedger ?? []
    if (ledger.length > 0) {
      const oldestPromotedAt = Math.min(...ledger.map((e) => e.promotedAt))
      const expireAt = oldestPromotedAt + 60 * 60_000
      const waitMs = expireAt - Date.now()
      return Math.max(minMs, Math.min(maxMs, waitMs + 1000))
    }
  }

  return maxMs
}

function scheduleNextTick(): void {
  if (timer) {
    clearTimeout(timer)
    timer = null
  }
  if (!state.enabled) return
  const delay = computeNextDelayMs()
  timer = setTimeout(() => {
    void (async () => {
      try {
        await runTick('timer')
      } catch (e) {
        console.error('[heartbeat] tick threw unexpectedly:', (e as Error).message)
      } finally {
        scheduleNextTick()
      }
    })()
  }, delay)
}

/** Back-compat alias — old callers used scheduleTimer(). */
function scheduleTimer(): void {
  scheduleNextTick()
}

// --- Journal ----------------------------------------------------------------

export async function ticksDir(): Promise<string> {
  const dir = join(await researchDir(), 'ticks')
  await mkdir(dir, { recursive: true })
  return dir
}

/** The last `n` tick transcripts, newest first, each truncated for context. */
async function recentNotes(n: number): Promise<string> {
  let dir: string
  try {
    dir = await ticksDir()
  } catch {
    return ''
  }
  let files: string[]
  try {
    files = (await readdir(dir)).filter((f) => f.endsWith('.md')).sort().reverse()
  } catch {
    return ''
  }
  const picked = files.slice(0, n)
  if (picked.length === 0) return ''
  const blocks: string[] = []
  for (const f of picked) {
    try {
      const body = await readFile(join(dir, f), 'utf-8')
      blocks.push(`--- ${f} ---\n${body.slice(0, 1500)}`)
    } catch {
      // skip unreadable
    }
  }
  return blocks.join('\n\n')
}

export function stamp(d: Date): string {
  const p = (n: number): string => String(n).padStart(2, '0')
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`
}

/** List the tick journal files, newest first. */
export async function listJournal(): Promise<HeartbeatJournalEntry[]> {
  let dir: string
  try {
    dir = await ticksDir()
  } catch {
    return []
  }
  let names: string[]
  try {
    names = (await readdir(dir)).filter((f) => f.endsWith('.md'))
  } catch {
    return []
  }
  const out: HeartbeatJournalEntry[] = []
  for (const name of names) {
    try {
      const s = await stat(join(dir, name))
      out.push({ name, mtimeMs: s.mtimeMs, size: s.size })
    } catch {
      // skip unreadable
    }
  }
  out.sort((a, b) => b.mtimeMs - a.mtimeMs)
  return out
}

/** Read one tick journal file. The name is validated to block traversal. */
export async function readJournal(name: string): Promise<string> {
  if (!/^tick-[\w-]+\.md$/.test(name)) {
    throw new Error(`invalid journal name: ${name}`)
  }
  const dir = await ticksDir()
  return readFile(join(dir, name), 'utf-8')
}

// --- Prompts ----------------------------------------------------------------

function toolCatalog(): string {
  const lines: string[] = []
  for (const name of HEARTBEAT_TOOLS) {
    const t = TOOLS[name]
    if (!t) continue
    lines.push(`• ${t.name} — ${t.description}`)
    lines.push(`  ${t.example.replace(/\n/g, ' ')}`)
  }
  return lines.join('\n')
}

function heartbeatSystemPrompt(): string {
  const today = new Date().toString()
  return [
    "You are Gemma, an AI assistant running 100% locally on Bear's Mac.",
    '',
    'THIS IS AN AUTONOMOUS HEARTBEAT TICK — a brief, self-directed check-in with no human watching. Bear set the heartbeat running so you can observe and learn about yourself a little at a time.',
    '',
    `Host clock: ${today}.`,
    '',
    'HOW A TICK WORKS:',
    '• You are given ONE task: a single tool call.',
    '• Emit exactly one <action> for it, then STOP.',
    '• You then receive the tool result and narrate what it shows, in plain text.',
    'That is the whole tick — small, focused, $0. Breadth builds across many ticks.',
    '',
    'OFFLINE-SAFE / $0: only the local tools listed below are available. Cloud tools (web search, weather, NotebookLM, semantic recall) are disabled.',
    '',
    'TOOL FORMAT — STRICT XML. One action, on its own lines, never inside prose or code fences:',
    '',
    '  <action name="tool_name">',
    '  <param_name>value</param_name>',
    '  </action>',
    '',
    'AVAILABLE TOOLS:',
    toolCatalog()
  ].join('\n')
}

function planningSystemPrompt(): string {
  return [
    "You are Gemma, an AI assistant running 100% locally on Bear's Mac.",
    '',
    'THIS IS A PLANNING TICK. You are deciding what to research next. The autonomous heartbeat will work the goals you propose — ONE tiny goal per tick.',
    '',
    'Your 5-step self-mastery roadmap:',
    ROADMAP,
    '',
    'Propose 3 to 6 SMALL goals for upcoming heartbeat ticks. Rules for EVERY goal:',
    '• It must be achievable with exactly ONE tool call (one tick runs one tool).',
    `• It must use an offline-safe local tool — one of: ${[...HEARTBEAT_TOOLS].join(', ')}. No web, no NotebookLM (those need Bear online).`,
    '• Name the tool in the goal so a later tick knows what to call.',
    '• Favor goals that move you along the roadmap and that you have NOT already done (see your recent notes).',
    '',
    'Output ONLY the goals, each on its own line, in exactly this format:',
    'GOAL: <a clear instruction that names the tool to use>',
    '',
    'No preamble, no numbering, no commentary — only GOAL: lines.'
  ].join('\n')
}

const NARRATE_NUDGE =
  'The tool result is above. In plain text, report what it actually shows — be specific and evidence-based: quote the real values, labels, counts, or paths from the result, never invent. Then add one concrete suggestion for what a future tick should investigate. Do not call another tool.'

// --- Stream helper ----------------------------------------------------------

interface StreamOutcome {
  buffer: string
  action: ParsedAction | null
}

/**
 * Run one streamed model turn. With `untilAction`, returns as soon as a
 * complete <action> appears in the buffer; otherwise drains the whole turn.
 */
async function collectStream(
  model: string,
  messages: MLXChatMessage[],
  signal: AbortSignal,
  untilAction: boolean
): Promise<StreamOutcome> {
  let buffer = ''
  for await (const chunk of chatStream({ model, messages, signal, temperature: HEARTBEAT_TEMP })) {
    if (chunk.content) {
      buffer += chunk.content
      if (untilAction) {
        const found = findNextAction(buffer, 0)
        if (found && found !== 'incomplete') {
          return { buffer, action: found }
        }
      }
    }
    if (chunk.done) break
  }
  return { buffer, action: null }
}

// --- The probe (one tool + one narration) -----------------------------------

export interface ProbeSpec {
  label: string
  instruction: string
  /** If the model fails to emit an action, the runner falls back to this.
   *  When omitted, runProbe derives it from the instruction text. */
  fallbackTool?: string
}

export interface ProbeResult {
  transcript: string
  finalText: string
  toolUsed: string
  /** true if the tool ran but returned an error (or no tool ran at all). */
  toolErrored: boolean
}

function heartbeatCtx(): ToolContext {
  return {
    conversationId: 'heartbeat',
    // Autonomous: no human to approve. rw-confirm/ro mounts therefore
    // reject mutations; only Home (rw-free) is writable.
    requestConfirm: async () => false
  }
}

/** The first HEARTBEAT_TOOLS name mentioned in a goal instruction, if any. */
function deriveFallbackTool(text: string): string | undefined {
  for (const name of HEARTBEAT_TOOLS) {
    if (new RegExp(`\\b${name}\\b`).test(text)) return name
  }
  return undefined
}

export async function runProbe(
  model: string,
  probe: ProbeSpec,
  notes: string,
  signal: AbortSignal,
  onTool: (name: string) => void
): Promise<ProbeResult> {
  const fallback = probe.fallbackTool ?? deriveFallbackTool(probe.instruction)
  const messages: MLXChatMessage[] = [
    { role: 'system', content: heartbeatSystemPrompt() },
    {
      role: 'user',
      content: [
        'TASK FOR THIS TICK:',
        probe.instruction,
        '',
        'Emit that one action now — nothing else. After </action>, stop.',
        '',
        'RECENT RESEARCH NOTES (your memory from prior ticks):',
        notes.trim() || '(none yet — this is an early tick)'
      ].join('\n')
    }
  ]

  // --- ACTION turn: the model emits one tool call ---
  const a = await collectStream(model, messages, signal, true)

  let toolName: string | null
  let toolArgs: Record<string, unknown>
  let assistantContent: string
  let modelActed: boolean
  if (a.action) {
    toolName = a.action.name
    toolArgs = a.action.args
    assistantContent = a.buffer.slice(0, a.action.end)
    modelActed = true
  } else if (fallback) {
    // The model narrated instead of acting — fall back to the tool the
    // goal named so the tick still produces real data.
    toolName = fallback
    toolArgs = {}
    assistantContent = `<action name="${fallback}"></action>`
    modelActed = false
  } else {
    toolName = null
    toolArgs = {}
    assistantContent = a.buffer.trim()
    modelActed = false
  }

  if (!toolName) {
    // No action and no fallback — the tick can't gather data this round.
    return {
      transcript: [
        '_The model did not emit a usable action and the goal named no tool to fall back on._',
        '',
        '## Findings',
        '',
        a.buffer.trim() || '_(no output)_'
      ].join('\n'),
      finalText: 'No tool call was made this tick — the model did not emit a usable action.',
      toolUsed: '(none)',
      toolErrored: true
    }
  }

  // --- run the tool ---
  const callId = `hb_${Date.now()}_${rand()}`
  let result: string
  if (HEARTBEAT_TOOLS.has(toolName)) {
    onTool(toolName)
    result = await runTool(toolName, toolArgs, heartbeatCtx())
  } else {
    result = `Error: "${toolName}" is disabled during an autonomous heartbeat tick (offline-safe / $0 mode). Available tools: ${[...HEARTBEAT_TOOLS].join(', ')}`
  }

  // --- NARRATE turn: Patch 28 routing so the result reaches the model ---
  messages.push({
    role: 'assistant',
    content: assistantContent,
    tool_calls: [
      {
        id: callId,
        type: 'function',
        function: { name: toolName, arguments: JSON.stringify(toolArgs) }
      }
    ]
  })
  messages.push({ role: 'tool', tool_call_id: callId, content: result })
  messages.push({ role: 'user', content: NARRATE_NUDGE })

  const n = await collectStream(model, messages, signal, false)
  const narration = n.buffer.trim()

  const transcript = [
    modelActed
      ? '_The model chose and emitted this action._'
      : '_The model did not emit a usable action — the runner ran the goal’s named tool directly._',
    '',
    `**Tool:** \`${toolName}\`  ·  args: \`${JSON.stringify(toolArgs).slice(0, 300)}\``,
    '',
    '**Result:**',
    '```',
    result.slice(0, 2000) + (result.length > 2000 ? '\n…[truncated]' : ''),
    '```',
    '',
    '## Findings',
    '',
    narration || '_(the model produced no narration)_'
  ].join('\n')

  return {
    transcript,
    finalText: narration || '(no narration produced)',
    toolUsed: toolName,
    toolErrored: /^Error\b/i.test(result.trim())
  }
}

// --- Planning turn ----------------------------------------------------------

interface PlanningResult {
  rawText: string
  instructions: string[]
}

async function runPlanningTurn(
  model: string,
  notes: string,
  signal: AbortSignal
): Promise<PlanningResult> {
  const messages: MLXChatMessage[] = [
    { role: 'system', content: planningSystemPrompt() },
    {
      role: 'user',
      content: [
        'RECENT RESEARCH NOTES (what you have already looked at):',
        notes.trim() || '(none yet — this is your first planning tick)',
        '',
        'Propose your goals now — only GOAL: lines.'
      ].join('\n')
    }
  ]
  const out = await collectStream(model, messages, signal, false)
  const instructions: string[] = []
  for (const m of out.buffer.matchAll(/^[\s\-*\d.]*GOAL\s*:\s*(.+)$/gim)) {
    const t = m[1].trim()
    if (t) instructions.push(t)
  }
  return { rawText: out.buffer.trim(), instructions: instructions.slice(0, 8) }
}

// --- Patch 40: rate limiter (rolling-60min primary ledger) -----------------

function evictLedger(): void {
  const cutoff = Date.now() - 60 * 60 * 1000
  state.primaryGoalLedger = (state.primaryGoalLedger ?? []).filter(
    (e) => e.promotedAt >= cutoff
  )
}

function rollingPrimaryCount(): number {
  evictLedger()
  return (state.primaryGoalLedger ?? []).length
}

function canPromotePrimary(): boolean {
  return rollingPrimaryCount() < MAX_PRIMARIES_PER_HOUR
}

/**
 * Promote queued goals into in_progress (phase='dedupe'), subject to the
 * 60-min cap on primaries. Follow-ups are NOT rate-limited here — they
 * are bounded by their parent's followUpCount cap, applied at enqueue.
 */
async function autoPromote(): Promise<HeartbeatGoal[]> {
  const promoted: HeartbeatGoal[] = []
  for (const g of goals) {
    if (g.status === 'queued' && g.kind === 'follow_up' && !g.phase) {
      g.status = 'in_progress'
      g.phase = 'dedupe'
      promoted.push(g)
    }
  }
  for (const g of goals) {
    if (
      g.status === 'queued' &&
      (g.kind === 'primary' || !g.kind) &&
      !g.phase
    ) {
      if (!canPromotePrimary()) break
      g.status = 'in_progress'
      g.phase = 'dedupe'
      ;(state.primaryGoalLedger ??= []).push({ id: g.id, promotedAt: Date.now() })
      promoted.push(g)
    }
  }
  if (promoted.length > 0) {
    await saveGoals()
    await saveState()
    emitGoals()
    emitState()
  }
  return promoted
}

// --- Patch 40: KG helpers (workspace anchor + parent lookup + topic norm) --

let workspaceEnsured = false
async function ensureWorkspaceNode(): Promise<void> {
  if (workspaceEnsured) return
  try {
    await runCypher(
      'gemma',
      `MERGE (w:Workspace {id: $id})
         ON CREATE SET w.created_at = datetime(), w.label = $label`,
      { id: HEARTBEAT_WORKSPACE_ID, label: 'Gemma autonomous heartbeat workspace' }
    )
    workspaceEnsured = true
  } catch (e) {
    console.warn('[heartbeat] ensureWorkspaceNode failed:', (e as Error).message)
  }
}

function parentObservationUuid(goal: HeartbeatGoal): string | null {
  if (!goal.parentId) return null
  const p = goals.find((g) => g.id === goal.parentId)
  return p?.observationUuid ?? null
}

function normalizeTopic(s: string): string {
  // Patch 41: keep underscores — tool names like `gemma_kg_schema` are the
  // common topic-key shape, and stripping them produces unreadable strings
  // ("gemmakgschema") that no longer match the original tool ids.
  return s
    .toLowerCase()
    .replace(/[`"'*~]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80)
}

// --- Patch 40: dedupe-check (NO LLM, read-only on KG) ----------------------

type DedupeClass = 'COVERED' | 'ADJACENT' | 'NOVEL' | 'SPARSE'

interface DedupeOutcome {
  classification: DedupeClass
  topScore: number
  topUuid?: string
  topText?: string
  topTopic?: string
}

async function runDedupeCheck(goal: HeartbeatGoal): Promise<DedupeOutcome> {
  // Corpus floor — until enough in-window observations exist, dedupe is noise.
  try {
    const cntRows = await runCypherRaw(
      'gemma',
      `MATCH (o:HeartbeatObservation)
       WHERE o.created_at > datetime() - duration($win)
       RETURN count(o) AS cnt`,
      { win: `P${DEDUPE_WINDOW_DAYS}D` }
    )
    const cnt = Number(cntRows[0]?.cnt ?? 0)
    if (cnt < DEDUPE_CORPUS_FLOOR) {
      return { classification: 'SPARSE', topScore: 0 }
    }
  } catch {
    return { classification: 'SPARSE', topScore: 0 }
  }

  const topic = normalizeTopic(goal.title)
  const queryText = `${topic} :: ${goal.instruction}`.slice(0, 2000)
  const embRes = await embedTexts([queryText], { inputType: 'query' })
  const vec = embRes.vectors?.[0]
  if (!vec) return { classification: 'SPARSE', topScore: 0 }

  const rows = await runCypherRaw(
    'gemma',
    `CALL db.index.vector.queryNodes('observation_embedding', $k, $vec)
     YIELD node, score
     WHERE node:HeartbeatObservation
       AND node.created_at > datetime() - duration($win)
       AND score >= $minScore
       AND (node.confidence IS NULL OR node.confidence >= 0.4)
     RETURN node.uuid AS uuid, node.text AS text, node.topic AS topic, score
     ORDER BY score DESC LIMIT $k`,
    {
      k: DEDUPE_TOP_K,
      vec,
      minScore: DEDUPE_ADJACENT_THRESHOLD,
      win: `P${DEDUPE_WINDOW_DAYS}D`
    }
  )
  if (rows.length === 0) return { classification: 'NOVEL', topScore: 0 }
  const top = rows[0]
  const score = Number(top.score)
  const topUuid = top.uuid != null ? String(top.uuid) : undefined
  const topText = top.text != null ? String(top.text) : undefined
  const topTopic = top.topic != null ? String(top.topic) : undefined

  if (
    score >= DEDUPE_COVERED_THRESHOLD &&
    topTopic &&
    topTopic.toLowerCase() === topic
  ) {
    return { classification: 'COVERED', topScore: score, topUuid, topText, topTopic }
  }
  return { classification: 'ADJACENT', topScore: score, topUuid, topText, topTopic }
}

// --- Patch 40: consolidate (LLM extract + KG write + follow-ups) -----------

function consolidateSystemPrompt(remainingFollowUpBudget: number): string {
  const lines = [
    "You are Gemma, an AI assistant running 100% locally on Bear's Mac.",
    '',
    'THIS IS A CONSOLIDATE TICK. A probe just ran. Your job: produce a durable observation summary that future ticks can learn from, plus any concrete follow-up questions worth investigating.',
    '',
    'OUTPUT FORMAT (exact, no preamble):',
    '',
    'OBSERVATION:',
    '<1-3 sentences. The durable, evidence-grounded finding. Quote real values/labels/paths from the result. Hypothesis-first language; no overclaim like "always", "never", or "once and for all".>',
    '',
    'CONFIDENCE: <0.0 - 1.0 — how confident the observation is correct>'
  ]
  if (remainingFollowUpBudget > 0) {
    lines.push(
      '',
      `Then, if AND ONLY IF the result surfaces a specific concrete sub-question that would meaningfully extend this finding, append up to ${remainingFollowUpBudget} lines of the form:`,
      'FOLLOW_UP: <one-tool instruction>',
      '',
      'Each follow-up must (a) be specific (not "investigate further"), (b) name a HEARTBEAT_TOOL it would use, (c) be answerable in one tool call.',
      `Available tools: ${[...HEARTBEAT_TOOLS].join(', ')}.`,
      '',
      'If no worthy follow-up exists, output none.'
    )
  } else {
    lines.push(
      '',
      'No follow-ups allowed for this consolidate (budget exhausted or this is a follow-up goal itself).'
    )
  }
  lines.push(
    '',
    'No commentary, no greeting — just OBSERVATION:, CONFIDENCE:, and optional FOLLOW_UP: lines.'
  )
  return lines.join('\n')
}

interface ConsolidateParsed {
  observationText: string
  confidence?: number
  followUps: string[]
}

function parseConsolidateOutput(raw: string, maxFollowUps: number): ConsolidateParsed {
  const lines = raw.split('\n')
  const obsLines: string[] = []
  let confidence: number | undefined
  const followUps: string[] = []
  let mode: 'none' | 'observation' = 'none'
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^OBSERVATION\s*:/i.test(trimmed)) {
      mode = 'observation'
      const rest = trimmed.replace(/^OBSERVATION\s*:/i, '').trim()
      if (rest) obsLines.push(rest)
      continue
    }
    const cm = trimmed.match(/^CONFIDENCE\s*:\s*([\d.]+)/i)
    if (cm) {
      mode = 'none'
      const v = parseFloat(cm[1])
      if (Number.isFinite(v) && v >= 0 && v <= 1) confidence = v
      continue
    }
    const fm = trimmed.match(/^FOLLOW_UP\s*:\s*(.+)$/i)
    if (fm) {
      mode = 'none'
      if (followUps.length < maxFollowUps) followUps.push(fm[1].trim())
      continue
    }
    if (mode === 'observation' && trimmed) obsLines.push(trimmed)
  }
  return {
    observationText: obsLines.join(' ').trim(),
    confidence,
    followUps: followUps.slice(0, maxFollowUps)
  }
}

interface ConsolidateOutcome {
  observationUuid: string
  followUpInstructions: string[]
  confidence?: number
}

async function runConsolidate(
  goal: HeartbeatGoal,
  probeJournalBody: string,
  model: string,
  signal: AbortSignal,
  tickNum: number
): Promise<ConsolidateOutcome> {
  const followUpBudget =
    goal.kind === 'follow_up'
      ? 0
      : Math.max(0, MAX_FOLLOWUPS_PER_PRIMARY - (goal.followUpCount ?? 0))

  const messages: MLXChatMessage[] = [
    { role: 'system', content: consolidateSystemPrompt(followUpBudget) },
    {
      role: 'user',
      content: [
        'PROBE GOAL:',
        goal.instruction,
        '',
        'PROBE NARRATION (already produced):',
        (goal.summary ?? '').slice(0, 2000),
        '',
        'PROBE TRANSCRIPT (excerpt):',
        probeJournalBody.slice(0, 2000),
        '',
        followUpBudget > 0
          ? `Remaining follow-up budget for this primary goal: ${followUpBudget}.`
          : 'No follow-ups allowed for this consolidate.',
        '',
        'Produce OBSERVATION:, CONFIDENCE:, and any FOLLOW_UP: lines now.'
      ].join('\n')
    }
  ]
  const out = await collectStream(model, messages, signal, false)
  const parsed = parseConsolidateOutput(out.buffer, followUpBudget)
  if (!parsed.observationText) {
    throw new Error('Consolidate produced no parseable OBSERVATION text.')
  }

  const observationUuid = `obs_${Date.now()}_${rand()}`
  const tickUuid = `htick_${Date.now()}_${rand()}`
  const topicLc = normalizeTopic(goal.title)
  const toolArgsJson = JSON.stringify({ instruction: goal.instruction }).slice(0, 4000)
  const excerpt = probeJournalBody.slice(0, 2000)

  const embRes = await embedTexts([parsed.observationText], { inputType: 'document' })
  const embedding = embRes.vectors?.[0]
  if (!embedding) throw new Error('embedding failed for observation')

  await ensureWorkspaceNode()
  const parentObs = parentObservationUuid(goal)

  await runCypher(
    'gemma',
    `MERGE (t:HeartbeatTick {uuid: $tickUuid})
       ON CREATE SET t.created_at = datetime(), t.tick_num = $tickNum, t.kind = 'consolidate'
     MERGE (w:Workspace {id: $wid})
     CREATE (o:Observation:HeartbeatObservation {
       uuid: $uuid,
       created_at: datetime(),
       text: $text,
       topic: $topic,
       instruction: $instruction,
       tool_name: $toolName,
       tool_args_json: $toolArgsJson,
       tool_result_excerpt: $excerpt,
       journal_path: $journalPath,
       model: $model,
       tick_id: $tickUuid,
       embedding: $embedding,
       confidence: $confidence,
       goal_id: $goalId
     })
     MERGE (t)-[:PRODUCED]->(o)
     MERGE (o)-[:ABOUT]->(w)
     WITH o
     OPTIONAL MATCH (p:Observation {uuid: $parentObs})
     FOREACH (_ IN CASE WHEN $parentObs IS NOT NULL AND p IS NOT NULL THEN [1] ELSE [] END |
       MERGE (o)-[:SPAWNED_FROM]->(p)
     )
     RETURN o.uuid AS uuid`,
    {
      tickUuid,
      tickNum,
      wid: HEARTBEAT_WORKSPACE_ID,
      uuid: observationUuid,
      text: parsed.observationText,
      topic: topicLc,
      instruction: goal.instruction,
      toolName: goal.lastToolUsed ?? '(unknown)',
      toolArgsJson,
      excerpt,
      journalPath: goal.journalFile ?? '',
      model,
      embedding,
      confidence: parsed.confidence ?? null,
      goalId: goal.id,
      parentObs
    }
  )

  return {
    observationUuid,
    followUpInstructions: parsed.followUps,
    confidence: parsed.confidence
  }
}

async function enqueueFollowUps(
  parent: HeartbeatGoal,
  instructions: string[]
): Promise<HeartbeatGoal[]> {
  if (instructions.length === 0) return []
  const remaining = MAX_FOLLOWUPS_PER_PRIMARY - (parent.followUpCount ?? 0)
  const accept = instructions.slice(0, Math.max(0, remaining))
  if (accept.length === 0) return []
  const now = Date.now()
  const created: HeartbeatGoal[] = accept.map((ins, i) => ({
    id: `goal_${now}_fu${i}_${rand()}`,
    title: ins.length > 80 ? ins.slice(0, 79) + '…' : ins,
    instruction: ins,
    status: 'queued',
    createdAt: now,
    kind: 'follow_up',
    parentId: parent.id
  }))
  goals.push(...created)
  parent.followUpCount = (parent.followUpCount ?? 0) + created.length
  await saveGoals()
  emitGoals()
  return created
}

// --- Patch 40: review-tick (cluster surfacing + Pattern synthesis) ---------

interface SynthesisCandidate {
  seedUuid: string
  seedTopic: string
  supportingUuids: string[]
  distinctTopics: string[]
}

async function findSynthesisCandidates(): Promise<SynthesisCandidate[]> {
  try {
    const rows = await runCypherRaw(
      'gemma',
      `MATCH (o:HeartbeatObservation)
       WHERE o.created_at > datetime() - duration($win)
         AND o.embedding IS NOT NULL
       CALL (o) {
         WITH o
         CALL db.index.vector.queryNodes('observation_embedding', 6, o.embedding)
         YIELD node AS n, score
         WHERE n:HeartbeatObservation
           AND n.uuid <> o.uuid
           AND score >= 0.88
         RETURN collect(DISTINCT n) AS neighbors, collect(DISTINCT n.topic) AS topics
       }
       WITH o, neighbors, topics
       WHERE size(neighbors) >= 3
         AND size(topics) >= 2
         AND duration.inSeconds(
               reduce(mn = o.created_at, x IN neighbors |
                 CASE WHEN x.created_at < mn THEN x.created_at ELSE mn END),
               datetime()
             ).seconds >= $gateHours * 3600
       CALL (o) {
         WITH o
         OPTIONAL CALL db.index.vector.queryNodes('pattern_embedding', 1, o.embedding)
         YIELD node AS p, score AS pscore
         RETURN pscore
       }
       WITH o, neighbors, topics, pscore
       WHERE pscore IS NULL OR pscore < 0.90
       RETURN o.uuid AS seedUuid, o.topic AS seedTopic,
              [n IN neighbors | n.uuid] AS supportingUuids,
              topics AS distinctTopics
       ORDER BY size(supportingUuids) DESC
       LIMIT 5`,
      { win: `P${DEDUPE_WINDOW_DAYS}D`, gateHours: REVIEW_MIN_CLUSTER_AGE_HOURS }
    )
    return rows.map((r) => ({
      seedUuid: String(r.seedUuid),
      seedTopic: String(r.seedTopic),
      supportingUuids: Array.isArray(r.supportingUuids)
        ? (r.supportingUuids as unknown[]).map((x) => String(x))
        : [],
      distinctTopics: Array.isArray(r.distinctTopics)
        ? (r.distinctTopics as unknown[]).map((x) => String(x))
        : []
    }))
  } catch (e) {
    console.warn('[heartbeat] findSynthesisCandidates failed:', (e as Error).message)
    return []
  }
}

/**
 * Patch 44 — diagnostic probe for the operator surface. Returns the in-window
 * observation count and the oldest age, independent of the synthesis gates.
 * Lets the UI explain WHY a review skipped (cluster too young, no obs at all,
 * etc.) instead of leaving the operator to grep code.
 */
async function reviewDiagnostics(): Promise<{
  inWindowObs: number
  oldestAgeHours: number | null
}> {
  try {
    const rows = await runCypherRaw(
      'gemma',
      `MATCH (o:HeartbeatObservation)
       WHERE o.created_at > datetime() - duration($win)
       RETURN count(o) AS inWindowObs,
              CASE WHEN count(o) > 0
                   THEN duration.inSeconds(min(o.created_at), datetime()).seconds / 3600
                   ELSE null END AS oldestAgeHours`,
      { win: `P${DEDUPE_WINDOW_DAYS}D` }
    )
    if (!rows[0]) return { inWindowObs: 0, oldestAgeHours: null }
    return {
      inWindowObs: Number(rows[0].inWindowObs) || 0,
      oldestAgeHours:
        rows[0].oldestAgeHours === null || rows[0].oldestAgeHours === undefined
          ? null
          : Number(rows[0].oldestAgeHours)
    }
  } catch {
    return { inWindowObs: 0, oldestAgeHours: null }
  }
}

function reviewSystemPrompt(): string {
  return [
    "You are Gemma, an AI assistant running 100% locally on Bear's Mac.",
    '',
    'THIS IS A REVIEW TICK. Several recent observations cluster together. Your job: propose ONE :Pattern that synthesizes what they share.',
    '',
    'OUTPUT FORMAT (no preamble):',
    '',
    'PATTERN:',
    '<1-3 hypothesis-first sentences. Begin with "Across these observations, the apparent regularity is…" or similar. NEVER claim finality.>',
    '',
    'CONFIDENCE: <0.0 - 1.0>'
  ].join('\n')
}

function parseReviewOutput(raw: string): { patternText: string; confidence?: number } {
  const lines = raw.split('\n')
  const ptn: string[] = []
  let confidence: number | undefined
  let mode: 'none' | 'pattern' = 'none'
  for (const line of lines) {
    const trimmed = line.trim()
    if (/^PATTERN\s*:/i.test(trimmed)) {
      mode = 'pattern'
      const rest = trimmed.replace(/^PATTERN\s*:/i, '').trim()
      if (rest) ptn.push(rest)
      continue
    }
    const cm = trimmed.match(/^CONFIDENCE\s*:\s*([\d.]+)/i)
    if (cm) {
      mode = 'none'
      const v = parseFloat(cm[1])
      if (Number.isFinite(v) && v >= 0 && v <= 1) confidence = v
      continue
    }
    if (mode === 'pattern' && trimmed) ptn.push(trimmed)
  }
  return { patternText: ptn.join(' ').trim(), confidence }
}

async function fetchObservationsForReview(
  uuids: string[]
): Promise<Array<{ uuid: string; text: string; topic: string }>> {
  if (uuids.length === 0) return []
  const rows = await runCypherRaw(
    'gemma',
    `MATCH (o:Observation) WHERE o.uuid IN $uuids
     RETURN o.uuid AS uuid, o.text AS text, o.topic AS topic`,
    { uuids }
  )
  return rows.map((r) => ({
    uuid: String(r.uuid),
    text: String(r.text ?? ''),
    topic: String(r.topic ?? '')
  }))
}

async function runReview(
  model: string,
  signal: AbortSignal,
  tickNum: number
): Promise<{ status: 'ok' | 'skipped' | 'error'; summary: string }> {
  const diag = await reviewDiagnostics()
  const recordAttempt = (
    status: 'ok' | 'skipped' | 'error',
    candidates: number,
    reason?: string,
    patternUuid?: string
  ): void => {
    state.lastReviewAttempt = {
      at: Date.now(),
      status,
      candidates,
      inWindowObs: diag.inWindowObs,
      oldestAgeHours: diag.oldestAgeHours,
      gateHours: REVIEW_MIN_CLUSTER_AGE_HOURS,
      reason,
      patternUuid
    }
  }
  const candidates = await findSynthesisCandidates()
  if (candidates.length === 0) {
    const reason =
      diag.inWindowObs === 0
        ? 'No observations in dedupe window yet.'
        : diag.oldestAgeHours !== null && diag.oldestAgeHours < REVIEW_MIN_CLUSTER_AGE_HOURS
          ? `Oldest in-window observation is ${diag.oldestAgeHours}h < ${REVIEW_MIN_CLUSTER_AGE_HOURS}h gate (need cluster maturity).`
          : `No cluster of ≥3 neighbors at cosine ≥0.88 across ≥2 topics (in-window obs=${diag.inWindowObs}).`
    recordAttempt('skipped', 0, reason)
    return { status: 'skipped', summary: reason }
  }
  const winner = candidates[0]
  const all = await fetchObservationsForReview([winner.seedUuid, ...winner.supportingUuids])
  if (all.length < 3) {
    const reason = 'Selected cluster shrank below 3 observations between match and fetch.'
    recordAttempt('skipped', candidates.length, reason)
    return { status: 'skipped', summary: reason }
  }
  const messages: MLXChatMessage[] = [
    { role: 'system', content: reviewSystemPrompt() },
    {
      role: 'user',
      content: [
        `Cluster of ${all.length} observations across topics [${winner.distinctTopics.join(', ')}]:`,
        '',
        ...all.map((o, i) => `(${i + 1}) [topic=${o.topic}] ${o.text}`),
        '',
        'Synthesize ONE :Pattern that captures what these observations share.'
      ].join('\n')
    }
  ]
  const out = await collectStream(model, messages, signal, false)
  const parsed = parseReviewOutput(out.buffer)
  if (!parsed.patternText) {
    const reason = 'Review tick produced no parseable PATTERN.'
    recordAttempt('error', candidates.length, reason)
    return { status: 'error', summary: reason }
  }
  const embRes = await embedTexts([parsed.patternText], { inputType: 'document' })
  const embedding = embRes.vectors?.[0]
  if (!embedding) {
    const reason = 'embedding failed for pattern'
    recordAttempt('error', candidates.length, reason)
    return { status: 'error', summary: reason }
  }

  const patternUuid = `ptn_${Date.now()}_${rand()}`
  const tickUuid = `htick_${Date.now()}_${rand()}`
  const supportingUuids = all.map((o) => o.uuid)

  try {
    await runCypher(
      'gemma',
      `MERGE (t:HeartbeatTick {uuid: $tickUuid})
         ON CREATE SET t.created_at = datetime(), t.tick_num = $tickNum, t.kind = 'review'
       CREATE (p:Pattern {
         uuid: $uuid,
         created_at: datetime(),
         text: $text,
         embedding: $embedding,
         confidence: $confidence,
         evidence_count: $evidenceCount,
         source: 'heartbeat-review'
       })
       MERGE (t)-[:PRODUCED]->(p)
       WITH p
       UNWIND $uuids AS u
       MATCH (o:Observation {uuid: u})
       MERGE (o)-[:SUPPORTS]->(p)`,
      {
        tickUuid,
        tickNum,
        uuid: patternUuid,
        text: parsed.patternText,
        embedding,
        confidence: parsed.confidence ?? null,
        evidenceCount: supportingUuids.length,
        uuids: supportingUuids
      }
    )
  } catch (e) {
    const reason = `Pattern write failed: ${(e as Error).message}`
    recordAttempt('error', candidates.length, reason)
    return { status: 'error', summary: reason }
  }
  const summary = `Wrote :Pattern ${patternUuid} from cluster of ${supportingUuids.length} observations.`
  recordAttempt('ok', candidates.length, summary, patternUuid)
  return { status: 'ok', summary }
}

// --- Tick orchestration -----------------------------------------------------

/**
 * Patch 40: state-machine runTick.
 *
 * Each call advances at most ONE step:
 *   1. Auto-promote queued goals (rate-limited for primaries).
 *   2. If any goal is in_progress, run its next phase
 *      (dedupe → probe → consolidate).
 *   3. Else if review-tick is due, synthesize a :Pattern from recent
 *      observation clusters.
 *   4. Else if no queued primaries and there's hourly budget, run a
 *      plan-tick (which proposes more primaries).
 *   5. Else idle.
 *
 * Hard invariants:
 *   • dedupe-check is read-only on the KG (no writes; pure embed+cypher).
 *   • consolidate awaits the voyage embed AND the KG write before
 *     returning, so the next plan/dedupe sees the just-written observation.
 *   • follow-up goals don't count against the 7/hour primary cap;
 *     they're bounded by their parent's 4-cap, applied at enqueue.
 */
async function runTick(trigger: 'timer' | 'manual'): Promise<HeartbeatTickResult> {
  if (state.ticking) {
    return { status: 'skipped', error: 'a tick is already running' }
  }
  const model = getModel()
  if (!model) {
    return { status: 'skipped', error: 'no model is loaded' }
  }
  if (isBusy()) {
    return { status: 'skipped', error: 'a chat is currently streaming — try again shortly' }
  }

  state.ticking = true
  emitState()
  const tickNum = state.tickCount + 1
  const started = Date.now()
  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), TICK_TIMEOUT_MS)

  try {
    await autoPromote()

    // Prefer to advance an in-progress goal before starting new work.
    // Follow-ups get priority — they tighten threads, primaries broaden them.
    const followUpActive = goals.find(
      (g) => g.status === 'in_progress' && g.phase && g.kind === 'follow_up'
    )
    const primaryActive = goals.find(
      (g) => g.status === 'in_progress' && g.phase && g.kind !== 'follow_up'
    )
    const active = followUpActive ?? primaryActive

    if (active) {
      return await runGoalPhase(active, model, abort.signal, tickNum, trigger, started)
    }

    const queuedPrimaries = goals.filter(
      (g) => g.status === 'queued' && (g.kind === 'primary' || !g.kind)
    )
    const reviewDue = (state.ticksSinceReview ?? 0) >= REVIEW_EVERY_N_TICKS

    if (reviewDue) {
      const r = await runReview(model, abort.signal, tickNum)
      state.ticksSinceReview = 0
      return await finalizeTick(tickNum, r.status, r.summary)
    }

    if (queuedPrimaries.length === 0 && canPromotePrimary()) {
      return await runPlanTick(model, abort.signal, tickNum, trigger, started)
    }

    if (!canPromotePrimary() && queuedPrimaries.length > 0) {
      return await finalizeTick(
        tickNum,
        'skipped',
        `Primary budget full (${rollingPrimaryCount()}/${MAX_PRIMARIES_PER_HOUR} this hour) — waiting for ledger to evict.`
      )
    }

    return await finalizeTick(tickNum, 'skipped', 'No actionable work this tick.')
  } catch (e) {
    const error = abort.signal.aborted
      ? `tick aborted after ${TICK_TIMEOUT_MS / 1000}s timeout`
      : (e as Error).message
    state.lastTickAt = Date.now()
    state.lastTickStatus = 'error'
    state.lastError = error
    await saveState()
    emit({ type: 'tick-end', tick: tickNum, status: 'error', error })
    return { status: 'error', error }
  } finally {
    clearTimeout(killTimer)
    state.ticking = false
    emitState()
  }
}

// --- Patch 40: per-phase runners --------------------------------------------

async function runGoalPhase(
  goal: HeartbeatGoal,
  model: string,
  signal: AbortSignal,
  tickNum: number,
  trigger: 'timer' | 'manual',
  started: number
): Promise<HeartbeatTickResult> {
  const label = `${goal.title} — ${goal.phase}`
  emit({ type: 'tick-start', tick: tickNum, objective: label })

  if (goal.phase === 'dedupe') {
    let outcome: DedupeOutcome
    try {
      outcome = await runDedupeCheck(goal)
    } catch {
      outcome = { classification: 'SPARSE', topScore: 0 }
    }
    goal.dedupe = outcome
    if (outcome.classification === 'COVERED' && outcome.topText) {
      goal.instruction = `${goal.instruction}\n\n[Prior knowledge — you already wrote: "${outcome.topText.slice(0, 300)}"\nInvestigate an OPEN SUB-QUESTION that goes deeper than what you already know. If nothing remains, briefly say so and do not repeat the prior finding.]`
    } else if (outcome.classification === 'ADJACENT' && outcome.topText) {
      goal.instruction = `${goal.instruction}\n\n[Related prior observation: "${outcome.topText.slice(0, 300)}"\nUse this as context but focus on what is NOT yet covered.]`
    }
    goal.phase = 'probe'
    await saveGoals()
    emitGoals()
    return await finalizeTick(
      tickNum,
      'ok',
      `Dedupe ${outcome.classification} (top score ${outcome.topScore.toFixed(3)})`
    )
  }

  if (goal.phase === 'probe') {
    const notes = await recentNotes(2)
    const r = await runProbe(
      model,
      { label: goal.title, instruction: goal.instruction },
      notes,
      signal,
      (name) => emit({ type: 'tick-tool', tick: tickNum, tool: name })
    )
    const now = new Date()
    const fileStamp = stamp(now)
    const durationS = Math.round((Date.now() - started) / 1000)
    const journal = [
      `# Heartbeat Tick #${tickNum} — ${now.toLocaleString()}`,
      '',
      `- **Trigger:** ${trigger}`,
      `- **Model:** ${model}`,
      `- **Type:** probe tick (Patch 40)`,
      `- **Goal:** ${goal.title} ${goal.kind === 'follow_up' ? '(follow-up)' : ''}`,
      `- **Tool:** ${r.toolUsed}`,
      `- **Duration:** ${durationS}s`,
      '',
      `## ${goal.title}`,
      '',
      r.transcript,
      ''
    ].join('\n')
    const journalName = `tick-${fileStamp}.md`
    const journalPath = join(await ticksDir(), journalName)
    await writeFile(journalPath, journal, 'utf-8')

    goal.journalFile = journalName
    goal.summary = r.finalText
    goal.lastToolUsed = r.toolUsed
    if (r.toolErrored) {
      goal.status = 'done'
      goal.completedAt = Date.now()
      goal.phase = undefined
      await saveGoals()
      emitGoals()
      state.ticksSinceReview = (state.ticksSinceReview ?? 0) + 1
      await saveState()
      return await finalizeTick(tickNum, 'error', `Probe errored: ${r.finalText}`, journalPath)
    }
    goal.phase = 'consolidate'
    await saveGoals()
    emitGoals()
    return await finalizeTick(tickNum, 'ok', r.finalText, journalPath)
  }

  if (goal.phase === 'consolidate') {
    let probeBody = ''
    if (goal.journalFile) {
      try {
        probeBody = await readFile(join(await ticksDir(), goal.journalFile), 'utf-8')
      } catch {
        probeBody = ''
      }
    }
    let outcome: ConsolidateOutcome
    try {
      outcome = await runConsolidate(goal, probeBody, model, signal, tickNum)
    } catch (e) {
      goal.status = 'done'
      goal.completedAt = Date.now()
      goal.phase = undefined
      await saveGoals()
      emitGoals()
      state.ticksSinceReview = (state.ticksSinceReview ?? 0) + 1
      await saveState()
      return await finalizeTick(
        tickNum,
        'error',
        `Consolidate failed: ${(e as Error).message}`
      )
    }
    goal.observationUuid = outcome.observationUuid
    goal.status = 'done'
    goal.completedAt = Date.now()
    goal.phase = undefined
    await saveGoals()
    emitGoals()

    let followUpNote = ''
    if (goal.kind !== 'follow_up' && outcome.followUpInstructions.length > 0) {
      const created = await enqueueFollowUps(goal, outcome.followUpInstructions)
      followUpNote = `; enqueued ${created.length} follow-up(s)`
    }
    state.ticksSinceReview = (state.ticksSinceReview ?? 0) + 1
    await saveState()
    return await finalizeTick(
      tickNum,
      'ok',
      `Wrote observation ${outcome.observationUuid}${followUpNote}.`
    )
  }

  return await finalizeTick(tickNum, 'skipped', 'Goal had no phase set.')
}

async function runPlanTick(
  model: string,
  signal: AbortSignal,
  tickNum: number,
  trigger: 'timer' | 'manual',
  started: number
): Promise<HeartbeatTickResult> {
  emit({ type: 'tick-start', tick: tickNum, objective: 'Plan upcoming goals' })
  const notes = await recentNotes(3)
  const plan = await runPlanningTurn(model, notes, signal)
  const seeded = plan.instructions.length === 0
  const instructions = seeded ? SEED_GOALS : plan.instructions
  const now0 = Date.now()
  // Patch 40: NEW primaries enter `queued` directly. Auto-promoter handles
  // the 7/hour cap; no manual ratification step.
  const fresh: HeartbeatGoal[] = instructions.map((ins, i) => ({
    id: `goal_${now0}_${i}_${rand()}`,
    title: ins.length > 80 ? ins.slice(0, 79) + '…' : ins,
    instruction: ins,
    status: 'queued',
    createdAt: now0,
    kind: 'primary'
  }))
  goals.push(...fresh)
  await saveGoals()
  emitGoals()

  const now = new Date()
  const fileStamp = stamp(now)
  const durationS = Math.round((Date.now() - started) / 1000)
  const journal = [
    `# Heartbeat Tick #${tickNum} — ${now.toLocaleString()}`,
    '',
    `- **Trigger:** ${trigger}`,
    `- **Model:** ${model}`,
    `- **Type:** plan tick (Patch 40)`,
    `- **Proposed:** ${fresh.length} primary goal(s) (auto-promote at up to ${MAX_PRIMARIES_PER_HOUR}/hour)`,
    `- **Duration:** ${durationS}s`,
    '',
    '## Plan tick',
    '',
    seeded
      ? '_Model produced no parseable goals — seeded with defaults._'
      : '_Gemma proposed these goals; they auto-promote within the rolling-hour cap._',
    '',
    ...fresh.map((g, i) => `${i + 1}. ${g.instruction}`),
    '',
    '## Planning notes',
    '',
    plan.rawText || '_(none)_',
    ''
  ].join('\n')
  const journalName = `tick-${fileStamp}.md`
  const journalPath = join(await ticksDir(), journalName)
  await writeFile(journalPath, journal, 'utf-8')

  state.ticksSinceReview = (state.ticksSinceReview ?? 0) + 1
  await saveState()
  return await finalizeTick(tickNum, 'ok', `Proposed ${fresh.length} goal(s).`, journalPath)
}

async function finalizeTick(
  tickNum: number,
  status: 'ok' | 'skipped' | 'error',
  summary: string,
  journalPath?: string
): Promise<HeartbeatTickResult> {
  state.tickCount = tickNum
  state.lastTickAt = Date.now()
  state.lastTickStatus = status
  state.lastError = status === 'error' ? summary : undefined
  await saveState()
  emit({
    type: 'tick-end',
    tick: tickNum,
    status,
    journalPath,
    summary,
    error: status === 'error' ? summary : undefined
  })
  return { status, journalPath, summary, error: status === 'error' ? summary : undefined }
}

// --- Public API -------------------------------------------------------------

export interface HeartbeatHooks {
  getModel: () => string | null
  isBusy: () => boolean
}

export async function initHeartbeat(hooks: HeartbeatHooks): Promise<void> {
  getModel = hooks.getModel
  isBusy = hooks.isBusy
  await loadState()
  await loadGoals()
  scheduleTimer()
  console.log(
    `[heartbeat] initialized — ${state.enabled ? `enabled, every ${state.cadenceMinutes}min` : 'disabled'}, ${state.tickCount} tick(s), ${goals.length} goal(s)`
  )
}

export function getHeartbeatState(): HeartbeatState {
  return snapshot()
}

export async function setHeartbeatEnabled(on: boolean): Promise<HeartbeatState> {
  state.enabled = on
  await saveState()
  scheduleTimer()
  emitState()
  return snapshot()
}

export async function setHeartbeatCadence(minutes: number): Promise<HeartbeatState> {
  state.cadenceMinutes = clampCadence(minutes)
  await saveState()
  scheduleNextTick()
  emitState()
  return snapshot()
}

/** Patch 43 — set the adaptive-cadence FLOOR (min delay during active work). */
export async function setHeartbeatMinCadence(seconds: number): Promise<HeartbeatState> {
  state.minCadenceSeconds = clampMinCadence(seconds)
  await saveState()
  scheduleNextTick()
  emitState()
  return snapshot()
}

/** Run a tick immediately (manual trigger — used for testing and the UI button). */
export function runTickNow(): Promise<HeartbeatTickResult> {
  return runTick('manual')
}

export function shutdownHeartbeat(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
}
