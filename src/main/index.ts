import { app, shell, BrowserWindow, ipcMain, nativeTheme, session, nativeImage, dialog, Menu } from 'electron'
// EPIPE guard — Electron main can lose stdout to a closed pipe at startup,
// which turns the first console.log into an uncaught exception that crashes the app.
// See locateMLX() in ./mlx for the first call that surfaces this.
process.stdout.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})
process.stderr.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EPIPE') return
  throw err
})

// Patch 58.1: set name as early as possible — before app.whenReady, before
// any other initialization — so macOS menu / dock / About dialog all see
// "Phronesis". In packaged builds the .app's Info.plist (CFBundleName from
// electron-builder.yml productName) governs the leftmost menu item; in dev
// mode (running unpackaged Electron.app) that bundle says "Electron" and
// the JS-side override has limited effect on the leftmost menu LABEL —
// but role:about/hide/quit items still get "Phronesis" correctly.
//
// ORDER MATTERS: cache the userData path BEFORE setName, then re-pin it
// via setPath in whenReady. Otherwise userData would resolve to ~/Library/
// Application Support/Phronesis/ (the new name) and all existing data
// (heartbeat state, FS mounts, conversations) would be invisible.
const __preservedUserDataPath = app.getPath('userData')
process.title = 'Phronesis'
app.setName('Phronesis')

import { join } from 'path'
import { electronApp, optimizer, is } from '@electron-toolkit/utils'
import { AVAILABLE_MODELS, PROVIDERS } from '@shared/types'
import { getModelStatuses, deleteModelFromCache } from './models'
import {
  locateMLX,
  installMLX,
  startServer,
  stopServer,
  chatStream,
  listLocalModels,
  type MLXChatMessage
} from './mlx'
import {
  TOOLS,
  chatSystemPrompt,
  codeSystemPrompt,
  findNextAction,
  emitSafeBoundary,
  runTool,
  cleanFileContent,
  type ToolContext
} from './tools'
import { analyzeUserMentalModel, getLatestUMM, getLatestUMMUuid } from './tom'
import { selectStrategy, shiftPSV, DEFAULT_PSV } from '../shared/psv'
import { writePSVState, upsertConversationState } from './conversation-state'
import {
  getObservabilitySnapshot,
  getSentinelDetail,
  dryRunSentinel,
  setSentinelEnabled,
  getApprovalsQueue,
  resolveApproval,
  deferApproval
} from './observability'
import { scheduler, PRIORITY } from './scheduler'

scheduler.register('user_chat')
import {
  ensureWorkspace,
  startWorkspaceServer,
  stopWorkspaceServer,
  getWorkspaceServerPort,
  previewUrl,
  listTree,
  workspaceDir,
  wsWriteFile
} from './workspace'
import type { ChatRequest, StreamChunk, ToolCall } from '../shared/types'
import { loadAiosEnv } from './env-loader'
import {
  initHeartbeat,
  shutdownHeartbeat,
  getHeartbeatState,
  setHeartbeatEnabled,
  setHeartbeatCadence,
  runTickNow,
  listJournal,
  readJournal,
  getGoals,
  setGoalStatus,
  heartbeatEvents
} from './heartbeat'
import {
  initMission,
  startMission,
  abortMission,
  getMissions,
  isMissionActive,
  missionEvents
} from './mission'

// Patch 18: mirror config-file API keys into process.env so spawned Python
// scripts (temporal-intelligence, google_maps, weather) inherit them even
// when launched from Dock/Finder (which doesn't source the login shell).
const loadedKeys = loadAiosEnv()
console.log(`[aios-env] Loaded ${loadedKeys.length} key(s): ${loadedKeys.join(', ') || 'none'}`)

