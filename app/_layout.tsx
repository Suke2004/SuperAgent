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
 *
 * `GestureHandlerRootView` is the outermost element, and it has to be: every gesture
 * the library recognises is dispatched by that view, so a `Gesture.Pan()` mounted
 * outside one does not error — it silently never fires. That failure mode has no crash
 * and no stack trace, which is why the wrapper goes in before anything depends on it
 * rather than alongside the first gesture.
 *
 * {@link Booting}, {@link Locked} and {@link ErrorBoundary} return *before* it, and stay
 * that way deliberately. None of them has a gesture, all three are the app's floor when
 * something has gone wrong or has not started yet, and the less mounted above them the
 * fewer ways they have to fail.
 */

import { Stack, useRouter } from 'expo-router';
import type { ErrorBoundaryProps } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { useEffect, useState } from 'react';
import { AppState, Pressable, Text, View } from 'react-native';
import { GestureHandlerRootView } from 'react-native-gesture-handler';
import { SafeAreaProvider } from 'react-native-safe-area-context';

import { Glyph } from '@/components/Glyph';
import { useReducedMotion } from '@/components/motion';
import { ToastHost } from '@/components/Toast';
import { duration } from '@/constants/animations';
import { APP_NAME } from '@/lib/app';
import { useHydrated } from '@/lib/storage';
import { invalidateTransports } from '@/lib/gateway';
import { unlockApp } from '@/lib/appLock';
import { debugLog } from '@/lib/log';
import { onNotificationTap } from '@/lib/notify';
import { clearCache, primeRedactorWithStoredKeys } from '@/lib/secureKey';
import { useMemory } from '@/stores/memory';
import { useChat } from '@/stores/chat';
import { startSendQueue } from '@/stores/queue';
import { useSkills } from '@/stores/skills';
import { useMcp } from '@/stores/mcp';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { ThemeProvider, useTheme } from '@/theme';

function Navigator() {
  const t = useTheme();
  const router = useRouter();
  const reduced = useReducedMotion();

  // A tapped "reply is ready" notification opens the conversation it came from,
  // including the tap that started the process — see `onNotificationTap`. Pushed, not
  // replaced, so the back gesture still goes where the user expects.
  useEffect(
    () => onNotificationTap((id) => router.push({ pathname: '/chat/[id]', params: { id } })),
    [router],
  );

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
          /**
           * One push animation on both platforms.
           *
           * Android's native-stack default is a fade-with-scale from the centre, which
           * says "a new thing appeared" — but every screen in this app is a level down
           * from the one before it, and the horizontal slide is what carries that. iOS
           * already does this; naming it explicitly is what makes Android agree.
           *
           * Reduce Motion gets a cross-fade rather than nothing at all: a screen change
           * with no transition whatsoever loses the only cue that the *screen* changed
           * rather than its contents, and a fade has no travel to trigger the vestibular
           * problem the setting exists for.
           */
          animation: reduced ? 'fade' : 'slide_from_right',
          animationDuration: duration.panel,
          // The iOS back-swipe, asked for on Android too. On Android this is honoured by
          // the predictive-back implementation in `react-native-screens`; where the OS
          // does not support it the hardware button is still the way back, so the worst
          // case is the behaviour we already had.
          gestureEnabled: true,
        }}
      >
        {/* Home draws its own serif greeting, which *is* the title; a navigator header
            above it would say the app's name twice. */}
        <Stack.Screen name="index" options={{ title: APP_NAME, headerShown: false }} />
        {/* `jarvis://new?q=…`: a redirect with a spinner, so it has nothing to title. */}
        <Stack.Screen name="new" options={{ headerShown: false }} />
        {/* The title comes from the conversation, set by the screen itself. */}
        <Stack.Screen name="chat/[id]" options={{ title: '' }} />
        <Stack.Screen name="chat/inspect" options={{ title: 'Developer details' }} />
        <Stack.Screen name="settings/index" options={{ title: 'Settings' }} />
        <Stack.Screen name="settings/providers" options={{ title: 'Providers' }} />
        <Stack.Screen name="settings/provider/[id]" options={{ title: 'Provider' }} />
        <Stack.Screen name="settings/models" options={{ title: 'Models' }} />
        <Stack.Screen name="settings/model/[key]" options={{ title: 'Model' }} />
        <Stack.Screen name="settings/appearance" options={{ title: 'Appearance' }} />
        <Stack.Screen name="settings/memory" options={{ title: 'Memory' }} />
        <Stack.Screen name="settings/skills" options={{ title: 'Skills' }} />
        <Stack.Screen name="settings/mcp" options={{ title: 'MCP servers' }} />
        <Stack.Screen name="settings/prompts" options={{ title: 'Prompts' }} />
        <Stack.Screen name="settings/projects" options={{ title: 'Projects' }} />
        <Stack.Screen name="settings/usage" options={{ title: 'Usage' }} />
        <Stack.Screen name="settings/backup" options={{ title: 'Backup' }} />
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
 *
 * The mark rather than a spinner, for the same reason: the native splash *is* the
 * mark on this colour, so a stock `ActivityIndicator` here replaced it with an
 * unrelated shape on the first React frame — which is what "the initial loading is
 * not coming correctly" looks like. Same shape, same colour, now turning.
 */
function Booting() {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#262624' }}>
      <Glyph size={56} state="thinking" color="#d97757" label={`${APP_NAME} is starting`} />
    </View>
  );
}

