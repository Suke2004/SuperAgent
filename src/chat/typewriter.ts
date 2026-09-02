/**
 * How fast to hand a streamed reply to the screen.
 *
 * ## The problem this solves
 *
 * A gateway does not deliver a reply one character at a time. It delivers whatever
 * arrived in the last socket read, which on a fast connection is a paragraph at once
 * and on a slow one is a word every few hundred milliseconds. Rendered straight
 * through, the reply lands in slabs — and a slab is the one thing that reads as *the
 * app stalled and then caught up*, even when nothing stalled at all.
 *
 * So the buffer and the screen are separated. Text accumulates in the store as fast as
 * it arrives; this decides how much of it is visible on each frame. The result is a
 * steady cadence out of a lumpy input, which is what makes a reply feel like it is
 * being written rather than pasted.
 *
 * ## Why it chases rather than paces
 *
 * The obvious implementation is a fixed characters-per-second, and it is wrong in both
 * directions: too slow and it falls minutes behind a long reply, too fast and it is
 * back to rendering slabs. This one reveals a *fraction of the backlog* per tick
 * instead, which is self-correcting — the further behind it is, the faster it goes, and
 * it settles at whatever rate the model is actually writing at without being told.
 *
 * Pure and separate from the component so the pacing can be tested without a device.
 * The hook around it is four lines in `StreamView`.
 */

/** How often to reveal, in ms. Two frames at 60fps — a cadence, not a per-frame crawl. */
export const TYPEWRITER_MS = 33;

/**
 * The backlog is divided by this to get one tick's step.
 *
 * Sets how tightly the screen chases the buffer. At 8, a reply arriving at a typical
 * 120 characters a second settles about 30 characters — a quarter of a second — behind,
 * which is close enough to feel live and loose enough to smooth every chunk boundary.
 * Lower is jumpier, higher is laggier.
 */
export const TYPEWRITER_LEAD = 8;

/**
 * Backlog past which it stops chasing and simply shows everything, in characters.
 *
 * The chase is for making a stream readable, not for animating a paste. A single chunk
 * this large is a summarised history landing at once, a cached completion, or a
 * reconnect replaying what was missed — and typing 2,000 characters out at a readable
 * pace would take half a minute while the user waits for text the app already has.
 */
export const TYPEWRITER_MAX_LAG = 400;

/**
 * How many characters should be visible after one tick.
 *
 * @param shown How many are visible now.
 * @param total How many the buffer holds.
 * @returns The new visible count. Never decreases unless the buffer itself shrank,
 *   which happens when a turn is retried and the text is replaced from empty.
 */
export function revealStep(shown: number, total: number): number {
  // Caught up, or the buffer was replaced by something shorter. Either way the screen
  // should be showing exactly what there is — there is nothing to reveal towards.
  if (total <= shown) return total;

  const backlog = total - shown;
  if (backlog > TYPEWRITER_MAX_LAG) return total;

  // At least one character, or a backlog under `TYPEWRITER_LEAD` would round to zero
  // and the last few characters of every reply would never arrive.
  return shown + Math.max(1, Math.ceil(backlog / TYPEWRITER_LEAD));
}
