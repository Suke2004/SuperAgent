/**
 * The offline queue's ordering rules.
 *
 * Worth a test because all three are easy to get wrong and invisible when wrong: a
 * conversation queued twice sends twice, a flush that ignores `retrying` sends twice,
 * and a flush that keeps going while the gateway is still down burns one request per
 * queued conversation to learn what the first one already proved.
 */

let mockUnreachable = false;
// The store's only React Native import is `AppState`, and only `startSendQueue` uses
// it; stubbing it keeps this suite in the node environment where the rest live.
jest.mock('react-native', () => ({
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
}));
jest.mock('@/stores/reachability', () => ({
  isUnreachable: () => mockUnreachable,
  useReachability: { subscribe: jest.fn(), getState: () => ({ status: 'unknown' }) },
}));
jest.mock('@/lib/verify', () => ({ verifyProfile: jest.fn() }));
// Only the foreground probe reads it, and it pulls the Keystore in behind it.
jest.mock('@/stores/providers', () => ({ useProviders: { getState: () => ({ activeId: 'p1' }) } }));

import { useSendQueue } from './queue';

beforeEach(() => {
  mockUnreachable = false;
  useSendQueue.setState({ ids: [], retrying: false });
});

test('a conversation is queued once, however many turns fail', () => {
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c2');
  expect(useSendQueue.getState().ids).toEqual(['c1', 'c2']);
});

test('dropping is how a manual retry or a dismissal leaves the queue', () => {
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c2');
  useSendQueue.getState().drop('c1');
  expect(useSendQueue.getState().ids).toEqual(['c2']);
});

test('a flush retries each queued conversation once, in order, and empties the queue', async () => {
  const seen: string[] = [];
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c2');

  const sent = await useSendQueue.getState().flush(async (id) => {
    seen.push(id);
  });

  expect(seen).toEqual(['c1', 'c2']);
  expect(sent).toBe(2);
  expect(useSendQueue.getState().ids).toEqual([]);
});

test('a flush stops at the first sign the gateway is still down, keeping the rest', async () => {
  const seen: string[] = [];
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c2');
  useSendQueue.getState().queue('c3');

  await useSendQueue.getState().flush(async (id) => {
    seen.push(id);
    // What a network failure does in the real store, minus the store.
    mockUnreachable = true;
    useSendQueue.getState().queue(id);
  });

  expect(seen).toEqual(['c1']);
  expect(useSendQueue.getState().ids).toEqual(['c1', 'c2', 'c3']);
});

test('a retry that throws does not abandon the rest of the queue', async () => {
  const seen: string[] = [];
  useSendQueue.getState().queue('c1');
  useSendQueue.getState().queue('c2');

  const sent = await useSendQueue.getState().flush(async (id) => {
    seen.push(id);
    if (id === 'c1') throw new Error('boom');
  });

  expect(seen).toEqual(['c1', 'c2']);
  expect(sent).toBe(1);
});

test('two triggers cannot flush at once', async () => {
  let calls = 0;
  useSendQueue.getState().queue('c1');

  const first = useSendQueue.getState().flush(async () => {
    calls += 1;
    await new Promise((resolve) => setTimeout(resolve, 5));
  });
  const second = await useSendQueue.getState().flush(async () => {
    calls += 1;
  });

  await first;
  expect(second).toBe(0);
  expect(calls).toBe(1);
});

test('an empty queue is a no-op', async () => {
  const retry = jest.fn();
  expect(await useSendQueue.getState().flush(retry)).toBe(0);
  expect(retry).not.toHaveBeenCalled();
});
