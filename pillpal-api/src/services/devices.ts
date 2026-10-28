import { prisma } from '../lib/prisma';
import type { Device, Prisma } from '../generated/prisma/client';
import { config } from '../config';
import { ApiError } from '../lib/errors';
import { generateClaimCode, generateDeviceApiKey, sha256 } from '../lib/crypto';
import { notify, notifyCaregivers } from './notifications';

export const SLOT_COUNT = 5;

/**
 * Register (or re-register) a Raspberry Pi. Called by the Pi on first boot with the
 * shared provisioning key. Returns the plain API key exactly once.
 */
export async function registerDevice(input: { serialNumber: string; firmwareVersion?: string; model?: string }) {
  const apiKey = generateDeviceApiKey();
  const claimCode = generateClaimCode();
  const claimCodeExpiresAt = new Date(Date.now() + config.CLAIM_CODE_TTL_MINUTES * 60_000);

  const existing = await prisma.device.findUnique({ where: { serialNumber: input.serialNumber } });

  const device = existing
    ? await prisma.device.update({
        where: { id: existing.id },
        data: {
          apiKeyHash: sha256(apiKey), // re-registering rotates the key (the Pi lost its config)
          firmwareVersion: input.firmwareVersion ?? existing.firmwareVersion,
          model: input.model ?? existing.model,
          lastSeenAt: new Date(),
          ...(existing.ownerId ? {} : { claimCode, claimCodeExpiresAt }),
        },
      })
    : await prisma.device.create({
        data: {
          serialNumber: input.serialNumber,
          apiKeyHash: sha256(apiKey),
          firmwareVersion: input.firmwareVersion,
          model: input.model,
          claimCode,
          claimCodeExpiresAt,
          lastSeenAt: new Date(),
          slots: { create: Array.from({ length: SLOT_COUNT }, (_, i) => ({ index: i + 1 })) },
        },
      });

  return { device, apiKey };
}

/** Issue a fresh claim code for an unclaimed device (the Pi calls this when the old one expired). */
export async function refreshClaimCode(deviceId: string) {
  const device = await prisma.device.findUnique({ where: { id: deviceId } });
  if (!device) throw ApiError.notFound('Device');
  if (device.ownerId) throw ApiError.conflict('Device is already claimed');
  return prisma.device.update({
    where: { id: deviceId },
    data: { claimCode: generateClaimCode(), claimCodeExpiresAt: new Date(Date.now() + config.CLAIM_CODE_TTL_MINUTES * 60_000) },
  });
}

/** Link a device to the user who typed its claim code into the app. */
export async function claimDevice(userId: string, claimCode: string, name?: string) {
  const device = await prisma.device.findUnique({ where: { claimCode: claimCode.toUpperCase().trim() } });
  if (!device) throw ApiError.notFound('No device with that claim code');
  if (device.ownerId) throw ApiError.conflict('Device is already claimed');
  if (device.claimCodeExpiresAt && device.claimCodeExpiresAt < new Date()) {
    throw new ApiError(410, 'CLAIM_CODE_EXPIRED', 'Claim code expired. Ask the dispenser for a new one.');
  }
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });

  return prisma.device.update({
    where: { id: device.id },
    data: {
      ownerId: userId,
      name: name?.trim() || device.name,
      claimCode: null,
      claimCodeExpiresAt: null,
      claimedAt: new Date(),
      status: device.lastSeenAt && Date.now() - device.lastSeenAt.getTime() < config.DEVICE_OFFLINE_AFTER_MINUTES * 60_000 ? 'ONLINE' : 'OFFLINE',
      settings: { ...(device.settings as object), timezone: user.timezone },
    },
    include: { slots: { orderBy: { index: 'asc' } } },
  });
}

