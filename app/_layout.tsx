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
import { useMemory } from '@/stores/memory';
import { useSkills } from '@/stores/skills';
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
          // The header sits on the page colour rather than a raised surface: in this
          // design the app is one continuous sheet, and a lighter bar across the top
          // would be the only edge on the screen that means nothing.
          headerStyle: { backgroundColor: t.colors.bg },
          headerTintColor: t.colors.text,
          headerTitleStyle: { fontFamily: t.serifFont, fontSize: t.fontSize.lg, fontWeight: '400' },
          headerShadowVisible: false,
          contentStyle: { backgroundColor: t.colors.bg },
        }}
      >
        {/* Home draws its own serif greeting, which *is* the title; a navigator header
            above it would say the app's name twice. */}
        <Stack.Screen name="index" options={{ title: 'Jarvis', headerShown: false }} />
        {/* The title comes from the conversation, set by the screen itself. */}
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings/providers" options={{ title: 'Providers' }} />
        <Stack.Screen name="settings/provider/[id]" options={{ title: 'Provider' }} />
        <Stack.Screen name="settings/models" options={{ title: 'Models' }} />
        <Stack.Screen name="settings/model/[key]" options={{ title: 'Model' }} />
        <Stack.Screen name="settings/appearance" options={{ title: 'Appearance' }} />
        <Stack.Screen name="settings/memory" options={{ title: 'Memory' }} />
        <Stack.Screen name="settings/skills" options={{ title: 'Skills' }} />
        <Stack.Screen name="settings/debug" options={{ title: 'Debug log' }} />
      </Stack>
    </>
  );
}

/**
 * The pre-hydration screen.
 *
 * Colours are hardcoded because this renders outside the ThemeProvider, and they
 * match the splash background so the handoff from the native splash to the first
 * React frame has no flash.
 */
function Booting() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#262624' }}>
      <ActivityIndicator size="large" color="#d97757" />
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

  // Memories are read once at start rather than lazily on the first send: the send
  // path reads them synchronously to build the prompt, so a store that were still
  // empty at that moment would silently produce a memory-free first request.
  // Not a render gate — a missing memory block degrades the reply, it doesn't break
  // it, and blocking the first frame on SQLite would be the worse trade.
  useEffect(() => {
    if (!hydrated) return;
    void useMemory.getState().load();
    void useSkills.getState().load();
  }, [hydrated]);

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
