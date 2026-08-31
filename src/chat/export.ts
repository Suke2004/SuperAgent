/**
 * Conversation export: Markdown for a person, JSON for a program.
 *
 * A pure module, taking the conversation and its messages as arguments and
 * returning text. Nothing here touches SQLite, the clipboard or the share sheet,
 * which is what lets `export.test.ts` assert the one property that blocks the 1.0
 * gate: **the API key never appears in an exported conversation.** That test
 * greps the produced artefact rather than checking a call site, for the same
 * reason `src/lib/redact.test.ts` does — a new field added to the exporter has to
 * fail the test rather than ship.
 *
 * Three decisions that shape everything below.
 *
 * **Redaction happens twice, deliberately.** Every string is passed through
 * `redactString` as it is written, and the finished artefact is passed through it
 * again. The first pass is the boundary discipline the debug log uses; the second
 * is a net under it, because an export is a file a user mails to someone, and the
 * cost asymmetry between "one redundant string scan" and "a leaked key in an
 * email" is not close. The second pass is safe for JSON because the replacement
 * text contains no characters JSON escapes.
 *
 * **Attachment bytes are never exported.** An image or PDF block becomes a
 * one-line descriptor. Partly size — base64 turns a 3 MB photo into 4 MB of
 * unreadable text in the middle of a transcript — and partly that an export is
 * shared, and silently carrying the contents of every photo the user ever
 * attached into a file they meant as a transcript is a privacy decision nobody
 * asked to make.
 *
 * **Thinking is opt-in.** Extended-thinking text is the model's scratch work; it
 * frequently restates the user's private context in blunter terms than the reply
 * does, and it is not what "export this conversation" means. Available, off by
 * default, and labelled when included.
 */

import type { Conversation, StoredMessage } from '@/db/conversations';
import { APP_WIRE_NAME } from '@/lib/app';
import { redactString } from '@/lib/redact';
import type { ContentBlock, TokenUsage } from '@/transports/types';

/** The formats the UI offers. Order is the order they are presented in. */
export const EXPORT_FORMATS = ['markdown', 'json'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/**
 * The JSON envelope's version.
 *
 * Written into every export so a future importer can refuse a file it does not
 * understand instead of guessing. Bump it when the shape changes incompatibly —
 * adding an optional field is not incompatible.
 */
export const EXPORT_SCHEMA_VERSION = 1;

export interface ExportOptions {
  /** The model's scratch work. Off by default; see the module comment. */
  includeThinking?: boolean;
  /** Messages the context strategy dropped from the request. Included, marked. */
  includeExcluded?: boolean;
  /** Per-message token counts and the conversation's settings. */
  includeMetadata?: boolean;
  /** Injected so a filename is reproducible in a test. */
  now?: number;
}

export interface ExportInput {
  conversation: Conversation;
  messages: readonly StoredMessage[];
}

export interface ExportResult {
  /** Safe on every filesystem the share sheet might hand this to. */
  filename: string;
  mimeType: string;
  text: string;
  /** For the confirmation: what the user is about to send somewhere. */
  bytes: number;
  messages: number;
}

/* -------------------------------------------------------------------------- */
/* Shared helpers                                                             */
/* -------------------------------------------------------------------------- */

const ROLE_LABEL: Record<string, string> = {
  user: 'You',
  assistant: 'Assistant',
  system: 'System',
  tool: 'Tool',
};

/** Every string on its way into an artefact goes through here. No exceptions. */
function safe(value: string): string {
  return redactString(value);
}

/** ISO 8601, in UTC, because an export is read somewhere else. */
function iso(at: number): string {
  return new Date(at).toISOString();
}

/**
 * A filename that survives being handed to an unknown filesystem.
 *
 * Reserved characters, control characters and separators are all replaced with a
 * hyphen by a single allow-list pass, because the deny-list differs per platform
 * and the share target is whichever app the user picked. Lossy on purpose: the
 * title is already inside the document, so a mangled filename costs nothing, and
 * a filename a share target rejects costs the whole export.
 */
export function exportFilename(title: string, format: ExportFormat, at: number): string {
  const slug = safe(title)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60);
  const stamp = iso(at).slice(0, 10);
  const base = slug || 'conversation';
  return `${base}-${stamp}.${format === 'markdown' ? 'md' : 'json'}`;
}

/** A human description of an attachment, standing in for bytes we refuse to write. */
function describeAttachment(block: ContentBlock): string {
  if (block.type === 'image') {
    const kb = Math.round((block.data.length * 3) / 4 / 1024);
    return `[image: ${safe(block.mediaType)}, ~${kb} kB — not included in this export]`;
  }
  if (block.type === 'document') {
    const name = block.name ? safe(block.name) : 'untitled';
    // A document whose text was extracted on device *is* exportable text, and
    // dropping it would lose content the model actually saw.
    if (block.text) return `[document: ${name} (${safe(block.mediaType)})]\n\n${safe(block.text)}`;
    return `[document: ${name} (${safe(block.mediaType)}) — contents not included in this export]`;
  }
  return '';
}

