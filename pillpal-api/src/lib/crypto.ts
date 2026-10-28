import { createHash, randomBytes, randomInt } from 'node:crypto';
import bcrypt from 'bcryptjs';

export async function hashPassword(plain: string): Promise<string> {
  return bcrypt.hash(plain, 10);
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  return bcrypt.compare(plain, hash);
}

/** SHA-256 hex digest; used for refresh tokens and device API keys (never stored in plain text). */
export function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

/** Random opaque token for refresh tokens. */
export function randomToken(bytes = 32): string {
  return randomBytes(bytes).toString('hex');
}

/** Device API keys look like "pp_dev_<48 hex chars>" so they are easy to recognise in logs/configs. */
export function generateDeviceApiKey(): string {
  return `pp_dev_${randomBytes(24).toString('hex')}`;
}

// No 0/O or 1/I so the code is easy to read off the touchscreen.
const CLAIM_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

/** 6-character claim code shown on the Pi's screen, e.g. "K7PX3Q". */
export function generateClaimCode(length = 6): string {
  let code = '';
  for (let i = 0; i < length; i++) code += CLAIM_ALPHABET[randomInt(CLAIM_ALPHABET.length)];
  return code;
}
