import React, { useState } from 'react';
import { Alert, Text, TouchableOpacity, View } from 'react-native';
import { formatDays, formatTimeOfDay, type Medication } from '../model';
import { describeError, useApp } from '../store';
import { styles } from '../theme';
import type { MedicationForm } from '../types';
import { Button, Card, Chip, Empty, Input, Label, P, Section, Title } from '../ui';

const QUICK_TIMES = ['08:00', '12:00', '18:00', '21:00'];
const FORMS: { value: MedicationForm; label: string }[] = [
  { value: 'TABLET', label: 'Tablet' },
  { value: 'CAPSULE', label: 'Capsule' },
  { value: 'SOFTGEL', label: 'Softgel' },
  { value: 'OTHER', label: 'Other' },
];
const TIME_RE = /^([01]?\d|2[0-3]):[0-5]\d$/;

/** Accepts "8:00", "08:00", "18:30" and returns "HH:MM" or null. */
export function normalizeTime(input: string): string | null {
  const t = input.trim();
  if (!TIME_RE.test(t)) return null;
  const [h, m] = t.split(':');
  return `${h.padStart(2, '0')}:${m}`;
}

function TimePicker({ selected, onChange }: { selected: string[]; onChange: (times: string[]) => void }) {
  const [custom, setCustom] = useState('');
  const toggle = (t: string) => onChange(selected.includes(t) ? selected.filter((x) => x !== t) : [...selected, t].sort());
  const addCustom = () => {
    const t = normalizeTime(custom);
    if (!t) {
      Alert.alert('Invalid time', 'Use 24-hour HH:MM, for example 07:30 or 18:00.');
      return;
    }
    if (!selected.includes(t)) onChange([...selected, t].sort());
    setCustom('');
  };
  return (
    <>
      <View style={styles.wrap}>
        {[...new Set([...QUICK_TIMES, ...selected])].sort().map((t) => (
          <Chip key={t} label={formatTimeOfDay(t)} active={selected.includes(t)} onPress={() => toggle(t)} />
        ))}
      </View>
      <View style={[styles.row, { marginTop: 10 }]}>
        <Input small placeholder="HH:MM" value={custom} onChangeText={setCustom} autoCapitalize="none" />
        <Button title="Add time" variant="ghost" onPress={addCustom} />
      </View>
    </>
  );
}

function AddMedicationForm({ onDone }: { onDone: () => void }) {
  const { addMedication } = useApp();
  const [name, setName] = useState('');
  const [strength, setStrength] = useState('');
  const [form, setForm] = useState<MedicationForm>('TABLET');
  const [instructions, setInstructions] = useState('');
  const [times, setTimes] = useState<string[]>(['08:00']);

  const save = async () => {
    if (!name.trim()) {
      Alert.alert('Name required', 'Enter the medication name.');
      return;
    }
    if (times.length === 0) {
      Alert.alert('Pick a time', 'Choose at least one time of day.');
      return;
    }
    try {
      await addMedication({ name: name.trim(), strength: strength.trim() || undefined, form, instructions: instructions.trim() || undefined, times });
      onDone();
    } catch (err) {
      Alert.alert('Could not add medication', describeError(err));
    }
  };

  return (
    <Card>
      <Label>New medication</Label>
      <Input placeholder="Name (e.g. Metformin)" value={name} onChangeText={setName} />
      <Input placeholder="Strength (e.g. 500 mg)" value={strength} onChangeText={setStrength} />
      <View style={styles.wrap}>
        {FORMS.map((f) => (
          <Chip key={f.value} label={f.label} active={form === f.value} onPress={() => setForm(f.value)} />
        ))}
      </View>
      <Input placeholder="Instructions (e.g. take with food)" value={instructions} onChangeText={setInstructions} />
      <Section>Times</Section>
      <TimePicker selected={times} onChange={setTimes} />
      <Button title="Save medication" onPress={save} />
      <TouchableOpacity onPress={onDone}>
        <Text style={styles.link}>Cancel</Text>
      </TouchableOpacity>
    </Card>
  );
}

