import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentDevice, requireDevice, requireProvisioningKey } from '../middleware/auth';
import { idParam, isoDateSchema, jsonObjectSchema, slotIndexSchema } from '../lib/validation';
import { buildSyncPayload, refreshClaimCode, registerDevice, touchDevice } from '../services/devices';
import { markDispensed, markFailed, markSkipped, markTaken } from '../services/doseEngine';
import { checkLowStock, setSlotCount } from '../services/inventory';
import { recordVital } from '../services/vitals';

/**
 * Endpoints used by the Raspberry Pi firmware. Base path: /api/v1/device
 * Authentication: `X-Device-Key: pp_dev_...` (returned once by /register).
 */
export const deviceRouter = Router();

/**
 * POST /device/register  (header X-Provisioning-Key)
 * First-boot registration. Returns the API key (store it on the Pi!) and the claim code
 * to show on the touchscreen. Calling it again for the same serial rotates the key.
 */
deviceRouter.post('/register', requireProvisioningKey, async (req, res) => {
  const body = z
    .object({
      serialNumber: z.string().trim().min(3).max(64),
      firmwareVersion: z.string().trim().max(40).optional(),
      model: z.string().trim().max(60).optional(),
    })
    .parse(req.body);
  const { device, apiKey } = await registerDevice(body);
  res.status(201).json({
    deviceId: device.id,
    apiKey,
    claimed: !!device.ownerId,
    claimCode: device.claimCode,
    claimCodeExpiresAt: device.claimCodeExpiresAt,
    syncIntervalSeconds: 30,
  });
});

deviceRouter.use(requireDevice);

/** GET /device/claim-status - poll this while showing the claim code. */
deviceRouter.get('/claim-status', async (req, res) => {
  let device = currentDevice(req);
  if (!device.ownerId && (!device.claimCode || (device.claimCodeExpiresAt && device.claimCodeExpiresAt < new Date()))) {
    device = await refreshClaimCode(device.id);
  }
  await touchDevice(device);
  const owner = device.ownerId ? await prisma.user.findUnique({ where: { id: device.ownerId }, select: { firstName: true, timezone: true } }) : null;
  res.json({ claimed: !!device.ownerId, claimCode: device.ownerId ? null : device.claimCode, claimCodeExpiresAt: device.claimCodeExpiresAt, owner });
});

/** POST /device/claim-code - force a fresh claim code. */
deviceRouter.post('/claim-code', async (req, res) => {
  const device = await refreshClaimCode(currentDevice(req).id);
  res.json({ claimCode: device.claimCode, claimCodeExpiresAt: device.claimCodeExpiresAt });
});

const syncBody = z.object({
  firmwareVersion: z.string().trim().max(40).optional(),
  ipAddress: z.string().trim().max(64).optional(),
  uptimeSeconds: z.number().int().min(0).optional(),
  /** Current load-cell readings / counts per slot, if available. */
  slots: z
    .array(
      z.object({
        index: slotIndexSchema,
        weightGrams: z.number().min(0).optional(),
        pillCount: z.number().int().min(0).optional(),
      }),
    )
    .optional(),
  meta: jsonObjectSchema.optional(),
});

/**
 * POST /device/sync - heartbeat + full state download. Call every ~30 seconds.
 * Body is optional. GET /device/sync does the same without a heartbeat body.
 */
async function handleSync(req: Parameters<typeof currentDevice>[0], body: z.infer<typeof syncBody>) {
  const device = currentDevice(req);
  await touchDevice(device, {
    ...(body.firmwareVersion ? { firmwareVersion: body.firmwareVersion } : {}),
    ...(body.ipAddress ? { ipAddress: body.ipAddress } : {}),
  });

  if (body.slots?.length) {
    const slots = await prisma.slot.findMany({ where: { deviceId: device.id } });
    for (const s of body.slots) {
      const slot = slots.find((x) => x.index === s.index);
      if (!slot) continue;
      if (s.weightGrams !== undefined) {
        await prisma.slot.update({ where: { id: slot.id }, data: { lastWeightGrams: s.weightGrams } });
        await prisma.sensorReading.create({ data: { deviceId: device.id, slotId: slot.id, type: 'WEIGHT', value: s.weightGrams, unit: 'g' } });
      }
      if (s.pillCount !== undefined && s.pillCount !== slot.pillCount) {
        await setSlotCount(slot.id, s.pillCount, 'ADJUSTMENT');
        await checkLowStock(slot.id);
      }
    }
  }
  return buildSyncPayload(device.id);
}

