// Prisma 7 configuration. Prisma no longer reads .env on its own, so we load it here.
import 'dotenv/config';
import { defineConfig } from 'prisma/config';

export default defineConfig({
  schema: 'prisma/schema.prisma',
  migrations: {
    path: 'prisma/migrations',
    seed: 'tsx prisma/seed.ts',
  },
  datasource: {
    // Falls back to the docker-compose database so `npm run db:migrate` works out of the box.
    url: process.env.DATABASE_URL ?? 'postgresql://pillpal:pillpal@localhost:5432/pillpal',
  },
});
