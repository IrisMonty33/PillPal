/**
 * View models used by the screens, plus the adapters that build them from API responses.
 * These keep the same field names the original screens used (dose, times, next_refill, kind…)
 * so the UI code stays familiar.
 */
import type { ApiDose, ApiMedication, ApiVital, DoseStatus } from './types';

export type Medication = {
  id: string;
  name: string;
  /** e.g. "500 mg · 1 tablet" */
  dose: string;
  instructions: string | null;
  /** "HH:MM" strings, sorted */
  times: string[];
  /** The schedules behind `times`, so a time can be removed. */
  schedules: { id: string; timeOfDay: string; daysOfWeek: number[]; quantity: number; label: string | null }[];
  /** Null when the medication is not loaded in a dispenser slot. */
  slotIndex: number | null;
  pillCount: number | null;
  refillThreshold: number;
  /** Text for the "Refill:" line, e.g. "7 pills left in slot 2 – refill soon" */
  next_refill: string | null;
};

export type Vital = {
  id: string;
  recorded_at: string;
  heart_rate: number | null;
  spo2: number | null;
  temperature_c: number | null;
  systolic: number | null;
  diastolic: number | null;
  flagged: boolean;
};

export type EventKind = 'dispensed' | 'taken' | 'missed' | 'skipped' | 'failed' | 'scheduled';

export type Event = {
  id: string;
  kind: EventKind;
  message: string;
  occurred_at: string;
  medication_id: string | null;
  /** True while the dose can still be acted on (Mark taken / Skip). */
  actionable: boolean;
};

const FORM_LABEL: Record<string, string> = { TABLET: 'tablet', CAPSULE: 'capsule', SOFTGEL: 'softgel', OTHER: 'dose' };

export function toMedication(m: ApiMedication): Medication {
  const schedules = [...m.schedules].filter((s) => s.isActive).sort((a, b) => a.timeOfDay.localeCompare(b.timeOfDay));
  const quantity = schedules[0]?.quantity ?? 1;
  const form = FORM_LABEL[m.form] ?? 'dose';
  const dose = [m.strength, `${quantity} ${form}${quantity === 1 ? '' : 's'}`].filter(Boolean).join(' · ');
  const pillCount = m.slot?.pillCount ?? null;
  let next_refill: string | null = null;
  if (m.slot) {
    next_refill =
      pillCount !== null && pillCount <= m.refillThreshold
        ? `${pillCount} left in slot ${m.slot.index} – refill soon`
        : `${pillCount} in slot ${m.slot.index}`;
  }
  return {
    id: m.id,
    name: m.name,
    dose,
    instructions: m.instructions,
    times: schedules.map((s) => s.timeOfDay),
    schedules: schedules.map((s) => ({ id: s.id, timeOfDay: s.timeOfDay, daysOfWeek: s.daysOfWeek, quantity: s.quantity, label: s.label })),
    slotIndex: m.slot?.index ?? null,
    pillCount,
    refillThreshold: m.refillThreshold,
    next_refill,
  };
}

/**
 * The API stores one reading per vital type. The station typically records several at once,
 * so readings recorded within 2 minutes of each other are shown as one card.
 */
export function groupVitals(readings: ApiVital[]): Vital[] {
  const sorted = [...readings].sort((a, b) => b.recordedAt.localeCompare(a.recordedAt));
  const sessions: Vital[] = [];
  for (const r of sorted) {
    const t = new Date(r.recordedAt).getTime();
    let session = sessions.find((s) => Math.abs(new Date(s.recorded_at).getTime() - t) < 2 * 60_000);
    if (!session) {
      session = { id: r.id, recorded_at: r.recordedAt, heart_rate: null, spo2: null, temperature_c: null, systolic: null, diastolic: null, flagged: false };
      sessions.push(session);
    }
    session.flagged = session.flagged || r.flagged;
    switch (r.type) {
      case 'BLOOD_PRESSURE':
        session.systolic = r.systolic;
        session.diastolic = r.diastolic;
        if (r.pulse != null && session.heart_rate == null) session.heart_rate = r.pulse;
        break;
      case 'HEART_RATE':
        session.heart_rate = r.value;
        break;
      case 'SPO2':
        session.spo2 = r.value;
        break;
      case 'TEMPERATURE':
        session.temperature_c = r.value != null && (r.unit ?? 'C').toUpperCase().startsWith('F') ? Math.round(((r.value - 32) * 5) / 9 * 10) / 10 : r.value;
        break;
      default:
        break;
    }
  }
  return sessions;
}

const KIND: Record<DoseStatus, EventKind> = {
  SCHEDULED: 'scheduled',
  DISPENSED: 'dispensed',
  TAKEN: 'taken',
  MISSED: 'missed',
  SKIPPED: 'skipped',
  FAILED: 'failed',
};

export function formatClock(iso: string): string {
  return new Date(iso).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function toEvent(d: ApiDose): Event {
  const name = d.medication.strength ? `${d.medication.name} ${d.medication.strength}` : d.medication.name;
  const at = formatClock(d.scheduledAt);
  const messages: Record<DoseStatus, string> = {
    SCHEDULED: `${name} is due at ${at}`,
    DISPENSED: `${name} is ready in the tray`,
    TAKEN: d.takenAt ? `${name} taken at ${formatClock(d.takenAt)}` : `${name} taken`,
    MISSED: `${name} (${at}) was not taken`,
    SKIPPED: `${name} (${at}) skipped${d.notes ? ` – ${d.notes}` : ''}`,
    FAILED: `Could not dispense ${name}${d.failureReason ? `: ${d.failureReason}` : ''}`,
  };
  const occurred = d.takenAt ?? d.skippedAt ?? d.dispensedAt ?? (d.status === 'MISSED' ? d.windowEndsAt : d.scheduledAt);
  return {
    id: d.id,
    kind: KIND[d.status],
    message: messages[d.status],
    occurred_at: occurred,
    medication_id: d.medicationId,
    actionable: d.status === 'SCHEDULED' || d.status === 'DISPENSED' || d.status === 'MISSED' || d.status === 'FAILED',
  };
}

/** "08:00" -> "8:00 AM" (device locale) */
export function formatTimeOfDay(hhmm: string): string {
  const [h, m] = hhmm.split(':').map(Number);
  return new Date(2020, 0, 1, h, m).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export function formatDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function formatDays(daysOfWeek: number[]): string {
  if (daysOfWeek.length === 0 || daysOfWeek.length === 7) return 'Every day';
  return daysOfWeek.map((d) => DAY_NAMES[d]).join(' ');
}