function MedicationCard({ med }: { med: Medication }) {
  const { addSchedule, removeSchedule, removeMedication, logManualDose } = useApp();
  const [adding, setAdding] = useState(false);
  const [newTime, setNewTime] = useState('');

  const addTime = async () => {
    const t = normalizeTime(newTime);
    if (!t) {
      Alert.alert('Invalid time', 'Use 24-hour HH:MM, for example 07:30 or 18:00.');
      return;
    }
    try {
      await addSchedule(med.id, t);
      setNewTime('');
      setAdding(false);
    } catch (err) {
      Alert.alert('Could not add time', describeError(err));
    }
  };

  const confirmRemove = () =>
    Alert.alert('Remove medication?', `${med.name} will be removed from your schedule. Your history is kept.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Remove', style: 'destructive', onPress: () => removeMedication(med.id).catch((err) => Alert.alert('Could not remove', describeError(err))) },
    ]);

  return (
    <Card>
      <View style={styles.rowBetween}>
        <Label>{med.name}</Label>
        <TouchableOpacity onPress={confirmRemove}>
          <Text style={styles.linkInline}>Remove</Text>
        </TouchableOpacity>
      </View>
      <P>{med.dose}</P>
      {med.instructions ? <Text style={styles.date}>{med.instructions}</Text> : null}
      {med.next_refill ? <Text style={styles.date}>{med.slotIndex ? 'Dispenser: ' : 'Refill: '}{med.next_refill}</Text> : <Text style={styles.date}>Not loaded in the dispenser</Text>}

      <View style={styles.wrap}>
        {med.schedules.map((s) => (
          <Chip
            key={s.id}
            label={`${formatTimeOfDay(s.timeOfDay)}${s.daysOfWeek.length ? ` · ${formatDays(s.daysOfWeek)}` : ''}  ✕`}
            active
            onPress={() =>
              Alert.alert('Remove this time?', `${med.name} at ${formatTimeOfDay(s.timeOfDay)}`, [
                { text: 'Cancel', style: 'cancel' },
                { text: 'Remove', style: 'destructive', onPress: () => removeSchedule(s.id).catch((err) => Alert.alert('Could not remove', describeError(err))) },
              ])
            }
          />
        ))}
        {!adding && <Chip label="+ time" onPress={() => setAdding(true)} />}
      </View>
      {adding && (
        <View style={[styles.row, { marginTop: 10 }]}>
          <Input small placeholder="HH:MM" value={newTime} onChangeText={setNewTime} autoCapitalize="none" autoFocus />
          <Button title="Add" variant="small" onPress={addTime} />
          <Button title="Cancel" variant="ghost" onPress={() => setAdding(false)} />
        </View>
      )}
      <View style={[styles.row, { marginTop: 12 }]}>
        <Button title="Log a dose taken now" variant="ghost" onPress={() => logManualDose(med.id).catch((err) => Alert.alert('Could not log dose', describeError(err)))} />
      </View>
    </Card>
  );
}

export function MedicationsScreen() {
  const { data } = useApp();
  const [showForm, setShowForm] = useState(false);

  return (
    <>
      <Title>Medications</Title>
      <P>Your medications and when to take them. Load them into the dispenser under Settings.</P>
      {showForm ? (
        <AddMedicationForm onDone={() => setShowForm(false)} />
      ) : (
        <View style={{ marginTop: 10, marginBottom: 6, alignSelf: 'flex-start' }}>
          <Button title="+ Add medication" variant="ghost" onPress={() => setShowForm(true)} />
        </View>
      )}
      {data.meds.length ? data.meds.map((m) => <MedicationCard key={m.id} med={m} />) : <Empty>No medications yet. Add one to start your schedule.</Empty>}
    </>
  );
}
