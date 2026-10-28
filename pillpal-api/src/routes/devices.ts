import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { config } from '../config';
import { currentUser, requireUser } from '../middleware/auth';
import { idParam, jsonObjectSchema, paginationSchema, slotIndexSchema } from '../lib/validation';
import { claimDevice, unclaimDevice } from '../services/devices';
import { adjustSlotCount, checkLowStock, setSlotCount } from '../services/inventory';
import { relinkFutureDoses } from '../services/doseEngine';

/**
 * App-side device management (the user's phone talks to these).
 * The Raspberry Pi itself uses /api/v1/device/* (singular) - see routes/device.ts.
 */
export const devicesRouter = Router();
devicesRouter.use(requireUser);

const deviceInclude = {
  slots: {
    orderBy: { index: 'asc' as const },
    include: { medication: { select: { id: true, name: true, strength: true, form: true, refillThreshold: true } } },
  },
};

async function ownedDevice(req: Parameters<typeof currentUser>[0], id: string) {
  const device = await prisma.device.findFirst({ where: { id, ownerId: currentUser(req).id }, include: deviceInclude });
  if (!device) throw ApiError.notFound('Device');
  return device;
}

function withOnlineFlag<T extends { lastSeenAt: Date | null; status: string }>(device: T) {
  const isOnline = !!device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() < config.DEVICE_OFFLINE_AFTER_MINUTES * 60_000;
  return { ...device, isOnline };
}

/** POST /devices/claim { claimCode, name? } - link the dispenser showing this code to my account. */
devicesRouter.post('/claim', async (req, res) => {
  const body = z.object({ claimCode: z.string().trim().min(4).max(12), name: z.string().trim().max(60).optional() }).parse(req.body);
  const device = await claimDevice(currentUser(req).id, body.claimCode, body.name);
  res.status(201).json({ device: withOnlineFlag(device) });
});

/** GET /devices */
devicesRouter.get('/', async (req, res) => {
  const devices = await prisma.device.findMany({ where: { ownerId: currentUser(req).id }, include: deviceInclude, orderBy: { createdAt: 'asc' } });
  res.json({ devices: devices.map(withOnlineFlag) });
});

/** GET /devices/:id */
devicesRouter.get('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  res.json({ device: withOnlineFlag(await ownedDevice(req, id)) });
});

/** PATCH /devices/:id { name?, settings? } - settings are merged and pushed to the Pi on its next sync. */
devicesRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ name: z.string().trim().min(1).max(60).optional(), settings: jsonObjectSchema.optional() }).parse(req.body);
  const device = await ownedDevice(req, id);
  const updated = await prisma.device.update({
    where: { id },
    data: {
      ...(body.name ? { name: body.name } : {}),
      ...(body.settings ? { settings: { ...(device.settings as object), ...body.settings } } : {}),
    },
    include: deviceInclude,
  });
  res.json({ device: withOnlineFlag(updated) });
});

/** DELETE /devices/:id - unlink the dispenser from my account (it shows a new claim code). */
devicesRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  await ownedDevice(req, id);
  await unclaimDevice(id);
  res.status(204).end();
});

/**
 * PUT /devices/:id/slots/:index { medicationId | null, pillCount?, capacity? }
 * Load a medication into a hopper slot (or empty it with medicationId: null).
 */
