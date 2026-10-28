import { beforeAll, describe, expect, it } from 'vitest';
import { prisma } from '../src/lib/prisma';
import { runSchedulerTick } from '../src/jobs/scheduler';
import { localTimeString } from '../src/lib/time';
import { ADMIN_KEY, api, claimedDevice, createMedication, registerDevice, registerUser, resetDb } from './helpers';

/** A time of day (HH:MM) a few minutes from now in the given timezone. */
function soon(minutes: number, timezone: string) {
  return localTimeString(new Date(Date.now() + minutes * 60_000), timezone);
}

describe('device registration and claiming', () => {
  beforeAll(resetDb);

  it('registers a Pi, shows a claim code, and lets the user claim it', async () => {
    const user = await registerUser();
    const device = await registerDevice('PI-CLAIM-1');
    expect(device.apiKey).toMatch(/^pp_dev_/);
    expect(device.claimCode).toHaveLength(6);

    const status = await api().get('/api/v1/device/claim-status').set(device.headers);
    expect(status.body.claimed).toBe(false);

    const bad = await api().post('/api/v1/devices/claim').set(user.auth).send({ claimCode: 'ZZZZZZ' });
    expect(bad.status).toBe(404);

    const claim = await api().post('/api/v1/devices/claim').set(user.auth).send({ claimCode: device.claimCode, name: 'Kitchen' });
    expect(claim.status).toBe(201);
    expect(claim.body.device.name).toBe('Kitchen');
    expect(claim.body.device.slots).toHaveLength(5);

    const again = await api().post('/api/v1/devices/claim').set(user.auth).send({ claimCode: device.claimCode });
    expect(again.status).toBe(404); // code is consumed

    const status2 = await api().get('/api/v1/device/claim-status').set(device.headers);
    expect(status2.body.claimed).toBe(true);
    expect(status2.body.owner.firstName).toBe(user.user.firstName);
  });

  it('rejects wrong provisioning and device keys', async () => {
    expect((await api().post('/api/v1/device/register').set('x-provisioning-key', 'wrong').send({ serialNumber: 'PI-X' })).status).toBe(401);
    expect((await api().get('/api/v1/device/sync').set('x-device-key', 'pp_dev_nope')).status).toBe(401);
  });

  it('re-registering the same serial rotates the API key', async () => {
    const first = await registerDevice('PI-ROTATE');
    const second = await registerDevice('PI-ROTATE');
    expect(second.deviceId).toBe(first.deviceId);
    expect((await api().get('/api/v1/device/sync').set(first.headers)).status).toBe(401);
    expect((await api().get('/api/v1/device/sync').set(second.headers)).status).toBe(200);
  });
});

