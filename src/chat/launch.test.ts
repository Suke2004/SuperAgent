import { launchTarget, linkedPrompt } from '@/chat/launch';
import type { Conversation } from '@/db/conversations';

function conversation(patch: Partial<Conversation> & { id: string }): Conversation {
  return {
    title: 'Untitled',
    createdAt: 0,
    updatedAt: 0,
    pinned: false,
    archived: false,
    profileId: 'p1',
    model: 'm',
    config: {},
    tags: [],
    ...patch,
  };
}

describe('launchTarget', () => {
  it('starts a new conversation when there are none', () => {
    expect(launchTarget([])).toBeUndefined();
  });

  it('reuses the newest empty conversation', () => {
    const target = launchTarget([
      conversation({ id: 'old', messageCount: 0, updatedAt: 100 }),
      conversation({ id: 'new', messageCount: 0, updatedAt: 200 }),
    ]);
    expect(target).toBe('new');
  });

  it('never lands in a conversation that has messages', () => {
    expect(launchTarget([conversation({ id: 'a', messageCount: 3, updatedAt: 500 })])).toBeUndefined();
  });

  it('treats an unknown message count as non-empty', () => {
    // `messageCount` is only populated by the list query. Reusing a row whose size
    // is unknown is how a launch lands in an existing transcript.
    expect(launchTarget([conversation({ id: 'a', updatedAt: 500 })])).toBeUndefined();
  });

  it('skips the archive', () => {
    expect(launchTarget([conversation({ id: 'a', messageCount: 0, archived: true })])).toBeUndefined();
  });

  it('prefers an empty row over a newer non-empty one', () => {
    const target = launchTarget([
      conversation({ id: 'busy', messageCount: 12, updatedAt: 900 }),
      conversation({ id: 'blank', messageCount: 0, updatedAt: 100 }),
    ]);
    expect(target).toBe('blank');
  });
});

describe('linkedPrompt', () => {
  it('takes the text a link carries', () => {
    expect(linkedPrompt('Summarise this page')).toBe('Summarise this page');
    expect(linkedPrompt(undefined)).toBe('');
  });

  it('accepts the shapes a URL can actually produce', () => {
    // `?q=a&q=b` arrives as an array, and a router that hands one over unguarded is a
    // `.replace` on a non-string away from a crash on the launch path.
    expect(linkedPrompt(['one', 'two'])).toBe('one two');
    expect(linkedPrompt('  padded  ')).toBe('padded');
    expect(linkedPrompt('two\r\nlines')).toBe('two\nlines');
  });

  it('caps the length rather than refusing the link', () => {
    expect(linkedPrompt('x'.repeat(9000))).toHaveLength(4000);
  });
});
