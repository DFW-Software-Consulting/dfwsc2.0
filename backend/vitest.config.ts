import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    fileParallelism: false,
    testTimeout: 30000,
    hookTimeout: 30000,
    coverage: {
      provider: 'v8',
      reporter: ['text', 'lcov', 'html'],
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/__tests__/**', 'src/index.ts'],
      reportOnFailure: true,
      thresholds: {
        statements: 90,
        branches: 80,
        functions: 90,
        lines: 90,
      },
    },
    env: {
      NODE_ENV: 'test',
      STRIPE_SECRET_KEY: 'sk_test_1234567890',
      STRIPE_WEBHOOK_SECRET: 'whsec_test1234567890',
      DATABASE_URL: process.env.DATABASE_URL ?? '',
      JWT_SECRET: 'test_jwt_secret_minimum_32_characters_long_random_string',
      JWT_EXPIRY: '1h',
      FRONTEND_ORIGIN: 'http://localhost:5173',
      USE_CHECKOUT: 'false',
      SMTP_HOST: 'localhost',
      SMTP_PORT: '1025',
      SMTP_USER: 'test',
      SMTP_PASS: 'test',
    },
  },
})
