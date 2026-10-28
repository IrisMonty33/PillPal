import { prisma } from '../lib/prisma';
import type { DoseEvent, DoseStatus, Prisma, Schedule } from '../generated/prisma/client';
import { config } from '../config';
import { ApiError } from '../lib/errors';
import {
  addDaysToDateString,
  addMinutes,
  localDateString,
  parseDateString,
  parseTimeOfDay,
  weekdayOfDateString,
  zonedTimeToUtc,
} from '../lib/time';
import { adjustSlotCount, checkLowStock } from './inventory';
import { notify, notifyCaregivers } from './notifications';

/**
 * The dose engine turns Schedules ("08:00 every day") into DoseEvents (one row per
 * occurrence) and owns every status transition. See the DoseStatus enum in
 * prisma/schema.prisma for the state machine.
 */

// ---------------------------------------------------------------------------
// Generating dose events from schedules
// ---------------------------------------------------------------------------

function dateOnly(d: Date | null): string | null {
  return d ? d.toISOString().slice(0, 10) : null;
}

/**
 * Compute the occurrences of one schedule between `from` and `to` (UTC instants),
 * using the user's timezone for the wall-clock time.
 */
export function occurrencesForSchedule(schedule: Schedule, timezone: string, from: Date, to: Date): Date[] {
  const { hour, minute } = parseTimeOfDay(schedule.timeOfDay);
  const start = dateOnly(schedule.startDate);
  const end = dateOnly(schedule.endDate);
  const result: Date[] = [];

  // Walk one calendar day before `from` to one day after `to` so timezone offsets never skip a day.
  let day = addDaysToDateString(localDateString(from, timezone), -1);
  const lastDay = addDaysToDateString(localDateString(to, timezone), 1);

  while (day <= lastDay) {
    const weekday = weekdayOfDateString(day);
    const matchesDay = schedule.daysOfWeek.length === 0 || schedule.daysOfWeek.includes(weekday);
    const afterStart = !start || day >= start;
    const beforeEnd = !end || day <= end;

    if (matchesDay && afterStart && beforeEnd) {
      const { year, month, day: d } = parseDateString(day);
      const at = zonedTimeToUtc(year, month, d, hour, minute, timezone);
      if (at >= from && at <= to) result.push(at);
    }
    day = addDaysToDateString(day, 1);
  }
  return result;
}

/** Create missing DoseEvents for every active schedule of one user, from `now` to `now + horizon`. */
export async function generateDoseEventsForUser(userId: string, now = new Date(), horizonHours = config.DOSE_GENERATION_HORIZON_HOURS) {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return 0;

  const schedules = await prisma.schedule.findMany({
    where: { userId, isActive: true, medication: { isActive: true } },
    include: { medication: { include: { slot: true } } },
  });
  if (schedules.length === 0) return 0;

  const to = new Date(now.getTime() + horizonHours * 3_600_000);
  const rows: Prisma.DoseEventCreateManyInput[] = [];

  for (const schedule of schedules) {
    const slot = schedule.medication.slot;
    for (const at of occurrencesForSchedule(schedule, user.timezone, now, to)) {
      rows.push({
        userId,
        medicationId: schedule.medicationId,
        scheduleId: schedule.id,
        deviceId: slot?.deviceId ?? null,
        slotId: slot?.id ?? null,
        scheduledAt: at,
        windowEndsAt: addMinutes(at, schedule.graceMinutes),
        quantity: schedule.quantity,
        status: 'SCHEDULED',
        source: 'SCHEDULE',
      });
    }
  }

  if (rows.length === 0) return 0;
  const result = await prisma.doseEvent.createMany({ data: rows, skipDuplicates: true });
  return result.count;
}

/** Generate dose events for every user that has an active schedule. Called by the scheduler job. */
export async function generateAllDoseEvents(now = new Date()) {
  const users = await prisma.user.findMany({
    where: { schedules: { some: { isActive: true } } },
    select: { id: true },
  });
  let created = 0;
  for (const user of users) created += await generateDoseEventsForUser(user.id, now);
  return created;
}

/**
 * After a schedule is created/edited/deactivated: drop its future SCHEDULED events and rebuild them.
 * Past events (history) are never touched.
 */
export async function regenerateScheduleDoses(scheduleId: string, now = new Date()) {
  const schedule = await prisma.schedule.findUnique({ where: { id: scheduleId } });
  if (!schedule) return;
  await prisma.doseEvent.deleteMany({ where: { scheduleId, status: 'SCHEDULED', scheduledAt: { gt: now } } });
  if (schedule.isActive) await generateDoseEventsForUser(schedule.userId, now);
}

