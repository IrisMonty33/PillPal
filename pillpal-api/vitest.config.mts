import 'dotenv/config';
import { defineConfig } from 'vitest/config';

/**
 * Tests run against a separate database so they never touch your dev data.
 * Default: the dev DATABASE_URL with "_test" appended to the database name
 * (pillpal -> pillpal_test). Override with TEST_DATABASE_URL.
 * `tests/globalSetup.ts` creates/resets that database before the suite starts.
 */
function testDatabaseUrl(): string {
  if (process.env.TEST_DATABASE_URL) return process.env.TEST_DATABASE_URL;
  const url = new URL(process.env.DATABASE_URL ?? 'postgresql://pillpal:pillpal@localhost:5432/pillpal');
  const dbName = url.pathname.replace(/^\//, '') || 'pillpal';
  url.pathname = `/${dbName.endsWith('_test') ? dbName : `${dbName}_test`}`;
  return url.toString();
}

export default defineConfig({
  test: {
    globalSetup: ['./tests/globalSetup.ts'],
    fileParallelism: false, // all test files share one database
    testTimeout: 20_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      DATABASE_URL: testDatabaseUrl(),
      JWT_SECRET: 'test-secret-not-for-production',
      DEVICE_PROVISIONING_KEY: 'test-provisioning-key',
      ADMIN_API_KEY: 'test-admin-key',
      SCHEDULER_ENABLED: 'false',
      PUSH_ENABLED: 'false',
      LOG_LEVEL: 'silent',
    },
  },
});