function usageLine(usage: Partial<TokenUsage>): string {
  const parts: string[] = [];
  if (usage.input !== undefined) parts.push(`in ${usage.input}`);
  if (usage.output !== undefined) parts.push(`out ${usage.output}`);
  if (usage.thinking !== undefined) parts.push(`thinking ${usage.thinking}`);
  if (usage.cacheRead !== undefined) parts.push(`cache read ${usage.cacheRead}`);
  if (usage.cacheWrite !== undefined) parts.push(`cache write ${usage.cacheWrite}`);
  return parts.join(' · ');
}

/** Whether a message belongs in the artefact at all. */
function included(message: StoredMessage, options: ExportOptions): boolean {
  if (message.excluded && options.includeExcluded === false) return false;
  return true;
}

/* -------------------------------------------------------------------------- */
/* Markdown                                                                   */
/* -------------------------------------------------------------------------- */

/**
 * Blocks as Markdown.
 *
 * Tool calls and results are fenced JSON rather than prose: they *are* data, and
 * a reader who cares about them wants to see the arguments exactly. Errors are
 * quoted with the gateway's own wording, never a paraphrase.
 */
function blocksToMarkdown(blocks: readonly ContentBlock[], options: ExportOptions): string[] {
  const out: string[] = [];
  for (const block of blocks) {
    switch (block.type) {
      case 'text':
        if (block.text.trim()) out.push(safe(block.text));
        // Footnoted under the text, matching the `server_tool` source list. The quoted
        // passage goes in here even though the transcript drops it: a document is read
        // to check an answer, and the quotation is the check.
        if (block.citations?.length) {
          out.push(
            block.citations
              .map((citation) => {
                const link = `- [${safe(citation.title ?? citation.url)}](${safe(citation.url)})`;
                return citation.citedText ? `${link}\n  > ${safe(citation.citedText).split('\n').join('\n  > ')}` : link;
              })
              .join('\n'),
          );
        }
        break;
      case 'thinking':
        if (!options.includeThinking) break;
        // Blockquoted and labelled, so it can never be mistaken for the reply.
        if (block.text.trim()) {
          out.push(`> **Thinking**\n>\n${safe(block.text).split('\n').map((line) => `> ${line}`).join('\n')}`);
        }
        if (block.redacted) out.push('> **Thinking** (redacted by the provider)');
        break;
      case 'image':
      case 'document':
        out.push(describeAttachment(block));
        break;
      case 'tool_use':
        out.push(
          `**Tool call** \`${safe(block.name)}\`\n\n\`\`\`json\n${safe(stringify(block.input))}\n\`\`\``,
        );
        break;
      case 'tool_result':
        out.push(
          `**Tool result**${block.isError ? ' (error)' : ''}\n\n\`\`\`\n${safe(block.content)}\n\`\`\``,
        );
        break;
      case 'server_tool': {
        const lines = [`**${safe(block.summary ?? block.name)}**`];
        for (const source of block.sources ?? []) {
          lines.push(`- [${safe(source.title ?? source.url)}](${safe(source.url)})`);
        }
        out.push(lines.join('\n'));
        break;
      }
    }
  }
  return out.filter(Boolean);
}

/** `JSON.stringify` that cannot throw on a cycle or a BigInt. */
function stringify(value: unknown): string {
  try {
    const seen = new WeakSet<object>();
    return JSON.stringify(
      value,
      (_key, item) => {
        if (typeof item === 'bigint') return `${item}`;
        if (item && typeof item === 'object') {
          if (seen.has(item)) return '[Circular]';
          seen.add(item);
        }
        return item;
      },
      2,
    ) ?? 'null';
  } catch {
    return '[unserialisable]';
  }
}

