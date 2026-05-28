import { app, net } from 'electron'
import { spawn, ChildProcess, spawnSync } from 'child_process'
import { join } from 'path'
import { existsSync, rmSync } from 'fs'
import { createServer } from 'net'

const MLX_PORT = 11437
const MLX_HOST = `127.0.0.1:${MLX_PORT}`
const MLX_URL = `http://${MLX_HOST}`

let serverProc: ChildProcess | null = null
let currentModel: string | null = null

// ---------------------------------------------------------------------------
// Paths — everything lives under <appData>/mlx/
// ---------------------------------------------------------------------------

function dataDir(): string {
  return join(app.getPath('userData'), 'mlx')
}

function venvDir(): string {
  return join(dataDir(), 'venv')
}

/** The python binary inside our managed venv */
function venvPython(): string {
  return join(venvDir(), 'bin', 'python3')
}

function modelsDir(): string {
  return join(dataDir(), 'models')
}

/** Patch 67.1: exposed so models.ts can scan the same HF cache the MLX
 *  subprocess writes to. Without this, the Models tab scans the SYSTEM
 *  default (~/.cache/huggingface/hub) which is the wrong location for
 *  this app and reports false "not downloaded" for every model. */
export function hfHubDir(): string {
  return join(modelsDir(), 'hub')
}

// ---------------------------------------------------------------------------
// System Python detection
// ---------------------------------------------------------------------------

/**
 * Find a compatible system Python (3.10–3.13).
 * We explicitly skip 3.14+ because mlx-vlm doesn't publish wheels for it yet.
 * We try versioned binaries first (most reliable), then fall back to `python3`.
 */