describe('medications, slots, schedules and dispensing', () => {
  beforeAll(resetDb);

  it('runs the whole happy path from schedule to dispensed dose', async () => {
    const user = await registerUser();
    const { device, headers } = await claimedDevice(user.auth);
    const med = await createMedication(user.auth, { name: 'Lisinopril', strength: '10 mg', refillThreshold: 5 });

    // Load 7 pills into slot 2.
    const slotRes = await api().put(`/api/v1/devices/${device.id}/slots/2`).set(user.auth).send({ medicationId: med.id, pillCount: 7 });
    expect(slotRes.status).toBe(200);
    expect(slotRes.body.slot.pillCount).toBe(7);

    // Schedule a dose 3 minutes from now (user timezone).
    const sched = await api()
      .post('/api/v1/schedules')
      .set(user.auth)
      .send({ medicationId: med.id, timeOfDay: soon(3, user.user.timezone), quantity: 2, graceMinutes: 30, label: 'Test' });
    expect(sched.status).toBe(201);

    // The Pi syncs and sees the slot, the schedule and the upcoming dose.
    const sync = await api().post('/api/v1/device/sync').set(headers).send({ firmwareVersion: '0.2.0', slots: [{ index: 2, weightGrams: 1.2 }] });
    expect(sync.status).toBe(200);
    expect(sync.body.owner.id).toBe(user.user.id);
    expect(sync.body.slots.find((s: { index: number }) => s.index === 2).medication.name).toBe('Lisinopril');
    expect(sync.body.schedules).toHaveLength(1);
    expect(sync.body.upcomingDoses.length).toBeGreaterThanOrEqual(1);
    const dose = sync.body.upcomingDoses[0];
    expect(dose.slotIndex).toBe(2);
    expect(dose.quantity).toBe(2);

    // The Pi dispenses it; the break-beam counted 2 pills.
    const dispensed = await api().post(`/api/v1/device/doses/${dose.id}/dispensed`).set(headers).send({ detectedCount: 2, slotIndex: 2 });
    expect(dispensed.status).toBe(200);
    expect(dispensed.body.dose.status).toBe('TAKEN'); // requireTakenConfirmation defaults to false
    expect(dispensed.body.dose.detectedCount).toBe(2);

    // Reporting twice is idempotent.
    expect((await api().post(`/api/v1/device/doses/${dose.id}/dispensed`).set(headers).send({})).status).toBe(200);

    // Pill count dropped to 5 -> LOW_STOCK alert (threshold 5).
    const dev = await api().get(`/api/v1/devices/${device.id}`).set(user.auth);
    expect(dev.body.device.slots.find((s: { index: number }) => s.index === 2).pillCount).toBe(5);
    expect(dev.body.device.isOnline).toBe(true);

    const notifications = await api().get('/api/v1/notifications').set(user.auth);
    expect(notifications.body.notifications.map((n: { type: string }) => n.type)).toContain('LOW_STOCK');

    // Refilling resets the alert and shows up in inventory history.
    const refill = await api().post(`/api/v1/devices/${device.id}/slots/2/refill`).set(user.auth).send({ pillCount: 30 });
    expect(refill.body.slot.pillCount).toBe(30);
    const inv = await api().get(`/api/v1/devices/${device.id}/slots/2/inventory`).set(user.auth);
    expect(inv.body.events.map((e: { reason: string }) => e.reason)).toEqual(['REFILL', 'DISPENSE', 'REFILL']);

    // Adherence counts the taken dose (the range must include the scheduled time, a few minutes ahead).
    const to = new Date(Date.now() + 24 * 3_600_000).toISOString();
    const adherence = await api().get(`/api/v1/doses/adherence?from=${new Date(Date.now() - 3_600_000).toISOString()}&to=${to}`).set(user.auth);
    expect(adherence.body.adherence.taken).toBe(1);
    expect(adherence.body.adherence.adherenceRate).toBe(100);
  });

  it('requires taken confirmation when the user enables it', async () => {
    const user = await registerUser();
    const { device, headers } = await claimedDevice(user.auth);
    await api().patch('/api/v1/notifications/settings').set(user.auth).send({ requireTakenConfirmation: true });
    const med = await createMedication(user.auth);
    await api().put(`/api/v1/devices/${device.id}/slots/1`).set(user.auth).send({ medicationId: med.id, pillCount: 20 });
    await api().post('/api/v1/schedules').set(user.auth).send({ medicationId: med.id, timeOfDay: soon(2, user.user.timezone) });

    const sync = await api().get('/api/v1/device/sync').set(headers);
    const dose = sync.body.upcomingDoses[0];
    const dispensed = await api().post(`/api/v1/device/doses/${dose.id}/dispensed`).set(headers).send({ detectedCount: 1 });
    expect(dispensed.body.dose.status).toBe('DISPENSED');

    const taken = await api().post(`/api/v1/device/doses/${dose.id}/taken`).set(headers).send({ method: 'touchscreen' });
    expect(taken.body.dose.status).toBe('TAKEN');

    // Cannot skip a dose that was already taken.
    expect((await api().post(`/api/v1/doses/${dose.id}/skip`).set(user.auth).send({})).status).toBe(409);
  });

  it('editing a schedule rebuilds upcoming doses and does not duplicate them', async () => {
    const user = await registerUser();
    const med = await createMedication(user.auth);
    const sched = await api().post('/api/v1/schedules').set(user.auth).send({ medicationId: med.id, timeOfDay: soon(10, user.user.timezone) });
    const before = await prisma.doseEvent.count({ where: { scheduleId: sched.body.schedule.id } });
    expect(before).toBeGreaterThanOrEqual(2); // today + tomorrow within the 48h horizon

    await runSchedulerTick(); // generating again must not add duplicates
    expect(await prisma.doseEvent.count({ where: { scheduleId: sched.body.schedule.id } })).toBe(before);

    const patched = await api().patch(`/api/v1/schedules/${sched.body.schedule.id}`).set(user.auth).send({ quantity: 3 });
    expect(patched.status).toBe(200);
    const doses = await prisma.doseEvent.findMany({ where: { scheduleId: sched.body.schedule.id } });
    expect(doses.every((d) => d.quantity === 3)).toBe(true);

    await api().delete(`/api/v1/schedules/${sched.body.schedule.id}`).set(user.auth);
    expect(await prisma.doseEvent.count({ where: { scheduleId: sched.body.schedule.id, status: 'SCHEDULED' } })).toBe(0);
  });

  it('queues remote commands and completes them from the device', async () => {
    const user = await registerUser();
    const { device, headers } = await claimedDevice(user.auth);
    const med = await createMedication(user.auth);
    await api().put(`/api/v1/devices/${device.id}/slots/3`).set(user.auth).send({ medicationId: med.id, pillCount: 10 });

    const cmd = await api().post(`/api/v1/devices/${device.id}/commands`).set(user.auth).send({ type: 'DISPENSE', slotIndex: 3, quantity: 1 });
    expect(cmd.status).toBe(201);
    expect(cmd.body.command.payload.doseEventId).toBeTruthy();

    const sync = await api().get('/api/v1/device/sync').set(headers);
    expect(sync.body.pendingCommands.map((c: { id: string }) => c.id)).toContain(cmd.body.command.id);
    // The remote dose is driven by the command, so it must NOT also appear as an upcoming scheduled dose.
    expect(sync.body.upcomingDoses.map((d: { id: string }) => d.id)).not.toContain(cmd.body.command.payload.doseEventId);
    // Delivered commands are not sent twice.
    const sync2 = await api().get('/api/v1/device/sync').set(headers);
    expect(sync2.body.pendingCommands).toHaveLength(0);

    const done = await api().post(`/api/v1/device/commands/${cmd.body.command.id}/complete`).set(headers).send({ success: true, result: { detectedCount: 1 } });
    expect(done.body.command.status).toBe('COMPLETED');

    const dose = await prisma.doseEvent.findUniqueOrThrow({ where: { id: cmd.body.command.payload.doseEventId } });
    expect(dose.status).toBe('TAKEN');
    expect(dose.source).toBe('REMOTE');
    expect((await prisma.slot.findFirstOrThrow({ where: { deviceId: device.id, index: 3 } })).pillCount).toBe(9);

    // A failed dispense alerts the user.
    const cmd2 = await api().post(`/api/v1/devices/${device.id}/commands`).set(user.auth).send({ type: 'DISPENSE', slotIndex: 3 });
    await api().get('/api/v1/device/sync').set(headers);
    await api().post(`/api/v1/device/commands/${cmd2.body.command.id}/complete`).set(headers).send({ success: false, error: 'hopper jammed' });
    const failed = await prisma.doseEvent.findUniqueOrThrow({ where: { id: cmd2.body.command.payload.doseEventId } });
    expect(failed.status).toBe('FAILED');
    const notifications = await api().get('/api/v1/notifications').set(user.auth);
    expect(notifications.body.notifications[0].type).toBe('DEVICE_ERROR');
  });

  it('isolates data between users', async () => {
    const a = await registerUser();
    const b = await registerUser();
    const med = await createMedication(a.auth);
    expect((await api().get(`/api/v1/medications/${med.id}`).set(b.auth)).status).toBe(404);
    expect((await api().get('/api/v1/medications').set(b.auth)).body.medications).toHaveLength(0);
  });
});

