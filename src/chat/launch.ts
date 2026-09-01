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

/**
 * Longest prompt a `jarvis://new?q=…` link may carry.
 *
 * Generous enough for a pasted paragraph and far short of anything that would make the
 * composer unusable. Truncated rather than refused: a clipped prompt the user can see
 * and edit beats an error screen.
 */
const MAX_QUERY = 4000;

/**
 * The prompt a deep link asked for, out of whatever the URL actually contained.
 *
 * A URL is untrusted input — it can come from a web page, a QR code or another app —
 * and expo-router hands a repeated query parameter over as an array, so neither the
 * shape nor the size of `q` can be assumed. Carriage returns come out because a `\r`
 * pasted into a `TextInput` is an invisible character that changes what gets sent.
 */
export function linkedPrompt(value: string | readonly string[] | undefined): string {
  const raw = Array.isArray(value) ? value.join(' ') : ((value as string | undefined) ?? '');
  return raw.replace(/\r/g, '').trim().slice(0, MAX_QUERY);
}
