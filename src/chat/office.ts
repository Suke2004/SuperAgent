/**
 * Text out of an Office file, on device.
 *
 * A `.docx`, `.xlsx` or `.pptx` is a zip of XML parts, and `fflate` — already here for
 * skill archives — opens it. So the one format family the picker used to refuse
 * outright is readable with no new dependency and no native code: the same treatment
 * a `.md` gets, extracted here and sent as text.
 *
 * Two things are deliberate:
 *
 *  - **Tags are matched, not parsed.** There is no XML parser in this project and an
 *    OOXML part is machine-written, so a tokenizer over `<…>` is enough to walk runs
 *    and paragraphs. It nests correctly because the walk is a stream, not a
 *    `[\s\S]*?` pair match. `ponytail: regex tokenizer, swap in a real parser if
 *    something needs attributes deeper than a cell reference.`
 *  - **The output is bounded here as well as by the caller.** A 4 MB spreadsheet is
 *    tens of megabytes of XML; building the whole string and trimming it afterwards is
 *    the version that runs out of memory on a phone.
 *
 * What is lost, and stated to the user rather than hidden: layout, styles, images,
 * and a cell's number format — a date cell reads as its serial number, because the
 * format lives in a styles part this does not open.
 */

import { strFromU8, unzipSync } from 'fflate';

export type OfficeKind = 'docx' | 'xlsx' | 'pptx';

/** The three media types, as Android and the picker report them. */
const KIND_BY_TYPE: Record<string, OfficeKind> = {
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document': 'docx',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet': 'xlsx',
  'application/vnd.openxmlformats-officedocument.presentationml.presentation': 'pptx',
};

const KIND_BY_EXTENSION: Record<string, OfficeKind> = { docx: 'docx', xlsx: 'xlsx', pptx: 'pptx' };

/** Media types worth offering in the system picker. */
export const OFFICE_MEDIA_TYPES = Object.keys(KIND_BY_TYPE);

/**
 * Source-file ceiling for an Office file, in bytes.
 *
 * Higher than the plain-text limit because the file is compressed — a 4 MB `.docx` is
 * a long report, not a rogue file — and the expansion is bounded by {@link LIMIT}
 * below rather than by this number.
 */
export const MAX_OFFICE_BYTES = 4_000_000;

/**
 * Ceiling on extracted characters, applied while extracting.
 *
 * Above the 120k the attachment layer keeps, so the elision the user is told about is
 * still the caller's, and low enough that a runaway sheet cannot fill the heap.
 */
const LIMIT = 400_000;

/** Which of the three, from what the system said and then from the name. */
export function officeKind(mediaType: string | undefined, name?: string): OfficeKind | undefined {
  const byType = KIND_BY_TYPE[(mediaType ?? '').toLowerCase()];
  if (byType) return byType;
  const extension = (name ?? '').toLowerCase().split('.').pop() ?? '';
  return KIND_BY_EXTENSION[extension];
}

/** Whether this file is one this module can read. */
export function isOfficeDocument(mediaType: string | undefined, name?: string): boolean {
  return officeKind(mediaType, name) !== undefined;
}

/* ------------------------------------------------------------------------- */
/* XML                                                                        */
/* ------------------------------------------------------------------------- */

const NAMED: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeEntities(raw: string): string {
  if (!raw.includes('&')) return raw;
  return raw.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    if (body.startsWith('#')) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
    }
    return NAMED[body] ?? whole;
  });
}

