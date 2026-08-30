/**
 * API key storage.
 *
 * The key lives in `expo-secure-store` (Android Keystore) and nowhere else. In
 * particular it is **not** part of any Zustand store, because those stores persist
 * to AsyncStorage — putting the key in state would write it to plaintext storage
 * the moment someone added a field to a persisted slice. The provider store holds
 * only a boolean and a fingerprint; the key is read here, at request time.
 *
 * Every value read is registered with the redactor immediately, so from the first
 * read onwards the debug log and every export scrubs it automatically.
 */

import * as SecureStore from 'expo-secure-store';
import { Platform } from 'react-native';

import { keyFingerprint, registerSecret, unregisterSecret } from './redact';

/** One entry per provider profile, so switching profiles switches keys. */
const PREFIX = 'agentrouter.apiKey.';

/** Web has no Android Keystore. This is development-only compatibility storage. */
function webStorage(): Storage | null {
  if (Platform.OS !== 'web') return null;
  try {
    return globalThis.localStorage;
  } catch {
    return null;
  }
}

/**
 * Some browser contexts (private/opaque iframes, blocked cookies, SSR) expose
 * `localStorage` but reject access to it. Keep web compatibility in-memory in
 * those contexts, and never fall through to the native SecureStore module.
 */
const webMemory = new Map<string, string>();

function webSet(id: string, value: string): void {
  const browser = webStorage();
  if (browser) {
    try {
      browser.setItem(id, value);
      webMemory.delete(id);
      return;
    } catch {
      // Fall back to session-only memory below.
    }
  }
  webMemory.set(id, value);
}

function webGet(id: string): string | null {
  const browser = webStorage();
  if (browser) {
    try {
      return browser.getItem(id) ?? webMemory.get(id) ?? null;
    } catch {
      // Fall back to session-only memory below.
    }
  }
  return webMemory.get(id) ?? null;
}

function webDelete(id: string): void {
  const browser = webStorage();
  if (browser) {
    try {
      browser.removeItem(id);
    } catch {
      // Continue and clear the in-memory copy below.
    }
  }
  webMemory.delete(id);
}

/**
 * In-memory cache, module-scoped and never persisted.
 *
 * A Keystore read is a few milliseconds, which is fine per request but not per
 * keystroke in the composer's token counter. Cleared by `forget`/`clearCache`.
 */
const cache = new Map<string, string>();

function storageKey(profileId: string): string {
  // SecureStore keys must be alphanumeric plus `.`, `-`, `_`.
  return `${PREFIX}${profileId.replace(/[^A-Za-z0-9._-]/g, '_')}`;
}

export interface KeyStatus {
  present: boolean;
  /** A salted hash prefix like `#3f9c1a02`, or `(none)`. Safe to render and to log. */
  fingerprint: string;
}

export async function isSecureStoreAvailable(): Promise<boolean> {
  if (Platform.OS === 'web') return false;
  try {
    return await SecureStore.isAvailableAsync();
  } catch {
    return false;
  }
}

export async function saveApiKey(profileId: string, key: string): Promise<KeyStatus> {
  const trimmed = key.trim();
  if (!trimmed) {
    await deleteApiKey(profileId);
    return { present: false, fingerprint: keyFingerprint(null) };
  }

  const previous = cache.get(storageKey(profileId));
  if (previous && previous !== trimmed) unregisterSecret(previous);

  if (Platform.OS === 'web') {
    webSet(storageKey(profileId), trimmed);
  } else {
    await SecureStore.setItemAsync(storageKey(profileId), trimmed, {
      keychainAccessible: SecureStore.WHEN_UNLOCKED,
    });
  }
  cache.set(storageKey(profileId), trimmed);
  registerSecret(trimmed);
  return { present: true, fingerprint: keyFingerprint(trimmed) };
}

export async function loadApiKey(profileId: string): Promise<string | null> {
  const id = storageKey(profileId);
  const cached = cache.get(id);
  if (cached !== undefined) return cached;

  try {
    const value = Platform.OS === 'web' ? webGet(id) : await SecureStore.getItemAsync(id);
    if (value) {
      cache.set(id, value);
      registerSecret(value);
      return value;
    }
    return null;
  } catch {
    // A corrupt Keystore entry (or a restored backup from another device) throws
    // rather than returning null. Treat it as absent so the UI asks for the key
    // again instead of showing an unactionable decryption error.
    return null;
  }
}

export async function deleteApiKey(profileId: string): Promise<void> {
  const id = storageKey(profileId);
  const cached = cache.get(id);
  if (cached) unregisterSecret(cached);
  cache.delete(id);
  try {
    if (Platform.OS === 'web') webDelete(id);
    else await SecureStore.deleteItemAsync(id);
  } catch {
    // Deleting something already absent is not an error worth surfacing.
  }
}

export async function getKeyStatus(profileId: string): Promise<KeyStatus> {
  const key = await loadApiKey(profileId);
  return { present: key !== null, fingerprint: keyFingerprint(key) };
}

/**
 * Load every stored key and register it with the redactor.
 *
 * Called once at startup: without it, a log line written before the first request
 * could contain a key from a profile that hasn't been used yet this session.
 */
export async function primeRedactorWithStoredKeys(profileIds: string[]): Promise<void> {
  await Promise.all(profileIds.map((id) => loadApiKey(id)));
}

/** Drop the in-memory copies without touching the Keystore. */
export function clearCache(): void {
  for (const value of cache.values()) unregisterSecret(value);
  cache.clear();
}
