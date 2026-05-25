import { useEffect, useRef, useState } from 'react'
import { transcribeAudioBlob } from '../lib/whisper'

interface Props {
  onSend: (text: string, images?: string[]) => void
  onStop: () => void
  streaming: boolean
  disabled: boolean
  placeholder?: string
  model: string
}

type RecState = 'idle' | 'recording' | 'loading-model' | 'transcribing'

// Patch 13: read a File as a base64 data URL for direct attachment to the
// chat request. The mlx_vlm.server (Gemma 4 vision) accepts data: URLs
// in the OpenAI content-parts image_url shape — see Patch 5 wire format.
function readImageAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(r.error)
    r.readAsDataURL(file)
  })
}

export default function Composer({
  onSend,
  onStop,
  streaming,
  disabled,
  placeholder,
  model: _model
}: Props) {
  const [text, setText] = useState('')
  const [recState, setRecState] = useState<RecState>('idle')
  const [recordSeconds, setRecordSeconds] = useState(0)
  const [recordError, setRecordError] = useState<string | null>(null)
  const [modelProgress, setModelProgress] = useState<{ pct: number; label: string } | null>(null)
  // Patch 13: pending images (data URLs) attached for the next send
  const [images, setImages] = useState<string[]>([])
  const [isDragging, setIsDragging] = useState(false)
  const taRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const mediaRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])
  const streamRef = useRef<MediaStream | null>(null)
  const timerRef = useRef<number | null>(null)

  async function addFiles(files: FileList | File[]): Promise<void> {
    const arr = Array.from(files).filter((f) => f.type.startsWith('image/'))
    if (arr.length === 0) return
    const urls = await Promise.all(arr.map(readImageAsDataUrl))
    setImages((prev) => [...prev, ...urls])
  }

  function removeImage(idx: number): void {
    setImages((prev) => prev.filter((_, i) => i !== idx))
  }

  useEffect(() => {
    const el = taRef.current
    if (!el) return
    el.style.height = 'auto'
    const max = 220
    el.style.height = Math.min(el.scrollHeight, max) + 'px'
  }, [text])

  function submit(): void {
    const t = text.trim()
    // Patch 13: allow image-only sends — vision queries don't always need text
    if ((!t && images.length === 0) || streaming || disabled) return
    onSend(t, images.length > 0 ? images : undefined)
    setText('')
    setImages([])
  }

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>): void {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      submit()
    }
  }

  function onPaste(e: React.ClipboardEvent<HTMLTextAreaElement>): void {
    const items = e.clipboardData?.items
    if (!items) return
    const files: File[] = []
    for (const item of Array.from(items)) {
      if (item.kind === 'file' && item.type.startsWith('image/')) {
        const f = item.getAsFile()
        if (f) files.push(f)
      }
    }
    if (files.length > 0) {
      e.preventDefault()
      addFiles(files)
    }
  }

  async function startRecording(): Promise<void> {
    setRecordError(null)
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
      streamRef.current = stream
      const mime = pickMime()
      const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined)
      chunksRef.current = []
      rec.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data)
      }
      rec.onstop = async () => {
        const blob = new Blob(chunksRef.current, { type: rec.mimeType || 'audio/webm' })
        streamRef.current?.getTracks().forEach((t) => t.stop())
        streamRef.current = null
        if (blob.size < 500) {
          setRecState('idle')
          setRecordSeconds(0)
          setRecordError('Recording too short')
          return
        }
        setRecState('loading-model')
        try {
          const result = await transcribeAudioBlob(blob, (ev) => {
            if (ev.status === 'progress' && typeof ev.progress === 'number') {
              setModelProgress({
                pct: ev.progress,
                label: ev.file ?? 'whisper model'
              })
            } else if (ev.status === 'ready' || ev.status === 'done') {
              setModelProgress(null)
              setRecState('transcribing')
            } else if (ev.status === 'initiate' || ev.status === 'download') {
              setModelProgress({ pct: 0, label: ev.file ?? 'whisper model' })
            }
          })
          setRecState('transcribing')
          if (result) {
            setText((prev) => (prev ? prev + ' ' + result : result))
            setTimeout(() => taRef.current?.focus(), 0)
          } else {
            setRecordError("Couldn't pick up any speech. Try again a bit louder.")
          }
        } catch (e) {
          setRecordError((e as Error).message)
        } finally {
          setRecState('idle')
          setRecordSeconds(0)
          setModelProgress(null)
        }
      }
      rec.start()
      mediaRef.current = rec
      setRecState('recording')
      setRecordSeconds(0)
      if (timerRef.current) window.clearInterval(timerRef.current)
      timerRef.current = window.setInterval(() => {
        setRecordSeconds((s) => s + 1)
      }, 1000)
    } catch (e) {
      setRecordError((e as Error).message || 'Microphone access denied')
      setRecState('idle')
    }
  }

  function stopRecording(): void {
    if (timerRef.current) {
      window.clearInterval(timerRef.current)
      timerRef.current = null
    }
    mediaRef.current?.stop()
    mediaRef.current = null
  }

  function onMicClick(): void {
    if (recState === 'idle') {
      startRecording()
    } else if (recState === 'recording') {
      stopRecording()
    }
  }

  const canSend =
    (text.trim().length > 0 || images.length > 0) && !disabled && recState === 'idle'

  return (
    <div
      className="shrink-0 px-6 pb-6 pt-2"
      onDragOver={(e) => {
        if (Array.from(e.dataTransfer.types).includes('Files')) {
          e.preventDefault()
          setIsDragging(true)
        }
      }}
      onDragLeave={(e) => {
        // only clear if we're leaving the container, not a child
        if (e.currentTarget === e.target) setIsDragging(false)
      }}
      onDrop={(e) => {
        e.preventDefault()
        setIsDragging(false)
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files)
      }}
    >
      <input
        ref={fileInputRef}
        type="file"
        accept="image/*"
        multiple
        className="hidden"
        onChange={(e) => {
          if (e.target.files) addFiles(e.target.files)
          // allow re-selecting the same file
          e.target.value = ''
        }}
      />
      <div className="mx-auto max-w-3xl">
        {/* Patch 13: thumbnail strip for pending images */}
        {images.length > 0 && (
          <div className="mb-2 flex flex-wrap gap-2">
            {images.map((src, i) => (
              <div
                key={i}
                className="group relative h-16 w-16 overflow-hidden rounded-lg border border-white/10 bg-white/5"
              >
                <img src={src} alt="" className="h-full w-full object-cover" draggable={false} />
                <button
                  onClick={() => removeImage(i)}
                  aria-label="Remove image"
                  className="absolute right-0.5 top-0.5 flex h-4 w-4 items-center justify-center rounded-full bg-black/70 text-[10px] leading-none text-white opacity-0 transition group-hover:opacity-100 hover:bg-black"
                >
                  ×
                </button>
              </div>
            ))}
          </div>
        )}
        <div
          className={`flex items-end gap-2 rounded-2xl border bg-white/[0.03] p-2 shadow-lg shadow-black/40 transition ${
            isDragging
              ? 'border-white/40 bg-white/[0.06]'
              : 'border-white/10 focus-within:border-white/20'
          }`}
        >
          <MicButton
            state={recState}
            seconds={recordSeconds}
            onClick={onMicClick}
            disabled={streaming || disabled}
          />
          <AttachButton
            onClick={() => fileInputRef.current?.click()}
            disabled={streaming || disabled}
          />
          <textarea
            ref={taRef}
            data-composer
            value={text}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            placeholder={
              recState === 'recording'
                ? 'Listening…'
                : recState === 'transcribing'
                  ? 'Transcribing…'
                  : (placeholder ?? 'Message Phronesis…')
            }
            rows={1}
            disabled={disabled || recState !== 'idle'}
            className="min-h-[28px] flex-1 resize-none bg-transparent px-2 py-1.5 text-[14.5px] leading-relaxed text-white placeholder:text-ink-400 focus:outline-none disabled:opacity-50"
          />
          {streaming ? (
            <button
              onClick={onStop}
              aria-label="Stop"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-ink-900 transition hover:bg-white/90"
            >
              <svg viewBox="0 0 12 12" className="h-3 w-3" fill="currentColor">
                <rect x="2" y="2" width="8" height="8" rx="1" />
              </svg>
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend}
              aria-label="Send"
              className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white text-ink-900 transition hover:bg-white/90 disabled:cursor-not-allowed disabled:bg-white/10 disabled:text-ink-400"
            >
              <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
                <path d="M2 8l12-6-4 14-2-6-6-2z" />
              </svg>
            </button>
          )}
        </div>
        <div className="mt-2 flex items-center justify-center gap-2 text-[11px] text-ink-400">
          {recordError ? (
            <span className="text-red-400/90">{recordError}</span>
          ) : recState === 'recording' ? (
            <span>Click mic again to stop.</span>
          ) : recState === 'loading-model' ? (
            modelProgress ? (
              <span className="shimmer-text">
                Downloading Whisper model… {Math.round((modelProgress.pct ?? 0))}%
              </span>
            ) : (
              <span className="shimmer-text">Loading Whisper…</span>
            )
          ) : recState === 'transcribing' ? (
            <span className="shimmer-text">Transcribing locally…</span>
          ) : (
            <span>Enter to send · Shift+Enter for newline · mic for voice</span>
          )}
        </div>
      </div>
    </div>
  )
}

