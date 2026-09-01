/**
 * Office extraction, against archives built in the test.
 *
 * Real `.docx`/`.xlsx` bytes cannot be committed usefully — a fixture nobody can read
 * in a diff — so each case zips the two or three parts that matter. That is also the
 * point: the parts are what the extractor claims to understand, and a case here is a
 * statement about one of them.
 */

import { strToU8, zipSync } from 'fflate';

import { columnIndex, extractOffice, isOfficeDocument, officeKind } from '@/chat/office';

function archive(files: Record<string, string>): Uint8Array {
  const entries: Record<string, Uint8Array> = {};
  for (const [path, text] of Object.entries(files)) entries[path] = strToU8(text);
  return zipSync(entries);
}

const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document';

describe('officeKind', () => {
  it('takes the media type when the system gave one', () => {
    expect(officeKind(DOCX_TYPE)).toBe('docx');
  });

  it('falls back to the extension, which is what Android usually leaves', () => {
    // Document providers routinely report `application/octet-stream` for a real file.
    expect(officeKind('application/octet-stream', 'Q3 numbers.xlsx')).toBe('xlsx');
    expect(officeKind(undefined, 'deck.PPTX')).toBe('pptx');
  });

  it('is not fooled by a name that only contains the word', () => {
    expect(officeKind('text/plain', 'notes-about-docx.txt')).toBeUndefined();
    expect(isOfficeDocument('application/pdf', 'paper.pdf')).toBe(false);
  });
});

describe('docx', () => {
  it('reads runs in order, one line per paragraph', () => {
    const bytes = archive({
      'word/document.xml':
        '<?xml version="1.0"?><w:document><w:body>' +
        '<w:p><w:r><w:t>Hello</w:t></w:r><w:r><w:t xml:space="preserve"> world</w:t></w:r></w:p>' +
        '<w:p><w:r><w:t>Second</w:t></w:r></w:p>' +
        '</w:body></w:document>',
    });
    expect(extractOffice(bytes, 'docx')).toBe('Hello world\nSecond');
  });

  it('keeps tabs and breaks, and decodes entities', () => {
    const bytes = archive({
      'word/document.xml':
        '<w:body><w:p><w:r><w:t>a</w:t></w:r><w:r><w:tab/><w:t>b</w:t><w:br/><w:t>Ben &amp; co &#8212; ok</w:t></w:r></w:p></w:body>',
    });
    expect(extractOffice(bytes, 'docx')).toBe('a\tb\nBen & co — ok');
  });

  it('does not lose the rest of a paragraph to a nested one', () => {
    // A text box puts a `w:p` inside a `w:p`. A non-greedy pair match ends the outer
    // paragraph at the inner close tag and drops everything after it.
    const bytes = archive({
      'word/document.xml':
        '<w:body><w:p><w:r><w:t>before</w:t></w:r>' +
        '<w:txbxContent><w:p><w:r><w:t>inside</w:t></w:r></w:p></w:txbxContent>' +
        '<w:r><w:t>after</w:t></w:r></w:p></w:body>',
    });
    expect(extractOffice(bytes, 'docx')).toBe('before\ninside\nafter');
  });

  it('is empty rather than broken when the document part is missing', () => {
    expect(extractOffice(archive({ 'docProps/app.xml': '<Properties/>' }), 'docx')).toBe('');
  });

  it('throws on bytes that are not a zip, which is a read failure and not an empty file', () => {
    expect(() => extractOffice(strToU8('this is a text file, renamed'), 'docx')).toThrow();
  });
});

describe('xlsx', () => {
  const workbook =
    '<workbook><sheets><sheet name="Sales &amp; VAT" sheetId="1" r:id="rId1"/>' +
    '<sheet name="Notes" sheetId="2" r:id="rId2"/></sheets></workbook>';
  const rels =
    '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/>' +
    '<Relationship Id="rId2" Target="worksheets/sheet2.xml"/></Relationships>';
  const strings =
    '<sst count="3"><si><t>Region</t></si><si><t>Total</t></si>' +
    '<si><r><t>Nor</t></r><r><t>th</t></r></si></sst>';

  it('names each sheet, resolves shared strings and keeps the columns lined up', () => {
    const bytes = archive({
      'xl/workbook.xml': workbook,
      'xl/_rels/workbook.xml.rels': rels,
      'xl/sharedStrings.xml': strings,
      'xl/worksheets/sheet1.xml':
        '<worksheet><sheetData>' +
        '<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row>' +
        // C skips B: a blank cell is omitted from the file entirely, and a row read
        // positionally would shift 42 one column left.
        '<row r="2"><c r="A2" t="s"><v>2</v></c><c r="C2"><v>42</v></c></row>' +
        '</sheetData></worksheet>',
      'xl/worksheets/sheet2.xml':
        '<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Draft</t></is></c>' +
        '<c r="B1" t="b"><v>1</v></c></row></sheetData></worksheet>',
    });

    expect(extractOffice(bytes, 'xlsx')).toBe(
      '## Sales & VAT\nRegion\tTotal\nNorth\t\t42\n\n## Notes\nDraft\tTRUE',
    );
  });

  it('reads the sheets even when the workbook part is missing', () => {
    // Ordered by the number in the name, so sheet10 does not sort between 1 and 2.
    const bytes = archive({
      'xl/worksheets/sheet2.xml': '<sheetData><row><c r="A1"><v>2</v></c></row></sheetData>',
      'xl/worksheets/sheet10.xml': '<sheetData><row><c r="A1"><v>10</v></c></row></sheetData>',
      'xl/worksheets/sheet1.xml': '<sheetData><row><c r="A1"><v>1</v></c></row></sheetData>',
    });
    expect(extractOffice(bytes, 'xlsx')).toBe('## Sheet 1\n1\n\n## Sheet 2\n2\n\n## Sheet 3\n10');
  });

  it('drops rows that hold nothing', () => {
    const bytes = archive({
      'xl/worksheets/sheet1.xml':
        '<sheetData><row r="1"><c r="A1"><v>1</v></c></row><row r="2"/>' +
        '<row r="3"><c r="A3" t="s"><v>9</v></c></row></sheetData>',
    });
    expect(extractOffice(bytes, 'xlsx')).toBe('## Sheet 1\n1');
  });
});

describe('pptx', () => {
  it('numbers the slides and reads the text frames', () => {
    const bytes = archive({
      'ppt/slides/slide1.xml':
        '<p:sld><p:cSld><p:spTree><p:sp><p:txBody><a:p><a:r><a:t>Title</a:t></a:r></a:p>' +
        '<a:p><a:r><a:t>One</a:t></a:r><a:br/><a:r><a:t>Two</a:t></a:r></a:p></p:txBody></p:sp></p:spTree></p:cSld></p:sld>',
      'ppt/slides/slide2.xml': '<p:sld><a:p><a:r><a:t>Thanks</a:t></a:r></a:p></p:sld>',
      // Layouts and masters carry boilerplate text; only the slides are read.
      'ppt/slideLayouts/slideLayout1.xml': '<a:p><a:r><a:t>Click to edit</a:t></a:r></a:p>',
    });
    const text = extractOffice(bytes, 'pptx');
    expect(text).toBe('## Slide 1\nTitle\nOne\nTwo\n\n## Slide 2\nThanks');
    expect(text).not.toContain('Click to edit');
  });
});

describe('columnIndex', () => {
  it('reads a spreadsheet column reference', () => {
    expect(columnIndex('A1')).toBe(0);
    expect(columnIndex('Z9')).toBe(25);
    expect(columnIndex('AA1')).toBe(26);
    expect(columnIndex('AB12')).toBe(27);
  });
});
