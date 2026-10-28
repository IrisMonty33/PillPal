import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { dateOnlySchema, idParam } from '../lib/validation';
import { regenerateScheduleDoses } from '../services/doseEngine';

export const medicationsRouter = Router();
medicationsRouter.use(requireUser);

const medicationBody = z.object({
  name: z.string().trim().min(1).max(120),
  strength: z.string().trim().max(60).nullable().optional(),
  form: z.enum(['TABLET', 'CAPSULE', 'SOFTGEL', 'OTHER']).optional(),
  color: z.string().trim().max(40).nullable().optional(),
  shape: z.string().trim().max(40).nullable().optional(),
  instructions: z.string().trim().max(500).nullable().optional(),
  notes: z.string().trim().max(2000).nullable().optional(),
  prescriber: z.string().trim().max(120).nullable().optional(),
  pharmacy: z.string().trim().max(120).nullable().optional(),
  rxNumber: z.string().trim().max(60).nullable().optional(),
  pillWeightMg: z.number().positive().nullable().optional(),
  refillThreshold: z.number().int().min(0).max(1000).optional(),
  isActive: z.boolean().optional(),
  startDate: dateOnlySchema.nullable().optional(),
  endDate: dateOnlySchema.nullable().optional(),
});

const include = {
  slot: { select: { id: true, index: true, deviceId: true, pillCount: true, capacity: true } },
  schedules: { where: { isActive: true }, orderBy: { timeOfDay: 'asc' as const } },
};

/** GET /medications?includeInactive=true */
medicationsRouter.get('/', async (req, res) => {
  const { includeInactive } = z.object({ includeInactive: z.coerce.boolean().default(false) }).parse(req.query);
  const medications = await prisma.medication.findMany({
    where: { userId: currentUser(req).id, ...(includeInactive ? {} : { isActive: true }) },
    include,
    orderBy: { name: 'asc' },
  });
  res.json({ medications });
});

/** POST /medications */
medicationsRouter.post('/', async (req, res) => {
  const body = medicationBody.parse(req.body);
  const medication = await prisma.medication.create({ data: { ...body, userId: currentUser(req).id }, include });
  res.status(201).json({ medication });
});

/** GET /medications/:id */
medicationsRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const medication = await prisma.medication.findFirst({
    where: { id, userId: currentUser(req).id },
    include: { ...include, schedules: { orderBy: { timeOfDay: 'asc' } } },
  });
  if (!medication) throw ApiError.notFound('Medication');
  res.json({ medication });
});

/** PATCH /medications/:id */
medicationsRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = medicationBody.partial().parse(req.body);
  const existing = await prisma.medication.findFirst({ where: { id, userId: currentUser(req).id } });
  if (!existing) throw ApiError.notFound('Medication');

  const medication = await prisma.medication.update({ where: { id }, data: body, include });

  // Deactivating a medication cancels its upcoming doses; reactivating rebuilds them.
  if (body.isActive !== undefined && body.isActive !== existing.isActive) {
    for (const s of await prisma.schedule.findMany({ where: { medicationId: id } })) await regenerateScheduleDoses(s.id);
  }
  res.json({ medication });
});

/**
 * DELETE /medications/:id
 * Default: deactivate (keeps dose history, frees the slot, cancels upcoming doses).
 * Add ?permanent=true to delete the medication and all of its history.
 */
medicationsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { permanent } = z.object({ permanent: z.coerce.boolean().default(false) }).parse(req.query);
  const existing = await prisma.medication.findFirst({ where: { id, userId: currentUser(req).id } });
  if (!existing) throw ApiError.notFound('Medication');

  if (permanent) {
    await prisma.medication.delete({ where: { id } });
    res.status(204).end();
    return;
  }

  await prisma.$transaction([
    prisma.slot.updateMany({ where: { medicationId: id }, data: { medicationId: null } }),
    prisma.schedule.updateMany({ where: { medicationId: id }, data: { isActive: false } }),
    prisma.doseEvent.deleteMany({ where: { medicationId: id, status: 'SCHEDULED', scheduledAt: { gt: new Date() } } }),
    prisma.medication.update({ where: { id }, data: { isActive: false } }),
  ]);
  res.status(204).end();
});
