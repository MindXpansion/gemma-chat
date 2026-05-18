# Research 01 — `mlx-vlm` Server + Gemma 4 Wire Format

**Status:** Implementation-ready
**Date:** 2026-05-17
**Audience:** Gemma Chat implementation team (Patch 5 — multimodal IPC fix)
**Scope:** The exact wire format `mlx_vlm.server` expects for text / image / audio messages,
the Gemma 4 model family's modality and prompt characteristics, and ready-to-use request recipes.

---

## TL;DR (what the implementation team must know)

1. **`mlx_vlm.server` is OpenAI-compatible at `/v1/chat/completions`** but uses a content-part
   schema that is a *near-superset* of OpenAI's. It accepts **both** the OpenAI canonical
   `{"type":"image_url","image_url":{"url":"..."}}` shape **and** mlx-vlm's preferred
   `{"type":"input_image","image_url":"..."}` shape. ([source](https://github.com/Blaizzy/mlx-vlm))
2. **Images may be sent as `data:` URLs (base64) or as `file://`/HTTP URLs or local paths.**
   The server passes the string through to `mlx_vlm.utils.prepare_inputs`, which base64-decodes
   data URLs to PIL and fetches HTTP URLs. ([source](https://github.com/Blaizzy/mlx-vlm))
3. **Audio uses `{"type":"input_audio","input_audio":{"data":"<path-or-data-url>","format":"wav|mp3|flac"}}`.**
   Gemma 4 E2B/E4B *do* support audio natively in mlx-vlm via a Conformer encoder; 26B-MoE
   and 31B-Dense **do not** have an audio path. ([mlx-vlm Gemma 4 README](https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/gemma4/README.md))
4. **Critical gotcha:** the current Gemma Chat code at `src/main/mlx.ts:439-442` flattens
   every message to `{role, content: string}`, discarding `images` entirely. This is the same
   class of silent-drop bug reported against Gemma 4 in `omlx#690` — no error, no warning,
   only a token count anomaly betrays the loss. ([omlx#690](https://github.com/jundot/omlx/issues/690))
5. **Gemma 4 E4B-it (our default) is text + image + audio**, 128K context, recommended
   sampling `temperature=1.0, top_p=0.95, top_k=64`. Place **images before text** in the
   content array for optimal performance. ([Gemma 4 E4B-it model card](https://huggingface.co/google/gemma-4-E4B-it))
6. **Required mlx-vlm version: `0.4.3+`** for Gemma 4 support. Older versions silently fall back
   to text-only loading. ([mlx-community/gemma-4-e4b-4bit](https://huggingface.co/mlx-community/gemma-4-e4b-4bit))

---

## 1. `mlx-vlm` Server — Authoritative Reference

### 1.1 Server identity

`mlx_vlm.server` is a FastAPI service that ships inside the `mlx-vlm` PyPI package
(<https://github.com/Blaizzy/mlx-vlm>). It exposes OpenAI-compatible endpoints for any
VLM that mlx-vlm can load — currently including Gemma 4, Qwen2.5-VL, Idefics, Pixtral,
LLaVA, Phi-3.5-Vision, and others.

### 1.2 Startup CLI flags (verified against current main)

| Flag | Default | Purpose |
| ---- | ------- | ------- |
| `--model` | *(none — lazy load)* | HF repo ID or local path to preload at startup |
| `--adapter-path` | — | LoRA / adapter weights to load with the model |
| `--draft-model` | — | Speculative-decoding drafter model |
| `--draft-kind` | — | `dflash`, `eagle3`, or `mtp` |
| `--draft-block-size` | — | Override drafter block size |
| `--host` | `0.0.0.0` | Bind address |
| `--port` | `8080` | Bind port |
| `--trust-remote-code` | off | Pass through to HF loaders for non-canonical configs |
| `--enable-thinking` | off | Default thinking-mode on (Gemma 4 supports thinking) |
| `--kv-bits` | — | KV-cache quantization (e.g. `8` or `3.5`) |
| `--kv-quant-scheme` | `uniform` | `uniform` or `turboquant` |
| `--kv-group-size` | `64` | Group size for uniform KV quant |
| `--max-kv-size` | — | Hard cap on KV cache (tokens) |
| `--vision-cache-size` | `20` | LRU size for `VisionFeatureCache` (projected image features) |
| `--log-level` | `INFO` | DEBUG/INFO/WARNING/ERROR/CRITICAL |
| `--top-logprobs-k` | — | Cap for `top_logprobs` |

Sources: server CLI listing in repo
(<https://github.com/Blaizzy/mlx-vlm/blob/main/README.md>), confirmed by reading
`mlx_vlm/server.py` on `main`.

Today Gemma Chat passes only `--model` and `--port`. That's correct and minimal. If we
later want to reduce memory pressure on E4B with long conversations, `--kv-bits 8` and
`--max-kv-size 32768` are the levers.

### 1.3 Endpoints

| Path | Purpose |
| ---- | ------- |
| `/v1/chat/completions`, `/chat/completions` | OpenAI-style chat (what we use) |
| `/v1/responses`, `/responses` | OpenAI Responses-API style |
| `/v1/models`, `/models` | List loaded model |
| `/health` | Liveness |
| `/v1/metrics`, `/metrics` | Throughput / request stats |
| `/unload` | Unload current model (free RAM) |
| `/v1/cache/stats`, `/v1/cache/reset` | APC (auto-prefix cache) management |

### 1.4 Request schema — the **exact** JSON shape

Top-level fields accepted by `/v1/chat/completions`:

```jsonc
{
  "model": "mlx-community/gemma-4-e4b-it-4bit",   // must match a loaded model id
  "messages": [ /* see §1.5 */ ],
  "max_tokens": 512,
  "temperature": 1.0,
  "top_p": 0.95,
  "top_k": 64,
  "min_p": 0.0,
  "repetition_penalty": 1.0,

  // Gemma-4 / OSS-style thinking
  "enable_thinking": false,
  "thinking_budget": 0,
  "thinking_start_token": "<think>",
  "thinking_end_token": "</think>",

  "stream": true,
  "logprobs": false,
  "top_logprobs": 0,

  // Structured output (JSON-schema constrained decoding)
  "response_format": {
    "type": "json_schema",
    "json_schema": { "name": "X", "strict": true, "schema": { /* ... */ } }
  }
}
```

### 1.5 The `messages` content array — TWO accepted shapes

This is the load-bearing detail for Patch 5. Reading `mlx_vlm/server.py` on `main`, the
content-item dispatcher branches on the `type` field:

```python
# Paraphrased from mlx_vlm/server.py (current main)
for item in message.content:
    if isinstance(item, dict):
        if item["type"] == "input_text" or item["type"] == "text":
            chat_messages.append(item["text"])
        elif item["type"] == "input_image" or item["type"] == "image_url":
            images.append(item["image_url"])   # accepts str or dict downstream
        elif item["type"] == "input_audio":
            audios.append(item["input_audio"]) # dict {data, format}
```

The string `item["image_url"]` is then passed to `mlx_vlm.utils.prepare_inputs`, which:

> "Data URLs are base64-decoded to PIL; bare URLs pass through as strings."
> — server pipeline notes, confirmed by community downstream consumers
> (e.g. `omlx`, `mlx-openai-server`).

Both **mlx-vlm-native** and **OpenAI-canonical** content shapes work:

**Shape A — mlx-vlm native (preferred in their examples):**

```json
{
  "role": "user",
  "content": [
    { "type": "input_text",  "text": "Describe this image." },
    { "type": "input_image", "image_url": "data:image/png;base64,iVBORw0KGgo..." }
  ]
}
```

**Shape B — OpenAI canonical (recommended for portability):**

```json
{
  "role": "user",
  "content": [
    { "type": "text",      "text": "Describe this image." },
    { "type": "image_url", "image_url": { "url": "data:image/png;base64,iVBORw0KGgo..." } }
  ]
}
```

> **Implementation recommendation for Patch 5:** Use **Shape B (OpenAI canonical)**.
> It is the format every other OpenAI-compatible server in the ecosystem speaks
> (vLLM, LM Studio, llama.cpp's `llama-server`, Ollama, Together, Anthropic adapters).
> It future-proofs the bridge if we ever swap the backend.

### 1.6 Image URL formats accepted by `prepare_inputs`

| Form | Example | Notes |
| ---- | ------- | ----- |
| Base64 data URL | `data:image/png;base64,iVBOR...` | Decoded server-side to PIL. **Our default.** |
| `data:image/jpeg;base64,...` | — | Same. JPEG/PNG/WebP all work. |
| HTTP/HTTPS URL | `https://example.com/foo.png` | Fetched server-side (synchronous). |
| Local file path | `/Users/bear/foo.png` | Useful for tests; **do not** send over IPC from renderer. |
| `file://` URL | `file:///Users/bear/foo.png` | Same as path. |

**Formats:** PNG, JPEG, WebP, GIF, BMP are all valid (whatever PIL accepts).
**No documented hard size cap**, but vision encoders re-tile internally; very large images
just take longer. Practical guidance from the Gemma 4 model card: choose your **image
token budget** (70/140/280/560/1120 tokens) based on the task. The processor handles
resizing; you don't pre-resize.

### 1.7 System messages with images

Yes — the dispatcher in §1.5 runs for **any** message role. System messages may include
image content parts. In practice we won't use this (Gemma 4's recommended pattern keeps
images in the user turn), but it isn't blocked.

### 1.8 The `VisionFeatureCache` optimization

The server keeps an LRU of projected vision features keyed by image identity
(`--vision-cache-size`, default 20). In multi-turn conversations where the same image
recurs across user turns, the vision tower runs **once**, not per-turn. **This means the
data URL string itself becomes the cache key** — if we re-encode the same PNG to a
different base64 string each turn (e.g. by re-saving), we'll thrash the cache. Keep
image bytes stable across turns.

---

## 2. Gemma 4 — Model Family Reference

Primary sources:
- Google AI blog launch: <https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/>
- HF model card (E4B-it): <https://huggingface.co/google/gemma-4-E4B-it>
- HF model card (E2B-it): <https://huggingface.co/google/gemma-4-E2B-it>
- mlx-community E4B-4bit: <https://huggingface.co/mlx-community/gemma-4-e4b-4bit>
- mlx-vlm Gemma 4 README: <https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/gemma4/README.md>
- Google AI for Developers (Gemma 3n predecessor, same multimodal foundations):
  <https://ai.google.dev/gemma/docs/gemma-3n>

### 2.1 Variants

| Variant | Total params | Effective / active | Arch | Context | Text | Image | Audio | Video | Typical RAM (4-bit) |
| ------- | ------------ | ------------------ | ---- | ------- | :--: | :---: | :---: | :---: | ------------------- |
| **E2B-it** | 5.1 B | 2.3 B effective | Dense + PLE | 128 K | ✓ | ✓ | ✓ | ✓ | ~5 GB |
| **E4B-it** | 8.0 B | 4.5 B effective | Dense + PLE | 128 K | ✓ | ✓ | ✓ | ✓ | ~5–6 GB (4-bit) |
| **26B-A4B-it** | 25.2 B | 3.8 B active | MoE (8 of 128 + 1 shared) | 256 K | ✓ | ✓ | ✗ | ✓ | ~52 GB |
| **31B-it** | 30.7 B | 30.7 B | Dense, K-eq-V attn | 256 K | ✓ | ✓ | ✗ | ✓ | ~63 GB |

Notes:
- **PLE** = Per-Layer Embeddings (Matryoshka-style). "Effective" reflects what's loaded
  into compute; PLE lookup is essentially free at inference time.
- **K-eq-V attention** in the 26B/31B halves projection cost by reusing K as V.
- Audio is **E2B/E4B only.** This is the single biggest constraint for Gemma Chat:
  if a user picks the 31B Dense, our UI must hide the audio affordance.

### 2.2 Modality token budgets

| Modality | Budget |
| -------- | ------ |
| Image | 70 / 140 / 280 / 560 / 1120 tokens per image (configurable per request via processor). Lower for classification, higher for OCR. |
| Audio | ~40 ms per token, up to **750 tokens** = **~30 s maximum per audio clip** |
| Video | Frame sequence at 1 fps, **60 s max** |
| Context | 128 K (E2B/E4B), 256 K (26B/31B) |

### 2.3 Chat template (canonical)

Apply via `processor.apply_chat_template(...)`. The template natively handles `system`,
`user`, `assistant`. Thinking mode is opt-in:

```python
text = processor.apply_chat_template(
    messages,
    tokenize=False,
    add_generation_prompt=True,
    enable_thinking=False,   # set True for chain-of-thought reasoning
)
```

When we use `mlx_vlm.server`, **the server applies this template for us** — we send raw
OpenAI-style messages and the server formats them. We do **not** hand-roll Gemma's
turn tokens.

### 2.4 Recommended sampling parameters

From the official E4B-it model card:

```text
temperature = 1.0
top_p       = 0.95
top_k       = 64
```

Our current `chatStream` defaults to `temperature = 0.7`. That is fine and conservative
— Gemma 4 is well-behaved at 0.7. For more "Gemini-like" creative output, raise to 1.0.

### 2.5 Vision tower

| Spec | E2B / E4B | 26B / 31B |
| ---- | --------- | --------- |
| Vision encoder params | ~150 M (MobileNet-V5 based) | ~550 M |
| Variable aspect ratio | ✓ | ✓ |
| Variable resolution | ✓ | ✓ |

The Gemma 3n docs describe a "High-performance MobileNet-V5 encoder"; Gemma 4 inherits
this. (<https://ai.google.dev/gemma/docs/gemma-3n>)

### 2.6 Audio encoder (E2B / E4B only)

- **Architecture:** Conformer
- **Params:** ~300 M
- **Input:** 128-bin mel spectrogram, 16 kHz
- **Token rate:** ~40 ms per token
- **Max clip duration:** 30 s (≈750 tokens)
- **Formats accepted by mlx-vlm:** WAV, MP3, FLAC, "any format handled by `soundfile`"
  (so OGG/Vorbis, AIFF, etc. also work) —
  per <https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/gemma4/README.md>.
- **Tasks the model is trained on:** ASR (transcription) and AST (speech-to-text
  translation). Free-form "describe this sound" is **not** an explicit training target;
  expect best results with ASR/AST-style prompts.

### 2.7 Modality ordering (important)

Per the official E4B-it card:

> "Place images **before** text for optimal performance."

When mixing modalities, the recommended content-array order is:

```text
[ image, image, ..., audio, ..., text ]
```

### 2.8 Multi-turn thinking-mode gotcha

If `enable_thinking=true`:

> "**Critical**: Do NOT include thinking content in conversation history.
>  Only include the final response from previous model turns.
>  Remove all thinking tags before the next user turn."

For Gemma Chat: if we ever expose thinking mode in the UI, the IPC bridge must strip
content between `<|channel>` / `<channel|>` delimiters (or `<think>`/`</think>`,
configurable) before re-sending an assistant turn back to the server.

---

## 3. Practical Recipes — Test Cases for Patch 5

All three use `mlx-community/gemma-4-e4b-it-4bit` against a local
`mlx_vlm.server --model mlx-community/gemma-4-e4b-it-4bit --port 8080`.

### 3.1 Text-only (baseline — what we already do correctly)

```bash
curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d '{
    "model": "mlx-community/gemma-4-e4b-it-4bit",
    "messages": [
      {"role": "system", "content": "You are a concise assistant."},
      {"role": "user",   "content": "What is the capital of France?"}
    ],
    "stream": false,
    "max_tokens": 64,
    "temperature": 0.7
  }'
```

Note: a plain string `content` is valid — the server normalizes it to
`[{"type":"text","text":"..."}]` internally. We keep using strings for any
text-only turn.

### 3.2 Single image + text (the Patch 5 happy path)

```bash
# Encode an image to a data URL
IMG_B64=$(base64 < ./test.png | tr -d '\n')

curl -s http://127.0.0.1:8080/v1/chat/completions \
  -H 'content-type: application/json' \
  -d "$(cat <<JSON
{
  "model": "mlx-community/gemma-4-e4b-it-4bit",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "data:image/png;base64,${IMG_B64}" } },
        { "type": "text",      "text": "Describe this image in two sentences." }
      ]
    }
  ],
  "stream": false,
  "max_tokens": 200,
  "temperature": 0.7
}
JSON
)"
```

**Verification heuristic** (catches the silent-drop bug): a 512×512 PNG should produce
a prompt-token count in the **hundreds**, not single digits. If `usage.prompt_tokens`
< 50, the image was dropped. Log this in the bridge during dev.

### 3.3 Multi-turn with image carried in turn 1 only

```json
{
  "model": "mlx-community/gemma-4-e4b-it-4bit",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "image_url", "image_url": { "url": "data:image/jpeg;base64,/9j/4AAQ..." } },
        { "type": "text",      "text": "Whose painting style does this resemble?" }
      ]
    },
    { "role": "assistant", "content": "It strongly resembles late-period Monet." },
    { "role": "user",      "content": "Which specific series?" }
  ],
  "stream": true,
  "max_tokens": 256
}
```

The image from turn 1 stays in context (it's part of the prompt). Turn 3 is text-only
and the model can still refer back to it. Vision features are cached server-side, so
turn 3 does not re-run the vision tower.

### 3.4 Audio (E2B / E4B only — preview for future patch)

```json
{
  "model": "mlx-community/gemma-4-e4b-it-4bit",
  "messages": [
    {
      "role": "user",
      "content": [
        { "type": "input_audio",
          "input_audio": { "data": "data:audio/wav;base64,UklGRiQAAABXQVZF...", "format": "wav" } },
        { "type": "text",
          "text": "Transcribe the following speech segment in English into English text. Only output the transcription, with no newlines." }
      ]
    }
  ],
  "stream": false,
  "max_tokens": 512,
  "temperature": 0.0
}
```

For best ASR results use the Gemma 4 canonical ASR prompt verbatim (above) and set
`temperature` to 0.0. For translation, use the AST template from §2.6 / the E4B model card.

---

## 4. Concrete fix for `src/main/mlx.ts:431-446` (Patch 5)

Current code drops images:

```ts
messages: opts.messages.map((m) => ({
  role: m.role,
  content: m.content       // <- string only; images discarded
})),
```

Target — emit OpenAI-canonical mixed content **only when images are present**, otherwise
keep the simpler string form (cleaner logs, smaller payloads, identical semantics):

```ts
messages: opts.messages.map((m) => {
  if (!m.images || m.images.length === 0) {
    return { role: m.role, content: m.content }
  }
  // Gemma 4 best practice: images first, text last.
  const parts: Array<
    | { type: 'image_url'; image_url: { url: string } }
    | { type: 'text'; text: string }
  > = m.images.map((url) => ({ type: 'image_url', image_url: { url } }))
  if (m.content) parts.push({ type: 'text', text: m.content })
  return { role: m.role, content: parts }
}),
```

Renderer-side: each entry in `m.images` should already be a `data:image/...;base64,...`
URL. If the renderer hands us raw bytes or a `file://` path, normalize to a data URL
before crossing the IPC bridge (the renderer is sandboxed; the server may not be able
to read the file directly).

---

## 5. Known Gotchas (curated, with citations)

### 5.1 Silent image-drop on incompatible quantizations

`omlx#690` documents Gemma 4 silently dropping images when loaded from the Unsloth
dynamic-quant format (`*-UD-MLX-*`). Detection looked at config keys / model arch
patterns that Unsloth didn't match → loaded as text-only → image parts stripped during
formatting. Same bug class as ours today. **Mitigation:** stick to `mlx-community/...`
quantizations, and log `usage.prompt_tokens` during dev to catch silent drops.
(<https://github.com/jundot/omlx/issues/690>)

### 5.2 mlx-vlm version floor

`mlx-community/gemma-4-e4b-4bit` requires **mlx-vlm ≥ 0.4.3**. Earlier versions either
fail to load the architecture or load it as text-only.
(<https://huggingface.co/mlx-community/gemma-4-e4b-4bit>)

**Action:** pin `mlx-vlm>=0.4.3` in the Python bootstrap. The repo currently pins
`mlx-lm>=0.24.0` for the older code path; add an `mlx-vlm` floor when this lands.

### 5.3 Vision cache identity

`VisionFeatureCache` keys on the image string. If our renderer re-encodes the same
selected image to a fresh base64 string per turn (e.g. by reading the file again with
a different timestamp metadata), the cache misses every time. **Action:** memoize the
data URL in the renderer per attachment.

### 5.4 Thinking-mode history pollution

If we ever enable `enable_thinking=true`, the renderer must strip the model's
`<|channel>...<channel|>` (or `<think>...</think>`) regions before appending the
assistant turn to history. Otherwise the next turn re-feeds reasoning, which the model
was explicitly trained not to receive in history. (Gemma 4 E4B-it card.)

### 5.5 Audio is variant-gated

E2B / E4B only. If we ever expose a model picker that includes 26B-A4B or 31B-Dense,
the UI must disable the microphone affordance. There is no audio encoder in those
checkpoints. (mlx-vlm Gemma 4 README.)

### 5.6 30-second audio cap

Gemma 4 audio caps at 30 s per clip. For longer recordings, chunk client-side. The
server does not chunk for us. (E4B-it card.)

### 5.7 Modality ordering

Images **before** text in the content array. The model card calls this out explicitly
as a performance recommendation, not just a stylistic preference. (E4B-it card.)

### 5.8 Streaming `finish_reason` quirk

Our current SSE parser only treats `stop` and `length` as end-of-stream. The mlx-vlm
server may also emit `tool_calls` if structured-output / tool calling is in use, and
custom finish reasons in thinking mode. Not a current problem (we don't use those
features), but worth noting before we wire structured output.

### 5.9 `image_url` as string vs object

mlx-vlm accepts `image_url` as a bare string (their preferred shape) *and* as
`{url: "..."}` (OpenAI canonical). Other OpenAI-compatible backends (vLLM, LM Studio)
only accept the object form. **For portability, always send the object form.**

---

## 6. Source Index

Authoritative sources cited in this document:

1. **mlx-vlm repo** — <https://github.com/Blaizzy/mlx-vlm>
2. **mlx-vlm README** — <https://github.com/Blaizzy/mlx-vlm/blob/main/README.md>
3. **mlx-vlm Gemma 4 model README** — <https://github.com/Blaizzy/mlx-vlm/blob/main/mlx_vlm/models/gemma4/README.md>
4. **mlx-vlm pyproject.toml** (version floors) — <https://github.com/Blaizzy/mlx-vlm/blob/main/pyproject.toml>
5. **Google AI blog — Gemma 4 launch** — <https://blog.google/innovation-and-ai/technology/developers-tools/gemma-4/>
6. **HF model card — google/gemma-4-E4B-it** — <https://huggingface.co/google/gemma-4-E4B-it>
7. **HF model card — google/gemma-4-E2B-it** — <https://huggingface.co/google/gemma-4-E2B-it>
8. **HF model card — google/gemma-4-31B-it** — <https://huggingface.co/google/gemma-4-31B-it>
9. **HF model card — mlx-community/gemma-4-e4b-4bit** — <https://huggingface.co/mlx-community/gemma-4-e4b-4bit>
10. **Google AI for Developers — Gemma 3n overview** (multimodal precursor) — <https://ai.google.dev/gemma/docs/gemma-3n>
11. **omlx#690 — Gemma 4 silent image-drop bug (analogous failure mode)** — <https://github.com/jundot/omlx/issues/690>

---

*End of research note. Patch 5 may be implemented directly from §4 with the curl
recipes in §3 as the verification test plan.*
