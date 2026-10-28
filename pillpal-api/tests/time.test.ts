import { describe, expect, it } from 'vitest';
import { isWithinQuietHours, localDateString, tzOffsetMinutes, zonedTimeToUtc } from '../src/lib/time';
import { occurrencesForSchedule } from '../src/services/doseEngine';
import type { Schedule } from '../src/generated/prisma/client';
import { evaluateVital } from '../src/services/vitals';

describe('timezone helpers', () => {
  it('converts New York wall-clock time to UTC across daylight saving', () => {
    // EST (UTC-5) in January, EDT (UTC-4) in July
    expect(zonedTimeToUtc(2026, 1, 15, 8, 0, 'America/New_York').toISOString()).toBe('2026-01-15T13:00:00.000Z');
    expect(zonedTimeToUtc(2026, 7, 15, 8, 0, 'America/New_York').toISOString()).toBe('2026-07-15T12:00:00.000Z');
    expect(tzOffsetMinutes(new Date('2026-01-15T12:00:00Z'), 'America/New_York')).toBe(-300);
    expect(tzOffsetMinutes(new Date('2026-07-15T12:00:00Z'), 'America/New_York')).toBe(-240);
  });

  it('handles the DST switch day', () => {
    // DST starts 2026-03-08 in the US. 08:00 local that day is already EDT.
    expect(zonedTimeToUtc(2026, 3, 8, 8, 0, 'America/New_York').toISOString()).toBe('2026-03-08T12:00:00.000Z');
    expect(zonedTimeToUtc(2026, 3, 7, 8, 0, 'America/New_York').toISOString()).toBe('2026-03-07T13:00:00.000Z');
  });

  it('formats local dates', () => {
    expect(localDateString(new Date('2026-10-03T02:30:00Z'), 'America/New_York')).toBe('2026-10-02');
    expect(localDateString(new Date('2026-10-03T02:30:00Z'), 'UTC')).toBe('2026-10-03');
  });

  it('detects quiet hours including overnight windows', () => {
    expect(isWithinQuietHours('23:00', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('03:00', '22:00', '07:00')).toBe(true);
    expect(isWithinQuietHours('12:00', '22:00', '07:00')).toBe(false);
    expect(isWithinQuietHours('13:00', '12:00', '14:00')).toBe(true);
    expect(isWithinQuietHours('13:00', null, null)).toBe(false);
  });
});

describe('occurrencesForSchedule', () => {
  const base: Schedule = {
    id: 's1',
    userId: 'u1',
    medicationId: 'm1',
    label: null,
    timeOfDay: '08:00',
    daysOfWeek: [],
    quantity: 1,
    graceMinutes: 60,
    startDate: null,
    endDate: null,
    isActive: true,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('produces one occurrence per day inside the window', () => {
    const from = new Date('2026-10-01T00:00:00Z');
    const to = new Date('2026-10-03T23:59:59Z');
    const result = occurrencesForSchedule(base, 'America/New_York', from, to).map((d) => d.toISOString());
    expect(result).toEqual(['2026-10-01T12:00:00.000Z', '2026-10-02T12:00:00.000Z', '2026-10-03T12:00:00.000Z']);
  });

  it('respects daysOfWeek, startDate and endDate', () => {
    const from = new Date('2026-10-01T00:00:00Z'); // Thursday
    const to = new Date('2026-10-10T23:59:59Z');
    const mwf = occurrencesForSchedule({ ...base, daysOfWeek: [1, 3, 5] }, 'America/New_York', from, to);
    expect(mwf.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-02', '2026-10-05', '2026-10-07', '2026-10-09']);

    const bounded = occurrencesForSchedule(
      { ...base, startDate: new Date('2026-10-03T00:00:00Z'), endDate: new Date('2026-10-05T00:00:00Z') },
      'America/New_York',
      from,
      to,
    );
    expect(bounded.map((d) => d.toISOString().slice(0, 10))).toEqual(['2026-10-03', '2026-10-04', '2026-10-05']);
  });
});

describe('evaluateVital', () => {
  it('flags dangerous readings and accepts normal ones', () => {
    expect(evaluateVital({ type: 'BLOOD_PRESSURE', systolic: 120, diastolic: 80, pulse: 70 })).toBeNull();
    expect(evaluateVital({ type: 'BLOOD_PRESSURE', systolic: 185, diastolic: 95 })).toMatch(/dangerously high/);
    expect(evaluateVital({ type: 'SPO2', value: 85 })).toMatch(/low/);
    expect(evaluateVital({ type: 'TEMPERATURE', value: 103.5, unit: 'F' })).toMatch(/fever/);
    expect(evaluateVital({ type: 'GLUCOSE', value: 110 })).toBeNull();
  });
});