deviceRouter.post('/sync', async (req, res) => {
  res.json(await handleSync(req, syncBody.parse(req.body ?? {})));
});
deviceRouter.get('/sync', async (req, res) => {
  res.json(await handleSync(req, {}));
});

/** POST /device/heartbeat - lightweight "I'm alive" without downloading state. */
deviceRouter.post('/heartbeat', async (req, res) => {
  const body = syncBody.pick({ firmwareVersion: true, ipAddress: true }).parse(req.body ?? {});
  const device = await touchDevice(currentDevice(req), body);
  res.json({ ok: true, serverTime: new Date().toISOString(), claimed: !!device.ownerId });
});

/** POST /device/doses/:id/dispensed - pills left the hopper (break-beam counted them). */
deviceRouter.post('/doses/:id/dispensed', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({
      dispensedAt: isoDateSchema.optional(),
      detectedCount: z.number().int().min(0).optional(),
      weightBeforeGrams: z.number().min(0).optional(),
      weightAfterGrams: z.number().min(0).optional(),
      slotIndex: slotIndexSchema.optional(),
    })
    .parse(req.body ?? {});
  const device = currentDevice(req);
  await assertDoseBelongsToOwner(id, device.ownerId);
  const slot = body.slotIndex ? await prisma.slot.findUnique({ where: { deviceId_index: { deviceId: device.id, index: body.slotIndex } } }) : null;
  const dose = await markDispensed(id, { deviceId: device.id, slotId: slot?.id, ...body });
  res.json({ dose });
});

/** POST /device/doses/:id/taken - user confirmed on the touchscreen / tray sensor saw the pills removed. */
deviceRouter.post('/doses/:id/taken', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ takenAt: isoDateSchema.optional(), method: z.string().max(40).optional() }).parse(req.body ?? {});
  await assertDoseBelongsToOwner(id, currentDevice(req).ownerId);
  const dose = await markTaken(id, { takenAt: body.takenAt, notes: body.method ? `confirmed via ${body.method}` : undefined });
  res.json({ dose });
});

/** POST /device/doses/:id/skipped */
deviceRouter.post('/doses/:id/skipped', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ reason: z.string().max(200).optional() }).parse(req.body ?? {});
  await assertDoseBelongsToOwner(id, currentDevice(req).ownerId);
  res.json({ dose: await markSkipped(id, { reason: body.reason ?? 'skipped on device' }) });
});

/** POST /device/doses/:id/failed { reason } - jam, empty hopper, sensor timeout... Alerts the user. */
deviceRouter.post('/doses/:id/failed', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ reason: z.string().trim().min(1).max(200), code: z.string().max(40).optional() }).parse(req.body);
  const device = currentDevice(req);
  await assertDoseBelongsToOwner(id, device.ownerId);
  await prisma.deviceEvent.create({ data: { deviceId: device.id, level: 'ERROR', type: body.code ?? 'DISPENSE_FAILED', message: body.reason, data: { doseEventId: id } } });
  res.json({ dose: await markFailed(id, { deviceId: device.id, reason: body.reason }) });
});

/** POST /device/doses/manual - the user pressed "dispense now" on the touchscreen. */
deviceRouter.post('/doses/manual', async (req, res) => {
  const body = z
    .object({
      slotIndex: slotIndexSchema,
      quantity: z.number().int().min(1).max(20).default(1),
      dispensedAt: isoDateSchema.optional(),
      detectedCount: z.number().int().min(0).optional(),
    })
    .parse(req.body);
  const device = currentDevice(req);
  if (!device.ownerId) throw ApiError.conflict('Device is not claimed yet');
  const slot = await prisma.slot.findUnique({ where: { deviceId_index: { deviceId: device.id, index: body.slotIndex } } });
  if (!slot?.medicationId) throw ApiError.unprocessable(`Slot ${body.slotIndex} has no medication loaded`);

  const at = body.dispensedAt ?? new Date();
  const created = await prisma.doseEvent.create({
    data: {
      userId: device.ownerId,
      medicationId: slot.medicationId,
      deviceId: device.id,
      slotId: slot.id,
      scheduledAt: at,
      windowEndsAt: at,
      quantity: body.quantity,
      status: 'SCHEDULED',
      source: 'DEVICE',
    },
  });
  const dose = await markDispensed(created.id, { deviceId: device.id, slotId: slot.id, dispensedAt: at, detectedCount: body.detectedCount });
  res.status(201).json({ dose });
});

