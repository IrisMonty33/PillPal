/**
 * PillPal API client for the React Native (Expo) app.
 * Drop this file into the app (e.g. src/lib/api.ts), set BASE_URL, and call the functions.
 *
 *   npx expo install expo-secure-store expo-notifications expo-device
 *
 * Tokens are kept in SecureStore; an expired access token is refreshed automatically.
 */
import * as SecureStore from 'expo-secure-store';

// Your laptop's LAN IP while developing (phone and laptop on the same Wi-Fi), e.g. http://192.168.1.20:4000/api/v1
export const BASE_URL = 'http://192.168.1.20:4000/api/v1';

type Json = Record<string, unknown>;

export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string, public details?: unknown) {
    super(message);
  }
}

// ---------------------------------------------------------------- tokens
const ACCESS_KEY = 'pillpal.accessToken';
const REFRESH_KEY = 'pillpal.refreshToken';

export async function saveTokens(accessToken: string, refreshToken: string) {
  await SecureStore.setItemAsync(ACCESS_KEY, accessToken);
  await SecureStore.setItemAsync(REFRESH_KEY, refreshToken);
}
export async function clearTokens() {
  await SecureStore.deleteItemAsync(ACCESS_KEY);
  await SecureStore.deleteItemAsync(REFRESH_KEY);
}
export const isLoggedIn = async () => !!(await SecureStore.getItemAsync(REFRESH_KEY));

// ---------------------------------------------------------------- core request helper
async function request<T = Json>(method: string, path: string, body?: unknown, retry = true): Promise<T> {
  const accessToken = await SecureStore.getItemAsync(ACCESS_KEY);
  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers: {
      'Content-Type': 'application/json',
      ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (res.status === 401 && retry && (await SecureStore.getItemAsync(REFRESH_KEY))) {
    const refreshed = await refreshTokens();
    if (refreshed) return request<T>(method, path, body, false);
  }

  if (res.status === 204) return undefined as T;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = (data as { error?: { code: string; message: string; details?: unknown } }).error;
    throw new ApiError(res.status, err?.code ?? 'HTTP_ERROR', err?.message ?? res.statusText, err?.details);
  }
  return data as T;
}

async function refreshTokens(): Promise<boolean> {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
  if (!refreshToken) return false;
  const res = await fetch(`${BASE_URL}/auth/refresh`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ refreshToken }),
  });
  if (!res.ok) {
    await clearTokens();
    return false;
  }
  const data = await res.json();
  await saveTokens(data.accessToken, data.refreshToken);
  return true;
}

export const api = {
  get: <T = Json>(path: string) => request<T>('GET', path),
  post: <T = Json>(path: string, body?: unknown) => request<T>('POST', path, body ?? {}),
  put: <T = Json>(path: string, body?: unknown) => request<T>('PUT', path, body ?? {}),
  patch: <T = Json>(path: string, body?: unknown) => request<T>('PATCH', path, body ?? {}),
  delete: <T = Json>(path: string) => request<T>('DELETE', path),
};

// ---------------------------------------------------------------- auth
export async function register(input: { email: string; password: string; firstName: string; lastName?: string; timezone?: string }) {
  const data = await api.post<{ user: Json; accessToken: string; refreshToken: string }>('/auth/register', input);
  await saveTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function login(email: string, password: string) {
  const data = await api.post<{ user: Json; accessToken: string; refreshToken: string }>('/auth/login', { email, password });
  await saveTokens(data.accessToken, data.refreshToken);
  return data.user;
}

export async function logout() {
  const refreshToken = await SecureStore.getItemAsync(REFRESH_KEY);
  if (refreshToken) await api.post('/auth/logout', { refreshToken }).catch(() => undefined);
  await clearTokens();
}

// ---------------------------------------------------------------- typical screens
export const getDashboard = () => api.get('/dashboard');
export const getMedications = () => api.get<{ medications: Json[] }>('/medications');
export const createMedication = (med: { name: string; strength?: string; form?: 'TABLET' | 'CAPSULE' | 'SOFTGEL' | 'OTHER'; instructions?: string }) =>
  api.post('/medications', med);
export const createSchedule = (s: { medicationId: string; timeOfDay: string; daysOfWeek?: number[]; quantity?: number; graceMinutes?: number; label?: string }) =>
  api.post('/schedules', s);
export const getTodayDoses = () => api.get<{ doses: Json[]; nextDose: Json | null }>('/doses/today');
export const markDoseTaken = (doseId: string) => api.post(`/doses/${doseId}/taken`);
export const skipDose = (doseId: string, reason?: string) => api.post(`/doses/${doseId}/skip`, { reason });
export const getAdherence = (days = 30) => api.get(`/doses/adherence?days=${days}`);
export const claimDevice = (claimCode: string, name?: string) => api.post('/devices/claim', { claimCode, name });
export const getDevices = () => api.get<{ devices: Json[] }>('/devices');
export const loadSlot = (deviceId: string, slotIndex: number, medicationId: string | null, pillCount?: number) =>
  api.put(`/devices/${deviceId}/slots/${slotIndex}`, { medicationId, pillCount });
export const dispenseNow = (deviceId: string, slotIndex: number, quantity = 1) =>
  api.post(`/devices/${deviceId}/commands`, { type: 'DISPENSE', slotIndex, quantity });
export const getNotifications = () => api.get<{ notifications: Json[]; unreadCount: number }>('/notifications');
export const getVitals = (type?: string) => api.get(`/vitals${type ? `?type=${type}` : ''}`);
export const addBloodPressure = (systolic: number, diastolic: number, pulse?: number) =>
  api.post('/vitals', { type: 'BLOOD_PRESSURE', systolic, diastolic, pulse });

// ---------------------------------------------------------------- push notifications (Expo)
/**
 * Call once after login. Requires `expo-notifications` + `expo-device`:
 *
 *   import * as Notifications from 'expo-notifications';
 *   import * as Device from 'expo-device';
 *   const { status } = await Notifications.requestPermissionsAsync();
 *   if (status === 'granted' && Device.isDevice) {
 *     const token = (await Notifications.getExpoPushTokenAsync({ projectId: '<your-expo-project-id>' })).data;
 *     await registerPushToken(token, Platform.OS === 'ios' ? 'IOS' : 'ANDROID');
 *   }
 */
export const registerPushToken = (token: string, platform: 'IOS' | 'ANDROID') => api.post('/auth/push-tokens', { token, platform });