function findSystemPython(): string | null {
  // Prefer specific known-good versions, newest first
  const versionedCandidates = [
    '/opt/homebrew/bin/python3.13',
    '/opt/homebrew/bin/python3.12',
    '/opt/homebrew/bin/python3.11',
    '/opt/homebrew/bin/python3.10',
    '/opt/homebrew/opt/python@3.13/bin/python3.13',
    '/opt/homebrew/opt/python@3.12/bin/python3.12',
    '/opt/homebrew/opt/python@3.11/bin/python3.11',
    '/opt/homebrew/opt/python@3.10/bin/python3.10',
    '/usr/local/bin/python3.13',
    '/usr/local/bin/python3.12',
    '/usr/local/bin/python3.11',
    '/usr/local/bin/python3.10'
  ]

  for (const c of versionedCandidates) {
    try {
      const s = spawnSync(c, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (s.status === 0) {
        console.log(`[mlx] Found compatible Python: ${c} (${s.stdout.toString().trim()})`)
        return c
      }
    } catch {
      // not available
    }
  }

  // Last resort: try generic python3 but verify it's not 3.14+
  const fallbacks = ['/opt/homebrew/bin/python3', '/usr/local/bin/python3', '/usr/bin/python3']
  for (const c of fallbacks) {
    try {
      const s = spawnSync(c, ['--version'], { timeout: 5000, stdio: ['ignore', 'pipe', 'pipe'] })
      if (s.status === 0) {
        const ver = s.stdout.toString().trim() // e.g. "Python 3.13.2"
        const match = ver.match(/Python 3\.(\d+)/)
        const minor = match ? parseInt(match[1], 10) : 99
        if (minor >= 10 && minor <= 13) {
          console.log(`[mlx] Found compatible Python: ${c} (${ver})`)
          return c
        } else if (minor < 10) {
          console.log(`[mlx] Skipping ${c} — ${ver} is too old (need 3.10+)`)
        } else {
          console.log(`[mlx] Skipping ${c} — ${ver} is too new for mlx-vlm`)
        }
      }
    } catch {
      // not available
    }
  }

  return null
}

// ---------------------------------------------------------------------------
// MLX detection
// ---------------------------------------------------------------------------

export interface MLXStatus {
  /** Python to use for running mlx_vlm (venv python if installed, system python otherwise) */
  python: string
  /** Whether mlx-vlm is installed and importable */
  installed: boolean
}

/**
 * Check if mlx-vlm is ready to use.
 * Returns the python path to use and whether mlx_vlm is installed.
 */
export function locateMLX(): MLXStatus | null {
  // 1. Check if we have a working venv with mlx_vlm installed
  const vPy = venvPython()
  if (existsSync(vPy)) {
    // Verify the venv Python is 3.10+ — older versions can't run modern mlx-vlm
    try {
      const verCheck = spawnSync(vPy, ['--version'], {
        timeout: 5000,
        stdio: ['ignore', 'pipe', 'pipe']
      })
      const verStr = verCheck.stdout?.toString().trim() || ''
      const verMatch = verStr.match(/Python 3\.(\d+)/)
      const minor = verMatch ? parseInt(verMatch[1], 10) : 0
      if (minor < 10) {
        console.log(`[mlx] Existing venv uses ${verStr} (too old). Deleting and recreating…`)
        try { rmSync(venvDir(), { recursive: true, force: true }) } catch { /* ok */ }
        // Fall through to system python detection below
      } else {
        // Venv Python is compatible — check if mlx_vlm is installed
        try {
          const check = spawnSync(vPy, ['-c', 'import mlx_vlm; print("ok")'], {
            timeout: 15000,
            stdio: ['ignore', 'pipe', 'pipe']
          })
          const stdout = check.stdout?.toString().trim() || ''
          if (check.status === 0 && stdout.includes('ok')) {
            console.log('[mlx] Found mlx-vlm in venv')
            return { python: vPy, installed: true }
          }
        } catch {
          // venv exists but mlx_vlm not importable
        }
        // Venv exists but mlx_vlm is missing — can still pip install into it
        return { python: vPy, installed: false }
      }
    } catch {
      // Can't check version — treat as needing recreation
      console.log('[mlx] Cannot determine venv Python version. Recreating…')
      try { rmSync(venvDir(), { recursive: true, force: true }) } catch { /* ok */ }
    }
  }

  // 2. No venv yet — find a compatible system python so we can create one
  const sysPython = findSystemPython()
  if (!sysPython) return null
  return { python: sysPython, installed: false }
}

// ---------------------------------------------------------------------------
// Installation — creates a venv and installs mlx-vlm
// ---------------------------------------------------------------------------

export type InstallProgress = {
  stage: 'download' | 'install'
  message: string
}

/**
 * Install mlx-vlm into a dedicated virtual environment.
 * Uses --index-url to bypass any corporate pip registries.
 * Returns the venv python path to use for all subsequent operations.
 */
export async function installMLX(
  onProgress: (p: InstallProgress) => void
): Promise<string> {
  const sysPython = findSystemPython()
  if (!sysPython) {
    throw new Error(
      'Python 3.10–3.13 not found. Please install Python via Homebrew: brew install python@3.13'
    )
  }

  const vDir = venvDir()
  const vPy = venvPython()

  // Step 1: Create venv if needed
  if (!existsSync(vPy)) {
    onProgress({ stage: 'install', message: 'Creating Python virtual environment…' })
    console.log(`[mlx] Creating venv at ${vDir} using ${sysPython}`)
    await runProcess(sysPython, ['-m', 'venv', vDir], onProgress)
  }

  // Step 2: Upgrade pip first (avoids old-pip issues)
  onProgress({ stage: 'install', message: 'Upgrading pip…' })
  await runProcess(vPy, [
    '-m', 'pip', 'install', '--upgrade', 'pip',
    '--index-url', 'https://pypi.org/simple/'
  ], onProgress)

  // Step 3: Install mlx-vlm + hf_transfer (Rust-based HF download transport
  // that avoids the Xet protocol stall — see audit §3.6 and Patch 6).
  // Force public PyPI to bypass corporate registries.
  onProgress({ stage: 'install', message: 'Installing mlx-vlm + hf_transfer (this may take a few minutes)…' })
  await runProcess(vPy, [
    '-m', 'pip', 'install', '--upgrade', 'mlx-vlm>=0.5.0', 'hf_transfer',
    '--index-url', 'https://pypi.org/simple/'
  ], onProgress)

  // Verify the install worked
  const check = spawnSync(vPy, ['-c', 'import mlx_vlm; print("ok")'], {
    timeout: 15000,
    stdio: ['ignore', 'pipe', 'pipe']
  })
  if (check.status !== 0 || !check.stdout?.toString().includes('ok')) {
    const err = check.stderr?.toString().slice(-300) || 'unknown error'
    throw new Error(`mlx-vlm installed but failed to import: ${err}`)
  }

  console.log('[mlx] mlx-vlm installed successfully')
  return vPy
}

/** Run a subprocess and stream output to onProgress */
function runProcess(
  cmd: string,
  args: string[],
  onProgress: (p: InstallProgress) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    const proc = spawn(cmd, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        PIP_DISABLE_PIP_VERSION_CHECK: '1',
        // Force public PyPI — don't inherit corporate pip.conf
        PIP_INDEX_URL: 'https://pypi.org/simple/',
        PIP_EXTRA_INDEX_URL: ''
      }
    })

    let stderr = ''
    proc.stdout?.on('data', (d) => {
      const line = d.toString().trim()
      if (line) onProgress({ stage: 'install', message: line.slice(0, 120) })
    })
    proc.stderr?.on('data', (d) => {
      stderr += d.toString()
      const line = d.toString().trim()
      if (line) onProgress({ stage: 'install', message: line.slice(0, 120) })
    })
    proc.on('error', reject)
    proc.on('exit', (code) => {
      if (code === 0) resolve()
      else reject(new Error(`${cmd} ${args.slice(0, 3).join(' ')} failed (exit ${code}): ${stderr.slice(-500)}`))
    })
  })
}

