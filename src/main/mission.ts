import { EventEmitter } from 'events'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import { chatStream, type MLXChatMessage } from './mlx'
import { HEARTBEAT_TOOLS, runProbe, ticksDir, stamp, researchDir } from './heartbeat'
import type { Mission, MissionStep, MissionEvent } from '../shared/types'

/**
 * Patch 35 — Mission Mode (Layer 1: the engine).
 *
 * A mission is an objective Bear assigns. The engine:
 *   1. DECOMPOSES it — one model turn turns the objective into an ordered
 *      checklist of probe-sized steps (each one tool call).
 *   2. EXECUTES the steps back-to-back, unattended — each step is a probe
 *      (one tool -> narrate), the same proven unit a heartbeat tick uses.
 *      The runner holds the plan and progress; the model never has to
 *      chain (the E4B constraint still holds).
 *   3. COMPLETES when every step is done, or marks the mission `stuck`.
 *
 * L1 scope: runs on the currently-loaded model and uses only the
 * offline-safe read tools. Model-switch orchestration (to a 27B/31B) and
 * write capability are later layers — L1 proves the loop safely.
 */

const DECOMPOSE_TEMP = 0.7
/** A whole mission is aborted if it runs past this. */
const MISSION_TIMEOUT_MS = 30 * 60 * 1000
/** Cap the decomposed plan — keeps an unattended run bounded. */
const MAX_STEPS = 10

function rand(): string {
  return Math.random().toString(36).slice(2, 8)
}

// --- State ------------------------------------------------------------------

const missionEvents = new EventEmitter()
export { missionEvents }

let missions: Mission[] = []
let activeAbort: AbortController | null = null
let getModel: () => string | null = () => null
let isChatBusy: () => boolean = () => false

export function isMissionActive(): boolean {
  return activeAbort !== null
}

function emit(ev: MissionEvent): void {
  missionEvents.emit('event', ev)
}

function emitMissions(): void {
  emit({ type: 'missions', missions: getMissions() })
}

async function missionsPath(): Promise<string> {
  return join(await researchDir(), 'missions.json')
}

function isMission(m: unknown): m is Mission {
  return (
    !!m &&
    typeof m === 'object' &&
    typeof (m as Mission).id === 'string' &&
    typeof (m as Mission).objective === 'string' &&
    Array.isArray((m as Mission).steps)
  )
}

async function loadMissions(): Promise<void> {
  try {
    const raw = await readFile(await missionsPath(), 'utf-8')
    const p = JSON.parse(raw) as { missions?: unknown }
    if (p && Array.isArray(p.missions)) {
      missions = p.missions.filter(isMission)
    }
  } catch {
    // no missions file yet — first run
  }
}

async function saveMissions(): Promise<void> {
  try {
    // Keep history bounded.
    if (missions.length > 50) missions = missions.slice(0, 50)
    await writeFile(
      await missionsPath(),
      JSON.stringify({ missions }, null, 2),
      'utf-8'
    )
  } catch {
    // best-effort
  }
}

export function getMissions(): Mission[] {
  return missions.map((m) => ({ ...m, steps: m.steps.map((s) => ({ ...s })) }))
}

// --- Decomposition ----------------------------------------------------------

function decomposeSystemPrompt(): string {
  return [
    "You are Gemma, an AI assistant running 100% locally on Bear's Mac, planning how to accomplish a mission Bear has assigned you.",
    '',
    'Break the mission objective into an ordered list of small, concrete steps. Rules for EVERY step:',
    '• It must be achievable with exactly ONE tool call (one step runs one tool).',
    `• Use only offline-safe local tools — one of: ${[...HEARTBEAT_TOOLS].join(', ')}.`,
    '• Each step must be a FULL INSTRUCTION SENTENCE — say what to do and why, and name the tool. Never write a bare tool name.',
    '• Order the steps so each builds on the one before it.',
    '• Only include steps that directly serve the objective. Do NOT invent steps for outputs, files, or reports that the objective did not ask for.',
    '• If the objective asks for a written result, the final step should fs_write it, and that step must say exactly what to write and to which path.',
    '',
    `Produce 3 to ${MAX_STEPS} steps. Output ONLY the steps, each on its own line, exactly:`,
    'STEP: <a full instruction sentence — what to do, and which tool>',
    '',
    'Example: STEP: Use gemma_kg_schema to inspect the structure of the knowledge graph.',
    '',
    'No preamble, no numbering, no commentary — only STEP: lines.'
  ].join('\n')
}

async function decompose(
  model: string,
  objective: string,
  signal: AbortSignal
): Promise<string[]> {
  const messages: MLXChatMessage[] = [
    { role: 'system', content: decomposeSystemPrompt() },
    {
      role: 'user',
      content: `MISSION OBJECTIVE:\n${objective}\n\nBreak it into steps now — only STEP: lines.`
    }
  ]
  let buffer = ''
  for await (const chunk of chatStream({ model, messages, signal, temperature: DECOMPOSE_TEMP })) {
    if (chunk.content) buffer += chunk.content
    if (chunk.done) break
  }
  const steps: string[] = []
  for (const m of buffer.matchAll(/^[\s\-*\d.]*STEP\s*:\s*(.+)$/gim)) {
    const t = m[1].trim()
    if (t) steps.push(t)
  }
  return steps.slice(0, MAX_STEPS)
}

// --- Execution --------------------------------------------------------------

