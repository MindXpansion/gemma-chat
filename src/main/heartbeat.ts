import { app } from 'electron'
import { EventEmitter } from 'events'
import { mkdir, readFile, writeFile, readdir } from 'fs/promises'
import { join } from 'path'
import { chatStream, type MLXChatMessage } from './mlx'
import { TOOLS, findNextAction, runTool, type ToolContext, type ParsedAction } from './tools'
import { ensureGemmaHome } from './gemma-fs'
import type { HeartbeatState, HeartbeatEvent, HeartbeatTickResult } from '../shared/types'

/**
 * Patch 34 — Autonomous Heartbeat (Layer 1: the engine).
 *
 * A main-process timer fires self-directed research ticks on a cadence.
 *
 * Tick model — ONE PROBE PER TICK. E4B cannot free-chain tools: after a
 * <|tool_response> it reverts to its trained "narrate to the user"
 * behavior and will not emit a second <action> (verified across three
 * test ticks — it either stalls empty or describes the next step in prose
 * without acting). So each tick runs exactly ONE tool, then narrates the
 * result — the tool→narrate→done flow that handleChat is proven to drive
 * reliably. Breadth comes from successive ticks, not from chaining.
 *
 * Each tick:
 *   • builds a FRESH context (no accumulated chat — avoids the E4B
 *     contamination failure mode),
 *   • runs ONE offline-safe, $0 local tool,
 *   • has the model narrate the result,
 *   • appends a dated transcript to ~/GemmaWorkspace/research/ticks/.
 *
 * Hard constraints (Bear's, non-negotiable):
 *   • Offline-safe / $0 — no web, no VoyageAI embeddings, no NotebookLM.
 *     Enforced by HEARTBEAT_TOOLS.
 *   • Codebase mounts stay read-only — requestConfirm auto-denies, so only
 *     Home (rw-free) is writable.
 */

// --- Tunables ---------------------------------------------------------------

/**
 * Chat parity (0.7). A lower temperature was tried (0.4) and caused the
 * model to deterministically emit an immediate stop token after a
 * <|tool_response>, ending the tick after one tool. 0.7 is the value
 * handleChat is proven to narrate reliably at.
 */
const HEARTBEAT_TEMP = 0.7
/** A runaway tick is aborted after this long. */
const TICK_TIMEOUT_MS = 6 * 60 * 1000
const MIN_CADENCE_MIN = 5
const MAX_CADENCE_MIN = 720
const DEFAULT_CADENCE_MIN = 30

/**
 * The offline-safe, $0 tool subset. Every name here resolves to a tool that
 * touches only the local machine — no network, no paid API. Cloud tools
 * (web_search, fetch_url, aios_weather/directions/distance/places, the
 * gemma_ingest/gemma_recall/fs_index embedding tools, every nlm_*) are
 * deliberately absent.
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

/**
 * A probe = one focused thing a tick investigates. Each tick runs the next
 * probe in rotation. L3 replaces this fixed rotation with a roadmap-driven
 * goal queue; until then the rotation walks Gemma's own proposed first
 * sweep (KG, Home, mounts) one piece at a time.
 *
 * `instruction` is what the model is told to do on the ACTION turn.
 * `tool`/`args` are the runner's fallback — if the model fails to emit a
 * usable action, the runner runs the probe directly so the tick always
 * produces real data.
 */
interface Probe {
  id: string
  label: string
  tool: string
  args: Record<string, unknown>
  instruction: string
}

const PROBES: Probe[] = [
  {
    id: 'temporal',
    label: 'Anchor the current date & time',
    tool: 'aios_now',
    args: {},
    instruction:
      'Anchor yourself in time. Emit exactly one action: <action name="aios_now"></action>'
  },
  {
    id: 'gemma-kg',
    label: 'Inspect your own knowledge graph',
    tool: 'gemma_kg_schema',
    args: {},
    instruction:
      'Inspect your own knowledge graph (the gemma-chat-memory database) — its node labels and relationships. Emit exactly one action: <action name="gemma_kg_schema"></action>'
  },
  {
    id: 'mounts',
    label: 'Review your mounted workspaces',
    tool: 'fs_mounts',
    args: {},
    instruction:
      'See which codebases and workspaces are mounted for you. Emit exactly one action: <action name="fs_mounts"></action>'
  },
  {
    id: 'home',
    label: 'Survey your Home workspace',
    tool: 'fs_tree',
    args: { root: 'home' },
    instruction:
      'Survey your Home workspace — what files and folders it holds. Emit exactly one action:\n<action name="fs_tree">\n<root>home</root>\n</action>'
  },
  {
    id: 'partner-kg',
    label: 'Inspect the partnership knowledge graph',
    tool: 'aios_kg_schema',
    args: {},
    instruction:
      'Inspect the shared partnership knowledge graph (read-only) — its node labels and relationships. Emit exactly one action: <action name="aios_kg_schema"></action>'
  }
]

// --- State ------------------------------------------------------------------

const heartbeatEvents = new EventEmitter()
export { heartbeatEvents }

let state: HeartbeatState = {
  enabled: false,
  cadenceMinutes: DEFAULT_CADENCE_MIN,
  tickCount: 0,
  ticking: false
}

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
  const home = await ensureGemmaHome()
  const dir = join(home, 'research', 'ticks')
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

// --- Prompt -----------------------------------------------------------------

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

async function runProbe(
  model: string,
  probe: Probe,
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

  let toolName: string
  let toolArgs: Record<string, unknown>
  let assistantContent: string
  let modelActed: boolean
  if (a.action) {
    toolName = a.action.name
    toolArgs = a.action.args
    assistantContent = a.buffer.slice(0, a.action.end)
    modelActed = true
  } else {
    // The model narrated instead of acting (or said nothing) — fall back to
    // the probe's own tool so the tick still produces real data.
    toolName = probe.tool
    toolArgs = probe.args
    assistantContent = `<action name="${probe.tool}"></action>`
    modelActed = false
  }

  // --- run the tool ---
  const callId = `hb_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
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
      : '_The model did not emit a usable action — the runner ran the probe tool directly._',
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

  state.ticking = true
  emitState()

  const tickNum = state.tickCount + 1
  const probe = PROBES[state.tickCount % PROBES.length]
  const started = Date.now()
  emit({ type: 'tick-start', tick: tickNum, objective: probe.label })

  const abort = new AbortController()
  const killTimer = setTimeout(() => abort.abort(), TICK_TIMEOUT_MS)

  try {
    const notes = await recentNotes(2)
    const { transcript, finalText, toolUsed } = await runProbe(
      model,
      probe,
      notes,
      abort.signal,
      (name) => emit({ type: 'tick-tool', tick: tickNum, tool: name })
    )

    const now = new Date()
    const durationS = Math.round((Date.now() - started) / 1000)
    const journal = [
      `# Heartbeat Tick #${tickNum} — ${now.toLocaleString()}`,
      '',
      `- **Trigger:** ${trigger}`,
      `- **Model:** ${model}`,
      `- **Probe:** ${probe.label}`,
      `- **Tool:** ${toolUsed}`,
      `- **Duration:** ${durationS}s`,
      '',
      '## Probe',
      '',
      transcript,
      ''
    ].join('\n')

    const dir = await ticksDir()
    const journalPath = join(dir, `tick-${stamp(now)}.md`)
    await writeFile(journalPath, journal, 'utf-8')

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
  scheduleTimer()
  console.log(
    `[heartbeat] initialized — ${state.enabled ? `enabled, every ${state.cadenceMinutes}min` : 'disabled'}, ${state.tickCount} tick(s) so far`
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