function conversationToMarkdown(input: ExportInput, options: ExportOptions): string {
  const { conversation, messages } = input;
  const lines: string[] = [`# ${safe(conversation.title)}`, ''];

  const facts: string[] = [
    `- Model: \`${safe(conversation.model)}\``,
    `- Started: ${iso(conversation.createdAt)}`,
    `- Last updated: ${iso(conversation.updatedAt)}`,
  ];
  if (conversation.tags.length) facts.push(`- Tags: ${conversation.tags.map(safe).join(', ')}`);
  if (conversation.forkedFromId) facts.push('- Forked from another conversation');
  lines.push(...facts, '');

  if (conversation.systemPrompt) {
    lines.push('## System prompt', '', safe(conversation.systemPrompt), '');
  }

  const kept = messages.filter((message) => included(message, options));
  for (const message of kept) {
    const label = ROLE_LABEL[message.role] ?? message.role;
    const marks: string[] = [iso(message.createdAt)];
    if (message.model && message.model !== conversation.model) marks.push(`\`${safe(message.model)}\``);
    if (message.excluded) marks.push('omitted from the request');
    if (message.meta?.editedAt) marks.push('edited');
    if (message.meta?.aborted) marks.push('stopped early');
    lines.push(`## ${label}`, '', `*${marks.join(' · ')}*`, '');

    const body = blocksToMarkdown(message.content, options);
    // Falling back to the flattened `text` column: a message whose blocks are all
    // attachments still has a preview worth showing, and a heading with nothing
    // under it reads as data loss.
    lines.push(...(body.length ? body : [safe(message.text) || '*(no text)*']), '');

    if (message.error) lines.push(`> **Error:** ${safe(message.error)}`, '');
    if (options.includeMetadata !== false && message.usage) {
      const line = usageLine(message.usage);
      if (line) lines.push(`*Tokens: ${line}*`, '');
    }
  }

  if (!kept.length) lines.push('*No messages.*', '');
  return lines.join('\n');
}

/* -------------------------------------------------------------------------- */
/* JSON                                                                       */
/* -------------------------------------------------------------------------- */

/**
 * Blocks as JSON, with attachment payloads replaced by their shape.
 *
 * `data` is dropped and `bytes` put in its place, so a reader can see that an
 * image was there and how big it was without the file carrying it. The same
 * decision as the Markdown path, expressed structurally.
 */
function blockToJson(block: ContentBlock, options: ExportOptions): Record<string, unknown> | null {
  switch (block.type) {
    case 'text':
      // `redactDeep`, not `safe`, on the citations: a URL and a title come from a
      // third party by way of the model, so neither is a shape this app authored.
      return {
        type: 'text',
        text: safe(block.text),
        ...(block.citations?.length ? { citations: redactDeep(block.citations) } : {}),
      };
    case 'thinking':
      if (!options.includeThinking) return null;
      return {
        type: 'thinking',
        text: safe(block.text),
        ...(block.redacted ? { redactedByProvider: true } : {}),
      };
    case 'image':
      return {
        type: 'image',
        mediaType: safe(block.mediaType),
        bytes: Math.round((block.data.length * 3) / 4),
        included: false,
      };
    case 'document':
      return {
        type: 'document',
        mediaType: safe(block.mediaType),
        ...(block.name ? { name: safe(block.name) } : {}),
        ...(block.text ? { text: safe(block.text) } : {}),
        ...(block.data ? { bytes: Math.round((block.data.length * 3) / 4), included: false } : {}),
      };
    case 'tool_use':
      return { type: 'tool_use', id: safe(block.id), name: safe(block.name), input: redactDeep(block.input) };
    case 'tool_result':
      return {
        type: 'tool_result',
        toolUseId: safe(block.toolUseId),
        content: safe(block.content),
        ...(block.isError ? { isError: true } : {}),
      };
    case 'server_tool':
      // `raw` is the provider's own wire payload — pages of fetched text, kept out
      // of the export for the same reason image `data` is. The summary and the
      // source list are what a reader wants, and both get walked by `redactDeep`
      // because neither is a shape this app authored.
      return {
        type: 'server_tool',
        name: safe(block.name),
        ...(block.summary ? { summary: safe(block.summary) } : {}),
        ...(block.sources?.length ? { sources: redactDeep(block.sources) } : {}),
        included: false,
      };
  }
}

/**
 * Redacts every string inside an arbitrary value.
 *
 * Tool-call arguments are the one place in an export whose shape we do not
 * control — they are whatever a server's schema said — so they get walked rather
 * than trusted. `redact()` from `@/lib/redact` also blanks secret-*named* keys,
 * which is the wrong behaviour here: it would silently drop a legitimate `token`
 * argument to a tool and make the export a misleading record of what was sent.
 * This walk scrubs values and keeps the structure.
 */
function redactDeep(value: unknown, seen: WeakSet<object> = new WeakSet()): unknown {
  if (typeof value === 'string') return safe(value);
  if (typeof value !== 'object' || value === null) return value;
  if (seen.has(value)) return '[Circular]';
  seen.add(value);
  if (Array.isArray(value)) return value.map((item) => redactDeep(item, seen));
  const out: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
    out[safe(key)] = redactDeep(item, seen);
  }
  return out;
}

