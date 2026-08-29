/**
 * Multi-select in the conversation list: what is selected, and what a bulk
 * action would actually do to it.
 *
 * Split out of the screen for the reason the rest of `src/chat/` is: Jest matches
 * `.ts` only, so logic living in a `.tsx` component is logic with no tests. What
 * ends up here is specifically the part that would be embarrassing to get wrong —
 * the sentences a destructive confirmation puts in front of someone.
 *
 * The design rule these functions exist to enforce: **a bulk confirmation must
 * describe the selection, not the button.** "Delete 12 conversations?" is a
 * description of the button. "Delete 12 conversations and 431 messages? 3 are
 * pinned" is a description of what is about to be destroyed, and it is the only
 * version that gives someone a chance to notice they selected a thread they
 * meant to keep. Every count below is here to be said out loud in a dialog.
 */

import type { Conversation } from '@/db/conversations';

/**
 * Toggling one row, returned as a new set.
 *
 * A new `Set` rather than a mutation because React state is compared by
 * identity: mutating and re-setting the same set renders nothing.
 */
export function toggleSelected(selected: ReadonlySet<string>, id: string): Set<string> {
  const next = new Set(selected);
  if (!next.delete(id)) next.add(id);
  return next;
}

/**
 * Drops ids that are no longer on screen.
 *
 * Called after every list reload. Without it, archiving a selection leaves its
 * ids selected against rows that have left the list, and the next action would
 * be applied to invisible conversations — the specific bug where "Delete" hits
 * more than the user can see.
 */
export function pruneSelection(
  selected: ReadonlySet<string>,
  visible: readonly Conversation[],
): Set<string> {
  const present = new Set(visible.map((c) => c.id));
  const next = new Set<string>();
  for (const id of selected) if (present.has(id)) next.add(id);
  return next;
}

/** Selects everything currently visible; the "all" in "select all" is only ever the loaded page. */
export function selectAll(visible: readonly Conversation[]): Set<string> {
  return new Set(visible.map((c) => c.id));
}

/** What is in the selection, in the terms a confirmation dialog needs. */
export interface SelectionSummary {
  count: number;
  /** Total messages across the selection — the real cost of a delete. */
  messages: number;
  pinned: number;
  archived: number;
  /** Every tag carried by at least one selected conversation, alphabetically. */
  tags: string[];
  /** Titles, in list order, for the dialog to sample from. */
  titles: string[];
}

export function summariseSelection(
  selected: ReadonlySet<string>,
  visible: readonly Conversation[],
): SelectionSummary {
  const tags = new Set<string>();
  const titles: string[] = [];
  let count = 0;
  let messages = 0;
  let pinned = 0;
  let archived = 0;

  // Iterating `visible` rather than `selected` so the order is list order: the
  // titles a dialog samples then match what the user was just looking at, and a
  // `Set`'s insertion order would instead be the order they happened to tap.
  for (const conversation of visible) {
    if (!selected.has(conversation.id)) continue;
    count += 1;
    messages += conversation.messageCount ?? 0;
    if (conversation.pinned) pinned += 1;
    if (conversation.archived) archived += 1;
    for (const tag of conversation.tags) tags.add(tag);
    titles.push(conversation.title);
  }

  return { count, messages, pinned, archived, tags: [...tags].sort(), titles };
}

/** `1 conversation` / `12 conversations`. Used everywhere, wrong once is enough. */
export function plural(count: number, singular: string, pluralForm = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

/**
 * At most three titles, then "and N more".
 *
 * Three because a dialog that lists twelve titles is a dialog nobody reads, and
 * because on a phone the rest would be clipped by the OS anyway — which is worse
 * than truncating deliberately, since a clipped list gives no hint that it was
 * clipped.
 */
export function sampleTitles(titles: readonly string[], limit = 3): string {
  if (titles.length === 0) return '';
  const shown = titles.slice(0, limit).map((title) => `“${title}”`);
  const rest = titles.length - shown.length;
  if (rest > 0) shown.push(`and ${plural(rest, 'more', 'more')}`);
  return shown.join(', ');
}

/**
 * The body of the delete confirmation.
 *
 * Names the message count, because the number of *conversations* systematically
 * understates what is being destroyed — twelve rows can be four thousand
 * messages. Calls out pinned rows, because pinning is the signal the user
 * already gave that these matter. Offers archiving in the same breath, since
 * that is what "get these out of my list" usually means and it is reversible.
 */
export function describeDelete(summary: SelectionSummary): string {
  const parts = [
    `${plural(summary.count, 'conversation')} and ${plural(summary.messages, 'message')}.`,
  ];
  if (summary.pinned > 0) {
    parts.push(`${summary.pinned} of them ${summary.pinned === 1 ? 'is' : 'are'} pinned.`);
  }
  if (summary.titles.length) parts.push(sampleTitles(summary.titles) + '.');
  parts.push('This cannot be undone — archiving keeps them and takes them out of the list.');
  // Recorded spend is deliberately not deleted, and saying so pre-empts the
  // reasonable worry that tidying up the list falsifies the usage dashboard.
  parts.push('Usage history is kept: it records what was already spent.');
  return parts.join(' ');
}

/**
 * Whether archiving the selection would do anything, and how much.
 *
 * A selection can span both states — the archive is multi-selectable too — so
 * the button needs to know how many rows would actually move before it promises
 * a number. `changing` is what the label counts; `already` is why the two
 * differ.
 */
export function archiveEffect(
  summary: SelectionSummary,
  archived: boolean,
): { changing: number; already: number } {
  const already = archived ? summary.archived : summary.count - summary.archived;
  return { changing: summary.count - already, already };
}
