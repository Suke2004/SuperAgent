/**
 * The rolling summary's arithmetic and prompt, kept out of the store so it can be
 * tested without SQLite.
 *
 * One thing here is load-bearing rather than tidy: a summary that grows by a
 * paragraph every time it is extended eventually costs more than the turns it
 * replaced, and it is charged as input on every remaining turn of the
 * conversation. The termination guarantee is `boundSummary`, not the model's
 * cooperation — the instruction asks for a budget, and the budget is then
 * enforced on what comes back, so `summarise` cannot grow without bound however
 * chatty the model is.
 */

import { SUMMARY_INSTRUCTION } from '@/chat/request';

/**
 * Ceiling on the stored summary, in characters (~1.1k tokens at 3.8 chars/token).
 *
 * Chosen against the same budget long-term memory uses (1,600 chars): both go
 * into every request's prefix, and between them they should not be the reason a
 * conversation runs out of window.
 */
export const SUMMARY_CHAR_BUDGET = 2_000;

/**
 * At what fraction of the budget the next extension is asked to recompress
 * rather than append. Below it, extending is cheaper and keeps more detail.
 */
const RECOMPRESS_AT = 0.75;

/** True when the existing summary is close enough to the ceiling to need rewriting. */
export function needsRecompression(previous: string | undefined): boolean {
  return (previous?.length ?? 0) >= SUMMARY_CHAR_BUDGET * RECOMPRESS_AT;
}

/**
 * Cuts an over-long summary at a paragraph, then a sentence, then a word.
 *
 * The end is what goes, not the middle: unlike a document, a summary's tail is
 * the oldest material — it has already been compressed once and the turns it
 * came from are further from the current one. The marker is explicit because the
 * text goes into a system prompt, and a model handed a sentence that stops
 * mid-clause will try to finish it.
 */
export function boundSummary(text: string, budget = SUMMARY_CHAR_BUDGET): string {
  const trimmed = text.trim();
  if (trimmed.length <= budget) return trimmed;

  const marker = '\n\n[Older notes dropped to stay within the summary budget.]';
  const room = Math.max(0, budget - marker.length);
  const head = trimmed.slice(0, room);
  const cut = Math.max(head.lastIndexOf('\n\n'), head.lastIndexOf('. '), head.lastIndexOf(' '));
  return `${(cut > room * 0.5 ? head.slice(0, cut) : head).trimEnd()}${marker}`;
}

/**
 * The user-message body for one summarisation call.
 *
 * Extending states the existing notes first so the model has somewhere to merge
 * into; recompressing says so explicitly and repeats the budget, because "merge
 * these" and "make this smaller" produce very different output from the same
 * transcript.
 */
export function summaryRequestBody(previous: string | undefined, transcript: string): string {
  const budget = `Keep the result under ${SUMMARY_CHAR_BUDGET} characters.`;
  if (!previous) return `${transcript}\n\n${SUMMARY_INSTRUCTION} ${budget}`;
  const merge = needsRecompression(previous)
    ? 'The existing notes are near their size limit: rewrite them together with the new turns into one ' +
      'shorter set of notes, dropping the least useful details rather than appending.'
    : 'Merge the existing notes with the new turns into one set of notes.';
  return (
    `Existing notes:\n\n${previous}\n\nNewly removed turns:\n\n${transcript}\n\n` +
    `${SUMMARY_INSTRUCTION} ${merge} ${budget}`
  );
}

/**
 * The one sentence a failed summarisation owes the user.
 *
 * The turn still sends — losing the summary is much better than losing the
 * message — but silence here means the next reply forgets things for a reason
 * nothing on screen explains.
 */
export const SUMMARY_FAILED_NOTE =
  'Older turns could not be summarised, so this reply was sent without notes about them.';