// ---------------------------------------------------------------------------
// Server lifecycle
// ---------------------------------------------------------------------------

export interface ServerProgress {
  message: string
  /** 0.0–1.0 progress fraction, if available */
  progress?: number
}

/** Resolves true if TCP `port` is bindable right now. */
function isPortFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const probe = createServer()
    probe.once('error', () => resolve(false))
    probe.once('listening', () => probe.close(() => resolve(true)))
    probe.listen(port, '0.0.0.0')
  })
}

/** Poll until `port` is bindable, up to `timeoutMs`. */
async function waitPortFree(port: number, timeoutMs: number): Promise<void> {
  const start = Date.now()
  while (Date.now() - start < timeoutMs) {
    if (await isPortFree(port)) return
    await new Promise((r) => setTimeout(r, 250))
  }
  console.log(`[mlx] port ${port} still busy after ${timeoutMs}ms — proceeding anyway`)
}

/**
 * Pre-flight port clear. Before spawning a fresh mlx_vlm.server, SIGKILL
 * every mlx_vlm.server process — our own prior server AND any orphan from a
 * crashed or older session — then wait for port 11437 to become bindable.
 *
 * Patch 39: the app only ever wants ONE mlx server, so killing them all is
 * correct. `pkill -f` matches on the process command line via sysctl — the
 * same TCC-safe path `ps` uses — so unlike `lsof -i :PORT` it does NOT hang
 * under macOS Sequoia, and unlike Patch 37's pid-file it also reaps orphans
 * this app instance never recorded. That orphan case is exactly what left
 * port 11437 squatted and made every model load fail with EADDRINUSE.
 */
