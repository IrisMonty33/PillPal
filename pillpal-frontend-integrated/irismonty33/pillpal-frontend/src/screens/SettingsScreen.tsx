import React, { useEffect, useState } from 'react';
import { Alert, Switch, Text, TouchableOpacity, View } from 'react-native';
import { API_URL } from '../config';
import { formatClock, formatDateTime } from '../model';
import { registerForPush } from '../push';
import { describeError, useApp } from '../store';
import { coral, styles } from '../theme';
import type { ApiDevice, ApiSlot, NotificationSettings, PatientOverview } from '../types';
import { Button, Card, Chip, Empty, Input, Label, P, Section, Stat, Title } from '../ui';

// ---------------------------------------------------------------- dispenser
function SlotRow({ device, slot }: { device: ApiDevice; slot: ApiSlot }) {
  const { data, setSlot, refillSlot, dispenseNow } = useApp();
  const [editing, setEditing] = useState(false);
  const [count, setCount] = useState('');
  const low = slot.medication && slot.pillCount <= slot.medication.refillThreshold;

  const wrap = (fn: () => Promise<void>) => fn().catch((err) => Alert.alert('Dispenser', describeError(err)));

  return (
    <View style={{ marginTop: 14, paddingTop: 12, borderTopWidth: 1, borderColor: '#E7E9E8' }}>
      <View style={styles.rowBetween}>
        <Label>Slot {slot.index}</Label>
        {slot.medication ? (
          <Text style={[styles.date, { marginTop: 0 }, low && styles.alert]}>
            {slot.pillCount} pill{slot.pillCount === 1 ? '' : 's'}
            {low ? ' · refill soon' : ''}
          </Text>
        ) : (
          <Text style={[styles.date, { marginTop: 0 }]}>empty</Text>
        )}
      </View>
      <P>{slot.medication ? `${slot.medication.name}${slot.medication.strength ? ` ${slot.medication.strength}` : ''}` : 'Tap a medication to load it here.'}</P>

      {editing ? (
        <>
          <View style={styles.wrap}>
            {data.meds.map((m) => (
              <Chip
                key={m.id}
                label={m.name}
                active={slot.medication?.id === m.id}
                onPress={() => wrap(async () => { await setSlot(device.id, slot.index, m.id, count ? Number(count) : undefined); setEditing(false); })}
              />
            ))}
            {slot.medication && <Chip label="Empty slot" onPress={() => wrap(async () => { await setSlot(device.id, slot.index, null); setEditing(false); })} />}
          </View>
          <View style={[styles.row, { marginTop: 10 }]}>
            <Input small placeholder="pill count" keyboardType="number-pad" value={count} onChangeText={setCount} />
            {slot.medication && (
              <Button
                title="Set count"
                variant="small"
                onPress={() => wrap(async () => { if (!count) return; await refillSlot(device.id, slot.index, Number(count)); setCount(''); setEditing(false); })}
              />
            )}
            <Button title="Done" variant="ghost" onPress={() => setEditing(false)} />
          </View>
        </>
      ) : (
        <View style={[styles.row, { marginTop: 10 }]}>
          <Button title={slot.medication ? 'Change / refill' : 'Load medication'} variant="ghost" onPress={() => setEditing(true)} />
          {slot.medication && device.isOnline && (
            <Button
              title="Dispense now"
              variant="small"
              onPress={() =>
                wrap(async () => {
                  await dispenseNow(device.id, slot.index);
                  Alert.alert('Sent', `${device.name} will dispense ${slot.medication?.name} within about 30 seconds.`);
                })
              }
            />
          )}
        </View>
      )}
    </View>
  );
}

function DeviceCard({ device }: { device: ApiDevice }) {
  const { unpairDevice, ringDevice } = useApp();
  return (
    <Card>
      <View style={styles.rowBetween}>
        <Label>{device.name}</Label>
        <Text style={[styles.badge, { marginBottom: 0 }, !device.isOnline && styles.alert]}>{device.isOnline ? 'ONLINE' : 'OFFLINE'}</Text>
      </View>
      <Text style={styles.date}>
        {device.lastSeenAt ? `Last seen ${formatDateTime(device.lastSeenAt)}` : 'Never connected'}
        {device.firmwareVersion ? ` · firmware ${device.firmwareVersion}` : ''}
      </Text>
      {device.slots.map((s) => (
        <SlotRow key={s.id} device={device} slot={s} />
      ))}
      <View style={[styles.row, { marginTop: 16 }]}>
        <Button title="Find it (beep)" variant="ghost" onPress={() => ringDevice(device.id).catch((err) => Alert.alert('Dispenser', describeError(err)))} />
        <Button
          title="Unpair"
          variant="ghost"
          onPress={() =>
            Alert.alert('Unpair dispenser?', 'The dispenser will show a new pairing code and its slots will be cleared.', [
              { text: 'Cancel', style: 'cancel' },
              { text: 'Unpair', style: 'destructive', onPress: () => unpairDevice(device.id).catch((err) => Alert.alert('Dispenser', describeError(err))) },
            ])
          }
        />
      </View>
    </Card>
  );
}

