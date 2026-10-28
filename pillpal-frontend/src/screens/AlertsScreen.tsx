import React from 'react';
import { Text, View } from 'react-native';
import { formatDateTime } from '../model';
import { useApp } from '../store';
import { styles } from '../theme';
import type { NotificationType } from '../types';
import { Button, Card, Empty, P, Title } from '../ui';

const URGENT: NotificationType[] = ['DOSE_MISSED', 'DEVICE_ERROR', 'VITALS_ALERT', 'DEVICE_OFFLINE'];

/** The notification inbox (bell icon). Push notifications land here too, so nothing is lost. */
export function AlertsScreen() {
  const { data, markAllRead } = useApp();
  return (
    <>
      <Title>Alerts</Title>
      <View style={styles.rowBetween}>
        <P>{data.unreadCount ? `${data.unreadCount} unread` : 'You are all caught up.'}</P>
        {data.unreadCount > 0 && <Button title="Mark all read" variant="ghost" onPress={markAllRead} />}
      </View>
      {data.notifications.length ? (
        data.notifications.map((n) => (
          <Card key={n.id} style={n.readAt ? { opacity: 0.7 } : undefined}>
            <Text style={[styles.badge, URGENT.includes(n.type) && styles.alert]}>{n.type.replace(/_/g, ' ')}</Text>
            <Text style={styles.label}>{n.title}</Text>
            <P>{n.body}</P>
            <Text style={styles.date}>{formatDateTime(n.createdAt)}</Text>
          </Card>
        ))
      ) : (
        <Empty>No alerts yet.</Empty>
      )}
    </>
  );
}
