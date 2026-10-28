import { createApp } from './app';
import { config } from './config';
import { logger } from './lib/logger';
import { prisma } from './lib/prisma';
import { startScheduler, stopScheduler } from './jobs/scheduler';

/** Entry point: `npm run dev` (watch mode) or `npm start` (compiled). */
async function main() {
  await prisma.$connect();
  logger.info('Connected to PostgreSQL');

  const app = createApp();
  const server = app.listen(config.PORT, config.HOST, () => {
    logger.info(`PillPal API listening on http://localhost:${config.PORT}/api/v1  (${config.NODE_ENV})`);
  });

  if (config.SCHEDULER_ENABLED) startScheduler();
  else logger.warn('Scheduler disabled (SCHEDULER_ENABLED=false)');

  const shutdown = (signal: string) => {
    logger.info(`${signal} received, shutting down`);
    stopScheduler();
    server.close(() => {
      prisma.$disconnect().finally(() => process.exit(0));
    });
    setTimeout(() => process.exit(1), 5000).unref();
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));
}

main().catch((err) => {
  logger.error({ err }, 'Failed to start. Is PostgreSQL running and DATABASE_URL correct?');
  process.exit(1);
});