function PairDevice() {
  const { claimDevice } = useApp();
  const [code, setCode] = useState('');
  const [name, setName] = useState('');
  return (
    <Card>
      <Label>Pair a dispenser</Label>
      <P>Enter the 6-character code shown on the PillPal touchscreen.</P>
      <Input placeholder="Pairing code (e.g. K7PX3Q)" autoCapitalize="characters" autoCorrect={false} value={code} onChangeText={setCode} />
      <Input placeholder="Name (optional, e.g. Kitchen)" value={name} onChangeText={setName} />
      <Button
        title="Pair"
        onPress={async () => {
          if (code.trim().length < 4) {
            Alert.alert('Enter the code', 'The code is on the dispenser screen.');
            return;
          }
          try {
            await claimDevice(code, name.trim() || undefined);
            setCode('');
            setName('');
            Alert.alert('Paired', 'Your dispenser is linked to this account. Load medications into its slots below.');
          } catch (err) {
            Alert.alert('Pairing failed', describeError(err));
          }
        }}
      />
    </Card>
  );
}

// ---------------------------------------------------------------- notifications
const SETTING_LABELS: { key: keyof NotificationSettings; label: string }[] = [
  { key: 'doseReminders', label: 'Dose reminders' },
  { key: 'missedDoseAlerts', label: 'Missed dose alerts' },
  { key: 'lowStockAlerts', label: 'Low pill count alerts' },
  { key: 'deviceOfflineAlerts', label: 'Dispenser offline alerts' },
  { key: 'vitalsAlerts', label: 'Vitals out-of-range alerts' },
  { key: 'requireTakenConfirmation', label: 'Ask me to confirm each dose was taken' },
];

function NotificationSettingsCard() {
  const { data, updateSettings, preview } = useApp();
  const [pushStatus, setPushStatus] = useState<string>('');
  const s = data.settings;

  useEffect(() => {
    if (preview) return;
    registerForPush().then((token) => setPushStatus(token ? 'Push notifications are on for this phone.' : 'Push is unavailable here (Expo Go or simulator). In-app alerts still work.'));
  }, [preview]);

  return (
    <Card>
      <Label>Notifications</Label>
      {s ? (
        SETTING_LABELS.map(({ key, label }) => (
          <View key={key} style={styles.switchRow}>
            <Text style={[styles.p, { marginTop: 0, flex: 1 }]}>{label}</Text>
            <Switch value={Boolean(s[key])} trackColor={{ true: coral }} onValueChange={(v) => updateSettings({ [key]: v } as Partial<NotificationSettings>).catch((err) => Alert.alert('Settings', describeError(err)))} />
          </View>
        ))
      ) : (
        <P>{preview ? 'Connect to the server to change notification settings.' : 'Loading…'}</P>
      )}
      {pushStatus ? <Text style={styles.date}>{pushStatus}</Text> : null}
    </Card>
  );
}

