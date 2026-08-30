/**
 * Provider profiles.
 *
 * Several named gateways, one active at a time, switched manually. The two ships
 * as defaults — AgentRouter primary and its parity backup — plus room for
 * OpenRouter or a first-party key later.
 *
 * A profile pins a transport *kind* as well as a URL, because the two are not
 * interchangeable: the same origin needs `/v1` on the OpenAI path and must not have
 * it on the Anthropic one. Rather than making the user get that right, the base URL
 * is normalised for the chosen kind on save, and the change is reported back.
 *
 * The API key is not in this store. It lives in SecureStore, keyed by profile id;
 * this store holds only whether a key is present and its fingerprint, both of which
 * are safe to persist to AsyncStorage.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { newId } from '@/lib/id';
import { safeHeaders } from '@/lib/redact';
import { deleteApiKey, getKeyStatus, saveApiKey } from '@/lib/secureKey';
import { expectHydration, persistConfig } from '@/lib/storage';
import { normaliseBaseUrl } from '@/transports';
import type { TransportKind } from '@/transports/types';

/** The gateway's documented base URLs. Both are needed; neither is optional. */
export const AGENTROUTER_ORIGIN = 'https://agentrouter.org';
export const AGENTROUTER_BACKUP_ORIGIN = 'https://ps.air-outer.com';

/**
 * Claude ids the gateway is known to serve. Everything else is discovered at
 * runtime from `/v1/models`; this list exists only so a fresh install can send a
 * message before the first discovery call.
 *
 * These are guesses until discovery runs, which is why {@link adoptDiscoveredModel}
 * exists: a seeded id the gateway does not serve comes back as a permission error
 * that reads like a bad key, so the first successful discovery replaces it.
 */
export const DEFAULT_MODEL = 'claude-opus-5';
export const KNOWN_CLAUDE_MODELS = [
  'claude-opus-5',
  'claude-opus-4-8',
  'claude-opus-4-7',
  'claude-opus-4-6',
] as const;

export interface ProviderProfile {
  id: string;
  name: string;
  kind: TransportKind;
  /** Already normalised for `kind`. */
  baseUrl: string;
  /**
   * Where to fail over when this profile's host is unreachable. Origin only —
   * normalisation applies the right `/v1` shape for the kind.
   */
  fallbackBaseUrl?: string;
  /** Default model for new conversations on this profile. */
  defaultModel: string;
  /** Extra headers, e.g. `anthropic-beta`. Never holds the key. */
  headers: Record<string, string>;
  /** Set by `saveKey`; the key itself is in SecureStore. */
  hasKey: boolean;
  keyFingerprint: string;
  /** Result of the last connection test, for the profile list. */
  lastTest?: { at: number; ok: boolean; summary: string };
  createdAt: number;
}

interface ProviderState {
  profiles: ProviderProfile[];
  activeId: string;
  /** Set when a request has failed over to `fallbackBaseUrl`. */
  activeFailover: { profileId: string; from: string; to: string } | null;

  active(): ProviderProfile;
  byId(id: string): ProviderProfile | undefined;
  addProfile(init: Partial<ProviderProfile> & { name: string; kind: TransportKind; baseUrl: string }): string;
  updateProfile(id: string, patch: Partial<Omit<ProviderProfile, 'id' | 'createdAt'>>): void;
  removeProfile(id: string): void;
  duplicateProfile(id: string): string | null;
  setActive(id: string): void;
  saveKey(id: string, key: string): Promise<void>;
  clearKey(id: string): Promise<void>;
  refreshKeyStatus(id: string): Promise<void>;
  recordTest(id: string, ok: boolean, summary: string): void;
  setFailover(value: ProviderState['activeFailover']): void;
}

function makeProfile(
  init: Partial<ProviderProfile> & { name: string; kind: TransportKind; baseUrl: string },
): ProviderProfile {
  const profile: ProviderProfile = {
    id: init.id ?? newId('prof_'),
    name: init.name,
    kind: init.kind,
    baseUrl: normaliseBaseUrl(init.kind, init.baseUrl),
    defaultModel: init.defaultModel ?? DEFAULT_MODEL,
    // Every path that creates a profile — seeds, the editor, duplicate, an
    // imported backup — funnels through here, so this is the one place the header
    // screen has to live. See {@link safeHeaders}: no credential header, no
    // spoofed User-Agent, ever persisted.
    headers: safeHeaders(init.headers),
    hasKey: init.hasKey ?? false,
    keyFingerprint: init.keyFingerprint ?? '(none)',
    createdAt: init.createdAt ?? Date.now(),
  };
  if (init.fallbackBaseUrl) profile.fallbackBaseUrl = init.fallbackBaseUrl;
  if (init.lastTest) profile.lastTest = init.lastTest;
  return profile;
}

/**
 * Seed profiles.
 *
 * Anthropic-first because that is the path with thinking budgets and the richer
 * controls, which is the reason this app exists. The OpenAI profile ships alongside
 * it so the `/v1` distinction is visible in the UI from the first launch rather
 * than being something the user discovers via a 404.
 */
function seedProfiles(): ProviderProfile[] {
  return [
    makeProfile({
      id: 'agentrouter-anthropic',
      name: 'AgentRouter (Anthropic)',
      kind: 'anthropic',
      baseUrl: AGENTROUTER_ORIGIN,
      fallbackBaseUrl: AGENTROUTER_BACKUP_ORIGIN,
    }),
    makeProfile({
      id: 'agentrouter-openai',
      name: 'AgentRouter (OpenAI)',
      kind: 'openai',
      baseUrl: AGENTROUTER_ORIGIN,
      fallbackBaseUrl: AGENTROUTER_BACKUP_ORIGIN,
    }),
  ];
}

