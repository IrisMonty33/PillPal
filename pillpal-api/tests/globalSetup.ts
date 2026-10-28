import { execSync } from 'node:child_process';
import type { TestProject } from 'vitest/node';

/**
 * Runs once before the whole test suite: (re)creates the test database schema with
 * `prisma db push`. Requires PostgreSQL to be reachable (docker compose up -d).
 * Set SKIP_TEST_DB_SETUP=1 if you manage the test database yourself.
 */
export default function setup(project: TestProject) {
  if (process.env.SKIP_TEST_DB_SETUP) return;
  const url = project.config.env.DATABASE_URL;
  if (!url) throw new Error('vitest.config.mts did not provide DATABASE_URL for tests');
  console.log(`\nPreparing test database ${url.replace(/\/\/.*@/, '//***@')}`);
  execSync('npx prisma db push --force-reset --accept-data-loss --skip-generate', {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: url },
  });
}