function MicButton({
  state,
  seconds,
  onClick,
  disabled
}: {
  state: RecState
  seconds: number
  onClick: () => void
  disabled: boolean
}) {
  if (state === 'recording') {
    return (
      <button
        onClick={onClick}
        className="flex h-9 items-center gap-1.5 rounded-xl bg-red-500/90 px-3 text-[11.5px] font-medium text-white transition hover:bg-red-500"
        aria-label="Stop recording"
      >
        <span className="flex h-2 w-2 items-center justify-center">
          <span className="h-2 w-2 animate-pulse rounded-full bg-white" />
        </span>
        <span className="tabular-nums">{formatTime(seconds)}</span>
      </button>
    )
  }
  if (state === 'transcribing' || state === 'loading-model') {
    return (
      <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl bg-white/5">
        <svg className="h-4 w-4 animate-spin text-ink-200" viewBox="0 0 24 24" fill="none">
          <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="3" strokeDasharray="40 100" />
        </svg>
      </div>
    )
  }
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Voice input"
      aria-label="Record voice"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-400 transition hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="currentColor">
        <path d="M8 2a2 2 0 0 0-2 2v5a2 2 0 0 0 4 0V4a2 2 0 0 0-2-2z" />
        <path
          d="M4 9a4 4 0 0 0 8 0M8 13v1.5"
          stroke="currentColor"
          strokeWidth="1.3"
          fill="none"
          strokeLinecap="round"
        />
      </svg>
    </button>
  )
}

// Patch 13: image-attach button matching MicButton's idle style
function AttachButton({ onClick, disabled }: { onClick: () => void; disabled: boolean }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title="Attach image"
      aria-label="Attach image"
      className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl text-ink-400 transition hover:bg-white/5 hover:text-white disabled:cursor-not-allowed disabled:opacity-40"
    >
      <svg viewBox="0 0 16 16" className="h-4 w-4" fill="none" stroke="currentColor" strokeWidth="1.5">
        <rect x="2" y="3" width="12" height="10" rx="1.5" />
        <circle cx="5.75" cy="6.25" r="0.9" fill="currentColor" stroke="none" />
        <path d="M2.5 12L6 8.5l2.5 2.5L11 8l2.5 2.5" strokeLinecap="round" strokeLinejoin="round" />
      </svg>
    </button>
  )
}

function formatTime(seconds: number): string {
  const m = Math.floor(seconds / 60)
  const s = seconds % 60
  return `${m}:${String(s).padStart(2, '0')}`
}

function pickMime(): string | undefined {
  const candidates = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4', 'audio/ogg']
  for (const c of candidates) {
    if (typeof MediaRecorder !== 'undefined' && MediaRecorder.isTypeSupported(c)) return c
  }
  return undefined
}

