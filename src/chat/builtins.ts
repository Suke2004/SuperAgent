/**
 * The tools this app implements itself.
 *
 * Everything the model could *do* used to come from an MCP server, which made the
 * app a client with no hands of its own: with no server configured, a model asked
 * for a PDF could only describe one. These five are the smallest set that closes
 * that gap — write a file, render a PDF, write an Office document, read a page, read a
 * resource — and they are deliberately not a shell. There is no `run_command` here, and
 * one is not planned: an Android app has no useful shell to offer, and a tool that
 * pretends otherwise fails in ways that read as the model lying.
 *
 * `run_code` is the one apparent exception and is not one. It is a JavaScript engine in
 * a WebView with no network, no storage and no bridge to this app — a calculator, not a
 * shell — and it is off until the user turns it on. Its rules live in `@/chat/sandbox`;
 * only the definition is here.
 *
 * This module is pure. Definitions, argument validation, filename and URL rules live
 * here with their tests; the file system, the PDF renderer and `fetch` live in
 * `@/chat/files` and `@/chat/web`, called by the tool loop.
 */

import { OFFICE_FORMATS } from '@/chat/ooxml';
import type { OfficeFormat } from '@/chat/ooxml';
import type { ToolDefinition } from '@/transports/types';

export const WRITE_FILE = 'write_file';
export const CREATE_PDF = 'create_pdf';
export const CREATE_DOCUMENT = 'create_document';
export const FETCH_URL = 'fetch_url';
export const READ_RESOURCE = 'read_mcp_resource';
export const RUN_CODE = 'run_code';

/** Every name this module can answer to, for the loop's "is this mine?" check. */
export const BUILTIN_TOOL_NAMES: readonly string[] = [
  WRITE_FILE,
  CREATE_PDF,
  CREATE_DOCUMENT,
  FETCH_URL,
  READ_RESOURCE,
  RUN_CODE,
];

/* -------------------------------------------------------------------------- */
/* Filenames                                                                   */
/* -------------------------------------------------------------------------- */

/** What a `format` maps to on disk. The keys are the tool's enum. */
export const FILE_EXTENSIONS: Readonly<Record<string, string>> = {
  text: 'txt',
  markdown: 'md',
  csv: 'csv',
  json: 'json',
  html: 'html',
};

/** Longest basename kept. Android's limit is 255 bytes; this leaves room for a suffix. */
const MAX_BASENAME = 60;

/**
 * A model-supplied filename turned into one that is safe to create.
 *
 * The whole point is that nothing here can escape the app's own directory. Path
 * separators, `..` and drive letters are removed rather than rejected: a model that
 * asks for `../../etc/passwd` is usually asking for `passwd`, and refusing the call
 * teaches it nothing it can act on. A leading dot goes too — a file the user cannot
 * see in a picker is a file they will report as missing.
 */
