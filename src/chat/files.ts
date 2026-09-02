/**
 * Files the model produced, on disk and back out again.
 *
 * The counterpart to `@/chat/builtins`: that module decides what a valid
 * `write_file` call is, this one performs it. Split for the usual reason — the
 * naming and URL rules are the part with edge cases worth testing, and they should
 * not need a file system to test.
 *
 * Everything lands in one directory under the app's own document root. Not the
 * shared Downloads folder: that needs a permission this app does not ask for, and a
 * file in shared storage outlives the app that made it, so uninstalling would leave
 * the user's generated documents behind with nothing to manage them. The share sheet
 * is how a file gets out, which is the same handover the transcript export already
 * uses — and {@link saveToFolder} is how a copy gets out on purpose, through the system
 * folder picker, which grants the write one folder at a time instead of up front.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

import { mediaTypeFor } from '@/chat/attachments';
import { printableHtml } from '@/chat/printable';
import { log } from '@/lib/log';

/** Where generated files live. One directory, created on demand. */
export function filesDirectory(): Directory {
  const directory = new Directory(Paths.document, 'files');
  if (!directory.exists) directory.create({ intermediates: true });
  return directory;
}

export interface GeneratedFile {
  name: string;
  uri: string;
  bytes: number;
  modifiedAt: number;
}

/**
 * A name nothing is using yet.
 *
 * Suffixed rather than overwritten. A model asked twice for `report.pdf` means two
 * reports; silently replacing the first would destroy work the user may not have
 * shared yet, and this is the one operation here that is not reversible.
 */
function freeName(directory: Directory, name: string): string {
  const dot = name.lastIndexOf('.');
  const stem = dot > 0 ? name.slice(0, dot) : name;
  const extension = dot > 0 ? name.slice(dot) : '';
  let candidate = name;
  for (let n = 2; new File(directory, candidate).exists && n < 1_000; n += 1) {
    candidate = `${stem}-${n}${extension}`;
  }
  return candidate;
}

/**
 * Writes a file and reports what it ended up being called.
 *
 * Takes bytes as readily as text, because an Office document is a zip: `create_document`
 * hands over a `Uint8Array` and `write_file` a string, and the only difference that makes
 * downstream is the number in the log line.
 */
export async function writeGeneratedFile(name: string, content: string | Uint8Array): Promise<GeneratedFile> {
  const directory = filesDirectory();
  const file = new File(directory, freeName(directory, name));
  file.create({ overwrite: false });
  file.write(content);
  log.info('files', 'wrote a file', { bytes: content.length, extension: name.split('.').pop() ?? '' });
  return describe(file);
}

/**
 * Renders Markdown to a PDF through the platform's own print pipeline.
 *
 * `expo-print` runs the HTML in a WebView and asks Android to paginate it, which is
 * the only PDF writer on the device that already handles page breaks, fonts and
 * margins. The alternative was a PDF library and a layout engine, for a feature
 * whose job is "make this readable on paper".
 */
export async function writePdf(name: string, title: string, markdown: string): Promise<GeneratedFile> {
  const { uri } = await Print.printToFileAsync({ html: printableHtml(title, markdown), base64: false });
  const directory = filesDirectory();
  const target = new File(directory, freeName(directory, name));
  // `printToFileAsync` writes into the cache under a generated name; moving it gives
  // the file the name the model asked for and puts it where the files list looks.
  new File(uri).move(target);
  log.info('files', 'wrote a pdf', { bytes: target.size ?? 0 });
  return describe(target);
}

/** Every generated file, newest first. */
export async function listGeneratedFiles(): Promise<GeneratedFile[]> {
  try {
    const entries = filesDirectory().list();
    return entries
      .filter((entry): entry is File => entry instanceof File)
      .map(describe)
      .sort((a, b) => b.modifiedAt - a.modifiedAt || a.name.localeCompare(b.name));
  } catch (error) {
    log.error('files', 'could not list generated files', error);
    return [];
  }
}

/** Hands one file to the share sheet. Returns false when sharing is unavailable. */
export async function shareGeneratedFile(uri: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  await Sharing.shareAsync(uri);
  return true;
}

/** The text of one generated file, for the previewer. */
export async function readGeneratedText(uri: string): Promise<string> {
  return await new File(uri).text();
}

/** The bytes, for the one preview mode that has to unzip before it can read: Office. */
export async function readGeneratedBytes(uri: string): Promise<Uint8Array> {
  return await new File(uri).bytes();
}

/**
 * An edit saved back over the file it came from.
 *
 * Overwrites, unlike {@link writeGeneratedFile}, because this *is* the same document —
 * a second copy every time the user fixed a typo is a files list nobody can use.
 */
