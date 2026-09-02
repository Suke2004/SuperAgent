/**
 * Which files can be read here, and which can be written back.
 *
 * One thing is worth testing more than the mode itself: that `editable` is false for
 * every format whose text does not round-trip. An Office file that offered a Save button
 * would replace a real document with the flattened words `extractOffice` pulled out of
 * it, which is data loss dressed up as a feature.
 */

import { previewFor } from '@/chat/preview';

describe('previewFor', () => {
  it('reads the shapes of text this app writes', () => {
    for (const name of ['notes.md', 'report.txt', 'rows.csv', 'config.json', 'data.yaml', 'log.log']) {
      expect(previewFor(name)).toEqual({ mode: 'text', note: '', editable: true });
    }
  });

  it('renders the two things worth rendering, and lets their source be edited', () => {
    expect(previewFor('page.html')).toEqual({ mode: 'artifact', note: '', editable: true });
    expect(previewFor('chart.svg').mode).toBe('artifact');
    expect(previewFor('chart.svg').editable).toBe(true);
  });

  it('reads an Office file and refuses to pretend the text can be saved back', () => {
    for (const name of ['plan.docx', 'budget.xlsx', 'deck.pptx']) {
      const preview = previewFor(name);
      expect(preview.mode).toBe('office');
      // The one assertion that matters: no Save button over a lossy extraction.
      expect(preview.editable).toBe(false);
      expect(preview.note).toContain('cannot be edited here');
    }
  });

  it('hands a PDF to another app rather than showing an empty box', () => {
    const preview = previewFor('invoice.pdf');
    expect(preview.mode).toBe('handoff');
    expect(preview.editable).toBe(false);
    expect(preview.note).toContain('PDF');
  });

  it('hands over anything it does not recognise, and says why in general terms', () => {
    const preview = previewFor('archive.zip');
    expect(preview.mode).toBe('handoff');
    expect(preview.note).toContain('another app');
    expect(previewFor('').mode).toBe('handoff');
  });

  it('does not care how the extension was capitalised', () => {
    expect(previewFor('REPORT.MD').mode).toBe('text');
    expect(previewFor('Plan.DOCX').mode).toBe('office');
    expect(previewFor('Page.HTML').mode).toBe('artifact');
  });
});
