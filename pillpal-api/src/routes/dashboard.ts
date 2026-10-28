import { Router } from 'express';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { currentUser, requireUser } from '../middleware/auth';
import { adherenceSummary } from '../services/doseEngine';
import { startOfLocalDay } from '../lib/time';

/** GET /dashboard - one call that fills the app's home screen. */
export const dashboardRouter = Router();
dashboardRouter.use(requireUser);

dashboardRouter.get('/', async (req, res) => {
  const user = currentUser(req);
  const now = new Date();
  const dayStart = startOfLocalDay(now, user.timezone);
  const dayEnd = new Date(dayStart.getTime() + 24 * 3_600_000);

  const doseInclude = {
    medication: { select: { id: true, name: true, strength: true, form: true } },
    slot: { select: { index: true, deviceId: true } },
  };

  const [todayDoses, nextDose, devices, unreadNotifications, adherence7d, latestVitals, lowStockSlots] = await Promise.all([
    prisma.doseEvent.findMany({ where: { userId: user.id, scheduledAt: { gte: dayStart, lt: dayEnd } }, include: doseInclude, orderBy: { scheduledAt: 'asc' } }),
    prisma.doseEvent.findFirst({ where: { userId: user.id, status: 'SCHEDULED', scheduledAt: { gte: now } }, include: doseInclude, orderBy: { scheduledAt: 'asc' } }),
    prisma.device.findMany({
      where: { ownerId: user.id },
      select: { id: true, name: true, status: true, lastSeenAt: true, firmwareVersion: true, slots: { orderBy: { index: 'asc' }, select: { index: true, pillCount: true, capacity: true, medication: { select: { id: true, name: true, refillThreshold: true } } } } },
    }),
    prisma.notification.count({ where: { userId: user.id, readAt: null } }),
    adherenceSummary(user.id, new Date(now.getTime() - 7 * 24 * 3_600_000), now, user.timezone),
    prisma.vitalReading.findMany({ where: { userId: user.id }, orderBy: { recordedAt: 'desc' }, take: 3 }),
    prisma.slot.findMany({
      where: { device: { ownerId: user.id }, medicationId: { not: null } },
      select: { index: true, pillCount: true, deviceId: true, medication: { select: { id: true, name: true, refillThreshold: true } } },
    }),
  ]);

  res.json({
    serverTime: now.toISOString(),
    user: { id: user.id, firstName: user.firstName, timezone: user.timezone },
    today: {
      date: dayStart.toISOString(),
      doses: todayDoses,
      taken: todayDoses.filter((d) => d.status === 'TAKEN').length,
      missed: todayDoses.filter((d) => d.status === 'MISSED').length,
      remaining: todayDoses.filter((d) => d.status === 'SCHEDULED' || d.status === 'DISPENSED').length,
    },
    nextDose,
    adherenceLast7Days: adherence7d,
    devices: devices.map((d) => ({ ...d, isOnline: !!d.lastSeenAt && now.getTime() - d.lastSeenAt.getTime() < config.DEVICE_OFFLINE_AFTER_MINUTES * 60_000 })),
    lowStock: lowStockSlots.filter((s) => s.medication && s.pillCount <= s.medication.refillThreshold),
    unreadNotifications,
    latestVitals,
  });
});