/** When a medication's slot changes, point its upcoming doses at the new device/slot. */
export async function relinkFutureDoses(medicationId: string, deviceId: string | null, slotId: string | null) {
  await prisma.doseEvent.updateMany({
    where: { medicationId, status: 'SCHEDULED', scheduledAt: { gt: new Date() } },
    data: { deviceId, slotId },
  });
}

// ---------------------------------------------------------------------------
// Status transitions
// ---------------------------------------------------------------------------

const ALLOWED: Record<'DISPENSED' | 'TAKEN' | 'SKIPPED' | 'FAILED', DoseStatus[]> = {
  DISPENSED: ['SCHEDULED', 'FAILED', 'MISSED'],
  TAKEN: ['SCHEDULED', 'DISPENSED', 'MISSED', 'FAILED', 'SKIPPED'],
  SKIPPED: ['SCHEDULED', 'DISPENSED', 'FAILED', 'MISSED'],
  FAILED: ['SCHEDULED', 'DISPENSED'],
};

async function loadDose(doseEventId: string, userId?: string): Promise<DoseEvent> {
  const dose = await prisma.doseEvent.findUnique({ where: { id: doseEventId } });
  if (!dose || (userId && dose.userId !== userId)) throw ApiError.notFound('Dose');
  return dose;
}

function assertTransition(dose: DoseEvent, target: keyof typeof ALLOWED) {
  if (!ALLOWED[target].includes(dose.status)) {
    throw ApiError.conflict(`Cannot mark a ${dose.status} dose as ${target}`);
  }
}

export interface DispensedInput {
  deviceId: string;
  slotId?: string | null;
  dispensedAt?: Date;
  detectedCount?: number | null;
  weightBeforeGrams?: number | null;
  weightAfterGrams?: number | null;
}

/** The device dispensed the pills for this dose. Idempotent: reporting twice is harmless. */
export async function markDispensed(doseEventId: string, input: DispensedInput) {
  const dose = await loadDose(doseEventId);
  if (dose.status === 'DISPENSED' || (dose.status === 'TAKEN' && dose.dispensedAt)) return dose;
  assertTransition(dose, 'DISPENSED');

  const dispensedAt = input.dispensedAt ?? new Date();
  const settings = await prisma.notificationSettings.findUnique({ where: { userId: dose.userId } });
  const autoTaken = !(settings?.requireTakenConfirmation ?? false);

  const updated = await prisma.doseEvent.update({
    where: { id: doseEventId },
    data: {
      status: autoTaken ? 'TAKEN' : 'DISPENSED',
      dispensedAt,
      takenAt: autoTaken ? dispensedAt : null,
      deviceId: input.deviceId,
      slotId: input.slotId ?? dose.slotId,
      detectedCount: input.detectedCount ?? null,
      weightBeforeGrams: input.weightBeforeGrams ?? null,
      weightAfterGrams: input.weightAfterGrams ?? null,
      failureReason: null,
    },
  });

  const slotId = input.slotId ?? dose.slotId;
  if (slotId) {
    const pills = input.detectedCount && input.detectedCount > 0 ? input.detectedCount : dose.quantity;
    await adjustSlotCount(slotId, -pills, 'DISPENSE');
    await prisma.slot.update({ where: { id: slotId }, data: { lastDispensedAt: dispensedAt } });
    await checkLowStock(slotId);
  }
  return updated;
}

export async function markTaken(doseEventId: string, opts: { userId?: string; takenAt?: Date; notes?: string } = {}) {
  const dose = await loadDose(doseEventId, opts.userId);
  if (dose.status === 'TAKEN') return dose;
  assertTransition(dose, 'TAKEN');
  return prisma.doseEvent.update({
    where: { id: doseEventId },
    data: { status: 'TAKEN', takenAt: opts.takenAt ?? new Date(), notes: opts.notes ?? dose.notes },
  });
}

export async function markSkipped(doseEventId: string, opts: { userId?: string; reason?: string } = {}) {
  const dose = await loadDose(doseEventId, opts.userId);
  if (dose.status === 'SKIPPED') return dose;
  assertTransition(dose, 'SKIPPED');
  return prisma.doseEvent.update({
    where: { id: doseEventId },
    data: { status: 'SKIPPED', skippedAt: new Date(), notes: opts.reason ?? dose.notes },
  });
}

