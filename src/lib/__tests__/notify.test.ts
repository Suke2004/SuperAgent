/**
 * What the app says when a turn ends, and — more importantly — when it says nothing.
 *
 * A notification for a reply the user is already looking at, or for a turn they
 * cancelled themselves, is the kind of thing that gets an app's notifications turned
 * off for good. Those two cases and the empty-turn case are the whole point of
 * `replyNotice` being a separate, testable function. `replyAnnouncement` is its mirror
 * for a screen reader, and the pair has one property worth a test of its own: exactly
 * one of them speaks for any given turn.
 */

import { replyAnnouncement, replyNotice, tappedConversation } from '@/lib/notify';

jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationChannelAsync: jest.fn(),
  getPermissionsAsync: jest.fn(),
  requestPermissionsAsync: jest.fn(),
  scheduleNotificationAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getLastNotificationResponseAsync: jest.fn(async () => null),
  AndroidImportance: { DEFAULT: 3 },
}));

jest.mock('react-native', () => ({
  AccessibilityInfo: { announceForAccessibility: jest.fn() },
  AppState: { currentState: 'background' },
  Platform: { OS: 'android' },
}));

const base = { title: 'Cache design', text: 'Use a write-through cache.', foreground: false };

describe('replyNotice', () => {
  test('announces a finished reply, titled by its conversation', () => {
    expect(replyNotice(base)).toEqual({ title: 'Cache design', body: 'Use a write-through cache.' });
  });

  test('says nothing the user does not need told', () => {
    // Watching it arrive is better than being told it arrived.
    expect(replyNotice({ ...base, foreground: true })).toBeNull();
    // They pressed stop.
    expect(replyNotice({ ...base, stopReason: 'aborted' })).toBeNull();
    // A turn that produced nothing has its failure in the transcript already.
    expect(replyNotice({ ...base, text: '   ' })).toBeNull();
  });

  test('collapses whitespace and truncates, so the banner is one readable line', () => {
    const notice = replyNotice({ ...base, text: `line\n\n  line\t${'x'.repeat(200)}` });
    expect(notice?.body.startsWith('line line x')).toBe(true);
    expect(notice?.body.endsWith('…')).toBe(true);
    expect(notice?.body.length).toBeLessThanOrEqual(110);
  });

  test('an unnamed conversation still gets a title', () => {
    expect(replyNotice({ ...base, title: '  ' })?.title).toBeTruthy();
  });
});

describe('replyAnnouncement', () => {
  test('says how much arrived, not what it says', () => {
    expect(replyAnnouncement({ ...base, foreground: true })).toBe('Reply ready, 4 words');
    // Singular, because "1 words" in a synthesised voice is worse than in print.
    expect(replyAnnouncement({ ...base, foreground: true, text: 'Yes.' })).toBe('Reply ready, 1 word');
  });

  test('stays silent for the turns it must not interrupt for', () => {
    // Backgrounded is the notification's job, and TalkBack drops it anyway.
    expect(replyAnnouncement(base)).toBeNull();
    // They pressed stop.
    expect(replyAnnouncement({ ...base, foreground: true, stopReason: 'aborted' })).toBeNull();
    // Nothing arrived; the transcript's error row is focusable and more useful.
    expect(replyAnnouncement({ ...base, foreground: true, text: ' \n\t ' })).toBeNull();
  });

  test('exactly one of the two speaks for any turn', () => {
    // The invariant the pair exists to hold: `foreground` decides which, and neither
    // case is left with nothing said or with both said at once.
    for (const foreground of [true, false]) {
      const said = [replyNotice({ ...base, foreground }), replyAnnouncement({ ...base, foreground })];
      expect(said.filter(Boolean)).toHaveLength(1);
    }
  });
});

describe('tappedConversation', () => {
  test('reads the id a tap carries, and refuses anything else', () => {
    const tap = (data: unknown) =>
      tappedConversation({ notification: { request: { content: { data } } } } as never);
    expect(tap({ conversationId: 'c1' })).toBe('c1');
    // Notification payloads are data, not promises: a missing or wrong-typed id must
    // not become a route to `/chat/undefined`.
    expect(tap({ conversationId: 42 })).toBeNull();
    expect(tap({})).toBeNull();
    expect(tap(null)).toBeNull();
  });
});
