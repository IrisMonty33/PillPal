import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { dateRangeSchema, idParam, isoDateSchema, paginationSchema } from '../lib/validation';
import { adherenceSummary, markSkipped, markTaken } from '../services/doseEngine';
import { startOfLocalDay } from '../lib/time';

export const dosesRouter = Router();
dosesRouter.use(requireUser);

const doseInclude = {
  medication: { select: { id: true, name: true, strength: true, form: true } },
  slot: { select: { index: true, deviceId: true } },
  schedule: { select: { id: true, label: true, timeOfDay: true } },
};

/** GET /doses?from&to&status&medicationId&limit&offset - dose history, newest first. */
dosesRouter.get('/', async (req, res) => {
  const q = dateRangeSchema
    .extend(paginationSchema.shape)
    .extend({
      status: z.enum(['SCHEDULED', 'DISPENSED', 'TAKEN', 'MISSED', 'SKIPPED', 'FAILED']).optional(),
      medicationId: z.uuid().optional(),
    })
    .parse(req.query);

  const where = {
    userId: currentUser(req).id,
    ...(q.status ? { status: q.status } : {}),
    ...(q.medicationId ? { medicationId: q.medicationId } : {}),
    ...(q.from || q.to ? { scheduledAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  const [doses, total] = await Promise.all([
    prisma.doseEvent.findMany({ where, include: doseInclude, orderBy: { scheduledAt: 'desc' }, take: q.limit, skip: q.offset }),
    prisma.doseEvent.count({ where }),
  ]);
  res.json({ doses, total, limit: q.limit, offset: q.offset });
});

/** GET /doses/today - everything scheduled for today in the user's timezone, plus the next dose. */
dosesRouter.get('/today', async (req, res) => {
  const user = currentUser(req);
  const now = new Date();
  const start = startOfLocalDay(now, user.timezone);
  const end = new Date(start.getTime() + 24 * 3_600_000);
  const doses = await prisma.doseEvent.findMany({
    where: { userId: user.id, scheduledAt: { gte: start, lt: end } },
    include: doseInclude,
    orderBy: { scheduledAt: 'asc' },
  });
  const next = await prisma.doseEvent.findFirst({
    where: { userId: user.id, status: 'SCHEDULED', scheduledAt: { gte: now } },
    include: doseInclude,
    orderBy: { scheduledAt: 'asc' },
  });
  res.json({ date: start.toISOString(), doses, nextDose: next });
});

/** GET /doses/upcoming?hours=24 */
dosesRouter.get('/upcoming', async (req, res) => {
  const { hours } = z.object({ hours: z.coerce.number().int().min(1).max(24 * 14).default(24) }).parse(req.query);
  const now = new Date();
  const doses = await prisma.doseEvent.findMany({
    where: { userId: currentUser(req).id, status: { in: ['SCHEDULED', 'DISPENSED'] }, scheduledAt: { gte: now, lte: new Date(now.getTime() + hours * 3_600_000) } },
    include: doseInclude,
    orderBy: { scheduledAt: 'asc' },
  });
  res.json({ doses });
});

/** GET /doses/adherence?days=30 (or ?from&to) */
dosesRouter.get('/adherence', async (req, res) => {
  const user = currentUser(req);
  const q = dateRangeSchema.extend({ days: z.coerce.number().int().min(1).max(365).default(30) }).parse(req.query);
  const to = q.to ?? new Date();
  const from = q.from ?? new Date(to.getTime() - q.days * 24 * 3_600_000);
  res.json({ adherence: await adherenceSummary(user.id, from, to, user.timezone) });
});

/** POST /doses/manual - log a dose taken without the dispenser (e.g. from the bottle while travelling). */
dosesRouter.post('/manual', async (req, res) => {
  const body = z
    .object({
      medicationId: z.uuid(),
      quantity: z.number().int().min(1).max(20).default(1),
      takenAt: isoDateSchema.optional(),
      notes: z.string().trim().max(500).optional(),
    })
    .parse(req.body);
  const userId = currentUser(req).id;
  const medication = await prisma.medication.findFirst({ where: { id: body.medicationId, userId } });
  if (!medication) throw ApiError.notFound('Medication');

  const takenAt = body.takenAt ?? new Date();
  const dose = await prisma.doseEvent.create({
    data: {
      userId,
      medicationId: medication.id,
      scheduledAt: takenAt,
      windowEndsAt: takenAt,
      quantity: body.quantity,
      status: 'TAKEN',
      source: 'MANUAL',
      takenAt,
      notes: body.notes,
    },
    include: doseInclude,
  });
  res.status(201).json({ dose });
});

/** GET /doses/:id */
dosesRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const dose = await prisma.doseEvent.findFirst({ where: { id, userId: currentUser(req).id }, include: doseInclude });
  if (!dose) throw ApiError.notFound('Dose');
  res.json({ dose });
});

/** POST /doses/:id/taken - the user confirms they took this dose (works for missed doses taken late, too). */
dosesRouter.post('/:id/taken', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ takenAt: isoDateSchema.optional(), notes: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const dose = await markTaken(id, { userId: currentUser(req).id, takenAt: body.takenAt, notes: body.notes });
  res.json({ dose });
});

/** POST /doses/:id/skip */
dosesRouter.post('/:id/skip', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ reason: z.string().trim().max(500).optional() }).parse(req.body ?? {});
  const dose = await markSkipped(id, { userId: currentUser(req).id, reason: body.reason });
  res.json({ dose });
});
