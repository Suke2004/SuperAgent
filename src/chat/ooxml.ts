/**
 * Word, Excel and PowerPoint files, written on device.
 *
 * The mirror of `@/chat/office`: that module opens the three zips of XML, this one
 * builds them. Same reason it needs no new dependency — `fflate` is already here, and a
 * `.docx` is a handful of XML parts in a zip with a manifest. What was missing was not
 * a library but the parts.
 *
 * **Markdown is the input for all three**, rather than a schema per format. A model
 * writes good Markdown without being asked, `parseMarkdown` already turns it into
 * blocks this project trusts, and one tool with one argument is a tool that gets called
 * correctly. Each format then reads the blocks it can use:
 *
 *  - **docx** takes everything — headings, emphasis, code, quotes, lists, tables.
 *  - **xlsx** takes the *tables*, one sheet each, named after the heading above them.
 *    Prose is not a spreadsheet, so a document with no table becomes a single column
 *    of lines rather than a failed call.
 *  - **pptx** takes the *headings* as slides and everything under one as its bullets.
 *
 * Three things are deliberate and cost something:
 *
 *  1. **Direct formatting for lists, not `numbering.xml`.** A real list needs a
 *     numbering part, an abstract definition and a relationship, per list style. A
 *     bullet character and an indent is what the same document looks like, in four
 *     lines. `ponytail: literal bullets, add numbering.xml if a document needs
 *     multi-level or continued numbering.`
 *  2. **No hyperlink relationships.** A `<w:hyperlink>` needs a rel part entry per
 *     link. The address is written after the text instead, which is what a printed
 *     page does and what survives being pasted anywhere.
 *  3. **Element order is the schema's, not a convenience.** `w:rPr` children must come
 *     in the order the spec lists or a strict reader — LibreOffice, Google Docs —
 *     rejects the file where Word would have opened it. The orderings below are not
 *     arbitrary and are the first thing to check if a file will not open.
 *
 * Everything here is pure: blocks in, bytes out, no file system. That is what lets the
 * zip be built and inspected in Jest.
 */

import { strToU8, zipSync } from 'fflate';

import { inlineText, parseMarkdown } from '@/components/markdown/blocks';
import type { InlineToken, MdBlock } from '@/components/markdown/blocks';

/** The three formats this module writes. Matches `OfficeKind` on the reading side. */
export const OFFICE_FORMATS = ['docx', 'xlsx', 'pptx'] as const;

export type OfficeFormat = (typeof OFFICE_FORMATS)[number];

/** Media type per format, for the share sheet and the content-type manifest. */
export const OFFICE_FORMAT_TYPES: Readonly<Record<OfficeFormat, string>> = {
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
};

const DECL = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>';

const NS_CT = 'http://schemas.openxmlformats.org/package/2006/content-types';
const NS_REL = 'http://schemas.openxmlformats.org/package/2006/relationships';
const NS_ODR = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const NS_A = 'http://schemas.openxmlformats.org/drawingml/2006/main';

/**
 * Characters XML 1.0 has no representation for, at all.
 *
 * Tab, newline and carriage return are the only ones below `0x20` a document may carry,
 * and there is no escape for the rest — not even a numeric reference. Built from a
 * string rather than written as a literal so the source file holds no control bytes.
 */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]', 'g');

/**
 * One string, safe to put between tags.
 *
 * The control characters go as well as the five entities. XML 1.0 forbids most of them
 * outright, and a model that echoed a byte out of a binary file would otherwise produce
 * a document no reader will open — a failure that looks like a bug in this module and
 * is not.
 */
