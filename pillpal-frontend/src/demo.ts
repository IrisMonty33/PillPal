/**
 * Preview-mode data, shown when EXPO_PUBLIC_API_URL is not set so the UI can be
 * developed without a server. With a server, run `npm run db:seed` in pillpal-api
 * and log in as demo@pillpal.app / Password123! instead.
 */
import type { Event, Medication, Vital } from './model';
import type { ApiDevice, ApiNotification } from './types';

const hoursAgo = (h: number) => new Date(Date.now() - h * 3_600_000).toISOString();

export const demoMeds: Medication[] = [
  { id: 'a', name: 'Lisinopril', dose: '10 mg · 1 tablet', instructions: 'Take with water', times: ['08:00'], schedules: [{ id: 's1', timeOfDay: '08:00', daysOfWeek: [], quantity: 1, label: 'Morning' }], slotIndex: 2, pillCount: 6, refillThreshold: 7, next_refill: '6 left in slot 2 – refill soon' },
  { id: 'b', name: 'Metformin', dose: '500 mg · 1 tablet', instructions: 'Take with food', times: ['08:00', '18:30'], schedules: [{ id: 's2', timeOfDay: '08:00', daysOfWeek: [], quantity: 1, label: 'Breakfast' }, { id: 's3', timeOfDay: '18:30', daysOfWeek: [], quantity: 1, label: 'Dinner' }], slotIndex: 1, pillCount: 38, refillThreshold: 10, next_refill: '38 in slot 1' },
];

export const demoVitals: Vital[] = [
  { id: 'v1', recorded_at: hoursAgo(1), heart_rate: 72, spo2: 98, temperature_c: 36.7, systolic: 118, diastolic: 76, flagged: false },
  { id: 'v2', recorded_at: hoursAgo(25), heart_rate: 75, spo2: 97, temperature_c: 36.8, systolic: 121, diastolic: 78, flagged: false },
];

export const demoEvents: Event[] = [
  { id: 'e1', kind: 'taken', message: 'Lisinopril 10 mg taken at 8:04 AM', occurred_at: hoursAgo(2), medication_id: 'a', actionable: false },
  { id: 'e2', kind: 'dispensed', message: 'Metformin 500 mg is ready in the tray', occurred_at: hoursAgo(1), medication_id: 'b', actionable: true },
  { id: 'e3', kind: 'missed', message: 'Metformin 500 mg (6:30 PM) was not taken', occurred_at: hoursAgo(26), medication_id: 'b', actionable: true },
];

export const demoDevices: ApiDevice[] = [
  {
    id: 'd1',
    name: 'Kitchen PillPal',
    status: 'ONLINE',
    isOnline: true,
    firmwareVersion: '0.1.0',
    lastSeenAt: new Date().toISOString(),
    slots: [
      { id: 'sl1', index: 1, pillCount: 38, capacity: 50, lastWeightGrams: 21.3, medication: { id: 'b', name: 'Metformin', strength: '500 mg', form: 'TABLET', refillThreshold: 10 } },
      { id: 'sl2', index: 2, pillCount: 6, capacity: 50, lastWeightGrams: 0.7, medication: { id: 'a', name: 'Lisinopril', strength: '10 mg', form: 'TABLET', refillThreshold: 7 } },
      { id: 'sl3', index: 3, pillCount: 0, capacity: 50, lastWeightGrams: null, medication: null },
      { id: 'sl4', index: 4, pillCount: 0, capacity: 50, lastWeightGrams: null, medication: null },
      { id: 'sl5', index: 5, pillCount: 0, capacity: 50, lastWeightGrams: null, medication: null },
    ],
  },
];

export const demoNotifications: ApiNotification[] = [
  { id: 'n1', type: 'LOW_STOCK', title: 'Lisinopril is running low', body: 'Only 6 left in slot 2 of Kitchen PillPal. Time to refill.', data: null, readAt: null, createdAt: hoursAgo(1) },
  { id: 'n2', type: 'DOSE_MISSED', title: 'Missed dose: Metformin', body: 'Your 6:30 PM dose of Metformin was not taken.', data: null, readAt: hoursAgo(20), createdAt: hoursAgo(25) },
];
