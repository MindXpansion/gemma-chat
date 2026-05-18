# SOTA Electron Security & Skills/Tools/CLI Architecture for Gemma Chat (2026)

> **Doc role:** Forward-looking research and recommendation document.
> **Scope:** Two questions — (1) what does state-of-the-art Electron desktop security look like in 2026, and (2) what is the right Skills/tools/CLI integration architecture for a local-AI agent app like Gemma Chat?
> **Authored:** 2026-05-17 (Bear + Claude)
> **Companion to:** `docs/gemma-chat-app-design.md` (the 9-section forensic audit). This doc takes the current architecture as given (see "Current State Recap" below) and recommends what to change, with citations.
> **Citation discipline:** Every concrete claim links to an upstream source (electronjs.org, anthropic.com, ai-sdk.dev, modelcontextprotocol.io, GitHub repos, or vendor blog posts). Where there is no canonical source, the claim is flagged as opinion.

---

## Table of Contents

- [0. Current State Recap (taken as given)](#0-current-state-recap-taken-as-given)
- [1. SOTA Electron Desktop Security in 2026](#1-sota-electron-desktop-security-in-2026)
  - [1.1 Electron Fuses](#11-electron-fuses)
  - [1.2 ASAR Integrity Checking](#12-asar-integrity-checking)
  - [1.3 IPC Validation: typed, schema-checked channels](#13-ipc-validation-typed-schema-checked-channels)
  - [1.4 safeStorage for secrets](#14-safestorage-for-secrets)
  - [1.5 Process model: should sandbox become true?](#15-process-model-should-sandbox-become-true)
  - [1.6 Content Security Policy — tightest reasonable](#16-content-security-policy--tightest-reasonable)
  - [1.7 macOS hardening: notarization, hardened runtime, entitlements](#17-macos-hardening-notarization-hardened-runtime-entitlements)
  - [1.8 Sandboxing subprocesses (run_bash hardening)](#18-sandboxing-subprocesses-run_bash-hardening)
  - [1.9 Auto-update: electron-updater in 2026](#19-auto-update-electron-updater-in-2026)
  - [1.10 Other 2026 hygiene](#110-other-2026-hygiene)
- [2. Skills / Tools / CLI Integration Patterns](#2-skills--tools--cli-integration-patterns)
  - [2.1 The Anthropic Agent SDK as a design source](#21-the-anthropic-agent-sdk-as-a-design-source)
  - [2.2 Agent Skills: the canonical Skills format](#22-agent-skills-the-canonical-skills-format)
  - [2.3 Model Context Protocol (MCP) status in 2026](#23-model-context-protocol-mcp-status-in-2026)
  - [2.4 Consuming MCP servers from a Gemma-driven agent](#24-consuming-mcp-servers-from-a-gemma-driven-agent)
  - [2.5 Vercel AI SDK — tool definition patterns](#25-vercel-ai-sdk--tool-definition-patterns)
  - [2.6 LangChain JS / LangGraph](#26-langchain-js--langgraph)
  - [2.7 Custom JSON-RPC / LSP-style skill protocol](#27-custom-json-rpc--lsp-style-skill-protocol)
  - [2.8 CLI integration with user-visible approval](#28-cli-integration-with-user-visible-approval)
- [3. Concrete Recommendations for Gemma Chat](#3-concrete-recommendations-for-gemma-chat)
  - [3.1 IPC validation pattern to retrofit](#31-ipc-validation-pattern-to-retrofit)
  - [3.2 Skills loader architecture — start simple, grow into MCP](#32-skills-loader-architecture--start-simple-grow-into-mcp)
  - [3.3 run_bash hardening — what to actually do](#33-run_bash-hardening--what-to-actually-do)
  - [3.4 Filesystem-access approval UX](#34-filesystem-access-approval-ux)
- [4. Phased adoption plan](#4-phased-adoption-plan)
- [5. Sources](#5-sources)

---

## 0. Current State Recap (taken as given)

The 9-section audit (`docs/gemma-chat-app-design.md`) establishes the baseline. Restating only what this research depends on:

- **Stack:** Electron 34, React 19, TypeScript 5.7, Vite 6.
- **Process model:** main (Node) + preload (`contextBridge`) + renderer (Chromium).
- **webPreferences:** `contextIsolation: true`, `nodeIntegration: false`, **`sandbox: false`**, CSP set via meta tag in `index.html`.
- **IPC:** 12 `ipcMain.handle` channels, 5 outbound, **no per-channel schema validation**, **no per-tool user approval**.
- **Tools:** flat `TOOLS` registry in `src/main/tools.ts` with 10 hardcoded tools; agent emits `<action name="...">` XML during streaming; `runTool(name, args, ctx)` dispatches.
- **Workspace ops:** path-bounded to per-conversation directories.
- **`run_bash`:** gated only by a six-pattern regex deny-list. Known-inadequate.

The research below assumes the reader is familiar with these facts.

---

## 1. SOTA Electron Desktop Security in 2026

### 1.1 Electron Fuses

**What they are.** Fuses are package-time bits flipped into the Electron binary that the OS-level code signature then locks in place; the OS prevents them from being flipped back at runtime. Per the Electron docs, fuses exist so you can "disable certain unused Electron features that are powerful but may make your app's security posture weaker" — e.g., disabling `ELECTRON_RUN_AS_NODE` to prevent a class of "living off the land" attacks against your signed binary [[electronjs.org/fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)].

**Every current fuse and the secure default for Gemma Chat:**

| Fuse | Current default | Secure default | Why it matters for Gemma Chat |
|---|---|---|---|
| `runAsNode` | enabled | **disabled** | Stops attackers who get code-exec on the box from re-launching the signed Electron binary as a Node shell to bypass signature checks. Gemma Chat does not use `child_process.fork` from the main process for anything we control. |
| `cookieEncryption` | disabled | **enabled** | Encrypts the on-disk cookie store with OS-level keys (DPAPI/Keychain). We don't currently rely on cookies, but enabling costs nothing. |
| `nodeOptions` | enabled | **disabled** | Prevents `NODE_OPTIONS`/`NODE_EXTRA_CA_CERTS` from injecting code via env vars. |
| `nodeCliInspect` | enabled | **disabled** | Disables `--inspect` and SIGUSR1 debugger attach in production. |
| `embeddedAsarIntegrityValidation` | disabled | **enabled** | Forces ASAR contents to match a build-time hash; prevents tampering with `app.asar`. Pairs with `onlyLoadAppFromAsar`. |
| `onlyLoadAppFromAsar` | disabled | **enabled** | Without it, attackers can drop an `app/` directory next to `app.asar` and bypass the integrity check by exploiting Electron's search order. |
| `loadBrowserProcessSpecificV8Snapshot` | disabled | **enabled** | Uses separate V8 snapshot for the main process so a renderer can't be tricked into running with a snapshot built with `nodeIntegration` semantics. |
| `grantFileProtocolExtraPrivileges` | enabled | **disabled** | We use `file://` for the renderer entrypoint. Disabling this *can* break things; needs a smoke test in dev. |
| `wasmTrapHandlers` | enabled | platform-dependent | Leave default. |

Sources: [electronjs.org/fuses](https://www.electronjs.org/docs/latest/tutorial/fuses), [github.com/electron/fuses](https://github.com/electron/fuses), and the per-fuse table compiled from the Electron docs page itself.

**How to configure via electron-builder.** electron-builder ships first-class support for fuses through the `electronFuses` config key, which wraps `@electron/fuses` [[electron.build/adding-electron-fuses](https://www.electron.build/tutorials/adding-electron-fuses.html), [electron.build/FuseOptionsV1](https://www.electron.build/app-builder-lib.Interface.FuseOptionsV1.html)]. In `electron-builder.yml` (or `package.json#build`):

```yaml
electronFuses:
  runAsNode: false
  enableCookieEncryption: true
  enableNodeOptionsEnvironmentVariable: false
  enableNodeCliInspectArguments: false
  enableEmbeddedAsarIntegrityValidation: true
  onlyLoadAppFromAsar: true
  loadBrowserProcessSpecificV8Snapshot: true
  grantFileProtocolExtraPrivileges: false
  resetAdHocDarwinSignature: true   # required on Apple Silicon if not immediately re-signing
  strictlyRequireAllFuses: true     # hard-fail builds if Electron adds a fuse we forgot
```

The `strictlyRequireAllFuses: true` setting [[electron.build/FuseOptionsV1](https://www.electron.build/app-builder-lib.Interface.FuseOptionsV1.html)] is the discipline that prevents Electron version bumps from silently leaving new fuses unset.

**Verification.** `npx @electron/fuses read --app /Applications/Gemma\ Chat.app` prints the current fuse state in a built artifact [[github.com/electron/fuses](https://github.com/electron/fuses)]. This should be wired into CI as a post-build assertion.

**Apple Silicon footgun.** Flipping fuses invalidates the ad-hoc darwin signature on arm64. If you flip fuses and don't immediately re-sign, the app refuses to launch. Either pass `resetAdHocDarwinSignature: true` to `flipFuses` (electron-builder exposes this) or sign in the same build step [[electronjs.org/fuses](https://www.electronjs.org/docs/latest/tutorial/fuses)].

---

### 1.2 ASAR Integrity Checking

ASAR integrity is a hash-validation feature: at build time, electron-builder writes a SHA-256 hash of the ASAR header into the app's Info.plist (macOS) or PE resource (Windows); at runtime, Electron validates the archive's contents against that hash and forcefully terminates on mismatch [[electronjs.org/asar-integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)].

**Key facts:**
- Disabled by default — gated by the `embeddedAsarIntegrityValidation` fuse [[electronjs.org/asar-integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)].
- Requires `@electron/asar >= 3.1.0` to generate hash-bearing ASARs [[electronjs.org/asar-integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)].
- Must be paired with `onlyLoadAppFromAsar` — otherwise Electron's app search path lets an attacker drop an `app/` directory next to `app.asar` and bypass the check [[electronjs.org/asar-integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity)].
- Electron Forge and Electron Packager set this up automatically when ASAR is enabled; electron-builder requires the fuse config above.

**Known bypass.** GHSA-vmqv-hx8q-j7mg documented a way to bypass ASAR integrity via resource modification on macOS by tampering with files outside `app.asar` that the loader trusts [[github.com/electron/electron/security/advisories/GHSA-vmqv-hx8q-j7mg](https://github.com/electron/electron/security/advisories/GHSA-vmqv-hx8q-j7mg)]. Fixed in current Electron. Stay on a supported major version (recommendation §1.10).

**For Gemma Chat:** enable both fuses; treat any startup failure as a security event, not a packaging bug.

---

### 1.3 IPC Validation: typed, schema-checked channels

The current code has 12 `ipcMain.handle` channels with no runtime validation. Electron's own security checklist now lists "Validate the Sender of All IPC Messages" as recommendation #17: every handler should check `event.senderFrame.url` against an allowlist *and* validate arguments with a schema [[electronjs.org/security](https://www.electronjs.org/docs/latest/tutorial/security)].

**The 2026 consensus pattern: hand-rolled Zod validators in a thin IPC wrapper.**

Why not `electron-trpc`? It exists ([github.com/jsonnull/electron-trpc](https://github.com/jsonnull/electron-trpc)) and is genuinely ergonomic — full tRPC routers across the IPC boundary with inferred client types and Zod validators baked in. But a December 2025 analysis raises real concerns: every call gets SuperJSON-serialized twice, routed through the router tree, and serialized back, which is "a performance tax" for the simple getter/setter calls that dominate most apps [[seedteamtalks: The Case Against electron-trpc](https://seedteamtalks.hyper.media/tech-talks/the-case-against-electron-trpc-when-type-safety-becomes-a-performance-tax?v=bafy2bzaceaynzyohje7w7n645rvkkl6uzkigyissdbqrs3hipycwm5yoaasvu)]. For Gemma Chat's mix — streaming token chunks (high-frequency), short tool calls (low-frequency), and dialog/file ops (occasional) — the SuperJSON overhead on the streaming path would be measurable.

The middle road most production Electron apps land on in 2026:

```ts
// src/main/ipc/define.ts
import { z, ZodSchema } from 'zod';
import { ipcMain, IpcMainInvokeEvent } from 'electron';

export function defineHandler<I extends ZodSchema, O>(
  channel: string,
  schema: I,
  fn: (input: z.infer<I>, event: IpcMainInvokeEvent) => Promise<O>,
) {
  ipcMain.handle(channel, async (event, rawInput) => {
    // 1) sender allowlist — only trust our own renderer
    const url = event.senderFrame?.url ?? '';
    if (!isTrustedSender(url)) throw new Error(`untrusted sender: ${url}`);
    // 2) schema validation — reject anything off-contract
    const parsed = schema.safeParse(rawInput);
    if (!parsed.success) throw new Error(`bad input on ${channel}: ${parsed.error.message}`);
    // 3) call the handler with typed input
    return fn(parsed.data, event);
  });
}
```

This pattern:
- gives full TypeScript inference at the call site (the `defineHandler` generic flows `z.infer` into `fn`);
- enforces Electron security recommendation #17 (sender validation) **and** #20 (don't expose raw IPC) in one place;
- is monitorable — you can wrap with metrics/audit logging without touching every handler;
- has zero SuperJSON overhead for the streaming path;
- aligns with the AI SDK's own direction — v5 explicitly aligned tool definitions with MCP by renaming `parameters` → `inputSchema` to make "schema-validated input" the central concept [[Vercel AI SDK 5 migration](https://www.pkgpulse.com/guides/vercel-ai-sdk-5-migration-2026), [ai-sdk.dev/foundations/tools](https://ai-sdk.dev/docs/foundations/tools)].

**The Electron team's own missing piece.** Issue [#33517](https://github.com/electron/electron/issues/33517) tracks the request to allow centralized IPC validation; until that lands, the wrapper above is the canonical pattern.

**Recommendation finalized in §3.1.**

---

### 1.4 safeStorage for secrets

Electron's `safeStorage` opportunistically encrypts strings using OS-level facilities: DPAPI on Windows, Keychain on macOS, and (on Linux) one of `kwallet`, `kwallet5`, `kwallet6`, or `gnome-libsecret` [[electronjs.org/safe-storage](https://www.electronjs.org/docs/latest/api/safe-storage)].

**Gotchas, all from the official docs:**
- On Linux, when no secret store is available, `safeStorage` silently falls back to encryption with a *hardcoded plaintext password*. Check `safeStorage.getSelectedStorageBackend()` and refuse to store secrets if it returns `'basic_text'` [[electronjs.org/safe-storage](https://www.electronjs.org/docs/latest/api/safe-storage)].
- On macOS, the *first* call may block the main thread waiting for Keychain user input. Initialize on `app.whenReady()`, off the hot path.
- Use the async variants (`encryptString` / `decryptString` since 2024) when you can — they support key-rotation signaling (`shouldReEncrypt`) and `isTemporarilyUnavailable` for the macOS Keychain-locked case.

**Reference implementation:** Signal Desktop's PR [#6849](https://github.com/signalapp/Signal-Desktop/pull/6849) wraps the database encryption key in `safeStorage`. That's the model.

**For Gemma Chat today:** there are no remote API keys (Gemma runs locally via MLX). But we should already be using `safeStorage` for: the future auto-update signing public key fingerprint (if user-overridable), any per-skill credentials a user installs (e.g., a `gh` token for a GitHub skill), and the Hugging Face token used for model downloads. The latter is the immediate actionable one — it's likely sitting in `~/.cache/huggingface/token` in plaintext today.

---

### 1.5 Process model: should sandbox become true?

**Current state:** `sandbox: false`. This was true upstream and we inherited it.

**Default since Electron 20:** `sandbox: true` is the default; we've explicitly turned it off [[electronjs.org/security](https://www.electronjs.org/docs/latest/tutorial/security) recommendation #4].

**What enabling sandbox actually constrains:** the renderer process runs in the Chromium sandbox (seccomp-bpf on Linux, App Sandbox on macOS, integrity-level-low on Windows). The renderer can no longer make raw syscalls; everything must go through the main process. This is the single biggest defense-in-depth win against a renderer-side RCE — which for an AI chat app is the threat to worry about (LLM output is, by construction, untrusted content rendered in the renderer).

**What it breaks for us:**
- The preload script gets a *sandboxed* environment: only `require()` of a polyfilled subset is available; no `require('fs')`, no `require('child_process')`, no full Node API [[electronjs.org/tutorial-preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)].
- "From Electron 20 onwards, preload scripts are sandboxed by default and no longer have access to a full Node.js environment" [[electronjs.org/tutorial-preload](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload)].
- `@electron-toolkit/preload` is designed to work in a sandboxed preload — it only exposes `ipcRenderer`, `webFrame`, and a curated `process` shim, all of which are available in the sandboxed environment [[npmjs.com/@electron-toolkit/preload](https://www.npmjs.com/package/@electron-toolkit/preload)].
- "Sandboxed preload scripts only support CommonJS (`require()`); use a bundler if you need external npm modules or modern ES syntax" [[copyprogramming.com Electron 2026 Guide](https://copyprogramming.com/howto/electron-unable-to-load-preload-script-resources-app-asar-src-preload-js)].

**Audit our preload:** if our preload does anything other than `contextBridge.exposeInMainWorld('api', { invoke: ipcRenderer.invoke, on: ipcRenderer.on, ... })`, that work needs to move to the main process behind a new IPC channel.

**Recommendation:** flip `sandbox: true`. The cost is one preload-audit task and possibly bundling the preload through Vite's preload entry (`electron-vite` handles this out of the box). The benefit is full Chromium sandbox on the renderer, which is the single largest defensive change available.

---

### 1.6 Content Security Policy — tightest reasonable

**Current state:** CSP is set via a `<meta http-equiv="Content-Security-Policy">` tag in `index.html`. This is the pragmatic Electron pattern because there's no HTTP server to set headers [[content-security-policy.com/electron](https://content-security-policy.com/examples/electron/), [blog.coding.kiwi/electron-csp-local](https://blog.coding.kiwi/electron-csp-local/)].

**Meta-tag limits you must know:** "you can specify a http-equiv meta tag for CSP and almost everything is still supported … you will not be able to use framing protections, sandboxing [the CSP `sandbox` directive], or a CSP violation logging endpoint" [[content-security-policy.com/meta](https://content-security-policy.com/examples/meta/)]. The `frame-ancestors` and `report-uri` directives are ignored when set via meta.

**For an Electron app with iframes, the practical "tightest reasonable" policy:**

```html
<meta http-equiv="Content-Security-Policy" content="
  default-src 'none';
  script-src 'self';
  style-src 'self' 'unsafe-inline';
  img-src 'self' data: blob:;
  font-src 'self' data:;
  media-src 'self' blob:;
  connect-src 'self' http://127.0.0.1:11437;
  worker-src 'self' blob:;
  child-src 'self';
  frame-src 'self';
  object-src 'none';
  base-uri 'none';
  form-action 'none';
">
```

Notes:
- `default-src 'none'` is the "deny everything" base, then explicit allowances — the OWASP-recommended strict pattern [[OWASP CSP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)].
- `connect-src` must include the MLX server endpoint (`127.0.0.1:11437` per the patch in `mlx.ts`). Tighten the host:port to what we actually use; do not use `*`.
- `'unsafe-inline'` for styles is a Vite/React reality; eliminating it requires nonces or hashes, which is a bigger lift. Inline scripts are not allowed — `script-src 'self'` blocks them.
- `'unsafe-eval'` is **not** in this policy. If Vite's dev server complains about it, that's a dev-only issue; production must not include it [[xjavascript: CSP blocks eval in Electron](https://www.xjavascript.com/blog/content-security-policy-of-your-site-blocks-the-use-of-eval-in-javascript-warning-when-setting-csp-meta-tag-in-electron/)].

**For frame-ancestors and reporting,** add an HTTP-header CSP via `session.defaultSession.webRequest.onHeadersReceived` for any `protocol.handle()`-served custom protocol responses. The meta-tag CSP and the header CSP combine via intersection.

---

### 1.7 macOS hardening: notarization, hardened runtime, entitlements

For distribution outside the Mac App Store, the required posture is:
- Developer ID Application certificate + notarization (`xcrun notarytool submit` or `@electron/notarize`) [[github.com/electron/notarize](https://github.com/electron/notarize), [electronjs.org/code-signing](https://www.electronjs.org/docs/latest/tutorial/code-signing)].
- `hardenedRuntime: true` in the electron-builder `mac` config — required for notarization [[ramielcreations: Sign and notarize MacOS electron app](https://www.ramielcreations.com/macos-github-app-build)].

**Minimum entitlements** for an Electron app under hardened runtime [[ramielcreations](https://www.ramielcreations.com/macos-github-app-build), [kilianvalkhof: Notarizing your Electron application](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/)]:

```xml
<!-- assets/entitlements.mac.plist -->
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
  <key>com.apple.security.cs.allow-jit</key><true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key><true/>
  <!-- Add only if Gemma Chat spawns Python/MLX as a child process: -->
  <key>com.apple.security.cs.disable-library-validation</key><true/>
  <!-- Add only if the agent runs subprocesses that load .dylibs not signed by us: -->
  <key>com.apple.security.cs.allow-dyld-environment-variables</key><false/>
</dict></plist>
```

The two JIT entitlements are mandatory for V8 [[ramielcreations](https://www.ramielcreations.com/macos-github-app-build)]. `disable-library-validation` is the one that lets us spawn Python/MLX as a subprocess loading frameworks that aren't signed by our Team ID — required because MLX ships with `mlx-vlm`'s Python bindings.

`electron-builder.yml` mac section:

```yaml
mac:
  category: public.app-category.developer-tools
  hardenedRuntime: true
  gatekeeperAssess: false
  entitlements: assets/entitlements.mac.plist
  entitlementsInherit: assets/entitlements.mac.plist
  notarize: true   # delegates to @electron/notarize (uses APPLE_ID/APPLE_APP_SPECIFIC_PASSWORD/APPLE_TEAM_ID or APPLE_API_KEY)
```

**2026 cert lifespan change.** "Starting February 15, 2026, code signing certificate lifespans are limited to a maximum of one year" [[signmycode: How to Code Sign an Electron.js App](https://signmycode.com/resources/how-to-code-signing-an-electron-js-app-for-macos)]. Plan for an annual rotation cycle.

---

### 1.8 Sandboxing subprocesses (run_bash hardening)

This is the largest unaddressed risk in the audit. The current six-pattern regex deny-list on `run_bash` is inadequate by construction (regex-based command parsing cannot defend against shell metacharacters; that's a 40-year-old result).

**Option A: `sandbox-exec` — deprecated but still functional.** macOS's `sandbox-exec` wraps `sandbox_init(3)` and applies a Scheme-DSL profile to a subprocess [[igorstechnoclub: sandbox-exec](https://igorstechnoclub.com/sandbox-exec/), [jmmv.dev: A quick glance at macOS' sandbox-exec](https://jmmv.dev/2019/11/macos-sandbox-exec.html)]. A deny-by-default profile (allow file-read on the workspace dir, deny network, deny process-exec except a small allowlist) is the kind of mitigation we want.

The problem: `sandbox-exec` is officially deprecated. Apple's man page recommends "App Sandbox" instead, but App Sandbox is for MAS-distributed GUI apps and requires the `com.apple.security.app-sandbox` entitlement and an Xcode project — it's not a drop-in replacement for sandboxing arbitrary subprocesses [[apple/containerization #737](https://github.com/apple/containerization/issues/737), [openai/codex #215](https://github.com/openai/codex/issues/215)]. As of early 2026, "sandbox-exec remains functional despite its deprecated status, and the situation continues to be a frustration point for developers who need sandboxing capabilities for command-line and server-side processes." Many production tools (OpenAI Codex, Homebrew via `alcoholless`) still use it.

A reasonable profile fragment for `run_bash` in a per-conversation workspace:

```scheme
(version 1)
(deny default)
(allow process-fork)
(allow signal (target self))
(allow file-read* (subpath "/usr/lib") (subpath "/System") (subpath "/private/etc"))
(allow file-read* (subpath "<WORKSPACE_DIR>"))
(allow file-write* (subpath "<WORKSPACE_DIR>"))
(deny network*)              ; tools that need network are explicit, not bash
(allow process-exec (literal "/bin/sh") (literal "/bin/bash") (literal "/usr/bin/env")
                    (literal "/usr/bin/grep") (literal "/usr/bin/awk")
                    (literal "/usr/bin/sed") (literal "/usr/bin/cat")
                    (literal "/usr/bin/jq")  (literal "/usr/bin/git"))
```

`sandbox-exec` passes env vars by default; we must scrub the environment before invocation [[jmmv.dev](https://jmmv.dev/2019/11/macos-sandbox-exec.html)].

**Option B: Replace `run_bash` with a curated set of per-CLI tools.** Instead of one `run_bash`, ship `run_grep`, `run_jq`, `run_git`, `run_gh`, etc., each with a typed Zod schema for its arguments. The agent loses the freedom to compose pipelines but gains real validation. This is the pattern Anthropic's own Agent SDK pushes — "Tools should represent primary, frequent actions" and well-designed tools "maximize context efficiency by being prominent" [[Anthropic: Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)].

**Option C: Containerization.** Docker-in-Electron is feasible but kills the "single-binary download" UX and adds 2 GB to the install. macOS 26's new "containers" feature may eventually be a replacement for `sandbox-exec` for headless processes; not yet production-ready.

**Recommendation pursued in §3.3:** B+A combined — the default surface area is curated typed tools (Option B); a *gated* `run_bash` survives behind a sandbox-exec profile (Option A) and a per-invocation user approval dialog (the audit's missing approval primitive).

---

### 1.9 Auto-update: electron-updater in 2026

`electron-updater` is still the right default — it's the default that ships with electron-builder and supports GitHub Releases, S3, Azure Blob, and generic HTTP backends [[electron.build/auto-update](https://www.electron.build/auto-update.html), [github.com/electron-userland/electron-builder](https://github.com/electron-userland/electron-builder)]. Differential updates work on NSIS for Windows.

**The 2026 threat model.** Doyensec's February 2026 deep-dive identified four classes of attack that default `electron-updater` does not fully address [[blog.doyensec.com: Building a Secure Electron Auto-Updater](https://blog.doyensec.com/2026/02/16/electron-safe-updater.html)]:
1. **Downgrade attacks** — serving an older vulnerable version via manifest manipulation.
2. **Integrity violations** — tampering with binaries during distribution.
3. **Race conditions** — replacing verified files between verification and install on multi-user systems.
4. **Untested version installation** — production deploying an alpha-signed build because signing keys aren't environment-separated.

Doyensec's recommended posture is a "SafeUpdater" pattern: Ed25519 signing of every artifact *and* the manifest, SHA-512 binary hashes, embedded public key for verification, and explicit cryptographic key separation between dev/prod environments [[doyensec](https://blog.doyensec.com/2026/02/16/electron-safe-updater.html)].

**Alternatives surveyed:**
- **Tauri's updater** — built-in, similar feature set, but switching from Electron is a separate decision [[openreplay: Comparing Electron and Tauri](https://blog.openreplay.com/comparing-electron-tauri-desktop-applications/)].
- **Update servers:** Hazel (free Vercel deployment), Nuts (disk-cached + private repos), Nucleus (Atlassian, multi-app + channels), electron-release-server (dashboard, no GitHub) [[electron.build/auto-update](https://www.electron.build/auto-update.html)].
- **Windows code signing:** Azure Trusted Signing is "Microsoft's modern cloud-based alternative to EV certificates and is the cheapest option for code signing on Windows as of October 2025." Use it for Windows artifacts.

**For Gemma Chat:** stay on `electron-updater` with GitHub Releases as the backend, add manifest signature verification on top (the SafeUpdater pattern), separate dev/prod signing keys.

---

### 1.10 Other 2026 hygiene

The Electron security checklist [[electronjs.org/security](https://www.electronjs.org/docs/latest/tutorial/security)] has 20 items. We've covered the load-bearing ones. The remaining items we should explicitly assert:

- **#5 Permission handlers.** Wire `session.defaultSession.setPermissionRequestHandler` to deny everything we don't actively need (camera, microphone, geolocation, notifications, midi, persistent-storage). The renderer should never ask for any of these.
- **#13 Navigation limits.** Handle `will-navigate` on every webContents; deny anything that isn't our app's own origin.
- **#14 New-window limits.** Register `webContents.setWindowOpenHandler` to deny all popups; route any legitimate external-link click through `shell.openExternal` with URL allowlisting.
- **#15 `shell.openExternal`** — validate the URL (must be `https:` or `http:`; never `file:`, `javascript:`, custom protocol handlers).
- **#16 Current Electron.** We're on 34. Electron's support window covers the latest three majors; bumping to current is operational hygiene.
- **#18 Custom protocol over `file:`.** Long-term, replace the `file://` renderer entry with `protocol.handle('app://', ...)` and load `app://index.html`. This is the Electron-canonical way to get tighter CSP and origin semantics. Requires the renderer to be served by us, not the OS file URL loader.

---

## 2. Skills / Tools / CLI Integration Patterns

### 2.1 The Anthropic Agent SDK as a design source

Even though we don't use Claude as the model, Anthropic's Agent SDK design notes are the single most coherent statement of how to build a tool-using agent loop. The core principles, from Anthropic's engineering post [[claude.com: Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)]:

- **The loop:** "gather context → take action → verify work → repeat." The verify step is what distinguishes agents from one-shot tool callers.
- **Tools are the primary building blocks.** "Tools should represent primary, frequent actions"; they "maximize context efficiency by being prominent in the model's context window."
- **Context management is its own concern.** Agentic search (`grep`, `tail` style), subagents with isolated context windows that "only send relevant information back," and compaction as context fills.
- **Verification patterns:** rules-based (linting), visual (screenshots), or LLM-as-judge. "Give Claude concrete ways to evaluate its work."
- **"Give your agents a computer."** Filesystem access, bash, code execution — the same primitives a human developer uses.

**Mapped to Gemma Chat today:**

| Anthropic principle | Gemma Chat today | Gap |
|---|---|---|
| gather→act→verify loop | gather + act exist; verify is absent | Add a verification primitive — at minimum, the agent should be told "after running a tool, summarize whether the result was what you expected." Optionally an LLM-as-judge subagent step. |
| Tools as primary actions | 10 flat tools, XML-tagged dispatch | Schemas are JS objects, not validated. Migrate to Zod-defined tools matching the AI SDK shape (see §2.5). |
| Context management | Linear chat history | No agentic search, no subagents, no compaction. Out of scope for v0.2; on the roadmap. |
| Skills as progressive disclosure | None | This is the headline addition — see §3.2. |
| "Give your agents a computer" | Workspace dir + `run_bash` | Direction is correct; safety is not. See §3.3. |

**On managed agents.** The Agent SDK supports a hybrid where you prototype locally and migrate hot paths to "Managed Agents" — a hosted REST API where Anthropic runs the loop and sandbox [[anthropics/skills: managed-agents-overview](https://github.com/anthropics/skills/blob/main/skills/claude-api/shared/managed-agents-overview.md), [augmentcode: Anthropic Agent SDK guide](https://www.augmentcode.com/guides/anthropic-agent-sdk-what-ships-vs-what-you-build)]. Not directly applicable to Gemma Chat (we're explicitly running the model locally), but the *architecture* of separating "agent loop" from "tool registry" is the lesson — the loop should be cleanly extractable.

---

### 2.2 Agent Skills: the canonical Skills format

Anthropic's Skills format is the most thoughtful filesystem-based skills design in production. We should adopt it as our format. Key facts from the Claude API docs [[platform.claude.com: Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)]:

**SKILL.md structure:**

```yaml
---
name: pdf-processing            # max 64 chars, lowercase + digits + hyphens, no XML, no reserved words ("anthropic","claude")
description: Extract text and tables from PDF files, fill forms, merge documents. Use when working with PDF files or when the user mentions PDFs, forms, or document extraction.
# description: max 1024 chars, non-empty, no XML
---

# PDF Processing
## Quick start
...
```

**Three-level progressive disclosure** [[platform.claude.com: Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)]:

| Level | When loaded | Token cost | Content |
|---|---|---|---|
| 1: Metadata | At startup, always | ~100 tokens per skill | `name` + `description` from YAML frontmatter |
| 2: Instructions | When skill triggered | <5k tokens | SKILL.md body |
| 3: Resources | As needed via bash | effectively unlimited | bundled scripts/, references/, assets/ |

**The loader's algorithm:**
1. At session start, scan all skill dirs, read *only* the YAML frontmatter, build a catalog in the system prompt.
2. When user request matches a skill's description, the agent `cat`s the SKILL.md body into context.
3. SKILL.md may reference further files (FORMS.md, scripts/fill_form.py); agent reads those via bash as needed.
4. Scripts execute via bash; *only output* enters context, never the source.

**Directory layout** [[github.com/anthropics/skills](https://github.com/anthropics/skills)]:

```
pdf-skill/
├── SKILL.md           # required
├── FORMS.md           # optional, referenced from SKILL.md
├── REFERENCE.md       # optional
└── scripts/
    └── fill_form.py
```

**Security considerations from Anthropic's own docs** [[platform.claude.com: Agent Skills security](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview#security-considerations)]:
- "Use Skills only from trusted sources" — they're code, treat them like installing software.
- Skills that fetch external URLs are particularly risky — fetched content can carry prompt injection.
- Audit bundled scripts, look for unusual network/file patterns.

**Why this works for Gemma Chat:** the progressive disclosure model is genuinely necessary for an 8B-parameter model whose effective context is tighter than Claude's. Loading 30 skills' full bodies into a Gemma context window would be catastrophic; loading 30 one-line descriptions is fine. The format also gives us file-on-disk diffable, version-controllable skills, which is the right unit for sharing.

---

### 2.3 Model Context Protocol (MCP) status in 2026

**Status as of May 2026** [[modelcontextprotocol.io](https://modelcontextprotocol.io/), [digitalapplied: MCP 97M downloads](https://www.digitalapplied.com/blog/mcp-97-million-downloads-model-context-protocol-mainstream), [sitepoint: MCP complete 2026 guide](https://www.sitepoint.com/model-context-protocol-mcp/)]:

- Introduced by Anthropic November 2024; reached "de facto standard for AI agent integration" within 18 months.
- 97M monthly SDK downloads (March 2026), 5,800+ servers across every major category.
- OpenAI committed to MCP support in 2025, "breaking provider-specific tool format fragmentation."
- Vercel AI SDK 5 explicitly aligned tool definitions with MCP semantics (renaming `parameters` → `inputSchema`) [[Vercel AI SDK 5 migration](https://www.pkgpulse.com/guides/vercel-ai-sdk-5-migration-2026)].

**Transports** [[modelcontextprotocol.io/docs/develop/build-server](https://modelcontextprotocol.io/docs/develop/build-server), [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)]:
- **stdio** — local process, MCP server is a child of the client. Default for Claude Desktop / Claude Code. The only relevant transport for an in-Electron-app integration today.
- **Streamable HTTP** — introduced November 2025, replaces the legacy SSE transport. For remote MCP servers.
- **SSE (legacy)** — deprecated path.

**2026 roadmap.** "Key evolution on the 2026 roadmap is stateless operation" — current servers must maintain session state, limiting horizontal scaling; new spec standardizes session creation/resumption/migration [[digitalapplied: MCP adoption 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol)]. This matters more for remote/HTTP MCP than for our local stdio use case.

**SDKs:**
- TypeScript SDK: official, "Tier 1," 66M+ npm downloads, 27,000+ dependents [[github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)]. Optional middleware for Express/Hono/Node http.
- Python SDK: official [[github.com/modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk)].

**Claude Desktop as the canonical client.** Claude Desktop reads `mcpServers` from a JSON config and spawns each server as a stdio child process [[support.claude.com: Local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop), [modelcontextprotocol.io/docs/develop/connect-local-servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers)]. The 3-part flow: client → JSON-RPC over stdio → server returns tool list → client wires tools into the model's tool catalog. Tools chain across servers transparently to the model.

---

### 2.4 Consuming MCP servers from a Gemma-driven agent

**The core question:** can a non-Claude agent loop consume MCP servers as a Skill mechanism?

**Yes — and the bridge is small.** MCP is provider-agnostic by design. The client side is a stdio JSON-RPC speaker; it doesn't care what model is producing tool calls on the other end. The bridge layer is "convert the MCP tool list into whatever tool-calling shape our model expects, and convert tool-call requests back into MCP `tools/call` JSON-RPC."

**Sketch using the official TS SDK** [[github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk)]:

```ts
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const transport = new StdioClientTransport({
  command: 'npx',
  args: ['-y', '@modelcontextprotocol/server-filesystem', '/Users/bear/work'],
});

const client = new Client({ name: 'gemma-chat', version: '0.2.0' }, { capabilities: {} });
await client.connect(transport);

const { tools } = await client.listTools();
// tools is an array of { name, description, inputSchema (JSON Schema) }
// Convert to our internal Tool type, register in the TOOLS registry under namespace "mcp:<server>:<tool>"

// When the agent emits <action name="mcp:filesystem:read_file" args={...}/>:
const result = await client.callTool({ name: 'read_file', arguments: { /* args */ } });
// result.content is an array of content parts (text, image, etc.)
```

**Bridge layer responsibilities for Gemma Chat:**
1. **Spawn lifecycle.** MCP servers are child processes; main process owns them, restarts on crash, kills on app quit.
2. **Tool-name namespacing.** Multiple MCP servers can ship tools with the same name (`read_file`). Namespace as `mcp:<server-id>:<tool>` in the internal `TOOLS` registry.
3. **Schema translation.** MCP tools advertise JSON Schema; Gemma's `<action>` XML parser needs the same arg shape. AI SDK 5's alignment makes this trivial — the `inputSchema` field is the same concept [[ai-sdk.dev/foundations/tools](https://ai-sdk.dev/docs/foundations/tools)].
4. **Approval surface.** Every tool call routes through the same approval UX (§3.4); MCP tools are not privileged.
5. **Resources and prompts.** MCP servers can also expose "resources" (read-only data) and "prompts" (parameterized prompt templates). For v0.2, only consume `tools`; add resources/prompts in v0.3.

**Why this is the right destination for skills:** every MCP server in the ecosystem (5,800+) becomes a potential skill the user can install by editing one JSON config. That's the same ergonomic position Claude Desktop occupies. The Anthropic Skills format covers the prompt/instruction side; MCP covers the executable-tool side. They're complementary, not competing.

---

### 2.5 Vercel AI SDK — tool definition patterns

The Vercel AI SDK's tool API is the cleanest typed-tool-definition pattern in the TypeScript ecosystem [[ai-sdk.dev/foundations/tools](https://ai-sdk.dev/docs/foundations/tools), [vercel.com/blog/ai-sdk-5](https://vercel.com/blog/ai-sdk-5), [vercel.com/blog/ai-sdk-6](https://vercel.com/blog/ai-sdk-6)]:

```ts
import { tool } from 'ai';
import { z } from 'zod';

const weatherTool = tool({
  description: 'Get the weather in a location',
  inputSchema: z.object({
    location: z.string().describe('The location to get the weather for'),
  }),
  outputSchema: z.object({   // v5 addition: typed output
    temperature: z.number(),
    conditions: z.string(),
  }),
  execute: async ({ location }) => ({ temperature: 72, conditions: 'sunny' }),
});
```

**Why this shape is worth copying even off-Vercel:**
- **Symmetric input/output validation.** v5 introduced `outputSchema` so TypeScript validates the `execute` return at compile time and the SDK validates it at runtime [[Vercel AI SDK 5 migration](https://www.pkgpulse.com/guides/vercel-ai-sdk-5-migration-2026)].
- **MCP-aligned vocabulary.** `inputSchema` (not `parameters`) matches MCP, which means a tool defined in this shape can be exposed via MCP with a thin adapter [[ai-sdk.dev/foundations/tools](https://ai-sdk.dev/docs/foundations/tools)].
- **Schema-agnostic.** Supports Zod 3/4, Valibot, raw JSON Schema. Future-proof.

**For Gemma Chat:** adopt this exact shape for the `Tool` type in `src/main/tools.ts`. We don't need to depend on the `ai` package itself — the shape is what matters. A 40-line `tool()` helper of our own gives us the inference benefits without the dependency.

---

### 2.6 LangChain JS / LangGraph

LangGraph reached v1.0 in 2025 [[blog.langchain.com: LangChain and LangGraph v1.0](https://blog.langchain.com/langchain-langgraph-1dot0/)]. The selling point is "a low-level orchestration framework for building controllable agents" with "a proven ReAct pattern on LangGraph's durable runtime" [[github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph), [docs.langchain.com: Agents](https://docs.langchain.com/oss/python/langchain/agents)]. It supports "any model that supports tool calling … including self-hosted models via Ollama, vLLM, or llama.cpp" [[docs.langchain.com: Agents](https://docs.langchain.com/oss/python/langchain/agents)] — which would cover Gemma via MLX with a small shim.

**The pitch for Gemma Chat:** LangGraph would give us nodes/edges, durable execution, replay, and the middleware pattern for free.

**The argument against:** LangChain JS is a big dependency footprint, and the current Gemma Chat orchestrator (`agent-orchestrator.ts` per the audit) is small enough that the abstractions are likely more cost than benefit at v0.2. Where LangGraph genuinely shines — subagents with isolated context, durable execution, parallel branches — Gemma Chat doesn't need yet.

**Recommendation:** revisit at v0.4+ when we start adding subagents and need durability. Today, keep our own loop and copy the shape (nodes, edges, conditional routing) as a mental model.

---

### 2.7 Custom JSON-RPC / LSP-style skill protocol

A few apps roll their own subprocess protocol instead of MCP. The trade-offs are well-understood:

**Pros of rolling our own:**
- Total control over message shapes (e.g., can include streaming token output natively, not just final results).
- No dependency on the MCP SDK / spec evolution.
- Smaller wire format if we want it.

**Cons:**
- We re-implement everything MCP already gives us (handshake, capability negotiation, schema discovery, error model, content-type system).
- Zero ecosystem leverage — we cannot consume the 5,800 existing MCP servers.
- Every skill author has to learn our protocol instead of the standard one.

**Verdict:** don't. MCP exists, it's well-specified, it has SDKs in TypeScript and Python, it's already the standard. The right place to put custom protocol design is *inside* an MCP server (the server's internal logic), not at the transport layer.

The LSP comparison is apt: LSP won because every editor agreed on one protocol. MCP is winning the same fight for agent tools.

---

### 2.8 CLI integration with user-visible approval

The patterns that matter for "agent invokes shell tools with the user watching":

**Per-CLI typed tools, not generic shell.** The Anthropic Agent SDK guidance — "tools should represent primary, frequent actions" — argues for `run_gh(subcommand, args)`, `run_jq(filter, input)`, `run_git(subcommand, args)` rather than `run_bash(any_command)`. Each typed tool can validate args, document expected behavior in its description (which becomes part of the model's context), and have its own per-invocation approval policy [[claude.com: Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk)].

**Approval policies, three tiers:**
1. **Always allow** (e.g., `read_file` within workspace) — read-only, scoped, low-blast-radius.
2. **Allow once / Allow for session / Always allow this exact invocation** — Claude Code's model. Gives the user granular control without modal fatigue [[code.claude.com: Skills](https://code.claude.com/docs/en/skills)].
3. **Always prompt** (e.g., `run_bash`, anything network) — user sees the exact command, args, and chosen working directory; can edit before approving.

**User-visible logging.** Every tool invocation gets a streaming inline-message render in the chat — what was called, what args, what the (truncated) output was. The audit doc already calls this out as a missing primitive; it's the same UX surface as the approval modal.

**Don't expand `$VAR`.** A subtle bug class: if the agent emits `<action name="run_bash" args='{"cmd": "echo $HOME"}' />` and the bash wrapper invokes it via `sh -c`, the user-visible "approval string" shows literal `$HOME` but execution expands it. Either expand before display or run with `bash -c` and clearly mark "shell expansion enabled" in the approval dialog.

---

## 3. Concrete Recommendations for Gemma Chat

### 3.1 IPC validation pattern to retrofit

**Use hand-rolled Zod validators in a `defineHandler` wrapper.** Not electron-trpc.

Reasoning, point by point:
- Validation latency on the streaming chunk channel matters; SuperJSON overhead is real for high-frequency calls [[The Case Against electron-trpc](https://seedteamtalks.hyper.media/tech-talks/the-case-against-electron-trpc-when-type-safety-becomes-a-performance-tax?v=bafy2bzaceaynzyohje7w7n645rvkkl6uzkigyissdbqrs3hipycwm5yoaasvu)].
- The wrapper pattern is ~40 LOC, gives full TypeScript inference, and centralizes sender validation (Electron security recommendation #17) [[electronjs.org/security](https://www.electronjs.org/docs/latest/tutorial/security)].
- The wrapper is the natural place to wire audit logging (every IPC call gets a log line — same store as tool-invocation logs).
- Migrating channel-by-channel is risk-free: handlers not yet migrated keep their current `ipcMain.handle` registration.

**Concrete deliverable for v0.2:**
- New file `src/main/ipc/define.ts` (the wrapper above).
- New file `src/main/ipc/schemas.ts` (a Zod schema per channel, exported by name).
- One channel migrated at a time, starting with the highest-blast-radius ones (`tool-invoke`, `workspace-write`, anything that touches the filesystem or spawns processes).
- Sender allowlist: only `event.senderFrame.url` matching our renderer entry; everything else throws.

---

### 3.2 Skills loader architecture — start simple, grow into MCP

**Phase 1 (v0.2): Anthropic-format SKILL.md skills from a single directory.**

Mirror Claude Code's approach [[code.claude.com: Skills](https://code.claude.com/docs/en/skills), [platform.claude.com: Agent Skills](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview)]:
- Skills directory: `~/Library/Application Support/GemmaChat/skills/` (user) and `<repo>/.gemma-chat/skills/` (project).
- At startup, scan both, parse only YAML frontmatter, build a catalog injected into the agent system prompt as "available skills."
- When the agent emits `<action name="use_skill" args='{"skill": "pdf-processing"}' />`, the loader `cat`s the full SKILL.md body into the next agent turn.
- Skills can reference bundled scripts; scripts run through the same per-CLI-tool approval pipeline (§3.4).
- Adopt Anthropic's frontmatter exactly (`name`, `description`, the same length/character constraints) so skills are interoperable with Claude Code skills users already have.

This is small, ships in days, and immediately unlocks the "drop a skill into a directory, restart, use it" workflow.

**Phase 2 (v0.3): MCP client.**

Add an MCP client that spawns servers configured in `~/Library/Application Support/GemmaChat/mcp-servers.json` — exact-shape compatible with Claude Desktop's config so users can copy-paste between the two [[support.claude.com: Local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop)]:

```json
{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/Users/bear/work"]
    },
    "github": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-github"],
      "env": { "GITHUB_TOKEN": "${USE_SAFE_STORAGE:github-token}" }
    }
  }
}
```

MCP-discovered tools register into the same `TOOLS` registry under namespace `mcp:<server>:<tool>`. The agent doesn't know they're MCP; they're just tools with descriptions and schemas. This is exactly the bridge sketched in §2.4.

**Why this order:** SKILL.md skills are the instruction-shaped extension; MCP servers are the action-shaped extension. Skills typically *call* tools (often MCP tools). Shipping skills first means we have a need for tools to call, which forces the tool registry to be clean before we plug MCP into it.

---

### 3.3 run_bash hardening — what to actually do

**Replace generic `run_bash` with a curated per-CLI tool surface + a gated `run_bash` escape hatch.**

Concretely, for v0.2:

1. **Add typed tools for the common CLIs** the agent actually needs, each with Zod-validated args:
   - `run_grep({ pattern, path, flags })` — pattern is escaped before going to grep; path is workspace-bounded.
   - `run_jq({ filter, input })` — filter is passed through `jq`'s own parser; no shell.
   - `run_git({ subcommand: "status" | "log" | "diff" | "show", args })` — explicit allowlist of subcommands; nothing destructive in v0.2.
   - `run_gh({ subcommand, args })` — for GitHub workflows; token comes from `safeStorage`.
   - `read_file_chunked({ path, offset, limit })` — replaces "use cat in bash to read a file."
2. **Deprecate `run_bash` as default-on; make it opt-in per workspace.** A workspace-level setting (`.gemma-chat/config.json` with `allowBash: true`) and a one-time approval modal ("This workspace is requesting permission to run arbitrary shell commands. Do you want to allow this?") gate it.
3. **When `run_bash` is allowed, wrap every invocation in `sandbox-exec`** with the profile in §1.8. Scrub env vars before exec. The approval modal shows the exact command, the working directory, and the sandbox profile name.
4. **Long-term:** track Apple's macOS 26 "containers" replacement for `sandbox-exec` [[apple/containerization #737](https://github.com/apple/containerization/issues/737)]. When mature, migrate. Until then, `sandbox-exec` is the least-bad option and is the same choice OpenAI's Codex CLI and Homebrew's `alcoholless` make today [[medium.com/nttlabs: Alcoholless](https://medium.com/nttlabs/alcoholless-a-lightweight-security-sandbox-for-macos-programs-homebrew-ai-agents-etc-ccf0d1927301)].

**On Docker as an alternative:** rejected for v0.2 — adds 2GB to install, kills the "double-click, runs" UX, and most Gemma Chat users aren't going to have Docker Desktop installed. Revisit if we ever ship an "advanced" build channel.

---

### 3.4 Filesystem-access approval UX

**Use an in-renderer modal layered with a persistent allowlist file. Not the Electron native dialog.**

Reasoning:
- The native `dialog.showMessageBox` is jarring inside a chat flow and doesn't compose with the inline tool-call rendering. It also can't show streaming context (e.g., "the agent wants to read this file *because* it's about to do X").
- An in-renderer modal sits where the user is already looking (the chat), can show the file's contents in a preview pane, and can offer "Allow once / Allow for session / Always allow this path / Deny."
- The persistent allowlist is a single JSON file: `~/Library/Application Support/GemmaChat/allowlist.json` with entries like `{ "path": "/Users/bear/Documents/work", "scope": "read", "expires": null, "addedAt": "2026-05-17T...", "grantedFor": "default" }`.
- Sensitive paths (`~/.ssh`, `~/Library/Keychains`, `~/.aws`, anything matching a deny-list of credential paths) are *always* blocked, not approvable.

**Per-tool default policy:**

| Tool | Default policy | Notes |
|---|---|---|
| `read_file` within workspace dir | Always allow | Path-bounded; no prompt. |
| `read_file` outside workspace | Prompt with allowlist | Per-path persistence. |
| `write_file` within workspace | Always allow | Path-bounded. |
| `write_file` outside workspace | **Always prompt** | No "always allow" option for writes outside workspace. |
| `delete_file` (any) | Always prompt, no "always" | Highest-friction by design. |
| `run_bash` | Workspace-opt-in + per-call prompt | See §3.3. |
| `mcp:*` calls | Same policy as the matching native tool | Don't let MCP escape the approval surface. |

This is the same model Claude Code uses (always allow / allow once / allow for session) which is the de facto UX standard at this point [[code.claude.com: Skills](https://code.claude.com/docs/en/skills)].

**Implementation note:** the approval modal lives in the renderer; the *enforcement* lives in the main process, behind every filesystem-touching IPC handler. The renderer never makes the trust decision — it only displays the question and forwards the user's answer.

---

## 4. Phased adoption plan

This is opinionated sequencing, not a project plan. Adjust to milestones.

**v0.2 — security floor + skills MVP.**
- §1.1 Fuses (electron-builder config, CI assertion).
- §1.2 ASAR integrity (paired fuse).
- §1.3 IPC validation wrapper, migrate highest-blast-radius channels first.
- §1.4 `safeStorage` for HF token.
- §1.5 Flip `sandbox: true` after preload audit.
- §1.6 Tighten CSP per §1.6.
- §3.1 IPC validation pattern wired.
- §3.2 Phase 1 (SKILL.md loader from local dir).
- §3.4 Approval UX scaffolding (modal + allowlist JSON), wired into workspace ops.

**v0.3 — agent capability expansion + macOS hardening.**
- §1.7 Notarization + hardened runtime + entitlements (gates first signed release).
- §1.8 / §3.3 `run_bash` replacement plan: curated per-CLI tools + gated `run_bash` behind sandbox-exec.
- §2.4 / §3.2 Phase 2 (MCP client, Claude-Desktop-compatible config).
- §1.10 Permission handler + navigation/window limits.

**v0.4 — distribution + advanced agent loop.**
- §1.9 Auto-update (electron-updater + Ed25519 manifest signing per Doyensec pattern).
- §2.6 Consider LangGraph if subagents/durable execution become real requirements.
- §2.2 Skill resources + prompts (full MCP capability surface), skill marketplace concept.

---

## 5. Sources

### Electron official docs
- [Electron Security](https://www.electronjs.org/docs/latest/tutorial/security) — the 20-item security checklist.
- [Electron Fuses](https://www.electronjs.org/docs/latest/tutorial/fuses) — all fuses, semantic, secure defaults.
- [Electron Fuses raw markdown](https://raw.githubusercontent.com/electron/electron/refs/heads/main/docs/tutorial/fuses.md).
- [ASAR Integrity](https://www.electronjs.org/docs/latest/tutorial/asar-integrity).
- [safeStorage API](https://www.electronjs.org/docs/latest/api/safe-storage).
- [Using Preload Scripts](https://www.electronjs.org/docs/latest/tutorial/tutorial-preload).
- [Code Signing](https://www.electronjs.org/docs/latest/tutorial/code-signing).
- [Updating Applications](https://www.electronjs.org/docs/latest/tutorial/updates).

### Electron ecosystem
- [@electron/fuses on GitHub](https://github.com/electron/fuses) and [npm](https://www.npmjs.com/package/@electron/fuses).
- [@electron/notarize](https://github.com/electron/notarize).
- [electron-builder: Auto Update](https://www.electron.build/auto-update.html).
- [electron-builder: Configuring Electron Fuses](https://www.electron.build/tutorials/adding-electron-fuses.html).
- [electron-builder: FuseOptionsV1](https://www.electron.build/app-builder-lib.Interface.FuseOptionsV1.html).
- [electron-userland/electron-builder on GitHub](https://github.com/electron-userland/electron-builder).
- [@electron-toolkit/preload on npm](https://www.npmjs.com/package/@electron-toolkit/preload).
- [Electron issue #33517 — centralized IPC validation](https://github.com/electron/electron/issues/33517).
- [GHSA-vmqv-hx8q-j7mg — ASAR integrity bypass](https://github.com/electron/electron/security/advisories/GHSA-vmqv-hx8q-j7mg).
- [electron-trpc](https://electron-trpc.dev/) and [github.com/jsonnull/electron-trpc](https://github.com/jsonnull/electron-trpc).
- [The Case Against electron-trpc — performance tax analysis (Dec 2025)](https://seedteamtalks.hyper.media/tech-talks/the-case-against-electron-trpc-when-type-safety-becomes-a-performance-tax?v=bafy2bzaceaynzyohje7w7n645rvkkl6uzkigyissdbqrs3hipycwm5yoaasvu).
- [Doyensec: Building a Secure Electron Auto-Updater (Feb 2026)](https://blog.doyensec.com/2026/02/16/electron-safe-updater.html).
- [Signal Desktop PR #6849 — safeStorage adoption](https://github.com/signalapp/Signal-Desktop/pull/6849).

### CSP and content security
- [Electron CSP examples](https://content-security-policy.com/examples/electron/).
- [CSP meta http-equiv examples](https://content-security-policy.com/examples/meta/).
- [OWASP CSP cheat sheet](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html).
- [Electron CSP for file://](https://blog.coding.kiwi/electron-csp-local/).
- [CSP eval warning in Electron](https://www.xjavascript.com/blog/content-security-policy-of-your-site-blocks-the-use-of-eval-in-javascript-warning-when-setting-csp-meta-tag-in-electron/).

### macOS hardening and sandboxing
- [Ramielcreations: Sign and notarize MacOS electron app](https://www.ramielcreations.com/macos-github-app-build).
- [Kilian Valkhof: Notarizing your Electron application](https://kilianvalkhof.com/2019/electron/notarizing-your-electron-application/).
- [signmycode: How to Code Sign an Electron.js App for macOS](https://signmycode.com/resources/how-to-code-signing-an-electron-js-app-for-macos).
- [igorstechnoclub: sandbox-exec primer](https://igorstechnoclub.com/sandbox-exec/).
- [jmmv.dev: A quick glance at macOS' sandbox-exec](https://jmmv.dev/2019/11/macos-sandbox-exec.html).
- [Lucas Wiman: Sandboxing code on MacOS](https://lucaswiman.github.io/blog/2023-06-04--macos-sandbox/).
- [apple/containerization issue #737 — sandbox-exec deprecation timeline](https://github.com/apple/containerization/issues/737).
- [openai/codex issue #215 — sandbox-exec deprecation](https://github.com/openai/codex/issues/215).
- [Medium / nttlabs: Alcoholless lightweight sandbox](https://medium.com/nttlabs/alcoholless-a-lightweight-security-sandbox-for-macos-programs-homebrew-ai-agents-etc-ccf0d1927301).

### MCP
- [modelcontextprotocol.io — Build an MCP server](https://modelcontextprotocol.io/docs/develop/build-server).
- [modelcontextprotocol.io — Connect to local MCP servers](https://modelcontextprotocol.io/docs/develop/connect-local-servers).
- [github.com/modelcontextprotocol/typescript-sdk](https://github.com/modelcontextprotocol/typescript-sdk).
- [github.com/modelcontextprotocol/python-sdk](https://github.com/modelcontextprotocol/python-sdk).
- [Claude Help Center: Local MCP servers on Claude Desktop](https://support.claude.com/en/articles/10949351-getting-started-with-local-mcp-servers-on-claude-desktop).
- [Digital Applied: MCP 97M downloads (2026)](https://www.digitalapplied.com/blog/mcp-97-million-downloads-model-context-protocol-mainstream).
- [Digital Applied: MCP Adoption Statistics 2026](https://www.digitalapplied.com/blog/mcp-adoption-statistics-2026-model-context-protocol).
- [Sitepoint: MCP Complete 2026 Guide](https://www.sitepoint.com/model-context-protocol-mcp/).
- [Webfuse: MCP Cheat Sheet 2026](https://www.webfuse.com/mcp-cheat-sheet).

### Anthropic Agent SDK and Skills
- [Claude.com: Building agents with the Claude Agent SDK](https://claude.com/blog/building-agents-with-the-claude-agent-sdk).
- [Claude.com: Equipping agents for the real world with Agent Skills](https://www.anthropic.com/engineering/equipping-agents-for-the-real-world-with-agent-skills).
- [Claude API Docs: Agent Skills overview](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/overview).
- [Claude API Docs: Skill authoring best practices](https://platform.claude.com/docs/en/agents-and-tools/agent-skills/best-practices).
- [Claude Code Docs: Extend Claude with skills](https://code.claude.com/docs/en/skills).
- [github.com/anthropics/skills — public Skills repo](https://github.com/anthropics/skills).
- [Agensi: SKILL.md Specification](https://www.agensi.io/learn/skill-md-format-reference).
- [Augment Code: Anthropic Agent SDK — what ships vs what you build](https://www.augmentcode.com/guides/anthropic-agent-sdk-what-ships-vs-what-you-build).
- [Momentic: Anthropic Managed Agents vs Agent SDK](https://momenticmarketing.com/blog/anthropic-managed-agents-vs-agent-sdk).

### Vercel AI SDK
- [ai-sdk.dev: Foundations: Tools](https://ai-sdk.dev/docs/foundations/tools).
- [ai-sdk.dev: MCP tools](https://ai-sdk.dev/docs/ai-sdk-core/mcp-tools).
- [Vercel blog: AI SDK 5](https://vercel.com/blog/ai-sdk-5).
- [Vercel blog: AI SDK 6](https://vercel.com/blog/ai-sdk-6).
- [PkgPulse: Vercel AI SDK 5 Migration Guide 2026](https://www.pkgpulse.com/guides/vercel-ai-sdk-5-migration-2026).
- [Vercel Academy: Tool Use](https://vercel.com/academy/ai-sdk/tool-use).

### LangChain / LangGraph
- [github.com/langchain-ai/langgraph](https://github.com/langchain-ai/langgraph).
- [github.com/langchain-ai/langgraphjs](https://github.com/langchain-ai/langgraphjs).
- [LangChain blog: LangChain and LangGraph v1.0 milestones](https://blog.langchain.com/langchain-langgraph-1dot0/).
- [docs.langchain.com: Agents](https://docs.langchain.com/oss/python/langchain/agents).
- [langchain.com: LangGraph](https://www.langchain.com/langgraph).

### Penetration testing / Electron threat modeling
- [Deepstrike: Penetration Testing of Electron-based Applications](https://deepstrike.io/blog/penetration-testing-of-electron-based-applications).
- [Vulert: Securing Your Electron App](https://vulert.com/blog/securing-your-electron-app-tips-to-prevent-asar/).
- [Karol Mazurek: Cracking Electron Integrity](https://medium.com/@karol-mazurek/cracking-electron-integrity-0a10e0d5f239).