/** POST /device/events - one event or an array (batch upload after being offline). */
deviceRouter.post('/events', async (req, res) => {
  const eventSchema = z.object({
    level: z.enum(['INFO', 'WARN', 'ERROR']).default('INFO'),
    type: z.string().trim().min(1).max(60),
    message: z.string().max(500).optional(),
    data: jsonObjectSchema.optional(),
    occurredAt: isoDateSchema.optional(),
  });
  const events = z.union([eventSchema, z.array(eventSchema).min(1).max(500)]).parse(req.body);
  const list = Array.isArray(events) ? events : [events];
  const device = currentDevice(req);
  const result = await prisma.deviceEvent.createMany({
    data: list.map((e) => ({ deviceId: device.id, level: e.level, type: e.type, message: e.message, data: e.data, occurredAt: e.occurredAt ?? new Date() })),
  });
  res.status(201).json({ created: result.count });
});

/** POST /device/readings - sensor samples (load cell, break beam, temperature...). One object or an array. */
deviceRouter.post('/readings', async (req, res) => {
  const readingSchema = z.object({
    type: z.enum(['WEIGHT', 'BREAK_BEAM', 'TEMPERATURE', 'HUMIDITY', 'BATTERY', 'OTHER']),
    value: z.number(),
    unit: z.string().max(16).optional(),
    slotIndex: slotIndexSchema.optional(),
    meta: jsonObjectSchema.optional(),
    recordedAt: isoDateSchema.optional(),
  });
  const readings = z.union([readingSchema, z.array(readingSchema).min(1).max(1000)]).parse(req.body);
  const list = Array.isArray(readings) ? readings : [readings];
  const device = currentDevice(req);
  const slots = await prisma.slot.findMany({ where: { deviceId: device.id } });

  const result = await prisma.sensorReading.createMany({
    data: list.map((r) => ({
      deviceId: device.id,
      slotId: r.slotIndex ? (slots.find((s) => s.index === r.slotIndex)?.id ?? null) : null,
      type: r.type,
      value: r.value,
      unit: r.unit,
      meta: r.meta,
      recordedAt: r.recordedAt ?? new Date(),
    })),
  });

  // Keep the slot's latest weight handy for the app.
  for (const r of list) {
    if (r.type === 'WEIGHT' && r.slotIndex) {
      const slot = slots.find((s) => s.index === r.slotIndex);
      if (slot) await prisma.slot.update({ where: { id: slot.id }, data: { lastWeightGrams: r.value } });
    }
  }
  res.status(201).json({ created: result.count });
});

/** POST /device/vitals - a reading the Pi captured (e.g. from the BLE blood-pressure cuff). */
deviceRouter.post('/vitals', async (req, res) => {
  const body = z
    .object({
      type: z.enum(['BLOOD_PRESSURE', 'HEART_RATE', 'SPO2', 'TEMPERATURE', 'WEIGHT', 'GLUCOSE']),
      systolic: z.number().int().min(30).max(300).optional(),
      diastolic: z.number().int().min(20).max(200).optional(),
      pulse: z.number().int().min(20).max(250).optional(),
      value: z.number().optional(),
      unit: z.string().max(16).optional(),
      recordedAt: isoDateSchema.optional(),
      meta: jsonObjectSchema.optional(),
    })
    .parse(req.body);
  const device = currentDevice(req);
  if (!device.ownerId) throw ApiError.conflict('Device is not claimed yet');
  if (body.type === 'BLOOD_PRESSURE' && (body.systolic === undefined || body.diastolic === undefined)) {
    throw ApiError.badRequest('Blood pressure readings need systolic and diastolic');
  }
  const reading = await recordVital(device.ownerId, body, { source: 'DEVICE', deviceId: device.id });
  res.status(201).json({ reading });
});

