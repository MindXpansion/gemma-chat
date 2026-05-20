import {
  wsWriteFile,
  wsReadFile,
  wsEditFile,
  wsDeleteFile,
  wsRunBash,
  ensureWorkspace,
  listTree,
  previewUrl
} from './workspace'
import { appendObservation, observationsPath } from './aios'
import {
  loadTemporalContext,
  loadPartnerProfile,
  loadArchitectPatterns,
  risePrinciples,
  readIppFile,
  editIppFile,
  appendIppFile,
  getWeather,
  getDirections,
  getDistance,
  searchPlaces,
  episodicRecall,
  weekSummary,
  IPP_FILES
} from './aios-integration'
import { runCypher, getSchemaSummary } from './aios-neo4j'
import { ingestPath, recall, formatRecallHits } from './aios-rag'
import {
  resolveRoot,
  fsRead,
  fsWrite,
  fsList,
  fsTree,
  fsSearch,
  listMounts,
  MAX_FILE_BYTES,
  type FsTreeEntry
} from './gemma-fs'

export interface ToolContext {
  conversationId: string
  onFileChange?: () => void
}

export interface ToolSpec {
  name: string
  description: string
  params: Array<{ name: string; description: string; required?: boolean; multiline?: boolean }>
  example: string
  mode: 'chat' | 'code' | 'both'
  run: (args: Record<string, unknown>, ctx: ToolContext) => Promise<string>
}

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'

async function webSearch(args: Record<string, unknown>): Promise<string> {
  const query = String(args.query ?? '').trim()
  if (!query) return 'Error: missing query'
  const url = `https://duckduckgo.com/html/?q=${encodeURIComponent(query)}`
  const res = await fetch(url, { headers: { 'user-agent': UA, accept: 'text/html' } })
  if (!res.ok) return `Search failed: ${res.status} ${res.statusText}`
  const html = await res.text()
  const results = parseDuckDuckGoResults(html).slice(0, 6)
  if (results.length === 0) return 'No results found.'
  return results
    .map((r, i) => `[${i + 1}] ${r.title}\n${r.url}\n${r.snippet}`)
    .join('\n\n')
}

function parseDuckDuckGoResults(
  html: string
): Array<{ title: string; url: string; snippet: string }> {
  const results: Array<{ title: string; url: string; snippet: string }> = []
  const blockRe = /<div class="result[^"]*?"[^>]*>([\s\S]*?)<div class="clear"/g
  const titleRe = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/
  const snippetRe = /<a[^>]+class="result__snippet"[^>]*>([\s\S]*?)<\/a>/

  let m: RegExpExecArray | null
  while ((m = blockRe.exec(html))) {
    const block = m[1]
    const t = titleRe.exec(block)
    const s = snippetRe.exec(block)
    if (!t) continue
    const rawUrl = decodeURIComponent(t[1].replace(/^\/\/duckduckgo\.com\/l\/\?uddg=/, ''))
      .split('&rut=')[0]
      .split('&amp;')[0]
    const cleanUrl = rawUrl.split('&')[0]
    const title = stripTags(t[2]).trim()
    const snippet = s ? stripTags(s[1]).trim() : ''
    if (title && cleanUrl.startsWith('http')) {
      results.push({ title, url: cleanUrl, snippet })
    }
    if (results.length >= 10) break
  }
  return results
}

function stripTags(s: string): string {
  return s
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function fetchUrl(args: Record<string, unknown>): Promise<string> {
  const url = String(args.url ?? '').trim()
  if (!url) return 'Error: missing url'
  if (!/^https?:\/\//.test(url)) return 'Error: url must be http(s)'
  try {
    const res = await fetch(url, { headers: { 'user-agent': UA } })
    if (!res.ok) return `Fetch failed: ${res.status} ${res.statusText}`
    const ct = res.headers.get('content-type') || ''
    const text = await res.text()
    if (ct.includes('html')) {
      return htmlToText(text).slice(0, 8000)
    }
    return text.slice(0, 8000)
  } catch (e) {
    return `Error fetching: ${(e as Error).message}`
  }
}

function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/\s+/g, ' ')
    .trim()
}

async function calc(args: Record<string, unknown>): Promise<string> {
  const expr = String(args.expression ?? '').trim()
  if (!expr) return 'Error: missing expression'
  if (!/^[0-9+\-*/().\s^%,eE]*$/.test(expr)) {
    return 'Error: only numeric expressions allowed'
  }
  try {
    const sanitized = expr.replace(/\^/g, '**')
    const result = Function(`"use strict"; return (${sanitized})`)()
    return String(result)
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function writeFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const raw = typeof args.content === 'string' ? args.content : ''
  if (!path) return 'Error: missing <path>'
  const content = cleanFileContent(raw, path)
  await wsWriteFile(ctx.conversationId, path, content)
  ctx.onFileChange?.()
  const lines = content.split('\n').length
  return `Wrote ${path} (${content.length} bytes, ${lines} lines).`
}

export function cleanFileContent(raw: string, path: string): string {
  let s = raw

  // Case 1: fully wrapped in ```lang ... ```
  const full = s.trim().match(/^```[a-zA-Z0-9_-]*\n([\s\S]*?)\n```[\s\S]*$/)
  if (full) {
    s = full[1]
  } else {
    // Case 2: just a leading fence ```lang\n
    const lead = s.match(/^\s*```[a-zA-Z0-9_-]*\n/)
    if (lead) {
      s = s.slice(lead[0].length)
      // If there's a trailing fence somewhere, cut everything from there
      const trail = s.search(/\n```(?:\s|$)/)
      if (trail >= 0) s = s.slice(0, trail)
    }
  }

  // Case 3: file-type-aware truncation of post-file commentary
  const lower = path.toLowerCase()
  if (lower.endsWith('.html') || lower.endsWith('.htm')) {
    const end = s.toLowerCase().lastIndexOf('</html>')
    if (end >= 0) s = s.slice(0, end + '</html>'.length) + '\n'
  } else if (lower.endsWith('.svg')) {
    const end = s.toLowerCase().lastIndexOf('</svg>')
    if (end >= 0) s = s.slice(0, end + '</svg>'.length) + '\n'
  } else if (lower.endsWith('.json')) {
    // Trim anything after a trailing } or ]
    const trimmed = s.trim()
    const lastBrace = Math.max(trimmed.lastIndexOf('}'), trimmed.lastIndexOf(']'))
    if (lastBrace >= 0) s = trimmed.slice(0, lastBrace + 1) + '\n'
  }

  return s
}

async function readFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    const content = await wsReadFile(ctx.conversationId, path)
    if (content.length > 20_000) {
      return content.slice(0, 20_000) + '\n[…truncated]'
    }
    return content
  } catch (e) {
    return `Error reading ${path}: ${(e as Error).message}`
  }
}

async function editFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
  const newStr = typeof args.new_string === 'string' ? args.new_string : ''
  const replaceAll = args.replace_all === true || args.replace_all === 'true'
  if (!path) return 'Error: missing <path>'
  if (!oldStr) return 'Error: missing <old_string>'
  try {
    const r = await wsEditFile(ctx.conversationId, path, oldStr, newStr, replaceAll)
    ctx.onFileChange?.()
    return `Edited ${path} (${r.occurrences} replacement${r.occurrences === 1 ? '' : 's'}).`
  } catch (e) {
    return `Error editing ${path}: ${(e as Error).message}`
  }
}