async function clearMLXPort(): Promise<void> {
  try {
    const r = spawnSync('pkill', ['-9', '-f', 'mlx_vlm\\.server'], { timeout: 4000 })
    if (r.status === 0) {
      console.log('[mlx] Pre-flight: killed prior mlx_vlm.server process(es)')
    }
  } catch (e) {
    console.log('[mlx] Pre-flight pkill failed (proceeding):', (e as Error).message)
  }
  await waitPortFree(MLX_PORT, 15_000)
}

export async function startServer(
  python: string,
  model: string,
  onProgress?: (p: ServerProgress) => void
): Promise<void> {
  if (serverProc && !serverProc.killed && currentModel === model) return

  // Kill existing server if running with different model
  stopServer()

  // Reap any prior/orphan server and wait for port 11437 to be free
  // before spawning — lsof-free, so it survives macOS TCC (see clearMLXPort).
  await clearMLXPort()

  const env = {
    ...process.env,
    // HuggingFace cache dir — keep models in our app data
    HF_HOME: modelsDir(),
    TRANSFORMERS_CACHE: modelsDir(),
    HF_HUB_DISABLE_TELEMETRY: '1',
    // Rust-based downloader — avoids the Xet protocol stall (see audit §3.6 / Patch 6).
    // Requires hf_transfer installed in the venv; installMLX adds it.
    HF_HUB_ENABLE_HF_TRANSFER: '1',
    // Patch 22: force unbuffered Python output. Without this, when Electron
    // spawns python with piped stdout/stderr (no TTY), Python switches to
    // block-buffering and we get NO output until 4-8 KB has accumulated.
    // Symptom: setup screen looks frozen at "Loading Gemma 4 E4B…" with
    // zero progress, because mlx_vlm's download/load logs never reach us.
    PYTHONUNBUFFERED: '1'
  }

  // Track early exit so waitForHealth can bail out immediately
  let earlyExit: { code: number | null; stderr: string } | null = null
  let stderrBuf = ''

  console.log(`[mlx] Starting server: ${python} -u -m mlx_vlm.server --model ${model} --port ${MLX_PORT}`)

  serverProc = spawn(
    // Patch 22: -u flag is the belt to PYTHONUNBUFFERED's suspenders. Either
    // alone suffices; both together is the safest against future Python
    // versions changing default behavior.
    python,
    ['-u', '-m', 'mlx_vlm.server', '--model', model, '--port', String(MLX_PORT)],
    {
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: false
    }
  )
  currentModel = model

  serverProc.stdout?.on('data', (d) => console.log('[mlx]', d.toString().trim()))
  serverProc.stderr?.on('data', (d) => {
    const text = d.toString()
    stderrBuf += text
    console.log('[mlx]', text.trim())

    // Parse HuggingFace download progress from stderr
    // Format: "Fetching 8 files:  50%|█████     | 4/8 [00:55<00:59, 14.98s/it]"
    if (onProgress) {
      const lines = text.split('\n')
      for (const line of lines) {
        // Match "Fetching N files: XX%" pattern
        const fetchMatch = line.match(/Fetching\s+(\d+)\s+files?:\s+(\d+)%.*?(\d+)\/(\d+)/)
        if (fetchMatch) {
          const pct = parseInt(fetchMatch[2], 10)
          const done = parseInt(fetchMatch[3], 10)
          const total = parseInt(fetchMatch[4], 10)
          onProgress({
            message: `Downloading model files… ${done}/${total}`,
            progress: pct / 100
          })
          continue
        }

        // Match loading messages
        if (line.includes('Starting httpd') || line.includes('starting')) {
          onProgress({ message: 'Starting server…', progress: 1.0 })
        }
      }
    }
  })
  serverProc.on('exit', (code) => {
    console.log('[mlx] server exited with code', code)
    earlyExit = { code, stderr: stderrBuf }
    serverProc = null
    currentModel = null
  })

  // Wait for the server to become healthy.
  // First run downloads model weights from HuggingFace, so allow up to 10 min.
  // Patch 11: waitForHealth now verifies ownership — both that our spawned
  // child is still alive AND that /health reports our model is loaded.
  await waitForHealth(model, serverProc, 600_000, () => earlyExit)
}

