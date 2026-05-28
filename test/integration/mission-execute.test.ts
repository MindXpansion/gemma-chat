/**
 * Wave B2 — mission engine "stuck" path coverage (single-test file).
 *
 * Exercises executeMission's empty-decompose branch and the saveMissions /
 * crash-recovery edges that the parser-only and state-only unit test files
 * can't reach. This is the ONE place in Wave B2 where chatStream is mocked;
 * justification below.
 *
 * Mocks (justified per conventions.md):
 *   • vi.mock('../../src/main/mlx') — to exercise executeMission's
 *     decompose path WITHOUT spawning the live MLX subprocess. MLX is owned
 *     exclusively by Wave C2 in the parallel rollout; touching it from a
 *     Wave B2 worktree would break the serialization contract on port
 *     11437. The mock yields a buffer with zero `STEP:` lines so the engine
 *     drives directly into the `instructions.length === 0 → status='stuck'`
 *     branch, which is the goal of this file. Real-MLX end-to-end coverage
 *     of executeMission is Wave C2's job.
 *   • process.env.HOME redirect (synchronous, before import) — gemma-fs's
 *     HOME_DIR is computed at module-load from homedir(), and saveMissions
 *     would otherwise write to Bear's real ~/GemmaWorkspace/research/
 *     missions.json. Redirecting HOME to a per-test tmp dir isolates the
 *     test's disk side-effects. Not a "mock" of behavior — just an env
 *     redirect to keep tests hermetic.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

// Redirect HOME to a unique tmp dir BEFORE any import that resolves
// HOME_DIR at module-load time (gemma-fs.ts does this).
const realHome = process.env.HOME
const fakeHome = mkdtempSync(join(tmpdir(), 'phronesis-mission-test-'))
process.env.HOME = fakeHome

// Mock the MLX module so decompose returns immediately with output that
// parseMissionSteps will reduce to [] — driving executeMission into the
// `stuck` branch without hitting the live MLX server.
vi.mock('../../src/main/mlx', async () => {
  // Provide an async generator that yields one chunk with prose only (no
  // STEP: lines), then signals done. This matches the malformed-no-steps
  // fixture's failure mode and is what real models occasionally produce.
  return {
    chatStream: async function* () {
      yield {
        content:
          "I'm not sure how to plan this — could you give me more detail?",
        done: false
      }
      yield { done: true }
    },
    SAMPLING_PROFILES: {
      toolSynth: { temperature: 0.6, top_k: 20, top_p: 0.9 }
    },
    pickAgenticProfile: () => 'toolSynth'
  }
})

beforeAll(() => {
  /* HOME already redirected at module scope */
})

afterAll(() => {
  // Restore HOME and clean up the tmp dir.
  if (realHome) {
    process.env.HOME = realHome
  } else {
    delete process.env.HOME
  }
  try {
    rmSync(fakeHome, { recursive: true, force: true })
  } catch {
    /* best-effort */
  }
})

describe('executeMission — empty decompose drives to status=stuck', () => {
  it('marks the mission stuck and persists it when the parser yields no steps', async () => {
    // Would catch a regression where an empty plan was silently treated as
    // a successful empty mission ("done") — the user would see no error
    // and no work product, baffled. The contract is `stuck` + a reason.
    const mod = await import('../../src/main/mission')

    await mod.initMission({
      getModel: () => 'gemma-stub-test',
      isChatBusy: () => false
    })

    const r = await mod.startMission('plan something the mock cannot decompose')
    expect(r.ok).toBe(true)
    expect(r.missionId).toBeDefined()

    // executeMission is fire-and-forget; wait for it to settle.
    // The path is short (single empty decompose → set stuck → return),
    // but it crosses two scheduler awaits + disk write, so give it room.
    for (let i = 0; i < 50; i++) {
      const ms = mod.getMissions()
      if (ms.length > 0 && (ms[0].status === 'stuck' || ms[0].status === 'done')) break
      await new Promise((resolve) => setTimeout(resolve, 20))
    }

    const all = mod.getMissions()
    expect(all.length).toBeGreaterThanOrEqual(1)
    const m = all[0]
    expect(m.status).toBe('stuck')
    expect(m.error).toMatch(/could not decompose/i)
    expect(m.completedAt).toBeDefined()

    // saveMissions persisted to the redirected HOME dir, NOT real Bear home.
    const writtenPath = join(fakeHome, 'GemmaWorkspace', 'research', 'missions.json')
    expect(existsSync(writtenPath)).toBe(true)
    const parsed = JSON.parse(readFileSync(writtenPath, 'utf-8'))
    expect(Array.isArray(parsed.missions)).toBe(true)
    expect(parsed.missions.length).toBeGreaterThanOrEqual(1)
    expect(parsed.missions[0].status).toBe('stuck')
  })

  it('isMissionActive returns to false after the mission settles', async () => {
    // Would catch a regression where activeAbort wasn't cleared on the
    // stuck path — the engine would refuse all subsequent missions with
    // "a mission is already running" until app restart.
    const mod = await import('../../src/main/mission')
    expect(mod.isMissionActive()).toBe(false)
  })
})
