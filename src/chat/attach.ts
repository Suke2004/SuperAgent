/**
 * The impure half of attachments: pickers, the encoder, and the file system.
 *
 * `src/chat/attachments.ts` decides what is allowed and what it costs; this module
 * is what actually talks to `expo-image-picker`, `expo-image-manipulator`,
 * `expo-document-picker` and `expo-file-system`. The split is the same one
 * `export.ts` / `deliver.ts` uses, and for the same reason: every judgement worth
 * testing lives on the pure side, so this file has no arithmetic in it to get wrong.
 *
 * Three things here are not obvious:
 *
 *  1. **The resize is the feature.** Base64 of a 12 MP photo is a ~9 MB JavaScript
 *     string and the bridge copies it. Encoding first and checking the size after is
 *     the version of this module that runs out of memory on a mid-range phone, so
 *     the image is rendered at {@link MAX_IMAGE_EDGE} *before* any base64 exists,
 *     and re-encoded down the quality ladder until it fits.
 *  2. **Every temporary file is deleted.** The manipulator writes a new file per
 *     save, so one photo down four rungs of the ladder leaves four multi-megabyte
 *     files in the cache directory. Nothing else would ever clean them up.
 *  3. **A refusal is returned, not thrown.** Picking five photos where the fourth is
 *     too large must add four and say why the fifth did not — `notes` carries those
 *     sentences, so the composer can show them without the caller distinguishing
 *     partial success from failure.
 */

import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { ImageManipulator, SaveFormat } from 'expo-image-manipulator';
import * as ImagePicker from 'expo-image-picker';
import { Linking } from 'react-native';

import {
  admitDocument,
  admitImage,
  boundExtractedText,
  documentSupport,
  formatBytes,
  imageBlock,
  isTextualDocument,
  MAX_ATTACHMENTS_PER_MESSAGE,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_EDGE,
  mediaTypeFor,
  planResize,
  QUALITY_LADDER,
  attachmentSize,
} from '@/chat/attachments';
import { log } from '@/lib/log';
import type { ModelCapabilities } from '@/transports/support';
import type { ContentBlock, DocumentBlock, TransportKind } from '@/transports/types';

/**
 * What a pick attempt produced.
 *
 * `blocks` can be empty while `notes` is not — every file was refused — and both can
 * be non-empty at once, which is the case the shape exists for.
 */
export interface AttachResult {
  blocks: ContentBlock[];
  /** One sentence per file that did not make it, in the order they were picked. */
  notes: string[];
  /** The permission was refused for good and only Settings can undo it. */
  needsSettings?: boolean;
}

const NOTHING: AttachResult = { blocks: [], notes: [] };

/** Opens this app's page in Android Settings, for a permanently denied permission. */
export async function openAppSettings(): Promise<void> {
  try {
    await Linking.openSettings();
  } catch (error) {
    log.warn('attach', 'could not open settings', error);
  }
}

/**
 * Deletes a file the manipulator or the picker left in the cache directory.
 *
 * Best-effort and silent: the file may already be gone, may be a content URI the app
 * cannot delete, and in neither case is there anything for the user to do.
 */
function discard(uri: string | undefined): void {
  if (!uri || !uri.startsWith('file:')) return;
  try {
    new File(uri).delete();
  } catch {
    /* Cache files are the OS's problem if we cannot remove them. */
  }
}

/* ------------------------------------------------------------------------- */
/* Images                                                                     */
/* ------------------------------------------------------------------------- */

interface Encoded {
  mediaType: string;
  data: string;
}

/**
 * Downscales, re-encodes and base64s one picked asset.
 *
 * Everything is normalised to JPEG. A PNG screenshot re-encoded as JPEG at 0.8 is
 * visually identical to a model and a third of the size, and keeping the source
 * format would mean carrying a PNG's lossless bytes for a photograph. The one thing
 * this costs is transparency, which no model reads.
 *
 * Returns `undefined` when even the bottom of the ladder is too large; the caller
 * turns that into a sentence through `admitImage`.
 */