devicesRouter.put('/:id/slots/:index', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const index = slotIndexSchema.parse(req.params.index);
  const body = z
    .object({
      medicationId: z.uuid().nullable(),
      pillCount: z.number().int().min(0).max(1000).optional(),
      capacity: z.number().int().min(1).max(1000).optional(),
    })
    .parse(req.body);
  const device = await ownedDevice(req, id);
  const slot = device.slots.find((s) => s.index === index);
  if (!slot) throw ApiError.notFound('Slot');

  if (body.medicationId) {
    const medication = await prisma.medication.findFirst({ where: { id: body.medicationId, userId: currentUser(req).id }, include: { slot: true } });
    if (!medication) throw ApiError.notFound('Medication');
    if (medication.slot && medication.slot.id !== slot.id) {
      // Move the medication: free the old slot first.
      await prisma.slot.update({ where: { id: medication.slot.id }, data: { medicationId: null, pillCount: 0, lowStockNotifiedAt: null } });
      await relinkFutureDoses(medication.id, null, null);
    }
  }

  const previousMedicationId = slot.medicationId;
  const updated = await prisma.slot.update({
    where: { id: slot.id },
    data: {
      medicationId: body.medicationId,
      ...(body.capacity !== undefined ? { capacity: body.capacity } : {}),
      ...(body.medicationId !== previousMedicationId ? { pillCount: 0, lowStockNotifiedAt: null } : {}),
    },
  });

  if (body.medicationId !== previousMedicationId && previousMedicationId) {
    await relinkFutureDoses(previousMedicationId, null, null);
  }
  if (body.medicationId) await relinkFutureDoses(body.medicationId, device.id, slot.id);
  if (body.pillCount !== undefined) await setSlotCount(slot.id, body.pillCount, body.medicationId !== previousMedicationId ? 'REFILL' : 'ADJUSTMENT', currentUser(req).id);

  const fresh = await prisma.slot.findUniqueOrThrow({ where: { id: updated.id }, include: deviceInclude.slots.include });
  res.json({ slot: fresh });
});

/** POST /devices/:id/slots/:index/refill { pillCount } (absolute) or { added } (relative) */
devicesRouter.post('/:id/slots/:index/refill', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const index = slotIndexSchema.parse(req.params.index);
  const body = z
    .object({ pillCount: z.number().int().min(0).max(1000).optional(), added: z.number().int().min(1).max(1000).optional() })
    .refine((b) => b.pillCount !== undefined || b.added !== undefined, { message: 'Provide pillCount or added' })
    .parse(req.body);
  const device = await ownedDevice(req, id);
  const slot = device.slots.find((s) => s.index === index);
  if (!slot) throw ApiError.notFound('Slot');
  if (!slot.medicationId) throw ApiError.unprocessable('Assign a medication to this slot before refilling it');

  const updated =
    body.pillCount !== undefined
      ? await setSlotCount(slot.id, body.pillCount, 'REFILL', currentUser(req).id)
      : await adjustSlotCount(slot.id, body.added as number, 'REFILL', currentUser(req).id);
  res.json({ slot: updated });
});

/** GET /devices/:id/slots/:index/inventory - refill / dispense history for one slot. */
devicesRouter.get('/:id/slots/:index/inventory', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const index = slotIndexSchema.parse(req.params.index);
  const { limit, offset } = paginationSchema.parse(req.query);
  const device = await ownedDevice(req, id);
  const slot = device.slots.find((s) => s.index === index);
  if (!slot) throw ApiError.notFound('Slot');
  const events = await prisma.inventoryEvent.findMany({ where: { slotId: slot.id }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset });
  res.json({ events });
});

const commandBody = z.discriminatedUnion('type', [
  z.object({ type: z.literal('DISPENSE'), slotIndex: slotIndexSchema, quantity: z.number().int().min(1).max(20).default(1) }),
  z.object({ type: z.literal('TEST_SLOT'), slotIndex: slotIndexSchema }),
  z.object({ type: z.literal('TARE_SCALE') }),
  z.object({ type: z.literal('CALIBRATE_SCALE'), slotIndex: slotIndexSchema.optional(), knownWeightGrams: z.number().positive() }),
  z.object({ type: z.literal('RING'), seconds: z.number().int().min(1).max(60).default(5) }),
  z.object({ type: z.literal('REBOOT') }),
  z.object({ type: z.literal('SYNC_NOW') }),
  z.object({ type: z.literal('UPDATE_SETTINGS'), settings: jsonObjectSchema }),
]);

/**
 * POST /devices/:id/commands - queue a command; the Pi receives it on its next sync.
 * A DISPENSE command also creates a DoseEvent (source REMOTE) so it shows up in history.
 */
