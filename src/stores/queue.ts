/**
 * The offline send queue.
 *
 * A turn that failed because the gateway could not be reached is worth retrying, and
 * the message is already in SQLite — so the queue holds conversation ids, not copies
 * of anything. Retrying one is `retryTurn`, which the caller supplies; this store
 * decides only *when* and *in what order*.
 *
 * Two deliberate limits:
 *
 *  - **One at a time.** Two turns racing for a radio that just came back is how one
 *    failure becomes two, and the second failure re-queues both anyway.
 *  - **Stop at the first sign the gateway is still down.** `isUnreachable()` after a
 *    retry means the link is not back; the rest stay queued rather than each burning
 *    a request to learn the same thing.
 *
 * Nothing polls, for the reason `@/stores/reachability` documents. The queue is
 * flushed by evidence: a successful request anywhere in the app flips reachability,
 * and {@link startSendQueue} listens for that. Returning to the foreground with
 * something queued is the one case with no traffic to learn from, so it probes once
 * with the connection test that already exists.
 */

import { create } from 'zustand';
import { AppState } from 'react-native';

import { log } from '@/lib/log';
import { verifyProfile } from '@/lib/verify';
import { useProviders } from '@/stores/providers';
import { isUnreachable, useReachability } from '@/stores/reachability';

export type RetryTurn = (conversationId: string) => Promise<void>;

export interface SendQueueState {
  /** Conversations whose last turn failed on the network, oldest first. */
  ids: string[];
  /** True while a flush is in flight, so two triggers cannot double-send. */
  retrying: boolean;

  queue(conversationId: string): void;
  drop(conversationId: string): void;
  flush(retry: RetryTurn): Promise<number>;
}

export const useSendQueue = create<SendQueueState>()((set, get) => ({
  ids: [],
  retrying: false,

  queue(conversationId) {
    set((state) => (state.ids.includes(conversationId) ? state : { ids: [...state.ids, conversationId] }));
  },

  drop(conversationId) {
    set((state) => ({ ids: state.ids.filter((id) => id !== conversationId) }));
  },

  async flush(retry) {
    const { ids, retrying } = get();
    if (retrying || ids.length === 0) return 0;

    // Taken and cleared up front: a retry that fails again re-queues its own id
    // through the same path a first failure uses, so nothing needs to be put back.
    set({ ids: [], retrying: true });
    let sent = 0;
    try {
      for (const [index, id] of ids.entries()) {
        try {
          await retry(id);
          sent += 1;
        } catch (error) {
          log.warn('queue', 'Queued turn could not be retried', error);
        }
        if (isUnreachable()) {
          const remaining = ids.slice(index + 1);
          if (remaining.length) set((state) => ({ ids: [...state.ids, ...remaining] }));
          break;
        }
      }
    } finally {
      set({ retrying: false });
    }
    if (sent) log.info('queue', `Retried ${sent} queued ${sent === 1 ? 'turn' : 'turns'}.`);
    return sent;
  },
}));

/**
 * Wires the two triggers. Call once at startup; the returned function unwires it.
 *
 * `retry` is passed in rather than imported so this module does not depend on the
 * chat store, which depends on this one to queue a failure in the first place.
 */
export function startSendQueue(retry: RetryTurn): () => void {
  const unsubscribe = useReachability.subscribe((state, previous) => {
    if (state.status === 'reachable' && previous.status !== 'reachable') {
      void useSendQueue.getState().flush(retry);
    }
  });

  const subscription = AppState.addEventListener('change', (next) => {
    if (next !== 'active') return;
    if (useSendQueue.getState().ids.length === 0) return;
    if (!isUnreachable()) {
      void useSendQueue.getState().flush(retry);
      return;
    }
    // A connection test is the cheapest honest probe: it marks reachability either
    // way, and a success wakes the subscription above rather than sending twice.
    void verifyProfile(useProviders.getState().activeId).catch((error: unknown) => {
      log.warn('queue', 'Reconnect probe failed', error);
    });
  });

  return () => {
    unsubscribe();
    subscription.remove();
  };
}
