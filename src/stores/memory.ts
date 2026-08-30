/**
 * The memory store: the on/off switch, the cache the prompt builder reads, and the
 * distillation pass.
 *
 * The switch lives in `@/stores/settings` (`memoryEnabled`) with the app's other
 * behaviour toggles rather than here, so non-React code can read it the same way
 * it reads every other setting. What lives here is the loaded set of memories and
 * the actions over them.
 *
 * Off means off. When `memoryEnabled` is false the prompt gets no memory block and
 * no distillation request is made — the feature costs exactly nothing, rather than
 * being collected silently and merely not used. What is already stored is kept,
 * because "stop learning" and "forget what you know" are different intentions and
 * the second one has its own button.
 */

import { create } from 'zustand';

import {
  DISTIL_INSTRUCTION,
  approvedOnly,
  memoryAppliesTo,
  mergeMemories,
  parseMemory,
  renderMemoryBlock,
  shouldDistil,
} from '@/chat/memory';
import type { Memory, MemoryBlock } from '@/chat/memory';
import {
  addMemory,
  approveMemory,
  clearMemories,
  confirmMemory,
  deleteMemory as dbDeleteMemory,
  editMemory,
  listMemories,
  markMemoriesUsed,
  setMemoryPinned,
} from '@/db/memories';
import { flattenContent } from '@/db/conversations';
import type { StoredMessage } from '@/db/conversations';
import { resolveTransport } from '@/lib/gateway';
import { log } from '@/lib/log';
import { getSetting } from '@/stores/settings';
import type { ContentBlock } from '@/transports/types';

/** How much of the exchange the distillation pass reads, in characters. */
const DISTIL_CONTEXT_CHARS = 6_000;

/** Cap on the distillation reply. It returns a short JSON array or nothing. */
const DISTIL_MAX_TOKENS = 512;

export interface MemoryState {
  memories: Memory[];
  loaded: boolean;
  /** True while a distillation pass is in flight, for the settings screen. */
  distilling: boolean;

  load(): Promise<void>;
  /**
   * The block to prepend to a system prompt, and the ids it used.
   *
   * `memory` is the conversation's own override, which can only silence memory —
   * see {@link memoryAppliesTo}. Omitted means "whatever the global setting says".
   */
  promptBlock(memory?: boolean): MemoryBlock;
  add(text: string, kind?: Memory['kind']): Promise<void>;
  edit(id: string, text: string): Promise<void>;
  /** The user agreeing a distilled memory may be sent. Until then it is stored and unused. */
  approve(id: string): Promise<void>;
  setPinned(id: string, pinned: boolean): Promise<void>;
  forget(id: string): Promise<void>;
  /** Deletes every memory. Returns how many there were. */
  forgetEverything(): Promise<number>;
  /** Records that these memories were sent. Fire and forget. */
  noteUsed(ids: readonly string[]): void;
  /**
   * Asks the model what it learned, if the throttle and the switch both allow it.
   *
   * Resolves to the number of new memories. Never throws: a failed distillation is
   * a missed opportunity, and the turn it follows has already succeeded.
   */
  distil(input: { conversationId: string; profileId: string; model: string; messages: readonly StoredMessage[]; memory?: boolean }): Promise<number>;
}

