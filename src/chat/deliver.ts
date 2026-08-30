/**
 * Getting an export off the device.
 *
 * Split from `@/chat/export` because that module is pure and this one cannot be:
 * it reads SQLite and talks to the clipboard and the share sheet. Keeping the
 * formatting side free of both is what lets the security test grep a real
 * artefact without a mock in sight.
 *
 * **Why there is no "save to file".** The clipboard and the share sheet already
 * cover it — the share sheet's own targets (Drive, Files, mail) are what a user
 * means by "save it". `expo-file-system` is in the tree now (attachments, and the
 * skills zip export writes through `Directory.pickDirectoryAsync`), so this is a
 * choice rather than a missing capability: a folder picker is a worse handover for
 * a transcript than a share sheet, and the same one is there if that changes.
 * Documented rather than left as a gap so the next person does not think it was
 * forgotten.
 */

import * as Clipboard from 'expo-clipboard';
import { Share } from 'react-native';

import type { ExportFormat, ExportInput, ExportOptions, ExportResult } from '@/chat/export';
import { exportConversations } from '@/chat/export';
import { getConversation, listMessages } from '@/db/conversations';
import { log } from '@/lib/log';

export type DeliveryMethod = 'copy' | 'share';

/**
 * Above this, the share sheet stops being a good idea.
 *
 * Android passes the text through a Binder transaction with a hard limit around
 * 1 MB, shared with everything else in the parcel, and a target that overflows it
 * fails with an opaque error rather than a message a user can act on. The
 * clipboard has no such ceiling, so a large export is copied instead — and the
 * caller is told, rather than silently getting something other than what it
 * asked for.
 */
export const SHARE_BYTE_LIMIT = 256 * 1024;

/**
 * Reads the conversations and their messages.
 *
 * Ids that no longer exist are skipped rather than thrown on: an export is
 * started from a list that can be seconds stale, and refusing the whole export
 * because one row was deleted elsewhere would be the wrong trade.
 */
export async function gatherExport(ids: readonly string[]): Promise<ExportInput[]> {
  const out: ExportInput[] = [];
  for (const id of ids) {
    const conversation = await getConversation(id);
    if (!conversation) continue;
    out.push({ conversation, messages: await listMessages(id) });
  }
  return out;
}

export interface DeliveryOutcome {
  result: ExportResult;
  /** What actually happened, which is not always what was asked for. */
  method: DeliveryMethod;
  /** True when `share` was asked for and the artefact was too big for it. */
  fellBackToClipboard: boolean;
  /** False when the user dismissed the share sheet without choosing a target. */
  delivered: boolean;
}

/**
 * Builds the artefact and hands it over.
 *
 * Nothing is logged but sizes and counts. The artefact itself never reaches the
 * debug log: it is the one string in the app most likely to contain the user's
 * private conversation, and `redactString` protects keys, not content.
 */
export async function deliverExport(
  inputs: readonly ExportInput[],
  format: ExportFormat,
  method: DeliveryMethod,
  options: ExportOptions = {},
): Promise<DeliveryOutcome> {
  const result = exportConversations(inputs, format, options);
  const tooBig = result.bytes > SHARE_BYTE_LIMIT;
  const actual: DeliveryMethod = method === 'share' && tooBig ? 'copy' : method;

  log.info('export', 'export produced', {
    format,
    conversations: inputs.length,
    messages: result.messages,
    bytes: result.bytes,
    method: actual,
    fellBack: actual !== method,
  });

  if (actual === 'copy') {
    await Clipboard.setStringAsync(result.text);
    return { result, method: actual, fellBackToClipboard: actual !== method, delivered: true };
  }

  // `message` rather than `url`: there is no file to point at, and a share target
  // handed a `url` it cannot resolve shows an error instead of the transcript.
  const action = await Share.share({ message: result.text, title: result.filename });
  return {
    result,
    method: actual,
    fellBackToClipboard: false,
    delivered: action.action !== Share.dismissedAction,
  };
}
