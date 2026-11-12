import { defineConfig } from 'vitest/config'

// `ghuri test` runs vitest. App tests live in src/<app>/tests.ts (Django style) or *.test.ts files.
export default defineConfig({
  // Ghuri's decorators (@action, @admin.register, @display, @tool) work both as standard (TC39) decorators —
  // what wrangler / esbuild emit — and as legacy ones. Vitest transpiles with oxc, which only lowers legacy
  // decorators so far, so enable them for tests.
  oxc: { decorator: { legacy: true } } as Record<string, unknown>,
  test: {
    include: ['src/**/tests.ts', 'src/**/*.test.ts', 'tests/**/*.test.ts'],
    // Test databases (PGlite, D1 via Miniflare) can take a few seconds to start.
    testTimeout: 30_000,
    hookTimeout: 60_000,
  },
})
