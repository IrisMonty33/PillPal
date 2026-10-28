import { Router } from 'express';
import rateLimit from 'express-rate-limit';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { ApiError } from '../lib/errors';
import { hashPassword, randomToken, sha256, verifyPassword } from '../lib/crypto';
import { signAccessToken } from '../lib/jwt';
import { config, isTest } from '../config';
import { currentUser, requireUser } from '../middleware/auth';
import { timezoneSchema } from '../lib/validation';

export const authRouter = Router();

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: isTest ? 10_000 : 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { code: 'RATE_LIMITED', message: 'Too many attempts, please try again later' } },
});

const userSelect = {
  id: true,
  email: true,
  firstName: true,
  lastName: true,
  phone: true,
  timezone: true,
  createdAt: true,
} as const;

const registerSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(8, 'Password must be at least 8 characters').max(128),
  firstName: z.string().trim().min(1).max(60),
  lastName: z.string().trim().max(60).optional(),
  phone: z.string().trim().max(30).optional(),
  timezone: timezoneSchema.optional(),
});

const loginSchema = z.object({
  email: z.email().transform((e) => e.toLowerCase().trim()),
  password: z.string().min(1),
});

const refreshSchema = z.object({ refreshToken: z.string().min(10) });

const updateMeSchema = z.object({
  firstName: z.string().trim().min(1).max(60).optional(),
  lastName: z.string().trim().max(60).nullable().optional(),
  phone: z.string().trim().max(30).nullable().optional(),
  timezone: timezoneSchema.optional(),
});

const changePasswordSchema = z.object({
  currentPassword: z.string().min(1),
  newPassword: z.string().min(8).max(128),
});

const pushTokenSchema = z.object({
  token: z.string().min(10),
  platform: z.enum(['IOS', 'ANDROID', 'WEB']).default('ANDROID'),
});

async function issueTokens(userId: string) {
  const refreshToken = randomToken();
  await prisma.refreshToken.create({
    data: {
      userId,
      tokenHash: sha256(refreshToken),
      expiresAt: new Date(Date.now() + config.REFRESH_TOKEN_DAYS * 24 * 3_600_000),
    },
  });
  return { accessToken: signAccessToken(userId), refreshToken, tokenType: 'Bearer', expiresIn: config.JWT_ACCESS_TTL };
}

/** POST /auth/register - create an account. Returns the user plus tokens so the app is logged in immediately. */
authRouter.post('/register', authLimiter, async (req, res) => {
  const body = registerSchema.parse(req.body);
  const exists = await prisma.user.findUnique({ where: { email: body.email } });
  if (exists) throw ApiError.conflict('An account with this email already exists');

  const user = await prisma.user.create({
    data: {
      email: body.email,
      passwordHash: await hashPassword(body.password),
      firstName: body.firstName,
      lastName: body.lastName,
      phone: body.phone,
      timezone: body.timezone ?? 'America/New_York',
      settings: { create: {} },
    },
    select: userSelect,
  });

  // If someone invited this email as a caregiver before the account existed, link it now.
  await prisma.caregiverLink.updateMany({ where: { inviteEmail: user.email, caregiverId: null }, data: { caregiverId: user.id } });

  res.status(201).json({ user, ...(await issueTokens(user.id)) });
});

/** POST /auth/login */
authRouter.post('/login', authLimiter, async (req, res) => {
  const body = loginSchema.parse(req.body);
  const user = await prisma.user.findUnique({ where: { email: body.email } });
  if (!user || !(await verifyPassword(body.password, user.passwordHash))) {
    throw ApiError.unauthorized('Invalid email or password');
  }
  const { passwordHash: _ph, updatedAt: _u, ...safeUser } = user;
  res.json({ user: safeUser, ...(await issueTokens(user.id)) });
});

/** POST /auth/refresh - exchange a refresh token for a new access + refresh token pair. */
authRouter.post('/refresh', authLimiter, async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  const stored = await prisma.refreshToken.findUnique({ where: { tokenHash: sha256(refreshToken) } });
  if (!stored || stored.revokedAt || stored.expiresAt < new Date()) {
    throw ApiError.unauthorized('Refresh token is invalid or expired');
  }
  await prisma.refreshToken.update({ where: { id: stored.id }, data: { revokedAt: new Date() } });
  res.json(await issueTokens(stored.userId));
});

/** POST /auth/logout - revoke a refresh token (the app should also forget the access token). */
authRouter.post('/logout', async (req, res) => {
  const { refreshToken } = refreshSchema.parse(req.body);
  await prisma.refreshToken.updateMany({ where: { tokenHash: sha256(refreshToken), revokedAt: null }, data: { revokedAt: new Date() } });
  res.status(204).end();
});

/** GET /auth/me */
authRouter.get('/me', requireUser, async (req, res) => {
  const me = currentUser(req);
  const user = await prisma.user.findUniqueOrThrow({
    where: { id: me.id },
    select: { ...userSelect, settings: true, _count: { select: { devices: true, medications: true } } },
  });
  res.json({ user });
});

/** PATCH /auth/me */
authRouter.patch('/me', requireUser, async (req, res) => {
  const body = updateMeSchema.parse(req.body);
  const user = await prisma.user.update({ where: { id: currentUser(req).id }, data: body, select: userSelect });
  res.json({ user });
});

/** POST /auth/password */
authRouter.post('/password', requireUser, async (req, res) => {
  const body = changePasswordSchema.parse(req.body);
  const user = await prisma.user.findUniqueOrThrow({ where: { id: currentUser(req).id } });
  if (!(await verifyPassword(body.currentPassword, user.passwordHash))) throw ApiError.unauthorized('Current password is incorrect');
  await prisma.user.update({ where: { id: user.id }, data: { passwordHash: await hashPassword(body.newPassword) } });
  await prisma.refreshToken.updateMany({ where: { userId: user.id, revokedAt: null }, data: { revokedAt: new Date() } });
  res.status(204).end();
});

/** POST /auth/push-tokens - register the phone's Expo push token. */
authRouter.post('/push-tokens', requireUser, async (req, res) => {
  const body = pushTokenSchema.parse(req.body);
  const token = await prisma.pushToken.upsert({
    where: { token: body.token },
    create: { token: body.token, platform: body.platform, userId: currentUser(req).id },
    update: { platform: body.platform, userId: currentUser(req).id, lastUsedAt: new Date() },
  });
  res.status(201).json({ pushToken: token });
});

/** DELETE /auth/push-tokens/:token */
authRouter.delete('/push-tokens/:token', requireUser, async (req, res) => {
  const token = z.string().min(1).parse(req.params.token);
  await prisma.pushToken.deleteMany({ where: { token, userId: currentUser(req).id } });
  res.status(204).end();
});

/** DELETE /auth/me - delete the account and everything linked to it. */
authRouter.delete('/me', requireUser, async (req, res) => {
  await prisma.user.delete({ where: { id: currentUser(req).id } });
  res.status(204).end();
});
