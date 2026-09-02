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
  ACCEPTED_IMAGE_TYPES,
  admitAnother,
  admitDocument,
  admitImage,
  boundExtractedText,
  documentSupport,
  formatBytes,
  imageBlock,
  isTextualDocument,
  MAX_IMAGE_BASE64_CHARS,
  MAX_IMAGE_EDGE,
  mediaTypeFor,
  planResize,
  QUALITY_LADDER,
  remainingSlots,
} from '@/chat/attachments';
import { APP_NAME } from '@/lib/app';
import { discardable, type Shot } from '@/chat/camera';
import { extractOffice, OFFICE_MEDIA_TYPES, officeKind } from '@/chat/office';
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
  sent: number,
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

    const admission = admitImage(staged, encoded, sent);
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

/**
 * Picks images from the library.
 *
 * `quality: 1` looks wrong next to a module obsessed with size and is correct: the
 * picker's own compression happens *before* the downscale, so lowering it throws
 * away pixels that are about to be resampled anyway and leaves visible artefacts in
 * the result. The size control is the manipulator, one step later.
 *
 * `sent` is how many attachments the conversation already holds — see
 * {@link MAX_ATTACHMENTS_PER_CONVERSATION}. Asked *before* the picker opens, because a
 * gallery that opens and then refuses everything chosen from it is worse than a refusal
 * on the way in.
 */
export async function pickImages(existing: readonly ContentBlock[], sent = 0): Promise<AttachResult> {
  const room = admitAnother(existing, sent);
  if (!room.ok) return { blocks: [], notes: [room.reason] };

  const permission = await ImagePicker.requestMediaLibraryPermissionsAsync();
  if (!permission.granted) {
    return {
      blocks: [],
      notes: [
        permission.canAskAgain
          ? 'Photo access is needed to attach an image. Nothing is uploaded until you press send.'
          : `Photo access is turned off for ${APP_NAME}. Open Settings → Permissions to allow it.`,
      ],
      ...(permission.canAskAgain ? {} : { needsSettings: true }),
    };
  }

  const result = await ImagePicker.launchImageLibraryAsync({
    mediaTypes: ['images'],
    allowsMultipleSelection: true,
    selectionLimit: remainingSlots(existing, sent),
    quality: 1,
    // Location and camera metadata travel with an image otherwise, and an
    // attachment is not a place to leak where the photo was taken.
    exif: false,
  });
  if (result.canceled) return NOTHING;

  return ingestAssets(existing, sent, result.assets);
}

/**
 * Encodes a finished in-app camera session.
 *
 * The whole reason `CameraMode` holds file paths instead of images: this is the one place
 * the shots become base64, in a single sequential pass, through the identical ladder a
 * gallery pick goes down. A `Shot` is structurally an `ImagePickerAsset` — `uri`, `width`,
 * `height` and a name — which is the entire adapter, and is why there is no second encoder
 * here to drift out of step with the first one.
 *
 * Each shot's file is deleted as it is read, by `ingestAssets`' own `finally`.
 */
export async function captureShots(
  existing: readonly ContentBlock[],
  sent: number,
  shots: readonly Shot[],
): Promise<AttachResult> {
  if (!shots.length) return NOTHING;
  return ingestAssets(existing, sent, shots);
}

/**
 * Throws away shots the user retook or abandoned.
 *
 * Not optional and not deferred to the OS: `takePictureAsync` writes a full-resolution JPEG
 * per press into this app's cache, so a session of six photos where five were retaken is
 * five multi-megabyte files that nothing else will ever collect. Called on retake and on
 * cancel, which is why {@link discardable} rather than the caller decides which URIs those
 * are.
 */
export function discardShots(shots: readonly Shot[]): void {
  for (const uri of discardable(shots)) discard(uri);
}

/* ------------------------------------------------------------------------- */
/* Documents                                                                  */
/* ------------------------------------------------------------------------- */

