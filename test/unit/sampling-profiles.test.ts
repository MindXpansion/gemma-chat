/**
 * Wave A1 — SAMPLING_PROFILES + pickAgenticProfile.
 *
 * SAMPLING_PROFILES encodes the post-Patch-71.2 baseline-preserving sampling
 * for chat / heartbeat (temperature only, no top_k / top_p truncation) and
 * the tighter toolSynth profile for structured-output turns. The exact
 * numbers matter: Gemma 4 author defaults are temp 1.0 / top_k 64 / top_p
 * 0.95; we run cooler (0.7) which makes EOS truncation matter more, so any
 * regression that re-adds top_k/top_p to chat or heartbeat is a known-bad
 * pattern these tests would catch.
 *
 * pickAgenticProfile is the dispatch helper used inside the heartbeat /
 * mission tick loops to choose between exploration (heartbeat) and
 * synthesis (toolSynth) sampling for the next model turn.
 *
 * These tests would catch:
 *  • chat or heartbeat profile regressing to include top_k or top_p
 *    (re-introduces the Patch 71.2 EOS-suppression bug)
 *  • toolSynth's three constants (0.6 / 20 / 0.9) being silently tuned
 *  • pickAgenticProfile no longer routing tool-followups to toolSynth
 *  • pickAgenticProfile crashing on empty / malformed message arrays
 */
import { describe, it, expect } from 'vitest'
import {
  SAMPLING_PROFILES,
  pickAgenticProfile,
  type MLXChatMessage
} from '../../src/main/mlx'

describe('SAMPLING_PROFILES.chat', () => {
  it('has only a temperature field (no top_k, no top_p) — Patch 71.2 baseline', () => {
    expect(SAMPLING_PROFILES.chat.temperature).toBe(0.7)
    expect(SAMPLING_PROFILES.chat.top_k).toBeUndefined()
    expect(SAMPLING_PROFILES.chat.top_p).toBeUndefined()
  })
})

describe('SAMPLING_PROFILES.heartbeat', () => {
  it('has only a temperature field (no top_k, no top_p) — post-Patch-71.2 baseline', () => {
    expect(SAMPLING_PROFILES.heartbeat.temperature).toBe(0.7)
    expect(SAMPLING_PROFILES.heartbeat.top_k).toBeUndefined()
    expect(SAMPLING_PROFILES.heartbeat.top_p).toBeUndefined()
  })
})

describe('SAMPLING_PROFILES.toolSynth', () => {
  it('pins the shipped constants (0.6 / 20 / 0.9)', () => {
    // These exact values were tuned for format adherence on tool-call
    // and ToM-analyzer turns. Silent drift would regress structured
    // output quality without any visible failure.
    expect(SAMPLING_PROFILES.toolSynth.temperature).toBe(0.6)
    expect(SAMPLING_PROFILES.toolSynth.top_k).toBe(20)
    expect(SAMPLING_PROFILES.toolSynth.top_p).toBe(0.9)
  })
})

describe('pickAgenticProfile', () => {
  function msg(role: MLXChatMessage['role'], content = ''): MLXChatMessage {
    return { role, content }
  }

  it("returns 'toolSynth' when the last message role is 'tool'", () => {
    // Would catch a regression that routes tool-result followups through
    // the heartbeat (looser) profile, hurting tool_response synthesis.
    const messages: MLXChatMessage[] = [
      msg('user', 'find me a paper'),
      msg('assistant', '...'),
      msg('tool', '{"results": []}')
    ]
    expect(pickAgenticProfile(messages)).toBe('toolSynth')
  })

  it("returns 'heartbeat' when the last message role is 'assistant'", () => {
    const messages: MLXChatMessage[] = [
      msg('user', 'go'),
      msg('assistant', 'thinking...')
    ]
    expect(pickAgenticProfile(messages)).toBe('heartbeat')
  })

  it("returns 'heartbeat' when the last message role is 'user'", () => {
    const messages: MLXChatMessage[] = [msg('user', 'hello')]
    expect(pickAgenticProfile(messages)).toBe('heartbeat')
  })

  it("returns 'heartbeat' when the last message role is 'system'", () => {
    const messages: MLXChatMessage[] = [msg('system', 'you are gemma')]
    expect(pickAgenticProfile(messages)).toBe('heartbeat')
  })

  it("returns 'heartbeat' on an empty messages array (does not throw)", () => {
    // Edge case: tick loops can call this before any model output exists.
    // Throwing here would crash the heartbeat scheduler.
    expect(pickAgenticProfile([])).toBe('heartbeat')
  })

  it("returns 'heartbeat' when the last message has no role (malformed input)", () => {
    // Edge case: external callers can hand us a partially-built message
    // object. The function should treat "no role" as not-a-tool-followup.
    const messages = [{ content: 'oops' }] as unknown as MLXChatMessage[]
    expect(pickAgenticProfile(messages)).toBe('heartbeat')
  })
})