const STORE_NAME = 'providers';
expectHydration(STORE_NAME);

export const useProviders = create<ProviderState>()(
  persist(
    (set, get) => ({
      profiles: seedProfiles(),
      activeId: 'agentrouter-anthropic',
      activeFailover: null,

      active() {
        const { profiles, activeId } = get();
        // A deleted active profile must not leave the app with no provider at all.
        return profiles.find((p) => p.id === activeId) ?? profiles[0] ?? seedProfiles()[0]!;
      },

      byId(id) {
        return get().profiles.find((p) => p.id === id);
      },

      addProfile(init) {
        const profile = makeProfile(init);
        set((state) => ({ profiles: [...state.profiles, profile] }));
        return profile.id;
      },

      updateProfile(id, patch) {
        set((state) => ({
          profiles: state.profiles.map((profile) => {
            if (profile.id !== id) return profile;
            const merged = { ...profile, ...patch };
            if (patch.headers !== undefined) merged.headers = safeHeaders(patch.headers);
            // Re-normalise whenever either half of the pair changes, so switching a
            // profile from OpenAI to Anthropic fixes the URL instead of 404ing.
            if (patch.baseUrl !== undefined || patch.kind !== undefined) {
              merged.baseUrl = normaliseBaseUrl(merged.kind, merged.baseUrl);
            }
            return merged;
          }),
        }));
      },

      removeProfile(id) {
        void deleteApiKey(id);
        set((state) => {
          const profiles = state.profiles.filter((p) => p.id !== id);
          const activeId = state.activeId === id ? (profiles[0]?.id ?? '') : state.activeId;
          return { profiles, activeId };
        });
      },

      duplicateProfile(id) {
        const source = get().profiles.find((p) => p.id === id);
        if (!source) return null;
        // The copy deliberately starts without a key: SecureStore entries are keyed
        // by profile id and silently sharing one key across two profiles would make
        // "which key did I revoke?" unanswerable.
        const copy = makeProfile({
          ...source,
          id: newId('prof_'),
          name: `${source.name} copy`,
          hasKey: false,
          keyFingerprint: '(none)',
          createdAt: Date.now(),
        });
        delete copy.lastTest;
        set((state) => ({ profiles: [...state.profiles, copy] }));
        return copy.id;
      },

      setActive(id) {
        if (!get().profiles.some((p) => p.id === id)) return;
        set({ activeId: id, activeFailover: null });
      },

      async saveKey(id, key) {
        const status = await saveApiKey(id, key);
        get().updateProfile(id, { hasKey: status.present, keyFingerprint: status.fingerprint });
      },

      async clearKey(id) {
        await deleteApiKey(id);
        get().updateProfile(id, { hasKey: false, keyFingerprint: '(none)' });
      },

      async refreshKeyStatus(id) {
        const status = await getKeyStatus(id);
        const profile = get().byId(id);
        if (!profile) return;
        if (profile.hasKey === status.present && profile.keyFingerprint === status.fingerprint) return;
        get().updateProfile(id, { hasKey: status.present, keyFingerprint: status.fingerprint });
      },

      recordTest(id, ok, summary) {
        get().updateProfile(id, { lastTest: { at: Date.now(), ok, summary } });
      },

      setFailover(value) {
        set({ activeFailover: value });
      },
    }),
    persistConfig<ProviderState>(STORE_NAME, {
      partialize: (state) => ({ profiles: state.profiles, activeId: state.activeId }),
      merge: (persisted, current) => {
        const saved = (persisted ?? {}) as Partial<ProviderState>;
        // An empty saved list means a wiped install, not a deliberate "no providers";
        // reseeding beats an app that cannot send anything.
        const profiles = saved.profiles?.length ? saved.profiles.map((p) => makeProfile(p)) : current.profiles;
        const activeId = profiles.some((p) => p.id === saved.activeId)
          ? (saved.activeId as string)
          : (profiles[0]?.id ?? '');
        return { ...current, profiles, activeId };
      },
    }),
  ),
);

/** Read the active profile outside React. */
export function activeProfile(): ProviderProfile {
  return useProviders.getState().active();
}

/**
 * Point a profile's `defaultModel` at something the gateway actually serves.
 *
 * The seeded default is a guess, and a guess the gateway does not serve fails as
 * `403 Forbidden` — indistinguishable, from the user's side, from a bad key. So
 * the first discovery that lists models gets to correct it.
 *
 * Returns the id it switched to, or `null` when nothing changed, so the caller can
 * *say* that it happened. Silently rewriting the model the user picked would be
 * its own bug: only a `defaultModel` the gateway did not list is replaced.
 */
export function adoptDiscoveredModel(profileId: string, discovered: readonly string[]): string | null {
  if (discovered.length === 0) return null;
  const profile = useProviders.getState().byId(profileId);
  if (!profile) return null;
  if (discovered.includes(profile.defaultModel)) return null;

  // Prefer Claude: this app's controls (thinking budgets, effort) only exist on
  // that path, so where the gateway offers both it is the more useful default.
  const preferred =
    KNOWN_CLAUDE_MODELS.find((id) => discovered.includes(id)) ??
    discovered.find((id) => id.startsWith('claude-')) ??
    discovered[0];
  if (!preferred || preferred === profile.defaultModel) return null;

  useProviders.getState().updateProfile(profileId, { defaultModel: preferred });
  return preferred;
}