/** Types offered in the system picker. A wildcard would show files we then refuse. */
const DOCUMENT_TYPES = ['application/pdf', 'text/*', 'application/json', 'application/xml', ...OFFICE_MEDIA_TYPES];

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
  sent: number,
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
): Promise<AttachResult> {
  const room = admitAnother(existing, sent);
  if (!room.ok) return { blocks: [], notes: [room.reason] };

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

    const admission = admitDocument(
      staged,
      {
        mediaType,
        name: asset.name,
        ...(asset.size !== undefined ? { size: asset.size } : {}),
      },
      sent,
    );
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
    const encoded = admitDocument(
      staged,
      {
        mediaType,
        name: asset.name,
        size: block.data ? Math.floor((block.data.length * 3) / 4) : (block.text?.length ?? 0),
      },
      sent,
    );
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
 * Attaches a file this app was handed, by URI.
 *
 * Two callers: a file the model generated, from the files list, and a file another app
 * sent in through an "open with" intent — see `@/chat/incoming`. Same admission rules as
 * {@link pickDocuments} and deliberately the same code path, because neither origin earns
 * an exemption from the size ceiling: a 9 MB PDF breaks the request whether this app wrote
 * it or a file manager did.
 *
 * The one difference from the picker is that the source is *not* deleted afterwards. In
 * both cases it belongs to someone else — the user's own generated document, or another
 * app's content provider — rather than being a copy the picker made in the cache.
 */
export async function attachExistingFile(
  existing: readonly ContentBlock[],
  sent: number,
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
  source: { uri: string; name: string; size?: number },
): Promise<AttachResult> {
  const room = admitAnother(existing, sent);
  if (!room.ok) return { blocks: [], notes: [room.reason] };

  const mediaType = mediaTypeFor(source.name, undefined);
  const support = documentSupport(transport, capabilities, mediaType);
  if (!support.supported) return { blocks: [], notes: [`${source.name}: ${support.reason}`] };

  const admission = admitDocument(
    existing,
    {
      mediaType,
      name: source.name,
      ...(source.size !== undefined ? { size: source.size } : {}),
    },
    sent,
  );
  if (!admission.ok) return { blocks: [], notes: [admission.reason] };

  let block: DocumentBlock;
  try {
    block = await readDocument(source.uri, source.name, mediaType);
  } catch (error) {
    log.warn('attach', 'could not read a file', error);
    return { blocks: [], notes: [`${source.name} could not be read.`] };
  }

  // Second pass on the real encoded size, for the same reason `pickDocuments` does it.
  const encoded = admitDocument(
    existing,
    {
      mediaType,
      name: source.name,
      size: block.data ? Math.floor((block.data.length * 3) / 4) : (block.text?.length ?? 0),
    },
    sent,
  );
  if (!encoded.ok) return { blocks: [], notes: [encoded.reason] };

  return { blocks: [block], notes: [] };
}

/**
 * Attaches a file another app handed over through an "open with" intent.
 *
 * `@/chat/incoming` has already decided the URI is one this app will touch; what is left
 * is the part that needs the device. Two things have to be resolved here rather than
 * there:
 *
 *  - **The name.** A content URI often carries none — a downloads-provider id is
 *    `msf:42` — and the name is what types the file, so the provider is asked for its
 *    display name before anything is refused. A file with no name *and* no extension is
 *    refused, because guessing at bytes of unknown type is how a `400` happens.
 *  - **Which kind of block it becomes.** An image has to go down the resize ladder and
 *    an image block, not be base64'd whole into a document block, so the type decides
 *    the path rather than the caller.
 */
export async function attachIncomingFile(
  existing: readonly ContentBlock[],
  sent: number,
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
  incoming: { uri: string; name: string },
): Promise<AttachResult> {
  let name = incoming.name;
  let size: number | undefined;
  try {
    const file = new File(incoming.uri);
    if (!name) name = file.name;
    size = file.size ?? undefined;
  } catch (error) {
    // A provider that will not answer is not a crash: the name may still have come
    // from the URI, and the admission checks below decide on what is actually known.
    log.warn('attach', 'could not inspect an incoming file', error);
  }

  const mediaType = mediaTypeFor(name, undefined);
  if (!mediaType) {
    return {
      blocks: [],
      notes: [
        'The app that sent that file gave it no name or extension, so there is no way to tell ' +
          'what it is. Attach it from the composer instead.',
      ],
    };
  }

  if ((ACCEPTED_IMAGE_TYPES as readonly string[]).includes(mediaType)) {
    // Zero dimensions is the honest input, not a placeholder: a content URI reports
    // none, and `planResize` has a blind case for exactly this — the manipulator holds
    // the real bitmap and derives the height from it.
    return ingestAssets(existing, sent, [{ uri: incoming.uri, width: 0, height: 0, fileName: name }]);
  }

  return attachExistingFile(existing, sent, transport, capabilities, {
    uri: incoming.uri,
    name,
    ...(size !== undefined ? { size } : {}),
  });
}

/**
 * Reads one document into a block.
 *
 * Text is read as text even when the transport has a native document block for it:
 * the app can then show it, search it and export it, and `flattenContent` indexes
 * its contents rather than only its file name. A PDF has no such option — nothing on
 * device can extract its text — so it goes as base64 or not at all.
 *
 * An Office file is a zip of XML, so it is read here too — see `@/chat/office`. What
 * comes back is text and only text, which is why the composer shows a caveat for it.
 */
async function readDocument(uri: string, name: string, mediaType: string): Promise<DocumentBlock> {
  const file = new File(uri);

  const office = officeKind(mediaType, name);
  if (office) {
    const extracted = extractOffice(await file.bytes(), office);
    const { text, truncated } = boundExtractedText(extracted);
    return {
      type: 'document',
      mediaType,
      name: truncated ? `${name} (${formatBytes(extracted.length)}, shortened)` : name,
      // Empty is a real outcome — a deck of images, a blank workbook — and saying so
      // in the block beats a read failure the user cannot act on.
      text: text || `(no text could be read from ${name})`,
    };
  }

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
