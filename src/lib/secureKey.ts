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
import { log } from './log';

/** One entry per provider profile, so switching profiles switches keys. */
const PREFIX = 'agentrouter.apiKey.';

/**
 * Web keys live in memory for the session and nowhere else.
 *
 * They used to go to `localStorage`, which was labelled development-only and was
 * still one `expo start --web` from being real: any injected script can read it and
 * it survives the tab closing. A key that has to be re-pasted after a refresh is a
 * worse dev experience and a strictly better security story, and web is not a
 * supported target — Android is.
 */
const webMemory = new Map<string, string>();

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

/**
 * Said once per session, the first time a key is written on web.
 *
 * The `Map` above is a strictly better story than `localStorage`, but it is still a
 * JavaScript variable in a page: any injected script that can reach this module can
 * read it, and there is no Keystore to move it into. Android is the supported target;
 * a web session is for looking at the UI, not for a real key. Said out loud rather
 * than left to the comment, because the comment is not on screen when someone pastes.
 */
let warnedAboutWeb = false;

function warnOnWeb(): void {
  if (Platform.OS !== 'web' || warnedAboutWeb) return;
  warnedAboutWeb = true;
  log.warn(
    'secureKey',
    'This is the web build, which has no Keystore: the key is held in a page variable for this session only ' +
      'and any script on the page can read it. Use a throwaway key here, or run the Android build.',
  );
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
    warnOnWeb();
    webMemory.set(storageKey(profileId), trimmed);
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
    const value =
      Platform.OS === 'web' ? (webMemory.get(id) ?? null) : await SecureStore.getItemAsync(id);
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
    if (Platform.OS === 'web') webMemory.delete(id);
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