/** The device could not dispense (jam, empty hopper, sensor did not see a pill...). Alerts the user. */
export async function markFailed(doseEventId: string, opts: { deviceId: string; reason: string }) {
  const dose = await loadDose(doseEventId);
  if (dose.status === 'FAILED') return dose;
  assertTransition(dose, 'FAILED');

  const updated = await prisma.doseEvent.update({
    where: { id: doseEventId },
    data: { status: 'FAILED', failureReason: opts.reason, deviceId: opts.deviceId },
    include: { medication: true },
  });

  const payload = {
    type: 'DEVICE_ERROR' as const,
    title: `Could not dispense ${updated.medication.name}`,
    body: `Your PillPal reported a problem: ${opts.reason}. Please check the dispenser.`,
    data: { doseEventId, deviceId: opts.deviceId, medicationId: dose.medicationId },
  };
  await notify(dose.userId, payload);
  await notifyCaregivers(dose.userId, 'notifyDeviceIssues', payload);
  return updated;
}

// ---------------------------------------------------------------------------
// Adherence statistics
// ---------------------------------------------------------------------------

export interface AdherenceSummary {
  from: string;
  to: string;
  total: number;
  taken: number;
  missed: number;
  skipped: number;
  failed: number;
  pending: number;
  /** taken / (taken + missed + failed), as a 0-100 percentage. Null when nothing was due yet. */
  adherenceRate: number | null;
  currentStreakDays: number;
  byMedication: { medicationId: string; name: string; taken: number; missed: number; skipped: number; adherenceRate: number | null }[];
  byDay: { date: string; taken: number; missed: number; skipped: number; pending: number }[];
}

export async function adherenceSummary(userId: string, from: Date, to: Date, timezone: string): Promise<AdherenceSummary> {
  const doses = await prisma.doseEvent.findMany({
    where: { userId, scheduledAt: { gte: from, lte: to } },
    include: { medication: { select: { id: true, name: true } } },
    orderBy: { scheduledAt: 'asc' },
  });

  const counts = { taken: 0, missed: 0, skipped: 0, failed: 0, pending: 0 };
  const byMed = new Map<string, { medicationId: string; name: string; taken: number; missed: number; skipped: number }>();
  const byDay = new Map<string, { date: string; taken: number; missed: number; skipped: number; pending: number }>();

  for (const d of doses) {
    const med = byMed.get(d.medicationId) ?? { medicationId: d.medicationId, name: d.medication.name, taken: 0, missed: 0, skipped: 0 };
    const day = localDateString(d.scheduledAt, timezone);
    const dayRow = byDay.get(day) ?? { date: day, taken: 0, missed: 0, skipped: 0, pending: 0 };

    switch (d.status) {
      case 'TAKEN':
        counts.taken++; med.taken++; dayRow.taken++; break;
      case 'MISSED':
        counts.missed++; med.missed++; dayRow.missed++; break;
      case 'FAILED':
        counts.failed++; med.missed++; dayRow.missed++; break;
      case 'SKIPPED':
        counts.skipped++; med.skipped++; dayRow.skipped++; break;
      default:
        counts.pending++; dayRow.pending++;
    }
    byMed.set(d.medicationId, med);
    byDay.set(day, dayRow);
  }

  const rate = (taken: number, missed: number) => (taken + missed === 0 ? null : Math.round((taken / (taken + missed)) * 1000) / 10);

  // Streak: consecutive past days (ending today or yesterday) with at least one dose taken and none missed.
  const today = localDateString(new Date(), timezone);
  let streak = 0;
  let cursor = today;
  const todayRow = byDay.get(today);
  if (!todayRow || (todayRow.taken === 0 && todayRow.missed === 0)) cursor = addDaysToDateString(today, -1);
  while (true) {
    const row = byDay.get(cursor);
    if (!row || row.missed > 0 || row.taken === 0) break;
    streak++;
    cursor = addDaysToDateString(cursor, -1);
  }

  return {
    from: from.toISOString(),
    to: to.toISOString(),
    total: doses.length,
    ...counts,
    adherenceRate: rate(counts.taken, counts.missed + counts.failed),
    currentStreakDays: streak,
    byMedication: [...byMed.values()].map((m) => ({ ...m, adherenceRate: rate(m.taken, m.missed) })),
    byDay: [...byDay.values()].sort((a, b) => a.date.localeCompare(b.date)),
  };
}
