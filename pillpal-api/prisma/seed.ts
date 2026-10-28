/**
 * Seeds the database with a realistic demo account so the app and the Pi have
 * something to show immediately.
 *
 *   npm run db:seed
 *
 * Demo logins (password for both: Password123!)
 *   patient   demo@pillpal.app
 *   caregiver caregiver@pillpal.app
 *
 * Demo device API key (for the Pi / requests.http): pp_dev_demo_0000000000000000000000000000000000000000
 * Running the seed again wipes and recreates the demo data only.
 */
import 'dotenv/config';
import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../src/generated/prisma/client';
import { hashPassword, sha256 } from '../src/lib/crypto';
import { addDaysToDateString, localDateString, parseDateString, zonedTimeToUtc } from '../src/lib/time';

const prisma = new PrismaClient({
  adapter: new PrismaPg({ connectionString: process.env.DATABASE_URL ?? 'postgresql://pillpal:pillpal@localhost:5432/pillpal' }),
});

export const DEMO = {
  patientEmail: 'demo@pillpal.app',
  caregiverEmail: 'caregiver@pillpal.app',
  password: 'Password123!',
  deviceSerial: 'PILLPAL-DEMO-0001',
  deviceApiKey: 'pp_dev_demo_0000000000000000000000000000000000000000',
  timezone: 'America/New_York',
};

