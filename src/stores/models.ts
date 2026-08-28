/**
 * Model registry.
 *
 * `GET /v1/models` returns ids and almost nothing else — no context window, no
 * vision flag, no indication of whether a model reasons. So the registry keeps two
 * things side by side: what the gateway reported, and what the user has told us
 * about each model. The second half is hand-editable and never overwritten by a
 * refresh, because a discovery call that reset the user's flags every time would
 * make them not worth setting.
 *
 * Capabilities are seeded by `guessCapabilities` on first sight. Guesses are marked
 * as such, so the UI can say "guessed" rather than implying the gateway confirmed it.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { expectHydration, persistConfig } from '@/lib/storage';
import { DEFAULT_CAPABILITIES, guessCapabilities } from '@/transports/support';
import type { ModelCapabilities } from '@/transports/support';
import type { DiscoveredModel, WireHints } from '@/transports/types';

export interface ModelEntry {
  id: string;
  /** Which profile discovered it, so a stale entry can be attributed. */
  profileId: string;
  ownedBy?: string;
  capabilities: ModelCapabilities;
  /** False once the user edits the flags. Drives the "guessed" badge. */
  guessed: boolean;
  /** Wire quirks: `max_completion_tokens`, `anthropic-beta` values. */
  wireHints: WireHints;
  /** Per-million-token prices, for the cost estimate. Unknown unless entered. */
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  /** Hidden from the model picker without being deleted. */
  hidden: boolean;
  /** Present in the last successful discovery for its profile. */
  present: boolean;
  firstSeen: number;
  lastSeen: number;
  /** Anything else `/v1/models` returned, for the detail screen. */
  extra?: Record<string, unknown>;
}

interface ModelState {
  entries: Record<string, ModelEntry>;
  /** Per-profile timestamp of the last successful discovery. */
  lastDiscovery: Record<string, number>;

  list(profileId?: string): ModelEntry[];
  pickable(profileId: string): ModelEntry[];
  get(id: string): ModelEntry | undefined;
  capabilitiesFor(id: string): ModelCapabilities;
  wireHintsFor(id: string): WireHints;
  /** Merge a discovery result, preserving every hand-edited flag. */
  ingest(profileId: string, discovered: DiscoveredModel[]): { added: string[]; missing: string[] };
  /** Add a model the gateway didn't list, so an undiscovered id is still usable. */
  addManual(profileId: string, id: string): void;
  updateCapabilities(id: string, patch: Partial<ModelCapabilities>): void;
  updateWireHints(id: string, patch: Partial<WireHints>): void;
  setPricing(id: string, pricing: ModelEntry['pricing']): void;
  setHidden(id: string, hidden: boolean): void;
  resetToGuess(id: string): void;
  remove(id: string): void;
  clearProfile(profileId: string): void;
}

/**
 * Registry keys are `profileId::modelId`.
 *
 * The same id can mean different things on two gateways — different context
 * window, different pricing, sometimes a different model entirely — so flags are
 * scoped per profile rather than shared by name.
 */
export function entryKey(profileId: string, modelId: string): string {
  return `${profileId}::${modelId}`;
}

const STORE_NAME = 'models';
expectHydration(STORE_NAME);

function seedEntry(profileId: string, model: DiscoveredModel, now: number): ModelEntry {
  const entry: ModelEntry = {
    id: model.id,
    profileId,
    capabilities: guessCapabilities(model.id),
    guessed: true,
    wireHints: guessWireHints(model.id),
    hidden: false,
    present: true,
    firstSeen: now,
    lastSeen: now,
  };
  if (model.ownedBy !== undefined) entry.ownedBy = model.ownedBy;
  if (model.extra !== undefined) entry.extra = model.extra;
  return entry;
}

/**
 * Guess the wire quirks from the id.
 *
 * Only `max_completion_tokens` is worth guessing: the newer OpenAI reasoning
 * families reject `max_tokens` outright. A wrong guess costs one extra round trip,
 * because the adapter renames and retries once either way.
 */
export function guessWireHints(modelId: string): WireHints {
  const id = modelId.toLowerCase();
  const needsAlias = /^(o\d|gpt-5|gpt-4\.1|gpt-4o-.*(mini|reason))/.test(id) || /reasoning/.test(id);
  return needsAlias ? { maxTokensField: 'max_completion_tokens' } : {};
}

