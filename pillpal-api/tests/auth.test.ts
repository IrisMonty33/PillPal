import { beforeAll, describe, expect, it } from 'vitest';
import { api, registerUser, resetDb } from './helpers';

describe('auth', () => {
  beforeAll(resetDb);

  it('registers, logs in, refreshes and reads the profile', async () => {
    const reg = await registerUser({ firstName: 'Alan' });
    expect(reg.user.email).toContain('@test.local');
    expect(reg.accessToken).toBeTruthy();

    const login = await api().post('/api/v1/auth/login').send({ email: reg.email, password: reg.password });
    expect(login.status).toBe(200);
    expect(login.body.user.firstName).toBe('Alan');
    expect(login.body.user.passwordHash).toBeUndefined();

    const me = await api().get('/api/v1/auth/me').set('Authorization', `Bearer ${login.body.accessToken}`);
    expect(me.status).toBe(200);
    expect(me.body.user.settings.doseReminders).toBe(true);

    const refreshed = await api().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(refreshed.status).toBe(200);
    expect(refreshed.body.accessToken).toBeTruthy();

    // The old refresh token is rotated out.
    const reused = await api().post('/api/v1/auth/refresh').send({ refreshToken: login.body.refreshToken });
    expect(reused.status).toBe(401);
  });

  it('rejects bad credentials, duplicate emails and missing tokens', async () => {
    const reg = await registerUser();
    expect((await api().post('/api/v1/auth/login').send({ email: reg.email, password: 'wrong-password' })).status).toBe(401);
    expect((await api().post('/api/v1/auth/register').send({ email: reg.email, password: 'Password123!', firstName: 'Dup' })).status).toBe(409);
    expect((await api().get('/api/v1/auth/me')).status).toBe(401);
    expect((await api().get('/api/v1/auth/me').set('Authorization', 'Bearer nope')).status).toBe(401);
  });

  it('validates request bodies', async () => {
    const res = await api().post('/api/v1/auth/register').send({ email: 'not-an-email', password: 'short', firstName: '' });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe('VALIDATION_ERROR');
    expect(res.body.error.details.map((d: { path: string }) => d.path)).toEqual(expect.arrayContaining(['email', 'password', 'firstName']));
  });

  it('updates the profile and timezone', async () => {
    const reg = await registerUser();
    const res = await api().patch('/api/v1/auth/me').set(reg.auth).send({ timezone: 'Europe/London', lastName: 'Smith' });
    expect(res.status).toBe(200);
    expect(res.body.user.timezone).toBe('Europe/London');
    expect((await api().patch('/api/v1/auth/me').set(reg.auth).send({ timezone: 'Mars/Olympus' })).status).toBe(400);
  });
});
