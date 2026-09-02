/**
 * What a tool call *did*, in words a reader recognises.
 *
 * A transcript that says `mcp__filesystem__read_text_file` followed by 40 lines of
 * JSON is a log, not an answer. What the reader needs between their question and the
 * reply is the same thing they would get from a person: "I looked it up" — and only
 * if they ask, the receipt. So every call gets a one-line label and, where the
 * arguments contain something recognisable, the *one* argument that says which thing
 * it acted on: the query, the file, the domain.
 *
 * ## Why patterns rather than a registry
 *
 * The builtin names in `@/chat/builtins` are known, but most tools here arrive over
 * MCP from servers this app has never heard of, and their names are chosen by whoever
 * wrote the server. There is no list to look them up in. What there *is* is a strong
 * naming convention — `read_file`, `web_search`, `list_directory`, `run_command` — so
 * matching on the verb is the only approach that works on a tool added tomorrow.
 *
 * Order matters: the first match wins, and the patterns are arranged so the more
 * specific verb is tested first. `read_url` is a fetch, not a file read, and it has to
 * be caught before the bare `read`.
 *
 * ## Why the label never claims success
 *
 * "Searched the web", not "Found 8 results". This describes the *call*, which is
 * rendered before its result exists and stays rendered when the result is an error.
 * A label that promised an outcome would be a lie half the time it is on screen.
 */

import type { IconName } from '@/components/Icon';

/** The most a detail may be, in characters. A step is one line; a path is not. */
const DETAIL_CAP = 64;

/**
 * The argument keys worth showing, in the order they are preferred.
 *
 * `query` before `url` because a search tool that takes both means the query; `path`
 * before `name` because a file tool that has both means the path it touched.
 */
const DETAIL_KEYS: readonly string[] = [
  'query',
  'q',
  'search',
  'question',
  'url',
  'uri',
  'href',
  'path',
  'file',
  'file_path',
  'filePath',
  'filename',
  'name',
  'command',
  'cmd',
  'pattern',
  'expression',
  'code',
];

/**
 * Verb → sentence, and the glyph that goes in front of it. First match wins.
 *
 * Matched against the *humanised* name — `read_text_file` as `read text file` — with
 * every alternative anchored on `\b`. Substring matching would be shorter and it is
 * wrong: `summarise_thread` contains "read", `spreadsheet_rows` contains it too, and
 * both would be labelled "Read a file" by a reader-facing string they cannot check.
 */
const PATTERNS: readonly [RegExp, string, IconName][] = [
  [/\b(web|internet|brave|google|bing|duckduckgo) ?search\b|\bsearch ?web\b/, 'Searched the web', 'search'],
  [/\bfetch\b|\bread url\b|\bopen url\b|\bbrowse\b|\bscrape\b|\bcrawl\b|\bhttp\b/, 'Read a page', 'gateway'],
  [/\bpdf\b|\bprint\b/, 'Made a PDF', 'files'],
  [/\bwrite\b|\bsave\b|\bcreate (file|document)\b|\bput file\b|\bupload\b/, 'Wrote a file', 'files'],
  [/\bedit\b|\bpatch\b|\breplace\b|\brewrite\b|\bupdate file\b/, 'Edited a file', 'edit'],
  [/\bdelete\b|\bremove\b|\bunlink\b|\brm\b/, 'Deleted a file', 'trash'],
  [/\blist\b|\bglob\b|\bfind\b|\bls\b|\btree\b|\bdirectory\b|\bdir\b/, 'Looked through files', 'files'],
  [/\bgrep\b|\bripgrep\b|\bsearch\b/, 'Searched the files', 'search'],
  [/\brun\b|\bexec\b|\bbash\b|\bshell\b|\bterminal\b|\bcommand\b|\beval\b|\bpython\b|\bnode\b/, 'Ran code', 'diagnostics'],
  [/\bread\b|\bcat\b|\bopen\b|\bget file\b|\bresource\b/, 'Read a file', 'files'],
  [/\bquery\b|\bsql\b|\bdatabase\b|\bdb\b/, 'Queried a database', 'data'],
  [/\b(send|post|reply)\b/, 'Sent a message', 'mail'],
  [/\bcalendar\b|\bevent\b|\bschedule\b/, 'Checked the calendar', 'calendar'],
  [/\bmail\b|\bemail\b|\binbox\b|\bmessage\b/, 'Checked mail', 'mail'],
  [/\bmemory\b|\bremember\b|\brecall\b|\bnote\b/, 'Used its memory', 'memory'],
];

/**
 * The tool's own name, with the transport's routing stripped off.
 *
 * MCP tools reach the model as `mcp__<server>__<tool>` (and some gateways use one
 * separator, or a slash), and the server name is noise for this purpose — worse than
 * noise, because a server called `websearch` would make every one of its tools look
 * like a search. Only the last segment is the verb.
 */
export function bareToolName(name: string): string {
  const parts = name.split(/__|\/|\./).filter(Boolean);
  return parts[parts.length - 1] ?? name;
}

/** `read_text_file` → `read text file`, for the fallback label. */
function humanise(name: string): string {
  return bareToolName(name)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_-]+/g, ' ')
    .trim()
    .toLowerCase();
}

/** One line, capped, with an ellipsis when it was cut. Newlines become spaces. */
function oneLine(value: string): string {
  const flat = value.replace(/\s+/g, ' ').trim();
  if (flat.length <= DETAIL_CAP) return flat;
  return `${flat.slice(0, DETAIL_CAP - 1)}…`;
}

/**
 * The recognisable argument, or `null` when nothing in the input is worth a label.
 *
 * Only top-level string arguments are considered. A nested one would need a search
 * with no way to tell which of several strings is the subject, and guessing wrong
 * here labels a step with the wrong thing — which is worse than labelling it with
 * nothing, because a reader believes a label.
 */
export function toolDetail(input: unknown): string | null {
  if (typeof input === 'string') return oneLine(input) || null;
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const record = input as Record<string, unknown>;
  for (const key of DETAIL_KEYS) {
    const value = record[key];
    if (typeof value === 'string' && value.trim()) return oneLine(value);
  }
  return null;
}

export interface ToolStep {
  /** What it did: "Searched the web". Never claims an outcome. */
  label: string;
  /** What it did it to: a query, a path, a domain. `null` when unrecognisable. */
  detail: string | null;
  /** The glyph in front of the label. A type-only import, so this module stays pure. */
  icon: IconName;
}

/**
 * A tool call, as a step a reader can skim.
 *
 * The unmatched case is deliberately not "Used a tool": the name is the only
 * information there is, and a tool called `summarise_thread` reads perfectly well as
 * "Ran summarise thread". Discarding it to say nothing specific would be a downgrade.
 */
export function describeTool(name: string, input?: unknown): ToolStep {
  const words = humanise(name);
  const detail = toolDetail(input);

  for (const [pattern, label, icon] of PATTERNS) {
    if (pattern.test(words)) return { label, detail, icon };
  }

  return { label: words ? `Ran ${words}` : 'Ran a tool', detail, icon: 'tools' };
}