devicesRouter.post('/:id/commands', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = commandBody.parse(req.body);
  const device = await ownedDevice(req, id);
  const { type, ...payload } = body;
  let doseEventId: string | undefined;

  if (type === 'DISPENSE') {
    const slot = device.slots.find((s) => s.index === body.slotIndex);
    if (!slot?.medicationId) throw ApiError.unprocessable(`Slot ${body.slotIndex} has no medication loaded`);
    const now = new Date();
    const dose = await prisma.doseEvent.create({
      data: {
        userId: currentUser(req).id,
        medicationId: slot.medicationId,
        deviceId: device.id,
        slotId: slot.id,
        scheduledAt: now,
        windowEndsAt: new Date(now.getTime() + config.COMMAND_TTL_MINUTES * 60_000),
        quantity: body.quantity,
        status: 'SCHEDULED',
        source: 'REMOTE',
      },
    });
    doseEventId = dose.id;
  }

  const command = await prisma.deviceCommand.create({
    data: {
      deviceId: device.id,
      type,
      payload: { ...payload, ...(doseEventId ? { doseEventId } : {}) },
      createdById: currentUser(req).id,
      expiresAt: new Date(Date.now() + config.COMMAND_TTL_MINUTES * 60_000),
    },
  });
  res.status(201).json({ command });
});

/** GET /devices/:id/commands */
devicesRouter.get('/:id/commands', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const { limit, offset } = paginationSchema.parse(req.query);
  await ownedDevice(req, id);
  const commands = await prisma.deviceCommand.findMany({ where: { deviceId: id }, orderBy: { createdAt: 'desc' }, take: limit, skip: offset });
  res.json({ commands });
});

/** GET /devices/:id/commands/:commandId - poll this after queuing a command to see the result. */
devicesRouter.get('/:id/commands/:commandId', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const commandId = z.uuid().parse(req.params.commandId);
  await ownedDevice(req, id);
  const command = await prisma.deviceCommand.findFirst({ where: { id: commandId, deviceId: id } });
  if (!command) throw ApiError.notFound('Command');
  res.json({ command });
});

/** GET /devices/:id/events - device log (boot, jams, dispenses...). */
devicesRouter.get('/:id/events', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const q = paginationSchema.extend({ level: z.enum(['INFO', 'WARN', 'ERROR']).optional() }).parse(req.query);
  await ownedDevice(req, id);
  const events = await prisma.deviceEvent.findMany({
    where: { deviceId: id, ...(q.level ? { level: q.level } : {}) },
    orderBy: { occurredAt: 'desc' },
    take: q.limit,
    skip: q.offset,
  });
  res.json({ events });
});

/** GET /devices/:id/readings?type=WEIGHT&slotIndex=1 - sensor time series for charts. */
devicesRouter.get('/:id/readings', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const q = paginationSchema
    .extend({ type: z.enum(['WEIGHT', 'BREAK_BEAM', 'TEMPERATURE', 'HUMIDITY', 'BATTERY', 'OTHER']).optional(), slotIndex: slotIndexSchema.optional() })
    .parse(req.query);
  const device = await ownedDevice(req, id);
  const slot = q.slotIndex ? device.slots.find((s) => s.index === q.slotIndex) : undefined;
  const readings = await prisma.sensorReading.findMany({
    where: { deviceId: id, ...(q.type ? { type: q.type } : {}), ...(slot ? { slotId: slot.id } : {}) },
    orderBy: { recordedAt: 'desc' },
    take: q.limit,
    skip: q.offset,
  });
  res.json({ readings });
});

/** POST /devices/:id/slots/:index/check-stock - re-evaluate the low-stock alert for a slot (mostly for testing). */
devicesRouter.post('/:id/slots/:index/check-stock', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const index = slotIndexSchema.parse(req.params.index);
  const device = await ownedDevice(req, id);
  const slot = device.slots.find((s) => s.index === index);
  if (!slot) throw ApiError.notFound('Slot');
  res.json({ alerted: await checkLowStock(slot.id) });
});
