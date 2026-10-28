import type { NextFunction, Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import type { Device, User } from '../generated/prisma/client';
import { ApiError } from '../lib/errors';
import { verifyAccessToken } from '../lib/jwt';
import { sha256 } from '../lib/crypto';
import { config } from '../config';

export type AuthUser = Pick<User, 'id' | 'email' | 'firstName' | 'lastName' | 'timezone'>;

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by `requireUser` (app requests). */
      user?: AuthUser;
      /** Set by `requireDevice` (Raspberry Pi requests). */
      device?: Device;
    }
  }
}

function bearerToken(req: Request): string | undefined {
  const header = req.headers.authorization;
  if (!header) return undefined;
  const [scheme, token] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token) return undefined;
  return token.trim();
}

/** Requires a valid user JWT in `Authorization: Bearer <token>`. */
export async function requireUser(req: Request, _res: Response, next: NextFunction) {
  const token = bearerToken(req);
  if (!token) throw ApiError.unauthorized('Missing Authorization: Bearer <accessToken> header');

  const payload = verifyAccessToken(token);
  if (!payload) throw ApiError.unauthorized('Invalid or expired access token');

  const user = await prisma.user.findUnique({
    where: { id: payload.sub },
    select: { id: true, email: true, firstName: true, lastName: true, timezone: true },
  });
  if (!user) throw ApiError.unauthorized('User no longer exists');

  req.user = user;
  next();
}

/**
 * Requires a device API key, sent either as `X-Device-Key: pp_dev_...`
 * or `Authorization: Bearer pp_dev_...`.
 */
export async function requireDevice(req: Request, _res: Response, next: NextFunction) {
  const headerKey = req.headers['x-device-key'];
  const key = (typeof headerKey === 'string' && headerKey.trim()) || bearerToken(req);
  if (!key) throw ApiError.unauthorized('Missing X-Device-Key header');

  const device = await prisma.device.findUnique({ where: { apiKeyHash: sha256(key) } });
  if (!device) throw ApiError.unauthorized('Unknown device API key');

  req.device = device;
  next();
}

/** Requires the shared provisioning key (`X-Provisioning-Key`) used when a Pi registers itself. */
export function requireProvisioningKey(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers['x-provisioning-key'];
  if (key !== config.DEVICE_PROVISIONING_KEY) throw ApiError.unauthorized('Invalid provisioning key');
  next();
}

/** Requires the admin key (`X-Admin-Key`) for maintenance endpoints. */
export function requireAdmin(req: Request, _res: Response, next: NextFunction) {
  const key = req.headers['x-admin-key'];
  if (key !== config.ADMIN_API_KEY) throw ApiError.unauthorized('Invalid admin key');
  next();
}

/** Helper for handlers: the authenticated user (throws if middleware was not applied). */
export function currentUser(req: Request): AuthUser {
  if (!req.user) throw ApiError.unauthorized();
  return req.user;
}

export function currentDevice(req: Request): Device {
  if (!req.device) throw ApiError.unauthorized();
  return req.device;
}