/** The local name of a tag body, without the `/` of a close or the namespace kept. */
function tagName(body: string): string {
  return (body.replace(/^\//, '').split(/[\s/]/)[0] ?? '').trim();
}

interface Flow {
  /** Tag whose character data is the text — `w:t`, `a:t`. */
  text: string;
  /** Tag whose close ends a line — `w:p`, `a:p`. */
  para: string;
  /** Tag that means a tab, if the format has one. */
  tab?: string;
  /** Tag that means a line break inside a paragraph. */
  br?: string;
}

/**
 * The visible text of an OOXML part, in document order.
 *
 * A stream over tags rather than a pair match, so a paragraph inside a text box — a
 * `w:p` nested in a `w:p` — does not truncate its parent, which is exactly what a
 * non-greedy `<w:p>…</w:p>` regex does.
 */
function flowText(xml: string, flow: Flow): string {
  let out = '';
  let capture = false;
  let cursor = 0;
  const tags = /<([^>]*)>/g;
  let match: RegExpExecArray | null;

  while ((match = tags.exec(xml)) !== null) {
    if (capture) {
      const between = xml.slice(cursor, match.index);
      if (between) out += decodeEntities(between);
    }
    cursor = tags.lastIndex;
    if (out.length > LIMIT) break;

    const body = match[1] ?? '';
    const name = tagName(body);
    const closing = body.startsWith('/');
    const selfClosing = body.endsWith('/');

    if (name === flow.text) capture = !closing && !selfClosing;
    else if (name === flow.para) {
      // A line on open as well as on close: a paragraph nested in another one — which
      // is how a text box is stored — otherwise runs its text straight onto the text
      // before it.
      if (closing || (out !== '' && !out.endsWith('\n'))) out += '\n';
    }
    else if (flow.tab !== undefined && name === flow.tab) out += '\t';
    else if (flow.br !== undefined && name === flow.br) out += '\n';
  }

  return out;
}

/** Every `<t>` run inside one element, concatenated — a shared string with styling. */
function runsOf(xml: string): string {
  let out = '';
  for (const match of xml.matchAll(/<(?:\w+:)?t(?:\s[^>]*)?>([\s\S]*?)<\/(?:\w+:)?t>/g)) {
    out += decodeEntities(match[1] ?? '');
  }
  return out;
}

function attribute(attrs: string, name: string): string | undefined {
  const match = new RegExp(`${name}="([^"]*)"`).exec(attrs);
  return match?.[1];
}

/* ------------------------------------------------------------------------- */
/* Parts                                                                      */
/* ------------------------------------------------------------------------- */

type Entries = Record<string, Uint8Array>;

function part(entries: Entries, path: string): string | undefined {
  const bytes = entries[path];
  return bytes ? strFromU8(bytes) : undefined;
}

/** Paths matching a prefix, ordered by the number in the file name (`slide10` last). */
function numbered(entries: Entries, prefix: string): string[] {
  return Object.keys(entries)
    .filter((path) => path.startsWith(prefix) && path.endsWith('.xml'))
    .sort((a, b) => {
      const na = Number.parseInt(/(\d+)\.xml$/.exec(a)?.[1] ?? '0', 10);
      const nb = Number.parseInt(/(\d+)\.xml$/.exec(b)?.[1] ?? '0', 10);
      return na - nb || a.localeCompare(b);
    });
}

function docxText(entries: Entries): string {
  const xml = part(entries, 'word/document.xml');
  if (xml === undefined) return '';
  return flowText(xml, { text: 'w:t', para: 'w:p', tab: 'w:tab', br: 'w:br' });
}

function pptxText(entries: Entries): string {
  const slides = numbered(entries, 'ppt/slides/slide');
  const out: string[] = [];
  slides.forEach((path, index) => {
    if (out.join('').length > LIMIT) return;
    const xml = part(entries, path);
    if (xml === undefined) return;
    const text = flowText(xml, { text: 'a:t', para: 'a:p', br: 'a:br' }).trim();
    out.push(`## Slide ${index + 1}\n${text}`);
  });
  return out.join('\n\n');
}

/** `A` → 0, `Z` → 25, `AA` → 26. Used to put a row's gaps back. */
export function columnIndex(reference: string): number {
  let index = 0;
  for (const character of reference.toUpperCase()) {
    const value = character.charCodeAt(0) - 64;
    if (value < 1 || value > 26) break;
    index = index * 26 + value;
  }
  return Math.max(0, index - 1);
}

/** Sheet name → part path, from the workbook's relationships. */
function sheetPaths(entries: Entries): { name: string; path: string }[] {
  const workbook = part(entries, 'xl/workbook.xml');
  const rels = part(entries, 'xl/_rels/workbook.xml.rels');
  const byId = new Map<string, string>();
  if (rels !== undefined) {
    for (const match of rels.matchAll(/<Relationship\s([^>]*)\/?>/g)) {
      const attrs = match[1] ?? '';
      const id = attribute(attrs, 'Id');
      const target = attribute(attrs, 'Target');
      if (id && target) byId.set(id, `xl/${target.replace(/^\/?(xl\/)?/, '')}`);
    }
  }

  const found: { name: string; path: string }[] = [];
  if (workbook !== undefined) {
    for (const match of workbook.matchAll(/<sheet\s([^>]*?)\/?>/g)) {
      const attrs = match[1] ?? '';
      const name = decodeEntities(attribute(attrs, 'name') ?? `Sheet ${found.length + 1}`);
      const id = attribute(attrs, 'r:id') ?? attribute(attrs, 'id') ?? '';
      const path = byId.get(id);
      if (path !== undefined && entries[path]) found.push({ name, path });
    }
  }
  if (found.length > 0) return found;

  // No workbook part, or relationships that pointed nowhere: the sheets themselves are
  // still there, and an unnamed sheet of real numbers beats refusing the file.
  return numbered(entries, 'xl/worksheets/sheet').map((path, index) => ({
    name: `Sheet ${index + 1}`,
    path,
  }));
}

function sharedStrings(entries: Entries): string[] {
  const xml = part(entries, 'xl/sharedStrings.xml');
  if (xml === undefined) return [];
  const out: string[] = [];
  for (const match of xml.matchAll(/<si(?:\s[^>]*)?>([\s\S]*?)<\/si>/g)) out.push(runsOf(match[1] ?? ''));
  return out;
}

/** One cell's value as text, given the shared-string table. */
function cellValue(attrs: string, inner: string, strings: readonly string[]): string {
  const kind = attribute(attrs, 't') ?? 'n';
  if (kind === 'inlineStr') return runsOf(inner);
  if (kind === 's') {
    const index = Number.parseInt(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '', 10);
    return strings[index] ?? '';
  }
  const raw = decodeEntities(/<v(?:\s[^>]*)?>([\s\S]*?)<\/v>/.exec(inner)?.[1] ?? '');
  if (kind === 'b') return raw === '1' ? 'TRUE' : 'FALSE';
  return raw;
}

/**
 * A sheet as tab-separated rows.
 *
 * Gaps are preserved from each cell's `r` reference rather than counted, because a
 * sheet omits empty cells entirely and a row read positionally would shift every
 * column after the first blank.
 */
function sheetText(xml: string, strings: readonly string[]): string {
  const lines: string[] = [];
  let size = 0;

  for (const row of xml.matchAll(/<row(?:\s[^>]*)?>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of (row[1] ?? '').matchAll(/<c\s([^>]*?)\/>|<c\s([^>]*?)>([\s\S]*?)<\/c>/g)) {
      const attrs = cell[1] ?? cell[2] ?? '';
      const value = cell[1] !== undefined ? '' : cellValue(attrs, cell[3] ?? '', strings);
      const reference = attribute(attrs, 'r') ?? '';
      const at = reference ? columnIndex(reference) : cells.length;
      while (cells.length < at) cells.push('');
      cells[at] = value;
    }
    while (cells.length > 0 && cells[cells.length - 1] === '') cells.pop();
    if (cells.length === 0) continue;
    const line = cells.join('\t');
    size += line.length + 1;
    lines.push(line);
    if (size > LIMIT) break;
  }

  return lines.join('\n');
}

function xlsxText(entries: Entries): string {
  const strings = sharedStrings(entries);
  const out: string[] = [];
  for (const sheet of sheetPaths(entries)) {
    const xml = part(entries, sheet.path);
    if (xml === undefined) continue;
    const text = sheetText(xml, strings);
    if (!text) continue;
    out.push(`## ${sheet.name}\n${text}`);
    if (out.join('').length > LIMIT) break;
  }
  return out.join('\n\n');
}

/* ------------------------------------------------------------------------- */
/* The entry point                                                            */
/* ------------------------------------------------------------------------- */

/**
 * The readable text of an Office file, or `''` when there is none in it.
 *
 * Throws only when the bytes are not a zip at all — an empty result is a real answer
 * for a deck of images or a blank workbook, and the caller says so rather than
 * treating it as a read failure.
 */
export function extractOffice(bytes: Uint8Array, kind: OfficeKind): string {
  const entries = unzipSync(bytes);
  const text = kind === 'docx' ? docxText(entries) : kind === 'xlsx' ? xlsxText(entries) : pptxText(entries);
  // Runs and paragraphs leave ragged whitespace behind: a `w:p` per empty line, and a
  // trailing newline per part. Collapsed here so the model is not paying for it.
  return text
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}
