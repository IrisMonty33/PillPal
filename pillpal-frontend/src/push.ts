/**
 * Registers this phone for push notifications and sends the Expo token to the API.
 *
 * Notes:
 *  - Works on a physical device with a development build (`npx expo run:android` / EAS build).
 *    Expo Go cannot receive remote pushes on Android since SDK 53, so this quietly returns
 *    `null` there; in-app notifications (the bell) still work because they come from the API.
 *  - `projectId` comes from app.json → expo.extra.eas.projectId after `eas init`.
 */
import { Platform } from 'react-native';
import * as Notifications from 'expo-notifications';
import Constants from 'expo-constants';
import * as api from './api';

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});

export async function registerForPush(): Promise<string | null> {
  try {
    const { status: existing } = await Notifications.getPermissionsAsync();
    let status = existing;
    if (status !== 'granted') status = (await Notifications.requestPermissionsAsync()).status;
    if (status !== 'granted') return null;

    if (Platform.OS === 'android') {
      await Notifications.setNotificationChannelAsync('default', {
        name: 'PillPal',
        importance: Notifications.AndroidImportance.HIGH,
      });
    }

    const projectId: string | undefined = Constants.expoConfig?.extra?.eas?.projectId ?? Constants.easConfig?.projectId;
    const token = (await Notifications.getExpoPushTokenAsync(projectId ? { projectId } : undefined)).data;
    await api.auth.registerPushToken(token, Platform.OS === 'ios' ? 'IOS' : 'ANDROID');
    return token;
  } catch (err) {
    // Expo Go, simulator, or no EAS project yet: push is simply unavailable.
    console.log('Push registration skipped:', err instanceof Error ? err.message : err);
    return null;
  }
}