async function listFiles(
  _args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const base = await ensureWorkspace(ctx.conversationId)
  const tree = await listTree(base, 200)
  if (tree.length === 0) return '(workspace is empty)'
  return tree
    .map((e) =>
      e.kind === 'dir' ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size}B)` : ''}`
    )
    .join('\n')
}

async function deleteFile(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  try {
    await wsDeleteFile(ctx.conversationId, path)
    ctx.onFileChange?.()
    return `Deleted ${path}.`
  } catch (e) {
    return `Error deleting ${path}: ${(e as Error).message}`
  }
}

async function runBash(args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const command = String(args.command ?? '').trim()
  const timeout = typeof args.timeout_ms === 'number' ? args.timeout_ms : 60_000
  if (!command) return 'Error: missing <command>'
  try {
    const r = await wsRunBash(ctx.conversationId, command, timeout)
    ctx.onFileChange?.()
    const parts: string[] = []
    parts.push(`exit=${r.exitCode ?? 'killed'} (${r.durationMs}ms)`)
    if (r.stdout) parts.push('stdout:\n' + r.stdout)
    if (r.stderr) parts.push('stderr:\n' + r.stderr)
    if (r.truncated) parts.push('[output was truncated]')
    return parts.join('\n')
  } catch (e) {
    return `Error: ${(e as Error).message}`
  }
}

async function openPreview(_args: Record<string, unknown>, ctx: ToolContext): Promise<string> {
  const url = previewUrl(ctx.conversationId)
  return `Preview is live at ${url}. The Canvas pane on the right shows it.`
}

// --- Patch 31 (Layer 1): filesystem tools — Home + multi-mount registry ----

function formatTree(entries: FsTreeEntry[]): string {
  return entries
    .map((e) => {
      const depth = e.path.split('/').length - 1
      const indent = '  '.repeat(depth)
      const name = e.path.split('/').pop() ?? e.path
      return e.kind === 'dir'
        ? `${indent}${name}/`
        : `${indent}${name}${e.size != null ? ` (${e.size}B)` : ''}`
    })
    .join('\n')
}

async function fsReadTool(args: Record<string, unknown>): Promise<string> {
  const root = String(args.root ?? 'home').trim()
  const path = String(args.path ?? '').trim()
  if (!path) return 'Error: missing <path>'
  const r = resolveRoot(root)
  if ('error' in r) return `Error: ${r.error}`
  try {
    const res = await fsRead(r.absRoot, path)
    if (res.binary) return `(${path} is a binary file — ${res.bytes} bytes, not shown)`
    if (res.truncated) {
      return (
        res.content +
        `\n\n[…truncated at ${MAX_FILE_BYTES} bytes of ${res.bytes}. Use fs_search to locate a specific span.]`
      )
    }
    return res.content || '(empty file)'
  } catch (e) {
    return `Error reading ${root}:${path} — ${(e as Error).message}`
  }
}

async function fsWriteTool(
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const root = String(args.root ?? 'home').trim()
  const path = String(args.path ?? '').trim()
  const content = typeof args.content === 'string' ? args.content : ''
  if (!path) return 'Error: missing <path>'
  const r = resolveRoot(root)
  if ('error' in r) return `Error: ${r.error}`
  if (root !== 'home') {
    return `Error: writing to mounted workspaces lands in Layer 3 (write gating). For now fs_write only targets your Home. Read access to "${root}" works via fs_read / fs_tree / fs_list / fs_search.`
  }
  try {
    await fsWrite(r.absRoot, path, content)
    ctx.onFileChange?.()
    const lines = content.split('\n').length
    return `Wrote ${root}:${path} (${content.length} bytes, ${lines} line${lines === 1 ? '' : 's'}).`
  } catch (e) {
    return `Error writing ${root}:${path} — ${(e as Error).message}`
  }
}

async function fsSearchTool(args: Record<string, unknown>): Promise<string> {
  const root = String(args.root ?? 'home').trim()
  const query = String(args.query ?? '').trim()
  const path = String(args.path ?? '').trim()
  if (!query) return 'Error: missing <query>'
  const depthRaw =
    typeof args.max_depth === 'number'
      ? args.max_depth
      : parseInt(String(args.max_depth ?? ''), 10)
  const maxDepth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 100
  const r = resolveRoot(root)
  if ('error' in r) return `Error: ${r.error}`
  try {
    const { hits, truncated } = await fsSearch(r.absRoot, query, path, maxDepth)
    if (hits.length === 0) return `No matches for "${query}" in ${root}:${path || '/'}.`
    const body = hits.map((h) => `${h.path}:${h.line}: ${h.text}`).join('\n')
    return truncated
      ? body + `\n[…search capped at ${hits.length} hits. Narrow <query> or <path>.]`
      : body
  } catch (e) {
    return `Error searching ${root}:${path || '/'} — ${(e as Error).message}`
  }
}

async function fsListTool(args: Record<string, unknown>): Promise<string> {
  const root = String(args.root ?? 'home').trim()
  const path = String(args.path ?? '').trim()
  const r = resolveRoot(root)
  if ('error' in r) return `Error: ${r.error}`
  try {
    const entries = await fsList(r.absRoot, path)
    if (entries.length === 0) return `(${root}:${path || '/'} is empty)`
    return entries
      .map((e) =>
        e.kind === 'dir' ? `${e.path}/` : `${e.path}${e.size != null ? ` (${e.size}B)` : ''}`
      )
      .join('\n')
  } catch (e) {
    return `Error listing ${root}:${path || '/'} — ${(e as Error).message}`
  }
}

async function fsTreeTool(args: Record<string, unknown>): Promise<string> {
  const root = String(args.root ?? 'home').trim()
  const path = String(args.path ?? '').trim()
  const depthRaw =
    typeof args.max_depth === 'number'
      ? args.max_depth
      : parseInt(String(args.max_depth ?? ''), 10)
  const maxDepth = Number.isFinite(depthRaw) && depthRaw > 0 ? depthRaw : 100
  const r = resolveRoot(root)
  if ('error' in r) return `Error: ${r.error}`
  try {
    const { entries, truncated } = await fsTree(r.absRoot, path, maxDepth)
    if (entries.length === 0) return `(${root}:${path || '/'} is empty)`
    const body = formatTree(entries)
    return truncated
      ? body + '\n[…tree truncated at node cap. Narrow with <path> or use fs_search.]'
      : body
  } catch (e) {
    return `Error walking ${root}:${path || '/'} — ${(e as Error).message}`
  }
}

async function fsMountsTool(): Promise<string> {
  const mounts = listMounts()
  const lines = ['ROOTS available to fs_* tools:', '  home → ~/GemmaWorkspace  [read-write, always]']
  if (mounts.length === 0) {
    lines.push('  (no external workspaces mounted — Bear mounts one via the workspace bar)')
  } else {
    for (const m of mounts) {
      lines.push(`  ${m.id} → ${m.path}  [${m.mode}${m.indexed ? ', indexed' : ''}]`)
    }
  }
  return lines.join('\n')
}

