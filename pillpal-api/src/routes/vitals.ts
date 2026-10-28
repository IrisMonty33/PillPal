import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { dateRangeSchema, idParam, isoDateSchema, jsonObjectSchema, paginationSchema } from '../lib/validation';
import { recordVital } from '../services/vitals';

export const vitalsRouter = Router();
vitalsRouter.use(requireUser);

const vitalTypes = z.enum(['BLOOD_PRESSURE', 'HEART_RATE', 'SPO2', 'TEMPERATURE', 'WEIGHT', 'GLUCOSE']);

/** GET /vitals?type=BLOOD_PRESSURE&from&to&limit */
vitalsRouter.get('/', async (req, res) => {
  const q = dateRangeSchema.extend(paginationSchema.shape).extend({ type: vitalTypes.optional() }).parse(req.query);
  const where = {
    userId: currentUser(req).id,
    ...(q.type ? { type: q.type } : {}),
    ...(q.from || q.to ? { recordedAt: { ...(q.from ? { gte: q.from } : {}), ...(q.to ? { lte: q.to } : {}) } } : {}),
  };
  const [readings, total] = await Promise.all([
    prisma.vitalReading.findMany({ where, orderBy: { recordedAt: 'desc' }, take: q.limit, skip: q.offset }),
    prisma.vitalReading.count({ where }),
  ]);
  res.json({ readings, total });
});

/** GET /vitals/latest - most recent reading of each type (for the dashboard tiles). */
vitalsRouter.get('/latest', async (req, res) => {
  const userId = currentUser(req).id;
  const latest = await Promise.all(
    vitalTypes.options.map((type) => prisma.vitalReading.findFirst({ where: { userId, type }, orderBy: { recordedAt: 'desc' } })),
  );
  res.json({ latest: Object.fromEntries(vitalTypes.options.map((type, i) => [type, latest[i]])) });
});

/** POST /vitals - manual entry from the app. */
vitalsRouter.post('/', async (req, res) => {
  const body = z
    .object({
      type: vitalTypes,
      systolic: z.number().int().min(30).max(300).optional(),
      diastolic: z.number().int().min(20).max(200).optional(),
      pulse: z.number().int().min(20).max(250).optional(),
      value: z.number().optional(),
      unit: z.string().max(16).optional(),
      recordedAt: isoDateSchema.optional(),
      meta: jsonObjectSchema.optional(),
    })
    .parse(req.body);
  if (body.type === 'BLOOD_PRESSURE' && (body.systolic === undefined || body.diastolic === undefined)) {
    throw ApiError.badRequest('Blood pressure readings need systolic and diastolic');
  }
  if (body.type !== 'BLOOD_PRESSURE' && body.value === undefined) throw ApiError.badRequest('value is required');
  const reading = await recordVital(currentUser(req).id, body, { source: 'MANUAL' });
  res.status(201).json({ reading });
});

/** DELETE /vitals/:id */
vitalsRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const deleted = await prisma.vitalReading.deleteMany({ where: { id, userId: currentUser(req).id } });
  if (deleted.count === 0) throw ApiError.notFound('Reading');
  res.status(204).end();
});
