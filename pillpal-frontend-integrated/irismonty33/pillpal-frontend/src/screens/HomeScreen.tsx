import React from 'react';
import { Text, TouchableOpacity, View } from 'react-native';
import { formatClock } from '../model';
import { useApp } from '../store';
import { styles } from '../theme';
import { Card, Label, P, Stat, Title } from '../ui';
import type { Page } from '../navigation';

const TILES: { page: Page; icon: string }[] = [
  { page: 'Reports', icon: '▤' },
  { page: 'Reminders', icon: '◉' },
  { page: 'Medications', icon: '✚' },
  { page: 'Schedule', icon: '▦' },
  { page: 'Settings', icon: '⚙' },
  { page: 'Help', icon: '?' },
];

export function HomeScreen({ go }: { go: (page: Page) => void }) {
  const { data, preview } = useApp();
  const { nextDose, adherence, today, devices } = data;

  const nextLabel = nextDose
    ? `${nextDose.medication.name} at ${formatClock(nextDose.scheduledAt)}`
    : preview
      ? 'Metformin at 6:30 PM'
      : data.meds.length
        ? 'No doses scheduled'
        : 'Add a medication to get started';

  const due = today.filter((e) => e.kind === 'scheduled' || e.kind === 'dispensed' || e.kind === 'missed');
  const offline = devices.filter((d) => !d.isOnline);

  return (
    <>
      <Title>Your health, at a glance</Title>
      <Card>
        <Label>Next dose</Label>
        <Text style={styles.big}>{nextLabel}</Text>
        <P>{due.length ? `${due.length} dose${due.length === 1 ? '' : 's'} still to take today` : 'Nothing else due today'}</P>
        {due.length > 0 && (
          <TouchableOpacity onPress={() => go('Reminders')}>
            <Text style={styles.linkInline}>Open reminders ›</Text>
          </TouchableOpacity>
        )}
      </Card>

      {adherence && (
        <Card>
          <Label>Last 7 days</Label>
          <View style={[styles.row, { marginTop: 12 }]}>
            <Stat value={adherence.adherenceRate === null ? '–' : `${Math.round(adherence.adherenceRate)}%`} label="adherence" />
            <Stat value={adherence.taken} label="taken" />
            <Stat value={adherence.missed} label="missed" />
            <Stat value={adherence.currentStreakDays} label="day streak" />
          </View>
        </Card>
      )}

      {offline.length > 0 && (
        <Text style={styles.notice}>{offline.map((d) => d.name).join(', ')} is offline. Check its power and Wi‑Fi.</Text>
      )}
      {data.devices.length === 0 && !preview && (
        <Text style={styles.notice}>No dispenser paired yet. Go to Settings and enter the code shown on your PillPal screen.</Text>
      )}

      <View style={styles.grid}>
        {TILES.map((t) => (
          <TouchableOpacity accessibilityRole="button" key={t.page} style={styles.tile} onPress={() => go(t.page)}>
            <Text style={styles.tileIcon}>{t.icon}</Text>
            <Text style={styles.tileText}>{t.page}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </>
  );
}
