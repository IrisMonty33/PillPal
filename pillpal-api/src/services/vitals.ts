import { prisma } from '../lib/prisma';
import type { VitalSource, VitalType } from '../generated/prisma/client';
import { notify, notifyCaregivers } from './notifications';

export interface VitalInput {
  type: VitalType;
  systolic?: number | null;
  diastolic?: number | null;
  pulse?: number | null;
  value?: number | null;
  unit?: string | null;
  recordedAt?: Date;
  meta?: Record<string, any> | null; // eslint-disable-line @typescript-eslint/no-explicit-any
}

/**
 * Returns a human-readable reason when the reading is outside safe ranges, otherwise null.
 * Thresholds follow common consumer-device guidance (AHA blood-pressure categories etc.).
 */
export function evaluateVital(input: VitalInput): string | null {
  switch (input.type) {
    case 'BLOOD_PRESSURE': {
      const s = input.systolic ?? 0;
      const d = input.diastolic ?? 0;
      if (s >= 180 || d >= 120) return `Blood pressure ${s}/${d} is dangerously high`;
      if (s < 90 || d < 60) return `Blood pressure ${s}/${d} is low`;
      if (input.pulse != null && (input.pulse > 120 || input.pulse < 40)) return `Pulse of ${input.pulse} bpm is outside the normal range`;
      return null;
    }
    case 'HEART_RATE': {
      const v = input.value ?? 0;
      if (v > 120) return `Heart rate of ${v} bpm is high`;
      if (v < 40) return `Heart rate of ${v} bpm is low`;
      return null;
    }
    case 'SPO2': {
      const v = input.value ?? 100;
      return v < 90 ? `Blood oxygen of ${v}% is low` : null;
    }
    case 'TEMPERATURE': {
      const v = input.value ?? 37;
      const celsius = (input.unit ?? 'C').toUpperCase().startsWith('F') ? ((v - 32) * 5) / 9 : v;
      if (celsius >= 39.4) return `Temperature of ${v}°${(input.unit ?? 'C').toUpperCase()} is a high fever`;
      if (celsius <= 35) return `Temperature of ${v}°${(input.unit ?? 'C').toUpperCase()} is low`;
      return null;
    }
    case 'GLUCOSE': {
      const v = input.value ?? 100;
      if (v < 70) return `Blood glucose of ${v} mg/dL is low`;
      if (v > 300) return `Blood glucose of ${v} mg/dL is very high`;
      return null;
    }
    default:
      return null;
  }
}

/** Store a vital reading and send VITALS_ALERT notifications when it is out of range. */
export async function recordVital(userId: string, input: VitalInput, opts: { source: VitalSource; deviceId?: string | null }) {
  const alertReason = evaluateVital(input);
  const reading = await prisma.vitalReading.create({
    data: {
      userId,
      deviceId: opts.deviceId ?? null,
      type: input.type,
      source: opts.source,
      systolic: input.systolic ?? null,
      diastolic: input.diastolic ?? null,
      pulse: input.pulse ?? null,
      value: input.value ?? null,
      unit: input.unit ?? null,
      recordedAt: input.recordedAt ?? new Date(),
      flagged: alertReason !== null,
      meta: input.meta ?? undefined,
    },
  });

  if (alertReason) {
    const payload = {
      type: 'VITALS_ALERT' as const,
      title: 'Vitals reading needs attention',
      body: `${alertReason}. If you feel unwell, contact your doctor or emergency services.`,
      data: { vitalReadingId: reading.id, type: input.type },
    };
    await notify(userId, payload);
    await notifyCaregivers(userId, 'notifyVitals', payload);
  }
  return reading;
}