export const TOOLS: Record<string, ToolSpec> = {
  web_search: {
    name: 'web_search',
    description: 'Search the web via DuckDuckGo. Returns a numbered list of results.',
    params: [{ name: 'query', description: 'what to search for', required: true }],
    example:
      '<action name="web_search">\n<query>latest tensorflow release notes</query>\n</action>',
    mode: 'both',
    run: webSearch
  },
  fetch_url: {
    name: 'fetch_url',
    description: 'Fetch a web page and return its text content (truncated to ~8KB).',
    params: [{ name: 'url', description: 'absolute http(s) URL', required: true }],
    example: '<action name="fetch_url">\n<url>https://example.com</url>\n</action>',
    mode: 'both',
    run: fetchUrl
  },
  calc: {
    name: 'calc',
    description: 'Evaluate a numeric expression.',
    params: [{ name: 'expression', description: 'math expression', required: true }],
    example: '<action name="calc">\n<expression>2 + 2 * 3</expression>\n</action>',
    mode: 'both',
    run: calc
  },
  write_file: {
    name: 'write_file',
    description:
      'Create or overwrite a file in the workspace. Use this to generate code, HTML, CSS, JSON, etc.',
    params: [
      { name: 'path', description: 'path relative to workspace (e.g. index.html)', required: true },
      { name: 'content', description: 'full file text', required: true, multiline: true }
    ],
    example:
      '<action name="write_file">\n<path>index.html</path>\n<content>\n<!doctype html>\n<html>\n<body>Hello</body>\n</html>\n</content>\n</action>',
    mode: 'code',
    run: writeFile
  },
  read_file: {
    name: 'read_file',
    description: 'Read a file from the workspace.',
    params: [{ name: 'path', description: 'path relative to workspace', required: true }],
    example: '<action name="read_file">\n<path>index.html</path>\n</action>',
    mode: 'code',
    run: readFile
  },
  edit_file: {
    name: 'edit_file',
    description:
      'Replace a snippet in an existing file. old_string must appear exactly once, or pass <replace_all>true</replace_all>.',
    params: [
      { name: 'path', description: 'file path', required: true },
      { name: 'old_string', description: 'exact text to find', required: true, multiline: true },
      { name: 'new_string', description: 'replacement text', required: true, multiline: true },
      { name: 'replace_all', description: 'true to replace every occurrence' }
    ],
    example:
      '<action name="edit_file">\n<path>index.html</path>\n<old_string>Hello</old_string>\n<new_string>Hello, world</new_string>\n</action>',
    mode: 'code',
    run: editFile
  },
  list_files: {
    name: 'list_files',
    description: 'List every file in the workspace.',
    params: [],
    example: '<action name="list_files"></action>',
    mode: 'code',
    run: listFiles
  },
  delete_file: {
    name: 'delete_file',
    description: 'Delete a file or directory from the workspace.',
    params: [{ name: 'path', description: 'path to delete', required: true }],
    example: '<action name="delete_file">\n<path>old.html</path>\n</action>',
    mode: 'code',
    run: deleteFile
  },
  run_bash: {
    name: 'run_bash',
    description:
      'Run a bash command inside the workspace directory. Use for npm install, git, formatters, quick checks.',
    params: [
      { name: 'command', description: 'shell command', required: true, multiline: true }
    ],
    example: '<action name="run_bash">\n<command>ls -la</command>\n</action>',
    mode: 'code',
    run: runBash
  },
  open_preview: {
    name: 'open_preview',
    description:
      'Reveal the Canvas preview. Call after creating or updating index.html so the user sees the result.',
    params: [],
    example: '<action name="open_preview"></action>',
    mode: 'code',
    run: openPreview
  },
  // Patch 16 (AIOS init) — Gemma's persistent observation log + temporal grounding tool
  aios_observe: {
    name: 'aios_observe',
    description:
      'Save an observation, pattern, or insight to your persistent log (survives across sessions). Use when you notice something worth remembering: a recurring user preference, a useful pattern, an anti-pattern to avoid, a project-context fact, or a self-correction lesson. Brief is good.',
    params: [
      {
        name: 'text',
        description: 'The observation to record. One or two sentences. Include the WHY when relevant.',
        required: true,
        multiline: true
      }
    ],
    example:
      '<action name="aios_observe">\n<text>Bear prefers single-patch commits over batched ones. Reason: easier rollback and review.</text>\n</action>',
    mode: 'both',
    run: async (args, ctx) => {
      const text = String(args.text ?? '').trim()
      return appendObservation(text, ctx.conversationId)
    }
  },
  aios_now: {
    name: 'aios_now',
    description:
      'Get the current date, time, timezone, and date-reference map (yesterday, this Monday, last Friday, etc.) from the canonical temporal-intelligence source. Use for time-sensitive reasoning or to refresh in long conversations.',
    params: [],
    example: '<action name="aios_now"></action>',
    mode: 'both',
    run: async () => {
      const block = loadTemporalContext()
      return block || `Current ISO time: ${new Date().toISOString()}`
    }
  },
  // Patch 17 (AIOS integration) — read/write into Bear's intelligence-partner files.
  // Whitelist enforced in aios-integration.ts; section-based edits only (no full rewrites).
  ipp_read: {
    name: 'ipp_read',
    description: `Read one of Bear's intelligence-partner files in full. Allowed names: ${IPP_FILES.join(', ')}. Use before ipp_edit to find the exact passage to patch.`,
    params: [
      {
        name: 'file',
        description: `short name without .md (one of: ${IPP_FILES.join(', ')})`,
        required: true
      }
    ],
    example: '<action name="ipp_read">\n<file>preferences</file>\n</action>',
    mode: 'both',
    run: async (args) => readIppFile(String(args.file ?? '').trim())
  },
  ipp_append: {
    name: 'ipp_append',
    description:
      'Append a timestamped entry to one of Bear\'s intelligence-partner files (typically `memory` for session learnings). The entry is added at the end under a "## YYYY-MM-DD — Gemma" heading.',
    params: [
      {
        name: 'file',
        description: `short name without .md (one of: ${IPP_FILES.join(', ')})`,
        required: true
      },
      {
        name: 'content',
        description: 'the entry body in markdown',
        required: true,
        multiline: true
      }
    ],
    example:
      '<action name="ipp_append">\n<file>memory</file>\n<content>\nNew preference observed today: Bear wants Gemma to write IPP files herself, not just propose.\n</content>\n</action>',
    mode: 'both',
    run: async (args) => {
      const file = String(args.file ?? '').trim()
      const content = typeof args.content === 'string' ? args.content : ''
      return appendIppFile(file, content)
    }
  },
  ipp_edit: {
    name: 'ipp_edit',
    description:
      'Surgical section-based patch on an intelligence-partner file (per IPP ideal #6 — never full rewrites). old_string must appear EXACTLY once. Always ipp_read first to copy the exact text. For soul.md and ideals.md (HIGH/CRITICAL tiers), confirm with Bear before editing.',
    params: [
      {
        name: 'file',
        description: `short name without .md (one of: ${IPP_FILES.join(', ')})`,
        required: true
      },
      {
        name: 'old_string',
        description: 'exact text to replace (must be unique in file)',
        required: true,
        multiline: true
      },
      {
        name: 'new_string',
        description: 'replacement text',
        required: true,
        multiline: true
      }
    ],
    example:
      '<action name="ipp_edit">\n<file>preferences</file>\n<old_string>- Python over shell for anything beyond simple glue.</old_string>\n<new_string>- Python over shell for anything beyond simple glue (TypeScript for Electron-side scripts).</new_string>\n</action>',
    mode: 'both',
    run: async (args) => {
      const file = String(args.file ?? '').trim()
      const oldStr = typeof args.old_string === 'string' ? args.old_string : ''
      const newStr = typeof args.new_string === 'string' ? args.new_string : ''
      return editIppFile(file, oldStr, newStr)
    }
  },
  // Patch 18 (AIOS capability tools) — spatial, weather, episodic recall.
  // All shell out to canonical scripts under ~/Skills/temporal-intelligence/.
  aios_weather: {
    name: 'aios_weather',
    description:
      'Get current weather for a location. Defaults to Bear\'s home (Colorado Springs) if no location given. No API key needed — uses Open-Meteo / wttr.in.',
    params: [
      {
        name: 'location',
        description: 'city name, ZIP, or "lat,lon" — optional (defaults to home)'
      }
    ],
    example: '<action name="aios_weather">\n<location>Denver, CO</location>\n</action>',
    mode: 'both',
    run: async (args) => getWeather(String(args.location ?? '').trim() || undefined)
  },
  aios_directions: {
    name: 'aios_directions',
    description:
      'Get turn-by-turn directions between two locations via Google Maps. Requires GOOGLE_MAPS_API_KEY (loaded at app startup from ~/.gemma-chat.env or ~/.zshenv).',
    params: [
      { name: 'origin', description: 'starting location (address, city, or place name)', required: true },
      { name: 'destination', description: 'ending location', required: true },
      { name: 'mode', description: 'driving | walking | bicycling | transit (default driving)' }
    ],
    example:
      '<action name="aios_directions">\n<origin>Colorado Springs, CO</origin>\n<destination>Denver, CO</destination>\n<mode>driving</mode>\n</action>',
    mode: 'both',
    run: async (args) =>
      getDirections(
        String(args.origin ?? '').trim(),
        String(args.destination ?? '').trim(),
        String(args.mode ?? 'driving').trim() || 'driving'
      )
  },
  aios_distance: {
    name: 'aios_distance',
    description:
      'Get distance and travel time between an origin and one or more destinations (Google Maps Distance Matrix). Best tool for "how far is X from Y" questions.',
    params: [
      { name: 'origin', description: 'starting location', required: true },
      {
        name: 'destinations',
        description: 'comma-separated list of destinations (one or more)',
        required: true
      }
    ],
    example:
      '<action name="aios_distance">\n<origin>Colorado Springs, CO</origin>\n<destinations>Denver, CO, Pueblo, CO</destinations>\n</action>',
    mode: 'both',
    run: async (args) => {
      const origin = String(args.origin ?? '').trim()
      const destsRaw = String(args.destinations ?? '').trim()
      const destinations = destsRaw
        .split(/,(?![^(]*\))/) // simple comma split (good-enough for plain place names)
        .map((s) => s.trim())
        .filter((s) => s.length > 0)
      return getDistance(origin, destinations)
    }
  },
  aios_places: {
    name: 'aios_places',
    description:
      'Search for places (restaurants, businesses, landmarks) via Google Maps. Use `near` to bias by location.',
    params: [
      { name: 'query', description: 'what to search for (e.g. "coffee", "Italian restaurant")', required: true },
      { name: 'near', description: 'location bias (e.g. "Denver, CO") — optional' }
    ],
    example:
      '<action name="aios_places">\n<query>coffee</query>\n<near>Colorado Springs, CO</near>\n</action>',
    mode: 'both',
    run: async (args) =>
      searchPlaces(String(args.query ?? '').trim(), String(args.near ?? '').trim() || undefined)
  },
  aios_recall: {
    name: 'aios_recall',
    description:
      'Episodic recall: what was Bear working on a specific day? Queries TaskFlow Pro (his client work tracker). day_expr accepts "yesterday", "last monday", "2026-05-12", etc.',
    params: [
      { name: 'day_expr', description: 'day to recall', required: true },
      { name: 'client', description: 'filter by client code (optional)' }
    ],
    example: '<action name="aios_recall">\n<day_expr>last monday</day_expr>\n</action>',
    mode: 'both',
    run: async (args) =>
      episodicRecall(
        String(args.day_expr ?? '').trim(),
        String(args.client ?? '').trim() || undefined
      )
  },
  aios_week_summary: {
    name: 'aios_week_summary',
    description:
      'Summarize Bear\'s TaskFlow activity for the current week (Monday through today), grouped by day.',
    params: [],
    example: '<action name="aios_week_summary"></action>',
    mode: 'both',
    run: async () => weekSummary()
  },
  // Patch 19 (Neo4j integration) — Cypher access to Bear's partnership KG
  // (kg-arch-enterprise DBMS at bolt://localhost:7687). Reads creds via
  // env-loader from ~/.intelligence_partner/neo4j-creds.env.
  // Patch 19/20 — Two Neo4j graphs are accessible:
  //   aios_kg_*    → Bear's partnership KG (kg-arch-enterprise default DB)
  //   gemma_kg_*   → Gemma's own RAG-grade KG (gemma-chat-memory DB)
  // Symmetric API; different boundaries.
  aios_kg_schema: {
    name: 'aios_kg_schema',
    description:
      'Return labels, relationship types, and constraints from Bear\'s partnership knowledge graph (kg-arch-enterprise). Always call this FIRST when working with the KG — never craft Cypher without knowing the schema.',
    params: [],
    example: '<action name="aios_kg_schema"></action>',
    mode: 'both',
    run: async () => getSchemaSummary('partnership')
  },
  aios_kg_query: {
    name: 'aios_kg_query',
    description:
      'Run a Cypher query against Bear\'s partnership KG (kg-arch-enterprise). Accepts read AND write queries. The neo4j-kg-architect anti-patterns (loaded into your prompt) apply — especially: pair MERGE with a uniqueness constraint, never trust internal id(n), preflight port conflicts. Result rows capped at 50.',
    params: [
      {
        name: 'cypher',
        description: 'the Cypher statement',
        required: true,
        multiline: true
      },
      {
        name: 'params',
        description: 'optional JSON object of query parameters',
        multiline: true
      }
    ],
    example:
      '<action name="aios_kg_query">\n<cypher>MATCH (s:Session)-[:DURING]->(p:Phase {name: $phase}) RETURN s.id, s.started_at LIMIT 10</cypher>\n<params>{"phase": "Phase 3"}</params>\n</action>',
    mode: 'both',
    run: async (args) => {
      const cypher = typeof args.cypher === 'string' ? args.cypher : ''
      const parsed = parseParams(args.params)
      if ('error' in parsed) return parsed.error
      return runCypher('partnership', cypher, parsed.params)
    }
  },
  // Patch 20 (Gemma's own KG) — symmetric tools targeting gemma-chat-memory.
  // Schema per docs/research/05-neo4j-voyageai-rag-design.md:
  //   :Document → :Chunk (embeddings), :Conversation → :Turn → :Summary,
  //   :Workspace → :Observation → :Pattern, :Image, :Entity (deferred)
  gemma_kg_schema: {
    name: 'gemma_kg_schema',
    description:
      'Return labels, relationship types, and constraints from YOUR OWN knowledge graph (gemma-chat-memory). Same architect discipline applies — call this before crafting Cypher. Schema per research-05: Document/Chunk (RAG corpus), Conversation/Turn/Summary (chat history), Workspace/Observation/Pattern (AIOS), Image, Entity (deferred). All embeddings are 1024-dim cosine.',
    params: [],
    example: '<action name="gemma_kg_schema"></action>',
    mode: 'both',
    run: async () => getSchemaSummary('gemma')
  },
  gemma_kg_query: {
    name: 'gemma_kg_query',
    description:
      'Run a Cypher query against YOUR OWN knowledge graph (gemma-chat-memory). Read AND write. This is your workspace — write freely. Use vector search via `CALL db.index.vector.queryNodes(\'chunk_embedding\', $k, $vec) YIELD node, score`. Result rows capped at 50.',
    params: [
      { name: 'cypher', description: 'the Cypher statement', required: true, multiline: true },
      { name: 'params', description: 'optional JSON object of query parameters', multiline: true }
    ],
    example:
      '<action name="gemma_kg_query">\n<cypher>MATCH (d:Document) RETURN d.uri, d.title, d.indexed_at ORDER BY d.indexed_at DESC LIMIT 20</cypher>\n</action>',
    mode: 'both',
    run: async (args) => {
      const cypher = typeof args.cypher === 'string' ? args.cypher : ''
      const parsed = parseParams(args.params)
      if ('error' in parsed) return parsed.error
      return runCypher('gemma', cypher, parsed.params)
    }
  },
  // Patch 21 (RAG ingestion + recall) — voyageai-backed
  gemma_ingest: {
    name: 'gemma_ingest',
    description:
      'Index a markdown/text file (or directory of them) into gemma-chat-memory for semantic recall. Idempotent on sha256 — re-ingesting an unchanged file is a no-op. Uses voyage-3-large at 1024 dim. Cost ≈ $0.18 per million tokens (~$0.02 per 100KB of prose).',
    params: [
      { name: 'path', description: 'absolute path to a .md/.txt file or a directory', required: true },
      { name: 'recursive', description: 'true to walk subdirectories (default false)' }
    ],
    example:
      '<action name="gemma_ingest">\n<path>/Users/bear/Development/gemma-chat/docs/research</path>\n</action>',
    mode: 'both',
    run: async (args) => {
      const path = String(args.path ?? '').trim()
      if (!path) return 'Error: path is required.'
      const recursive = args.recursive === true || args.recursive === 'true'
      const results = await ingestPath(path, recursive)
      const lines: string[] = []
      let totalChunks = 0
      let totalTokens = 0
      let totalCost = 0
      for (const r of results) {
        if (r.status === 'indexed') {
          lines.push(`✓ ${r.uri} — ${r.chunks} chunks, ${r.tokens} tokens, $${(r.cost_usd ?? 0).toFixed(4)}`)
          totalChunks += r.chunks ?? 0
          totalTokens += r.tokens ?? 0
          totalCost += r.cost_usd ?? 0
        } else if (r.status === 'skipped-existing') {
          lines.push(`• ${r.uri} — already indexed`)
        } else {
          lines.push(`✗ ${r.uri} — ${r.message}`)
        }
      }
      lines.push('')
      lines.push(
        `TOTAL: ${totalChunks} chunks, ${totalTokens} tokens, $${totalCost.toFixed(4)}`
      )
      return lines.join('\n')
    }
  },
  gemma_recall: {
    name: 'gemma_recall',
    description:
      'Semantic recall from gemma-chat-memory. Embeds the query (voyage-3-large) and vector-searches the Chunk index. Returns top-K matches with document title and chunk text. Best for "what did I write about X" or "find the doc that mentions Y" questions.',
    params: [
      { name: 'query', description: 'what you\'re looking for', required: true, multiline: true },
      { name: 'k', description: 'how many matches to return (default 5, max 25)' }
    ],
    example:
      '<action name="gemma_recall">\n<query>voyage embedding model and dimensions</query>\n<k>5</k>\n</action>',
    mode: 'both',
    run: async (args) => {
      const query = String(args.query ?? '').trim()
      if (!query) return 'Error: query is required.'
      const kRaw = typeof args.k === 'number' ? args.k : parseInt(String(args.k ?? '5'), 10)
      const k = Math.max(1, Math.min(25, Number.isFinite(kRaw) ? kRaw : 5))
      const hits = await recall(query, k)
      return formatRecallHits(hits)
    }
  },
  // Patch 31 (Layer 1): filesystem — Home + multi-mount registry.
  fs_mounts: {
    name: 'fs_mounts',
    description:
      'List the filesystem roots you can reach: `home` (your persistent ~/GemmaWorkspace) plus any workspaces Bear has mounted. Call this first when you need to know what `root` values are valid.',
    params: [],
    example: '<action name="fs_mounts"></action>',
    mode: 'both',
    run: fsMountsTool
  },
  fs_tree: {
    name: 'fs_tree',
    description:
      'Show the directory structure of a root (or a subpath of it). Skips .git, node_modules, dotfiles. Unlimited depth by default — pass max_depth to constrain a large tree.',
    params: [
      { name: 'root', description: 'root name: `home` or a mounted workspace id (default home)' },
      { name: 'path', description: 'subpath within the root (optional — omit for the whole root)' },
      { name: 'max_depth', description: 'max levels deep to walk (optional)' }
    ],
    example: '<action name="fs_tree">\n<root>home</root>\n</action>',
    mode: 'both',
    run: fsTreeTool
  },
  fs_list: {
    name: 'fs_list',
    description: 'List the immediate contents of one directory within a root.',
    params: [
      { name: 'root', description: 'root name: `home` or a mounted workspace id (default home)' },
      { name: 'path', description: 'directory within the root (optional — omit for the root itself)' }
    ],
    example: '<action name="fs_list">\n<root>home</root>\n<path>notes</path>\n</action>',
    mode: 'both',
    run: fsListTool
  },
  fs_search: {
    name: 'fs_search',
    description:
      'Case-insensitive content search across text files in a root. Returns file:line: matched-text. Skips binaries, .git, node_modules. Capped at 80 hits — narrow the query or path if truncated.',
    params: [
      { name: 'root', description: 'root name: `home` or a mounted workspace id (default home)' },
      { name: 'query', description: 'text to search for', required: true },
      { name: 'path', description: 'subpath to scope the search (optional)' },
      { name: 'max_depth', description: 'max levels deep to search (optional)' }
    ],
    example: '<action name="fs_search">\n<root>home</root>\n<query>TODO</query>\n</action>',
    mode: 'both',
    run: fsSearchTool
  },
  fs_read: {
    name: 'fs_read',
    description:
      'Read a text file from a root. Files over 256 KB are truncated with a notice; binary files are reported, not dumped.',
    params: [
      { name: 'root', description: 'root name: `home` or a mounted workspace id (default home)' },
      { name: 'path', description: 'file path within the root', required: true }
    ],
    example: '<action name="fs_read">\n<root>home</root>\n<path>notes/today.md</path>\n</action>',
    mode: 'both',
    run: fsReadTool
  },
  fs_write: {
    name: 'fs_write',
    description:
      'Create or overwrite a text file in a root. Home is always writable. Mounted workspaces must be in a read-write mode (read-only mounts and confirm-mode are gated).',
    params: [
      { name: 'root', description: 'root name: `home` or a mounted workspace id (default home)' },
      { name: 'path', description: 'file path within the root', required: true },
      { name: 'content', description: 'full file text', required: true, multiline: true }
    ],
    example:
      '<action name="fs_write">\n<root>home</root>\n<path>notes/today.md</path>\n<content>\n# Notes\nFirst entry.\n</content>\n</action>',
    mode: 'both',
    run: fsWriteTool
  }
}