export const useMemory = create<MemoryState>()((set, get) => ({
  memories: [],
  loaded: false,
  distilling: false,

  async load() {
    try {
      const memories = await listMemories();
      set({ memories, loaded: true });
    } catch (error) {
      log.error('memory', 'Could not load memories', {
        error: error instanceof Error ? error.message : String(error),
      });
      set({ loaded: true });
    }
  },

  promptBlock(memory) {
    if (!memoryAppliesTo(getSetting('memoryEnabled'), memory)) return { included: [], dropped: 0, chars: 0 };
    // The review gate: a memory the user has not agreed to is never sent, however
    // highly it ranks. Filtered here rather than in `listMemories`, because the
    // settings screen has to be able to see the pending ones to act on them.
    return renderMemoryBlock(approvedOnly(get().memories));
  },

  async add(text, kind = 'fact') {
    const trimmed = text.trim();
    if (!trimmed) return;
    const memory = await addMemory({ kind, text: trimmed });
    set((state) => ({
      memories: [memory, ...state.memories.filter((m) => m.id !== memory.id)],
    }));
  },

  async edit(id, text) {
    const trimmed = text.trim();
    if (!trimmed) return;
    await editMemory(id, trimmed);
    set((state) => ({
      memories: state.memories.map((m) => (m.id === id ? { ...m, text: trimmed, updatedAt: Date.now() } : m)),
    }));
  },

  async approve(id) {
    await approveMemory(id);
    set((state) => ({
      memories: state.memories.map((m) => (m.id === id ? { ...m, approved: true, updatedAt: Date.now() } : m)),
    }));
  },

  async setPinned(id, pinned) {
    await setMemoryPinned(id, pinned);
    set((state) => ({ memories: state.memories.map((m) => (m.id === id ? { ...m, pinned } : m)) }));
  },

  async forget(id) {
    await dbDeleteMemory(id);
    set((state) => ({ memories: state.memories.filter((m) => m.id !== id) }));
  },

  async forgetEverything() {
    const removed = await clearMemories();
    set({ memories: [] });
    return removed;
  },

  noteUsed(ids) {
    if (!ids.length) return;
    void markMemoriesUsed(ids).catch(() => {
      // Provenance only. Losing it is not worth surfacing to the user, and this
      // runs immediately after a send that did succeed.
    });
  },

  async distil(input) {
    const assistantTurns = input.messages.filter((m) => m.role === 'assistant' && !m.error).length;
    const enabled = memoryAppliesTo(getSetting('memoryEnabled'), input.memory);
    if (!shouldDistil({ enabled, assistantTurns })) return 0;
    if (get().distilling) return 0;

    set({ distilling: true });
    try {
      if (!get().loaded) await get().load();

      const transcript = recentTranscript(input.messages);
      if (!transcript) return 0;

      const { transport } = await resolveTransport({ profileId: input.profileId });
      const result = await transport.complete({
        model: input.model,
        messages: [{ role: 'user', content: [{ type: 'text', text: `${transcript}\n\n${DISTIL_INSTRUCTION}` }] }],
        params: { maxTokens: DISTIL_MAX_TOKENS },
      });

      const raw = result.content
        .filter((block): block is Extract<ContentBlock, { type: 'text' }> => block.type === 'text')
        .map((block) => block.text)
        .join('\n');

      const candidates = parseMemory(raw);
      if (!candidates.length) return 0;

      const { additions, confirmed } = mergeMemories(get().memories, candidates);
      for (const id of confirmed) await confirmMemory(id);
      // `false`: stored, listed, and not sent until the user says so. The gate is
      // here rather than in the UI because this is the only writer whose text the
      // user never typed — a line in an attached document that reads like a
      // preference would otherwise become a standing instruction in every later
      // conversation, outliving the chat it entered through.
      for (const candidate of additions) await addMemory(candidate, input.conversationId, false);

      // Reloaded rather than patched: the hit counts just changed, and the
      // ordering the settings screen shows is derived from them.
      await get().load();

      if (additions.length || confirmed.length) {
        log.info('memory', `Learned ${additions.length} new, reconfirmed ${confirmed.length}`);
      }
      return additions.length;
    } catch (error) {
      log.warn('memory', 'Could not distil anything from this turn', {
        error: error instanceof Error ? error.message : String(error),
      });
      return 0;
    } finally {
      set({ distilling: false });
    }
  },
}));

/**
 * The tail of the conversation, as plain text, capped.
 *
 * The tail rather than the whole thread: distillation runs every few turns, so
 * earlier turns have already been read by an earlier pass, and re-sending them
 * would make the cost of the feature grow with conversation length — which is
 * precisely the shape of cost this app avoids everywhere else.
 */
function recentTranscript(messages: readonly StoredMessage[]): string {
  const parts: string[] = [];
  let used = 0;
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i];
    if (!message || message.excluded) continue;
    const text = flattenContent(message.content).trim();
    if (!text) continue;
    const line = `${message.role === 'user' ? 'User' : 'Assistant'}: ${text}`;
    if (used + line.length > DISTIL_CONTEXT_CHARS) break;
    parts.unshift(line);
    used += line.length;
  }
  return parts.join('\n\n');
}