export function stopServer(): void {
  if (serverProc && !serverProc.killed) {
    console.log('[mlx] Stopping server')
    // SIGKILL, not SIGTERM: uvicorn's graceful SIGTERM shutdown holds port
    // 11437 for a beat, which raced the next spawn into EADDRINUSE. A hard
    // kill releases the socket immediately.
    serverProc.kill('SIGKILL')
    serverProc = null
    currentModel = null
  }
}

/**
 * Poll the server until it reports our model is loaded.
 *
 * Patch 11: ownership-verified health. The previous version polled
 * /v1/models, which returns 200 from any MLX-compatible server — so an
 * orphan listener (audit §2.6) impersonated a successful start. We now:
 *   1. Bail if the spawned child has died (catches early bind failures).
 *   2. Poll /health (returns JSON with `loaded_model`) instead of /v1/models.
 *   3. Only accept the response when loaded_model === the model we asked for.
 *      A 200 with a different / null loaded_model is treated as "still
 *      loading" or "orphan responding" and we keep polling.
 */
async function waitForHealth(
  expectedModel: string,
  proc: ChildProcess,
  timeoutMs: number,
  checkEarlyExit: () => { code: number | null; stderr: string } | null
): Promise<void> {
  const start = Date.now()
  let lastError: unknown = null

  while (Date.now() - start < timeoutMs) {
    // Check if the server process crashed (exit handler fired)
    const exit = checkEarlyExit()
    if (exit) {
      throw new Error(
        `MLX server exited with code ${exit.code}. ${exit.stderr.slice(-500)}`
      )
    }
    // Patch 11: catch the race where the child is dead but the exit
    // handler hasn't fired yet.
    if (proc.killed || proc.exitCode != null) {
      throw new Error(
        `MLX server process (PID ${proc.pid}) died before becoming healthy.`
      )
    }

    try {
      const res = await fetch(`${MLX_URL}/health`)
      if (res.ok) {
        const data = (await res.json().catch(() => ({}))) as { loaded_model?: string }
        if (data.loaded_model === expectedModel) {
          console.log(
            `[mlx] Server is healthy (PID ${proc.pid}, model ${expectedModel})`
          )
          return
        }
        // 200 OK but wrong/no model. Most common cause: an orphan on the
        // port has a different model loaded, OR our spawn hasn't bound
        // yet and we're talking to the previous owner. Keep polling —
        // either our spawn will fail to bind and earlyExit will fire,
        // or the orphan will eventually be displaced.
        lastError = new Error(
          `Server responded with loaded_model=${data.loaded_model ?? 'null'}, expected ${expectedModel}`
        )
      }
    } catch (e) {
      lastError = e
    }
    await new Promise((r) => setTimeout(r, 1500))
  }
  throw new Error(
    `MLX server did not become healthy within ${timeoutMs / 1000}s: ${String(lastError)}`
  )
}

// ---------------------------------------------------------------------------
// Model management
// ---------------------------------------------------------------------------

export async function listLocalModels(): Promise<string[]> {
  try {
    const res = await fetch(`${MLX_URL}/v1/models`)
    if (!res.ok) return []
    const data = (await res.json()) as { data?: Array<{ id: string }> }
    return (data.data ?? []).map((m) => m.id)
  } catch {
    return []
  }
}