export async function writeGeneratedText(uri: string, content: string): Promise<GeneratedFile> {
  const file = new File(uri);
  file.write(content);
  log.info('files', 'saved an edit', { bytes: content.length });
  return describe(file);
}

export type SaveResult = { ok: true; where: 'folder' | 'shared' } | { ok: false; reason: string };

/**
 * A copy of one file, in a folder the user chose.
 *
 * The distinction from {@link shareGeneratedFile} is ownership: the share sheet hands a
 * file to another app, which may or may not keep it, whereas this writes a copy the user
 * keeps and this app never sees again.
 *
 * Android does that through the Storage Access Framework — the system folder picker, whose
 * grant is what makes the write legal, so no permission is declared in the manifest and
 * nothing is readable that the user did not point at. Nowhere else has an equivalent; the
 * iOS share sheet includes "Save to Files", which is the same act by a different route, so
 * that is what those platforms get rather than a button that cannot work.
 *
 * The branch is *availability*, not `Platform.OS`. Asking the picker whether it exists
 * also catches web and an Android without it, and — the reason it is written this way —
 * keeps `react-native` out of this module's imports, which is what lets everything that
 * imports it stay loadable in the test runner.
 *
 * `ponytail: whole file through base64 in memory, stream it if these ever get large.`
 */
export async function saveToFolder(uri: string, name: string): Promise<SaveResult> {
  /** Set once the picker has answered, which is what separates "no SAF" from "SAF failed". */
  let chosen: string | null = null;
  try {
    // Imported here rather than at the top of the file: SAF is the only way to write
    // outside this app's sandbox and it lives on the legacy subpath, which the package
    // publishes as untranspiled source — a top-level import makes this whole module, and
    // everything that imports it, unloadable under Jest.
    const { StorageAccessFramework } = await import('expo-file-system/legacy');
    const permission = await StorageAccessFramework.requestDirectoryPermissionsAsync();
    if (!permission.granted) return { ok: false, reason: 'No folder was chosen.' };
    chosen = permission.directoryUri;
    const type = mediaTypeFor(name, undefined) || 'application/octet-stream';
    const target = await StorageAccessFramework.createFileAsync(chosen, name, type);
    await StorageAccessFramework.writeAsStringAsync(target, new File(uri).base64Sync(), { encoding: 'base64' });
    log.info('files', 'saved a copy to a chosen folder', { extension: name.split('.').pop() ?? '' });
    return { ok: true, where: 'folder' };
  } catch (error) {
    // A failure *after* the folder was chosen is a real write failure, and saying so is
    // the only useful thing to do with it. Opening a share sheet instead would look like
    // the app had ignored the folder the user just picked.
    if (chosen) {
      log.error('files', 'could not save a copy', error);
      return { ok: false, reason: error instanceof Error ? error.message : 'The file could not be written there.' };
    }
    log.info('files', 'no folder picker here, sharing instead');
  }
  return (await shareGeneratedFile(uri))
    ? { ok: true, where: 'shared' }
    : { ok: false, reason: 'This device can neither pick a folder nor share.' };
}

/**
 * An image from the transcript, out to the share sheet.
 *
 * A transcript image is base64 in memory and the share sheet takes a file URI, so a
 * file has to exist for this to happen at all. It is written to the cache rather than
 * to {@link filesDirectory}: this is a handover, not a document the user manages, and
 * the OS being free to reclaim it once the sheet closes is the correct lifetime.
 *
 * Where the sheet goes from there is the platform's business — Photos, Drive, a
 * message. That is also why there is no separate "save to gallery": it would need the
 * media-library permission and a native module to do what the sheet already does.
 */
export async function shareImageData(mediaType: string, data: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const extension = mediaType === 'image/jpeg' ? 'jpg' : (mediaType.split('/')[1] ?? 'png');
  const file = new File(Paths.cache, `image-${Date.now()}.${extension}`);
  file.create({ overwrite: true, intermediates: true });
  file.write(data, { encoding: 'base64' });
  await Sharing.shareAsync(file.uri, { mimeType: mediaType });
  return true;
}

/** Deletes one generated file. Missing is success: the user wanted it gone. */
export function deleteGeneratedFile(uri: string): void {
  try {
    const file = new File(uri);
    if (file.exists) file.delete();
  } catch (error) {
    log.error('files', 'could not delete a generated file', error);
  }
}

function describe(file: File): GeneratedFile {
  return {
    name: file.name,
    uri: file.uri,
    bytes: file.size ?? 0,
    modifiedAt: file.modificationTime ?? 0,
  };
}
