/**
 * Persisted-state plumbing for Zustand.
 *
 * Non-secret app state (provider profiles, model flags, preferences) lives in
 * AsyncStorage. Conversations live in SQLite, because they need full-text search.
 * The API key lives in SecureStore and never comes near either — see `secureKey.ts`.
 *
 * Hydration is asynchronous, which matters more than it sounds: a settings screen
 * that renders before hydration finishes will show defaults, and the first edit
 * would then write those defaults over the stored values. `useHydrated` exists so
 * the root layout can hold the UI back until every store has loaded.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';
import { createJSONStorage } from 'zustand/middleware';
import type { PersistOptions } from 'zustand/middleware';

import { log } from './log';

/** Storage adapter shared by every persisted store. */
export const jsonStorage = createJSONStorage(() => AsyncStorage);

/**
 * Standard persist options.
 *
 * `version` + `migrate` are wired up front so a future shape change doesn't have
 * to start by discarding the user's profiles.
 */
export function persistConfig<T>(
  name: string,
  options: Partial<PersistOptions<T, unknown>> = {},
): PersistOptions<T, unknown> {
  return {
    name,
    storage: jsonStorage as PersistOptions<T, unknown>['storage'],
    version: 1,
    onRehydrateStorage: () => (_state, error) => {
      if (error) log.error('storage', `Could not read persisted state for "${name}".`, error);
      markHydrated(name);
    },
    ...options,
  } as PersistOptions<T, unknown>;
}

/* -------------------------------------------------------------------------- */
/* Hydration tracking                                                          */
/* -------------------------------------------------------------------------- */

const expected = new Set<string>();
const hydrated = new Set<string>();
let listeners: (() => void)[] = [];

/** Declare a store that the app should wait for. Called at module load. */
export function expectHydration(name: string): void {
  expected.add(name);
}

function markHydrated(name: string): void {
  hydrated.add(name);
  for (const listener of listeners) listener();
}

export function allHydrated(): boolean {
  for (const name of expected) if (!hydrated.has(name)) return false;
  return true;
}

/** Blocks the first render until every persisted store has loaded. */
export function useHydrated(): boolean {
  const [ready, setReady] = useState(allHydrated);

  useEffect(() => {
    if (ready) return;
    const listener = () => {
      if (allHydrated()) setReady(true);
    };
    listeners = [...listeners, listener];
    listener();

    // AsyncStorage can hang on a corrupt store. Rendering defaults after a beat is
    // better than an app that never paints, so long as nothing writes until the
    // user acts — which is why stores only persist on explicit changes.
    //
    // Logged rather than silent: the screens that come up are showing defaults, not
    // the user's settings, and "my provider profile is gone" needs to be diagnosable
    // from Settings → Debug rather than looking like data loss.
    const timer = setTimeout(() => {
      const missing = [...expected].filter((name) => !hydrated.has(name));
      if (missing.length) {
        log.error(
          'storage',
          `Gave up waiting for stored settings after 3s (${missing.join(', ')}). ` +
            'The app is showing defaults; anything you change now will overwrite what was saved.',
        );
      }
      setReady(true);
    }, 3_000);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
      clearTimeout(timer);
    };
  }, [ready]);

  return ready;
}

/* -------------------------------------------------------------------------- */
/* Direct access, for things that aren't stores                                */
/* -------------------------------------------------------------------------- */

export async function readJson<T>(key: string, fallback: T): Promise<T> {
  try {
    const raw = await AsyncStorage.getItem(key);
    return raw === null ? fallback : (JSON.parse(raw) as T);
  } catch (error) {
    log.warn('storage', `Could not read "${key}".`, error);
    return fallback;
  }
}

export async function writeJson(key: string, value: unknown): Promise<void> {
  try {
    await AsyncStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    log.warn('storage', `Could not write "${key}".`, error);
  }
}

export async function removeKey(key: string): Promise<void> {
  try {
    await AsyncStorage.removeItem(key);
  } catch (error) {
    log.warn('storage', `Could not remove "${key}".`, error);
  }
}
