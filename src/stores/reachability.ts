/**
 * Whether the gateway can currently be reached.
 *
 * Deliberately *not* device connectivity. This app has no NetInfo dependency, and
 * "the phone has a network" is the wrong question anyway: a captive portal, a VPN
 * that blackholes the gateway's host, and a gateway that is simply down all look
 * like a healthy radio and a failing request. So the only thing recorded here is
 * evidence this app produced itself — a request that could not reach the host, or
 * one that did.
 *
 * That makes the banner honest: it says the last attempt could not reach the
 * gateway and when, never "you are offline". Nothing polls; a state this cheap to
 * be wrong about should only be updated by real traffic.
 */

import { create } from 'zustand';

import { log } from '@/lib/log';

export type Reachability = 'unknown' | 'reachable' | 'unreachable';

export interface ReachabilityState {
  status: Reachability;
  /** When the current status was established. */
  since?: number;
  /** The failure's own wording, for the banner. Cleared when reachable. */
  detail?: string;
  /** Which base URL the evidence is about, so the banner can name it. */
  baseUrl?: string;
  /** How many consecutive failures — one flaky request is not an outage. */
  failures: number;

  markReachable(): void;
  markUnreachable(detail: string, baseUrl?: string): void;
}

export const useReachability = create<ReachabilityState>()((set) => ({
  status: 'unknown',
  failures: 0,

  markReachable() {
    set((state) => {
      if (state.status === 'reachable') return state;
      if (state.status === 'unreachable') {
        log.info('gateway', 'Gateway reachable again.');
      }
      return { status: 'reachable', since: Date.now(), failures: 0, detail: undefined, baseUrl: undefined };
    });
  },

  markUnreachable(detail, baseUrl) {
    set((state) => ({
      status: 'unreachable',
      // The clock is not restarted by a second failure: "unreachable for 4 minutes"
      // is the useful number, and each retry resetting it to zero would hide it.
      since: state.status === 'unreachable' ? (state.since ?? Date.now()) : Date.now(),
      failures: state.failures + 1,
      detail,
      ...(baseUrl !== undefined ? { baseUrl } : {}),
    }));
  },
}));

/** True while the last piece of evidence says the gateway could not be reached. */
export function isUnreachable(): boolean {
  return useReachability.getState().status === 'unreachable';
}
