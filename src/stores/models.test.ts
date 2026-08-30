/**
 * The model registry's merge.
 *
 * `ingest` is the one function here with a promise to keep: a re-discovery must not
 * cost the user a single hand-edited flag, price or hidden mark, and a model the
 * gateway stops listing must be marked absent rather than deleted. Both are silent
 * when broken — the flags come back wrong days later — so they are pinned here.
 *
 * `@/lib/storage` is mocked because the suite runs in node with no AsyncStorage; the
 * store's own logic is what is under test, not the persistence middleware.
 */

jest.mock('@/lib/storage', () => {
  const mockMemory = new Map<string, string>();
  return {
    expectHydration: jest.fn(),
    persistConfig: (name: string, options: Record<string, unknown> = {}) => ({
      name,
      storage: {
        getItem: async (key: string) => (mockMemory.has(key) ? JSON.parse(mockMemory.get(key) ?? 'null') : null),
        setItem: async (key: string, value: unknown) => {
          mockMemory.set(key, JSON.stringify(value));
        },
        removeItem: async (key: string) => {
          mockMemory.delete(key);
        },
      },
      ...options,
    }),
  };
});

import { entryKey, capabilitiesFor, pickableModelIds, useModels, wireHintsFor, guessWireHints } from './models';
import { DEFAULT_CAPABILITIES, guessCapabilities } from '@/transports/support';

const P = 'prof_1';
const KEY = entryKey(P, 'gpt-5');

beforeEach(() => {
  useModels.setState({ entries: {}, lastDiscovery: {} });
});

describe('ingest', () => {
  it('seeds a discovered model with guessed flags', () => {
    const { added, missing } = useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    expect(added).toEqual(['gpt-5']);
    expect(missing).toEqual([]);

    const entry = useModels.getState().get(KEY);
    expect(entry?.guessed).toBe(true);
    expect(entry?.present).toBe(true);
    expect(entry?.profileId).toBe(P);
    // gpt-5 rejects `max_tokens`, and the guess is what saves the first request.
    expect(entry?.wireHints).toEqual(guessWireHints('gpt-5'));
  });

  it('keeps every hand-edited field across a re-discovery', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    useModels.getState().updateCapabilities(KEY, { vision: false });
    useModels.getState().updateWireHints(KEY, { maxTokensField: 'max_tokens' });
    useModels.getState().setPricing(KEY, { inputPerMTok: 1.5, outputPerMTok: 7 });
    useModels.getState().setHidden(KEY, true);

    useModels.getState().ingest(P, [{ id: 'gpt-5', ownedBy: 'openai' }]);

    const entry = useModels.getState().get(KEY);
    expect(entry?.capabilities.vision).toBe(false);
    expect(entry?.wireHints.maxTokensField).toBe('max_tokens');
    expect(entry?.pricing).toEqual({ inputPerMTok: 1.5, outputPerMTok: 7 });
    expect(entry?.hidden).toBe(true);
    expect(entry?.guessed).toBe(false);
    // The gateway's own fields do refresh.
    expect(entry?.ownedBy).toBe('openai');
  });

  it('marks a model the gateway stopped listing rather than deleting it', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }, { id: 'o3' }]);
    useModels.getState().setPricing(entryKey(P, 'o3'), { inputPerMTok: 2, outputPerMTok: 8 });

    const { missing } = useModels.getState().ingest(P, [{ id: 'gpt-5' }]);

    expect(missing).toEqual(['o3']);
    expect(useModels.getState().get(entryKey(P, 'o3'))?.present).toBe(false);
    expect(useModels.getState().get(entryKey(P, 'o3'))?.pricing).toEqual({ inputPerMTok: 2, outputPerMTok: 8 });
  });

  it('leaves the other profiles alone', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    useModels.getState().ingest('prof_2', [{ id: 'claude-opus-5' }]);

    useModels.getState().ingest(P, []);

    expect(useModels.getState().get(entryKey('prof_2', 'claude-opus-5'))?.present).toBe(true);
    expect(useModels.getState().list('prof_2')).toHaveLength(1);
    expect(useModels.getState().lastDiscovery[P]).toBeGreaterThan(0);
  });
});

