/**
 * Shapes returned by the PillPal API (pillpal-api/docs/API.md).
 * Only the fields the app uses are listed; the server sends more.
 */

export type DoseStatus = 'SCHEDULED' | 'DISPENSED' | 'TAKEN' | 'MISSED' | 'SKIPPED' | 'FAILED';
export type MedicationForm = 'TABLET' | 'CAPSULE' | 'SOFTGEL' | 'OTHER';
export type VitalType = 'BLOOD_PRESSURE' | 'HEART_RATE' | 'SPO2' | 'TEMPERATURE' | 'WEIGHT' | 'GLUCOSE';
export type NotificationType =
  | 'DOSE_REMINDER' | 'DOSE_MISSED' | 'DOSE_TAKEN' | 'LOW_STOCK' | 'DEVICE_OFFLINE' | 'DEVICE_ONLINE'
  | 'DEVICE_ERROR' | 'VITALS_ALERT' | 'CAREGIVER_INVITE' | 'SYSTEM';

export interface ApiUser {
  id: string;
  email: string;
  firstName: string;
  lastName: string | null;
  phone?: string | null;
  timezone: string;
  settings?: NotificationSettings | null;
}

export interface NotificationSettings {
  doseReminders: boolean;
  missedDoseAlerts: boolean;
  lowStockAlerts: boolean;
  deviceOfflineAlerts: boolean;
  vitalsAlerts: boolean;
  reminderLeadMinutes: number;
  requireTakenConfirmation: boolean;
  quietHoursStart: string | null;
  quietHoursEnd: string | null;
}

export interface AuthResponse {
  user: ApiUser;
  accessToken: string;
  refreshToken: string;
}

export interface ApiSchedule {
  id: string;
  medicationId: string;
  label: string | null;
  timeOfDay: string; // "HH:MM"
  daysOfWeek: number[]; // 0 = Sunday … 6 = Saturday, [] = every day
  quantity: number;
  graceMinutes: number;
  isActive: boolean;
}

export interface ApiMedication {
  id: string;
  name: string;
  strength: string | null;
  form: MedicationForm;
  instructions: string | null;
  notes: string | null;
  refillThreshold: number;
  isActive: boolean;
  slot: { id: string; index: number; deviceId: string; pillCount: number; capacity: number } | null;
  schedules: ApiSchedule[];
}

export interface ApiDose {
  id: string;
  medicationId: string;
  scheduleId: string | null;
  deviceId: string | null;
  scheduledAt: string;
  windowEndsAt: string;
  quantity: number;
  status: DoseStatus;
  source: 'SCHEDULE' | 'MANUAL' | 'DEVICE' | 'REMOTE';
  dispensedAt: string | null;
  takenAt: string | null;
  skippedAt: string | null;
  failureReason: string | null;
  notes: string | null;
  medication: { id: string; name: string; strength: string | null; form: MedicationForm };
  slot: { index: number; deviceId: string } | null;
}

export interface ApiVital {
  id: string;
  type: VitalType;
  source: 'DEVICE' | 'MANUAL';
  systolic: number | null;
  diastolic: number | null;
  pulse: number | null;
  value: number | null;
  unit: string | null;
  flagged: boolean;
  recordedAt: string;
}

export interface ApiNotification {
  id: string;
  type: NotificationType;
  title: string;
  body: string;
  data: Record<string, unknown> | null;
  readAt: string | null;
  createdAt: string;
}

export interface ApiSlot {
  id: string;
  index: number;
  pillCount: number;
  capacity: number;
  lastWeightGrams: number | null;
  medication: { id: string; name: string; strength: string | null; form: MedicationForm; refillThreshold: number } | null;
}

export interface ApiDevice {
  id: string;
  name: string;
  status: 'UNCLAIMED' | 'ONLINE' | 'OFFLINE';
  isOnline: boolean;
  firmwareVersion: string | null;
  lastSeenAt: string | null;
  slots: ApiSlot[];
}

export interface ApiCaregiverLink {
  id: string;
  patientId: string;
  caregiverId: string | null;
  inviteEmail: string;
  status: 'PENDING' | 'ACCEPTED' | 'REVOKED';
  caregiver?: { id: string; email: string; firstName: string; lastName: string | null } | null;
  patient?: { id: string; email: string; firstName: string; lastName: string | null } | null;
}

export interface Adherence {
  total: number;
  taken: number;
  missed: number;
  skipped: number;
  pending: number;
  adherenceRate: number | null;
  currentStreakDays: number;
  byDay: { date: string; taken: number; missed: number; skipped: number; pending: number }[];
}

export interface Dashboard {
  serverTime: string;
  user: { id: string; firstName: string; timezone: string };
  today: { date: string; doses: ApiDose[]; taken: number; missed: number; remaining: number };
  nextDose: ApiDose | null;
  adherenceLast7Days: Adherence;
  devices: ApiDevice[];
  lowStock: { index: number; pillCount: number; deviceId: string; medication: { id: string; name: string; refillThreshold: number } }[];
  unreadNotifications: number;
  latestVitals: ApiVital[];
}

export interface PatientOverview {
  patient: { id: string; firstName: string; lastName: string | null; timezone: string };
  todayDoses: (ApiDose & { medication: { name: string; strength: string | null } })[];
  devices: { id: string; name: string; status: string; lastSeenAt: string | null }[];
  adherenceLast7Days: Adherence;
  recentVitals: ApiVital[];
  recentMissed: (ApiDose & { medication: { name: string } })[];
}
