/**
 * What a generated file can be shown as, decided from its name.
 *
 * The files list used to offer Share and Delete, which means the only way to find out
 * what is in a file this app wrote was to send it to another app. This module is the
 * question that has to be answered before any of that: whether the file can be *read*
 * here, whether it can be *rendered*, and whether an edit could be saved back without
 * losing something.
 *
 * The decision is by name alone and on purpose — it runs before the file is opened, so a
 * 30 MB PDF is never read into memory to discover that nothing on the device can display
 * it. Every branch reuses the predicate that already owns that question: `officeKind`
 * from the reading side, `artifactKindForFile` from the artifact renderer,
 * `isTextualDocument` from the attachment pipeline. Nothing here re-decides what a `.md`
 * is.
 */

import { artifactKindForFile } from '@/chat/artifact';
import { isTextualDocument, mediaTypeFor } from '@/chat/attachments';
import { officeKind } from '@/chat/office';

/**
 * How a file is shown.
 *
 *  - `text` — the bytes are text, so they go in a box the user can also type in.
 *  - `artifact` — text *and* renderable, so it gets the sandboxed preview as well.
 *  - `office` — a zip of XML this app can read the words out of, but not write back.
 *  - `handoff` — nothing here can show it; the share sheet takes it somewhere that can.
 */
export type PreviewMode = 'text' | 'artifact' | 'office' | 'handoff';

export interface Preview {
  mode: PreviewMode;
  /** What the view says about its own limits. Empty when there is nothing to warn about. */
  note: string;
  /** Whether an edit made here can be saved back over the file it came from. */
  editable: boolean;
}

/**
 * The mode, the caveat and whether editing is honest.
 *
 * `editable` is false for an Office file for a reason worth stating plainly rather than
 * discovering: `extractOffice` returns the *words*, not the document — no styles, no
 * table structure, no slide boundaries — so saving that text back would silently replace
 * a real `.docx` with a flattened transcript of itself. A read-only view that says so is
 * the honest version of that feature.
 */
export function previewFor(name: string): Preview {
  if (officeKind(undefined, name)) {
    return {
      mode: 'office',
      note: 'Showing the text this file contains. Formatting, sheets and slides are not shown, so it cannot be edited here — open it in Word, Excel or PowerPoint to change it.',
      editable: false,
    };
  }
  if (artifactKindForFile(name)) {
    return { mode: 'artifact', note: '', editable: true };
  }
  if (isTextualDocument(mediaTypeFor(name, undefined), name)) {
    return { mode: 'text', note: '', editable: true };
  }
  return {
    mode: 'handoff',
    note: name.toLowerCase().endsWith('.pdf')
      ? 'A PDF opens in whichever app you choose to view it with.'
      : 'This file cannot be shown here. Share it to open it in another app.',
    editable: false,
  };
}
