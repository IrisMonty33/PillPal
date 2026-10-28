/**
 * Thin client for the PillPal API. Every screen talks to the server through these functions.
 *
 * - Tokens are kept in AsyncStorage (see `configureApi` in App.tsx).
 * - When the access token expires (401) the client refreshes it once and retries.
 * - Errors are thrown as `ApiError` with the server's `code` / `message` / field `details`.
 */
import { API_URL } from './config';
import type {
  Adherence, ApiCaregiverLink, ApiDevice, ApiDose, ApiMedication, ApiNotification, ApiSchedule, ApiSlot, ApiUser,
  ApiVital, AuthResponse, Dashboard, MedicationForm, NotificationSettings, PatientOverview, VitalType,
} from './types';

export class ApiError extends Error {
  constructor(
    public status: number,
    public code: string,
    message: string,
    public details?: { path: string; message: string }[],
  ) {
    super(message);
  }
}

/** Minimal key/value storage interface so the client works with AsyncStorage (app) or memory (tests). */
export interface TokenStorage {
  getItem(key: string): Promise<string | null>;
  setItem(key: string, value: string): Promise<void>;
  removeItem(key: string): Promise<void>;
}

const ACCESS_KEY = 'pillpal.accessToken';
const REFRESH_KEY = 'pillpal.refreshToken';

let storage: TokenStorage = {
  getItem: async () => null,
  setItem: async () => undefined,
  removeItem: async () => undefined,
};
let baseUrl = API_URL;
let onSessionLost: () => void = () => undefined;

export function configureApi(options: { storage: TokenStorage; baseUrl?: string; onSessionLost?: () => void }) {
  storage = options.storage;
  if (options.baseUrl) baseUrl = options.baseUrl.replace(/\/+$/, '');
  if (options.onSessionLost) onSessionLost = options.onSessionLost;
}

export async function hasSession(): Promise<boolean> {
  return !!(await storage.getItem(REFRESH_KEY));
}

async function saveTokens(accessToken: string, refreshToken: string) {
  await storage.setItem(ACCESS_KEY, accessToken);
  await storage.setItem(REFRESH_KEY, refreshToken);
}

async function clearTokens() {
  await storage.removeItem(ACCESS_KEY);
  await storage.removeItem(REFRESH_KEY);
}