describe('the rest of the registry', () => {
  it('adds a model the gateway never listed, flagged as absent', () => {
    useModels.getState().addManual(P, '  custom-model  '.trim());
    const entry = useModels.getState().get(entryKey(P, 'custom-model'));
    expect(entry?.present).toBe(false);
    // Twice is a no-op, and a blank id is not a model.
    useModels.getState().addManual(P, 'custom-model');
    useModels.getState().addManual(P, '   ');
    expect(useModels.getState().list(P)).toHaveLength(1);
  });

  it('sorts the list and drops hidden models from the picker', () => {
    useModels.getState().ingest(P, [{ id: 'zeta' }, { id: 'alpha' }]);
    expect(useModels.getState().list(P).map((entry) => entry.id)).toEqual(['alpha', 'zeta']);

    useModels.getState().setHidden(entryKey(P, 'alpha'), true);
    expect(useModels.getState().pickable(P).map((entry) => entry.id)).toEqual(['zeta']);
  });

  it('clears pricing when it is unset, rather than storing a zero', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    useModels.getState().setPricing(KEY, { inputPerMTok: 1, outputPerMTok: 2 });
    useModels.getState().setPricing(KEY, undefined);
    expect(useModels.getState().get(KEY)?.pricing).toBeUndefined();
  });

  it('resets an edited model back to the guess', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    useModels.getState().updateCapabilities(KEY, { vision: false });
    useModels.getState().resetToGuess(KEY);
    const entry = useModels.getState().get(KEY);
    expect(entry?.guessed).toBe(true);
    expect(entry?.wireHints).toEqual(guessWireHints('gpt-5'));
  });

  it('ignores edits to a model that is not there', () => {
    useModels.getState().updateCapabilities('nope', { vision: true });
    useModels.getState().updateWireHints('nope', {});
    useModels.getState().setPricing('nope', { inputPerMTok: 1, outputPerMTok: 1 });
    useModels.getState().setHidden('nope', true);
    useModels.getState().resetToGuess('nope');
    expect(useModels.getState().entries).toEqual({});
  });

  it('removes one model, or every model of a profile', () => {
    useModels.getState().ingest(P, [{ id: 'gpt-5' }, { id: 'o3' }]);
    useModels.getState().ingest('prof_2', [{ id: 'claude-opus-5' }]);

    useModels.getState().remove(entryKey(P, 'o3'));
    expect(useModels.getState().list(P).map((entry) => entry.id)).toEqual(['gpt-5']);

    useModels.getState().clearProfile(P);
    expect(useModels.getState().list(P)).toEqual([]);
    expect(useModels.getState().list('prof_2')).toHaveLength(1);
  });

  it('falls back to a guess for a model that was never discovered', () => {
    // The case that matters: a conversation naming a model whose profile is gone.
    expect(capabilitiesFor('missing', 'gpt-5')).toEqual(guessCapabilities('gpt-5'));
    expect(wireHintsFor('missing', 'gpt-5')).toEqual(guessWireHints('gpt-5'));
    // The store's own lookup has no id to guess from, so it answers with the defaults.
    expect(useModels.getState().capabilitiesFor('nope')).toEqual(DEFAULT_CAPABILITIES);
    expect(useModels.getState().wireHintsFor('nope')).toEqual({});

    useModels.getState().ingest(P, [{ id: 'gpt-5' }]);
    useModels.getState().updateCapabilities(KEY, { vision: false });
    expect(capabilitiesFor(P, 'gpt-5').vision).toBe(false);
  });

  it('always offers the known defaults alongside what was discovered', () => {
    useModels.getState().ingest(P, [{ id: 'zeta' }]);
    expect(pickableModelIds(P, ['claude-opus-5', 'zeta'])).toEqual(['claude-opus-5', 'zeta']);
  });
});