async function main() {
  console.log('Seeding PillPal demo data...');

  // Idempotent: remove the previous demo data (cascades take care of children).
  await prisma.user.deleteMany({ where: { email: { in: [DEMO.patientEmail, DEMO.caregiverEmail] } } });
  await prisma.device.deleteMany({ where: { serialNumber: DEMO.deviceSerial } });

  const passwordHash = await hashPassword(DEMO.password);

  const patient = await prisma.user.create({
    data: {
      email: DEMO.patientEmail,
      passwordHash,
      firstName: 'Alan',
      lastName: 'Demo',
      phone: '+1 555 0100',
      timezone: DEMO.timezone,
      settings: { create: { reminderLeadMinutes: 5, quietHoursStart: '22:30', quietHoursEnd: '07:00' } },
    },
  });

  const caregiver = await prisma.user.create({
    data: {
      email: DEMO.caregiverEmail,
      passwordHash,
      firstName: 'Iris',
      lastName: 'Demo',
      timezone: DEMO.timezone,
      settings: { create: {} },
    },
  });

  await prisma.caregiverLink.create({
    data: { patientId: patient.id, caregiverId: caregiver.id, inviteEmail: caregiver.email, status: 'ACCEPTED', acceptedAt: new Date() },
  });

  // --- Device with 5 hopper slots -------------------------------------------------
  const device = await prisma.device.create({
    data: {
      serialNumber: DEMO.deviceSerial,
      name: 'Kitchen PillPal',
      apiKeyHash: sha256(DEMO.deviceApiKey),
      ownerId: patient.id,
      status: 'ONLINE',
      firmwareVersion: '0.1.0',
      model: 'Raspberry Pi 5 4GB',
      ipAddress: '192.168.1.42',
      lastSeenAt: new Date(),
      claimedAt: new Date(),
      settings: { volume: 80, brightness: 70, reminderRepeatMinutes: 5, timezone: DEMO.timezone },
      slots: { create: [1, 2, 3, 4, 5].map((index) => ({ index, capacity: 50, calibration: { servoMsPerPill: 180 } })) },
    },
    include: { slots: { orderBy: { index: 'asc' } } },
  });

  // --- Medications ----------------------------------------------------------------
  const meds = await Promise.all([
    prisma.medication.create({ data: { userId: patient.id, name: 'Metformin', strength: '500 mg', form: 'TABLET', color: 'white', shape: 'round', instructions: 'Take with food', pillWeightMg: 560, refillThreshold: 10 } }),
    prisma.medication.create({ data: { userId: patient.id, name: 'Lisinopril', strength: '10 mg', form: 'TABLET', color: 'pink', shape: 'round', pillWeightMg: 120, refillThreshold: 7 } }),
    prisma.medication.create({ data: { userId: patient.id, name: 'Atorvastatin', strength: '20 mg', form: 'TABLET', color: 'white', shape: 'oval', instructions: 'Take in the evening', pillWeightMg: 310, refillThreshold: 7 } }),
    prisma.medication.create({ data: { userId: patient.id, name: 'Vitamin D3', strength: '2000 IU', form: 'SOFTGEL', color: 'yellow', shape: 'oval', pillWeightMg: 250, refillThreshold: 5 } }),
  ]);
  const [metformin, lisinopril, atorvastatin, vitaminD] = meds;

  // Load medications into slots 1-4 (slot 5 stays empty).
  const slotFor = new Map<string, (typeof device.slots)[number]>();
  const loads: [typeof metformin, number, number][] = [
    [metformin, 1, 38],
    [lisinopril, 2, 6], // low -> will trigger a LOW_STOCK alert
    [atorvastatin, 3, 22],
    [vitaminD, 4, 44],
  ];
  for (const [med, index, count] of loads) {
    const slot = device.slots[index - 1];
    await prisma.slot.update({ where: { id: slot.id }, data: { medicationId: med.id, pillCount: count, lastWeightGrams: (count * (med.pillWeightMg ?? 300)) / 1000 } });
    await prisma.inventoryEvent.create({ data: { slotId: slot.id, medicationId: med.id, userId: patient.id, reason: 'REFILL', delta: count, countAfter: count } });
    slotFor.set(med.id, slot);
  }

  // --- Schedules ------------------------------------------------------------------
  const schedules = await Promise.all([
    prisma.schedule.create({ data: { userId: patient.id, medicationId: metformin.id, label: 'Breakfast', timeOfDay: '08:00', quantity: 1 } }),
    prisma.schedule.create({ data: { userId: patient.id, medicationId: metformin.id, label: 'Dinner', timeOfDay: '18:30', quantity: 1 } }),
    prisma.schedule.create({ data: { userId: patient.id, medicationId: lisinopril.id, label: 'Morning', timeOfDay: '08:00', quantity: 1 } }),
    prisma.schedule.create({ data: { userId: patient.id, medicationId: atorvastatin.id, label: 'Bedtime', timeOfDay: '21:00', quantity: 1 } }),
    prisma.schedule.create({ data: { userId: patient.id, medicationId: vitaminD.id, label: 'Mon/Wed/Fri', timeOfDay: '08:00', daysOfWeek: [1, 3, 5], quantity: 1 } }),
  ]);

  // --- 14 days of dose history (deterministic pseudo-random outcomes) --------------
  let seed = 42;
  const rand = () => {
    seed = (seed * 9301 + 49297) % 233280;
    return seed / 233280;
  };

  const now = new Date();
  const today = localDateString(now, DEMO.timezone);
  let historyRows = 0;
  for (let back = 14; back >= 1; back--) {
    const day = addDaysToDateString(today, -back);
    const { year, month, day: d } = parseDateString(day);
    const weekday = new Date(Date.UTC(year, month - 1, d)).getUTCDay();
    for (const s of schedules) {
      if (s.daysOfWeek.length && !s.daysOfWeek.includes(weekday)) continue;
      const [h, m] = s.timeOfDay.split(':').map(Number);
      const scheduledAt = zonedTimeToUtc(year, month, d, h, m, DEMO.timezone);
      const r = rand();
      const status = r < 0.86 ? 'TAKEN' : r < 0.95 ? 'MISSED' : 'SKIPPED';
      const slot = slotFor.get(s.medicationId);
      const takenAt = status === 'TAKEN' ? new Date(scheduledAt.getTime() + Math.floor(rand() * 40) * 60_000) : null;
      await prisma.doseEvent.create({
        data: {
          userId: patient.id,
          medicationId: s.medicationId,
          scheduleId: s.id,
          deviceId: device.id,
          slotId: slot?.id,
          scheduledAt,
          windowEndsAt: new Date(scheduledAt.getTime() + s.graceMinutes * 60_000),
          quantity: s.quantity,
          status,
          source: 'SCHEDULE',
          dispensedAt: takenAt,
          takenAt,
          detectedCount: takenAt ? s.quantity : null,
          skippedAt: status === 'SKIPPED' ? scheduledAt : null,
          reminderSentAt: new Date(scheduledAt.getTime() - 5 * 60_000),
          missedAlertSentAt: status === 'MISSED' ? new Date(scheduledAt.getTime() + s.graceMinutes * 60_000) : null,
          notes: status === 'SKIPPED' ? 'Felt nauseous' : null,
        },
      });
      historyRows++;
    }
  }

  // --- Vitals (blood pressure from the BLE cuff + a manual weight) ------------------
  for (let back = 7; back >= 0; back--) {
    const day = addDaysToDateString(today, -back);
    const { year, month, day: d } = parseDateString(day);
    const recordedAt = zonedTimeToUtc(year, month, d, 8, 15, DEMO.timezone);
    if (recordedAt > now) continue;
    await prisma.vitalReading.create({
      data: {
        userId: patient.id,
        deviceId: device.id,
        type: 'BLOOD_PRESSURE',
        source: 'DEVICE',
        systolic: 118 + Math.floor(rand() * 16),
        diastolic: 74 + Math.floor(rand() * 10),
        pulse: 62 + Math.floor(rand() * 14),
        unit: 'mmHg',
        recordedAt,
        meta: { cuff: 'Omron BLE' },
      },
    });
  }
  await prisma.vitalReading.create({ data: { userId: patient.id, type: 'WEIGHT', source: 'MANUAL', value: 176.4, unit: 'lb', recordedAt: new Date(now.getTime() - 2 * 24 * 3_600_000) } });

  // --- A few device log lines + notifications --------------------------------------
  await prisma.deviceEvent.createMany({
    data: [
      { deviceId: device.id, level: 'INFO', type: 'BOOT', message: 'Firmware 0.1.0 started', occurredAt: new Date(now.getTime() - 3 * 3_600_000) },
      { deviceId: device.id, level: 'INFO', type: 'SYNC', message: 'Synced 5 schedules', occurredAt: new Date(now.getTime() - 3 * 3_600_000 + 5000) },
      { deviceId: device.id, level: 'WARN', type: 'BREAK_BEAM_TIMEOUT', message: 'No pill detected within 3s on slot 2, retried once', occurredAt: new Date(now.getTime() - 26 * 3_600_000) },
    ],
  });
  await prisma.notification.createMany({
    data: [
      { userId: patient.id, type: 'LOW_STOCK', title: 'Lisinopril is running low', body: 'Only 6 left in slot 2 of Kitchen PillPal. Time to refill.', data: { deviceId: device.id, slotIndex: 2 }, createdAt: new Date(now.getTime() - 3_600_000) },
      { userId: patient.id, type: 'SYSTEM', title: 'Welcome to PillPal', body: 'Your dispenser is set up. Doses will be dispensed automatically on schedule.', readAt: new Date(now.getTime() - 5 * 3_600_000), createdAt: new Date(now.getTime() - 6 * 3_600_000) },
      { userId: caregiver.id, type: 'SYSTEM', title: 'You are now a caregiver for Alan', body: 'You will be alerted when Alan misses a dose.', createdAt: new Date(now.getTime() - 6 * 3_600_000) },
    ],
  });
  await prisma.slot.update({ where: { id: slotFor.get(lisinopril.id)!.id }, data: { lowStockNotifiedAt: new Date(now.getTime() - 3_600_000) } });

  // Upcoming doses for the next 48h are generated by the scheduler as soon as the API starts.
  console.log(`
Done.
  Patient login:    ${DEMO.patientEmail} / ${DEMO.password}
  Caregiver login:  ${DEMO.caregiverEmail} / ${DEMO.password}
  Device serial:    ${DEMO.deviceSerial}
  Device API key:   ${DEMO.deviceApiKey}
  Device id:        ${device.id}
  Medications: ${meds.length}, schedules: ${schedules.length}, dose history rows: ${historyRows}
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
