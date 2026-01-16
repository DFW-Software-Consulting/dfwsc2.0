import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    globals: true,
    environment: 'node',
    testTimeout: 30000, // 30 seconds timeout
    hookTimeout: 30000, // 30 seconds hook timeout
    env: {
      STRIPE_SECRET_KEY: 'sk_test_1234567890',
      STRIPE_WEBHOOK_SECRET: 'whsec_test1234567890',
      DATABASE_URL:
        process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/stripe_portal',
      ADMIN_USERNAME: 'admin',
      ADMIN_PASSWORD: 'testpassword',
      JWT_SECRET: 'test_jwt_secret_minimum_32_characters_long_random_string',
      JWT_EXPIRY: '1h',
    },
  },
})