/** POST /device/slots/:index/count { pillCount } - device recounted the hopper (e.g. with the scale). */
deviceRouter.post('/slots/:index/count', async (req, res) => {
  const index = slotIndexSchema.parse(req.params.index);
  const body = z.object({ pillCount: z.number().int().min(0).max(1000), weightGrams: z.number().min(0).optional() }).parse(req.body);
  const device = currentDevice(req);
  const slot = await prisma.slot.findUnique({ where: { deviceId_index: { deviceId: device.id, index } } });
  if (!slot) throw ApiError.notFound('Slot');
  await setSlotCount(slot.id, body.pillCount, 'ADJUSTMENT');
  if (body.weightGrams !== undefined) await prisma.slot.update({ where: { id: slot.id }, data: { lastWeightGrams: body.weightGrams } });
  await checkLowStock(slot.id);
  res.json({ slot: await prisma.slot.findUnique({ where: { id: slot.id } }) });
});

/** PATCH /device/slots/:index/calibration - store servo/scale calibration values. */
deviceRouter.patch('/slots/:index/calibration', async (req, res) => {
  const index = slotIndexSchema.parse(req.params.index);
  const body = jsonObjectSchema.parse(req.body);
  const device = currentDevice(req);
  const slot = await prisma.slot.findUnique({ where: { deviceId_index: { deviceId: device.id, index } } });
  if (!slot) throw ApiError.notFound('Slot');
  const updated = await prisma.slot.update({ where: { id: slot.id }, data: { calibration: { ...(slot.calibration as object), ...body } } });
  res.json({ slot: updated });
});

/** POST /device/commands/:id/ack - optional explicit "received" (sync already marks commands SENT). */
deviceRouter.post('/commands/:id/ack', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const device = currentDevice(req);
  const command = await prisma.deviceCommand.findFirst({ where: { id, deviceId: device.id } });
  if (!command) throw ApiError.notFound('Command');
  if (command.status === 'PENDING') await prisma.deviceCommand.update({ where: { id }, data: { status: 'SENT', sentAt: new Date() } });
  res.json({ ok: true });
});

/** POST /device/commands/:id/complete { success, result?, error? } */
deviceRouter.post('/commands/:id/complete', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z.object({ success: z.boolean(), result: jsonObjectSchema.optional(), error: z.string().max(300).optional() }).parse(req.body);
  const device = currentDevice(req);
  const command = await prisma.deviceCommand.findFirst({ where: { id, deviceId: device.id } });
  if (!command) throw ApiError.notFound('Command');

  const updated = await prisma.deviceCommand.update({
    where: { id },
    data: { status: body.success ? 'COMPLETED' : 'FAILED', result: body.result, error: body.error, completedAt: new Date() },
  });

  // A remote DISPENSE completes its dose automatically (or fails it so the user gets alerted).
  const payload = command.payload as { doseEventId?: string; slotIndex?: number } | null;
  if (command.type === 'DISPENSE' && payload?.doseEventId) {
    if (body.success) {
      const detected = typeof body.result?.detectedCount === 'number' ? body.result.detectedCount : undefined;
      await markDispensed(payload.doseEventId, { deviceId: device.id, detectedCount: detected }).catch(() => undefined);
    } else {
      await markFailed(payload.doseEventId, { deviceId: device.id, reason: body.error ?? 'dispense command failed' }).catch(() => undefined);
    }
  }
  res.json({ command: updated });
});

/** The dose being reported must belong to this device's owner. */
async function assertDoseBelongsToOwner(doseEventId: string, ownerId: string | null) {
  if (!ownerId) throw ApiError.conflict('Device is not claimed yet');
  const dose = await prisma.doseEvent.findUnique({ where: { id: doseEventId }, select: { userId: true } });
  if (!dose || dose.userId !== ownerId) throw ApiError.notFound('Dose');
}