async function encodeImage(asset: ImagePicker.ImagePickerAsset): Promise<Encoded | undefined> {
  const plan = planResize({ width: asset.width, height: asset.height });

  const context = ImageManipulator.manipulate(asset.uri);
  if (plan.resized) {
    // `height: null` is the instruction to derive it from the ratio — which is what
    // we want when the platform reported no dimensions, because the native side has
    // the real bitmap and we do not.
    context.resize(plan.height === null ? { width: plan.width } : { width: plan.width, height: plan.height });
  }
  const rendered = await context.renderAsync();

  let best: Encoded | undefined;
  for (const compress of QUALITY_LADDER) {
    const saved = await rendered.saveAsync({ base64: true, compress, format: SaveFormat.JPEG });
    discard(saved.uri);
    const data = saved.base64;
    if (!data) continue;
    best = { mediaType: 'image/jpeg', data };
    if (data.length <= MAX_IMAGE_BASE64_CHARS) break;
  }

  return best;
}

/**
 * Encodes picked assets one at a time, admitting each against what is already staged.
 *
 * Sequential rather than `Promise.all`, deliberately: four 12 MP bitmaps decoded at
 * once is four bitmaps in memory at once, which is the crash this whole module is
 * arranged to avoid. The budget also has to be checked against the *accumulated*
 * set, which a parallel version cannot do.
 */
async function ingestAssets(
  existing: readonly ContentBlock[],
  assets: readonly ImagePicker.ImagePickerAsset[],
): Promise<AttachResult> {
  const staged: ContentBlock[] = [...existing];
  const added: ContentBlock[] = [];
  const notes: string[] = [];

  for (const asset of assets) {
    let encoded: Encoded | undefined;
    try {
      encoded = await encodeImage(asset);
    } catch (error) {
      log.warn('attach', 'could not encode image', error);
      notes.push(`${asset.fileName ?? 'One image'} could not be read. It may be in a format this device cannot decode.`);
      continue;
    } finally {
      // The picker's own copy is ours to remove either way; the encoder read it
      // into a bitmap and no longer needs the file.
      if (asset.uri !== undefined) discard(asset.uri);
    }

    if (!encoded) {
      notes.push(
        `${asset.fileName ?? 'One image'} is still too large after being resized to ${MAX_IMAGE_EDGE}px and ` +
          `recompressed. Cropping it to the part that matters will fit.`,
      );
      continue;
    }

    const admission = admitImage(staged, encoded);
    if (!admission.ok) {
      notes.push(admission.reason);
      continue;
    }

    const block = imageBlock(encoded.mediaType, encoded.data);
    staged.push(block);
    added.push(block);
  }

  return { blocks: added, notes };
}

/** Room left in the message, so the system picker itself enforces the count. */
function remainingSlots(existing: readonly ContentBlock[]): number {
  return Math.max(0, MAX_ATTACHMENTS_PER_MESSAGE - attachmentSize(existing).count);
}

/**
 * Picks images from the library.
 *
 * `quality: 1` looks wrong next to a module obsessed with size and is correct: the
 * picker's own compression happens *before* the downscale, so lowering it throws
 * away pixels that are about to be resampled anyway and leaves visible artefacts in
 * the result. The size control is the manipulator, one step later.
 */
export async function pickImages(existing: readonly ContentBlock[]): Promise<AttachResult> {
  const slots = remainingSlots(existing);
  if (slots === 0) {
    return {
      blocks: [],
      notes: [`${MAX_ATTACHMENTS_PER_MESSAGE} attachments is the limit for one message.`],
    };
  }

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      blocks: [],
      notes: [
        permission.canAskAgain
          ? 'Photo access is needed to attach an image. Nothing is uploaded until you press send.'
          : 'Photo access is turned off for Jarvis. Open Settings → Permissions to allow it.',
      ],
      ...(permission.canAskAgain ? {} : { needsSettings: true }),
    };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: slots,
    quality: 1,
    // Location and camera metadata travel with an image otherwise, and an
    // attachment is not a place to leak where the photo was taken.
    exif: false,
  });
  if (result.canceled) return NOTHING;

  return ingestAssets(existing, result.assets);
}