/**
 * The lock screen.
 *
 * Deliberately as bare as {@link Booting} and outside the ThemeProvider: nothing
 * from the transcript should be on screen behind a lock, and that includes the
 * navigator's last frame. The retry button exists because a cancelled or
 * mis-read prompt must not leave a dead screen with no way forward.
 */
function Locked({ onUnlock }: { onUnlock: () => void }) {
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: '#262624', gap: 24 }}>
      <Text style={{ color: '#f5f4ef', fontSize: 20 }}>{APP_NAME} is locked</Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={`Unlock ${APP_NAME}`}
        onPress={onUnlock}
        style={{ paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: '#d97757' }}
      >
        <Text style={{ color: '#262624', fontSize: 16 }}>Unlock</Text>
      </Pressable>
    </View>
  );
}

/**
 * The last resort.
 *
 * A thrown render was taking the whole app out — a blank screen and then the process
 * gone, with nothing on screen to say why. Exported under this name because
 * expo-router looks for it and wraps this segment's routes in a boundary for us,
 * which is a boundary the app cannot forget to mount.
 *
 * Hardcoded colours and no `useTheme`, for the same reason as {@link Booting}: the
 * thing that threw may be inside the theme, and a fallback that can itself throw is
 * not a fallback. The message is shown because "it broke" with no detail is what
 * makes a crash unreportable; `retry` remounts the route, which is enough for the
 * common case of a screen that choked on one bad record.
 */
export function ErrorBoundary({ error, retry }: ErrorBoundaryProps) {
  return (
    <View style={{ flex: 1, justifyContent: 'center', gap: 20, padding: 24, backgroundColor: '#262624' }}>
      <Text style={{ color: '#f5f4ef', fontSize: 20 }}>That screen stopped working</Text>
      <Text selectable style={{ color: '#b7b5ad', fontSize: 13, fontFamily: 'monospace' }}>
        {error.message}
      </Text>
      <Pressable
        accessibilityRole="button"
        accessibilityLabel="Try again"
        onPress={() => void retry()}
        style={{ alignSelf: 'flex-start', paddingHorizontal: 20, paddingVertical: 12, borderRadius: 10, backgroundColor: '#d97757' }}
      >
        <Text style={{ color: '#262624', fontSize: 16 }}>Try again</Text>
      </Pressable>
    </View>
  );
}

export default function RootLayout() {
  const hydrated = useHydrated();
  const themeMode = useSettings((s) => s.themeMode);
  const debugEnabled = useSettings((s) => s.debugLogEnabled);
  const debugMirror = useSettings((s) => s.debugMirrorToConsole);
  const appLockEnabled = useSettings((s) => s.appLockEnabled);
  const profiles = useProviders((s) => s.profiles);
  const [primed, setPrimed] = useState(false);
  /**
   * Derived rather than stored, so nothing has to `setState` during an effect to
   * lock: the app is locked whenever the setting is on and this session has not
   * been through a prompt. A successful unlock and a trip to the background are the
   * only two things that move it.
   */
  const [unlocked, setUnlocked] = useState(false);
  const locked = hydrated && appLockEnabled && !unlocked;

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
    void useMcp.getState().load();
  }, [hydrated]);

  // The offline queue's two triggers live for as long as the app does: a request
  // that proves the gateway is back, and a return to the foreground with something
  // still waiting.
  useEffect(() => {
    if (!hydrated) return;
    return startSendQueue((conversationId) => useChat.getState().retryTurn(conversationId));
  }, [hydrated]);

  /**
   * Shorten the key's life in the heap.
   *
   * The Keystore copy is the only durable one, but the in-memory cache — and the
   * `HttpClient` inside each cached transport, which holds the key as a field — kept
   * it live for the whole process. A backgrounded app can sit in memory for hours and
   * is the state a heap dump is most likely to catch, so both are dropped on the way
   * out and the Keystore is read again on the way back in.
   *
   * Re-priming on `active` is not optional: `clearCache` unregisters the key from the
   * redactor, and without a re-read a log line written before the next request would
   * lose its protection.
   */
  useEffect(() => {
    if (!hydrated) return;
    const subscription = AppState.addEventListener('change', (next) => {
      if (next === 'background') {
        clearCache();
        invalidateTransports();
        setUnlocked(false);
      } else if (next === 'active') {
        void primeRedactorWithStoredKeys(profiles.map((p) => p.id));
      }
    });
    return () => subscription.remove();
  }, [hydrated, profiles]);

  // The prompt follows the locked state rather than the event that caused it, so the
  // cold start and the return from background share one path.
  useEffect(() => {
    if (!locked) return;
    void unlockApp().then((ok) => {
      if (ok) setUnlocked(true);
    });
  }, [locked]);

  // Held back until the keys are registered as well as the state loaded: a screen
  // that logs a request before priming finishes could write an unredacted key.
  if (!hydrated || !primed) return <Booting />;
  if (locked)
    return (
      <Locked
        onUnlock={() => {
          void unlockApp().then((ok) => {
            if (ok) setUnlocked(true);
          });
        }}
      />
    );

  return (
    <GestureHandlerRootView style={{ flex: 1 }}>
      <SafeAreaProvider>
        <ThemeProvider mode={themeMode}>
          <Navigator />
          {/* Above the navigator and outside it, so a toast survives the screen change
              that often causes it — "archived" is raised by the list and read on the
              screen after it. Mounted once: it is a module-level slot, and a second host
              would draw the same message twice. */}
          <ToastHost />
        </ThemeProvider>
      </SafeAreaProvider>
    </GestureHandlerRootView>
  );
}
