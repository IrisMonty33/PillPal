/**
 * Timezone helpers built on the Intl API (no extra dependencies).
 *
 * Schedules store a local time of day ("08:00") plus the user's IANA timezone.
 * The scheduler turns those into concrete UTC instants with `zonedTimeToUtc`,
 * which correctly handles daylight-saving changes.
 */

export interface LocalParts {
  year: number;
  month: number; // 1-12
  day: number; // 1-31
  hour: number; // 0-23
  minute: number;
  second: number;
  weekday: number; // 0 = Sunday ... 6 = Saturday
}

const WEEKDAYS: Record<string, number> = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

const formatterCache = new Map<string, Intl.DateTimeFormat>();

function formatter(timeZone: string): Intl.DateTimeFormat {
  let f = formatterCache.get(timeZone);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', {
      timeZone,
      hourCycle: 'h23',
      weekday: 'short',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    formatterCache.set(timeZone, f);
  }
  return f;
}

export function isValidTimeZone(timeZone: string): boolean {
  try {
    formatter(timeZone);
    return true;
  } catch {
    return false;
  }
}

/** Break a UTC instant into wall-clock parts in the given timezone. */
export function getLocalParts(date: Date, timeZone: string): LocalParts {
  const parts = formatter(timeZone).formatToParts(date);
  const get = (type: string) => parts.find((p) => p.type === type)?.value ?? '';
  return {
    year: Number(get('year')),
    month: Number(get('month')),
    day: Number(get('day')),
    hour: Number(get('hour')) % 24,
    minute: Number(get('minute')),
    second: Number(get('second')),
    weekday: WEEKDAYS[get('weekday')] ?? 0,
  };
}

/** Offset of `timeZone` from UTC at the given instant, in minutes (New York in winter = -300). */
export function tzOffsetMinutes(date: Date, timeZone: string): number {
  const p = getLocalParts(date, timeZone);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - date.getTime()) / 60_000);
}

/** Convert a wall-clock time in `timeZone` to the UTC instant it represents. */
export function zonedTimeToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
  timeZone: string,
): Date {
  const guess = Date.UTC(year, month - 1, day, hour, minute, 0);
  const offset1 = tzOffsetMinutes(new Date(guess), timeZone);
  let utc = guess - offset1 * 60_000;
  // Re-check in case the first guess landed on the other side of a DST switch.
  const offset2 = tzOffsetMinutes(new Date(utc), timeZone);
  if (offset2 !== offset1) utc = guess - offset2 * 60_000;
  return new Date(utc);
}

/** "YYYY-MM-DD" of the instant in the given timezone. */
export function localDateString(date: Date, timeZone: string): string {
  const p = getLocalParts(date, timeZone);
  return `${p.year}-${String(p.month).padStart(2, '0')}-${String(p.day).padStart(2, '0')}`;
}

/** "HH:MM" of the instant in the given timezone. */
export function localTimeString(date: Date, timeZone: string): string {
  const p = getLocalParts(date, timeZone);
  return `${String(p.hour).padStart(2, '0')}:${String(p.minute).padStart(2, '0')}`;
}

export function parseDateString(ymd: string): { year: number; month: number; day: number } {
  const [y, m, d] = ymd.split('-').map(Number);
  return { year: y, month: m, day: d };
}

/** Add days to a "YYYY-MM-DD" string (calendar arithmetic, timezone-free). */
export function addDaysToDateString(ymd: string, days: number): string {
  const { year, month, day } = parseDateString(ymd);
  const t = Date.UTC(year, month - 1, day + days);
  const d = new Date(t);
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

/** Weekday (0 = Sunday) of a "YYYY-MM-DD" calendar date. */
export function weekdayOfDateString(ymd: string): number {
  const { year, month, day } = parseDateString(ymd);
  return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export const TIME_OF_DAY_REGEX = /^([01]\d|2[0-3]):[0-5]\d$/;

export function parseTimeOfDay(hhmm: string): { hour: number; minute: number } {
  const [h, m] = hhmm.split(':').map(Number);
  return { hour: h, minute: m };
}

function toMinutes(hhmm: string): number {
  const { hour, minute } = parseTimeOfDay(hhmm);
  return hour * 60 + minute;
}

/**
 * True when `nowHHMM` falls inside the quiet-hours window. Windows may wrap past
 * midnight, e.g. start "22:00", end "07:00".
 */
export function isWithinQuietHours(nowHHMM: string, start?: string | null, end?: string | null): boolean {
  if (!start || !end) return false;
  const now = toMinutes(nowHHMM);
  const s = toMinutes(start);
  const e = toMinutes(end);
  if (s === e) return false;
  return s < e ? now >= s && now < e : now >= s || now < e;
}

export function addMinutes(date: Date, minutes: number): Date {
  return new Date(date.getTime() + minutes * 60_000);
}

export function minutesBetween(a: Date, b: Date): number {
  return (b.getTime() - a.getTime()) / 60_000;
}

/** Start of the local day (as a UTC instant) for the given instant and timezone. */
export function startOfLocalDay(date: Date, timeZone: string): Date {
  const p = getLocalParts(date, timeZone);
  return zonedTimeToUtc(p.year, p.month, p.day, 0, 0, timeZone);
}
