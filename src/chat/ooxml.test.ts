/**
 * The three zips, opened back up.
 *
 * A document that will not open is the only real failure mode here, and it is one no
 * amount of reading the source catches — the checks that matter are structural: the parts
 * a reader looks for exist, the relationship ids line up with what refers to them, and
 * text that arrived with an `&` or a stray control byte in it did not take the file down
 * with it. `unzipSync` is the same `fflate` the writer uses, so this is the file as Word
 * would find it, minus the schema validation no reader actually performs.
 */

import { strFromU8, unzipSync } from 'fflate';

import { officeDocument } from '@/chat/ooxml';
import type { OfficeFormat } from '@/chat/ooxml';

/** The zip as a map of path to text, which is what every assertion below wants. */
function open(markdown: string, format: OfficeFormat): Record<string, string> {
  const entries = unzipSync(officeDocument(markdown, format));
  const out: Record<string, string> = {};
  for (const [path, bytes] of Object.entries(entries)) out[path] = strFromU8(bytes);
  return out;
}

/** Every `r:id`/`Id` pairing a part relies on, so a renumbering cannot pass unnoticed. */
function relIds(rels: string): string[] {
  return [...rels.matchAll(/Id="([^"]+)"/g)].map((match) => match[1] ?? '');
}

/**
 * The bytes XML 1.0 cannot represent at all. Built from a string rather than written as a
 * literal, so this test file holds no control characters of its own — the same reason the
 * module under test does it that way.
 */
const CONTROL = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f]');

describe('docx', () => {
  const parts = open(
    ['# Title', '', 'Some **bold** and `code`.', '', '## Second', '', '- one', '- two', '', '> quoted'].join('\n'),
    'docx',
  );

  it('holds the parts a reader opens first', () => {
    expect(Object.keys(parts).sort()).toEqual(
      ['[Content_Types].xml', '_rels/.rels', 'word/_rels/document.xml.rels', 'word/document.xml', 'word/styles.xml'].sort(),
    );
  });

  it('declares every part it ships, because an undeclared one is a corrupt file', () => {
    const manifest = parts['[Content_Types].xml'] ?? '';
    expect(manifest).toContain('PartName="/word/document.xml"');
    expect(manifest).toContain('PartName="/word/styles.xml"');
    expect(manifest).toContain('Extension="rels"');
  });

  it('points the package at the document and the document at its styles', () => {
    expect(parts['_rels/.rels']).toContain('Target="word/document.xml"');
    expect(parts['word/_rels/document.xml.rels']).toContain('Target="styles.xml"');
  });

  it('closes the body with a page size, or the reader picks its own paper', () => {
    const body = parts['word/document.xml'] ?? '';
    expect(body).toContain('<w:sectPr>');
    expect(body).toContain('w:w="11906"');
    expect(body.indexOf('<w:sectPr>')).toBeGreaterThan(body.lastIndexOf('<w:p>'));
  });

  it('gives headings a real style, which is what puts them in the outline', () => {
    expect(parts['word/document.xml']).toContain('<w:pStyle w:val="Heading1"/>');
    expect(parts['word/document.xml']).toContain('<w:pStyle w:val="Heading2"/>');
    // The style has to exist as well: a `pStyle` naming nothing is silently ignored, and
    // `outlineLvl` is the half a screen reader uses.
    expect(parts['word/styles.xml']).toContain('w:styleId="Heading1"');
    expect(parts['word/styles.xml']).toContain('<w:outlineLvl w:val="0"/>');
  });

  it('flattens the three heading levels Word does not have', () => {
    const deep = open('#### four\n\n##### five', 'docx')['word/document.xml'] ?? '';
    expect(deep.match(/Heading3/g)).toHaveLength(2);
  });

  it('carries emphasis as runs, in the order the schema lists', () => {
    const body = parts['word/document.xml'] ?? '';
    expect(body).toContain('<w:rPr><w:b/></w:rPr>');
    expect(body).toContain('w:ascii="Consolas"');
    const nested = open('***both***', 'docx')['word/document.xml'] ?? '';
    expect(nested).toContain('<w:rPr><w:b/><w:i/></w:rPr>');
  });

  it('writes a literal bullet and a literal number, having no numbering part', () => {
    expect(parts['word/document.xml']).toContain('•');
    expect(open('3. third\n4. fourth', 'docx')['word/document.xml']).toContain('3. ');
  });

  it('marks a task item with its box', () => {
    const body = open('- [x] done\n- [ ] not', 'docx')['word/document.xml'] ?? '';
    expect(body).toContain('[x] ');
    expect(body).toContain('[ ] ');
  });

  it('builds a table with a repeating header row', () => {
    const body = open('| a | b |\n| - | - |\n| 1 | 2 |', 'docx')['word/document.xml'] ?? '';
    expect(body).toContain('<w:tblHeader/>');
    expect(body.match(/<w:tr>/g)).toHaveLength(2);
    expect(body.match(/<w:tc>/g)).toHaveLength(4);
  });

  it('splits a code block into one paragraph per line, so it can be read line by line', () => {
    const body = open('```js\nconst a = 1;\nconst b = 2;\n```', 'docx')['word/document.xml'] ?? '';
    expect(body.match(/<w:pStyle w:val="Code"\/>/g)).toHaveLength(2);
  });

  it('writes a link’s address after its text, having no hyperlink relationship', () => {
    const body = open('[docs](https://example.com/a)', 'docx')['word/document.xml'] ?? '';
    expect(body).toContain('docs');
    expect(body).toContain('https://example.com/a');
    expect(parts['word/_rels/document.xml.rels']).not.toContain('hyperlink');
  });
});

