# Sampling Baseline — Pre-Patch 70

**Date frozen:** 2026-05-26
**Recorded at commit:** `ebd8573` (HEAD before Patch 70)
**Models in use:** Gemma 4 family via mlx-vlm OpenAI-compat server
**Purpose:** Authoritative record of pre-change sampling state so Patch 70 (and any future sampling work) can be rolled back to known-good behavior without guessing.

---

## What we send today

Phronesis sends only `temperature` and `max_tokens` to mlx-vlm's `/v1/chat/completions`. **No `top_k`, no `top_p`, no `min_p`, no `repetition_penalty`** is ever set. Whatever the upstream sampler defaults to in the absence of those fields, that is what we run with.

### Exact file:line references

| Call site | File:line | Code (verbatim) |
|---|---|---|
| Chat default (mlx.ts request body) | `src/main/mlx.ts:587-589` | `temperature: opts.temperature ?? 0.7,`<br>`max_tokens: 8192` |
| Heartbeat tick temperature override | `src/main/heartbeat.ts:52` | `const HEARTBEAT_TEMP = 0.7` |
| Heartbeat tick stream invocation | `src/main/heartbeat.ts:564` | `for await (const chunk of chatStream({ model, messages, signal, temperature: HEARTBEAT_TEMP }))` |
| Mission decompose | shares `chatStream` | inherits `temperature: 0.7` default |
| ToM analyzer (`collect()`) | shares `chatStream` | inherits `temperature: 0.7` default |

### Effective per-caller values (today)

| Caller | temperature | top_k | top_p | max_tokens |
|---|---|---|---|---|
| User chat (interactive) | 0.7 | *(unset → mlx-vlm default)* | *(unset → mlx-vlm default)* | 8192 |
| Heartbeat (free-form research turns) | 0.7 | *(unset)* | *(unset)* | 8192 |
| Heartbeat (tool-synthesis turns) | 0.7 | *(unset)* | *(unset)* | 8192 |
| Mission decompose | 0.7 | *(unset)* | *(unset)* | 8192 |
| ToM analyzer | 0.7 | *(unset)* | *(unset)* | 8192 |

### Author-recommended defaults (for comparison only — NOT what we send)

Pulled verbatim from `models--mlx-community--gemma-4-26b-a4b-it-4bit/snapshots/<sha>/generation_config.json`:

```json
{
  "bos_token_id": 2,
  "do_sample": true,
  "eos_token_id": [1, 106, 50],
  "pad_token_id": 0,
  "temperature": 1.0,
  "top_k": 64,
  "top_p": 0.95,
  "transformers_version": "5.5.0.dev0"
}
```

So vs. Gemma 4's author defaults we run **cooler temperature (0.7 vs 1.0)** and **without any top-k / top-p truncation** for every call.

---

## Why this baseline exists

Before Patch 70 we have a single global behavior: temp=0.7, no truncation. Patch 70 adds three named profiles (chat / heartbeat free-form / tool-synthesis) with per-turn switching inside agentic loops. If any of the following are observed after Patch 70 ships, this baseline is the rollback target:

- Chat creativity feels clipped or repetitive in a way it didn't before
- Heartbeat ticks become less exploratory (always converge on the same plan)
- Tool-synthesis turns regress (worse JSON, worse tool-call formatting)
- Any model-specific degradation we can't quickly isolate to one profile

---

## How to roll back

### One-command revert (preferred)
```bash
# Reverts Patch 70 entirely. Confirm the SHA from `git log --oneline` first
# — replace <patch-70-sha> with the actual commit hash.
git revert <patch-70-sha>
```

### Manual restoration (if revert conflicts with later patches)
Restore these exact values at the listed locations:

1. **`src/main/mlx.ts`** — request body in `chatStream()`:
   ```ts
   temperature: opts.temperature ?? 0.7,
   max_tokens: 8192
   ```
   (No `top_k`, no `top_p` keys.)

2. **`src/main/heartbeat.ts`** — module constant near top:
   ```ts
   const HEARTBEAT_TEMP = 0.7
   ```
   And in the tick stream call:
   ```ts
   for await (const chunk of chatStream({ model, messages, signal, temperature: HEARTBEAT_TEMP })) {
   ```

3. **Remove any `SAMPLING_PROFILES` / `selectProfile` / per-turn profile logic** added by Patch 70.

4. **Remove the per-turn profile switching** inside the heartbeat/mission tick loops (Option B logic).

After manual restore, run:
```bash
npm run typecheck && npm run build
```
to verify the rollback compiles.

---

## Verification commands (post-rollback or pre-change sanity)

```bash
# Confirm no top_k / top_p / min_p / repetition_penalty anywhere in src/main
grep -rn "top_k\|top_p\|min_p\|repetition_penalty" src/main/

# Confirm temperature is only set in mlx.ts default and heartbeat.ts override
grep -rn "temperature:" src/main/

# Read live model defaults (any model in cache, not just 26B MoE)
find ~/Library/Application\ Support/Phronesis/mlx/models/hub/ \
  -name "generation_config.json" -exec cat {} \;
```

If both greps return ONLY the lines listed in the "Exact file:line references" table above, baseline is intact.

---

## Notes

- The `eos_token_id: [1, 106, 50]` array in the model config is irrelevant to our sampling work but documented here so future investigators can see what tokens the model considers stop signals (relevant if EOS handling becomes suspect — see today's E4B stutter investigation).
- mlx-vlm's OpenAI-compat server sits on top of `mlx-lm` samplers. Its sampler default when `top_k` / `top_p` are absent is "no truncation" (full-vocab sampling), which is why running with only `temperature` set is *substantially* different from running with the model's recommended `top_k=64, top_p=0.95`.