function conversationToJson(input: ExportInput, options: ExportOptions): Record<string, unknown> {
  const { conversation, messages } = input;
  return {
    id: safe(conversation.id),
    title: safe(conversation.title),
    createdAt: iso(conversation.createdAt),
    updatedAt: iso(conversation.updatedAt),
    model: safe(conversation.model),
    // The provider *profile* id, which is a locally generated identifier — never
    // a base URL and never a key. Kept so a future import can offer to reattach
    // the conversation to the profile it was using.
    profileId: safe(conversation.profileId),
    tags: conversation.tags.map(safe),
    pinned: conversation.pinned,
    archived: conversation.archived,
    ...(conversation.systemPrompt ? { systemPrompt: safe(conversation.systemPrompt) } : {}),
    ...(conversation.forkedFromId ? { forkedFromId: safe(conversation.forkedFromId) } : {}),
    ...(options.includeMetadata === false ? {} : { config: redactDeep(conversation.config) }),
    messages: messages
      .filter((message) => included(message, options))
      .map((message) => ({
        id: safe(message.id),
        role: message.role,
        createdAt: iso(message.createdAt),
        seq: message.seq,
        ...(message.model ? { model: safe(message.model) } : {}),
        content: message.content.map((block) => blockToJson(block, options)).filter(Boolean),
        text: safe(message.text),
        excluded: message.excluded,
        ...(message.error ? { error: safe(message.error) } : {}),
        ...(message.stopReason ? { stopReason: message.stopReason } : {}),
        ...(options.includeMetadata === false
          ? {}
          : {
              ...(message.usage ? { usage: message.usage } : {}),
              ...(message.meta ? { meta: redactDeep(message.meta) } : {}),
            }),
      })),
  };
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                               */
/* -------------------------------------------------------------------------- */

/**
 * The final scan.
 *
 * Every string above already went through `safe()`. This runs over the assembled
 * text anyway, because the failure mode being defended against is a *future*
 * field added to the exporter without one — and a field like that produces a
 * leak, not a compile error. See the module comment on why the redundancy is
 * worth its cost.
 */
function seal(text: string): string {
  return redactString(text);
}

function result(text: string, filename: string, format: ExportFormat, messages: number): ExportResult {
  const sealed = seal(text);
  return {
    filename,
    mimeType: format === 'markdown' ? 'text/markdown' : 'application/json',
    text: sealed,
    // Byte length, not string length: the confirmation says how big the file is,
    // and one em dash is three bytes.
    bytes: new TextEncoder().encode(sealed).length,
    messages,
  };
}

/** One conversation, as Markdown or JSON. */
export function exportConversation(
  input: ExportInput,
  format: ExportFormat,
  options: ExportOptions = {},
): ExportResult {
  const at = options.now ?? Date.now();
  const kept = input.messages.filter((message) => included(message, options)).length;
  const filename = exportFilename(input.conversation.title, format, at);

  if (format === 'markdown') {
    const header = `<!-- Exported ${iso(at)} by ${APP_WIRE_NAME}. API keys are never included. -->\n\n`;
    return result(header + conversationToMarkdown(input, options), filename, format, kept);
  }

  return result(
    stringify({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: iso(at),
      app: APP_WIRE_NAME,
      conversation: conversationToJson(input, options),
    }),
    filename,
    format,
    kept,
  );
}

/**
 * Several conversations in one artefact.
 *
 * Markdown concatenates with a rule between; JSON puts them in an array under
 * the same envelope. Separate from the single-conversation path rather than
 * special-casing inside it, because the filename and the envelope differ and
 * threading "is this a bundle" through both formatters would be worse than two
 * short functions.
 */
export function exportConversations(
  inputs: readonly ExportInput[],
  format: ExportFormat,
  options: ExportOptions = {},
): ExportResult {
  const at = options.now ?? Date.now();
  if (inputs.length === 1 && inputs[0]) return exportConversation(inputs[0], format, { ...options, now: at });

  const kept = inputs.reduce(
    (total, input) => total + input.messages.filter((message) => included(message, options)).length,
    0,
  );
  const filename = `${APP_WIRE_NAME.toLowerCase()}-${inputs.length}-conversations-${iso(at).slice(0, 10)}.${
    format === 'markdown' ? 'md' : 'json'
  }`;

  if (format === 'markdown') {
    const header =
      `<!-- Exported ${iso(at)} by ${APP_WIRE_NAME}. API keys are never included. -->\n\n` +
      `# ${inputs.length} conversations\n\n`;
    const body = inputs.map((input) => conversationToMarkdown(input, options)).join('\n\n---\n\n');
    return result(header + body, filename, format, kept);
  }

  return result(
    stringify({
      schemaVersion: EXPORT_SCHEMA_VERSION,
      exportedAt: iso(at),
      app: APP_WIRE_NAME,
      conversations: inputs.map((input) => conversationToJson(input, options)),
    }),
    filename,
    format,
    kept,
  );
}
