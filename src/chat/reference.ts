/**
 * Pulling one message out of another conversation and into this draft.
 *
 * Memories are already shared across conversations; message *content* was not.
 * Answering "what did I decide about this last week" meant leaving the chat,
 * searching the list, copying a reply, coming back and pasting it — five steps
 * during which the draft you were writing is still sitting there half-finished.
 *
 * The quote goes into the draft rather than straight into the request, and it goes
 * in as visible text. Two reasons: the composer's context gauge counts the draft,
 * so an eight-thousand-token reply pulled in from elsewhere shows up on the gauge
 * before it is sent rather than after; and hidden context the user cannot see or
 * edit is the version of this feature where a conversation is silently steered by
 * something quoted three days ago.
 */

/** Past this, a quote is a transcript. Trimmed with a marker rather than refused. */
export const QUOTE_CHAR_LIMIT = 4_000;

/** How a role is named in the attribution line, in the user's own terms. */
function speaker(role: string): string {
  if (role === 'user') return 'you';
  if (role === 'assistant') return 'the assistant';
  return role;
}

/**
 * A markdown blockquote of one message, attributed to the conversation it is from.
 *
 * The attribution is inside the quote, not above it: the model reads this as one
 * block, and "from another conversation" is the part that stops it being treated
 * as something said here.
 */
export function quoteMessage(
  input: { title: string; role: string; text: string },
  limit: number = QUOTE_CHAR_LIMIT,
): string {
  const trimmed = input.text.trim();
  const kept = cut(trimmed, Math.max(1, limit));
  const body = kept.length < trimmed.length ? `${kept}\n\n[Trimmed here — the rest is in “${input.title}”.]` : kept;
  const quoted = body
    .split('\n')
    .map((line) => (line.length ? `> ${line}` : '>'))
    .join('\n');
  return `> From “${input.title}” (${speaker(input.role)}):\n${quoted}`;
}

/** Cuts at a word boundary if there is one within reach, rather than mid-word. */
function cut(text: string, limit: number): string {
  if (text.length <= limit) return text;
  const head = text.slice(0, limit);
  const space = head.lastIndexOf(' ');
  return (space > limit * 0.6 ? head.slice(0, space) : head).trimEnd();
}

/**
 * Puts a quote into a draft without eating what was already typed.
 *
 * The quote goes above the existing text and ends with a blank line, so the
 * caret's next character starts the sentence that responds to it — which is the
 * order these are written in: quote first, question second.
 */
export function appendQuote(draft: string, quote: string): string {
  const existing = draft.trim();
  return existing ? `${quote}\n\n${existing}` : `${quote}\n\n`;
}
