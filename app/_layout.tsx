/**
 * Root layout.
 *
 * Three jobs, in order:
 *
 * 1. Wait for persisted state. Rendering before hydration would show defaults, and
 *    the first edit on a settings screen would then write those defaults over the
 *    user's stored values.
 * 2. Register every stored API key with the redactor, so no log line written before
 *    the first request can contain a key — including a key belonging to a profile
 *    that hasn't been used yet.
 * 3. Provide the theme and the navigation stack.
 */

import { Stack } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { ActivityIndicator, View } from 'react-native';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { useHydrated } from '@/lib/storage';
import { debugLog } from '@/lib/log';
import { primeRedactorWithStoredKeys } from '@/lib/secureKey';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { ThemeProvider, useTheme } from '@/theme';

function Navigator() {
  const t = useTheme();
  return (
    <>
      <StatusBar style={t.scheme === 'dark' ? 'light' : 'dark'} />
      <Stack
        screenOptions={{
          headerStyle: { backgroundColor: t.colors.surface },
          headerTintColor: t.colors.text,
          headerTitleStyle: { fontSize: t.fontSize.lg, fontWeight: '600' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.colors.bg },
        }}
      >
        <Stack.Screen name="index" options={{ title: 'AgentRouter' }} />
        {/* The title comes from the conversation, set by the screen itself. */}
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings/providers" options={{ title: 'Providers' }} />
        <Stack.Screen name="settings/provider/[id]" options={{ title: 'Provider' }} />
        <Stack.Screen name="settings/models" options={{ title: 'Models' }} />
        <Stack.Screen name="settings/model/[key]" options={{ title: 'Model' }} />
        <Stack.Screen name="settings/appearance" options={{ title: 'Appearance' }} />
        <Stack.Screen name="settings/debug" options={{ title: 'Debug log' }} />
      </Stack>
    </>
  );
}

function Booting() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#0f1114' }}>
      <ActivityIndicator size="large" color="#4c9aff" />
    </View>
  );
}

export default function RootLayout() {
  const hydrated = useHydrated();
  const themeMode = useSettings((s) => s.themeMode);
  const debugEnabled = useSettings((s) => s.debugLogEnabled);
  const debugMirror = useSettings((s) => s.debugMirrorToConsole);
  const profiles = useProviders((s) => s.profiles);
  const [primed, setPrimed] = useState(false);

  // The log module is deliberately store-free — the transports import it, and a
  // transport that reached into a React store would not be testable in node. So the
  // preference is pushed down from here instead.
  useEffect(() => {
    debugLog.setEnabled(debugEnabled);
    debugLog.setMirrorToConsole(debugMirror);
  }, [debugEnabled, debugMirror]);

  useEffect(() => {
    if (!hydrated || primed) return;
    let cancelled = false;
    void primeRedactorWithStoredKeys(profiles.map((p) => p.id)).finally(() => {
      if (!cancelled) setPrimed(true);
    });
    return () => {
      cancelled = true;
    };
  }, [hydrated, primed, profiles]);

  // Held back until the keys are registered as well as the state loaded: a screen
  // that logs a request before priming finishes could write an unredacted key.
  if (!hydrated || !primed) return <Booting />;

  return (
    <SafeAreaProvider>
      <ThemeProvider mode={themeMode}>
        <Navigator />
      </ThemeProvider>
    </SafeAreaProvider>
  );
}