let mainWindow: BrowserWindow | null = null

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 820,
    minHeight: 560,
    show: false,
    autoHideMenuBar: true,
    backgroundColor: '#0e0e0e',
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    vibrancy: 'under-window',
    visualEffectState: 'active',
    icon: join(__dirname, '../../build/icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.mjs'),
      sandbox: false,
      contextIsolation: true,
      nodeIntegration: false
    }
  })

  mainWindow.on('ready-to-show', () => {
    mainWindow?.show()
    if (is.dev) {
      mainWindow?.webContents.openDevTools({ mode: 'detach' })
    }
  })

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url)
    return { action: 'deny' }
  })

  if (is.dev && process.env['ELECTRON_RENDERER_URL']) {
    mainWindow.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

function send(channel: string, payload: unknown): void {
  mainWindow?.webContents.send(channel, payload)
}

let mlxPython: string | null = null
// Patch 9: remembered so the renderer's "Reconnect" action can restart the
// same model the user was last running, without round-tripping through the
// renderer state. Updated whenever startServer succeeds.
let currentModel: string | null = null

async function ensureMLXRunning(model: string): Promise<string> {
  let mlx = locateMLX()
  if (!mlx) {
    throw new Error(
      'Python 3.10–3.13 not found. Install via Homebrew: brew install python@3.13'
    )
  }

  let pythonToUse = mlx.python

  if (!mlx.installed) {
    send('setup:status', {
      stage: 'installing-mlx',
      message: 'Installing MLX runtime…'
    })
    // installMLX creates the venv and returns the venv python path
    pythonToUse = await installMLX((p) => {
      send('setup:status', {
        stage: 'installing-mlx',
        message: p.message
      })
    })
  }

  mlxPython = pythonToUse

  const label = AVAILABLE_MODELS.find((m) => m.name === model)?.label ?? model
  send('setup:status', { stage: 'starting-mlx', message: 'Starting model runtime…' })
  send('setup:status', {
    stage: 'downloading-model',
    message: `Loading ${label}… (first run downloads the model)`
  })
  await startServer(pythonToUse, model, (p) => {
    send('setup:status', {
      stage: 'downloading-model',
      message: p.message,
      progress: p.progress
    })
  })
  currentModel = model
  return pythonToUse
}

async function handleSetup(model: string): Promise<void> {
  try {
    send('setup:status', { stage: 'checking', message: 'Checking system…' })
    await ensureMLXRunning(model)
    send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
  } catch (e) {
    send('setup:status', {
      stage: 'error',
      message: 'Setup failed',
      error: (e as Error).message
    })
  }
}

const MAX_TOOL_ROUNDS_CHAT = 6
const MAX_TOOL_ROUNDS_CODE = 40

function actionTarget(_name: string, args: Record<string, unknown>): string | undefined {
  if (typeof args.path === 'string') return args.path
  if (typeof args.query === 'string') return String(args.query)
  if (typeof args.url === 'string') return String(args.url)
  if (typeof args.command === 'string')
    return String(args.command).slice(0, 80)
  return undefined
}

async function handleChat(req: ChatRequest, channel: string): Promise<void> {
  const abort = new AbortController()
  chatAbortControllers.set(req.conversationId, abort)

  const emit = (chunk: StreamChunk): void => send(channel, chunk)

  try {
    const baseMessages: MLXChatMessage[] = []

    if (req.mode === 'code') {
      const wsPath = await ensureWorkspace(req.conversationId)
      const href = previewUrl(req.conversationId)
      baseMessages.push({ role: 'system', content: codeSystemPrompt(wsPath, href) })
    } else {
      // Patch 61 (Tier 4.3 + 4.4): adapt PSV from the previous turn's
      // ToM read for THIS conversation. If no prior read exists (first
      // turn / app just started), use DEFAULT_PSV. Strategy and shift
      // are pure functions — no extra MLX call here; the ToM analyzer
      // already ran asynchronously after the prior turn's stream.
      const lastUmm = getLatestUMM(req.conversationId)
      const strategy = lastUmm ? selectStrategy(lastUmm) : null
      const psv = lastUmm && strategy ? shiftPSV(DEFAULT_PSV, strategy, lastUmm) : DEFAULT_PSV
      if (lastUmm && strategy) {
        console.log(
          `[psv] conversationId=${req.conversationId} strategy=${strategy} emotion=${lastUmm.user_emotion}(${lastUmm.emotion_intensity.toFixed(2)}) rapport=${lastUmm.rapport_level.toFixed(2)} empathy=${psv.empathy.toFixed(2)} agreeableness=${psv.agreeableness.toFixed(2)} consc=${psv.conscientiousness.toFixed(2)} openness=${psv.openness.toFixed(2)}`
        )
        // Patch 62 (Tier 4.5): persist this shift + roll up the conversation
        // hub. Fire-and-forget — the chat stream below must not wait on KG.
        // Skips cleanly when the prior turn's KG write failed (no uuid cached).
        const ummUuid = getLatestUMMUuid(req.conversationId)
        if (ummUuid) {
          void (async () => {
            const tKg = Date.now()
            try {
              await writePSVState(psv, strategy, ummUuid, req.conversationId)
              await upsertConversationState(req.conversationId, {
                current_strategy: strategy,
                last_user_emotion: lastUmm.user_emotion,
                rapport_observation: lastUmm.rapport_level
              })
              console.log(
                `[psv] kg-write ok conversationId=${req.conversationId} strategy=${strategy} ms=${Date.now() - tKg}`
              )
            } catch (e) {
              console.warn(
                `[psv] kg-write FAIL conversationId=${req.conversationId} ms=${Date.now() - tKg} err=${(e as Error).message}`
              )
            }
          })()
        } else {
          console.log(
            `[psv] kg-write SKIP conversationId=${req.conversationId} reason=no_prior_umm_uuid (Tier 4.5 needs at least 1 prior successful UMM write to anchor [:DROVE_SHIFT])`
          )
        }
      }
      baseMessages.push({ role: 'system', content: chatSystemPrompt(req.enableTools, psv) })
    }

    for (const m of req.messages) {
      const msg: MLXChatMessage = { role: m.role as MLXChatMessage['role'], content: m.content }
      if (m.images && m.images.length > 0) msg.images = m.images
      baseMessages.push(msg)
      if (m.toolCalls) {
        for (const tc of m.toolCalls) {
          if (tc.result != null) {
            baseMessages.push({
              role: 'tool',
              content: `Result of <action name="${tc.name}">: ${tc.result}`
            })
          }
        }
      }
    }

    const ctx: ToolContext = {
      conversationId: req.conversationId,
      onFileChange: () => send('workspace:changed', { conversationId: req.conversationId }),
      // Patch 31 L3: ask Bear to approve a write/bash op on an rw-confirm
      // mount. Resolves true on approve, false on deny / abort / 5-min timeout.
      requestConfirm: (payload) =>
        new Promise<boolean>((resolveConfirm) => {
          const id = `confirm_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
          let settled = false
          const settle = (approved: boolean): void => {
            if (settled) return
            settled = true
            pendingConfirms.delete(id)
            resolveConfirm(approved)
          }
          pendingConfirms.set(id, settle)
          emit({ type: 'tool_confirm', id, payload })
          abort.signal.addEventListener('abort', () => settle(false))
          setTimeout(() => settle(false), 5 * 60 * 1000)
        })
    }

    const useTools = req.mode === 'code' || req.enableTools
    const maxRounds = req.mode === 'code' ? MAX_TOOL_ROUNDS_CODE : MAX_TOOL_ROUNDS_CHAT

    emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })

    for (let round = 0; round < maxRounds; round++) {
      let buffer = ''
      let emittedIdx = 0
      let firstToken = true
      let executedAction = false
      let lastActivityTs = 0
      let pendingAction: { name: string; target?: string } | null = null

      // Live-write state for write_file streaming
      let livePath: string | null = null
      let liveContentStart = -1
      let lastLiveWrite = 0
      let livePending: Promise<unknown> | null = null
      let lastEmittedContent = ''
      const writeLivePartial = (): void => {
        if (!livePath || liveContentStart < 0 || livePending) return
        let partial = buffer.slice(liveContentStart)
        if (partial.startsWith('\n')) partial = partial.slice(1)
        const closeIdx = partial.indexOf('</content>')
        if (closeIdx >= 0) partial = partial.slice(0, closeIdx)
        const cleaned = cleanFileContent(partial, livePath)
        if (cleaned !== lastEmittedContent) {
          lastEmittedContent = cleaned
          send('file:streaming', {
            conversationId: req.conversationId,
            path: livePath,
            content: cleaned,
            done: false
          })
        }
        livePending = wsWriteFile(req.conversationId, livePath, cleaned)
          .then(() => {
            send('workspace:changed', { conversationId: req.conversationId })
          })
          .catch(() => {
            /* tolerate partial write failures */
          })
          .finally(() => {
            livePending = null
          })
      }

      const emitActivity = (): void => {
        const now = Date.now()
        if (now - lastActivityTs < 400) return
        lastActivityTs = now
        if (pendingAction) {
          emit({
            type: 'activity',
            activity: {
              kind: 'tool',
              tool: pendingAction.name,
              target: pendingAction.target,
              chars: buffer.length
            }
          })
        } else {
          emit({ type: 'activity', activity: { kind: 'generating', chars: buffer.length } })
        }
      }

      // Patch 57: gate MLX access via the scheduler. USER_CHAT is priority 1
      // (highest); per-round acquire/release lets heartbeat/ToM slip between
      // tool rounds rather than waiting for the whole multi-round conversation.
      await scheduler.acquire('user_chat', PRIORITY.USER_CHAT)
      try {
      streamLoop: for await (const chunk of chatStream({
        model: req.model,
        messages: baseMessages,
        signal: abort.signal
      })) {
        if (chunk.content) {
          if (firstToken) {
            firstToken = false
            emit({ type: 'activity', activity: { kind: 'generating', chars: 0 } })
          }
          buffer += chunk.content

          // Forward raw token to devtools console for debugging
          mainWindow?.webContents.send('chat:raw', {
            conversationId: req.conversationId,
            chunk: chunk.content
          })

          // Detect if we've started an action (for activity label + live writes)
          if (!pendingAction) {
            const openMatch = buffer
              .slice(emittedIdx)
              .match(/<action\s+name\s*=\s*["']?([a-zA-Z_][\w]*)["']?\s*>/i)
            if (openMatch) {
              const name = openMatch[1]
              const rest = buffer.slice(emittedIdx + (openMatch.index ?? 0))
              const pathM = rest.match(/<path>([^<]+?)<\/path>/i)
              const urlM = rest.match(/<url>([^<]+?)<\/url>/i)
              const qM = rest.match(/<query>([^<]+?)<\/query>/i)
              const cmdM = rest.match(/<command>([^<\n]+)/i)
              pendingAction = {
                name,
                target: pathM?.[1] || urlM?.[1] || qM?.[1] || cmdM?.[1]
              }
            }
          } else if (!pendingAction.target) {
            const rest = buffer.slice(emittedIdx)
            const pathM = rest.match(/<path>([^<]+?)<\/path>/i)
            const urlM = rest.match(/<url>([^<]+?)<\/url>/i)
            const qM = rest.match(/<query>([^<]+?)<\/query>/i)
            const cmdM = rest.match(/<command>([^<\n]+)/i)
            const t = pathM?.[1] || urlM?.[1] || qM?.[1] || cmdM?.[1]
            if (t) pendingAction.target = t
          }

          // Live write_file streaming — create/update the file as <content> grows
          if (pendingAction?.name === 'write_file' && pendingAction.target && !livePath) {
            livePath = pendingAction.target
          }
          if (livePath && liveContentStart < 0) {
            const idx = buffer.indexOf('<content>')
            if (idx >= 0) liveContentStart = idx + '<content>'.length
          }
          if (livePath && liveContentStart >= 0) {
            const now = Date.now()
            if (now - lastLiveWrite > 450) {
              lastLiveWrite = now
              writeLivePartial()
            }
          }

          emitActivity()

          while (true) {
            if (!useTools) {
              // No tool parsing: stream tokens as they arrive
              if (emittedIdx < buffer.length) {
                emit({ type: 'token', text: buffer.slice(emittedIdx) })
                emittedIdx = buffer.length
              }
              break
            }

            const found = findNextAction(buffer, emittedIdx)

            if (found === null) {
              // No action starting in the remaining buffer: emit safe text
              const safe = emitSafeBoundary(buffer, emittedIdx)
              if (safe > emittedIdx) {
                emit({ type: 'token', text: buffer.slice(emittedIdx, safe) })
                emittedIdx = safe
              }
              break
            }

            if (found === 'incomplete') {
              // Action has started but not closed. Emit text up to the open tag.
              const openIdx = buffer.indexOf('<action', emittedIdx)
              if (openIdx > emittedIdx) {
                emit({ type: 'token', text: buffer.slice(emittedIdx, openIdx) })
                emittedIdx = openIdx
              }
              break
            }

            // Emit any text between last emit and action start
            if (found.start > emittedIdx) {
              emit({ type: 'token', text: buffer.slice(emittedIdx, found.start) })
            }
            emittedIdx = found.end

            const call: ToolCall = {
              id: `call_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
              name: found.name,
              args: found.args,
              running: true
            }
            emit({ type: 'tool_call', call })
            emit({
              type: 'activity',
              activity: { kind: 'tool', tool: found.name, target: actionTarget(found.name, found.args) }
            })

            let result: string
            let hadError = false
            try {
              result = await runTool(found.name, found.args, ctx)
              emit({ type: 'tool_result', id: call.id, result })
            } catch (e) {
              result = `Error: ${(e as Error).message}`
              hadError = true
              emit({ type: 'tool_result', id: call.id, error: result })
            }

            // Patch 28 (Layer 1 of SOTA tool-use stack): route tool results
            // via OpenAI-shape tool_calls + tool_call_id so Gemma 4's official
            // chat_template renders them into native <|tool_response> tokens.
            //
            // Why this is the foundational fix: the template's forward-scan
            // for role:'tool' messages ONLY triggers when the prior assistant
            // message has a `tool_calls` array. Without it, the tool message
            // is silently DROPPED — the model never sees the result. Every
            // post-tool hallucination we debugged (weather, distance, the
            // "I used a real-time search" fabrication) was caused by missing
            // data, not by the model refusing to use data.
            //
            // Patches 26 and 27 were tightening narration prompts the model
            // never received. With Patch 28 the result actually arrives, in
            // the exact format Gemma 4 was trained on — narration becomes
            // the trained behavior.
            const openAiCallId = call.id // we use the same id we already minted
            baseMessages.push({
              role: 'assistant',
              content: buffer.slice(0, emittedIdx),
              tool_calls: [{
                id: openAiCallId,
                type: 'function',
                function: {
                  name: found.name,
                  arguments: JSON.stringify(found.args)
                }
              }]
            })
            baseMessages.push({
              role: 'tool',
              tool_call_id: openAiCallId,
              content: hadError ? `Error: ${result}` : result
            })
            // Patch 28.5 (Layer 1.5): minimal nudge after <|tool_response|>.
            // Without it, the model sometimes treats its assistant turn as
            // complete and emits a stop token instead of narrating. A trivial
            // user turn gives Gemma a clean generation prompt to respond on.
            // Ephemeral — lives only in baseMessages for this LLM call, never
            // persisted to conversation history.
            baseMessages.push({
              role: 'user',
              content: 'Now respond to me in plain text — narrate if the result is data, confirm briefly if it was an action.'
            })
            executedAction = true
            if (livePath) {
              send('file:streaming', {
                conversationId: req.conversationId,
                path: livePath,
                content: lastEmittedContent,
                done: true
              })
            }
            pendingAction = null
            livePath = null
            liveContentStart = -1
            lastEmittedContent = ''
            emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
            // Break out of the current stream — we need to start a new
            // request with the updated conversation including the tool result.
            break streamLoop
          }
        }
        if (chunk.done) {
          break streamLoop
        }
      }
      } finally {
        scheduler.release('user_chat')
      }

      if (!executedAction) {
        // In Build mode, if the model just described a plan without writing code,
        // nudge it to start coding immediately instead of ending the turn.
        if (req.mode === 'code' && round === 0 && buffer.trim().length > 0) {
          // Flush the plan text to the UI
          if (emittedIdx < buffer.length) {
            emit({ type: 'token', text: buffer.slice(emittedIdx) })
          }
          baseMessages.push({ role: 'assistant', content: buffer })
          baseMessages.push({
            role: 'user',
            content:
              'Good plan. Now start building — emit a write_file action with the first file immediately.'
          })
          emit({ type: 'activity', activity: { kind: 'thinking', chars: 0 } })
          continue // go to round 1
        }
        emit({ type: 'activity', activity: { kind: 'idle' } })
        emit({ type: 'done' })
        return
      }
    }
    emit({ type: 'activity', activity: { kind: 'idle' } })
    emit({
      type: 'error',
      error: `Reached max tool rounds (${maxRounds}). Ask the model to finish up and try again.`
    })
  } catch (e) {
    emit({ type: 'activity', activity: { kind: 'idle' } })
    if ((e as Error).name === 'AbortError') {
      emit({ type: 'done' })
    } else {
      emit({ type: 'error', error: (e as Error).message })
    }
  } finally {
    chatAbortControllers.delete(req.conversationId)
    // Patch 49 (Tier 4.2): fire ToM analysis on the user's latest message.
    // Chat mode only — code mode is precision-focused, no persona/PSV/ToM.
    // Sequential after the stream (MLX now free), fire-and-forget. Best-
    // effort: any error is swallowed inside analyzeUserMentalModel.
    if (req.mode === 'chat') {
      const lastUser = [...req.messages].reverse().find((m) => m.role === 'user')
      if (lastUser?.content) {
        const recentContext = req.messages
          .slice(-7, -1)
          .filter((m) => m.role === 'user' || m.role === 'assistant')
          .map((m) => ({ role: m.role as 'user' | 'assistant', content: m.content }))
        void analyzeUserMentalModel({
          conversationId: req.conversationId,
          model: req.model,
          userMessage: lastUser.content,
          recentContext
        })
      }
    }
  }
}

