import jwt, { type SignOptions } from 'jsonwebtoken';
import { config } from '../config';

export interface AccessTokenPayload {
  sub: string; // user id
  type: 'user';
}

export function signAccessToken(userId: string): string {
  const payload: AccessTokenPayload = { sub: userId, type: 'user' };
  const options: SignOptions = { expiresIn: config.JWT_ACCESS_TTL as SignOptions['expiresIn'] };
  return jwt.sign(payload, config.JWT_SECRET, options);
}

export function verifyAccessToken(token: string): AccessTokenPayload | null {
  try {
    const decoded = jwt.verify(token, config.JWT_SECRET);
    if (typeof decoded !== 'object' || decoded === null) return null;
    if ((decoded as AccessTokenPayload).type !== 'user' || typeof decoded.sub !== 'string') return null;
    return { sub: decoded.sub, type: 'user' };
  } catch {
    return null;
  }
}
