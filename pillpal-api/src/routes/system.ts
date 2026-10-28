import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { requireAdmin } from '../middleware/auth';
import { runSchedulerTick } from '../jobs/scheduler';

/** Health check + maintenance endpoints. */
export const systemRouter = Router();

/** GET /health - used by uptime monitors and the Pi to check connectivity. No auth. */
systemRouter.get('/health', async (_req, res) => {
  let database = 'ok';
  try {
    await prisma.$queryRaw`SELECT 1`;
  } catch {
    database = 'error';
  }
  res.status(database === 'ok' ? 200 : 503).json({ status: database === 'ok' ? 'ok' : 'degraded', database, time: new Date().toISOString(), version: process.env.npm_package_version ?? '0.1.0' });
});

/** POST /system/tick (header X-Admin-Key) - run the scheduler job right now instead of waiting. */
systemRouter.post('/system/tick', requireAdmin, async (_req, res) => {
  res.json({ tick: await runSchedulerTick() });
});

/** GET /system/stats (header X-Admin-Key) - row counts, handy for demos. */
systemRouter.get('/system/stats', requireAdmin, async (_req, res) => {
  const [users, devices, medications, schedules, doseEvents, notifications, vitals] = await Promise.all([
    prisma.user.count(),
    prisma.device.count(),
    prisma.medication.count(),
    prisma.schedule.count(),
    prisma.doseEvent.count(),
    prisma.notification.count(),
    prisma.vitalReading.count(),
  ]);
  res.json({ users, devices, medications, schedules, doseEvents, notifications, vitals });
});