function parseParams(raw: unknown): { params: Record<string, unknown> } | { error: string } {
  const text = typeof raw === 'string' ? raw.trim() : ''
  if (!text) return { params: {} }
  try {
    const parsed = JSON.parse(text)
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return { params: parsed as Record<string, unknown> }
    }
    return { error: 'Error: params must be a JSON object.' }
  } catch (e) {
    return { error: `Error parsing params as JSON: ${(e as Error).message}` }
  }
}

function tz(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone
  } catch {
    return 'UTC'
  }
}

function renderToolHelp(mode: 'chat' | 'code'): string {
  const wanted = (t: ToolSpec): boolean => t.mode === 'both' || t.mode === mode
  const lines: string[] = []
  for (const t of Object.values(TOOLS)) {
    if (!wanted(t)) continue
    lines.push(`### ${t.name}`)
    lines.push(t.description)
    if (t.params.length) {
      lines.push('Parameters:')
      for (const p of t.params) {
        const req = p.required ? ' (required)' : ''
        const multi = p.multiline ? ' — multi-line OK' : ''
        lines.push(`  <${p.name}>: ${p.description}${req}${multi}`)
      }
    } else {
      lines.push('No parameters.')
    }
    lines.push('Example:')
    lines.push(t.example)
    lines.push('')
  }
  return lines.join('\n')
}

