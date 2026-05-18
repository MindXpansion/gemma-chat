# Gemma Chat — Image Generation Strategy

**Status:** Research / proposal
**Date:** 2026-05-17
**Author:** Research pass for Bear
**Predecessor doc:** `docs/research/01-...` (not present yet — this is the second research doc)
**Decision frame already settled:** hybrid architecture. Vision-in, chat, and voice remain
100% local on Gemma 4 via MLX. Image generation (vision-out) routes to an external API,
because no on-device path on consumer Mac hardware yet matches FLUX-class quality at
interactive latencies. This doc picks the provider, the wiring, and the UX surface.

---

## TL;DR Recommendation

1. **Primary provider:** **fal.ai** running `fal-ai/flux/schnell` (interactive default) and
   `fal-ai/flux-pro/v1.1` (quality tier). Reasons: sub-second cold latency on schnell,
   you-pay-only-on-success billing, clean queue-or-sync API, image returned as an HTTPS URL
   (not base64), wide model catalog if we want to swap or A/B later.
2. **Fallback provider:** **Replicate** with `black-forest-labs/flux-schnell` for users who
   already have a Replicate account or who hit a fal outage. Same model family, near-identical
   pricing, simple `Prefer: wait` sync API.
3. **Architecture:** **Tool-based, proxied through main.** A new `generate_image` ToolSpec
   joins the existing tool registry in `src/main/tools.ts`. The agent decides when to call it.
   The HTTP call happens in the main process — the API key never crosses the IPC bridge into
   the renderer. The returned URL is downloaded by main, written to the per-conversation
   workspace as `images/<timestamp>-<slug>.png`, and the tool returns the workspace-relative
   path. The existing workspace file-watching machinery surfaces it.
4. **Surfacing:** dual — inline thumbnail in the chat transcript (clickable to enlarge), and
   the file appears in the Canvas pane file tree like any other workspace artifact. The agent
   can also `<img src="images/foo.png">` from a generated `index.html` in code mode, which
   "just works" because images live in the same workspace the preview server serves.
5. **Key storage:** Electron `safeStorage` API. Encrypted blob persisted to `userData`,
   decrypted only in main, never sent over IPC. First-run wizard collects the key; a
   Settings panel lets the user rotate it.
6. **Local fallback (Phase 2+):** DiffusionKit / mflux exists and works, but it is a
   model-download-and-config step that breaks the "open the app, it just works" promise.
   Park it as an optional setting once the hosted path is shipped and battle-tested.

End-to-end picture: user types "draw me a sunset over mountains", Gemma emits
`<action name="generate_image"><prompt>...</prompt></action>`, main calls fal.ai, downloads
the result into the conversation workspace, returns the path. Gemma then writes a plain-text
reply that references it; the renderer recognizes image paths in tool results and renders an
inline thumbnail in the chat. Cost: ~$0.003 per image at the default tier. First-image
latency target: <3 s wall clock.

---

## Part 1 — Provider Survey

The shortlist is evaluated on six axes that actually matter for a desktop chat client:

| Axis | Why it matters for Gemma Chat |
| --- | --- |
| **Cost per 1024² image** | We're routing on behalf of an individual user. Pennies matter at trial; predictable per-call pricing matters for trust. |
| **Latency (cold + warm)** | This is a chat client. >10 s wall clock breaks the feel. |
| **Sync vs async API** | Sync = one fetch and we're done. Async = poll-or-webhook, which is awkward inside a tool result. Sync is strongly preferred. |
| **Return format (URL vs base64)** | URL = small JSON, then a second fetch we control. Base64 = potentially MB of data through the LLM tool-result channel, which is awful for context budget and logs. URL is strongly preferred. |
| **Moderation strictness** | Local-feeling app + heavy-handed moderation = friction. We want "won't draw obviously illegal stuff" not "won't draw a glass of wine". |
| **Account friction** | Does it require a credit card up front? Free tier for trial? |

### 1.1 Replicate

The OG model marketplace. Maintains canonical hostings of every meaningful open-weight image
model: FLUX.1 schnell, FLUX.1 dev, FLUX 1.1 Pro, FLUX 1.1 Pro Ultra, SDXL, SD3, plus
thousands of community fine-tunes.

- **Pricing (2026):**
  - FLUX.1 [schnell]: **$0.003 / image** (~333 images per $1).
  - FLUX.1 [dev]: ~$0.025 / image.
  - FLUX 1.1 Pro: ~$0.04 / image.
  - FLUX Pro Ultra: ~$0.06 / image.
  See <https://replicate.com/pricing> and <https://replicate.com/black-forest-labs/flux-schnell/api>.
