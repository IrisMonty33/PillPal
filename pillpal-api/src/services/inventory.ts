import { prisma } from '../lib/prisma';
import type { InventoryReason } from '../generated/prisma/client';
import { notify, notifyCaregivers } from './notifications';

/**
 * Slot pill-count bookkeeping + LOW_STOCK alerts.
 * Every change is written to `inventory_events` so the app can show a history.
 */

export async function adjustSlotCount(
  slotId: string,
  delta: number,
  reason: InventoryReason,
  userId?: string | null,
) {
  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) return null;

  const countAfter = Math.max(0, slot.pillCount + delta);
  const updated = await prisma.slot.update({
    where: { id: slotId },
    data: {
      pillCount: countAfter,
      // A refill clears the "already warned" flag so the next low point warns again.
      ...(delta > 0 ? { lowStockNotifiedAt: null } : {}),
    },
  });

  await prisma.inventoryEvent.create({
    data: { slotId, medicationId: slot.medicationId, userId: userId ?? null, reason, delta, countAfter },
  });

  return updated;
}

/** Set the absolute pill count (used when the user refills or the device recounts with the scale). */
export async function setSlotCount(slotId: string, pillCount: number, reason: InventoryReason, userId?: string | null) {
  const slot = await prisma.slot.findUnique({ where: { id: slotId } });
  if (!slot) return null;
  return adjustSlotCount(slotId, pillCount - slot.pillCount, reason, userId);
}

/** Send a LOW_STOCK alert (once per refill cycle) if the slot is at/below the medication's threshold. */
export async function checkLowStock(slotId: string) {
  const slot = await prisma.slot.findUnique({
    where: { id: slotId },
    include: { medication: true, device: true },
  });
  if (!slot || !slot.medication || !slot.device.ownerId) return false;
  if (slot.lowStockNotifiedAt) return false;
  if (slot.pillCount > slot.medication.refillThreshold) return false;

  const title = slot.pillCount === 0 ? `${slot.medication.name} is empty` : `${slot.medication.name} is running low`;
  const body =
    slot.pillCount === 0
      ? `Slot ${slot.index} of ${slot.device.name} is empty. Refill it to keep your schedule going.`
      : `Only ${slot.pillCount} left in slot ${slot.index} of ${slot.device.name}. Time to refill.`;
  const data = { deviceId: slot.deviceId, slotIndex: slot.index, medicationId: slot.medicationId, pillCount: slot.pillCount };

  await notify(slot.device.ownerId, { type: 'LOW_STOCK', title, body, data });
  await notifyCaregivers(slot.device.ownerId, 'notifyLowStock', {
    type: 'LOW_STOCK',
    title,
    body,
    data,
  });
  await prisma.slot.update({ where: { id: slotId }, data: { lowStockNotifiedAt: new Date() } });
  return true;
}