function xml(text: string): string {
  return text
    .replace(CONTROL, '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

/** `<Relationship>` entries wrapped in their document. */
function rels(entries: readonly { id: string; type: string; target: string }[]): string {
  const items = entries
    .map((entry) => `<Relationship Id="${entry.id}" Type="${NS_ODR}/${entry.type}" Target="${entry.target}"/>`)
    .join('');
  return `${DECL}<Relationships xmlns="${NS_REL}">${items}</Relationships>`;
}

/** The manifest. `rels` and `xml` are defaults; every real part is an override. */
function contentTypes(overrides: readonly { part: string; type: string }[]): string {
  const items = overrides.map((o) => `<Override PartName="${o.part}" ContentType="${o.type}"/>`).join('');
  return (
    `${DECL}<Types xmlns="${NS_CT}">` +
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
    '<Default Extension="xml" ContentType="application/xml"/>' +
    `${items}</Types>`
  );
}

/** Parts to bytes. Deflate throughout: OOXML has no stored-first part, unlike ODF. */
function pack(parts: Record<string, string>): Uint8Array {
  const zippable: Record<string, Uint8Array> = {};
  for (const [path, content] of Object.entries(parts)) zippable[path] = strToU8(content);
  return zipSync(zippable, { level: 6 });
}

/* ------------------------------------------------------------------------- */
/* Word                                                                       */
/* ------------------------------------------------------------------------- */

const NS_W = 'http://schemas.openxmlformats.org/wordprocessingml/2006/main';

/** Emphasis carried down through nested inline tokens. */
interface Fmt {
  bold?: boolean;
  italic?: boolean;
  strike?: boolean;
  mono?: boolean;
}

/**
 * One run.
 *
 * The `w:rPr` children are in the order `CT_RPr` declares them — `rFonts`, `b`, `i`,
 * `strike` — because that sequence is part of the schema rather than a style. Word
 * tolerates a wrong order; a validating reader does not.
 *
 * `xml:space="preserve"` on every run, because the leading space in `**bold** text` is
 * its own run and a collapsed one would join two words.
 */
function run(text: string, fmt: Fmt): string {
  if (!text) return '';
  const props =
    (fmt.mono ? '<w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/>' : '') +
    (fmt.bold ? '<w:b/>' : '') +
    (fmt.italic ? '<w:i/>' : '') +
    (fmt.strike ? '<w:strike/>' : '');
  return `<w:r>${props ? `<w:rPr>${props}</w:rPr>` : ''}<w:t xml:space="preserve">${xml(text)}</w:t></w:r>`;
}

/** Inline tokens to runs, carrying emphasis down through nesting. */
function runs(tokens: readonly InlineToken[], fmt: Fmt = {}): string {
  let out = '';
  for (const token of tokens) {
    switch (token.kind) {
      case 'text':
        out += run(token.text, fmt);
        break;
      case 'code':
        out += run(token.text, { ...fmt, mono: true });
        break;
      case 'math':
        // Not converted to OMML. The LaTeX is what the author wrote and is readable;
        // a half-translated equation is worse than a legible one in a monospace run.
        out += run(token.latex, { ...fmt, mono: true });
        break;
      case 'strong':
        out += runs(token.tokens, { ...fmt, bold: true });
        break;
      case 'em':
        out += runs(token.tokens, { ...fmt, italic: true });
        break;
      case 'del':
        out += runs(token.tokens, { ...fmt, strike: true });
        break;
      case 'link': {
        const label = inlineText(token.tokens);
        out += run(label, fmt);
        if (token.href && token.href !== label) out += run(` (${token.href})`, { ...fmt, italic: true });
        break;
      }
      case 'image':
        // The bytes are not in the Markdown, so there is nothing to embed.
        out += run(`[${token.alt || 'image'}]`, { ...fmt, italic: true });
        break;
      case 'break':
        out += '<w:r><w:br/></w:r>';
        break;
    }
  }
  return out;
}

/** One paragraph. `props` is `w:pPr` content, already in schema order. */
function para(content: string, props = ''): string {
  return `<w:p>${props ? `<w:pPr>${props}</w:pPr>` : ''}${content}</w:p>`;
}

/** A table row of already-built cell paragraphs. */
function cell(content: string, header: boolean): string {
  const shading = header ? '<w:shd w:val="clear" w:color="auto" w:fill="EFEFEF"/>' : '';
  return `<w:tc><w:tcPr><w:tcW w:w="0" w:type="auto"/>${shading}</w:tcPr>${content}</w:tc>`;
}

const TABLE_BORDER = ['top', 'left', 'bottom', 'right', 'insideH', 'insideV']
  .map((edge) => `<w:${edge} w:val="single" w:sz="4" w:space="0" w:color="BFBFBF"/>`)
  .join('');

/**
 * One Markdown block as Word paragraphs.
 *
 * Recursive for quotes and list items, because both hold blocks rather than text — a
 * quoted table and a list item with two paragraphs are both things a model writes.
 * `indent` is in twentieths of a point, which is the unit `w:ind` speaks.
 */
function wordBlock(block: MdBlock, indent = 0): string {
  const ind = indent ? `<w:ind w:left="${indent}"/>` : '';

  switch (block.kind) {
    case 'heading': {
      // Six levels of Markdown onto three of Word: below the third a heading is a
      // run-in label, and inventing three more styles to distinguish them would be
      // three styles nobody looks at.
      const level = Math.min(block.level, 3);
      return para(runs(block.tokens), `<w:pStyle w:val="Heading${level}"/>${ind}`);
    }

    case 'paragraph':
      return para(runs(block.tokens), ind);

    case 'code':
      // One paragraph per line: a single paragraph with `w:br` between lines is one
      // block to a screen reader and cannot be selected line by line.
      return block.code
        .split('\n')
        .map((line) => para(run(line || ' ', { mono: true }), `<w:pStyle w:val="Code"/><w:ind w:left="${indent + 240}"/>`))
        .join('');

    case 'math':
      return para(run(block.latex, { mono: true }), `<w:pStyle w:val="Code"/>${ind}`);

    case 'quote':
      return block.blocks.map((inner) => wordBlock(inner, indent + 480)).join('');

    case 'list':
      return block.items
        .map((item, index) => {
          const marker = block.ordered ? `${block.start + index}.` : '•';
          const box = item.checked === undefined ? '' : item.checked ? '[x] ' : '[ ] ';
          const [first, ...rest] = item.blocks;
          // The marker joins the item's *first* paragraph rather than becoming a
          // paragraph of its own, or every bullet would sit on a line above its text.
          const head =
            first && first.kind === 'paragraph'
              ? para(run(`${marker} ${box}`, {}) + runs(first.tokens), `<w:ind w:left="${indent + 360}"/>`)
              : para(run(marker, {}), `<w:ind w:left="${indent + 360}"/>`) + (first ? wordBlock(first, indent + 720) : '');
          return head + rest.map((inner) => wordBlock(inner, indent + 720)).join('');
        })
        .join('');

    case 'table': {
      const head = `<w:tr><w:trPr><w:tblHeader/></w:trPr>${block.head
        .map((tokens) => cell(para(runs(tokens, { bold: true })), true))
        .join('')}</w:tr>`;
      const body = block.rows
        .map((row) => `<w:tr>${row.map((tokens) => cell(para(runs(tokens)), false)).join('')}</w:tr>`)
        .join('');
      return `<w:tbl><w:tblPr><w:tblW w:w="0" w:type="auto"/><w:tblBorders>${TABLE_BORDER}</w:tblBorders></w:tblPr>${head}${body}</w:tbl>${para('')}`;
    }

    case 'rule':
      return para('', '<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="BFBFBF"/></w:pBdr>');
  }
}

/**
 * One heading style. Sizes are half-points, so `w:sz="32"` is 16pt.
 *
 * `w:outlineLvl` is the part that matters beyond looks: it is what puts the heading in
 * the document outline, which is how a screen reader and Word's own navigation pane
 * find their way around. A paragraph that is merely bold and large is not a heading.
 */
function headingStyle(level: 1 | 2 | 3, size: number): string {
  return (
    `<w:style w:type="paragraph" w:styleId="Heading${level}">` +
    `<w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:qFormat/>` +
    `<w:pPr><w:keepNext/><w:spacing w:before="240" w:after="120"/><w:outlineLvl w:val="${level - 1}"/></w:pPr>` +
    `<w:rPr><w:b/><w:sz w:val="${size}"/></w:rPr></w:style>`
  );
}

/**
 * The style sheet: only what the writer above refers to.
 *
 * A `w:pStyle` pointing at a style that is not defined here is silently ignored, which
 * is how a document of headings comes out as one flat wall of body text — so this part
 * is not optional decoration.
 */
const WORD_STYLES =
  `${DECL}<w:styles xmlns:w="${NS_W}">` +
  '<w:docDefaults><w:rPrDefault><w:rPr>' +
  '<w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/>' +
  '</w:rPr></w:rPrDefault><w:pPrDefault><w:pPr>' +
  '<w:spacing w:after="120" w:line="276" w:lineRule="auto"/>' +
  '</w:pPr></w:pPrDefault></w:docDefaults>' +
  '<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>' +
  headingStyle(1, 32) +
  headingStyle(2, 26) +
  headingStyle(3, 24) +
  '<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="HTML Preformatted"/>' +
  '<w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr>' +
  '<w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas" w:cs="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>' +
  '</w:styles>';

/** A `.docx`: the manifest, two relationship parts, the styles and the body. */
function docx(blocks: readonly MdBlock[]): Uint8Array {
  const body = blocks.map((block) => wordBlock(block)).join('');
  // A4 with 20mm margins, in twentieths of a point. `w:sectPr` closes the body and is
  // where the page itself is described; without it a reader picks its own paper size.
  const section =
    '<w:sectPr><w:pgSz w:w="11906" w:h="16838"/>' +
    '<w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="708" w:footer="708" w:gutter="0"/>' +
    '</w:sectPr>';

  return pack({
    '[Content_Types].xml': contentTypes([
      { part: '/word/document.xml', type: `${OFFICE_FORMAT_TYPES.docx}.main+xml` },
      {
        part: '/word/styles.xml',
        type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml',
      },
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'officeDocument', target: 'word/document.xml' }]),
    'word/_rels/document.xml.rels': rels([{ id: 'rId1', type: 'styles', target: 'styles.xml' }]),
    'word/styles.xml': WORD_STYLES,
    'word/document.xml': `${DECL}<w:document xmlns:w="${NS_W}"><w:body>${body}${section}</w:body></w:document>`,
  });
}

/* ------------------------------------------------------------------------- */
/* Blocks as lines, for the two formats that are not a document               */
/* ------------------------------------------------------------------------- */

/** A line of text and how deeply it was nested. A bullet to pptx, a row to xlsx. */
interface Line {
  text: string;
  level: number;
}

/**
 * One block flattened to lines, keeping only the nesting.
 *
 * Neither a slide nor a cell has anywhere to put bold, so `inlineText` — which the
 * Markdown renderer already uses for exactly this — is the whole of the conversion. The
 * nesting is kept because it is the one piece of structure both formats can express: a
 * bullet level in pptx, an indent in xlsx.
 */
function blockLines(block: MdBlock, level = 0): Line[] {
  switch (block.kind) {
    case 'heading':
    case 'paragraph':
      return [{ text: inlineText(block.tokens), level }];

    case 'code':
      return block.code.split('\n').map((text) => ({ text, level }));

    case 'math':
      return [{ text: block.latex, level }];

    case 'quote':
      return block.blocks.flatMap((inner) => blockLines(inner, level));

    case 'list':
      return block.items.flatMap((item, index) => {
        // A number is written into the text; an unordered marker is not, because pptx
        // draws its own and a spreadsheet wants neither.
        const marker = block.ordered ? `${block.start + index}. ` : '';
        const inner = item.blocks.flatMap((inside, position) => blockLines(inside, level + (position === 0 ? 0 : 1)));
        const [first, ...rest] = inner;
        return first ? [{ text: `${marker}${first.text}`, level: first.level }, ...rest] : [];
      });

    case 'table':
      // Only reachable for a table nested inside a quote or a list item, since a
      // top-level one becomes a sheet of its own.
      return [block.head, ...block.rows].map((row) => ({ text: row.map(inlineText).join(' | '), level }));

    case 'rule':
      return [];
  }
}

/* ------------------------------------------------------------------------- */
/* Excel                                                                      */
/* ------------------------------------------------------------------------- */

const NS_S = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';

/** `0 → A`, `25 → Z`, `26 → AA`. Columns are bijective base-26, which has no zero. */
function columnName(index: number): string {
  let name = '';
  for (let n = index + 1; n > 0; n = Math.floor((n - 1) / 26)) {
    name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  }
  return name;
}

/**
 * A cell that is a number, rather than one that merely looks like one.
 *
 * Deliberately narrow: `1,200` and `$4.50` and `35%` stay text. Each would need a
 * number format in `styles.xml` to survive the round trip, and a cell that silently
 * became `0.35` when it said `35%` is worse than one that cannot be summed.
 * `ponytail: plain numbers only, add numFmts when a caller needs currency.`
 */
const NUMERIC = /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;

/**
 * One cell. Emitted from the *original* text, never a reparsed number, so a 20-digit
 * account number keeps every digit instead of being rounded by a float.
 */
function xlsxCell(ref: string, raw: string, header: boolean): string {
  const text = raw.trim();
  if (!text) return ''; // An absent cell and an empty one look the same and one is shorter.
  const style = header ? ' s="1"' : '';
  if (!header && NUMERIC.test(text)) return `<c r="${ref}"${style}><v>${text}</v></c>`;
  // `inlineStr` rather than the shared-strings table: one part fewer, and the table only
  // pays off when the same string repeats, which a generated sheet's rarely do.
  return `<c r="${ref}"${style} t="inlineStr"><is><t xml:space="preserve">${xml(raw)}</t></is></c>`;
}

/** One sheet. `sheetViews` precedes `sheetData`, per `CT_Worksheet`. */
function worksheet(rows: readonly (readonly string[])[], header: boolean): string {
  const data = rows
    .map((row, r) => {
      const cells = row.map((text, c) => xlsxCell(`${columnName(c)}${r + 1}`, text, header && r === 0)).join('');
      return cells ? `<row r="${r + 1}">${cells}</row>` : '';
    })
    .join('');
  // The frozen header is the one spreadsheet affordance worth four attributes: a table
  // whose header scrolls away is one you keep scrolling back up in.
  const view = header
    ? '<sheetViews><sheetView workbookViewId="0">' +
      '<pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/>' +
      '</sheetView></sheetViews>'
    : '';
  return `${DECL}<worksheet xmlns="${NS_S}">${view}<sheetData>${data}</sheetData></worksheet>`;
}

/** The five characters Excel will not have in a tab name, plus the apostrophe rule. */
const SHEET_FORBIDDEN = new RegExp('[\\[\\]:*?/\\\\]', 'g');

/**
 * A heading turned into a tab name Excel will accept.
 *
 * Excel does not report which rule a workbook broke — it offers to repair the file and
 * throws the sheet away — so all four are applied here: 31 characters, none of
 * `[]:*?/\`, no leading or trailing apostrophe, and no two sheets alike. The duplicate
 * case is not exotic: two tables under one repeated heading is the normal shape of a
 * report.
 */
function sheetName(raw: string, taken: Set<string>): string {
  const clean = raw.replace(SHEET_FORBIDDEN, ' ').replace(/\s+/g, ' ').trim().slice(0, 31);
  let name = clean.replace(/^'+|'+$/g, '').trim() || 'Sheet';
  if (taken.has(name.toLowerCase())) {
    for (let n = 2; ; n += 1) {
      const suffix = ` (${n})`;
      const candidate = name.slice(0, 31 - suffix.length).trim() + suffix;
      if (!taken.has(candidate.toLowerCase())) {
        name = candidate;
        break;
      }
    }
  }
  taken.add(name.toLowerCase());
  return name;
}

/**
 * Two fonts and the bold header that uses the second.
 *
 * `fills` has two entries because Excel requires it: index 1 must be `gray125` or the
 * workbook is reported as corrupt, whether or not anything refers to it. The rest is the
 * shortest chain that makes `s="1"` mean bold — `cellXfs` is what a cell's `s` indexes.
 */
const SHEET_STYLES =
  `${DECL}<styleSheet xmlns="${NS_S}">` +
  '<fonts count="2">' +
  '<font><sz val="11"/><name val="Calibri"/></font>' +
  '<font><b/><sz val="11"/><name val="Calibri"/></font>' +
  '</fonts>' +
  '<fills count="2">' +
  '<fill><patternFill patternType="none"/></fill>' +
  '<fill><patternFill patternType="gray125"/></fill>' +
  '</fills>' +
  '<borders count="1"><border/></borders>' +
  '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>' +
  '<cellXfs count="2">' +
  '<xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>' +
  '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>' +
  '</cellXfs>' +
  '</styleSheet>';

/** An `.xlsx`: one sheet per Markdown table, named after the heading above it. */
function xlsx(blocks: readonly MdBlock[]): Uint8Array {
  const taken = new Set<string>();
  const found: { name: string; rows: string[][]; header: boolean }[] = [];
  let heading = '';

  for (const block of blocks) {
    if (block.kind === 'heading') heading = inlineText(block.tokens);
    if (block.kind !== 'table') continue;
    found.push({
      name: sheetName(heading, taken),
      rows: [block.head.map(inlineText), ...block.rows.map((row) => row.map(inlineText))],
      header: true,
    });
  }

  // Prose is not a spreadsheet. One column of lines is a poor spreadsheet and an honest
  // record of what was written, which beats a tool call that failed on the user.
  if (found.length === 0) {
    found.push({
      name: sheetName('Document', taken),
      rows: blocks
        .flatMap((block) => blockLines(block))
        .filter((line) => line.text.trim())
        .map((line) => [`${'    '.repeat(line.level)}${line.text}`]),
      header: false,
    });
  }

  const parts: Record<string, string> = {
    '[Content_Types].xml': contentTypes([
      { part: '/xl/workbook.xml', type: `${OFFICE_FORMAT_TYPES.xlsx}.main+xml` },
      { part: '/xl/styles.xml', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml' },
      ...found.map((_, index) => ({
        part: `/xl/worksheets/sheet${index + 1}.xml`,
        type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml',
      })),
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'officeDocument', target: 'xl/workbook.xml' }]),
    'xl/_rels/workbook.xml.rels': rels([
      ...found.map((_, index) => ({
        id: `rId${index + 1}`,
        type: 'worksheet',
        target: `worksheets/sheet${index + 1}.xml`,
      })),
      { id: `rId${found.length + 1}`, type: 'styles', target: 'styles.xml' },
    ]),
    'xl/styles.xml': SHEET_STYLES,
    'xl/workbook.xml':
      `${DECL}<workbook xmlns="${NS_S}" xmlns:r="${NS_ODR}"><sheets>` +
      found
        .map((sheet, index) => `<sheet name="${xml(sheet.name)}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`)
        .join('') +
      '</sheets></workbook>',
  };
  for (const [index, sheet] of found.entries()) {
    parts[`xl/worksheets/sheet${index + 1}.xml`] = worksheet(sheet.rows, sheet.header);
  }
  return pack(parts);
}

/* ------------------------------------------------------------------------- */
/* PowerPoint                                                                 */
/* ------------------------------------------------------------------------- */

const NS_P = 'http://schemas.openxmlformats.org/presentationml/2006/main';

/**
 * The slide, in EMU — 914400 to the inch, so this is 13.333 × 7.5in, or 16:9.
 *
 * The boxes are positioned by hand rather than inherited from placeholders on the
 * layout. A layout with real placeholders means every slide carries an `idx` that has to
 * match it, and the reward is a text box in the same place this one puts it.
 */
const SLIDE = { w: 12192000, h: 6858000 } as const;
const TITLE_BOX = { x: 838200, y: 457200, cx: 10515600, cy: 1143000 } as const;
const BODY_BOX = { x: 838200, y: 1828800, cx: 10515600, cy: 4114800 } as const;

/**
 * The theme, which is not decoration: a slide master with no theme relationship is a
 * file PowerPoint offers to repair. `fmtScheme` needs exactly three entries in each of
 * its four lists, which is what the `repeat(3)` below is.
 */
const ACCENTS = ['4472C4', 'ED7D31', 'A5A5A5', 'FFC000', '5B9BD5', '70AD47'];

const THEME =
  `${DECL}<a:theme xmlns:a="${NS_A}" name="Office">` +
  '<a:themeElements><a:clrScheme name="Office">' +
  '<a:dk1><a:sysClr val="windowText" lastClr="000000"/></a:dk1>' +
  '<a:lt1><a:sysClr val="window" lastClr="FFFFFF"/></a:lt1>' +
  '<a:dk2><a:srgbClr val="44546A"/></a:dk2><a:lt2><a:srgbClr val="E7E6E6"/></a:lt2>' +
  ACCENTS.map((hex, index) => `<a:accent${index + 1}><a:srgbClr val="${hex}"/></a:accent${index + 1}>`).join('') +
  '<a:hlink><a:srgbClr val="0563C1"/></a:hlink><a:folHlink><a:srgbClr val="954F72"/></a:folHlink>' +
  '</a:clrScheme><a:fontScheme name="Office">' +
  '<a:majorFont><a:latin typeface="Calibri Light"/><a:ea typeface=""/><a:cs typeface=""/></a:majorFont>' +
  '<a:minorFont><a:latin typeface="Calibri"/><a:ea typeface=""/><a:cs typeface=""/></a:minorFont>' +
  '</a:fontScheme><a:fmtScheme name="Office">' +
  `<a:fillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:fillStyleLst>` +
  `<a:lnStyleLst>${'<a:ln w="6350"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill></a:ln>'.repeat(3)}</a:lnStyleLst>` +
  `<a:effectStyleLst>${'<a:effectStyle><a:effectLst/></a:effectStyle>'.repeat(3)}</a:effectStyleLst>` +
  `<a:bgFillStyleLst>${'<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>'.repeat(3)}</a:bgFillStyleLst>` +
  '</a:fmtScheme></a:themeElements></a:theme>';

/** The group shape every `p:spTree` opens with, empty. Required, and identical each time. */
const SP_TREE_HEAD =
  '<p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr>' +
  '<p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/>' +
  '<a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>';

const PML_NS = `xmlns:a="${NS_A}" xmlns:r="${NS_ODR}" xmlns:p="${NS_P}"`;

/**
 * The master, which exists to be pointed at.
 *
 * `p:clrMap` is the required part — it is what maps `bg1`/`tx1` onto the theme's
 * `lt1`/`dk1`, and without it every scheme colour on every slide is undefined.
 */
const SLIDE_MASTER =
  `${DECL}<p:sldMaster ${PML_NS}>` +
  `<p:cSld><p:spTree>${SP_TREE_HEAD}</p:spTree></p:cSld>` +
  '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" ' +
  'accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>' +
  '<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst>' +
  '</p:sldMaster>';

/** One layout, deliberately empty: the slides carry their own boxes. */
const SLIDE_LAYOUT =
  `${DECL}<p:sldLayout ${PML_NS} type="obj" preserve="1">` +
  `<p:cSld name="Title and Content"><p:spTree>${SP_TREE_HEAD}</p:spTree></p:cSld>` +
  '<p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>' +
  '</p:sldLayout>';

/** One text box. `sz` is hundredths of a point, so `3200` is 32pt. */
function textBox(
  id: number,
  name: string,
  box: { x: number; y: number; cx: number; cy: number },
  paragraphs: string,
): string {
  return (
    `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr txBox="1"/><p:nvPr/></p:nvSpPr>` +
    `<p:spPr><a:xfrm><a:off x="${box.x}" y="${box.y}"/><a:ext cx="${box.cx}" cy="${box.cy}"/></a:xfrm>` +
    '<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr>' +
    // `normAutofit` is what shrinks eleven bullets to fit rather than letting them run
    // off the bottom of the slide, which is where a generated deck usually goes wrong.
    `<p:txBody><a:bodyPr wrap="square"><a:normAutofit/></a:bodyPr><a:lstStyle/>${paragraphs}</p:txBody></p:sp>`
  );
}

/** One heading and what followed it. */
interface Slide {
  title: string;
  bullets: Line[];
}

/**
 * Headings become slides, and everything under one becomes its bullets.
 *
 * Prose before the first heading gets an untitled slide rather than being dropped, and a
 * document with no headings at all is that one slide — which is the right answer for a
 * short deck and honest about a long one.
 */
function slides(blocks: readonly MdBlock[]): Slide[] {
  const deck: Slide[] = [];
  let current: Slide = { title: '', bullets: [] };
  for (const block of blocks) {
    if (block.kind === 'heading') {
      if (current.title || current.bullets.length) deck.push(current);
      current = { title: inlineText(block.tokens), bullets: [] };
      continue;
    }
    current.bullets.push(...blockLines(block).filter((line) => line.text.trim()));
  }
  deck.push(current);
  return deck;
}

/** Bullets per slide before the rest spills onto a continuation. */
const MAX_BULLETS = 10;

/**
 * A long section split across slides.
 *
 * Autofit would otherwise shrink thirty bullets to something nobody can read from a
 * chair. Splitting is the only handling that keeps the text legible, and a `(cont.)`
 * title is how a person would have done it.
 */
function paginate(deck: readonly Slide[]): Slide[] {
  return deck.flatMap((slide) => {
    if (slide.bullets.length <= MAX_BULLETS) return [slide];
    const out: Slide[] = [];
    for (let at = 0; at < slide.bullets.length; at += MAX_BULLETS) {
      out.push({
        title: at === 0 ? slide.title : `${slide.title} (cont.)`,
        bullets: slide.bullets.slice(at, at + MAX_BULLETS),
      });
    }
    return out;
  });
}

/**
 * One slide's XML.
 *
 * The bullet character is set explicitly because an empty `a:lstStyle` on a text box
 * means no bullet at all — the list formatting a placeholder would have inherited from
 * the master is exactly what this deck does not use. `marL`/`indent` are the hanging
 * indent that keeps a wrapped bullet's second line clear of its own marker.
 */
function slideXml(slide: Slide): string {
  const title = slide.title
    ? textBox(
        2,
        'Title',
        TITLE_BOX,
        `<a:p><a:r><a:rPr lang="en-US" sz="3200" b="1"/><a:t>${xml(slide.title)}</a:t></a:r></a:p>`,
      )
    : '';
  const bullets = slide.bullets
    .map((line) => {
      const indent = 342900 * (line.level + 1);
      return (
        `<a:p><a:pPr lvl="${Math.min(line.level, 8)}" marL="${indent}" indent="-342900">` +
        '<a:buChar char="•"/></a:pPr>' +
        `<a:r><a:rPr lang="en-US" sz="1800"/><a:t>${xml(line.text)}</a:t></a:r></a:p>`
      );
    })
    .join('');
  const body = bullets ? textBox(3, 'Content', BODY_BOX, bullets) : '';
  return `${DECL}<p:sld ${PML_NS}><p:cSld><p:spTree>${SP_TREE_HEAD}${title}${body}</p:spTree></p:cSld></p:sld>`;
}

/** A `.pptx`: the master, one layout, the theme, and a slide per heading. */
function pptx(blocks: readonly MdBlock[]): Uint8Array {
  const deck = paginate(slides(blocks));
  const theme = 'application/vnd.openxmlformats-officedocument.theme+xml';
  const ml = 'application/vnd.openxmlformats-officedocument.presentationml';

  const parts: Record<string, string> = {
    '[Content_Types].xml': contentTypes([
      { part: '/ppt/presentation.xml', type: `${OFFICE_FORMAT_TYPES.pptx}.main+xml` },
      { part: '/ppt/slideMasters/slideMaster1.xml', type: `${ml}.slideMaster+xml` },
      { part: '/ppt/slideLayouts/slideLayout1.xml', type: `${ml}.slideLayout+xml` },
      { part: '/ppt/theme/theme1.xml', type: theme },
      ...deck.map((_, index) => ({ part: `/ppt/slides/slide${index + 1}.xml`, type: `${ml}.slide+xml` })),
    ]),
    '_rels/.rels': rels([{ id: 'rId1', type: 'officeDocument', target: 'ppt/presentation.xml' }]),
    // rId1 is the master and the slides follow it, because `p:sldMasterIdLst` and
    // `p:sldIdLst` below both index into this one list.
    'ppt/_rels/presentation.xml.rels': rels([
      { id: 'rId1', type: 'slideMaster', target: 'slideMasters/slideMaster1.xml' },
      ...deck.map((_, index) => ({
        id: `rId${index + 2}`,
        type: 'slide',
        target: `slides/slide${index + 1}.xml`,
      })),
      { id: `rId${deck.length + 2}`, type: 'theme', target: 'theme/theme1.xml' },
    ]),
    'ppt/slideMasters/slideMaster1.xml': SLIDE_MASTER,
    'ppt/slideMasters/_rels/slideMaster1.xml.rels': rels([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
      { id: 'rId2', type: 'theme', target: '../theme/theme1.xml' },
    ]),
    'ppt/slideLayouts/slideLayout1.xml': SLIDE_LAYOUT,
    'ppt/slideLayouts/_rels/slideLayout1.xml.rels': rels([
      { id: 'rId1', type: 'slideMaster', target: '../slideMasters/slideMaster1.xml' },
    ]),
    'ppt/theme/theme1.xml': THEME,
    'ppt/presentation.xml':
      `${DECL}<p:presentation ${PML_NS}>` +
      '<p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>' +
      `<p:sldIdLst>${deck.map((_, index) => `<p:sldId id="${256 + index}" r:id="rId${index + 2}"/>`).join('')}</p:sldIdLst>` +
      `<p:sldSz cx="${SLIDE.w}" cy="${SLIDE.h}"/><p:notesSz cx="6858000" cy="9144000"/>` +
      '</p:presentation>',
  };

  for (const [index, slide] of deck.entries()) {
    parts[`ppt/slides/slide${index + 1}.xml`] = slideXml(slide);
    parts[`ppt/slides/_rels/slide${index + 1}.xml.rels`] = rels([
      { id: 'rId1', type: 'slideLayout', target: '../slideLayouts/slideLayout1.xml' },
    ]);
  }
  return pack(parts);
}

/**
 * Markdown to an Office file.
 *
 * The one export. Pure — bytes out, nothing touched — which is what lets the zip be
 * opened and checked in Jest rather than on a device.
 */
export function officeDocument(markdown: string, format: OfficeFormat): Uint8Array {
  const blocks = parseMarkdown(markdown);
  if (format === 'xlsx') return xlsx(blocks);
  if (format === 'pptx') return pptx(blocks);
  return docx(blocks);
}










