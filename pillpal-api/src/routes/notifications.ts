import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { idParam, paginationSchema, timeOfDaySchema } from '../lib/validation';
import { notify } from '../services/notifications';

export const notificationsRouter = Router();
notificationsRouter.use(requireUser);

/** GET /notifications?unread=true&limit=50 */
notificationsRouter.get('/', async (req, res) => {
  const q = paginationSchema.extend({ unread: z.coerce.boolean().default(false) }).parse(req.query);
  const where = { userId: currentUser(req).id, ...(q.unread ? { readAt: null } : {}) };
  const [notifications, total, unreadCount] = await Promise.all([
    prisma.notification.findMany({ where, orderBy: { createdAt: 'desc' }, take: q.limit, skip: q.offset }),
    prisma.notification.count({ where }),
    prisma.notification.count({ where: { userId: currentUser(req).id, readAt: null } }),
  ]);
  res.json({ notifications, total, unreadCount });
});

/** GET /notifications/settings */
notificationsRouter.get('/settings', async (req, res) => {
  const userId = currentUser(req).id;
  const settings = await prisma.notificationSettings.upsert({ where: { userId }, create: { userId }, update: {} });
  res.json({ settings });
});

/** PATCH /notifications/settings */
notificationsRouter.patch('/settings', async (req, res) => {
  const body = z
    .object({
      doseReminders: z.boolean().optional(),
      missedDoseAlerts: z.boolean().optional(),
      lowStockAlerts: z.boolean().optional(),
      deviceOfflineAlerts: z.boolean().optional(),
      vitalsAlerts: z.boolean().optional(),
      reminderLeadMinutes: z.number().int().min(0).max(120).optional(),
      requireTakenConfirmation: z.boolean().optional(),
      quietHoursStart: timeOfDaySchema.nullable().optional(),
      quietHoursEnd: timeOfDaySchema.nullable().optional(),
    })
    .parse(req.body);
  const userId = currentUser(req).id;
  const settings = await prisma.notificationSettings.upsert({ where: { userId }, create: { userId, ...body }, update: body });
  res.json({ settings });
});

/** POST /notifications/test - sends yourself a test notification (useful while wiring up push). */
notificationsRouter.post('/test', async (req, res) => {
  const notification = await notify(currentUser(req).id, {
    type: 'SYSTEM',
    title: 'PillPal test notification',
    body: 'If you can read this on your phone, push notifications work!',
  });
  res.status(201).json({ notification });
});

/** POST /notifications/read-all */
notificationsRouter.post('/read-all', async (req, res) => {
  const result = await prisma.notification.updateMany({ where: { userId: currentUser(req).id, readAt: null }, data: { readAt: new Date() } });
  res.json({ marked: result.count });
});

/** POST /notifications/:id/read */
notificationsRouter.post('/:id/read', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const result = await prisma.notification.updateMany({ where: { id, userId: currentUser(req).id }, data: { readAt: new Date() } });
  if (result.count === 0) throw ApiError.notFound('Notification');
  res.json({ ok: true });
});

/** DELETE /notifications/:id */
notificationsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const result = await prisma.notification.deleteMany({ where: { id, userId: currentUser(req).id } });
  if (result.count === 0) throw ApiError.notFound('Notification');
  res.status(204).end();
});