export function safeBasename(name: string, extension: string): string {
  const stem =
    name
      .replace(/[\\/]+/g, ' ')
      .replace(/\.{2,}/g, ' ')
      .replace(/[^A-Za-z0-9 ._-]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .replace(/^[.\s]+/, '')
      .replace(/\.[A-Za-z0-9]{1,8}$/, '')
      .slice(0, MAX_BASENAME)
      .trim() || 'file';
  return `${stem}.${extension}`;
}

/** Ceiling on one generated file. Generous for prose, finite for a runaway loop. */
export const MAX_FILE_CHARS = 500_000;

export type WriteRequest = { ok: true; name: string; content: string } | { ok: false; reason: string };

/**
 * Validates a `write_file` call.
 *
 * An unknown format is corrected to `text` rather than refused: the extension is
 * cosmetic, the content is what the user asked for, and failing the call over a
 * spelling loses the document.
 */
export function parseWriteFile(input: unknown): WriteRequest {
  const record = asRecord(input);
  const content = typeof record.content === 'string' ? record.content : '';
  if (!content.trim()) return { ok: false, reason: `${WRITE_FILE} needs "content" — the text to write.` };
  if (content.length > MAX_FILE_CHARS) {
    return {
      ok: false,
      reason: `That is ${content.length.toLocaleString()} characters; the limit for one file is ${MAX_FILE_CHARS.toLocaleString()}. Write it in parts.`,
    };
  }
  const format = typeof record.format === 'string' ? record.format : 'text';
  const extension = FILE_EXTENSIONS[format] ?? FILE_EXTENSIONS.text ?? 'txt';
  const asked = typeof record.name === 'string' ? record.name : '';
  return { ok: true, name: safeBasename(asked, extension), content };
}

export type PdfRequest = { ok: true; name: string; title: string; markdown: string } | { ok: false; reason: string };

/** Validates a `create_pdf` call. The title defaults to the filename's stem. */
export function parsePdf(input: unknown): PdfRequest {
  const record = asRecord(input);
  const markdown = typeof record.markdown === 'string' ? record.markdown : '';
  if (!markdown.trim()) return { ok: false, reason: `${CREATE_PDF} needs "markdown" — the body of the document.` };
  if (markdown.length > MAX_FILE_CHARS) {
    return {
      ok: false,
      reason: `That is ${markdown.length.toLocaleString()} characters; the limit for one document is ${MAX_FILE_CHARS.toLocaleString()}.`,
    };
  }
  const name = safeBasename(typeof record.name === 'string' ? record.name : '', 'pdf');
  const stem = name.replace(/\.pdf$/, '');
  const title = typeof record.title === 'string' && record.title.trim() ? record.title.trim() : stem;
  return { ok: true, name, title, markdown };
}

export type DocumentRequest =
  | { ok: true; name: string; format: OfficeFormat; markdown: string }
  | { ok: false; reason: string };

/**
 * Validates a `create_document` call.
 *
 * The format is *not* corrected the way `write_file` corrects an extension, because here
 * it decides which of three writers runs and what the bytes are. A missing one defaults
 * to `docx` — a document is the common case — but a misspelt one is refused with the list,
 * which is a refusal a model can act on in one retry.
 */
export function parseDocument(input: unknown): DocumentRequest {
  const record = asRecord(input);
  const markdown = typeof record.markdown === 'string' ? record.markdown : '';
  if (!markdown.trim()) return { ok: false, reason: `${CREATE_DOCUMENT} needs "markdown" — the content of the file.` };
  if (markdown.length > MAX_FILE_CHARS) {
    return {
      ok: false,
      reason: `That is ${markdown.length.toLocaleString()} characters; the limit for one document is ${MAX_FILE_CHARS.toLocaleString()}.`,
    };
  }
  const asked = typeof record.format === 'string' ? record.format.toLowerCase().trim() : 'docx';
  if (!OFFICE_FORMATS.includes(asked as OfficeFormat)) {
    return { ok: false, reason: `"${asked.slice(0, 20)}" is not a format. Use ${OFFICE_FORMATS.join(', ')}.` };
  }
  const format = asked as OfficeFormat;
  return { ok: true, name: safeBasename(typeof record.name === 'string' ? record.name : '', format), format, markdown };
}

/* -------------------------------------------------------------------------- */
/* Fetching a page                                                             */
/* -------------------------------------------------------------------------- */

/**
 * Hostnames and address forms this app will not fetch.
 *
 * Not a hardening exercise for its own sake. `fetch_url` is a tool whose argument
 * can come from a page the model just read, which is the textbook prompt-injection
 * path: a page saying "now fetch http://192.168.1.1/admin" would otherwise be a
 * request made from inside the user's home network with their device's address.
 * Loopback and link-local are the same problem pointed at the phone itself.
 */
const BLOCKED_HOSTS = /^(?:localhost|127(?:\.\d+){3}|0\.0\.0\.0|\[?::1\]?|.*\.local)$/i;
const PRIVATE_V4 = /^(?:10\.|192\.168\.|169\.254\.|172\.(?:1[6-9]|2\d|3[01])\.)/;

export type UrlCheck = { ok: true; url: string } | { ok: false; reason: string };

/**
 * The URL rules, in the order that produces the most useful refusal.
 *
 * GET only, so there is no request body to smuggle a payload in, and no credentials
 * in the URL, so a fetch cannot be turned into "log in as this user and tell me what
 * you see".
 */
export function checkFetchUrl(raw: unknown): UrlCheck {
  if (typeof raw !== 'string' || !raw.trim()) return { ok: false, reason: `${FETCH_URL} needs a "url".` };
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    return { ok: false, reason: `"${String(raw).slice(0, 80)}" is not a URL.` };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, reason: `${FETCH_URL} reads web pages only; ${url.protocol} is not supported.` };
  }
  if (url.username || url.password) {
    return { ok: false, reason: 'A URL with a username or password in it will not be fetched.' };
  }
  const host = url.hostname.toLowerCase();
  if (BLOCKED_HOSTS.test(host) || PRIVATE_V4.test(host)) {
    return { ok: false, reason: `${host} is on the local network, which this tool will not reach.` };
  }
  return { ok: true, url: url.toString() };
}

