import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { currentUser, requireUser } from '../middleware/auth';
import { idParam } from '../lib/validation';
import { notify } from '../services/notifications';
import { adherenceSummary } from '../services/doseEngine';
import { startOfLocalDay } from '../lib/time';

/**
 * Caregiver sharing. A patient invites a caregiver by email; once accepted the caregiver
 * can see the patient's adherence and receives the alerts enabled on the link.
 */
export const caregiversRouter = Router();
caregiversRouter.use(requireUser);

const personSelect = { id: true, email: true, firstName: true, lastName: true } as const;

/** GET /caregivers - links where I am the patient, and links where I am the caregiver. */
caregiversRouter.get('/', async (req, res) => {
  const me = currentUser(req);
  const [myCaregivers, myPatients] = await Promise.all([
    prisma.caregiverLink.findMany({ where: { patientId: me.id, status: { not: 'REVOKED' } }, include: { caregiver: { select: personSelect } }, orderBy: { createdAt: 'asc' } }),
    prisma.caregiverLink.findMany({
      where: { OR: [{ caregiverId: me.id }, { inviteEmail: me.email, caregiverId: null }], status: { not: 'REVOKED' } },
      include: { patient: { select: personSelect } },
      orderBy: { createdAt: 'asc' },
    }),
  ]);
  res.json({ caregivers: myCaregivers, patients: myPatients });
});

/** POST /caregivers/invite { email, notifyMissedDoses?, ... } */
caregiversRouter.post('/invite', async (req, res) => {
  const body = z
    .object({
      email: z.email().transform((e) => e.toLowerCase().trim()),
      notifyMissedDoses: z.boolean().default(true),
      notifyLowStock: z.boolean().default(true),
      notifyDeviceIssues: z.boolean().default(true),
      notifyVitals: z.boolean().default(true),
    })
    .parse(req.body);
  const me = currentUser(req);
  if (body.email === me.email) throw ApiError.badRequest('You cannot invite yourself');

  const { email, ...permissions } = body;
  const caregiver = await prisma.user.findUnique({ where: { email }, select: { id: true } });
  const link = await prisma.caregiverLink.upsert({
    where: { patientId_inviteEmail: { patientId: me.id, inviteEmail: email } },
    create: { patientId: me.id, inviteEmail: email, caregiverId: caregiver?.id ?? null, ...permissions, status: 'PENDING' },
    update: { caregiverId: caregiver?.id ?? null, status: 'PENDING', acceptedAt: null, ...permissions },
    include: { caregiver: { select: personSelect } },
  });

  if (caregiver) {
    await notify(caregiver.id, {
      type: 'CAREGIVER_INVITE',
      title: `${me.firstName} wants you as a caregiver`,
      body: `${me.firstName} ${me.lastName ?? ''} invited you to follow their medication schedule in PillPal.`.replace('  ', ' '),
      data: { linkId: link.id, patientId: me.id },
    });
  }
  res.status(201).json({ link, inviteeHasAccount: !!caregiver });
});

/** PATCH /caregivers/:id - the patient adjusts which alerts this caregiver receives. */
caregiversRouter.patch('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const body = z
    .object({ notifyMissedDoses: z.boolean().optional(), notifyLowStock: z.boolean().optional(), notifyDeviceIssues: z.boolean().optional(), notifyVitals: z.boolean().optional() })
    .parse(req.body);
  const result = await prisma.caregiverLink.updateMany({ where: { id, patientId: currentUser(req).id }, data: body });
  if (result.count === 0) throw ApiError.notFound('Caregiver link');
  res.json({ link: await prisma.caregiverLink.findUnique({ where: { id }, include: { caregiver: { select: personSelect } } }) });
});

/** POST /caregivers/:id/accept - the invited caregiver accepts. */
caregiversRouter.post('/:id/accept', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const me = currentUser(req);
  const link = await prisma.caregiverLink.findUnique({ where: { id } });
  if (!link || (link.caregiverId !== me.id && link.inviteEmail !== me.email)) throw ApiError.notFound('Invite');
  if (link.status === 'REVOKED') throw ApiError.conflict('This invite was revoked');

  const updated = await prisma.caregiverLink.update({
    where: { id },
    data: { caregiverId: me.id, status: 'ACCEPTED', acceptedAt: new Date() },
    include: { patient: { select: personSelect } },
  });
  await notify(link.patientId, {
    type: 'SYSTEM',
    title: `${me.firstName} is now your caregiver`,
    body: `${me.firstName} accepted your invite and will receive your PillPal alerts.`,
    data: { linkId: id },
  });
  res.json({ link: updated });
});

/** DELETE /caregivers/:id - either side can end the relationship. */
caregiversRouter.delete('/:id', async (req, res) => {
  const { id } = idParam.parse(req.params);
  const me = currentUser(req);
  const link = await prisma.caregiverLink.findUnique({ where: { id } });
  if (!link || (link.patientId !== me.id && link.caregiverId !== me.id && link.inviteEmail !== me.email)) throw ApiError.notFound('Caregiver link');
  await prisma.caregiverLink.update({ where: { id }, data: { status: 'REVOKED' } });
  res.status(204).end();
});

/** GET /caregivers/patients/:patientId/overview - what a caregiver sees about a patient. */
caregiversRouter.get('/patients/:patientId/overview', async (req, res) => {
  const patientId = z.uuid().parse(req.params.patientId);
  const me = currentUser(req);
  const link = await prisma.caregiverLink.findFirst({ where: { patientId, caregiverId: me.id, status: 'ACCEPTED' } });
  if (!link) throw ApiError.forbidden('You are not an accepted caregiver for this patient');

  const patient = await prisma.user.findUniqueOrThrow({ where: { id: patientId }, select: { ...personSelect, timezone: true } });
  const now = new Date();
  const dayStart = startOfLocalDay(now, patient.timezone);
  const [todayDoses, devices, adherence, recentVitals, recentMissed] = await Promise.all([
    prisma.doseEvent.findMany({
      where: { userId: patientId, scheduledAt: { gte: dayStart, lt: new Date(dayStart.getTime() + 24 * 3_600_000) } },
      include: { medication: { select: { name: true, strength: true } } },
      orderBy: { scheduledAt: 'asc' },
    }),
    prisma.device.findMany({ where: { ownerId: patientId }, select: { id: true, name: true, status: true, lastSeenAt: true } }),
    adherenceSummary(patientId, new Date(now.getTime() - 7 * 24 * 3_600_000), now, patient.timezone),
    prisma.vitalReading.findMany({ where: { userId: patientId }, orderBy: { recordedAt: 'desc' }, take: 5 }),
    prisma.doseEvent.findMany({ where: { userId: patientId, status: 'MISSED' }, include: { medication: { select: { name: true } } }, orderBy: { scheduledAt: 'desc' }, take: 5 }),
  ]);
  res.json({ patient, todayDoses, devices, adherenceLast7Days: adherence, recentVitals, recentMissed });
});
