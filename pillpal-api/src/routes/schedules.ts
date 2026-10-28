import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { dateOnlySchema, idParam, timeOfDaySchema } from '../lib/validation';
import { regenerateScheduleDoses } from '../services/doseEngine';

export const schedulesRouter = Router();
schedulesRouter.use(requireUser);

const scheduleBody = z.object({
  medicationId: z.uuid(),
  label: z.string().trim().max(60).nullable().optional(),
  /** "HH:MM" in the user's timezone. */
  timeOfDay: timeOfDaySchema,
  /** 0 = Sunday ... 6 = Saturday. Omit or [] for every day. */
  daysOfWeek: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  quantity: z.number().int().min(1).max(20).default(1),
  graceMinutes: z.number().int().min(5).max(24 * 60).default(60),
  startDate: dateOnlySchema.nullable().optional(),
  endDate: dateOnlySchema.nullable().optional(),
  isActive: z.boolean().default(true),
});

const include = { medication: { select: { id: true, name: true, strength: true, form: true, slot: { select: { index: true, deviceId: true } } } } };

/** GET /schedules?medicationId=... */
schedulesRouter.get('/', async (req, res) => {
  const { medicationId, includeInactive } = z
    .object({ medicationId: z.uuid().optional(), includeInactive: z.coerce.boolean().default(false) })
    .parse(req.query);
  const schedules = await prisma.schedule.findMany({
    where: { userId: currentUser(req).id, ...(medicationId ? { medicationId } : {}), ...(includeInactive ? {} : { isActive: true }) },
    include,
    orderBy: [{ timeOfDay: 'asc' }],
  });
  res.json({ schedules });
});

/** POST /schedules */
schedulesRouter.post('/', async (req, res) => {
  const body = scheduleBody.parse(req.body);
  const userId = currentUser(req).id;
  const medication = await prisma.medication.findFirst({ where: { id: body.medicationId, userId } });
  if (!medication) throw ApiError.notFound('Medication');

  const schedule = await prisma.schedule.create({
    data: { ...body, daysOfWeek: [...new Set(body.daysOfWeek)].sort(), userId },
    include,
  });
  await regenerateScheduleDoses(schedule.id);
  res.status(201).json({ schedule });
});

/** GET /schedules/:id */
schedulesRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const schedule = await prisma.schedule.findFirst({ where: { id, userId: currentUser(req).id }, include });
  if (!schedule) throw ApiError.notFound('Schedule');
  res.json({ schedule });
});

/** PATCH /schedules/:id - any change rebuilds the upcoming (not yet taken) doses. */
schedulesRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = scheduleBody.omit({ medicationId: true }).partial().parse(req.body);
  const existing = await prisma.schedule.findFirst({ where: { id, userId: currentUser(req).id } });
  if (!existing) throw ApiError.notFound('Schedule');

  const schedule = await prisma.schedule.update({
    where: { id },
    data: { ...body, ...(body.daysOfWeek ? { daysOfWeek: [...new Set(body.daysOfWeek)].sort() } : {}) },
    include,
  });
  await regenerateScheduleDoses(id);
  res.json({ schedule });
});

/** DELETE /schedules/:id - deactivates the schedule and removes its upcoming doses; history is kept. */
schedulesRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const existing = await prisma.schedule.findFirst({ where: { id, userId: currentUser(req).id } });
  if (!existing) throw ApiError.notFound('Schedule');
  await prisma.schedule.update({ where: { id }, data: { isActive: false } });
  await regenerateScheduleDoses(id);
  res.status(204).end();
});