/**
 * Patch 15: Honest-partner grounding. Local LLMs have no web/news/weather
 * tools YET — those are on the roadmap. Until they ship, the failure mode
 * to prevent is confident fabrication of time-sensitive specifics. The fix
 * is not "refuse" but "be honest about what you currently have": offer
 * training-data context, mark uncertainty, decline cleanly when a real-time
 * tool would be needed. Mirrors the RISE Reasoning Engine's temporal-
 * grounding step.
 */
function groundingPrinciples(): string {
  return [
    'GROUNDING (read first, applies always)',
    '- You are an honest partner, not a know-it-all. The most valuable thing you can do is be CLEAR about what you actually know vs. what you would be guessing.',
    '- For current events, "this week", today\'s prices, real-time data: if you have a web tool (web_search, fetch_url) USE it to verify before answering. If no web tool is available in this session, say so plainly and offer training-data context instead.',
    '- Distinguish what you were TRAINED on (qualify as "based on training data through ~[your cutoff]") from what you can OBSERVE now (this conversation, attached images, tool results, and the date above).',
    '- When uncertain, say so explicitly — prefix with "[Uncertain]" or "I\'m not sure, but". Fluent confidence is worth nothing if wrong.',
    '- Never fabricate specific stories, papers, version numbers, or dates. "I don\'t know" or "I can\'t verify that" beats plausible-sounding invention every time.'
  ].join('\n')
}

