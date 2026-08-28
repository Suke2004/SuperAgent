/**
 * The conversation list's local filter and grouping.
 *
 * Split out of the screen because `jest.config.js` matches `.ts` only, so logic
 * that lives in a component is logic with no tests. The rule that follows from
 * that is: anything here is a pure function of its arguments, and the screen keeps
 * the hooks.
 *
 * There are two different searches in the list screen and they are not the same
 * thing. This module is the instant one: it filters the conversations already in
 * memory, on every keystroke, over the fields the row actually displays. The other
 * runs {@link searchMessages} against SQLite for full-text hits inside message
 * bodies, is debounced, and renders as a separate section. Keeping them separate is
 * what makes each explicable — a row appearing under the first is always visibly
 * justified by its own title, preview, tags or model.
 */

import type { Conversation } from '@/db/conversations';
import { highlightTerms } from '@/db/search';
import { BUCKET_LABEL, whenBucket } from '@/lib/when';
import type { WhenBucket } from '@/lib/when';

export const PINNED_LABEL = 'Pinned';

/**
 * The timestamp a row is sorted and grouped by.
 *
 * `updatedAt`, not `lastMessageAt`: it is what the database's `ORDER BY` uses, and
 * a list whose headings disagreed with its order would put yesterday's heading
 * above today's row. It also answers the question a user is really asking of this
 * screen — when did I last touch this — which a rename or a config change counts
 * towards as much as a message does.
 */
export function rowTime(conversation: Conversation): number {
  return conversation.updatedAt;
}

/** Everything about a conversation the row puts on screen, lowercased. */
function haystack(conversation: Conversation): string {
  return [conversation.title, conversation.preview ?? '', conversation.model, ...conversation.tags]
    .join('\n')
    .toLowerCase();
}

/**
 * Whether a conversation survives the filter box.
 *
 * Terms are ANDed and quoted phrases are honoured, matching how the full-text pass
 * treats the same input — one query string should not mean two different things
 * depending on which section you read the answer in.
 */
export function matchesQuery(conversation: Conversation, query: string): boolean {
  const needles = highlightTerms(query);
  if (needles.length === 0) return true;
  const text = haystack(conversation);
  return needles.every((needle) => text.includes(needle.toLowerCase()));
}

export interface FilterOptions {
  query?: string;
  tag?: string;
}

/**
 * Applies the filter box and the tag chip.
 *
 * Tag matching is exact and case-insensitive rather than substring: the tag came
 * from a chip the user tapped, so a near-miss is a bug, not a search.
 */
export function filterConversations(
  conversations: readonly Conversation[],
  options: FilterOptions = {},
): Conversation[] {
  const query = options.query?.trim() ?? '';
  const tag = options.tag?.trim().toLowerCase() ?? '';
  if (!query && !tag) return [...conversations];

  return conversations.filter((conversation) => {
    if (tag && !conversation.tags.some((value) => value.toLowerCase() === tag)) return false;
    if (query && !matchesQuery(conversation, query)) return false;
    return true;
  });
}

export type ListRow =
  | { kind: 'header'; key: string; label: string; count: number }
  | { kind: 'conversation'; key: string; conversation: Conversation };

const BUCKET_ORDER: readonly WhenBucket[] = ['today', 'yesterday', 'week', 'older'];

/**
 * Conversations and their group headings, flattened for a virtualised list.
 *
 * FlashList takes one array, so the headings are rows. They carry a count because
 * a heading that says "Older" is decoration and one that says "Older · 34" is
 * information.
 *
 * Grouping is a stable partition rather than a header-on-change scan, so input
 * that is not perfectly sorted produces one heading per group instead of the same
 * heading repeated down the screen. Pinned conversations are their own group
 * regardless of age — that is what pinning is for.
 */
export function buildRows(conversations: readonly Conversation[], now: number): ListRow[] {
  const pinned: Conversation[] = [];
  const groups = new Map<WhenBucket, Conversation[]>();

  for (const conversation of conversations) {
    if (conversation.pinned) {
      pinned.push(conversation);
      continue;
    }
    const bucket = whenBucket(rowTime(conversation), now);
    const group = groups.get(bucket);
    if (group) group.push(conversation);
    else groups.set(bucket, [conversation]);
  }

  const rows: ListRow[] = [];

  const emit = (key: string, label: string, items: readonly Conversation[]) => {
    if (items.length === 0) return;
    rows.push({ kind: 'header', key: `header:${key}`, label, count: items.length });
    for (const conversation of items) {
      rows.push({ kind: 'conversation', key: `conv:${conversation.id}`, conversation });
    }
  };

  emit('pinned', PINNED_LABEL, pinned);
  for (const bucket of BUCKET_ORDER) emit(bucket, BUCKET_LABEL[bucket], groups.get(bucket) ?? []);

  return rows;
}

/**
 * Tag counts for the filter chips, most used first then alphabetical.
 *
 * Derived from the loaded conversations rather than from {@link allTags} so the
 * chips only ever offer a tag that is present in what is on screen — offering one
 * that filters to nothing is worse than not offering it.
 */
export function tagCounts(conversations: readonly Conversation[]): { tag: string; count: number }[] {
  const counts = new Map<string, number>();
  for (const conversation of conversations) {
    for (const tag of conversation.tags) {
      counts.set(tag, (counts.get(tag) ?? 0) + 1);
    }
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count || a.tag.localeCompare(b.tag));
}

/**
 * Splits a comma-separated tag input into clean tags.
 *
 * Deduplicated case-insensitively but stored as typed: `Work` and `work` are the
 * same tag, and the one the user typed first is the spelling they get.
 */
export function parseTags(raw: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of raw.split(',')) {
    const tag = part.trim().replace(/\s+/g, ' ');
    if (!tag) continue;
    const key = tag.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tag);
  }
  return out;
}