async function refreshTokens(): Promise<boolean> {
  const refreshToken = await storage.getItem(REFRESH_KEY);
  if (!refreshToken) return false;
  const res = await fetch(`${baseUrl}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await clearTokens();
    onSessionLost();
    return false;
  }
  const data = (await res.json()) as AuthResponse;
  await saveTokens(data.accessToken, data.refreshToken);
  return true;
}

async function request<T>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const accessToken = await storage.getItem(ACCESS_KEY);
  let res: Response;
  try {
    res = await fetch(`${baseUrl}${path}`, {
      method,
      headers: {
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (err) {
    throw new ApiError(0, 'NETWORK', `Cannot reach the PillPal server at ${baseUrl}. Is it running and is EXPO_PUBLIC_API_URL correct?`);
  }

  if (res.status === 401 && retry && (await storage.getItem(REFRESH_KEY))) {
    if (await refreshTokens()) return request<T>(method, path, body, false);
  }
  if (res.status === 204) return undefined as T;

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: { path: string; message: string }[] } }).error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

const get = <T>(path: string) => request<T>('GET', path);
const post = <T>(path: string, body?: unknown) => request<T>('POST', path, body ?? {});
const put = <T>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {});
const patch = <T>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {});
const del = <T>(path: string) => request<T>('DELETE', path);

// ------------------------------------------------------------------ auth
export const auth = {
  async login(email: string, password: string) {
    const data = await post<AuthResponse>('/auth/login', { email: email.trim().toLowerCase(), password });
    await saveTokens(data.accessToken, data.refreshToken);
    return data.user;
  },
  async register(input: { email: string; password: string; firstName: string; lastName?: string; timezone?: string }) {
    const data = await post<AuthResponse>('/auth/register', { ...input, email: input.email.trim().toLowerCase() });
    await saveTokens(data.accessToken, data.refreshToken);
    return data.user;
  },
  async logout() {
    const refreshToken = await storage.getItem(REFRESH_KEY);
    if (refreshToken) await post('/auth/logout', { refreshToken }).catch(() => undefined);
    await clearTokens();
  },
  me: () => get<{ user: ApiUser & { settings: NotificationSettings | null } }>('/auth/me').then((r) => r.user),
  updateMe: (data: { firstName?: string; lastName?: string | null; timezone?: string }) => patch<{ user: ApiUser }>('/auth/me', data).then((r) => r.user),
  registerPushToken: (token: string, platform: 'IOS' | 'ANDROID' | 'WEB') => post('/auth/push-tokens', { token, platform }),
};

// ------------------------------------------------------------------ data
export const dashboard = () => get<Dashboard>('/dashboard');

export const medications = {
  list: () => get<{ medications: ApiMedication[] }>('/medications').then((r) => r.medications),
  create: (data: { name: string; strength?: string; form?: MedicationForm; instructions?: string; refillThreshold?: number }) =>
    post<{ medication: ApiMedication }>('/medications', data).then((r) => r.medication),
  update: (id: string, data: Partial<{ name: string; strength: string | null; form: MedicationForm; instructions: string | null; refillThreshold: number }>) =>
    patch<{ medication: ApiMedication }>(`/medications/${id}`, data).then((r) => r.medication),
  /** Deactivates the medication (history is kept, upcoming doses are cancelled). */
  remove: (id: string) => del<void>(`/medications/${id}`),
};

export const schedules = {
  create: (data: { medicationId: string; timeOfDay: string; daysOfWeek?: number[]; quantity?: number; graceMinutes?: number; label?: string }) =>
    post<{ schedule: ApiSchedule }>('/schedules', data).then((r) => r.schedule),
  remove: (id: string) => del<void>(`/schedules/${id}`),
};

export const doses = {
  list: (params: { limit?: number; from?: string; to?: string } = {}) => {
    const q = new URLSearchParams();
    if (params.limit) q.set('limit', String(params.limit));
    if (params.from) q.set('from', params.from);
    if (params.to) q.set('to', params.to);
    return get<{ doses: ApiDose[]; total: number }>(`/doses?${q.toString()}`);
  },
  today: () => get<{ doses: ApiDose[]; nextDose: ApiDose | null }>('/doses/today'),
  adherence: (days = 30) => get<{ adherence: Adherence }>(`/doses/adherence?days=${days}`).then((r) => r.adherence),
  markTaken: (id: string) => post<{ dose: ApiDose }>(`/doses/${id}/taken`).then((r) => r.dose),
  skip: (id: string, reason?: string) => post<{ dose: ApiDose }>(`/doses/${id}/skip`, { reason }).then((r) => r.dose),
  logManual: (medicationId: string, quantity = 1) => post<{ dose: ApiDose }>('/doses/manual', { medicationId, quantity }).then((r) => r.dose),
};

export const vitals = {
  list: (limit = 100) => get<{ readings: ApiVital[] }>(`/vitals?limit=${limit}`).then((r) => r.readings),
  add: (data: { type: VitalType; systolic?: number; diastolic?: number; pulse?: number; value?: number; unit?: string }) =>
    post<{ reading: ApiVital }>('/vitals', data).then((r) => r.reading),
};

export const notifications = {
  list: (limit = 50) => get<{ notifications: ApiNotification[]; unreadCount: number }>(`/notifications?limit=${limit}`),
  markRead: (id: string) => post(`/notifications/${id}/read`),
  markAllRead: () => post('/notifications/read-all'),
  settings: () => get<{ settings: NotificationSettings }>('/notifications/settings').then((r) => r.settings),
  updateSettings: (data: Partial<NotificationSettings>) => patch<{ settings: NotificationSettings }>('/notifications/settings', data).then((r) => r.settings),
};

export const devices = {
  list: () => get<{ devices: ApiDevice[] }>('/devices').then((r) => r.devices),
  claim: (claimCode: string, name?: string) => post<{ device: ApiDevice }>('/devices/claim', { claimCode: claimCode.trim().toUpperCase(), name }).then((r) => r.device),
  rename: (id: string, name: string) => patch<{ device: ApiDevice }>(`/devices/${id}`, { name }).then((r) => r.device),
  unpair: (id: string) => del<void>(`/devices/${id}`),
  setSlot: (deviceId: string, index: number, medicationId: string | null, pillCount?: number) =>
    put<{ slot: ApiSlot }>(`/devices/${deviceId}/slots/${index}`, { medicationId, pillCount }).then((r) => r.slot),
  refill: (deviceId: string, index: number, pillCount: number) => post<{ slot: ApiSlot }>(`/devices/${deviceId}/slots/${index}/refill`, { pillCount }).then((r) => r.slot),
  dispenseNow: (deviceId: string, slotIndex: number, quantity = 1) => post<{ command: { id: string } }>(`/devices/${deviceId}/commands`, { type: 'DISPENSE', slotIndex, quantity }),
  ring: (deviceId: string, seconds = 3) => post(`/devices/${deviceId}/commands`, { type: 'RING', seconds }),
};

export const caregivers = {
  list: () => get<{ caregivers: ApiCaregiverLink[]; patients: ApiCaregiverLink[] }>('/caregivers'),
  invite: (email: string) => post<{ link: ApiCaregiverLink; inviteeHasAccount: boolean }>('/caregivers/invite', { email: email.trim().toLowerCase() }),
  accept: (id: string) => post<{ link: ApiCaregiverLink }>(`/caregivers/${id}/accept`).then((r) => r.link),
  remove: (id: string) => del<void>(`/caregivers/${id}`),
  overview: (patientId: string) => get<PatientOverview>(`/caregivers/patients/${patientId}/overview`),
};

export const health = () => get<{ status: string; database: string }>('/health');
