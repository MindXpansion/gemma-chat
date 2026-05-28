# Test Fixtures Manifest

Captured real-world outputs used as test inputs. Each entry: filename, what
the fixture captures, where it was captured from, why it's useful.

Sub-agents adding fixtures must update this file in the same commit.

---

## test/fixtures/tom/ (ToM analyzer outputs)

*Empty — populate during Wave B (B1 agent).*

---

## test/fixtures/mission/ (mission decomposer outputs)

Synthesized per the decompose system prompt in `src/main/mission.ts` (Wave B2;
live-MLX-captured fixtures are deferred to Wave C2 which owns the MLX
subprocess). Each fixture targets a specific parser code path:

- `clean-three-step.txt` — happy-path 3-step plan, exactly matches the prompt's
  required `STEP: <sentence>` format. Catches a regression that broke basic
  parsing (e.g. tightening the regex too far).
- `single-step.txt` — minimum viable plan (1 STEP). Catches a regex that
  required at least 2 matches before yielding any.
- `with-prose-noise.txt` — STEP lines surrounded by preamble + trailing
  commentary. Catches a parser that anchored at start-of-buffer instead of
  start-of-line.
- `numbered-bulleted.txt` — STEP lines prefixed with `1.`, `-`, `  *` etc.
  Catches a regex that stopped accepting the leading `[\s\-*\d.]*` prefix.
- `malformed-no-steps.txt` — model gave up and emitted only prose. Catches a
  parser that synthesized fake steps instead of returning [] so the engine
  can mark the mission `stuck`.
- `oversized-twelve-steps.txt` — 12 STEP lines, exercises the MAX_STEPS=10
  cap. Catches a regression that removed the `.slice(0, MAX_STEPS)`
  truncation.

---

## test/fixtures/mlx/ (SSE chunks from mlx-vlm server)

*Empty — populate during Wave C (C2 agent).*

---

## test/fixtures/sentinels/ (YAML sentinel definitions)

- `sentinels/real-calibration-drift.yaml` — verbatim copy of the live
  `calibration-high-confidence-drift` sentinel from
  `~/GemmaWorkspace/sentinels/`. Catches drift if loader output stops
  matching the on-disk schema the operator actually maintains.
  Captured: 2026-05-27.
- `sentinels/real-orphan-node-rate.yaml` — verbatim copy of the live
  `orphan-node-rate` sentinel. Same purpose, second example.
  Captured: 2026-05-27.
- `sentinels/edge-empty.yaml` — zero-byte file. Catches a regression
  where the loader would crash on empty YAML instead of skipping it.
- `sentinels/edge-malformed.yaml` — unclosed quoted string + bad indent.
  Catches loader crashing on YAML parse error (must warn-and-skip).
- `sentinels/edge-missing-fields.yaml` — missing `query`, `threshold`,
  `comparator`, `summary_template`. Catches loader accepting incomplete
  schemas.
- `sentinels/edge-write-keyword.yaml` — query contains `CREATE`.
  Catches a regression where the read-only guard would allow writes.
- `sentinels/edge-apoc-write.yaml` — query calls `apoc.create.node`.
  Catches APOC-write bypass of the keyword regex.
- `sentinels/edge-no-observed.yaml` — query returns a column not aliased
  as `observed`. Catches loader accepting queries the runner can't
  evaluate.
- `sentinels/edge-bad-name.yaml` — name uses capitals + underscores.
  Catches loader accepting non-kebab-case names.
- `sentinels/edge-followup-no-prompt.yaml` — `action_on_cross:
  follow_up_enqueued` with no `follow_up_prompt`. Catches a regression
  where Gemma would be enqueued with an empty prompt.
- `sentinels/edge-valid-minimal.yaml` — smallest legal sentinel. Catches
  any tightening of the schema that accidentally rejects compliant input.

---

## Format

When adding a fixture:

```
- `surface/descriptive-name.txt` — what makes this fixture interesting
  (the specific bug it would catch / behavior it exercises).
  Captured: YYYY-MM-DD from <source>.
```
