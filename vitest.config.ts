import { cloudflareTest } from '@cloudflare/vitest-pool-workers'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        bindings: {
          SERVICE_ADMIN_TOKEN: 'test-admin-token',
          CAPABILITY_SIGNING_KEY: 'test-signing-key-with-at-least-32-bytes',
        },
      },
    }),
  ],
})
