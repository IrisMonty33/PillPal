import 'dotenv/config';
import { z } from 'zod';

/**
 * All environment variables the API uses, validated once at startup.
 * Copy `.env.example` to `.env` and adjust. Every value has a development default
 * so `npm run dev` works right after `docker compose up -d`.
 */
const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().positive().default(4000),
  HOST: z.string().default('0.0.0.0'),

  DATABASE_URL: z.string().default('postgresql://pillpal:pillpal@localhost:5432/pillpal'),

  /** Secret used to sign user JWTs. MUST be changed in production. */
  JWT_SECRET: z.string().min(8).default('change-me-in-production-please'),
  /** Lifetime of access tokens, e.g. "1h", "1d". */
  JWT_ACCESS_TTL: z.string().default('1d'),
  /** Lifetime of refresh tokens in days. */
  REFRESH_TOKEN_DAYS: z.coerce.number().int().positive().default(30),

  /** Shared secret the Raspberry Pi presents when it registers itself for the first time. */
  DEVICE_PROVISIONING_KEY: z.string().min(4).default('pillpal-provisioning-dev'),
  /** Key for maintenance endpoints under /api/v1/system. */
  ADMIN_API_KEY: z.string().min(4).default('pillpal-admin-dev'),

  /** Comma-separated list of allowed CORS origins, or "*" (default) for development. */
  CORS_ORIGINS: z.string().default('*'),

  /** Set to "false" to stop the background scheduler (tests do this). */
  SCHEDULER_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),
  /** How often the scheduler job runs, in seconds. */
  SCHEDULER_INTERVAL_SECONDS: z.coerce.number().int().positive().default(60),
  /** A device is marked OFFLINE when it has not synced for this many minutes. */
  DEVICE_OFFLINE_AFTER_MINUTES: z.coerce.number().int().positive().default(5),
  /** How far ahead dose events are generated from schedules (hours). */
  DOSE_GENERATION_HORIZON_HOURS: z.coerce.number().int().positive().default(48),
  /** Pending device commands expire after this many minutes if the device never picks them up. */
  COMMAND_TTL_MINUTES: z.coerce.number().int().positive().default(15),
  /** Claim codes shown on the touchscreen are valid for this many minutes. */
  CLAIM_CODE_TTL_MINUTES: z.coerce.number().int().positive().default(30),

  /** Optional Expo access token for push notifications (not required for development). */
  EXPO_ACCESS_TOKEN: z.string().optional(),
  /** Set to "false" to disable push sending entirely (in-app notifications still work). */
  PUSH_ENABLED: z
    .string()
    .default('true')
    .transform((v) => v !== 'false' && v !== '0'),

  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
});

const parsed = envSchema.safeParse(process.env);
if (!parsed.success) {
  console.error('Invalid environment configuration:');
  console.error(parsed.error.issues.map((i) => `  ${i.path.join('.')}: ${i.message}`).join('\n'));
  process.exit(1);
}

export const config = parsed.data;
export type Config = typeof config;

export const isProduction = config.NODE_ENV === 'production';
export const isTest = config.NODE_ENV === 'test';
