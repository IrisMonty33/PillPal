import React from 'react';
import { Text, View } from 'react-native';
import { formatDays, formatTimeOfDay } from '../model';
import { useApp } from '../store';
import { styles } from '../theme';
import { Card, Empty, Label, P, Title } from '../ui';

export function ScheduleScreen() {
  const { data } = useApp();
  const rows = data.meds
    .flatMap((m) => m.schedules.map((s) => ({ m, s })))
    .sort((a, b) => a.s.timeOfDay.localeCompare(b.s.timeOfDay));

  return (
    <>
      <Title>Daily schedule</Title>
      <P>Every planned dose, in order. Times follow your account timezone.</P>
      {rows.length ? (
        rows.map(({ m, s }) => (
          <Card key={s.id}>
            <View style={styles.row}>
              <Text style={styles.scheduleTime}>{formatTimeOfDay(s.timeOfDay)}</Text>
              <View style={{ flex: 1 }}>
                <Label>{m.name}</Label>
                <P>
                  {m.dose}
                  {s.quantity > 1 ? ` · take ${s.quantity}` : ''}
                  {s.daysOfWeek.length ? ` · ${formatDays(s.daysOfWeek)}` : ''}
                </P>
                {m.slotIndex ? <Text style={styles.date}>Slot {m.slotIndex}</Text> : <Text style={styles.date}>Not in the dispenser</Text>}
              </View>
            </View>
          </Card>
        ))
      ) : (
        <Empty>No doses scheduled. Add times under Medications.</Empty>
      )}
    </>
  );
}
