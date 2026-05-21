import { app } from 'electron'
import { EventEmitter } from 'events'
import { mkdir, readFile, writeFile, readdir, stat } from 'fs/promises'
import { join } from 'path'
import { chatStream, type MLXChatMessage } from './mlx'
import { TOOLS, findNextAction, runTool, type ToolContext, type ParsedAction } from './tools'
import { ensureGemmaHome } from './gemma-fs'
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

/**
 * The offline-safe, $0 tool subset. Every name here resolves to a tool
 * that touches only the local machine — no network, no paid API.
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
  ticking: false
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
      ticking: false
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

async function researchDir(): Promise<string> {
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

function scheduleTimer(): void {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  if (state.enabled) {
    timer = setInterval(() => {
      void runTick('timer')
    }, state.cadenceMinutes * 60_000)
  }
}

// --- Journal ----------------------------------------------------------------

async function ticksDir(): Promise<string> {
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

function stamp(d: Date): string {
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

interface ProbeSpec {
  label: string
  instruction: string
  /** If the model fails to emit an action, the runner falls back to this. */
  fallbackTool?: string
}

interface ProbeResult {
  transcript: string
  finalText: string
  toolUsed: string
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

async function runProbe(
  model: string,
  probe: ProbeSpec,
  notes: string,
  signal: AbortSignal,
  onTool: (name: string) => void
): Promise<ProbeResult> {
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
  } else if (probe.fallbackTool) {
    // The model narrated instead of acting — fall back to the tool the
    // goal named so the tick still produces real data.
    toolName = probe.fallbackTool
    toolArgs = {}
    assistantContent = `<action name="${probe.fallbackTool}"></action>`
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
      toolUsed: '(none)'
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
    toolUsed: toolName
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

// --- Tick orchestration -----------------------------------------------------

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

  // Decide the tick type. Never work an un-ratified goal: if goals are
  // proposed but none are queued, skip until Bear ratifies.
  const queued = goals.filter((g) => g.status === 'queued')
  const proposed = goals.filter((g) => g.status === 'proposed')
  if (queued.length === 0 && proposed.length > 0) {
    return {
      status: 'skipped',
      error: `${proposed.length} goal(s) awaiting your ratification — open the Heartbeat panel to approve them`
    }
  }

  state.ticking = true
  emitState()

  const tickNum = state.tickCount + 1
  const goal = queued[0] ?? null
  const label = goal ? goal.title : 'Plan upcoming goals'
  const started = Date.now()
  emit({ type: 'tick-start', tick: tickNum, objective: label })

  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), TICK_TIMEOUT_MS)

  try {
    let transcript: string
    let finalText: string
    let metaLines: string[]

    if (goal) {
      // --- WORK TICK ---
      const notes = await recentNotes(2)
      const r = await runProbe(
        model,
        {
          label: goal.title,
          instruction: goal.instruction,
          fallbackTool: deriveFallbackTool(goal.instruction)
        },
        notes,
        abort.signal,
        (name) => emit({ type: 'tick-tool', tick: tickNum, tool: name })
      )
      transcript = r.transcript
      finalText = r.finalText
      metaLines = ['- **Type:** work tick', `- **Goal:** ${goal.title}`, `- **Tool:** ${r.toolUsed}`]
    } else {
      // --- PLANNING TICK ---
      const notes = await recentNotes(3)
      const plan = await runPlanningTurn(model, notes, abort.signal)
      const seeded = plan.instructions.length === 0
      const instructions = seeded ? SEED_GOALS : plan.instructions
      const now0 = Date.now()
      const fresh: HeartbeatGoal[] = instructions.map((ins, i) => ({
        id: `goal_${now0}_${i}_${rand()}`,
        title: ins.length > 80 ? ins.slice(0, 79) + '…' : ins,
        instruction: ins,
        status: 'proposed',
        createdAt: now0
      }))
      goals.push(...fresh)
      await saveGoals()
      emitGoals()
      transcript = [
        seeded
          ? '_The model proposed no parseable goals — seeded with the default diagnostic goals._'
          : '_Gemma proposed these goals. They are awaiting Bear’s ratification._',
        '',
        '## Proposed goals',
        '',
        ...fresh.map((g, i) => `${i + 1}. ${g.instruction}`),
        '',
        '## Planning notes',
        '',
        plan.rawText || '_(none)_'
      ].join('\n')
      finalText = `Proposed ${fresh.length} goal(s) for Bear to ratify.`
      metaLines = ['- **Type:** planning tick', `- **Proposed:** ${fresh.length} goal(s)`]
    }

    const now = new Date()
    const fileStamp = stamp(now)
    const durationS = Math.round((Date.now() - started) / 1000)
    const journal = [
      `# Heartbeat Tick #${tickNum} — ${now.toLocaleString()}`,
      '',
      `- **Trigger:** ${trigger}`,
      `- **Model:** ${model}`,
      ...metaLines,
      `- **Duration:** ${durationS}s`,
      '',
      `## ${label}`,
      '',
      transcript,
      ''
    ].join('\n')

    const journalName = `tick-${fileStamp}.md`
    const journalPath = join(await ticksDir(), journalName)
    await writeFile(journalPath, journal, 'utf-8')

    if (goal) {
      goal.status = 'done'
      goal.completedAt = Date.now()
      goal.journalFile = journalName
      goal.summary = finalText
      await saveGoals()
      emitGoals()
    }

    state.tickCount = tickNum
    state.lastTickAt = Date.now()
    state.lastTickStatus = 'ok'
    state.lastError = undefined
    await saveState()

    emit({ type: 'tick-end', tick: tickNum, status: 'ok', journalPath, summary: finalText })
    return { status: 'ok', journalPath, summary: finalText }
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
  scheduleTimer()
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
