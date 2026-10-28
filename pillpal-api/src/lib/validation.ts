import { z } from 'zod';
import { isValidTimeZone, TIME_OF_DAY_REGEX } from './time';

/** Shared zod schemas. Routes call `schema.parse(req.body)`; ZodErrors become 400 responses. */

export const idParam = z.object({ id: z.uuid() });

export const timezoneSchema = z
  .string()
  .min(1)
  .refine(isValidTimeZone, { message: 'Must be a valid IANA timezone such as "America/New_York"' });

export const timeOfDaySchema = z.string().regex(TIME_OF_DAY_REGEX, 'Must be "HH:MM" in 24-hour format');

/** "YYYY-MM-DD" -> Date at UTC midnight (calendar dates are stored timezone-free). */
export const dateOnlySchema = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'Must be "YYYY-MM-DD"')
  .transform((s) => new Date(`${s}T00:00:00.000Z`));

/** ISO timestamp -> Date. Accepts anything `new Date()` understands. */
export const isoDateSchema = z
  .string()
  .refine((s) => !Number.isNaN(Date.parse(s)), 'Must be an ISO-8601 date-time')
  .transform((s) => new Date(s));

export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const dateRangeSchema = z.object({
  from: isoDateSchema.optional(),
  to: isoDateSchema.optional(),
});

export const slotIndexSchema = z.coerce.number().int().min(1).max(5);

/** Free-form JSON object (stored in Prisma `Json` columns). */
export const jsonObjectSchema = z.record(z.string(), z.any());
export type JsonObject = z.infer<typeof jsonObjectSchema>;
