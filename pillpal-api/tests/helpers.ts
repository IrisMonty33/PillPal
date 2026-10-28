import request from 'supertest';
import { createApp } from '../src/app';
import { prisma } from '../src/lib/prisma';

export const app = createApp();
export const api = () => request(app);

export const PROVISIONING_KEY = 'test-provisioning-key';
export const ADMIN_KEY = 'test-admin-key';

/** Wipe every table (users and devices cascade to everything else). */
export async function resetDb() {
  await prisma.$executeRawUnsafe('TRUNCATE TABLE "users", "devices" CASCADE');
}

let counter = 0;

export async function registerUser(overrides: Record<string, unknown> = {}) {
  counter++;
  const body = {
    email: `user${counter}-${Date.now()}@test.local`,
    password: 'Password123!',
    firstName: `Test${counter}`,
    timezone: 'America/New_York',
    ...overrides,
  };
  const res = await api().post('/api/v1/auth/register').send(body);
  if (res.status !== 201) throw new Error(`register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, email: body.email, password: body.password, auth: { Authorization: `Bearer ${res.body.accessToken}` } } as {
    user: { id: string; email: string; firstName: string; timezone: string };
    accessToken: string;
    refreshToken: string;
    email: string;
    password: string;
    auth: { Authorization: string };
  };
}

export async function registerDevice(serial = `PI-${Date.now()}-${counter++}`) {
  const res = await api().post('/api/v1/device/register').set('x-provisioning-key', PROVISIONING_KEY).send({ serialNumber: serial, firmwareVersion: '0.1.0' });
  if (res.status !== 201) throw new Error(`device register failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...res.body, headers: { 'x-device-key': res.body.apiKey as string } } as {
    deviceId: string;
    apiKey: string;
    claimCode: string;
    headers: { 'x-device-key': string };
  };
}

/** Registers a device and claims it for the given user. */
export async function claimedDevice(userAuth: { Authorization: string }, name = 'Test PillPal') {
  const device = await registerDevice();
  const res = await api().post('/api/v1/devices/claim').set(userAuth).send({ claimCode: device.claimCode, name });
  if (res.status !== 201) throw new Error(`claim failed: ${res.status} ${JSON.stringify(res.body)}`);
  return { ...device, device: res.body.device as { id: string; slots: { index: number; id: string }[] } };
}

export async function createMedication(userAuth: { Authorization: string }, data: Record<string, unknown> = {}) {
  const res = await api().post('/api/v1/medications').set(userAuth).send({ name: 'Metformin', strength: '500 mg', ...data });
  if (res.status !== 201) throw new Error(`medication failed: ${res.status} ${JSON.stringify(res.body)}`);
  return res.body.medication as { id: string; name: string };
}