describe('scheduler job (automated notifications)', () => {
  beforeAll(resetDb);

  it('sends reminders, marks missed doses, alerts caregivers and detects offline devices', async () => {
    const patient = await registerUser({ firstName: 'Pat' });
    const caregiver = await registerUser({ firstName: 'Carrie' });
    const { device, headers } = await claimedDevice(patient.auth);

    // Caregiver link: invite + accept.
    const invite = await api().post('/api/v1/caregivers/invite').set(patient.auth).send({ email: caregiver.email });
    expect(invite.status).toBe(201);
    expect(invite.body.inviteeHasAccount).toBe(true);
    const accept = await api().post(`/api/v1/caregivers/${invite.body.link.id}/accept`).set(caregiver.auth);
    expect(accept.status).toBe(200);
    expect(accept.body.link.status).toBe('ACCEPTED');

    const med = await createMedication(patient.auth, { name: 'Atorvastatin' });
    await api().put(`/api/v1/devices/${device.id}/slots/1`).set(patient.auth).send({ medicationId: med.id, pillCount: 30 });
    const sched = await api().post('/api/v1/schedules').set(patient.auth).send({ medicationId: med.id, timeOfDay: soon(5, patient.user.timezone), graceMinutes: 10 });
    const dose = await prisma.doseEvent.findFirstOrThrow({ where: { scheduleId: sched.body.schedule.id }, orderBy: { scheduledAt: 'asc' } });

    // 1) Reminder: pretend it is scheduled time.
    const tick1 = await runSchedulerTick(dose.scheduledAt);
    expect(tick1.remindersSent).toBe(1);
    expect(tick1.dosesMissed).toBe(0);
    let notes = await api().get('/api/v1/notifications').set(patient.auth);
    expect(notes.body.notifications[0].type).toBe('DOSE_REMINDER');
    expect(notes.body.notifications[0].title).toContain('Atorvastatin');

    // Running again does not send the reminder twice.
    expect((await runSchedulerTick(dose.scheduledAt)).remindersSent).toBe(0);

    // 2) Missed: pretend the grace window closed.
    const tick2 = await runSchedulerTick(new Date(dose.windowEndsAt.getTime() + 1000));
    expect(tick2.dosesMissed).toBe(1);
    expect((await prisma.doseEvent.findUniqueOrThrow({ where: { id: dose.id } })).status).toBe('MISSED');
    notes = await api().get('/api/v1/notifications').set(patient.auth);
    const types = (list: { type: string }[]) => list.map((n) => n.type);
    expect(types(notes.body.notifications)).toContain('DOSE_MISSED');
    const careNotes = await api().get('/api/v1/notifications').set(caregiver.auth);
    const careMissed = careNotes.body.notifications.find((n: { type: string }) => n.type === 'DOSE_MISSED');
    expect(careMissed).toBeTruthy();
    expect(careMissed.title).toContain('Pat');

    // The patient can still mark a missed dose as taken late.
    const late = await api().post(`/api/v1/doses/${dose.id}/taken`).set(patient.auth).send({});
    expect(late.body.dose.status).toBe('TAKEN');

    // 3) Offline: the device has not synced "for 10 minutes".
    await api().get('/api/v1/device/sync').set(headers);
    const tick3 = await runSchedulerTick(new Date(Date.now() + 10 * 60_000));
    expect(tick3.devicesOffline).toBe(1);
    notes = await api().get('/api/v1/notifications').set(patient.auth);
    expect(notes.body.notifications[0].type).toBe('DEVICE_OFFLINE');
    expect((await api().get(`/api/v1/devices/${device.id}`).set(patient.auth)).body.device.status).toBe('OFFLINE');

    // ...and comes back online on the next sync.
    await api().get('/api/v1/device/sync').set(headers);
    expect((await api().get(`/api/v1/devices/${device.id}`).set(patient.auth)).body.device.status).toBe('ONLINE');

    // Caregiver overview works; a stranger is refused.
    const overview = await api().get(`/api/v1/caregivers/patients/${patient.user.id}/overview`).set(caregiver.auth);
    expect(overview.status).toBe(200);
    expect(overview.body.patient.firstName).toBe('Pat');
    const stranger = await registerUser();
    expect((await api().get(`/api/v1/caregivers/patients/${patient.user.id}/overview`).set(stranger.auth)).status).toBe(403);
  });

  it('exposes a manual tick for admins and expires old commands', async () => {
    const user = await registerUser();
    const { device } = await claimedDevice(user.auth);
    const cmd = await api().post(`/api/v1/devices/${device.id}/commands`).set(user.auth).send({ type: 'RING', seconds: 3 });
    expect((await api().post('/api/v1/system/tick')).status).toBe(401);
    const tick = await api().post('/api/v1/system/tick').set('x-admin-key', ADMIN_KEY);
    expect(tick.status).toBe(200);
    await prisma.deviceCommand.update({ where: { id: cmd.body.command.id }, data: { expiresAt: new Date(Date.now() - 1000) } });
    const tick2 = await runSchedulerTick();
    expect(tick2.commandsExpired).toBe(1);
  });

  it('records vitals from the device and flags dangerous readings', async () => {
    const user = await registerUser();
    const { headers } = await claimedDevice(user.auth);
    const ok = await api().post('/api/v1/device/vitals').set(headers).send({ type: 'BLOOD_PRESSURE', systolic: 121, diastolic: 79, pulse: 66 });
    expect(ok.status).toBe(201);
    expect(ok.body.reading.flagged).toBe(false);
    const high = await api().post('/api/v1/device/vitals').set(headers).send({ type: 'BLOOD_PRESSURE', systolic: 190, diastolic: 125 });
    expect(high.body.reading.flagged).toBe(true);
    const notes = await api().get('/api/v1/notifications').set(user.auth);
    expect(notes.body.notifications[0].type).toBe('VITALS_ALERT');
    const latest = await api().get('/api/v1/vitals/latest').set(user.auth);
    expect(latest.body.latest.BLOOD_PRESSURE.systolic).toBe(190);
    const dashboard = await api().get('/api/v1/dashboard').set(user.auth);
    expect(dashboard.status).toBe(200);
    expect(dashboard.body.unreadNotifications).toBe(1);
  });
});