export async function hasModel(_name: string): Promise<boolean> {
  try {
    const models = await listLocalModels()
    return models.length > 0
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// Chat streaming (OpenAI-compatible SSE)
// ---------------------------------------------------------------------------

export interface MLXChatMessage {
  role: 'user' | 'assistant' | 'system' | 'tool'
  content: string
  images?: string[]
  // Patch 28: OpenAI-shape tool-call plumbing. Gemma 4's chat_template.jinja
  // forward-scan for tool results requires the prior assistant message to have
  // `tool_calls` AND the tool message to carry `tool_call_id`. Without these
  // fields, the template silently drops the tool message and the model never
  // sees the result.
  tool_calls?: Array<{
    id: string
    type: 'function'
    function: { name: string; arguments: string }
  }>
  tool_call_id?: string
}

export interface MLXChatOptions {
  model: string
  messages: MLXChatMessage[]
  signal?: AbortSignal
  temperature?: number
  /** Patch 70: optional sampling truncation. Pass-through to mlx-vlm's
   *  OpenAI-compat server. Omit either to leave it unset (server default = no
   *  truncation, which is the pre-Patch-70 baseline — see
   *  docs/baselines/sampling-baseline-2026-05-26.md). */
  top_k?: number
  top_p?: number
}

/**
 * Patch 70 + Patch 71.2: named sampling profiles. Three intents, three tunings:
 *
 *   • chat        — exactly the pre-Patch-70 baseline (temp 0.7, no
 *                   top-k/top-p). Preserves the user-facing chat feel.
 *   • heartbeat   — for free-form heartbeat/mission research turns. Bare
 *                   temp 0.7, no truncation. Reverted from Patch 70's
 *                   top_k=40/top_p=0.95 in 71.2 after measuring a severe
 *                   regression: pre-Patch-70 narrate turns were 3-28s,
 *                   post-Patch-70 they ran 2-4 MINUTES because top_k was
 *                   squeezing the EOS token out of the sampling pool and
 *                   the model literally couldn't terminate. See
 *                   docs/baselines/sampling-baseline-2026-05-26.md +
 *                   commit message for Patch 71.2 for the journal evidence.
 *   • toolSynth   — for turns that emit a tool call or parse structured
 *                   output (ToM analyzer, mission decompose, the model turn
 *                   immediately after a tool_response). Tighter sampling to
 *                   improve format adherence. Unchanged from Patch 70 — the
 *                   EOS-suppression issue doesn't bite here because tool
 *                   outputs are inherently short.
 *
 * Numbers chosen against Gemma 4's author defaults (temp 1.0, top_k 64,
 * top_p 0.95 per the model's generation_config.json). Author defaults work
 * for them partly because temp=1.0 gives EOS more probability mass; we run
 * cooler so EOS truncation matters more.
 */
export const SAMPLING_PROFILES = {
  chat: { temperature: 0.7 } as { temperature: number; top_k?: number; top_p?: number },
  heartbeat: { temperature: 0.7 } as { temperature: number; top_k?: number; top_p?: number },
  toolSynth: { temperature: 0.6, top_k: 20, top_p: 0.9 }
} as const

export type SamplingProfileName = keyof typeof SAMPLING_PROFILES

/**
 * Patch 70 (Option B): inside heartbeat/mission tick loops, decide which
 * profile to use for the NEXT model turn based on the last message in the
 * conversation. If the model is about to respond to a `tool` result, it's
 * synthesis (tighter); otherwise it's exploration (heartbeat profile).
 */
export function pickAgenticProfile(messages: MLXChatMessage[]): SamplingProfileName {
  const last = messages[messages.length - 1]
  return last?.role === 'tool' ? 'toolSynth' : 'heartbeat'
}

export async function* chatStream(
  opts: MLXChatOptions
): AsyncGenerator<{ content?: string; done?: boolean }> {
  // Patch 38: stream over Electron's net stack, NOT Node's global fetch.
  // Node's fetch (undici) imposes a 300s headersTimeout/bodyTimeout. The dense
  // 31B model's first token on a long conversation can take longer than that,
  // so undici aborted the socket mid-request and the renderer saw `terminated`
  // — even though the server was alive and still working. Patch 36 raised the
  // *renderer's* dead-man timer to 7 min but couldn't see undici's 5-min wall.
  // net.fetch has no such idle timeout; the caller's AbortSignal (renderer
  // dead-man timer / heartbeat + mission kill-timers) is now the sole timeout.
  const res = await net.fetch(`${MLX_URL}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model: opts.model,
      messages: opts.messages.map((m) => {
        // Patch 28: preserve OpenAI tool_calls/tool_call_id fields so Gemma 4's
        // chat template forward-scan attaches tool results to the prior
        // assistant turn as native <|tool_response> blocks.
        const base: Record<string, unknown> = { role: m.role, content: m.content }
        if (m.tool_calls && m.tool_calls.length > 0) base.tool_calls = m.tool_calls
        if (m.tool_call_id) base.tool_call_id = m.tool_call_id

        if (!m.images || m.images.length === 0) {
          return base
        }
        // Gemma 4 best practice: images first, text last (per E4B-it model card).
        const parts: Array<
          | { type: 'image_url'; image_url: { url: string } }
          | { type: 'text'; text: string }
        > = m.images.map((url) => ({ type: 'image_url', image_url: { url } }))
        if (m.content) parts.push({ type: 'text', text: m.content })
        base.content = parts
        return base
      }),
      stream: true,
      stream_options: { include_usage: true },
      temperature: opts.temperature ?? 0.7,
      // Patch 70: forward top_k/top_p ONLY when explicitly set. Omitting them
      // preserves the pre-Patch-70 baseline (server default = no truncation).
      ...(opts.top_k != null ? { top_k: opts.top_k } : {}),
      ...(opts.top_p != null ? { top_p: opts.top_p } : {}),
      max_tokens: 8192
    }),
    signal: opts.signal
  })

  if (!res.ok || !res.body) {
    const text = await res.text().catch(() => '')
    throw new Error(`Chat request failed: ${res.status} ${res.statusText} — ${text}`)
  }

  // Parse SSE stream (OpenAI format: "data: {...}\n\n")
  const stream = res.body as unknown as ReadableStream<Uint8Array>
  for await (const event of readSSE(stream)) {
    if (event === '[DONE]') {
      yield { done: true }
      return
    }
    try {
      const parsed = JSON.parse(event) as {
        choices?: Array<{
          delta?: { content?: string; role?: string }
          finish_reason?: string | null
        }>
        usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number }
      }
      // Dev-mode silent-image-drop detector: <50 prompt tokens for an image
      // request means images were stripped before reaching the model.
      if (parsed.usage?.prompt_tokens != null) {
        console.log(`[mlx] usage: prompt=${parsed.usage.prompt_tokens} completion=${parsed.usage.completion_tokens ?? '?'}`)
      }
      const choice = parsed.choices?.[0]
      if (choice?.delta?.content) {
        yield { content: choice.delta.content }
      }
      if (choice?.finish_reason === 'stop' || choice?.finish_reason === 'length') {
        yield { done: true }
        return
      }
    } catch {
      // Skip malformed events
    }
  }
  yield { done: true }
}

/** Parse an SSE byte stream into individual data payloads */
async function* readSSE(stream: ReadableStream<Uint8Array>): AsyncGenerator<string> {
  const reader = stream.getReader()
  const decoder = new TextDecoder()
  let buf = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buf += decoder.decode(value, { stream: true })

    let idx: number
    while ((idx = buf.indexOf('\n\n')) >= 0) {
      const block = buf.slice(0, idx).trim()
      buf = buf.slice(idx + 2)
      if (!block) continue
      for (const line of block.split('\n')) {
        if (line.startsWith('data: ')) {
          const data = line.slice(6).trim()
          if (data) yield data
        }
      }
    }
  }

  // Flush remaining buffer
  if (buf.trim()) {
    for (const line of buf.trim().split('\n')) {
      if (line.startsWith('data: ')) {
        const data = line.slice(6).trim()
        if (data) yield data
      }
    }
  }
}

export { MLX_URL }
