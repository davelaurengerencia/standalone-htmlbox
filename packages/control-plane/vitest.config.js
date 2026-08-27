// vitest.config.js — Cloudflare Workers vitest-plugin para tests E2E del control-plane.

import { cloudflareTest } from '@cloudflare/vitest-plugin'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['__tests__/**/*.test.js'],
    // Los tests comparten el D1/KV/R2 del worker — correr en serie para
    // evitar que se pisen los bootstraps.
    fileParallelism: false,
    pool: 'threads',
    poolOptions: {
      threads: {
        singleThread: true,
        // Serializa también DENTRO del archivo.
        isolate: false,
      },
    },
    sequence: {
      concurrent: false,
    },
  },
  plugins: [
    cloudflareTest({
      wrangler: { configPath: './wrangler.jsonc' },
      miniflare: {
        compatibilityDate: '2026-08-01',
        compatibilityFlags: ['nodejs_compat'],
        bindings: {
          HTMLBOX_ENV: 'test',
          HTMLBOX_TURSO_MODE: 'local',
          HTMLBOX_TURSO_DEV_URL: 'http://localhost:8080',
          HTMLBOX_R2_MODE: 'local-fake',
          HTMLBOX_EMAIL_MODE: 'dev',
          HTMLBOX_SESSION_DOMAIN: '',
          HTMLBOX_INTERNAL_SECRET: 'test-internal-secret-not-for-prod',
        },
      },
    }),
  ],
})