import React, { useState } from 'react';
import { Alert, Text, View } from 'react-native';
import { formatDateTime } from '../model';
import { describeError, useApp } from '../store';
import { styles } from '../theme';
import { Button, Card, Empty, Input, Label, P, Section, Title } from '../ui';

export function ReportsScreen() {
  const { data, addVital } = useApp();
  const [systolic, setSystolic] = useState('');
  const [diastolic, setDiastolic] = useState('');
  const [pulse, setPulse] = useState('');
  const [showForm, setShowForm] = useState(false);

  const save = async () => {
    const s = Number(systolic);
    const d = Number(diastolic);
    if (!s || !d) {
      Alert.alert('Missing values', 'Enter both the top (systolic) and bottom (diastolic) numbers.');
      return;
    }
    try {
      await addVital({ type: 'BLOOD_PRESSURE', systolic: s, diastolic: d, pulse: pulse ? Number(pulse) : undefined });
      setSystolic('');
      setDiastolic('');
      setPulse('');
      setShowForm(false);
    } catch (err) {
      Alert.alert('Could not save', describeError(err));
    }
  };

  return (
    <>
      <Title>Vitals reports</Title>
      <P>Measurements recorded by the station, newest first.</P>

      {showForm ? (
        <Card>
          <Label>Log blood pressure</Label>
          <View style={[styles.row, { marginTop: 12 }]}>
            <Input small placeholder="120" keyboardType="number-pad" value={systolic} onChangeText={setSystolic} />
            <Text style={styles.label}>/</Text>
            <Input small placeholder="80" keyboardType="number-pad" value={diastolic} onChangeText={setDiastolic} />
            <Input small placeholder="pulse" keyboardType="number-pad" value={pulse} onChangeText={setPulse} />
          </View>
          <View style={[styles.row, { marginTop: 14 }]}>
            <Button title="Save" variant="small" onPress={save} />
            <Button title="Cancel" variant="ghost" onPress={() => setShowForm(false)} />
          </View>
        </Card>
      ) : (
        <View style={{ marginTop: 10, marginBottom: 6, alignSelf: 'flex-start' }}>
          <Button title="+ Log a reading" variant="ghost" onPress={() => setShowForm(true)} />
        </View>
      )}

      <Section>History</Section>
      {data.vitals.length ? (
        data.vitals.map((v) => (
          <Card key={v.id} style={v.flagged ? styles.cardFlagged : undefined}>
            <Text style={styles.date}>{formatDateTime(v.recorded_at)}</Text>
            {v.flagged && <Text style={[styles.badge, styles.alert, { marginTop: 6 }]}>OUT OF RANGE</Text>}
            <View style={styles.vitalGrid}>
              <Text style={styles.metric}>
                ♥  {v.heart_rate ?? '—'} <Text style={styles.unit}>bpm</Text>
              </Text>
              <Text style={styles.metric}>
                O₂  {v.spo2 ?? '—'} <Text style={styles.unit}>%</Text>
              </Text>
              <Text style={styles.metric}>
                ☼  {v.temperature_c ?? '—'} <Text style={styles.unit}>°C</Text>
              </Text>
              <Text style={styles.metric}>
                BP  {v.systolic ?? '—'}/{v.diastolic ?? '—'}
              </Text>
            </View>
          </Card>
        ))
      ) : (
        <Empty>No measurements yet. Readings from your station will appear here.</Empty>
      )}
    </>
  );
}