/** Unlink a device from its owner (factory-reset from the app's point of view). */
export async function unclaimDevice(deviceId: string) {
  await prisma.$transaction([
    prisma.slot.updateMany({ where: { deviceId }, data: { medicationId: null, pillCount: 0, lowStockNotifiedAt: null } }),
    prisma.deviceCommand.updateMany({ where: { deviceId, status: 'PENDING' }, data: { status: 'EXPIRED' } }),
    prisma.doseEvent.updateMany({ where: { deviceId, status: 'SCHEDULED' }, data: { deviceId: null, slotId: null } }),
    prisma.device.update({
      where: { id: deviceId },
      data: {
        ownerId: null,
        status: 'UNCLAIMED',
        claimedAt: null,
        claimCode: generateClaimCode(),
        claimCodeExpiresAt: new Date(Date.now() + config.CLAIM_CODE_TTL_MINUTES * 60_000),
      },
    }),
  ]);
}

/**
 * Record that the device is alive. Flips OFFLINE -> ONLINE and tells the owner
 * if the device had been reported offline.
 */
export async function touchDevice(device: Device, patch: Prisma.DeviceUpdateInput = {}) {
  const wasOffline = device.status === 'OFFLINE';
  const updated = await prisma.device.update({
    where: { id: device.id },
    data: {
      ...patch,
      lastSeenAt: new Date(),
      status: device.ownerId ? 'ONLINE' : 'UNCLAIMED',
      offlineNotifiedAt: null,
    },
  });
  if (wasOffline && device.ownerId && device.offlineNotifiedAt) {
    await notify(device.ownerId, {
      type: 'DEVICE_ONLINE',
      title: `${device.name} is back online`,
      body: 'Your dispenser reconnected to PillPal.',
      data: { deviceId: device.id },
      respectQuietHours: true,
    });
  }
  return updated;
}

/** Mark devices that stopped syncing as OFFLINE and alert their owners (scheduler job). */
export async function markOfflineDevices(now = new Date()) {
  const cutoff = new Date(now.getTime() - config.DEVICE_OFFLINE_AFTER_MINUTES * 60_000);
  const stale = await prisma.device.findMany({
    where: { status: 'ONLINE', OR: [{ lastSeenAt: { lt: cutoff } }, { lastSeenAt: null }] },
  });
  for (const device of stale) {
    await prisma.device.update({ where: { id: device.id }, data: { status: 'OFFLINE', offlineNotifiedAt: now } });
    if (!device.ownerId) continue;
    const payload = {
      type: 'DEVICE_OFFLINE' as const,
      title: `${device.name} is offline`,
      body: `Your dispenser has not checked in for ${config.DEVICE_OFFLINE_AFTER_MINUTES} minutes. Check its power and Wi-Fi.`,
      data: { deviceId: device.id, lastSeenAt: device.lastSeenAt?.toISOString() ?? null },
    };
    await notify(device.ownerId, payload);
    await notifyCaregivers(device.ownerId, 'notifyDeviceIssues', payload);
  }
  return stale.length;
}