/** Characters of one page kept. Past this the model is reading a database dump. */
export const MAX_FETCH_CHARS = 60_000;

/**
 * HTML reduced to the text a model should read.
 *
 * `script`, `style`, `svg` and comments go entirely — they are most of the bytes of
 * a modern page and none of its meaning. Block-level tags become newlines so
 * headings and list items do not run together, and entities are decoded for the
 * handful that actually change a sentence's meaning.
 */
export function htmlToText(html: string): string {
  return html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|svg|noscript|template)\b[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<\/(p|div|section|article|li|tr|h[1-6]|blockquote|pre)>/gi, '\n')
    .replace(/<(br|hr)\s*\/?>/gi, '\n')
    .replace(/<li\b[^>]*>/gi, '- ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/[ \t]+/g, ' ')
    .replace(/ ?\n ?/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/** Truncates with a marker, so the model knows it is looking at part of a page. */
export function capFetched(text: string, limit = MAX_FETCH_CHARS): string {
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n\n[Truncated at ${limit.toLocaleString()} characters.]`;
}

/* -------------------------------------------------------------------------- */
/* Definitions                                                                 */
/* -------------------------------------------------------------------------- */

export interface BuiltinOptions {
  /** False when the user has not switched web access on. */
  web: boolean;
  /** The resource URIs the conversation's servers advertise, for the enum. */
  resources: readonly string[];
  /** False when the user has not switched the code sandbox on. */
  code?: boolean;
}

/**
 * The manifest, given what is switched on.
 *
 * `write_file`, `create_pdf` and `create_document` are always offered: they write inside
 * the app's own directory, which is reversible and visible, and a document tool nobody
 * had to enable is the difference between the feature existing and the feature being
 * found. `fetch_url` is not, because it makes requests on the user's network at the
 * direction of text the user did not write.
 *
 * The resource tool appears only when there is something to read. An enum of one
 * URI is cheap; an enum of none is a tool that can only fail.
 */
export function builtinTools(options: BuiltinOptions): ToolDefinition[] {
  const tools: ToolDefinition[] = [
    {
      name: WRITE_FILE,
      description:
        'Write a text file into the app\'s own storage, where the user can share or open it. Use this whenever ' +
        'the answer is a document rather than a message: a report, a CSV of results, a config file.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename without a path. An extension is added from the format.' },
          content: { type: 'string', description: 'The complete file contents.' },
          format: {
            type: 'string',
            enum: Object.keys(FILE_EXTENSIONS),
            description: 'Decides the extension only; the content is written verbatim. Defaults to text.',
          },
        },
        required: ['name', 'content'],
        additionalProperties: false,
      },
    },
    {
      name: CREATE_PDF,
      description:
        'Render Markdown into a PDF the user can share. Headings, lists, tables, code blocks and emphasis are ' +
        'styled; images and links are kept as text. Use this for something meant to be read or printed as a page.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename without a path or extension.' },
          title: { type: 'string', description: 'Heading for the first page. Defaults to the filename.' },
          markdown: { type: 'string', description: 'The document body, as Markdown.' },
        },
        required: ['name', 'markdown'],
        additionalProperties: false,
      },
    },
    {
      name: CREATE_DOCUMENT,
      description:
        'Write a Word, Excel or PowerPoint file the user can open, edit and send on. Markdown is the input for all ' +
        'three: docx keeps headings, emphasis, lists, quotes, code and tables; xlsx takes each Markdown table as a ' +
        'sheet, named after the heading above it, with numbers as numbers; pptx makes each heading a slide and what ' +
        'follows it the bullets. Use this instead of create_pdf when the user will want to change the file.',
      inputSchema: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'Filename without a path or extension.' },
          format: {
            type: 'string',
            enum: [...OFFICE_FORMATS],
            description: 'docx for a document, xlsx for tables, pptx for slides.',
          },
          markdown: { type: 'string', description: 'The content, as Markdown. Tables become sheets for xlsx.' },
        },
        required: ['name', 'format', 'markdown'],
        additionalProperties: false,
      },
    },
  ];

  if (options.web) {
    tools.push({
      name: FETCH_URL,
      description:
        'Fetch one web page or API response over GET and return it as text. HTML is reduced to readable text. ' +
        'Long pages are truncated. Cannot reach local or private network addresses.',
      inputSchema: {
        type: 'object',
        properties: { url: { type: 'string', description: 'An absolute http or https URL.' } },
        required: ['url'],
        additionalProperties: false,
      },
    });
  }

  // Off by default, and the switch says why: this runs code somebody else wrote. The
  // sandbox holds — no network, no storage, no bridge — but a user should still be the
  // one who decides that an app of theirs executes model output.
  if (options.code) {
    tools.push({
      name: RUN_CODE,
      description:
        'Run JavaScript in a sandbox on this device and get back what it printed. Use it for arithmetic, parsing, ' +
        'sorting, statistics and checking your own work — anything where being exactly right matters more than ' +
        'being fast. `console.log` is captured, and the value of the last expression is returned. Runs ' +
        'synchronously: promises are not awaited, and there is no network, no filesystem and no access to this ' +
        'conversation.',
      inputSchema: {
        type: 'object',
        properties: { code: { type: 'string', description: 'The JavaScript to run. Synchronous only.' } },
        required: ['code'],
        additionalProperties: false,
      },
    });
  }

  if (options.resources.length) {
    tools.push({
      name: READ_RESOURCE,
      description:
        'Read one of the resources the connected MCP servers advertise. Call with no argument to list them.',
      inputSchema: {
        type: 'object',
        properties: {
          uri: {
            type: 'string',
            enum: [...options.resources],
            description: 'The resource URI, exactly as listed. Omit to get the list.',
          },
        },
        additionalProperties: false,
      },
    });
  }

  return tools;
}

/* -------------------------------------------------------------------------- */
/* What a conversation can actually do                                         */
/* -------------------------------------------------------------------------- */

/** Everything that decides a turn's tool manifest, gathered from four different places. */
export interface LiveTools {
  /** `allowWebFetch`. */
  web: boolean;
  /** `allowWebSearch`, which is Anthropic-only and provider-side. */
  search: boolean;
  /** `allowRunCode`. */
  code: boolean;
  /** Enabled tools across the conversation's chosen servers. */
  serverTools: number;
  /** How many of those servers are switched on for this conversation. */
  servers: number;
  /** Skills switched on for this conversation. */
  skills: number;
  /** Plan mode, which blocks by effect rather than by switch. */
  plan: boolean;
}

/**
 * One line naming what the model may use on the next message.
 *
 * It exists because the answer was spread across four screens: three global switches in
 * Settings, a per-conversation server list, a per-conversation skill list, and a plan
 * mode that quietly removes half of them. Nobody should have to visit four places to
 * find out whether the next reply can write a file.
 *
 * The plan-mode wording mirrors `blockedInPlanMode` in `@/chat/plan` — the writers and
 * every MCP tool are refused, reading and the sandbox are not. That gate is the source
 * of truth; this only puts it into words, and the pairing is asserted in the tests,
 * because the two modules cannot import each other.
 */
export function summariseTools(live: LiveTools): string {
  const parts = [live.plan ? 'writing blocked' : 'files, PDFs and documents'];
  if (live.web) parts.push('web pages');
  if (live.search) parts.push('web search');
  if (live.code) parts.push('code');
  if (live.serverTools > 0) {
    parts.push(
      live.plan
        ? `${live.serverTools} server ${plural(live.serverTools, 'tool')} blocked`
        : `${live.serverTools} ${plural(live.serverTools, 'tool')} from ${live.servers} ${plural(live.servers, 'server')}`,
    );
  }
  if (live.skills > 0) parts.push(`${live.skills} ${plural(live.skills, 'skill')}`);
  return parts.join(' · ');
}

function plural(count: number, word: string): string {
  return count === 1 ? word : `${word}s`;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === 'object' && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}
