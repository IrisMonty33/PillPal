import { prisma } from '../lib/prisma';
import { config } from '../config';
import { logger } from '../lib/logger';
import { localTimeString } from '../lib/time';
import { generateAllDoseEvents } from '../services/doseEngine';
import { expireStaleCommands, markOfflineDevices } from '../services/devices';
import { notify, notifyCaregivers } from '../services/notifications';

/**
 * Background job that runs every SCHEDULER_INTERVAL_SECONDS (default 60s).
 * It is the heart of the "automated notifications" feature:
 *
 *   1. generate upcoming DoseEvents from Schedules
 *   2. send DOSE_REMINDER pushes when a dose is due
 *   3. mark overdue doses MISSED and alert the user + caregivers
 *   4. mark silent devices OFFLINE and alert
 *   5. expire device commands nobody picked up
 */

export interface TickSummary {
  ranAt: string;
  durationMs: number;
  dosesGenerated: number;
  remindersSent: number;
  dosesMissed: number;
  devicesOffline: number;
  commandsExpired: number;
}

function formatLocalTime(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat('en-US', { timeZone: timezone, hour: 'numeric', minute: '2-digit' }).format(date);
}

/** Step 2: reminders for doses that are due (respecting each user's lead time and quiet hours). */
export async function sendDueReminders(now = new Date()) {
  const maxLead = 24 * 60; // we fetch generously and filter per user below
  const due = await prisma.doseEvent.findMany({
    where: {
      status: 'SCHEDULED',
      reminderSentAt: null,
      scheduledAt: { lte: new Date(now.getTime() + maxLead * 60_000) },
      windowEndsAt: { gt: now },
    },
    include: {
      medication: { select: { name: true, strength: true } },
      slot: { select: { index: true } },
      user: { select: { timezone: true, settings: { select: { reminderLeadMinutes: true } } } },
    },
    orderBy: { scheduledAt: 'asc' },
  });

  let sent = 0;
  for (const dose of due) {
    const lead = dose.user.settings?.reminderLeadMinutes ?? 0;
    if (dose.scheduledAt.getTime() - lead * 60_000 > now.getTime()) continue; // not yet

    const when = formatLocalTime(dose.scheduledAt, dose.user.timezone);
    const where = dose.slot ? ` from slot ${dose.slot.index}` : '';
    await notify(dose.userId, {
      type: 'DOSE_REMINDER',
      title: `Time for ${dose.medication.name}`,
      body: `Take ${dose.quantity} ${dose.quantity === 1 ? 'pill' : 'pills'} of ${dose.medication.name}${dose.medication.strength ? ` ${dose.medication.strength}` : ''} at ${when}${where}.`,
      data: { doseEventId: dose.id, medicationId: dose.medicationId, deviceId: dose.deviceId, slotIndex: dose.slot?.index ?? null, scheduledAt: dose.scheduledAt.toISOString() },
      respectQuietHours: true,
    });
    await prisma.doseEvent.update({ where: { id: dose.id }, data: { reminderSentAt: now } });
    sent++;
  }
  return sent;
}

/** Step 3: doses whose window closed without being taken. */
export async function markMissedDoses(now = new Date()) {
  const overdue = await prisma.doseEvent.findMany({
    where: { status: { in: ['SCHEDULED', 'DISPENSED'] }, windowEndsAt: { lte: now } },
    include: {
      medication: { select: { name: true } },
      user: { select: { firstName: true, timezone: true } },
    },
  });

  for (const dose of overdue) {
    await prisma.doseEvent.update({
      where: { id: dose.id },
      data: { status: 'MISSED', missedAlertSentAt: now },
    });
    const when = formatLocalTime(dose.scheduledAt, dose.user.timezone);
    const data = { doseEventId: dose.id, medicationId: dose.medicationId, scheduledAt: dose.scheduledAt.toISOString() };

    await notify(dose.userId, {
      type: 'DOSE_MISSED',
      title: `Missed dose: ${dose.medication.name}`,
      body: dose.dispensedAt
        ? `${dose.medication.name} was dispensed at ${when} but never confirmed as taken.`
        : `Your ${when} dose of ${dose.medication.name} was not taken. Tap to mark it taken or skipped.`,
      data,
    });
    await notifyCaregivers(dose.userId, 'notifyMissedDoses', {
      type: 'DOSE_MISSED',
      title: `${dose.user.firstName} missed a dose`,
      body: `${dose.user.firstName} did not take ${dose.medication.name} scheduled for ${when} (${localTimeString(dose.scheduledAt, dose.user.timezone)} local time).`,
      data,
    });
  }
  return overdue.length;
}

let running = false;

/** One pass of every job. Safe to call manually (POST /api/v1/system/tick). */
export async function runSchedulerTick(now = new Date()): Promise<TickSummary> {
  if (running) {
    return { ranAt: now.toISOString(), durationMs: 0, dosesGenerated: 0, remindersSent: 0, dosesMissed: 0, devicesOffline: 0, commandsExpired: 0 };
  }
  running = true;
  const started = Date.now();
  try {
    const dosesGenerated = await generateAllDoseEvents(now);
    const remindersSent = await sendDueReminders(now);
    const dosesMissed = await markMissedDoses(now);
    const devicesOffline = await markOfflineDevices(now);
    const commandsExpired = await expireStaleCommands(now);
    const summary: TickSummary = { ranAt: now.toISOString(), durationMs: Date.now() - started, dosesGenerated, remindersSent, dosesMissed, devicesOffline, commandsExpired };
    if (dosesGenerated || remindersSent || dosesMissed || devicesOffline || commandsExpired) logger.info(summary, 'scheduler tick');
    return summary;
  } finally {
    running = false;
  }
}

let timer: NodeJS.Timeout | undefined;

export function startScheduler() {
  if (timer) return;
  const intervalMs = config.SCHEDULER_INTERVAL_SECONDS * 1000;
  const tick = () => runSchedulerTick().catch((err) => logger.error({ err }, 'scheduler tick failed'));
  tick();
  timer = setInterval(tick, intervalMs);
  timer.unref();
  logger.info(`Scheduler running every ${config.SCHEDULER_INTERVAL_SECONDS}s`);
}

export function stopScheduler() {
  if (timer) clearInterval(timer);
  timer = undefined;
}