/** Everything the Pi needs to run on its own until the next sync. */
export async function buildSyncPayload(deviceId: string, now = new Date()) {
  const device = await prisma.device.findUniqueOrThrow({
    where: { id: deviceId },
    include: {
      owner: { select: { id: true, firstName: true, lastName: true, timezone: true, settings: true } },
      slots: { orderBy: { index: 'asc' }, include: { medication: true } },
    },
  });

  const timezone = device.owner?.timezone ?? 'UTC';
  const medicationIds = device.slots.map((s) => s.medicationId).filter((id): id is string => !!id);

  const [schedules, upcomingDoses, recentDoses, pendingCommands] = device.owner
    ? await Promise.all([
        prisma.schedule.findMany({
          where: { userId: device.owner.id, isActive: true, medicationId: { in: medicationIds } },
          orderBy: [{ timeOfDay: 'asc' }],
        }),
        prisma.doseEvent.findMany({
          where: {
            userId: device.owner.id,
            deviceId,
            source: 'SCHEDULE', // remote/on-demand doses are driven by DISPENSE commands, not by this list
            status: { in: ['SCHEDULED', 'DISPENSED', 'FAILED'] },
            scheduledAt: { gte: new Date(now.getTime() - 24 * 3_600_000), lte: new Date(now.getTime() + 48 * 3_600_000) },
          },
          orderBy: { scheduledAt: 'asc' },
          include: { slot: { select: { index: true } }, medication: { select: { name: true, strength: true } } },
        }),
        prisma.doseEvent.findMany({
          where: { userId: device.owner.id, scheduledAt: { gte: new Date(now.getTime() - 24 * 3_600_000), lte: now }, status: { in: ['TAKEN', 'MISSED', 'SKIPPED'] } },
          orderBy: { scheduledAt: 'desc' },
          take: 20,
          include: { slot: { select: { index: true } }, medication: { select: { name: true } } },
        }),
        prisma.deviceCommand.findMany({ where: { deviceId, status: 'PENDING', expiresAt: { gt: now } }, orderBy: { createdAt: 'asc' } }),
      ])
    : [[], [], [], []];

  if (pendingCommands.length > 0) {
    await prisma.deviceCommand.updateMany({
      where: { id: { in: pendingCommands.map((c) => c.id) } },
      data: { status: 'SENT', sentAt: now },
    });
  }

  return {
    serverTime: now.toISOString(),
    syncIntervalSeconds: 30,
    device: {
      id: device.id,
      name: device.name,
      status: device.status,
      claimed: !!device.ownerId,
      claimCode: device.ownerId ? null : device.claimCode,
      timezone,
      settings: device.settings,
    },
    owner: device.owner
      ? {
          id: device.owner.id,
          firstName: device.owner.firstName,
          lastName: device.owner.lastName,
          timezone: device.owner.timezone,
          requireTakenConfirmation: device.owner.settings?.requireTakenConfirmation ?? false,
        }
      : null,
    slots: device.slots.map((s) => ({
      index: s.index,
      slotId: s.id,
      pillCount: s.pillCount,
      capacity: s.capacity,
      lastWeightGrams: s.lastWeightGrams,
      calibration: s.calibration,
      medication: s.medication
        ? {
            id: s.medication.id,
            name: s.medication.name,
            strength: s.medication.strength,
            form: s.medication.form,
            pillWeightMg: s.medication.pillWeightMg,
            instructions: s.medication.instructions,
          }
        : null,
    })),
    schedules: schedules.map((s) => ({
      id: s.id,
      medicationId: s.medicationId,
      slotIndex: device.slots.find((slot) => slot.medicationId === s.medicationId)?.index ?? null,
      label: s.label,
      timeOfDay: s.timeOfDay,
      daysOfWeek: s.daysOfWeek,
      quantity: s.quantity,
      graceMinutes: s.graceMinutes,
      startDate: s.startDate?.toISOString().slice(0, 10) ?? null,
      endDate: s.endDate?.toISOString().slice(0, 10) ?? null,
    })),
    upcomingDoses: upcomingDoses.map((d) => ({
      id: d.id,
      medicationId: d.medicationId,
      medicationName: d.medication.name,
      strength: d.medication.strength,
      slotIndex: d.slot?.index ?? null,
      quantity: d.quantity,
      scheduledAt: d.scheduledAt.toISOString(),
      windowEndsAt: d.windowEndsAt.toISOString(),
      status: d.status,
    })),
    recentDoses: recentDoses.map((d) => ({
      id: d.id,
      medicationName: d.medication.name,
      slotIndex: d.slot?.index ?? null,
      scheduledAt: d.scheduledAt.toISOString(),
      status: d.status,
      takenAt: d.takenAt?.toISOString() ?? null,
    })),
    pendingCommands: pendingCommands.map((c) => ({ id: c.id, type: c.type, payload: c.payload, createdAt: c.createdAt.toISOString() })),
  };
}

export type SyncPayload = Awaited<ReturnType<typeof buildSyncPayload>>;

/** Expire commands the device never picked up (scheduler job). */
export async function expireStaleCommands(now = new Date()) {
  const result = await prisma.deviceCommand.updateMany({
    where: { status: 'PENDING', expiresAt: { lt: now } },
    data: { status: 'EXPIRED' },
  });
  return result.count;
}
