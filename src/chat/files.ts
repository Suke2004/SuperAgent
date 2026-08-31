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
 * uses.
 */

import { Directory, File, Paths } from 'expo-file-system';
import * as Print from 'expo-print';
import * as Sharing from 'expo-sharing';

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

/** Writes a text file and reports what it ended up being called. */
export async function writeGeneratedFile(name: string, content: string): Promise<GeneratedFile> {
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
