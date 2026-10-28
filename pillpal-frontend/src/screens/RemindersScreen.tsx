import React from 'react';
import { Alert, Text, View } from 'react-native';
import { formatDateTime, type Event } from '../model';
import { describeError, useApp } from '../store';
import { styles } from '../theme';
import { Button, Card, Empty, P, Section, Title } from '../ui';

const BADGE_STYLE: Record<Event['kind'], object | undefined> = {
  taken: undefined,
  dispensed: undefined,
  scheduled: styles.pending,
  missed: styles.alert,
  failed: styles.alert,
  skipped: styles.pending,
};

export function RemindersScreen() {
  const { data, markTaken, skipDose } = useApp();

  const act = async (fn: () => Promise<void>) => {
    try {
      await fn();
    } catch (err) {
      Alert.alert('Could not update dose', describeError(err));
    }
  };

  const EventCard = ({ e, showActions }: { e: Event; showActions: boolean }) => (
    <Card>
      <Text style={[styles.badge, BADGE_STYLE[e.kind]]}>{e.kind.toUpperCase()}</Text>
      <Text style={styles.label}>{e.message}</Text>
      <Text style={styles.date}>{formatDateTime(e.occurred_at)}</Text>
      {showActions && e.actionable && (
        <View style={[styles.row, { marginTop: 12 }]}>
          <Button title="I took it" variant="small" onPress={() => act(() => markTaken(e.id))} />
          <Button title="Skip" variant="ghost" onPress={() => act(() => skipDose(e.id))} />
        </View>
      )}
    </Card>
  );

  const pendingToday = data.today.filter((e) => e.actionable);
  const doneToday = data.today.filter((e) => !e.actionable);
  const todayIds = new Set(data.today.map((e) => e.id));
  const history = data.events.filter((e) => !todayIds.has(e.id));

  return (
    <>
      <Title>Reminders</Title>
      <P>Today's doses, then dose activity from your station, newest first.</P>

      <Section>Today</Section>
      {data.today.length === 0 && <Empty>No doses scheduled for today.</Empty>}
      {pendingToday.map((e) => (
        <EventCard key={e.id} e={e} showActions />
      ))}
      {doneToday.map((e) => (
        <EventCard key={e.id} e={e} showActions={false} />
      ))}

      <Section>Earlier</Section>
      {history.length ? history.map((e) => <EventCard key={e.id} e={e} showActions={e.kind === 'missed' || e.kind === 'failed'} />) : <Empty>No dose activity yet.</Empty>}
    </>
  );
}
