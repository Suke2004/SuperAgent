/**
 * The projection from stored blocks to searchable text.
 *
 * Split out of `conversations.ts` for one reason: that module imports
 * `expo-sqlite` at the top level, so nothing in it can be unit-tested under Jest's
 * node environment — and this is the part of it most worth testing. The
 * block→text mapping is a contract (`docs/05_Data_Model.md` §8.3): the FTS index,
 * the list preview, the title derivation and the memory extractor all read the
 * same string, so a block kind flattened wrongly here is wrong in four places at
 * once, silently.
 *
 * `conversations.ts` re-exports all three names, so no caller had to change.
 */

import type { ContentBlock } from '@/transports/types';

/**
 * The searchable, previewable text of a block list.
 *
 * Thinking is excluded: searching your own history for a phrase and landing on
 * the model's scratchpad rather than its answer is noise, and the reasoning pane
 * is collapsed by default anyway. Images contribute a marker so a conversation
 * can be found by the fact that it had one.
 *
 * A document contributes its *name* before its text, and its name even when no
 * text could be read — searching for `invoice-2026.pdf` has to find the message it
 * was attached to, which is the only handle a user has on a PDF whose contents
 * live in base64 the app cannot read.
 */
export function flattenContent(blocks: readonly ContentBlock[]): string {
  const parts: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        parts.push(block.text);
        break;
      case 'document':
        if (block.name) parts.push(block.name);
        if (block.text) parts.push(block.text);
        break;
      case 'image':
        parts.push('[image]');
        break;
      case 'tool_use':
        parts.push(`[tool ${block.name}]`);
        break;
      case 'tool_result':
        parts.push(block.content);
        break;
      case 'thinking':
        break;
    }
  }
  return parts.join('\n\n').trim();
}

/**
 * True for the synthetic `user` message that carries nothing but tool results.
 *
 * A skill body comes back as a `tool_result`, and {@link flattenContent} projects a
 * result's content into `messages.text` — correct for search, wrong for the
 * conversation list, where it would replace the preview with the first line of an
 * instruction file the user never wrote. Three places need the same answer: the
 * insert (which passes `''` to skip the preview update), the store's optimistic
 * patch, and the transcript, which renders these turns as tool output rather than
 * as something the user said. One predicate, so they cannot drift.
 */
export function isToolTurn(blocks: readonly ContentBlock[]): boolean {
  return blocks.length > 0 && blocks.every((block) => block.type === 'tool_result');
}

/** Longest preview a list row can show before the ellipsis is cheaper. */
const PREVIEW_CHARS = 160;

/**
 * First non-empty line, trimmed to fit a list row.
 *
 * Exported because the chat store patches the same column optimistically while a
 * turn lands, and it has to produce the *same* string the database will hold.
 * Writing the raw message text there instead was debt D-04: the row showed a
 * whole paragraph — or a markdown heading's `#` — until the next relaunch swapped
 * it for the stored one-liner, which reads as a rendering glitch.
 */
export function previewOf(text: string): string {
  const line = text
    .split('\n')
    .map((l) => l.replace(/^#+\s*/, '').trim())
    .find((l) => l.length > 0);
  if (!line) return '';
  return line.length > PREVIEW_CHARS ? `${line.slice(0, PREVIEW_CHARS - 1)}…` : line;
}

/**
 * The title a conversation gets before its first message.
 *
 * Exported because the chat store checks against it to decide whether a title is
 * still automatic and therefore safe to overwrite with a derived one.
 */
export const DEFAULT_TITLE = 'New conversation';
