# Test Fixtures Manifest

Captured real-world outputs used as test inputs. Each entry: filename, what
the fixture captures, where it was captured from, why it's useful.

Sub-agents adding fixtures must update this file in the same commit.

---

## test/fixtures/tom/ (ToM analyzer outputs)

*Empty — populate during Wave B (B1 agent).*

---

## test/fixtures/mission/ (mission decomposer outputs)

*Empty — populate during Wave B (B2 agent).*

---

## test/fixtures/mlx/ (SSE chunks from mlx-vlm server)

*Empty — populate during Wave C (C2 agent).*

---

## test/fixtures/sentinels/ (YAML sentinel definitions)

*Empty — populate during Wave A (A2 agent).*

---

## Format

When adding a fixture:

```
- `surface/descriptive-name.txt` — what makes this fixture interesting
  (the specific bug it would catch / behavior it exercises).
  Captured: YYYY-MM-DD from <source>.
```
