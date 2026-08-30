/**
 * Where a cold launch should land.
 *
 * The app opens on a chat rather than on the list, which raises one question the
 * list never had to answer: does every launch create a conversation? It must not
 * — an app opened and closed twice a day for a fortnight would leave thirty empty
 * rows in the history it is meant to be showing. So a launch reuses the newest
 * conversation that has no messages in it, and only starts one when there is
 * nothing to reuse.
 *
 * `messageCount` is only populated by the list query, so an entry without it is
 * treated as non-empty: reusing a conversation whose size is unknown is how you
 * land in someone's transcript instead of a blank one.
 */

import type { Conversation } from '@/db/conversations';

/**
 * The id of the conversation a launch should open, or `undefined` to start one.
 *
 * Archived rows are skipped even if the caller passed some in — the archive is
 * where things go to stop being the thing you land on.
 */
export function launchTarget(conversations: readonly Conversation[]): string | undefined {
  let best: Conversation | undefined;
  for (const conversation of conversations) {
    if (conversation.archived || conversation.messageCount !== 0) continue;
    if (!best || conversation.updatedAt > best.updatedAt) best = conversation;
  }
  return best?.id;
}
