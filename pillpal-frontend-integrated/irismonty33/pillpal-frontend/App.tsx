import React, { useState } from 'react';
import { ActivityIndicator, RefreshControl, SafeAreaView, ScrollView, StatusBar, Text, TouchableOpacity, View } from 'react-native';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { configureApi } from './src/api';
import { NAV_PAGES, type Page } from './src/navigation';
import { AppProvider, useApp } from './src/store';
import { coral, styles } from './src/theme';
import { AlertsScreen } from './src/screens/AlertsScreen';
import { HelpScreen } from './src/screens/HelpScreen';
import { HomeScreen } from './src/screens/HomeScreen';
import { LoginScreen } from './src/screens/LoginScreen';
import { MedicationsScreen } from './src/screens/MedicationsScreen';
import { RemindersScreen } from './src/screens/RemindersScreen';
import { ReportsScreen } from './src/screens/ReportsScreen';
import { ScheduleScreen } from './src/screens/ScheduleScreen';
import { SettingsScreen } from './src/screens/SettingsScreen';

// Tokens live in AsyncStorage so the user stays signed in between launches.
configureApi({ storage: AsyncStorage });

export default function App() {
  return (
    <AppProvider>
      <Shell />
    </AppProvider>
  );
}

function Shell() {
  const { preview, sessionChecked, user, role, data, loading, refreshing, error, refresh } = useApp();
  const [page, setPage] = useState<Page>('Home');

  const header = (
    <View style={styles.header}>
      <View>
        <Text style={styles.brand}>PillPal</Text>
        <Text style={styles.subhead}>{preview ? 'Preview mode' : user ? (role === 'caregiver' ? `Caregiver view · ${user.firstName}` : `Patient view · ${user.firstName}`) : 'Sign in'}</Text>
      </View>
      {(user || preview) && (
        <TouchableOpacity accessibilityRole="button" accessibilityLabel="Alerts" onPress={() => setPage('Alerts')}>
          <Text style={styles.bell}>🔔</Text>
          {data.unreadCount > 0 && <Text style={styles.bellBadge}>{data.unreadCount}</Text>}
        </TouchableOpacity>
      )}
    </View>
  );

  if (!preview && !sessionChecked) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        {header}
        <ActivityIndicator color={coral} style={{ marginTop: 60 }} />
      </SafeAreaView>
    );
  }

  if (!preview && !user) {
    return (
      <SafeAreaView style={styles.root}>
        <StatusBar barStyle="dark-content" />
        {header}
        <LoginScreen />
      </SafeAreaView>
    );
  }

  const content = () => {
    switch (page) {
      case 'Home':
        return <HomeScreen go={setPage} />;
      case 'Reports':
        return <ReportsScreen />;
      case 'Reminders':
        return <RemindersScreen />;
      case 'Medications':
        return <MedicationsScreen />;
      case 'Schedule':
        return <ScheduleScreen />;
      case 'Settings':
        return <SettingsScreen />;
      case 'Alerts':
        return <AlertsScreen />;
      default:
        return <HelpScreen />;
    }
  };

  return (
    <SafeAreaView style={styles.root}>
      <StatusBar barStyle="dark-content" />
      {header}
      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled" refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} />}>
        {page !== 'Home' && (
          <TouchableOpacity onPress={() => setPage('Home')}>
            <Text style={styles.back}>‹  Home</Text>
          </TouchableOpacity>
        )}
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {loading && data.meds.length === 0 ? <ActivityIndicator color={coral} style={{ marginVertical: 20 }} /> : null}
        {content()}
      </ScrollView>
      <View style={styles.nav}>
        {NAV_PAGES.map((p) => (
          <TouchableOpacity key={p} onPress={() => setPage(p)} style={styles.navItem}>
            <Text style={[styles.navText, page === p && styles.active]}>{p}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </SafeAreaView>
  );
}
