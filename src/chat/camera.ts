/**
 * The in-app camera's decisions, with no camera in them.
 *
 * `src/components/chat/CameraMode.tsx` owns the viewfinder and `src/chat/attach.ts` owns
 * the encoder; this module owns the arithmetic and the wording between them, for the same
 * reason `voice.ts` sits behind `VoiceMode.tsx` — the suite runs under
 * `testEnvironment: 'node'`, so anything that imports `expo-camera` can never be tested.
 *
 * ## Why a session holds URIs and not images
 *
 * A shot is kept as a file path until the user is done, and every one of them is encoded
 * in a single pass on the way out. The alternative — encode on each shutter press — reads
 * as the obvious design and is the one that crashes: `attach.ts` goes to some trouble to
 * keep exactly one bitmap in memory at a time, and a viewfinder that lets you press the
 * shutter again during an encode defeats that by construction. Holding paths costs
 * nothing, makes *retake* a splice rather than an undo, and means the wait happens once,
 * where the user has already decided to leave.
 *
 * The consequence to know about: **an abandoned session leaves files in the cache**, so
 * cancelling has to delete them explicitly. {@link discardable} is what says which.
 *
 * ## Why the flash cycle depends on which way the camera faces
 *
 * There is no lamp on the front of a phone. `expo-camera` offers `screen` for that case,
 * which lights the display instead, and offering `auto`/`on` on the selfie camera would
 * be two settings that do nothing. So the cycle is `off → auto → on` on the back and
 * `off → screen` on the front, and switching sides has to re-validate the mode rather
 * than carry it across — see {@link flashFor}.
 */

import { remainingSlots, type Admission } from '@/chat/attachments';
import type { ContentBlock } from '@/transports/types';

/**
 * One photograph, before it is anything a model could read.
 *
 * Deliberately the same shape `ingestAssets` takes from `expo-image-picker`, which is what
 * lets a camera shot go down the identical resize ladder as a gallery pick with no second
 * encoder to keep in step. `width`/`height` may be `0`: `planResize` has a blind case for
 * that and derives the ratio from the real bitmap.
 */
export interface Shot {
  uri: string;
  width: number;
  height: number;
  /** For the refusal sentence, if this one turns out to be unencodable. */
  fileName: string;
}

/** Which way the camera points. Mirrors `expo-camera`'s `CameraType`. */
export type Facing = 'back' | 'front';

/** Flash modes this app offers. A subset of `expo-camera`'s, minus the ones that lie. */
export type Flash = 'off' | 'auto' | 'on' | 'screen';

/** The cycle each side of the phone actually supports. */
const CYCLE: Record<Facing, readonly Flash[]> = {
  back: ['off', 'auto', 'on'],
  front: ['off', 'screen'],
};

/**
 * The next flash mode for this side of the phone.
 *
 * Wraps. A control that stops at the end of its range needs a second control to get back,
 * and there are three modes.
 */
export function nextFlash(current: Flash, facing: Facing): Flash {
  const cycle = CYCLE[facing];
  const at = cycle.indexOf(current);
  // An unknown mode restarts the cycle rather than throwing: this is reached by flipping
  // the camera while `on` is set, and the answer there is `off`, not a crash.
  return cycle[(at + 1) % cycle.length] ?? 'off';
}

/**
 * The mode to use after flipping the camera.
 *
 * `on` on the front camera is a setting with no hardware behind it, so it becomes `off`
 * rather than being silently sent to a driver that ignores it. Flipping back does **not**
 * restore what was set before — remembering a mode across a flip means the lamp firing on
 * a shot the user did not expect it to.
 */
export function flashFor(current: Flash, facing: Facing): Flash {
  return CYCLE[facing].includes(current) ? current : 'off';
}

/** What the flash button says it will do, for a label and for a screen reader. */
export function flashLabel(mode: Flash): string {
  return {
    off: 'Flash off',
    auto: 'Flash automatic',
    on: 'Flash on',
    screen: 'Screen flash',
  }[mode];
}

/**
 * Whether the shutter can fire again.
 *
 * The count that matters is `staged + shots`: what the composer already holds *plus* what
 * this session has taken and not handed over yet. Asking `remainingSlots` about the staged
 * blocks alone is the version of this function that lets a user take eight photos into a
 * composer with seven slots and then throws seven of them away at the end, which is the
 * worst possible moment to be told.
 *
 * `sent` is the conversation's own running total — see `MAX_ATTACHMENTS_PER_CONVERSATION`.
 */
export function canShoot(staged: readonly ContentBlock[], sent: number, shots: number): Admission {
  const room = remainingSlots(staged, sent) - shots;
  if (room > 0) return { ok: true };
  return {
    ok: false,
    reason: shots
      ? `That is as many photos as this message can carry. Use them, or remove one to take another.`
      : `This chat has no room for another attachment. Send what is staged first.`,
  };
}

/** How many more shots this session may take. Never negative. */
export function shotsLeft(staged: readonly ContentBlock[], sent: number, shots: number): number {
  return Math.max(0, remainingSlots(staged, sent) - shots);
}

/**
 * The one-line status under the viewfinder.
 *
 * Says the count and the headroom in the same breath, because "3 photos" alone does not
 * answer the only question a user has at the shutter, which is whether they may take
 * another. At zero it is an instruction instead — a count of nothing is noise.
 */
export function describeSession(shots: number, left: number): string {
  if (!shots) return left ? 'Point and press the shutter.' : 'No room for another attachment.';
  const taken = shots === 1 ? '1 photo' : `${shots} photos`;
  return left ? `${taken} · room for ${left} more` : `${taken} · that is the limit`;
}

/**
 * Names a shot for the refusal sentence it might need later.
 *
 * A camera gives no filename, and `ingestAssets` falls back to "One image", which is
 * unhelpful when four were taken and the second one is the problem. Numbered from the
 * shot's position at the time it was taken, so the name a user is told matches the
 * position they saw it in.
 */
export function shotName(index: number): string {
  return `Photo ${index + 1}`;
}

/**
 * The shots whose files this app is responsible for deleting.
 *
 * Every shot, always — `takePictureAsync` writes into this app's own cache directory, so
 * unlike a content URI from another app there is never a case where the file belongs to
 * someone else. The function exists rather than the caller mapping `.uri` because a
 * *retake* and a *cancel* need exactly the same rule, and a version of this that was only
 * called on cancel is how the cache fills up one discarded shot at a time.
 */
export function discardable(shots: readonly Shot[]): readonly string[] {
  return shots.map((shot) => shot.uri);
}
