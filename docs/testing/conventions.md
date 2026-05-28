# Phronesis Test Conventions — SOTA bar

This is the authoritative spec sub-agents follow when writing tests in this
repository. If you are a sub-agent: read this entirely before writing code.

---

## The binding rules

1. **Live tests by default.** Hit the real services (Neo4j gemma-chat-memory,
   MLX-VLM, filesystem). Mocks are reserved for cases where live testing is
   *impossible or nonsensical*:
   - simulating subprocess crashes / SIGKILL chaos
   - time-dependent behavior (use `vi.useFakeTimers()` and `vi.setSystemTime()`)
   - network failure injection that can't be triggered naturally
   - testing the renderer in jsdom (Electron BrowserWindow can't be embedded)

   If you introduce a mock, the test file's top docstring **must** include a
   `Mocks:` section justifying why a live test is impossible here. No
   exceptions.

2. **Arrange–Act–Assert structure per test.** No exceptions for "simple"
   tests. Clarity beats brevity.

3. **Every test docstring states *what bug it would catch*.** Not what it
   does. "Verifies parser handles whitespace" is wrong; "would catch a
   regression where trimming was removed from field-value extraction" is
   right.

4. **No skipped tests without a `// TODO(coverage-phase-N): reason` comment.**
   The reason explains the dependency or blocker.

5. **Edge cases enumerated explicitly.** For every test of happy path, ask:
   empty input, oversized input, malformed input, concurrent input, boundary
   value (0, -1, MAX_INT, NaN, Infinity, undefined, null). Write the ones
   that are reachable from outside the module.

---

## Test layout

```
test/
  smoke.test.ts                  # Pipeline validation only.
  unit/
    <module>.test.ts             # Pure-logic, deterministic, no I/O.
  integration/
    <module>.live.test.ts        # Hits real Neo4j / FS / MLX. Suffix .live
                                 # makes it easy to grep for live tests
                                 # and to filter in CI.
  adversarial/
    <surface>.attack.test.ts     # Path traversal, prompt injection, oversized
                                 # inputs, schema deviation, chaos.
  e2e/
    <flow>.e2e.test.ts           # Playwright Electron flows.
  helpers/
    neo4j-cleanup.ts             # withTestRun() — see "Test data hygiene"
    fs-temp.ts                   # uniqueTempDir() — temp dir per test run
    mlx-fixtures.ts              # captured real-model outputs for fixtures
    (add more as needed; document them)
```

**Naming:** test files mirror source: `src/main/tom.ts` → `test/unit/tom-parser.test.ts`
+ `test/integration/tom-analyzer.live.test.ts`. Single source file may have
multiple test files; one test file should not span multiple source modules.

---

## Test data hygiene

### Neo4j (gemma-chat-memory)

Every test that writes to Neo4j **must**:

1. Use the `withTestRun` helper from `test/helpers/neo4j-cleanup.ts`:
   ```ts
   import { withTestRun } from '../helpers/neo4j-cleanup'

   describe('my live test', () => {
     it('does the thing', async () => {
       await withTestRun(async ({ runId, conversationId }) => {
         // runId is a unique tag stamped onto every node you create
         // conversationId is a unique test- prefixed conv id
         // After this callback returns, helper cleans up everything tagged with runId.
       })
     })
   })
   ```

2. **Never** delete by conversationId pattern alone — use the `_test_run_id`
   property tag so concurrent agent worktrees don't wipe each other's data.

3. **Never** call `closeNeo4j()` in `afterEach` — the singleton driver is
   shared. Only `closeNeo4j()` in `afterAll` of a *terminal* file (and even
   then, only if it actually solves a leak — vitest exits cleanly without it).

### Filesystem

Every test that writes files **must** use `uniqueTempDir()` from
`test/helpers/fs-temp.ts`. Returns a path under
`os.tmpdir()/phronesis-test-<runId>/` that's cleaned up afterAll.

Never write inside `src/` or `~/.Library/Application Support/Phronesis/`.

### MLX subprocess

There is **one** MLX server, on **one** port (11437). Tests that spawn or
connect to MLX **must serialize**. The convention:

- Tests that touch MLX live live under `test/integration/<X>.mlx.live.test.ts`
  (note `.mlx.live` suffix).
- `vitest.config.ts` uses a `pool: 'forks'` + `singleFork: true` *for that
  pattern only* (or the agent owning MLX runs tests with `--sequence.concurrent=false`).
- Other agents do NOT write live-MLX tests — that's reserved for the MLX-owning
  agent (Wave C2 in the parallel rollout plan).

Captured fixtures of real model output live in
`test/helpers/mlx-fixtures.ts` — use these for unit tests of parsers that
consume model output instead of calling MLX live.

---

## Coverage gates (raised per phase)

`vitest.config.ts` coverage thresholds. **Never lower these.** Bump them up
as each phase merges.

| Phase | lines | functions | branches | statements |
|---|---|---|---|---|
| Phase 0 (current) | 5 | 5 | 5 | 5 |
| After Wave A merged | 25 | 25 | 20 | 25 |
| After Wave B merged | 45 | 45 | 35 | 45 |
| After Wave C merged | 65 | 65 | 55 | 65 |
| After Wave D merged | 70 | 70 | 60 | 70 |
| After Wave E merged | 80 | 80 | 70 | 80 |

If your agent's wave can't hit the next gate, report it — don't lower the
threshold.

---

## Mock justification template

If a mock is truly necessary, the test file's top docstring includes:

```
/**
 * Mocks:
 *   • vi.useFakeTimers() — testing the 90s dead-man timer requires
 *     deterministic time advancement; running real-time wall-clock would
 *     make the test take 90+ seconds.
 *   • child_process.spawn — simulating SIGKILL on the MLX subprocess to
 *     verify recovery; live SIGKILL would interrupt other concurrent tests.
 */
```

Without that section, the reviewer (main agent) will reject the test.

---

## Fixture format

Captured real outputs live in `test/fixtures/<surface>/*.txt`. Filename
encodes what makes the fixture interesting:

```
test/fixtures/tom/clean-curious-exploring.txt
test/fixtures/tom/clarifying-out-of-enum.txt   # Patch 68 regression
test/fixtures/tom/missing-rapport.txt
test/fixtures/mission/clean-three-step.txt
test/fixtures/mlx/sse-stream-with-images.txt
```

When you capture a new fixture, commit the .txt file AND a one-line entry in
`test/fixtures/MANIFEST.md` (create if missing) explaining what it captures.

---

## What "SOTA" means here

A test suite is SOTA when:

1. It would have caught every bug actually fixed in the last 30 days of git
   history. Audit your suite against `git log --since='30 days ago' --oneline`
   for the files you own.
2. Failing tests have one-line failure messages that point to the actual cause.
3. The suite runs in under 60s for unit + under 5 min for full integration.
4. No flakiness: 10 consecutive runs all pass deterministically.
5. Adversarial tests prove security boundaries (path traversal blocked, prompt
   injection contained, schema deviations coerced not crashed).

If your tests don't meet (1) for your files, you haven't covered the surface.

---

## Workflow per sub-agent

1. `cd` to your assigned worktree (you'll be in one already if launched with
   `isolation: "worktree"`).
2. Run `npm install` if `node_modules/` is missing (it usually will be in a
   fresh worktree).
3. Read this conventions doc.
4. Read the files you own + the existing tests for them.
5. Write tests following the layout above.
6. Run `npm test` (must all pass), `npm run typecheck` (must be clean),
   `npm run lint` (warnings OK for now, no errors).
7. Run your tests 3 times in a row to check for flakiness. If any run differs,
   fix the test (usually a cleanup order issue) — do NOT commit flaky tests.
8. Commit on your worktree branch with a descriptive message.
9. Report back to main agent with: test count, what each test covers, any
   files you needed to modify outside your ownership (and why), any blockers.
