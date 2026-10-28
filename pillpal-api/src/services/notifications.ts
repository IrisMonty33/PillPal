import { Expo, type ExpoPushMessage, type ExpoPushTicket } from 'expo-server-sdk';
import { prisma } from '../lib/prisma';
import type { NotificationType, Prisma } from '../generated/prisma/client';
import { config } from '../config';
import { logger } from '../lib/logger';
import { isWithinQuietHours, localTimeString } from '../lib/time';

/**
 * Automated notifications.
 *
 * Every notification is stored in the `notifications` table (the app's inbox / bell icon).
 * If the user registered an Expo push token it is also sent as a push notification.
 * Email/SMS can be added later by extending `deliver()`.
 */

export interface NotifyInput {
  type: NotificationType;
  title: string;
  body: string;
  data?: Prisma.InputJsonValue;
  /** Reminders respect quiet hours; alerts (missed dose, device error) ignore them. */
  respectQuietHours?: boolean;
}

const expo = new Expo(config.EXPO_ACCESS_TOKEN ? { accessToken: config.EXPO_ACCESS_TOKEN } : {});

/** Which NotificationSettings flag controls each notification type (undefined = always on). */
const SETTING_FOR_TYPE: Partial<
  Record<NotificationType, 'doseReminders' | 'missedDoseAlerts' | 'lowStockAlerts' | 'deviceOfflineAlerts' | 'vitalsAlerts'>
> = {
  DOSE_REMINDER: 'doseReminders',
  DOSE_MISSED: 'missedDoseAlerts',
  LOW_STOCK: 'lowStockAlerts',
  DEVICE_OFFLINE: 'deviceOfflineAlerts',
  DEVICE_ONLINE: 'deviceOfflineAlerts',
  VITALS_ALERT: 'vitalsAlerts',
};

/**
 * Create a notification for one user and push it to their phone(s).
 * Returns the created row, or null when the user disabled this notification type.
 */
export async function notify(userId: string, input: NotifyInput) {
  const user = await prisma.user.findUnique({
    where: { id: userId },
    include: { settings: true, pushTokens: true },
  });
  if (!user) return null;

  const settingKey = SETTING_FOR_TYPE[input.type];
  if (settingKey && user.settings && !user.settings[settingKey]) {
    return null; // user turned this category off
  }

  const notification = await prisma.notification.create({
    data: { userId, type: input.type, title: input.title, body: input.body, data: input.data },
  });

  let sendPush = config.PUSH_ENABLED && user.pushTokens.length > 0;
  if (sendPush && input.respectQuietHours && user.settings) {
    const nowLocal = localTimeString(new Date(), user.timezone);
    if (isWithinQuietHours(nowLocal, user.settings.quietHoursStart, user.settings.quietHoursEnd)) sendPush = false;
  }

  if (sendPush) {
    // Fire and forget so API responses are never slowed down by Expo.
    void deliverPush(
      notification.id,
      user.pushTokens.map((t) => t.token),
      input,
    ).catch((err) => logger.warn({ err }, 'Push delivery failed'));
  }

  return notification;
}

/** Notify everyone who accepted a caregiver invite from this patient (filtered by their alert preferences). */
export async function notifyCaregivers(
  patientId: string,
  permission: 'notifyMissedDoses' | 'notifyLowStock' | 'notifyDeviceIssues' | 'notifyVitals',
  input: NotifyInput,
) {
  const links = await prisma.caregiverLink.findMany({
    where: { patientId, status: 'ACCEPTED', caregiverId: { not: null }, [permission]: true },
  });
  for (const link of links) {
    if (link.caregiverId) await notify(link.caregiverId, input);
  }
  return links.length;
}

async function deliverPush(notificationId: string, tokens: string[], input: NotifyInput) {
  const messages: ExpoPushMessage[] = [];
  const invalidTokens: string[] = [];

  for (const token of tokens) {
    if (!Expo.isExpoPushToken(token)) {
      invalidTokens.push(token);
      continue;
    }
    messages.push({
      to: token,
      sound: 'default',
      title: input.title,
      body: input.body,
      data: { notificationId, type: input.type, ...(typeof input.data === 'object' && input.data ? (input.data as object) : {}) },
      priority: input.type === 'DOSE_REMINDER' || input.type === 'DOSE_MISSED' ? 'high' : 'default',
    });
  }

  if (messages.length === 0) {
    await prisma.notification.update({
      where: { id: notificationId },
      data: { pushError: invalidTokens.length ? 'No valid Expo push tokens' : null },
    });
    return;
  }

  const tickets: ExpoPushTicket[] = [];
  for (const chunk of expo.chunkPushNotifications(messages)) {
    tickets.push(...(await expo.sendPushNotificationsAsync(chunk)));
  }

  const errors: string[] = [];
  tickets.forEach((ticket, i) => {
    if (ticket.status === 'error') {
      errors.push(ticket.message);
      if (ticket.details?.error === 'DeviceNotRegistered') invalidTokens.push(messages[i].to as string);
    }
  });

  if (invalidTokens.length) {
    await prisma.pushToken.deleteMany({ where: { token: { in: invalidTokens } } });
  }

  await prisma.notification.update({
    where: { id: notificationId },
    data: { pushSentAt: new Date(), pushError: errors.length ? errors.join('; ') : null },
  });
}