/** Mission objective + the summaries of completed steps — context the
 *  current step's probe sees so the mission stays coherent. */
function missionNotes(mission: Mission): string {
  const done = mission.steps.filter((s) => s.status === 'done' && s.summary)
  const lines = [`Mission objective: ${mission.objective}`]
  if (done.length > 0) {
    lines.push('', 'Progress so far:')
    done.forEach((s, i) => lines.push(`${i + 1}. ${s.instruction}\n   → ${s.summary}`))
  }
  return lines.join('\n')
}

async function writeMissionJournal(
  mission: Mission,
  stepNum: number,
  step: MissionStep,
  transcript: string,
  toolUsed: string
): Promise<string> {
  const now = new Date()
  const name = `tick-${stamp(now)}.md`
  const md = [
    `# Mission Step ${stepNum}/${mission.steps.length} — ${now.toLocaleString()}`,
    '',
    `- **Mission:** ${mission.objective}`,
    `- **Step:** ${step.instruction}`,
    `- **Model:** ${mission.model}`,
    `- **Tool:** ${toolUsed}`,
    '',
    '## Step',
    '',
    transcript,
    ''
  ].join('\n')
  await writeFile(join(await ticksDir(), name), md, 'utf-8')
  return name
}

async function executeMission(mission: Mission): Promise<void> {
  const abort = new AbortController()
  activeAbort = abort
  const killTimer = setTimeout(() => abort.abort(), MISSION_TIMEOUT_MS)

  try {
    const instructions = await decompose(mission.model, mission.objective, abort.signal)
    if (abort.signal.aborted) {
      mission.status = 'aborted'
      return
    }
    if (instructions.length === 0) {
      mission.status = 'stuck'
      mission.error = 'could not decompose the objective into steps'
      return
    }

    mission.steps = instructions.map((ins, i) => ({
      id: `step_${Date.now()}_${i}_${rand()}`,
      instruction: ins,
      status: 'pending'
    }))
    mission.status = 'running'
    mission.startedAt = Date.now()
    await saveMissions()
    emitMissions()

    for (let i = 0; i < mission.steps.length; i++) {
      if (abort.signal.aborted) {
        mission.status = 'aborted'
        break
      }
      const step = mission.steps[i]
      step.status = 'running'
      await saveMissions()
      emitMissions()

      try {
        const r = await runProbe(
          mission.model,
          { label: step.instruction.slice(0, 80), instruction: step.instruction },
          missionNotes(mission),
          abort.signal,
          (tool) => emit({ type: 'mission-tool', missionId: mission.id, tool })
        )
        step.journalFile = await writeMissionJournal(
          mission,
          i + 1,
          step,
          r.transcript,
          r.toolUsed
        )
        step.summary = r.finalText
        // A step whose tool errored (or that ran no tool) is a real
        // failure — mark it honestly rather than calling it done.
        step.status = r.toolErrored ? 'failed' : 'done'
      } catch (e) {
        step.status = 'failed'
        step.summary = `error: ${(e as Error).message}`
        if (abort.signal.aborted) {
          mission.status = 'aborted'
          await saveMissions()
          emitMissions()
          break
        }
      }
      await saveMissions()
      emitMissions()
    }

    if (mission.status === 'running') {
      mission.status = 'done'
    }
  } catch (e) {
    mission.status = abort.signal.aborted ? 'aborted' : 'stuck'
    mission.error = (e as Error).message
  } finally {
    clearTimeout(killTimer)
    mission.completedAt = Date.now()
    activeAbort = null
    await saveMissions()
    emitMissions()
  }
}

// --- Public API -------------------------------------------------------------

export interface MissionStartResult {
  ok: boolean
  missionId?: string
  error?: string
}

export async function startMission(objective: string): Promise<MissionStartResult> {
  const obj = objective.trim()
  if (!obj) return { ok: false, error: 'the mission objective is empty' }
  if (isMissionActive()) return { ok: false, error: 'a mission is already running' }
  const model = getModel()
  if (!model) return { ok: false, error: 'no model is loaded' }
  if (isChatBusy()) {
    return { ok: false, error: 'a chat is currently streaming — try again shortly' }
  }

  const mission: Mission = {
    id: `mission_${Date.now()}_${rand()}`,
    objective: obj,
    status: 'decomposing',
    steps: [],
    model,
    createdAt: Date.now()
  }
  missions.unshift(mission)
  await saveMissions()
  emitMissions()

  // Run unattended — do not await.
  void executeMission(mission)
  return { ok: true, missionId: mission.id }
}

export function abortMission(): boolean {
  if (activeAbort) {
    activeAbort.abort()
    return true
  }
  return false
}

export interface MissionHooks {
  getModel: () => string | null
  isChatBusy: () => boolean
}

export async function initMission(hooks: MissionHooks): Promise<void> {
  getModel = hooks.getModel
  isChatBusy = hooks.isChatBusy
  await loadMissions()
  // Crash recovery: a mission left mid-flight when the app closed can't
  // resume — mark it stuck so the record is honest.
  let fixed = false
  for (const m of missions) {
    if (m.status === 'running' || m.status === 'decomposing') {
      m.status = 'stuck'
      m.error = 'interrupted — the app was closed while this mission was running'
      m.completedAt = m.completedAt ?? Date.now()
      fixed = true
    }
  }
  if (fixed) await saveMissions()
  console.log(`[mission] initialized — ${missions.length} mission(s) in history`)
}
