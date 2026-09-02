/**
 * The camera's arithmetic and its wording.
 *
 * Two properties carry this module, and they are the two tested hardest:
 *
 *  - **The room a session has counts the shots the session has already taken.** Everything
 *    else about the camera is recoverable; a viewfinder that lets you take eight photos
 *    into a composer with seven slots throws one away at the moment the user is least able
 *    to do anything about it. See {@link canShoot}.
 *  - **A flash mode is only ever one the hardware has.** There is no lamp on the front of
 *    a phone, so both the cycle and the flip have to agree about that independently — the
 *    cycle because it must not offer `on`, and the flip because it must not carry an `on`
 *    that was set on the other side. See {@link nextFlash} and {@link flashFor}.
 */

import {
  MAX_ATTACHMENTS_PER_CONVERSATION,
  MAX_ATTACHMENTS_PER_MESSAGE,
  imageBlock,
} from '@/chat/attachments';
import type { ContentBlock } from '@/transports/types';

import {
  canShoot,
  describeSession,
  discardable,
  flashFor,
  flashLabel,
  nextFlash,
  shotName,
  shotsLeft,
  type Flash,
  type Shot,
} from './camera';

const image = (): ContentBlock => imageBlock('image/jpeg', 'x'.repeat(64));

const staged = (n: number): ContentBlock[] => Array.from({ length: n }, image);

const shot = (n: number): Shot => ({
  uri: `file:///cache/Camera/shot-${n}.jpg`,
  width: 3024,
  height: 4032,
  fileName: shotName(n),
});

describe('nextFlash', () => {
  it('cycles the back camera through the three modes it has', () => {
    expect(nextFlash('off', 'back')).toBe('auto');
    expect(nextFlash('auto', 'back')).toBe('on');
  });

  it('wraps, so one button is enough to get back', () => {
    expect(nextFlash('on', 'back')).toBe('off');
    expect(nextFlash('screen', 'front')).toBe('off');
  });

  it('offers the front camera only the screen, never the lamp it does not have', () => {
    expect(nextFlash('off', 'front')).toBe('screen');
    // Two presses on the front camera return to where they started. `auto` and `on` are
    // never reachable from here, which is the whole point of a per-facing cycle.
    expect(nextFlash(nextFlash('off', 'front'), 'front')).toBe('off');
  });

  it('restarts rather than throwing when the mode is not in this side of the cycle', () => {
    // Reached by flipping to the front while `on` is set. The answer is `off`, not a crash.
    expect(nextFlash('on', 'front')).toBe('off');
    expect(nextFlash('auto', 'front')).toBe('off');
    expect(nextFlash('screen', 'back')).toBe('off');
  });
});

describe('flashFor', () => {
  it('keeps a mode the new side supports', () => {
    expect(flashFor('off', 'front')).toBe('off');
    expect(flashFor('auto', 'back')).toBe('auto');
    expect(flashFor('screen', 'front')).toBe('screen');
  });

  it('drops a mode the new side has no hardware for', () => {
    expect(flashFor('on', 'front')).toBe('off');
    expect(flashFor('auto', 'front')).toBe('off');
    expect(flashFor('screen', 'back')).toBe('off');
  });

  it('does not restore the old mode when the camera flips back', () => {
    // `on` → front → back is `off`, not `on`. Remembering it across a flip means the lamp
    // firing on a shot the user did not expect it to.
    const there = flashFor('on', 'front');
    expect(flashFor(there, 'back')).toBe('off');
  });
});

describe('flashLabel', () => {
  it('says which mode is set, for the button and for a screen reader', () => {
    const modes: Flash[] = ['off', 'auto', 'on', 'screen'];
    expect(modes.map(flashLabel)).toEqual(['Flash off', 'Flash automatic', 'Flash on', 'Screen flash']);
  });
});

describe('canShoot', () => {
  it('allows a shot into an empty composer', () => {
    expect(canShoot([], 0, 0)).toEqual({ ok: true });
  });

  it('counts the shots this session has taken, not only what is staged', () => {
    // The composer is empty, so `remainingSlots` alone would say yes eight times over.
    // Seven shots already taken means one slot left, and the eighth fills it.
    expect(canShoot([], 0, MAX_ATTACHMENTS_PER_MESSAGE - 1)).toEqual({ ok: true });

    const full = canShoot([], 0, MAX_ATTACHMENTS_PER_MESSAGE);
    if (full.ok) throw new Error('unreachable');
    expect(full.reason).toMatch(/as many photos as this message can carry/);
  });

  it('counts what is staged as well, so the two sources share one ceiling', () => {
    const admission = canShoot(staged(MAX_ATTACHMENTS_PER_MESSAGE - 2), 0, 2);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toMatch(/remove one/);
  });

  it('blames the chat, not the photos, when nothing has been taken yet', () => {
    // Distinct wording on purpose: "remove one to take another" is useless advice when
    // there is nothing in this session to remove.
    const admission = canShoot([], MAX_ATTACHMENTS_PER_CONVERSATION, 0);
    if (admission.ok) throw new Error('unreachable');
    expect(admission.reason).toMatch(/no room for another attachment/);
    expect(admission.reason).not.toMatch(/remove one/);
  });
});

describe('shotsLeft', () => {
  it('is the message allowance less what is staged and what is taken', () => {
    expect(shotsLeft([], 0, 0)).toBe(MAX_ATTACHMENTS_PER_MESSAGE);
    expect(shotsLeft(staged(3), 0, 2)).toBe(MAX_ATTACHMENTS_PER_MESSAGE - 5);
  });

  it('never goes negative, whichever ceiling is overshot', () => {
    expect(shotsLeft([], 0, MAX_ATTACHMENTS_PER_MESSAGE + 4)).toBe(0);
    expect(shotsLeft([], MAX_ATTACHMENTS_PER_CONVERSATION + 4, 0)).toBe(0);
  });

  it('falls to the conversation allowance when that is the smaller one', () => {
    expect(shotsLeft([], MAX_ATTACHMENTS_PER_CONVERSATION - 2, 0)).toBe(2);
  });
});

describe('describeSession', () => {
  it('tells a user with no photos what to do rather than counting nothing', () => {
    expect(describeSession(0, 8)).toBe('Point and press the shutter.');
  });

  it('says there is no room, when the shutter will not fire at all', () => {
    expect(describeSession(0, 0)).toBe('No room for another attachment.');
  });

  it('gives the count and the headroom together', () => {
    // The count alone does not answer the question a user has at the shutter, which is
    // whether they may take another.
    expect(describeSession(1, 7)).toBe('1 photo · room for 7 more');
    expect(describeSession(3, 5)).toBe('3 photos · room for 5 more');
  });

  it('says so when the last slot has just been used', () => {
    expect(describeSession(8, 0)).toBe('8 photos · that is the limit');
  });
});

describe('shotName', () => {
  it('numbers from the position the user saw', () => {
    // One-based, because the name turns up in a refusal sentence about "the second photo".
    expect(shotName(0)).toBe('Photo 1');
    expect(shotName(3)).toBe('Photo 4');
  });
});

describe('discardable', () => {
  it('returns every shot, since each file was written into this app own cache', () => {
    expect(discardable([shot(0), shot(1)])).toEqual([
      'file:///cache/Camera/shot-0.jpg',
      'file:///cache/Camera/shot-1.jpg',
    ]);
  });

  it('is empty for an empty session, so cancelling early is not a special case', () => {
    expect(discardable([])).toEqual([]);
  });
});
