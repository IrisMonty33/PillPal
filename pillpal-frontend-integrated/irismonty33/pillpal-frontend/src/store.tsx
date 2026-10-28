/**
 * App-wide state: the signed-in user, everything loaded from the API, and the actions
 * screens can call. Wrap the app in <AppProvider> and use `useApp()` in any screen.
 *
 * Data is reloaded on pull-to-refresh, after every action, and every 30 s while the app
 * is in the foreground (push notifications cover the "instant" case).
 */
import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import { Alert, AppState } from 'react-native';
import * as api from './api';
import { ApiError } from './api';
import { configured, POLL_INTERVAL_MS } from './config';
import { demoDevices, demoEvents, demoMeds, demoNotifications, demoVitals } from './demo';
import { groupVitals, toEvent, toMedication, type Event, type Medication, type Vital } from './model';
import { registerForPush } from './push';
import type { Adherence, ApiCaregiverLink, ApiDevice, ApiDose, ApiNotification, ApiUser, MedicationForm, NotificationSettings, PatientOverview, VitalType } from './types';

export type Role = 'patient' | 'caregiver';

export interface AppData {
  meds: Medication[];
  vitals: Vital[];
  /** Dose activity, newest first (Reminders page). */
  events: Event[];
  /** Today's doses in the user's timezone, oldest first. */
  today: Event[];
  nextDose: ApiDose | null;
  adherence: Adherence | null;
  devices: ApiDevice[];
  notifications: ApiNotification[];
  unreadCount: number;
  caregivers: ApiCaregiverLink[];
  patients: ApiCaregiverLink[];
  settings: NotificationSettings | null;
}

const emptyData: AppData = {
  meds: [], vitals: [], events: [], today: [], nextDose: null, adherence: null, devices: [], notifications: [], unreadCount: 0, caregivers: [], patients: [], settings: null,
};

const previewData: AppData = {
  ...emptyData,
  meds: demoMeds,
  vitals: demoVitals,
  events: demoEvents,
  today: demoEvents.filter((e) => e.actionable),
  devices: demoDevices,
  notifications: demoNotifications,
  unreadCount: 1,
};

interface AppContextValue {
  preview: boolean;
  /** Null until we know whether a saved session exists. */
  sessionChecked: boolean;
  user: ApiUser | null;
  role: Role;
  data: AppData;
  loading: boolean;
  refreshing: boolean;
  error: string;
  refresh: () => Promise<void>;
  signIn: (email: string, password: string) => Promise<void>;
  signUp: (input: { email: string; password: string; firstName: string; lastName?: string }) => Promise<void>;
  signOut: () => Promise<void>;
  addMedication: (input: { name: string; strength?: string; form?: MedicationForm; instructions?: string; times: string[]; quantity?: number }) => Promise<void>;
  removeMedication: (id: string) => Promise<void>;
  addSchedule: (medicationId: string, timeOfDay: string, daysOfWeek?: number[], quantity?: number) => Promise<void>;
  removeSchedule: (id: string) => Promise<void>;
  markTaken: (doseId: string) => Promise<void>;
  skipDose: (doseId: string) => Promise<void>;
  logManualDose: (medicationId: string) => Promise<void>;
  addVital: (input: { type: VitalType; systolic?: number; diastolic?: number; pulse?: number; value?: number; unit?: string }) => Promise<void>;
  claimDevice: (claimCode: string, name?: string) => Promise<void>;
  unpairDevice: (id: string) => Promise<void>;
  setSlot: (deviceId: string, index: number, medicationId: string | null, pillCount?: number) => Promise<void>;
  refillSlot: (deviceId: string, index: number, pillCount: number) => Promise<void>;
  dispenseNow: (deviceId: string, slotIndex: number) => Promise<void>;
  ringDevice: (deviceId: string) => Promise<void>;
  inviteCaregiver: (email: string) => Promise<string>;
  acceptInvite: (linkId: string) => Promise<void>;
  removeCaregiverLink: (linkId: string) => Promise<void>;
  updateSettings: (patch: Partial<NotificationSettings>) => Promise<void>;
  markAllRead: () => Promise<void>;
  patientOverview: (patientId: string) => Promise<PatientOverview>;
}

const AppContext = createContext<AppContextValue | null>(null);

export function describeError(err: unknown): string {
  if (err instanceof ApiError) {
    if (err.details?.length) return err.details.map((d) => `${d.path}: ${d.message}`).join('\n');
    return err.message;
  }
  return err instanceof Error ? err.message : String(err);
}

