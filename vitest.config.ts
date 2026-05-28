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
      exclude: ['src/**/*.d.ts', 'src/**/index.ts', 'src/renderer/**'],
      // Targets are deliberately modest while we build up. Adjust per phase.
      thresholds: {
        lines: 5,
        functions: 5,
        branches: 5,
        statements: 5
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