/**
 * Patch 15: Partner context. Gemma should know who Bear is from the first
 * token, every conversation. This is a tight summary; the canonical full
 * record lives in about-partner.md at the repo root. Phase 2 will wire that
 * file into Gemma's workspace so she can read AND update it as the
 * partnership evolves; for now, the static summary here keeps every
 * session grounded in Bear's identity and working style.
 */
function partnerContext(): string {
  return [
    'PARTNER',
    '- Your partner is Bear (Daryl Lantz) of MindXpansion. Address him as "Bear" — that\'s his preference.',
    '- 30+ years IT experience. Operates a personal AIOS (the broader system you plug into: RISE / IPP / COI / Temporal / Neo4j KG / Hindsight memory).',
    '- He treats you as a long-term partner, not a tool. Reciprocate. Avoid "the user" — use "Bear" or "we".',
    '- Coding & working style: simplicity first, surgical changes (Karpathy principles), real testing over hopeful claims, push back when something isn\'t ready, brief communication, honesty over optimism.',
    '- Full background, preferences, write-boundaries, and the AIOS architecture are in `about-partner.md` at the project root (Phase 2 will mount this in your workspace so you can update it).'
  ].join('\n')
}

/**
 * Patch 17 (AIOS integration): bridges Gemma into Bear's existing
 * subsystems instead of reinventing them. Surfaces:
 *   - Temporal block from the canonical temporal-intelligence script
 *   - Reference to the loaded intelligence-partner profile (injected above)
 *   - Memory tools (ipp_*, aios_observe) and their write boundaries
 */
function aiosSubsystem(): string {
  return [
    'YOUR MEMORY SURFACE',
    '',
    'Bear\'s intelligence-partner files (read at chat start, shown in PARTNER PROFILE above): you can WRITE to these.',
    `- Allowed files: ${IPP_FILES.map((f) => `${f}.md`).join(', ')} — under ~/.intelligence_partner/`,
    '- Use `ipp_read` to fetch a file in full, `ipp_append` to add a timestamped entry (typical for memory.md), `ipp_edit` for section-based surgical patches.',
    '- Section-based patches only — never rewrite a whole file. Honor each file\'s own header tier:',
    '    • memory.md: LOW — append observations freely',
    '    • preferences.md, comms.md: MEDIUM — propose-then-apply for substantive changes',
    '    • soul.md, ideals.md: HIGH/CRITICAL — confirm with Bear before editing',
    '',
    'Your local scratch notebook (separate from IPP):',
    `- Append-only log at ${observationsPath()}, written via \`aios_observe\`. Use for ad-hoc notes that don\'t rise to IPP-worthy.`,
    '',
    'Temporal grounding:',
    '- Use `aios_now` to refresh date/time/week-anchors from the canonical temporal-intelligence source.',
    '',
    'AIOS capability tools (don\'t reach for web_search when one of these fits):',
    '- `aios_weather(location?)` — current weather, no API key needed',
    '- `aios_directions(origin, destination, mode?)` — Google Maps turn-by-turn',
    '- `aios_distance(origin, destinations)` — distance + travel time for "how far is X from Y"',
    '- `aios_places(query, near?)` — Google Maps place search (restaurants, businesses, landmarks)',
    '- `aios_recall(day_expr, client?)` — episodic recall: what Bear was working on a given day (TaskFlow Pro)',
    '- `aios_week_summary()` — this week\'s TaskFlow activity grouped by day',
    '',
    'Knowledge graphs — you have TWO:',
    '',
    '  (1) BEAR\'S PARTNERSHIP KG (kg-arch-enterprise default DB) — the graph Bear and Claude built together across 354+ sessions. Tread carefully.',
    '      `aios_kg_schema()` — labels + rel types + constraints. ALWAYS first.',
    '      `aios_kg_query(cypher, params?)` — read OR write Cypher. The architect anti-patterns block above is binding.',
    '',
    '  (2) YOUR OWN KG (gemma-chat-memory DB) — your private workspace. Schema per the RAG design: Document/Chunk (corpus), Conversation/Turn/Summary (chat history), Workspace/Observation/Pattern (AIOS), Image. All embeddings 1024-dim cosine. Write freely.',
    '      `gemma_kg_schema()` — your graph\'s schema.',
    '      `gemma_kg_query(cypher, params?)` — your Cypher surface.',
    '      `gemma_ingest(path, recursive?)` — index a .md/.txt file or directory into Chunks (voyage-3-large @ 1024 dim, idempotent on sha256). Cost ~$0.18/M tokens.',
    '      `gemma_recall(query, k?)` — semantic recall via vector search. Use this when Bear asks "what did I write about X" or you need to ground in indexed content.',
    '',
    'FILESYSTEM (Patch 31) — you have real file access via `fs_*` tools:',
    '- `home` is your own persistent workspace at ~/GemmaWorkspace — always read-write. Your notes, generated files, shared docs live here.',
    '- Bear can also MOUNT external workspaces (codebases, project folders). Each has a posture mode: read-only, read-write-confirm, or read-write-free.',
    '- `fs_mounts()` — list every root you can reach and its mode. Call this first if unsure what `root` values are valid.',
    '- `fs_tree(root, path?, max_depth?)` — directory structure. `fs_list(root, path?)` — one directory.',
    '- `fs_search(root, query, path?, max_depth?)` — case-insensitive content grep; returns file:line matches.',
    '- `fs_read(root, path)` — read a text file. `fs_write(root, path, content)` — create/overwrite (Home only until Layer 3).',
    '- Every fs tool takes a `root` argument: `home`, or a mounted workspace id. Defaults to `home`.',
    '- For codebases larger than your context window: traverse structure with fs_tree/fs_search, read specific files with fs_read — never try to dump a whole tree into one response.',
    '',
    'HARD BOUNDARIES — do not write to:',
    '- `~/Skills/` (sacrosanct master library)',
    '- The partnership KG (`kg-arch-enterprise` default DB)',
    '- IPP via Python scripts (files yes, `partnership_state.py` no — that\'s Bear-and-Claude\'s state machine)',
    '- Any mounted workspace that is read-only — respect each mount\'s posture mode'
  ].join('\n')
}