// ---------------------------------------------------------------- caregivers
function CaregiversCard() {
  const { data, inviteCaregiver, acceptInvite, removeCaregiverLink, patientOverview } = useApp();
  const [email, setEmail] = useState('');
  const [overview, setOverview] = useState<PatientOverview | null>(null);

  const invite = async () => {
    if (!email.includes('@')) {
      Alert.alert('Enter an email', 'Type the caregiver’s email address.');
      return;
    }
    try {
      const msg = await inviteCaregiver(email);
      setEmail('');
      if (msg) Alert.alert('Invite sent', msg);
    } catch (err) {
      Alert.alert('Invite failed', describeError(err));
    }
  };

  return (
    <>
      <Card>
        <Label>My caregivers</Label>
        <P>Caregivers get an alert when you miss a dose, run low on pills, or your dispenser has a problem.</P>
        {data.caregivers.length === 0 && <Empty>No caregivers yet.</Empty>}
        {data.caregivers.map((l) => (
          <View key={l.id} style={[styles.rowBetween, { marginTop: 10 }]}>
            <View style={{ flex: 1 }}>
              <Text style={styles.label}>{l.caregiver ? `${l.caregiver.firstName} ${l.caregiver.lastName ?? ''}`.trim() : l.inviteEmail}</Text>
              <Text style={styles.date}>{l.status === 'ACCEPTED' ? 'Accepted' : 'Invite pending'}</Text>
            </View>
            <TouchableOpacity onPress={() => removeCaregiverLink(l.id).catch((err) => Alert.alert('Caregivers', describeError(err)))}>
              <Text style={styles.linkInline}>Remove</Text>
            </TouchableOpacity>
          </View>
        ))}
        <View style={[styles.row, { marginTop: 12 }]}>
          <Input small placeholder="caregiver@example.com" keyboardType="email-address" autoCapitalize="none" value={email} onChangeText={setEmail} style={{ flex: 1, textAlign: 'left' }} />
          <Button title="Invite" variant="small" onPress={invite} />
        </View>
      </Card>

      {data.patients.length > 0 && (
        <Card>
          <Label>People I care for</Label>
          {data.patients.map((l) => (
            <View key={l.id} style={{ marginTop: 12 }}>
              <View style={styles.rowBetween}>
                <View style={{ flex: 1 }}>
                  <Text style={styles.label}>{l.patient ? `${l.patient.firstName} ${l.patient.lastName ?? ''}`.trim() : 'Patient'}</Text>
                  <Text style={styles.date}>{l.status === 'ACCEPTED' ? 'You receive their alerts' : 'Invited you'}</Text>
                </View>
                {l.status === 'ACCEPTED' ? (
                  <Button title="View" variant="small" onPress={() => patientOverview(l.patientId).then(setOverview).catch((err) => Alert.alert('Overview', describeError(err)))} />
                ) : (
                  <Button title="Accept" variant="small" onPress={() => acceptInvite(l.id).catch((err) => Alert.alert('Caregivers', describeError(err)))} />
                )}
              </View>
              {overview && overview.patient.id === l.patientId && (
                <View style={{ marginTop: 12 }}>
                  <View style={styles.row}>
                    <Stat value={overview.adherenceLast7Days.adherenceRate === null ? '–' : `${Math.round(overview.adherenceLast7Days.adherenceRate)}%`} label="7-day adherence" />
                    <Stat value={overview.adherenceLast7Days.missed} label="missed" />
                    <Stat value={overview.devices.filter((d) => d.status === 'ONLINE').length} label="online" />
                  </View>
                  <Section>Today</Section>
                  {overview.todayDoses.length === 0 && <P>No doses scheduled today.</P>}
                  {overview.todayDoses.map((d) => (
                    <Text key={d.id} style={styles.p}>
                      {formatClock(d.scheduledAt)} · {d.medication.name} · {d.status.toLowerCase()}
                    </Text>
                  ))}
                  {overview.recentMissed.length > 0 && (
                    <>
                      <Section>Recently missed</Section>
                      {overview.recentMissed.map((d) => (
                        <Text key={d.id} style={[styles.p, styles.alert]}>
                          {formatDateTime(d.scheduledAt)} · {d.medication.name}
                        </Text>
                      ))}
                    </>
                  )}
                  <TouchableOpacity onPress={() => setOverview(null)}>
                    <Text style={styles.link}>Close</Text>
                  </TouchableOpacity>
                </View>
              )}
            </View>
          ))}
        </Card>
      )}
    </>
  );
}

// ---------------------------------------------------------------- screen
export function SettingsScreen() {
  const { user, role, preview, data, signOut } = useApp();

  return (
    <>
      <Title>Settings</Title>

      <Card>
        <Label>Account</Label>
        <P>{preview ? 'Preview mode: set EXPO_PUBLIC_API_URL in .env to connect to the PillPal server.' : `${user?.firstName ?? ''} ${user?.lastName ?? ''} · ${user?.email ?? ''}`.trim()}</P>
        <P>Access: {role}</P>
        {!preview && <Text style={styles.date}>Timezone {user?.timezone} · Server {API_URL}</Text>}
        {!preview && (
          <TouchableOpacity onPress={() => signOut()}>
            <Text style={styles.link}>Sign out</Text>
          </TouchableOpacity>
        )}
      </Card>

      <Section>Dispenser</Section>
      {data.devices.map((d) => (
        <DeviceCard key={d.id} device={d} />
      ))}
      <PairDevice />

      <Section>Notifications</Section>
      <NotificationSettingsCard />

      <Section>Caregivers</Section>
      <CaregiversCard />
    </>
  );
}