export function AppProvider({ children }: { children: React.ReactNode }) {
  const preview = !configured;
  const [sessionChecked, setSessionChecked] = useState(preview);
  const [user, setUser] = useState<ApiUser | null>(null);
  const [data, setData] = useState<AppData>(preview ? previewData : emptyData);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState('');
  const loadingRef = useRef(false);

  // ---------------------------------------------------------------- loading
  const load = useCallback(async (mode: 'initial' | 'refresh' | 'background' = 'background') => {
    if (preview || !user || loadingRef.current) return;
    loadingRef.current = true;
    if (mode === 'initial') setLoading(true);
    if (mode === 'refresh') setRefreshing(true);
    try {
      const [dash, meds, doseList, readings, notes, care, me] = await Promise.all([
        api.dashboard(),
        api.medications.list(),
        api.doses.list({ limit: 100 }),
        api.vitals.list(100),
        api.notifications.list(50),
        api.caregivers.list(),
        api.auth.me(),
      ]);
      setData({
        meds: meds.map(toMedication),
        vitals: groupVitals(readings),
        events: doseList.doses.filter((d) => d.status !== 'SCHEDULED').map(toEvent),
        today: dash.today.doses.map(toEvent),
        nextDose: dash.nextDose,
        adherence: dash.adherenceLast7Days,
        devices: dash.devices,
        notifications: notes.notifications,
        unreadCount: notes.unreadCount,
        caregivers: care.caregivers,
        patients: care.patients,
        settings: me.settings,
      });
      setUser(me);
      setError('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      loadingRef.current = false;
      setLoading(false);
      setRefreshing(false);
    }
  }, [preview, user]);

  // Restore a saved session on startup.
  useEffect(() => {
    if (preview) return;
    (async () => {
      try {
        if (await api.hasSession()) setUser(await api.auth.me());
      } catch {
        // token expired or server down; the login screen will show
      } finally {
        setSessionChecked(true);
      }
    })();
  }, [preview]);

  // Initial load when a user appears, then poll while the app is in the foreground.
  const userId = user?.id;
  useEffect(() => {
    if (!userId) return;
    load('initial');
    registerForPush().catch(() => undefined); // no-op in Expo Go / simulators
    const timer = setInterval(() => {
      if (AppState.currentState === 'active') load('background');
    }, POLL_INTERVAL_MS);
    const sub = AppState.addEventListener('change', (state) => {
      if (state === 'active') load('background');
    });
    return () => {
      clearInterval(timer);
      sub.remove();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [userId]);

  // ---------------------------------------------------------------- helpers
  const refresh = useCallback(() => load('refresh'), [load]);

  /** Runs an API call, then reloads. In preview mode it explains that nothing is saved. */
  const run = useCallback(
    async (fn: () => Promise<unknown>) => {
      if (preview) {
        Alert.alert('Preview mode', 'Set EXPO_PUBLIC_API_URL to connect to the PillPal server. Changes are not saved in preview mode.');
        return;
      }
      await fn();
      await load('background');
    },
    [preview, load],
  );

  const role: Role = useMemo(() => {
    const caresForSomeone = data.patients.some((p) => p.status === 'ACCEPTED');
    return caresForSomeone && data.meds.length === 0 ? 'caregiver' : 'patient';
  }, [data.patients, data.meds.length]);

  const value: AppContextValue = {
    preview,
    sessionChecked,
    user,
    role,
    data,
    loading,
    refreshing,
    error,
    refresh,

    signIn: async (email, password) => {
      setUser(await api.auth.login(email, password));
    },
    signUp: async (input) => {
      const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone;
      setUser(await api.auth.register({ ...input, timezone }));
    },
    signOut: async () => {
      await api.auth.logout();
      setUser(null);
      setData(emptyData);
    },

    addMedication: (input) =>
      run(async () => {
        const { times, quantity, ...rest } = input;
        const med = await api.medications.create(rest);
        for (const timeOfDay of times) await api.schedules.create({ medicationId: med.id, timeOfDay, quantity: quantity ?? 1 });
      }),
    removeMedication: (id) => run(() => api.medications.remove(id)),
    addSchedule: (medicationId, timeOfDay, daysOfWeek = [], quantity = 1) => run(() => api.schedules.create({ medicationId, timeOfDay, daysOfWeek, quantity })),
    removeSchedule: (id) => run(() => api.schedules.remove(id)),

    markTaken: (doseId) => run(() => api.doses.markTaken(doseId)),
    skipDose: (doseId) => run(() => api.doses.skip(doseId)),
    logManualDose: (medicationId) => run(() => api.doses.logManual(medicationId)),
    addVital: (input) => run(() => api.vitals.add(input)),

    claimDevice: (claimCode, name) => run(() => api.devices.claim(claimCode, name)),
    unpairDevice: (id) => run(() => api.devices.unpair(id)),
    setSlot: (deviceId, index, medicationId, pillCount) => run(() => api.devices.setSlot(deviceId, index, medicationId, pillCount)),
    refillSlot: (deviceId, index, pillCount) => run(() => api.devices.refill(deviceId, index, pillCount)),
    dispenseNow: (deviceId, slotIndex) => run(() => api.devices.dispenseNow(deviceId, slotIndex)),
    ringDevice: (deviceId) => run(() => api.devices.ring(deviceId)),

    inviteCaregiver: async (email) => {
      if (preview) {
        Alert.alert('Preview mode', 'Connect to the server to invite caregivers.');
        return '';
      }
      const res = await api.caregivers.invite(email);
      await load('background');
      return res.inviteeHasAccount
        ? `${email} has been invited and will see the invite in their app.`
        : `${email} does not have an account yet. The invite activates as soon as they sign up.`;
    },
    acceptInvite: (linkId) => run(() => api.caregivers.accept(linkId)),
    removeCaregiverLink: (linkId) => run(() => api.caregivers.remove(linkId)),

    updateSettings: (patch) => run(() => api.notifications.updateSettings(patch)),
    markAllRead: () => run(() => api.notifications.markAllRead()),
    patientOverview: (patientId) => api.caregivers.overview(patientId),
  };

  return <AppContext.Provider value={value}>{children}</AppContext.Provider>;
}

export function useApp(): AppContextValue {
  const ctx = useContext(AppContext);
  if (!ctx) throw new Error('useApp must be used inside <AppProvider>');
  return ctx;
}