export const useModels = create<ModelState>()(
  persist(
    (set, get) => ({
      entries: {},
      lastDiscovery: {},

      list(profileId) {
        const all = Object.values(get().entries);
        const scoped = profileId ? all.filter((e) => e.profileId === profileId) : all;
        return scoped.sort((a, b) => a.id.localeCompare(b.id));
      },

      pickable(profileId) {
        return get()
          .list(profileId)
          .filter((entry) => !entry.hidden);
      },

      get(id) {
        return get().entries[id];
      },

      capabilitiesFor(id) {
        return get().entries[id]?.capabilities ?? DEFAULT_CAPABILITIES;
      },

      wireHintsFor(id) {
        return get().entries[id]?.wireHints ?? {};
      },

      ingest(profileId, discovered) {
        const now = Date.now();
        const added: string[] = [];
        const seen = new Set(discovered.map((m) => m.id));

        set((state) => {
          const entries = { ...state.entries };

          for (const model of discovered) {
            const key = entryKey(profileId, model.id);
            const existing = entries[key];
            if (existing) {
              // Refresh only the gateway-owned fields. `capabilities`, `wireHints`,
              // `pricing` and `hidden` are the user's, and a refresh must not touch them.
              entries[key] = {
                ...existing,
                lastSeen: now,
                present: true,
                ...(model.ownedBy !== undefined ? { ownedBy: model.ownedBy } : {}),
                ...(model.extra !== undefined ? { extra: model.extra } : {}),
              };
            } else {
              entries[key] = seedEntry(profileId, model, now);
              added.push(model.id);
            }
          }

          // Mark absent models rather than deleting them: a gateway that briefly
          // stops listing a model should not cost the user their pricing and flags.
          for (const [key, entry] of Object.entries(entries)) {
            if (entry.profileId === profileId && !seen.has(entry.id)) {
              entries[key] = { ...entry, present: false };
            }
          }

          return { entries, lastDiscovery: { ...state.lastDiscovery, [profileId]: now } };
        });

        const missing = get()
          .list(profileId)
          .filter((entry) => !entry.present)
          .map((entry) => entry.id);
        return { added, missing };
      },

      addManual(profileId, id) {
        const modelId = id.trim();
        if (!modelId) return;
        const key = entryKey(profileId, modelId);
        if (get().entries[key]) return;
        const now = Date.now();
        set((state) => ({
          entries: {
            ...state.entries,
            // `present: false` is honest — the gateway never listed it. The picker
            // still offers it, flagged, because gateways serve unlisted models.
            [key]: { ...seedEntry(profileId, { id: modelId }, now), present: false },
          },
        }));
      },

      updateCapabilities(id, patch) {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;
          return {
            entries: {
              ...state.entries,
              [id]: { ...entry, capabilities: { ...entry.capabilities, ...patch }, guessed: false },
            },
          };
        });
      },

      updateWireHints(id, patch) {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;
          return { entries: { ...state.entries, [id]: { ...entry, wireHints: { ...entry.wireHints, ...patch } } } };
        });
      },

      setPricing(id, pricing) {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;
          const next = { ...entry };
          if (pricing) next.pricing = pricing;
          else delete next.pricing;
          return { entries: { ...state.entries, [id]: next } };
        });
      },

      setHidden(id, hidden) {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;
          return { entries: { ...state.entries, [id]: { ...entry, hidden } } };
        });
      },

      resetToGuess(id) {
        set((state) => {
          const entry = state.entries[id];
          if (!entry) return state;
          return {
            entries: {
              ...state.entries,
              [id]: {
                ...entry,
                capabilities: guessCapabilities(entry.id),
                wireHints: guessWireHints(entry.id),
                guessed: true,
              },
            },
          };
        });
      },

      remove(id) {
        set((state) => {
          const entries = { ...state.entries };
          delete entries[id];
          return { entries };
        });
      },

      clearProfile(profileId) {
        set((state) => ({
          entries: Object.fromEntries(
            Object.entries(state.entries).filter(([, entry]) => entry.profileId !== profileId),
          ),
        }));
      },
    }),
    persistConfig<ModelState>(STORE_NAME, {
      partialize: (state) => ({ entries: state.entries, lastDiscovery: state.lastDiscovery }),
    }),
  ),
);

/**
 * Capabilities for a model on a profile, falling back to a guess.
 *
 * The fallback matters: a conversation can name a model that was never discovered
 * (typed manually, or discovered under a profile since deleted), and greying out
 * every control because the registry has no row would be worse than guessing.
 */
export function capabilitiesFor(profileId: string, modelId: string): ModelCapabilities {
  const entry = useModels.getState().get(entryKey(profileId, modelId));
  return entry?.capabilities ?? guessCapabilities(modelId);
}

export function wireHintsFor(profileId: string, modelId: string): WireHints {
  const entry = useModels.getState().get(entryKey(profileId, modelId));
  return entry?.wireHints ?? guessWireHints(modelId);
}

/** Models to offer for a profile, always including the known Claude defaults. */
export function pickableModelIds(profileId: string, extraDefaults: readonly string[]): string[] {
  const discovered = useModels.getState().pickable(profileId).map((entry) => entry.id);
  const merged = [...new Set([...discovered, ...extraDefaults])];
  return merged.sort((a, b) => a.localeCompare(b));
}