describe('escaping, which is the difference between a file and a corrupt file', () => {
  it('escapes the five entities everywhere text can go', () => {
    for (const format of ['docx', 'xlsx', 'pptx'] as const) {
      const parts = open('# a & b <c> "d"\n\n| & | < |\n| - | - |\n| > | " |', format);
      for (const [path, text] of Object.entries(parts)) {
        // Every part is well formed enough that no bare `&` survives outside an entity.
        expect(text.replace(/&(?:amp|lt|gt|quot|apos|#\d+);/g, '')).not.toContain('&');
        expect(path).toBeTruthy();
      }
    }
  });

  it('drops the control bytes XML 1.0 has no escape for at all', () => {
    // A model echoing a byte out of a binary file must not produce a document that no
    // reader will open — there is no numeric reference for these, so they go.
    const hostile = `head${String.fromCharCode(0, 7, 27)}tail`;
    for (const format of ['docx', 'xlsx', 'pptx'] as const) {
      const joined = Object.values(open(hostile, format)).join('');
      expect(joined).toContain('headtail');
      expect(CONTROL.test(joined)).toBe(false);
    }
  });
});

describe('xlsx', () => {
  const markdown = [
    '# Revenue',
    '',
    '| Region | Amount |',
    '| - | - |',
    '| North | 1200.5 |',
    '| South | -3 |',
    '| East | 1,200 |',
    '',
    '# Revenue',
    '',
    '| x | y |',
    '| - | - |',
    '| 1 | 2 |',
  ].join('\n');
  const parts = open(markdown, 'xlsx');

  it('ships the workbook, its styles and one sheet per table', () => {
    expect(Object.keys(parts).sort()).toEqual([
      '[Content_Types].xml',
      '_rels/.rels',
      'xl/_rels/workbook.xml.rels',
      'xl/styles.xml',
      'xl/workbook.xml',
      'xl/worksheets/sheet1.xml',
      'xl/worksheets/sheet2.xml',
    ]);
  });

  it('numbers the sheet relationships so every r:id resolves', () => {
    expect(relIds(parts['xl/_rels/workbook.xml.rels'] ?? '')).toEqual(['rId1', 'rId2', 'rId3']);
    expect(parts['xl/workbook.xml']).toContain('r:id="rId1"');
    expect(parts['xl/workbook.xml']).toContain('r:id="rId2"');
  });

  it('names each tab after the heading above it, and cannot repeat a name', () => {
    const workbook = parts['xl/workbook.xml'] ?? '';
    expect(workbook).toContain('name="Revenue"');
    // Excel discards a duplicate rather than saying which rule broke.
    expect(workbook).toContain('name="Revenue (2)"');
  });

  it('keeps a tab name inside the four rules Excel enforces silently', () => {
    const long = `# ${'ratio/of:things*'.repeat(6)}\n\n| a |\n| - |\n| 1 |`;
    const name = /name="([^"]*)"/.exec(open(long, 'xlsx')['xl/workbook.xml'] ?? '')?.[1] ?? '';
    expect(name.length).toBeLessThanOrEqual(31);
    expect(name).not.toMatch(/[[\]:*?/\\]/);
    expect(name.trim()).toBe(name);
  });

  it('makes a number a number and leaves everything else text', () => {
    const sheet = parts['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('<v>1200.5</v>');
    expect(sheet).toContain('<v>-3</v>');
    // `1,200` would become 1 to a naive parse, so it stays the string it was written as.
    expect(sheet).toContain('1,200');
    expect(sheet).not.toContain('<v>1,200</v>');
    expect(sheet).not.toContain('<v>North</v>');
  });

  it('writes a number as it was typed, not as a float that has been through JS', () => {
    const big = open('| id |\n| - |\n| 12345678901234567890 |', 'xlsx')['xl/worksheets/sheet1.xml'] ?? '';
    expect(big).toContain('<v>12345678901234567890</v>');
  });

  it('freezes the header row and keeps sheetViews before sheetData', () => {
    const sheet = parts['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('state="frozen"');
    expect(sheet.indexOf('<sheetViews>')).toBeLessThan(sheet.indexOf('<sheetData>'));
  });

  it('addresses cells bijectively, so the 27th column is AA and not Z1', () => {
    const wide = `| ${Array.from({ length: 28 }, (_, i) => `c${i}`).join(' | ')} |\n| ${'- | '.repeat(28)}\n| ${'1 | '.repeat(28)}`;
    const sheet = open(wide, 'xlsx')['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('r="Z1"');
    expect(sheet).toContain('r="AA1"');
    expect(sheet).toContain('r="AB1"');
  });

  it('gives prose a single column rather than failing the call', () => {
    const prose = open('# Notes\n\nFirst line.\n\n- a nested\n  - deeper', 'xlsx');
    expect(Object.keys(prose)).toContain('xl/worksheets/sheet1.xml');
    expect(Object.keys(prose)).not.toContain('xl/worksheets/sheet2.xml');
    const sheet = prose['xl/worksheets/sheet1.xml'] ?? '';
    expect(sheet).toContain('First line.');
    expect(sheet).not.toContain('state="frozen"');
  });

  it('keeps the two fills Excel requires even though nothing refers to the second', () => {
    expect(parts['xl/styles.xml']).toContain('gray125');
    expect(parts['xl/styles.xml']).toContain('<cellXfs count="2">');
  });
});

describe('pptx', () => {
  const parts = open(['# One', '', 'first point', '', '# Two', '', '- a', '- b'].join('\n'), 'pptx');

  it('ships the whole master → layout → theme chain, which is not optional', () => {
    for (const path of [
      'ppt/presentation.xml',
      'ppt/_rels/presentation.xml.rels',
      'ppt/slideMasters/slideMaster1.xml',
      'ppt/slideMasters/_rels/slideMaster1.xml.rels',
      'ppt/slideLayouts/slideLayout1.xml',
      'ppt/slideLayouts/_rels/slideLayout1.xml.rels',
      'ppt/theme/theme1.xml',
      'ppt/slides/slide1.xml',
      'ppt/slides/_rels/slide1.xml.rels',
    ]) {
      expect(Object.keys(parts)).toContain(path);
    }
  });

  it('maps scheme colours on the master, or every colour on every slide is undefined', () => {
    expect(parts['ppt/slideMasters/slideMaster1.xml']).toContain('<p:clrMap bg1="lt1" tx1="dk1"');
    expect(parts['ppt/slideMasters/_rels/slideMaster1.xml.rels']).toContain('theme1.xml');
  });

  it('gives fmtScheme exactly the three entries per list the schema demands', () => {
    const theme = parts['ppt/theme/theme1.xml'] ?? '';
    expect(theme.match(/<a:ln w="6350">/g)).toHaveLength(3);
    expect(theme.match(/<a:effectStyle>/g)).toHaveLength(3);
    expect(theme.match(/<a:accent\d>/g)).toHaveLength(6);
  });

  it('lists the master first so the slide ids that follow it line up', () => {
    const rels = parts['ppt/_rels/presentation.xml.rels'] ?? '';
    expect(relIds(rels)).toEqual(['rId1', 'rId2', 'rId3', 'rId4']);
    expect(rels).toContain('Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slideMaster"');
    const deck = parts['ppt/presentation.xml'] ?? '';
    expect(deck).toContain('<p:sldMasterId id="2147483648" r:id="rId1"/>');
    expect(deck).toContain('<p:sldId id="256" r:id="rId2"/>');
    expect(deck).toContain('<p:sldId id="257" r:id="rId3"/>');
  });

  it('is 16:9, and says how big a note is because the schema requires it', () => {
    expect(parts['ppt/presentation.xml']).toContain('<p:sldSz cx="12192000" cy="6858000"/>');
    expect(parts['ppt/presentation.xml']).toContain('<p:notesSz');
  });

  it('turns each heading into a slide and what follows it into bullets', () => {
    expect(parts['ppt/slides/slide1.xml']).toContain('<a:t>One</a:t>');
    expect(parts['ppt/slides/slide1.xml']).toContain('<a:t>first point</a:t>');
    expect(parts['ppt/slides/slide2.xml']).toContain('<a:t>Two</a:t>');
    expect(parts['ppt/slides/slide2.xml']).toContain('<a:t>a</a:t>');
    expect(Object.keys(parts)).not.toContain('ppt/slides/slide3.xml');
  });

  it('draws its own bullet, since an empty lstStyle on a text box inherits none', () => {
    expect(parts['ppt/slides/slide2.xml']).toContain('<a:buChar char="•"/>');
    expect(parts['ppt/slides/slide2.xml']).toContain('indent="-342900"');
  });

  it('indents a nested item one level deeper', () => {
    const nested = open('# T\n\n- top\n  - under', 'pptx')['ppt/slides/slide1.xml'] ?? '';
    expect(nested).toContain('lvl="0"');
    expect(nested).toContain('lvl="1"');
  });

  it('spills a long section onto a continuation rather than shrinking it to nothing', () => {
    const long = `# Long\n\n${Array.from({ length: 23 }, (_, i) => `- point ${i}`).join('\n')}`;
    const spilled = open(long, 'pptx');
    expect(Object.keys(spilled)).toContain('ppt/slides/slide3.xml');
    expect(Object.keys(spilled)).not.toContain('ppt/slides/slide4.xml');
    expect(spilled['ppt/slides/slide2.xml']).toContain('<a:t>Long (cont.)</a:t>');
  });

  it('keeps prose that arrived before the first heading, on a slide with no title', () => {
    const untitled = open('Opening line.\n\n# Later', 'pptx');
    expect(untitled['ppt/slides/slide1.xml']).toContain('<a:t>Opening line.</a:t>');
    expect(untitled['ppt/slides/slide1.xml']).not.toContain('name="Title"');
    expect(untitled['ppt/slides/slide2.xml']).toContain('<a:t>Later</a:t>');
  });

  it('is still a deck when there is nothing to put in it', () => {
    // A presentation with no slides is not a presentation any reader will open.
    const empty = open('', 'pptx');
    expect(Object.keys(empty)).toContain('ppt/slides/slide1.xml');
    expect(empty['ppt/presentation.xml']).toContain('<p:sldId id="256"');
  });
});
