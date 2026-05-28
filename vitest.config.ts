/**
 * Phase 0 — vitest config. Mirrors electron-vite's tsconfig path aliases so
 * tests can import from `@shared/*` and `../../src/main/*` the same way the
 * app does. Coverage uses v8 (native, fast) with thresholds intentionally
 * low while we build up — bump as we ship phases.
 */
import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

export default defineConfig({
  test: {
    // Node environment for main-process tests. Renderer tests (when we add
    // them) will use a per-file `// @vitest-environment jsdom` pragma.
    environment: 'node',
    globals: false,
    include: ['test/**/*.test.ts', 'test/**/*.test.tsx'],
    // Live tests against Neo4j / MLX can be slow; default 30s ceiling.
    testTimeout: 30_000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'html', 'json-summary'],
      include: ['src/main/**/*.ts', 'src/shared/**/*.ts', 'src/preload/**/*.ts'],
      // Note: src/preload/index.ts IS covered (Wave B3) — it's the entire
      // preload surface. The src/main/index.ts exclusion stands (Electron
      // app bootstrap, not unit-testable).
      exclude: ['src/**/*.d.ts', 'src/main/index.ts', 'src/renderer/**'],
      // Floor — locks in the post-Wave-B3 gain. Per-module coverage is much
      // higher (shared/ ~100%, scheduler 100%, env-loader 97%, observability
      // 71%, models 88%, sentinels 94%, preload 100%) but the global number
      // is dragged down by the still-uncovered giants (mlx.ts, heartbeat.ts,
      // tools.ts at 0%). Wave C and beyond will lift this.
      thresholds: {
        lines: 16,
        functions: 22,
        branches: 13,
        statements: 16
      }
    }
  },
  resolve: {
    alias: {
      '@shared': resolve(__dirname, 'src/shared'),
      '@main': resolve(__dirname, 'src/main'),
      '@preload': resolve(__dirname, 'src/preload')
    }
  }
})
