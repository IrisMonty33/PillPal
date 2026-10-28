import { PrismaPg } from '@prisma/adapter-pg';
import { PrismaClient } from '../generated/prisma/client';
import { config, isProduction } from '../config';

/**
 * Single shared Prisma client for the whole process.
 * Prisma 7 talks to PostgreSQL through the `pg` driver adapter.
 */
const adapter = new PrismaPg({ connectionString: config.DATABASE_URL });

export const prisma = new PrismaClient({
  adapter,
  log: isProduction ? ['error'] : ['warn', 'error'],
});

export type { Prisma } from '../generated/prisma/client';
export * from '../generated/prisma/enums';