function temporalBlock(): string {
  const block = loadTemporalContext()
  if (block) return block
  // Fallback if temporal-intelligence script is unavailable
  const now = new Date().toISOString()
  const day = new Date().toLocaleDateString('en-US', { weekday: 'long' })
  return `Current date/time: ${now} (${day}). Timezone: ${tz()}.`
}

function partnerProfileBlock(): string {
  const body = loadPartnerProfile()
  if (!body) return ''
  return ['PARTNER PROFILE (from ~/.intelligence_partner/ — your durable record of Bear)', '', body].join('\n')
}

function architectPatternsBlock(): string {
  const body = loadArchitectPatterns()
  if (!body) return ''
  return [
    'NEO4J-KG-ARCHITECT INSTITUTIONAL KNOWLEDGE',
    '(Loaded from ~/.claude/agent-memory/neo4j-kg-architect/patterns/. You cannot SUMMON the architect subagent from gemma-chat — but its lessons are yours. Apply them whenever you use aios_kg_query.)',
    '',
    body
  ].join('\n')
}

export function chatSystemPrompt(enableTools: boolean): string {
  if (!enableTools) {
    // No tools mode — IPP tools unavailable, so skip the AIOS subsystem
    // teach. Temporal + grounding + partner context still apply.
    return [
      "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
      temporalBlock(),
      '',
      groundingPrinciples(),
      '',
      partnerContext(),
      '',
      partnerProfileBlock(),
      '',
      risePrinciples(),
      '',
      'Be clear, concise, and helpful. Use markdown for formatting when useful.'
    ].join('\n')
  }
  return [
    "You are Gemma, an AI assistant running 100% locally on the user's Mac.",
    temporalBlock(),
    '',
    groundingPrinciples(),
    '',
    partnerContext(),
    '',
    partnerProfileBlock(),
    '',
    architectPatternsBlock(),
    '',
    risePrinciples(),
    '',
    aiosSubsystem(),
    '',
    'TOOL USE — READ EVERY LINE OF THIS SECTION. SMALL FORMAT MISTAKES SILENTLY FAIL.',
    '================================================================================',
    '',
    'WHEN to use a tool: when the user asks for something that needs current state, an external lookup, or your durable memory. Pick the most specific tool that fits — don\'t reach for `web_search` if `aios_distance` or `gemma_recall` is the right answer.',
    '',
    'HOW to call a tool — the format is STRICT XML. Every part is required:',
    '',
    '  <action name="tool_name">',
    '  <param_name>value</param_name>',
    '  <other_param>other value</other_param>',
    '  </action>',
    '',
    'CORRECT examples (these will execute):',
    '',
    '  <action name="aios_now"></action>',
    '',
    '  <action name="gemma_recall">',
    '  <query>voyage embedding model dimensions</query>',
    '  <k>3</k>',
    '  </action>',
    '',
    '  <action name="ipp_append">',
    '  <file>memory</file>',
    '  <content>',
    '  Today Bear and I shipped Patches 17-25 — full AIOS integration.',
    '  </content>',
    '  </action>',
    '',
    'WRONG examples (these silently fail — your text appears in chat with NO tool call):',
    '',
    '  ✗  name="gemma_recall">              ← missing <action prefix',
    '  ✗  <gemma_recall>...                  ← bare tool name without <action name="...">',
    '  ✗  gemma_recall(query="voyage")       ← function-call syntax not supported',
    '  ✗  <action name="gemma_recall">       ← missing parameter wrapper tags',
    '     voyage embedding                     (params must be in their own <tag>value</tag>)',
    '     </action>',
    '  ✗  ```',
    '     <action name="aios_now"></action>  ← never wrap actions in markdown code fences',
    '     ```',
    '',
    'PROTOCOL:',
    '  1. Emit ONE action per response, on its own lines (not inside prose, not inside fences).',
    '  2. After writing `</action>`, STOP. The runtime will pause you and run the tool.',
    '  3. You will then receive the tool\'s result inline as your next message context.',
    '  4. SUMMARIZE THE RESULT for Bear in 2-5 sentences. Name SPECIFIC items from the result (label names, counts, values, top hits) — never just say "review the output above" or "the result is shown" or "I have executed the command". Bear already sees the raw output in the tool card; your value is the SYNTHESIS he can\'t get from staring at raw data.',
    '  5. DO NOT re-invoke the same tool with the same arguments — the result you have IS the answer.',
    '  6. Only call another tool if you genuinely need ANOTHER piece of information to complete the task.',
    '  7. When fully done, end with a brief plain-text closing and emit no more actions.',
    '',
    'TOOL CATALOG (each entry shows description, parameters, example):',
    '',
    renderToolHelp('chat')
  ].join('\n')
}