const chatAbortControllers = new Map<string, AbortController>()
// Patch 31 L3: pending rw-confirm prompts, keyed by confirm id. The renderer
// answers via the 'tool:confirm-reply' IPC, which resolves the stored promise.
const pendingConfirms = new Map<string, (approved: boolean) => void>()

app.whenReady().then(async () => {
  // Patch 58.1: setName + process.title now run at module load (see top
  // of file). Here we just re-pin userData to the path captured BEFORE
  // setName so existing app data (~/Library/Application Support/gemma-chat
  // on macOS) keeps working.
  app.setPath('userData', __preservedUserDataPath)

  // Custom macOS application menu — role:'about'/'hide'/'quit' read
  // app.name(), so after setName('Phronesis') they automatically say
  // "About Phronesis", "Hide Phronesis", "Quit Phronesis".
  if (process.platform === 'darwin') {
    const template: Electron.MenuItemConstructorOptions[] = [
      {
        label: 'Phronesis',
        submenu: [
          { role: 'about' },
          { type: 'separator' },
          { role: 'services' },
          { type: 'separator' },
          { role: 'hide' },
          { role: 'hideOthers' },
          { role: 'unhide' },
          { type: 'separator' },
          { role: 'quit' }
        ]
      },
      { role: 'editMenu' },
      { role: 'viewMenu' },
      { role: 'windowMenu' }
    ]
    Menu.setApplicationMenu(Menu.buildFromTemplate(template))
  }

  electronApp.setAppUserModelId('com.ammaar.gemmachat')
  nativeTheme.themeSource = 'dark'

  // Set dock icon (macOS) — ensures the Gemma icon shows in dev mode
  if (process.platform === 'darwin' && app.dock) {
    const dockIcon = nativeImage.createFromPath(join(__dirname, '../../build/icon.png'))
    if (!dockIcon.isEmpty()) app.dock.setIcon(dockIcon)
  }

  app.on('browser-window-created', (_, window) => {
    optimizer.watchWindowShortcuts(window)
  })

  await startWorkspaceServer()

  // Patch 31: filesystem access — restore mount registry, ensure Gemma's Home.
  try {
    const fs = await import('./gemma-fs')
    await fs.loadFsState()
    await fs.ensureGemmaHome()
    await fs.refreshManifestsCache()
    console.log(`[gemma-fs] Home ready, ${fs.listMounts().length} mount(s) restored`)
  } catch (e) {
    console.error('[gemma-fs] init failed:', (e as Error).message)
  }

  // Patch 34: Autonomous Heartbeat — restore state, resume the timer if it
  // was left enabled. The heartbeat reads currentModel and skips a tick
  // whenever a user chat is mid-stream (single shared MLX server).
  try {
    heartbeatEvents.on('event', (ev) => send('heartbeat:event', ev))
    await initHeartbeat({
      getModel: () => currentModel,
      // A heartbeat tick must not contend for the single MLX server with
      // a user chat OR an autonomous mission.
      isBusy: () => chatAbortControllers.size > 0 || isMissionActive()
    })
  } catch (e) {
    console.error('[heartbeat] init failed:', (e as Error).message)
  }

  // Patch 35: Mission Mode — restore mission history, recover crashed runs.
  try {
    missionEvents.on('event', (ev) => send('mission:event', ev))
    await initMission({
      getModel: () => currentModel,
      isChatBusy: () => chatAbortControllers.size > 0
    })
  } catch (e) {
    console.error('[mission] init failed:', (e as Error).message)
  }

  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media' || permission === 'mediaKeySystem') {
      callback(true)
      return
    }
    callback(false)
  })
  session.defaultSession.setPermissionCheckHandler(() => true)

  ipcMain.handle('setup:start', async (_e, model: string) => {
    await handleSetup(model)
  })

  ipcMain.handle('model:switch', async (_e, model: string) => {
    const label = AVAILABLE_MODELS.find((m) => m.name === model)?.label ?? model
    send('setup:status', {
      stage: 'downloading-model',
      message: `Switching to ${label}…`
    })
    try {
      await stopServer()
      if (!mlxPython) {
        throw new Error('MLX Python path not available. Please restart the app.')
      }
      await startServer(mlxPython, model, (p) => {
        send('setup:status', {
          stage: 'downloading-model',
          message: p.message,
          progress: p.progress
        })
      })
      currentModel = model
      send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
    } catch (e) {
      send('setup:status', {
        stage: 'error',
        message: 'Model switch failed',
        error: (e as Error).message
      })
    }
  })

  // Patch 9: explicit Reconnect. Surfaces in the renderer when an assistant
  // message ends with the Patch 7 timeout error (or any "⚠️" error). Stops
  // any stale MLX subprocess, then starts a fresh one with the model the
  // user was last running. Same setup:status channel the Setup screen uses,
  // so progress is visible if a download has to repeat.
  ipcMain.handle('mlx:reconnect', async () => {
    if (!currentModel) {
      throw new Error('No model has been started yet — open Setup and pick a model.')
    }
    const label = AVAILABLE_MODELS.find((m) => m.name === currentModel)?.label ?? currentModel
    send('setup:status', { stage: 'starting-mlx', message: `Reconnecting to ${label}…` })
    try {
      await stopServer()
      await ensureMLXRunning(currentModel)
      send('setup:status', { stage: 'ready', message: 'Ready to chat.' })
      return { ok: true }
    } catch (e) {
      send('setup:status', {
        stage: 'error',
        message: 'Reconnect failed',
        error: (e as Error).message
      })
      throw e
    }
  })

  ipcMain.handle('setup:status', async () => {
    const mlx = locateMLX()
    return { hasMLX: !!(mlx && mlx.installed) }
  })

  ipcMain.handle('models:list-local', async () => {
    return listLocalModels()
  })

  // Patch 67 (Block D #132): Provider abstraction + Models tab.
  ipcMain.handle('providers:list', async () => PROVIDERS)

  ipcMain.handle('models:status', async () => getModelStatuses(currentModel))

  ipcMain.handle('model:delete', async (_e, name: string) => {
    // If the model the user wants to delete is the one currently loaded in
    // the MLX server, stop the server first so we're not yanking a file out
    // from under a running process.
    if (currentModel === name) {
      send('setup:status', { stage: 'starting-mlx', message: `Unloading ${name} before delete…` })
      await stopServer()
      currentModel = null
    }
    const res = await deleteModelFromCache(name)
    return res
  })

  ipcMain.handle('chat:send', async (_e, req: ChatRequest) => {
    const channel = `chat:stream:${req.conversationId}`
    handleChat(req, channel).catch((err) => console.error('chat handler error', err))
    return { channel }
  })

  ipcMain.handle('chat:abort', async (_e, conversationId: string) => {
    const c = chatAbortControllers.get(conversationId)
    if (c) c.abort()
  })

  ipcMain.handle('tools:list', async () => {
    return Object.values(TOOLS).map((t) => ({
      name: t.name,
      description: t.description,
      mode: t.mode
    }))
  })

  ipcMain.handle('workspace:info', async (_e, conversationId: string) => {
    await ensureWorkspace(conversationId)
    return {
      conversationId,
      path: workspaceDir(conversationId),
      previewUrl: previewUrl(conversationId)
    }
  })

  ipcMain.handle('workspace:list', async (_e, conversationId: string) => {
    const base = await ensureWorkspace(conversationId)
    return listTree(base, 300)
  })

  ipcMain.handle('workspace:open-external', async (_e, conversationId: string) => {
    await ensureWorkspace(conversationId)
    shell.openPath(workspaceDir(conversationId))
  })

  ipcMain.handle('workspace:server-port', async () => getWorkspaceServerPort())

  // Patch 31 L3: renderer's answer to an rw-confirm prompt.
  ipcMain.handle(
    'tool:confirm-reply',
    async (_e, { id, approved }: { id: string; approved: boolean }) => {
      pendingConfirms.get(id)?.(approved)
    }
  )

  // Patch 31 L2: mount management for Gemma's filesystem access.
  ipcMain.handle('gemmafs:list-mounts', async () => {
    const fs = await import('./gemma-fs')
    return fs.listMounts()
  })
  ipcMain.handle('gemmafs:pick-folder', async () => {
    const r = await dialog.showOpenDialog({
      properties: ['openDirectory', 'createDirectory'],
      title: 'Mount a workspace for Gemma'
    })
    return r.canceled || !r.filePaths[0] ? null : r.filePaths[0]
  })
  ipcMain.handle(
    'gemmafs:add-mount',
    async (_e, { path, mode }: { path: string; mode: 'ro' | 'rw-confirm' | 'rw-free' }) => {
      const fs = await import('./gemma-fs')
      return fs.addMount(path, mode)
    }
  )
  ipcMain.handle('gemmafs:remove-mount', async (_e, id: string) => {
    const fs = await import('./gemma-fs')
    return fs.removeMount(id)
  })
  ipcMain.handle(
    'gemmafs:set-mode',
    async (_e, { id, mode }: { id: string; mode: 'ro' | 'rw-confirm' | 'rw-free' }) => {
      const fs = await import('./gemma-fs')
      return fs.setMountMode(id, mode)
    }
  )

  // Patch 63 (Block D #130): Settings Dashboard — observability snapshot.
  ipcMain.handle('observability:snapshot', async (_e, conversationId: string) =>
    getObservabilitySnapshot(conversationId)
  )

  // Patch 65 (Block D #137): Sentinels tab — per-sentinel detail + dry-run + toggle.
  ipcMain.handle('sentinel:detail', async (_e, name: string) => getSentinelDetail(name))
  ipcMain.handle('sentinel:dry-run', async (_e, name: string) => dryRunSentinel(name))
  ipcMain.handle('sentinel:set-enabled', async (_e, { name, enabled }: { name: string; enabled: boolean }) =>
    setSentinelEnabled(name, enabled)
  )

  // Patch 66 (Block D #138): Approvals queue.
  ipcMain.handle('approvals:list', async () => getApprovalsQueue())
  ipcMain.handle(
    'approvals:resolve',
    async (_e, { uuid, resolution }: { uuid: string; resolution: 'resolved' | 'dismissed' }) =>
      resolveApproval(uuid, resolution)
  )
  ipcMain.handle('approvals:defer', async (_e, { uuid, hours }: { uuid: string; hours: number }) =>
    deferApproval(uuid, hours)
  )

  // Patch 34: Autonomous Heartbeat controls.
  ipcMain.handle('heartbeat:get-state', async () => getHeartbeatState())
  ipcMain.handle('heartbeat:set-enabled', async (_e, on: boolean) =>
    setHeartbeatEnabled(on)
  )
  ipcMain.handle('heartbeat:set-cadence', async (_e, minutes: number) =>
    setHeartbeatCadence(minutes)
  )
  ipcMain.handle('heartbeat:tick-now', async () => runTickNow())
  ipcMain.handle('heartbeat:journal-list', async () => listJournal())
  ipcMain.handle('heartbeat:journal-read', async (_e, name: string) =>
    readJournal(name)
  )
  ipcMain.handle('heartbeat:goals-get', async () => getGoals())
  ipcMain.handle(
    'heartbeat:goal-set-status',
    async (_e, { id, status }: { id: string; status: 'queued' | 'skipped' }) =>
      setGoalStatus(id, status)
  )

  // Patch 35: Mission Mode controls.
  ipcMain.handle('mission:start', async (_e, objective: string) =>
    startMission(objective)
  )
  ipcMain.handle('mission:abort', async () => abortMission())
  ipcMain.handle('mission:list', async () => getMissions())

  ipcMain.handle(
    'audio:transcribe',
    async (_e, { base64: _base64, model: _model }: { base64: string; model: string }) => {
      // Audio transcription via MLX is not yet supported
      // Return empty text so the UI doesn't break
      return { text: '' }
    }
  )

  createWindow()

  app.on('activate', function () {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  // On macOS, keep the app alive in the dock so reopening is instant and the
  // MLX subprocess + workspace server stay warm. Only non-darwin platforms
  // quit on last-window-close.
  if (process.platform !== 'darwin') {
    app.quit()
  }
})

app.on('before-quit', () => {
  shutdownHeartbeat()
  stopServer()
  stopWorkspaceServer()
  // Patch 19: close Neo4j driver pool (fire-and-forget, app is exiting)
  import('./aios-neo4j').then((m) => m.closeNeo4j()).catch(() => {})
})