/** Takes a photo. Same pipeline; a different permission and a single asset. */
export async function captureImage(existing: readonly ContentBlock[]): Promise<AttachResult> {
  if (remainingSlots(existing) === 0) {
    return {
      blocks: [],
      notes: [`${MAX_ATTACHMENTS_PER_MESSAGE} attachments is the limit for one message.`],
    };
  }

  const permission = await ImagePicker.requestCameraPermissionsAsync();
  if (!permission.granted) {
    return {
      blocks: [],
      notes: [
        permission.canAskAgain
          ? 'Camera access is needed to take a photo. Nothing is uploaded until you press send.'
          : 'Camera access is turned off for Jarvis. Open Settings → Permissions to allow it.',
      ],
      ...(permission.canAskAgain ? {} : { needsSettings: true }),
    };
  }

  const result = await ImagePicker.launchCameraAsync({ mediaTypes: ['images'], quality: 1, exif: false });
  if (result.canceled) return NOTHING;

  return ingestAssets(existing, result.assets);
}

/* ------------------------------------------------------------------------- */
/* Documents                                                                  */
/* ------------------------------------------------------------------------- */

/** Types offered in the system picker. A wildcard would show files we then refuse. */
const DOCUMENT_TYPES = ['application/pdf', 'text/*', 'application/json', 'application/xml'];

/**
 * Picks documents and reads them in whichever form this profile can send.
 *
 * The order matters: `admitDocument` runs against the *reported file size*, before
 * anything is read, so a 60 MB PDF costs one sentence rather than an out-of-memory
 * crash. Only then is the file opened — as text when it is text, as base64 when the
 * transport has a native document block for it.
 */
export async function pickDocuments(
  existing: readonly ContentBlock[],
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
): Promise<AttachResult> {
  if (remainingSlots(existing) === 0) {
    return {
      blocks: [],
      notes: [`${MAX_ATTACHMENTS_PER_MESSAGE} attachments is the limit for one message.`],
    };
  }

  const result = await DocumentPicker.getDocumentAsync({
    type: DOCUMENT_TYPES,
    multiple: true,
    copyToCacheDirectory: true,
  });
  if (result.canceled) return NOTHING;

  const staged: ContentBlock[] = [...existing];
  const added: ContentBlock[] = [];
  const notes: string[] = [];

  for (const asset of result.assets) {
    const mediaType = mediaTypeFor(asset.name, asset.mimeType);

    const support = documentSupport(transport, capabilities, mediaType);
    if (!support.supported) {
      notes.push(`${asset.name}: ${support.reason}`);
      continue;
    }

    const admission = admitDocument(staged, {
      mediaType,
      name: asset.name,
      ...(asset.size !== undefined ? { size: asset.size } : {}),
    });
    if (!admission.ok) {
      notes.push(admission.reason);
      continue;
    }

    let block: DocumentBlock | undefined;
    try {
      block = await readDocument(asset.uri, asset.name, mediaType);
    } catch (error) {
      log.warn('attach', 'could not read document', error);
      notes.push(`${asset.name} could not be read from storage.`);
      continue;
    } finally {
      discard(asset.uri);
    }

    // A second admission pass, because the first one only saw the file size the
    // picker claimed. Base64 is a third larger, and `size` is optional in the API.
    const encoded = admitDocument(staged, {
      mediaType,
      name: asset.name,
      size: block.data ? Math.floor((block.data.length * 3) / 4) : (block.text?.length ?? 0),
    });
    if (!encoded.ok) {
      notes.push(encoded.reason);
      continue;
    }

    staged.push(block);
    added.push(block);
  }

  return { blocks: added, notes };
}

/**
 * Reads one document into a block.
 *
 * Text is read as text even when the transport has a native document block for it:
 * the app can then show it, search it and export it, and `flattenContent` indexes
 * its contents rather than only its file name. A PDF has no such option — nothing on
 * device can extract its text — so it goes as base64 or not at all.
 */
async function readDocument(uri: string, name: string, mediaType: string): Promise<DocumentBlock> {
  const file = new File(uri);

  if (isTextualDocument(mediaType, name)) {
    const raw = await file.text();
    const { text, truncated } = boundExtractedText(raw);
    return {
      type: 'document',
      mediaType,
      name: truncated ? `${name} (${formatBytes(raw.length)}, shortened)` : name,
      text,
    };
  }

  const data = await file.base64();
  return { type: 'document', mediaType, name, data };
}