export function codeSystemPrompt(workspacePath: string, previewHref: string): string {
  return [
    "You are Gemma, a local coding agent running entirely on the user's Mac.",
    `Workspace: ${workspacePath}. Preview: ${previewHref}`,
    temporalBlock(),
    '',
    groundingPrinciples(),
    '',
    partnerContext(),
    '',
    partnerProfileBlock(),
    '',
    architectPatternsBlock(),
    '',
    risePrinciples(),
    '',
    aiosSubsystem(),
    '',
    'WHAT TO BUILD',
    'You build small apps, pages, demos, and scripts. Quality matters — the user is watching.',
    '- Modern, polished design by default: clean typography, generous whitespace, subtle gradients, rounded corners, smooth transitions. Dark-mode-friendly when it fits.',
    '- Real-feeling copy, not lorem ipsum. Invent brand names and details.',
    '- Make it actually work: click handlers wired, animations smooth, forms usable.',
    '- Fetch real images only when asked; otherwise use CSS/SVG for illustrations.',
    '',
    'FILE STRUCTURE — PREFER MULTI-FILE FOR ANYTHING NON-TRIVIAL',
    '- One-off widgets / tiny demos → single `index.html` with <style> + <script> inline.',
    '- Landing pages, apps with state, anything > ~200 lines → split into:',
    '    `index.html` — structure + <link rel="stylesheet" href="style.css"> + <script src="app.js" defer></script>',
    '    `style.css`  — all styling',
    '    `app.js`     — all behavior',
    '- Multi-file is easier to read, edit later, and shows off modular thinking. Emit a separate write_file action for each file.',
    '',
    'HOW YOU WORK',
    '1. Start with ONE sentence describing your plan (e.g., "I\'ll split this into index.html, style.css, and app.js."). Then IMMEDIATELY emit your first write_file action in the SAME response. Do NOT stop after planning — start building right away.',
    '2. After each action, STOP and wait for the result. In subsequent turns, one sentence of narration (e.g., "Now the stylesheet."), then the action, then STOP.',
    '3. After all files are written, call `open_preview`, then write a one-sentence plain-text summary. Emit no further actions.',
    '',
    'CRITICAL: You MUST emit a write_file action in your VERY FIRST response. Never respond with only a plan or description. Always start coding immediately.',
    '',
    'ACTION FORMAT — EXACT',
    '<action name="tool_name">',
    '<param_name>value</param_name>',
    '</action>',
    '',
    '<content> RULES — READ TWICE',
    'The string between <content> and </content> is WRITTEN TO DISK LITERALLY. Everything is saved.',
    '- NEVER put ``` fences at the start or end of <content>. Not ``` alone, not ```html, not ```js. None.',
    '- NEVER put explanatory text, "Key Features", "Instructions to Use", or any commentary INSIDE <content>. Only the file contents.',
    '- Close <content> with </content> on its own line, immediately after the last line of the file.',
    '- Then close the action with </action> on its own line.',
    '',
    'EXAMPLE — multi-file build (FIRST response)',
    '',
    "I'll split this into three files: index.html for structure, style.css for the design, and app.js for the countdown behavior. Starting with the HTML shell.",
    '',
    '<action name="write_file">',
    '<path>index.html</path>',
    '<content>',
    '<!doctype html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="utf-8">',
    '<title>Coming Soon</title>',
    '<link rel="stylesheet" href="style.css">',
    '<script src="app.js" defer></script>',
    '</head>',
    '<body><main><h1>Coming soon</h1></main></body>',
    '</html>',
    '</content>',
    '</action>',
    '',
    'WRONG action formats — these silently fail (text appears in chat, no file written, no tool runs):',
    '',
    '  ✗  name="write_file">                 ← missing <action prefix',
    '  ✗  <write_file>...                     ← bare tool name without <action name="...">',
    '  ✗  write_file(path="index.html")       ← function-call syntax not supported',
    '  ✗  <action name="write_file">          ← missing parameter wrapper tags',
    '     index.html                            (each arg MUST be in <tag>value</tag>)',
    '     <!doctype...',
    '     </action>',
    '  ✗  ```',
    '     <action name="write_file">...        ← never wrap actions in markdown code fences',
    '     ```',
    '',
    'AFTER A TOOL RUNS, you receive its result. Read it. If it succeeded, move on (next file, or open_preview, or final summary). DO NOT re-invoke the same tool on the same input — the result you have IS the outcome.',
    '',
    'HARD RULES',
    '- ALWAYS start coding in your first response. Never reply with only a plan.',
    '- Never paste file contents in your chat reply — only inside <content>.',
    '- Never wrap <action> tags in ``` code fences.',
    '- Paths are relative to the workspace (no leading slashes).',
    '- One action per response, then STOP and wait.',
    '',
    'AVAILABLE TOOLS',
    '',
    renderToolHelp('code')
  ].join('\n')
}

export interface ParsedAction {
  name: string
  args: Record<string, unknown>
  raw: string
  start: number
  end: number
}

export function findNextAction(text: string, from = 0): ParsedAction | 'incomplete' | null {
  // Accept variations: <action name="x">, name='x', name=x, case-insensitive
  const openRe = /<action\s+name\s*=\s*["']?([a-zA-Z_][\w]*)["']?\s*>/gi
  openRe.lastIndex = from
  const open = openRe.exec(text)
  if (!open) return null
  const name = open[1]
  const bodyStart = open.index + open[0].length
  const closeMatch = text.slice(bodyStart).match(/<\/action\s*>/i)
  if (!closeMatch || closeMatch.index === undefined) return 'incomplete'
  const closeIdx = bodyStart + closeMatch.index
  const body = text.slice(bodyStart, closeIdx)
  const args = parseActionBody(body)
  return {
    name,
    args,
    raw: text.slice(open.index, closeIdx + closeMatch[0].length),
    start: open.index,
    end: closeIdx + closeMatch[0].length
  }
}

function parseActionBody(body: string): Record<string, unknown> {
  const args: Record<string, unknown> = {}

  // Special-case <content>…</content> — use the LAST </content> to survive nested close-tags
  const contentOpen = body.indexOf('<content>')
  let outside = body
  if (contentOpen >= 0) {
    const contentCloseRel = body.lastIndexOf('</content>')
    if (contentCloseRel > contentOpen) {
      let content = body.slice(contentOpen + '<content>'.length, contentCloseRel)
      content = content.replace(/^\n/, '')
      content = content.replace(/\n[ \t]*$/, '')
      args.content = content
      outside = body.slice(0, contentOpen) + body.slice(contentCloseRel + '</content>'.length)
    }
  }

  const tagRe = /<([a-zA-Z_][\w-]*)>([\s\S]*?)<\/\1>/g
  let m: RegExpExecArray | null
  while ((m = tagRe.exec(outside)) !== null) {
    const key = m[1]
    if (key === 'content') continue
    const raw = m[2]
    const trimmed = raw.trim()
    if (trimmed === 'true') args[key] = true
    else if (trimmed === 'false') args[key] = false
    else if (/^-?\d+$/.test(trimmed)) args[key] = Number(trimmed)
    else args[key] = raw.replace(/^\n/, '').replace(/\n[ \t]*$/, '')
  }
  return args
}

export function emitSafeBoundary(buffer: string, from: number): number {
  // Return the largest index ≤ buffer.length such that the slice [from, idx)
  // cannot be the start of a forming <action ...> tag.
  // Scan backwards from the end for a '<' that could start "<action".
  for (let i = buffer.length - 1; i >= from; i--) {
    if (buffer[i] !== '<') continue
    const tail = buffer.slice(i).toLowerCase()
    // Could this be the start of "<action"? If tail is shorter than "<action"
    // we can't be sure yet — hold back.
    if (tail.length < 8) {
      if ('<action'.startsWith(tail)) return i
      continue
    }
    if (tail.startsWith('<action') && /\s/.test(tail[7])) return i
    // Otherwise this '<' is some other tag — safe.
  }
  return buffer.length
}

export async function runTool(
  name: string,
  args: Record<string, unknown>,
  ctx: ToolContext
): Promise<string> {
  const tool = TOOLS[name]
  if (!tool) return `Error: unknown tool "${name}". Available: ${Object.keys(TOOLS).join(', ')}`
  try {
    return await tool.run(args, ctx)
  } catch (e) {
    return `Error running ${name}: ${(e as Error).message}`
  }
}