- **Latency:** Cold starts can be 10–30 s on the less-popular models; FLUX schnell is
  generally warm and returns in 1–3 s for 1024² (it's a 4-step model). Cold-start variance
  is the one knock against Replicate.
- **API shape:** REST. Default async (POST → poll the prediction URL). Sync mode via the
  `Prefer: wait` request header — request blocks for up to 60 s and returns the populated
  prediction inline. See
  <https://replicate.com/changelog/2024-10-09-synchronous-api> and
  <https://replicate.com/docs/topics/predictions/create-a-prediction>.
- **Return format:** HTTPS URL (`prediction.output[0]`). They briefly tried embedded data
  URLs and rolled it back in Oct 2024 — see
  <https://replicate.com/blog/data-urls-in-our-sync-api>. URLs expire after ~1 hour, so we
  must download and persist them. Fine for us; we want them on disk anyway.
- **Moderation:** Light. The model itself is the safety boundary on the open FLUX models.
- **Account:** Requires sign-up + payment method to use most models. No meaningful free tier.

**Bottom line:** A safe choice. Best raw catalog. Cold starts and the requirement of a paid
account from minute one cost it the top slot.

### 1.2 fal.ai

Inference-as-a-service that has explicitly optimized for low latency on diffusion models.
Hosts FLUX schnell, dev, pro, FLUX.2 family, SDXL, Stable Diffusion 3.5, plus video and
audio. Pitches itself as "the fastest inference engine on the market" with custom CUDA
kernels.

- **Pricing (2026):**
  - FLUX.1 [schnell]: from **$0.003 / megapixel** (so $0.003 for 1024² which is ~1 MP).
  - FLUX.1 [dev]: ~$0.025 / image.
  - FLUX.2 [pro]: $0.03 / MP.
  - FLUX.2 [flex]: $0.03 / MP.
  See <https://fal.ai/docs/documentation/model-apis/pricing> and
  <https://fal.ai/models/fal-ai/flux/schnell>.
- **Latency:** This is fal's headline. 5–10 s cold start; warm calls on schnell routinely
  return in <1 s for 1024². They claim "up to 10× faster than naive inference" via custom
  kernels.
- **API shape:** Three modes:
  - `fal.run(...)` — synchronous, direct HTTP, just wait. Perfect for us.
  - `fal.subscribe(...)` — queue under the hood with auto-polling. Library handles it.
  - Async queue with webhooks for production batch workloads.
  See <https://docs.fal.ai/model-apis/model-endpoints/synchronous-requests> and
  <https://docs.fal.ai/model-apis/model-endpoints/queue>.
- **Return format:** HTTPS URL in `images[0].url` along with width, height, content_type,
  file_size. URLs live on fal's CDN.
- **Billing model:** **You pay only on successful output.** Server errors and queue waits
  are not billed. This is meaningfully nicer than competitors when the model occasionally
  fails the safety check.
- **Moderation:** Light. Similar profile to Replicate — model-level safety on the FLUX
  weights themselves.
- **Account:** Sign-up + payment method. They do issue trial credits at signup
  (varies; historically $1 = enough to test).

**Bottom line:** Best latency, cleanest sync API, fairest billing model. Top pick.

### 1.3 OpenAI Images (gpt-image-1, DALL·E 3)

OpenAI's image stack as of mid-2026 is `gpt-image-1` (and `gpt-image-1-mini`), with DALL·E 3
in legacy mode.

- **Pricing (2026):**
  - gpt-image-1, low quality 1024²: ~$0.011 / image.
  - gpt-image-1, medium quality: ~$0.042 / image.
  - gpt-image-1, high quality: ~**$0.167 / image** (one of the most expensive options on the market).
  - gpt-image-1-mini: $0.005 / image (low) up to $0.036 (high).
  See <https://openai.com/api/pricing/> and
  <https://costgoat.com/pricing/openai-images>.
- **Latency:** 8–20 s typical. Markedly slower than FLUX schnell. The "thinking" overhead
  on gpt-image-1 is real.
- **API shape:** Standard sync REST (`/v1/images/generations`). No queue, no polling.
- **Return format:** **base64 (`b64_json`) only** for gpt-image-1. URL responses are not
  supported on the GPT image models — only on DALL·E 2/3. This is a real wart for us: the
  response payload is several hundred KB of base64 on the wire and even larger as a tool
  result if naively returned. We'd have to decode in main and write to disk regardless. See
  <https://developers.openai.com/api/reference/python/resources/images/methods/generate>.
- **Moderation:** **Strictest of the lot.** Refusals on faces of public figures, anything
  edgy, brand logos, sometimes harmless prompts that trip false positives. Fine if Gemma
  Chat is a productivity tool; annoying if users expect creative latitude.
- **Account:** Requires OpenAI org with billing. Some orgs need a verified organization to
  use gpt-image-1 at all.

**Bottom line:** Highest quality for product photography / typography / coherent text in
images. Worst latency, worst moderation, base64-only response, 10–50× more expensive than
FLUX schnell. Worth offering as an opt-in quality tier later; not the default.

### 1.4 Together.ai

Inference platform with growing image catalog.

- **Pricing (2026):**
  - FLUX.1 [schnell]: **free** (rate-limited serverless endpoint).
  - FLUX.1 [dev]: ~$0.025 / image.
  - FLUX.1 [pro]: $0.05 / image.
  - FLUX.2 [pro]: $0.03 / image.
  - FLUX.2 [flex]: $0.03 / image.
  See <https://www.together.ai/pricing>,
  <https://www.together.ai/models/flux-1-schnell>, and
  <https://www.together.ai/models/flux-2-pro>.
- **Latency:** Comparable to Replicate on warm endpoints. The free schnell endpoint is rate
  limited and can queue noticeably under load.
- **API shape:** Sync REST in the OpenAI-compatible style.
- **Return format:** URL or base64 (configurable).
- **Moderation:** Light, model-level.
- **Account:** Sign-up required. Free credit on signup.

**Bottom line:** The free schnell endpoint is interesting as a "no payment method required"
default to lower trial friction. But it's rate-limited and unpredictable. Worth listing as
a selectable provider; not the recommended default.

### 1.5 Vercel AI Gateway

Vercel's gateway-style abstraction in front of multiple providers, exposing the AI SDK's
`generateImage` interface.

- **Image providers behind it (2026):** Black Forest Labs (FLUX family), Google (Imagen),
  OpenAI (gpt-image-1), xAI (Grok Imagine). See
  <https://vercel.com/docs/ai-gateway/capabilities/image-generation> and
  <https://vercel.com/changelog/image-only-models-available-in-vercel-ai-gateway>.
- **Pricing:** Pass-through pricing from the underlying providers, plus a Vercel surcharge.
- **API shape:** AI SDK `generateImage({ model, prompt })`. Returns base64 by default.
- **Why it could matter:** One API key gets you every major image provider. No need to
  rotate keys per provider. Built-in usage metrics and spend caps.
- **Why it's awkward for us:** We're a desktop Electron app, not a Next.js site. The
  ergonomic wins of the AI SDK (server-side streaming React Server Components, etc.) don't
  apply. We'd be using it purely as a multi-provider key broker — which we can do directly
  per-provider with little more code. Adds a third-party dependency and a third-party bill
  for routing we can do ourselves.

**Bottom line:** Not the right shape for a desktop app whose unique selling point is "your
data doesn't leave your machine except where you explicitly ask it to". Worth keeping in
mind as a back-pocket option if we ever want zero-config multi-provider.

### 1.6 Black Forest Labs direct (bfl.ai)

The model authors' own hosted API. Hosts FLUX.1 dev/pro, FLUX 1.1 pro / ultra / raw, and
the FLUX.2 generation.

- **Pricing (2026):**
  - FLUX.1 [dev]: $0.025 / image.
  - FLUX.1 [pro]: $0.05 / image.
  - FLUX 1.1 [pro]: $0.04 / image.
  - FLUX 1.1 [pro] Ultra: $0.06 / image.
  - FLUX.2 pricing is megapixel-based with a formula
    `(firstMP + (outputMP-1) * mpPrice) + (inputMP * mpPrice)` in cents — see
    <https://bfl.ai/pricing> and <https://docs.bfl.ai/quick_start/pricing>.
  - Credit-based system: 1 credit = $0.01.
- **Latency:** Solid; comparable to fal but generally not faster.
- **API shape:** Sync REST, polling supported for long jobs.
- **Return format:** URL.
- **Moderation:** Light, model-level.
- **Account:** Sign-up + payment.

**Notable:** They do **not** host FLUX schnell on their own API. Schnell is the Apache-2.0
open-weight one anyone can host; BFL's API is positioned around the commercial Pro tier.
That means going BFL-direct means starting at $0.04+/image, not $0.003.

**Bottom line:** Authoritative, reliable, but starts at a price point >10× our preferred
default. Worth offering as a "Pro Quality" selectable tier; not the trial-friendly default.

### 1.7 Quick mentions

- **Google Imagen 4** — Available via the Gemini API and Vertex AI. ~$0.04/image at the
  standard tier. Quality is excellent, especially for photorealistic and text-in-image
  scenes. Moderation is moderately strict (less than OpenAI, more than FLUX). Worth
  offering as an alternative high-quality tier alongside gpt-image-1.
- **xAI Grok Imagine** — Available via the xAI API. Pricing similar to gpt-image-1.
  Notably permissive moderation policy. Niche audience; defer unless users ask.

### 1.8 Provider comparison

| Provider / Model | $/1024² | Cold latency | Warm latency | Sync API | Returns | Moderation | Account friction |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **fal — FLUX schnell** | **$0.003** | ~5 s | **<1 s** | Yes (`fal.run`) | URL | Light | Sign-up + card; trial credit |
| fal — FLUX.2 pro | $0.03 | ~5 s | 2–4 s | Yes | URL | Light | Sign-up + card |
| **Replicate — FLUX schnell** | $0.003 | 5–30 s | 1–3 s | Yes (`Prefer: wait`) | URL | Light | Sign-up + card |
| Replicate — FLUX 1.1 Pro | $0.04 | 5–30 s | 2–5 s | Yes | URL | Light | Sign-up + card |
| Together — FLUX schnell | **Free** | variable | 1–4 s | Yes (OpenAI-compat) | URL/b64 | Light | Sign-up; no card needed |
| Together — FLUX.2 pro | $0.03 | low | 2–4 s | Yes | URL/b64 | Light | Sign-up + card |
| OpenAI — gpt-image-1 (medium) | $0.042 | n/a | 8–15 s | Yes | **b64 only** | **Strict** | Org + verified billing |
| OpenAI — gpt-image-1 (high) | $0.167 | n/a | 10–20 s | Yes | **b64 only** | **Strict** | Org + verified billing |
| BFL — FLUX 1.1 Pro | $0.04 | low | 2–5 s | Yes | URL | Light | Sign-up + card |
| BFL — FLUX.2 Pro | ~$0.03/MP | low | 2–5 s | Yes | URL | Light | Sign-up + card |
| Vercel AI Gateway | pass-through + fee | n/a | varies | Yes (AI SDK) | b64 by default | inherits | Vercel account |
| Google Imagen 4 | ~$0.04 | n/a | 3–6 s | Yes | URL/b64 | Medium | Google Cloud / Gemini API key |

### 1.9 Why fal.ai for default + Replicate for fallback

- Warm latency on schnell is the single biggest UX axis for a chat app. fal wins it.
- Pay-only-on-success pricing aligns incentives — moderation refusals, transient errors,
  and queue waits don't cost the user.
- URL return format keeps the tool-result payload small (a few hundred bytes of JSON, not
  a megabyte of base64 stuffed into the LLM context).
- Replicate has the broader model catalog and is the obvious fallback if fal hiccups —
  same model family at near-identical price.
- Both providers expose the same conceptual model surface (text → image, optional
  width/height/steps), so a thin abstraction in `tools.ts` lets us swap based on a settings
  toggle without changing the agent-facing interface.

---

## Part 2 — Architectural Patterns

The codebase as it stands today uses a fairly opinionated pattern: tools are defined in
`src/main/tools.ts` as `ToolSpec` records, the LLM emits XML `<action>` blocks, the main
process parses them, executes the tool, and feeds the string result back into the model
loop. The renderer never directly invokes external APIs — it sends messages to main and
receives streaming token events.

The image generation feature has to slot into this. Three patterns to evaluate.

### Pattern A — Direct from renderer (preload bridge + safeStorage)

The renderer process gets a preload-exposed function like `window.api.generateImage(prompt)`.
Main process holds the key (encrypted via `safeStorage`), but the renderer triggers the
call directly via IPC.

**Pros:**
- Lower latency for non-agentic flows (e.g., a "Generate Image" button in the UI that
  doesn't involve the LLM at all).
- Image data can be streamed straight into a `<img>` blob URL with no disk round-trip.

**Cons:**
- Breaks the "the agent decides what to do" model. If we want Gemma to autonomously decide
  to generate an image based on the conversation, this pattern doesn't reach the model
  loop at all.
- Two parallel code paths (renderer-triggered and agent-triggered) means two places to
  maintain rate limiting, error handling, retry logic, key validation.
- Inconsistent with how every other tool is built.

**Verdict:** Skip. If we ever add a manual "draw this" button, it can call the same
underlying main-process function the tool uses — no need to expose a renderer-facing path.

### Pattern B — Proxied through main (no tool, just a service)

Main process exposes an IPC method `generateImage(prompt, opts)`. The renderer can call it
directly, but it is _also_ called by the agent loop on the model's behalf when… well, when
what? Without making it a tool, the model has no way to ask.

**Verdict:** This is really Pattern A in disguise unless paired with a tool. Skip.

### Pattern C — Tool-based (recommended)

`generate_image` becomes a new entry in the `TOOLS` registry in `src/main/tools.ts`.

- The model decides when to call it, based on conversation context and the system prompt's
  tool catalog (which the existing `renderToolHelp('chat')` function already generates from
  the registry).
- The tool runs in the main process. It reads the API key (decrypted via `safeStorage`),
  calls fal.ai's sync endpoint, downloads the resulting image, writes it into the
  conversation workspace, and returns a short string result like:
  `Generated image saved to images/2026-05-17-sunset-mountains.png (1024×1024, 0.8s).`
- The agent reads that string and, if it wants, references the path in its next reply
  (e.g., `Here's the sunset you asked for: images/2026-05-17-sunset-mountains.png`).
- The renderer's chat transcript renderer recognizes workspace-relative image paths in
  message bodies (or in tool results — implementation choice) and renders an inline
  thumbnail.

**Pros:**
- Consistent with existing tool architecture. Zero new patterns to learn or maintain.
- Surface area for new tools (`edit_image`, `upscale_image`, `caption_image`) is already
  there. We just add more `ToolSpec` entries.
- The image being a file in the workspace means everything else already works: the file
  tree picks it up, the preview server serves it for code-mode HTML, the conversation
  archive includes it, file watchers fire.
- Key never leaves main. Renderer doesn't even know the key exists.

**Cons:**
- Tool-result text is what the LLM sees, so we have to be deliberate about what we return.
  Returning a markdown-ish string with the path is fine; returning a 700 KB base64 blob
  would be a disaster. URL-returning providers (fal, Replicate) make this easy.
- Slight extra hop: we always download the image to disk before the model gets the
  acknowledgement. That's ~50–200 ms of additional latency. Acceptable, and it's the
  behavior we want anyway (persistence).

**Verdict:** This is the path.

### 2.1 Where the image file lives

The existing `workspace.ts` model gives every conversation a directory at
`<userData>/workspaces/<conversationId>/`. The preview server already serves this directory,
file watchers already fire `onFileChange` to the renderer, and the file tree already
displays its contents.

Decision: write to `<workspaceRoot>/images/<YYYY-MM-DD>-<short-slug>-<rand>.png`.

- The `images/` subdirectory keeps generated content discoverable and separable from
  agent-written HTML/CSS/JS.
- Date prefix gives natural chronological ordering.
- Short slug (first 6 words of prompt, kebab-cased, ASCII-only) makes the filename
  human-readable when the user goes spelunking.
- 4-byte random suffix prevents collisions on identical-prompt back-to-back generations.

If the agent is in code mode and writes an `index.html` that references `images/foo.png`,
the existing preview server serves it correctly with zero extra plumbing. This is the
single biggest reason to put the file in the workspace rather than returning base64 or
storing it elsewhere.

### 2.2 How the image surfaces in chat

Two complementary surfaces:

1. **Inline thumbnail in the chat transcript.** When the chat renderer sees a message body
   (or tool result block) that contains a workspace-relative path matching
   `images/.+\.(png|jpg|webp)`, it renders a thumbnail (max ~400px wide, clickable to
   open full-size in a lightbox). This is a small renderer-side change to the existing
   message component.
2. **The file tree in the Canvas pane.** Already automatic — the workspace file watcher
   fires, the file appears.

Where the tool result text shows the path, we want it formatted in a way the LLM can both
acknowledge and quote back if asked. Something like:

```
Generated image:
  path: images/2026-05-17-sunset-mountains.png
  size: 1024x1024
  provider: fal/flux-schnell
  elapsed: 820ms
```

The renderer's message component can scan for `images/...png|jpg|webp` substrings in BOTH
assistant text AND tool results to decide where to drop a thumbnail. (Implementation note:
do this with a careful regex that requires the prefix `images/` so we don't accidentally
thumbnail every `path/to/file.png` mention.)

### 2.3 What the new ToolSpec looks like

Concretely, the addition to `TOOLS` in `src/main/tools.ts`:

```ts
generate_image: {
  name: 'generate_image',
  description:
    'Generate an image from a text prompt. Saves the result to the workspace ' +
    'and returns its relative path. Use when the user asks for a picture, ' +
    'illustration, photo, logo, or anything visual.',
  params: [
    { name: 'prompt', description: 'detailed description of the desired image', required: true, multiline: true },
    { name: 'aspect_ratio', description: 'one of: square, portrait, landscape, wide (default: square)' },
    { name: 'quality', description: 'fast (default, ~1s) or high (5-10s, more detail)' }
  ],
  example:
    '<action name="generate_image">\n' +
    '<prompt>A serene mountain landscape at sunset, oil painting style, ' +
    'warm orange and purple sky, snow-capped peaks reflected in a still alpine lake</prompt>\n' +
    '<aspect_ratio>landscape</aspect_ratio>\n' +
    '</action>',
  mode: 'both',
  run: generateImage
}
```

The `mode: 'both'` matters — we want this available in chat mode (the user asking for art)
and in code mode (the agent generating hero images for a landing page it's building).

Internal implementation sketch (lives in a new `src/main/image-gen.ts` to keep `tools.ts`
focused):

```ts
async function generateImage(args, ctx) {
  const prompt = String(args.prompt ?? '').trim()
  if (!prompt) return 'Error: missing <prompt>'
  const aspect = String(args.aspect_ratio ?? 'square')
  const quality = String(args.quality ?? 'fast')

  const provider = await getActiveProvider()       // reads settings, decrypts key
  if (!provider) return 'Error: no image provider configured. Open Settings → Image Generation to add an API key.'

  const dims = aspectToDimensions(aspect)           // 1024x1024, 1024x1536, etc.
  const model = quality === 'high' ? provider.proModel : provider.fastModel

  const t0 = Date.now()
  let imageUrl: string
  try {
    imageUrl = await provider.generate({ prompt, ...dims, model })
  } catch (e) {
    return `Error generating image: ${(e as Error).message}`
  }

  const bytes = await downloadBytes(imageUrl)
  const rel = `images/${dateStamp()}-${slug(prompt)}-${rand4()}.png`
  await wsWriteBinary(ctx.conversationId, rel, bytes)
  ctx.onFileChange?.()

  const elapsed = Date.now() - t0
  return [
    `Generated image saved to ${rel}`,
    `Size: ${dims.width}x${dims.height}`,
    `Provider: ${provider.id}/${model}`,
    `Elapsed: ${elapsed}ms`
  ].join('\n')
}
```

A few notes on this sketch:

- `wsWriteBinary` doesn't exist yet — `workspace.ts` currently exposes `wsWriteFile` for
  text. We'd add a binary sibling that takes a Buffer and skips the `cleanFileContent`
  pass entirely (that pass is specific to LLM-generated text content and would be actively
  harmful applied to PNG bytes).
- Provider abstraction is small: an interface with `id`, `fastModel`, `proModel`, and
  `generate({ prompt, width, height, model }) => Promise<string>` returning the image
  URL. fal and Replicate implementations are ~30 lines each.
- `slug()` should be ASCII-only, lowercased, hyphen-joined, max ~6 words. Reject characters
  outside `[a-z0-9-]` to keep paths sane cross-platform.

### 2.4 API key storage

The Electron `safeStorage` API is the right tool: it uses the OS keychain on macOS
(Keychain), Windows (DPAPI), and Linux (kwallet / gnome-libsecret) to derive a per-user
encryption key, then encrypts arbitrary blobs we store wherever we want. Reference:
<https://www.electronjs.org/docs/latest/api/safe-storage>.

Plan:

1. On first use of `generate_image`, if no key is configured, the tool returns a
   user-visible error directing them to Settings → Image Generation.
2. The Settings panel collects the key, validates it with a no-op API call (e.g., fal's
   account/whoami endpoint), then calls `safeStorage.encryptString(key)` and writes the
   ciphertext as a base64 string into the app's existing settings store
   (`<userData>/settings.json` or similar).
3. At runtime, the image-gen module reads the ciphertext, calls
   `safeStorage.decryptString(buf)`, and caches the plaintext in a module-scoped variable
   for the lifetime of the app session. Never exposed via IPC.
4. **Critical guard:** check `safeStorage.isEncryptionAvailable()` before storing. On Linux
   without a keychain backend, the API silently falls back to a hardcoded-password
   "encryption" that is no encryption at all
   (<https://github.com/electron/electron/blob/main/docs/api/safe-storage.md>,
   <https://blog.jse.li/posts/electron-store-encryption/>). If unavailable, warn the user
   prominently before saving.
5. Provide a "Rotate key" and "Remove key" affordance in the Settings panel.

The key never crosses the IPC boundary into the renderer. The renderer only ever sees:
"image generation is configured" / "image generation is not configured" + "saved" /
"failed" / "moderation rejected" results.

### 2.5 IPC and message-flow summary

```
   Renderer                Main                       fal.ai
   --------                ----                       ------
1. user types prompt
2. send message  ───────►  add to convo, run model
                           model emits <action name="generate_image">
3.                         runTool('generate_image')
4.                         decrypt fal key (safeStorage)
5.                         POST https://fal.run/fal-ai/flux/schnell  ───────►
6.                         ◄─── { images: [{ url: "https://cdn.fal.ai/..." }] }
7.                         fetch(url) → Buffer
8.                         write to workspaces/<convId>/images/...png
9.                         fire onFileChange ─────►  file tree updates
10.                        tool result string returned to model
11.                        model emits final assistant message referencing path
12.   ◄────── stream tokens ───────
13. renderer detects images/...png in stream, renders thumbnail inline
```

Steps 4–9 all happen inside the main process. The renderer's only inputs are tokens and a
file-changed notification — both already-existing channels.

---

## Part 3 — Cost and Latency Modeling

Default tier (fal + FLUX schnell, 1024²):

- Cost: $0.003/image. 10 images = 3 cents. 1000 images = $3.
- Wall-clock: ~0.8–1.5 s warm + ~50–200 ms download + ~10 ms disk write. Target: under
  2 s p50, under 4 s p95.

Quality tier (fal + FLUX.2 pro):

- Cost: $0.03/image. 10× the default. Still trivial at hobbyist usage.
- Wall-clock: ~2–4 s warm + same I/O. Target: under 6 s p95.

Daily heavy user (50 images/day, 80/20 fast/quality split):
`(40 × 0.003) + (10 × 0.03) = $0.12 + $0.30 = $0.42 / day = ~$13/month`.

This is comfortable enough that we can offer a "free trial" pattern by funding the first
N images out of a MindXpansion-owned fal account if we ever want to lower friction
further — but for v1 we should keep things simple: user supplies their own key.

---

## Part 4 — Local FLUX Fallback (Phase 2+ — small section)

The local option exists. As of mid-2026 the meaningful contenders for FLUX inference on
Apple Silicon are:

- **DiffusionKit** (`argmaxinc/DiffusionKit`) — Native Swift + MLX, supports FLUX.1 schnell
  and dev via `FluxPipeline`. Probably the cleanest integration story for a Mac app.
  <https://github.com/argmaxinc/DiffusionKit>.
- **mflux** — Pure-Python MLX implementation, broad compatibility, requires the user to
  have a Python environment.
- **flux-generator** (`voipnuggets/flux-generator`) — MLX-based; pitched at "no API key,
  no internet". Designed for the same audience we'd be serving.
  <https://voipnuggets.com/2025/02/18/flux-generator-local-image-generation-on-apple-silicon-with-open-webui-integration-using-flux-llm/>.
- **Draw Things** — Mature commercial app with an MLX backend; ~25% faster than mflux on
  FLUX per recent benchmarks. Not a library; an app, so less directly useful for
  embedding.
- Apple's own `apple/ml-stable-diffusion` (Core ML) — solid for SD 1.5/SDXL, FLUX support
  is community-extended rather than first-party.

**Hardware reality (2026):** Workable FLUX inference needs an M2/M3/M4 Pro/Max with 24 GB+
unified memory, and even then we're looking at 5–25 s/image. Models themselves are 12+ GB
downloads. On a base M3 with 16 GB, you're in swap-thrash territory.

**Why this is a Phase 2+ item, not the default:**

1. **First-run UX is killed by a 12 GB download.** The current Gemma Chat experience is
   "install, open, type". A local-FLUX default would mean "install, open, wait 20 minutes
   for the model to download, type". That's a different product.
2. **Hardware-tier gating.** A meaningful fraction of our users are on 8 GB and 16 GB
   machines that can run Gemma 4 fine but cannot run FLUX. Defaulting to local means a
   bad experience for them with no actionable error.
3. **Quality gap is real.** FLUX schnell hosted runs the same weights as FLUX schnell
   local, but the hosted version returns in 1 s vs 5–15 s locally. Same quality, much
   worse latency.
4. **Embedding overhead.** Either we ship the MLX runtime + weights (massive binary), or
   we shell out to a Python environment we don't control (bad), or we depend on a
   user-installed Draw Things-style app (worse).

**Recommendation:** Ship hosted-by-default in v1. In v2, add a "Use local FLUX (advanced)"
toggle in Settings that triggers an opt-in model download via DiffusionKit-style
integration, validates hardware, and switches the `generate_image` tool's provider
backend transparently. Same ToolSpec, same prompt-engineering, same UX — only the
provider implementation changes. The clean provider-abstraction interface from Part 2
makes this swap mechanical when the time comes.

---

## Part 5 — Open Questions / Future Work

- **Image editing / inpainting.** Both fal and Replicate offer FLUX Kontext and FLUX
  Fill. Worth adding `edit_image` as a separate tool in v1.1 once `generate_image` is
  stable. It would take a path to an existing workspace image plus an instruction.
- **Provider failover.** Should we auto-fall-back from fal to Replicate on error? Probably
  yes, but the user needs both keys configured. Defer to v1.1.
- **Cost visibility.** Show running spend in the Settings panel. Fal exposes usage via
  their API; Replicate ditto. v1.1.
- **Prompt enhancement.** Gemma 4 is a capable text model. We could route raw user
  prompts through Gemma first to expand them ("a sunset" → "A serene sunset over distant
  mountains, golden hour, soft volumetric light, painterly style...") before sending to
  the image provider. Quality gain is meaningful with schnell. Add as an opt-in toggle in
  v1.1.
- **NSFW handling.** The hosted providers we recommend (fal, Replicate) carry light
  moderation. If we want stricter, we layer a content classifier (Gemma can do this) on
  the prompt before sending. v1.1+.

---

## Part 6 — Concrete Implementation Checklist for v1

The above as a stepwise plan. Each item is one to a few hours.

1. **Add `wsWriteBinary` and a `images/` path helper to `src/main/workspace.ts`.**
   Mirror the existing `wsWriteFile` API, but take a `Buffer` and skip
   `cleanFileContent`.
2. **Create `src/main/image-gen.ts`** with the provider abstraction and the fal
   implementation. Replicate implementation as a second file or same file.
3. **Add `safeStorage`-backed key storage** to the existing settings module. Add
   `isEncryptionAvailable()` guard with prominent warning if false.
4. **Wire a new `generate_image` entry into the `TOOLS` registry** in
   `src/main/tools.ts` (just the ToolSpec; the implementation lives in image-gen.ts).
5. **Build a Settings → Image Generation panel** in the renderer with: provider picker
   (fal / Replicate / Together), key field (password-masked), validate button, save.
6. **Add inline image rendering to the chat message component.** Regex-match
   `images/[a-z0-9-]+\.(png|jpg|webp)` in assistant text and tool-result blocks; render
   as `<img>` pointing at the preview server URL.
7. **Update the chat-mode system prompt's tool catalog** so Gemma knows
   `generate_image` exists and what it's for. (No code change — happens automatically
   via `renderToolHelp('chat')` once the tool is registered.)
8. **Add a quick smoke test** harness that exercises the tool end-to-end with a sandbox
   key. Manual for v1; automate in v1.1.

---

## Sources

### Providers and pricing
- [Replicate Pricing](https://replicate.com/pricing)
- [Replicate — black-forest-labs/flux-schnell API reference](https://replicate.com/black-forest-labs/flux-schnell/api)
- [Replicate — Synchronous API changelog](https://replicate.com/changelog/2024-10-09-synchronous-api)
- [Replicate — "We messed up: data URLs in our sync API"](https://replicate.com/blog/data-urls-in-our-sync-api)
- [Replicate — Create a prediction docs](https://replicate.com/docs/topics/predictions/create-a-prediction)
- [fal.ai Pricing](https://fal.ai/docs/documentation/model-apis/pricing)
- [fal.ai — Synchronous Requests](https://docs.fal.ai/model-apis/model-endpoints/synchronous-requests)
- [fal.ai — Queue API](https://docs.fal.ai/model-apis/model-endpoints/queue)
- [fal.ai webhook payload reference](https://www.hooklistener.com/learn/fal-ai-webhooks-guide)
- [OpenAI API Pricing](https://openai.com/api/pricing/)
- [OpenAI — Create Image API reference](https://developers.openai.com/api/reference/python/resources/images/methods/generate)
- [OpenAI Image Pricing Calculator (CostGoat)](https://costgoat.com/pricing/openai-images)
- [Together.ai Pricing](https://www.together.ai/pricing)
- [Together.ai — FLUX.1 schnell free endpoint](https://www.together.ai/models/flux-1-schnell)
- [Together.ai — FLUX.2 pro](https://www.together.ai/models/flux-2-pro)
- [Vercel AI Gateway — Image Generation](https://vercel.com/docs/ai-gateway/capabilities/image-generation)
- [Vercel — Image-only models changelog](https://vercel.com/changelog/image-only-models-available-in-vercel-ai-gateway)
- [Black Forest Labs Pricing](https://bfl.ai/pricing)
- [Black Forest Labs Docs — Pricing](https://docs.bfl.ai/quick_start/pricing)
- [Pricepertoken — image model comparison](https://pricepertoken.com/image)
- [DigitalApplied — image API pricing 2026](https://www.digitalapplied.com/blog/ai-image-generation-api-pricing-comparison-2026)

### Local FLUX on Apple Silicon
- [argmaxinc/DiffusionKit](https://github.com/argmaxinc/DiffusionKit)
- [voipnuggets/flux-generator](https://github.com/voipnuggets/flux-generator)
- [apple/ml-stable-diffusion](https://github.com/apple/ml-stable-diffusion)
- [MLX Stable Diffusion guide (Medium)](https://medium.com/@ingridwickstevens/mlx-stable-diffusion-for-local-image-generation-on-apple-silicon-2ec00ba1031a)
- [InsiderLLM — Stable Diffusion on Mac with MLX](https://insiderllm.com/guides/stable-diffusion-mac-mlx/)

### Electron key storage
- [Electron safeStorage docs](https://www.electronjs.org/docs/latest/api/safe-storage)
- [electron/electron — safe-storage.md (source of truth)](https://github.com/electron/electron/blob/main/docs/api/safe-storage.md)
- [Jesse Li — "Breaking electron-store's encryption"](https://blog.jse.li/posts/electron-store-encryption/)
- [Freek Van der Herten — Replacing Keytar with safeStorage](https://freek.dev/2103-replacing-keytar-with-electrons-safestorage-in-ray)
- [Signal-Desktop PR using safeStorage](https://github.com/signalapp/Signal-Desktop/pull/6849)
