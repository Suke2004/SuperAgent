/**
 * App-wide preferences.
 *
 * Everything here is a display or behaviour choice, not data: it can all be reset
 * without losing conversations. Deliberately small — per-conversation settings
 * (model, sampling, system prompt) belong to the conversation, not to the app.
 */

import { create } from 'zustand';
import { persist } from 'zustand/middleware';

import { expectHydration, persistConfig } from '@/lib/storage';
import type { ThemeMode } from '@/theme';

/** What to do as the conversation approaches the model's context window. */
export type ContextStrategy = 'warn' | 'drop_oldest' | 'summarise';

export interface SettingsState {
  themeMode: ThemeMode;
  /** Collapsed state of the reasoning pane is remembered, per the spec. */
  showThinkingByDefault: boolean;
  /** Render markdown, or show the raw text the model actually produced. */
  renderMarkdown: boolean;
  /** Live token counting in the composer. Off is cheaper on very long chats. */
  liveTokenCount: boolean;
  contextStrategy: ContextStrategy;
  /** Fraction of the context window at which the pressure warning appears. */
  contextWarnAt: number;
  /** Keep the request/response debug log. */
  debugLogEnabled: boolean;
  /** Mirror debug entries to the Metro console too. */
  debugMirrorToConsole: boolean;
  /** Fall back to the backup domain when the primary is unreachable. */
  autoFailover: boolean;
  /** Cap on agentic tool-use rounds per turn. */
  maxToolIterations: number;
  /** Ask before running a tool the user has not blanket-approved. */
  confirmToolCalls: boolean;
  /** Speak assistant replies with the system voice. */
  ttsEnabled: boolean;
  /** Send on Enter instead of inserting a newline. */
  sendOnEnter: boolean;
  /**
   * Learn durable things about the user and carry them into later conversations.
   *
   * A behaviour toggle rather than a stored flag on the memories themselves: off
   * has to mean the prompt gets no memory block *and* no distillation request is
   * made, so the feature costs nothing while it is off. The memories already
   * learned are kept — "stop learning" and "forget everything" are different
   * intentions, and the second has its own button on the memory screen.
   */
  memoryEnabled: boolean;
  /**
   * Ask the provider to cache the stable prefix of each request.
   *
   * On by default because the arithmetic is one-sided on a conversation that gets a
   * second turn: a cache read costs a tenth of an input token, a write costs
   * 1.25×, so the break-even is a single re-read. Off exists for a gateway that
   * charges the write premium and serves nothing back — see
   * `ModelCapabilities.promptCache`, which gates it per model as well.
   */
  promptCaching: boolean;
  /**
   * Drop replayed reasoning and shorten long tool results before dropping whole
   * turns, when the window is tight.
   *
   * On by default. Off sends every stored block verbatim and reaches straight for
   * dropping turns, which is what the app did before the ladder existed — kept as
   * an escape hatch for anyone debugging a model that behaves differently when its
   * own earlier reasoning is absent.
   */
  progressiveTrim: boolean;

  set<K extends keyof SettingsState>(key: K, value: SettingsState[K]): void;
  reset(): void;
}

const DEFAULTS = {
  themeMode: 'system' as ThemeMode,
  showThinkingByDefault: false,
  renderMarkdown: true,
  liveTokenCount: true,
  contextStrategy: 'warn' as ContextStrategy,
  contextWarnAt: 0.8,
  debugLogEnabled: true,
  debugMirrorToConsole: false,
  autoFailover: true,
  maxToolIterations: 8,
  confirmToolCalls: true,
  ttsEnabled: false,
  sendOnEnter: false,
  memoryEnabled: true,
  promptCaching: true,
  progressiveTrim: true,
};

const STORE_NAME = 'settings';
expectHydration(STORE_NAME);

export const useSettings = create<SettingsState>()(
  persist(
    (set) => ({
      ...DEFAULTS,
      set: (key, value) => set({ [key]: value } as Pick<SettingsState, typeof key>),
      reset: () => set({ ...DEFAULTS }),
    }),
    persistConfig<SettingsState>(STORE_NAME, {
      // Only persist data, never the actions.
      partialize: (state) =>
        Object.fromEntries(Object.keys(DEFAULTS).map((key) => [key, state[key as keyof SettingsState]])),
    }),
  ),
);

/** Read a setting outside React (adapters, background queue). */
export function getSetting<K extends keyof typeof DEFAULTS>(key: K): SettingsState[K] {
  return useSettings.getState()[key];
}
