/**
 * What may be attached, at what size, and what it costs.
 *
 * The picker is the easy half of multimodal. The hard half is that base64 of a
 * full-resolution phone photo is a ~9 MB JavaScript string, the bridge copies it,
 * SQLite stores it, and every later turn re-sends it — so a 12 MP holiday snap
 * attached three times is a conversation that cannot be continued on any model.
 * Every limit in this file exists because something downstream falls over without
 * it, and every refusal names the number so the user can act on it.
 *
 * The module is pure on purpose: no `expo-image-picker`, no `expo-file-system`, no
 * `expo-sqlite`. `src/chat/attach.ts` is the impure half that drives the pickers
 * and the encoder and asks the functions here whether the result is allowed. That
 * split is what lets the size arithmetic — the part that is expensive to get wrong
 * and impossible to eyeball — run in Jest.
 */

import { truncateMiddle } from '@/chat/trim';
import { estimateBlockTokens } from '@/lib/tokens';
import type { ModelCapabilities } from '@/transports/support';
import type { ContentBlock, DocumentBlock, ImageBlock, TransportKind } from '@/transports/types';

/**
 * Long edge to resize down to, in pixels.
 *
 * Anthropic's vision guidance is that anything above 1568px on the long edge is
 * scaled down server-side before it is tokenised, so the extra pixels are paid for
 * on the wire and then discarded. 1568 is therefore the largest size that is not
 * simply waste.
 */
export const MAX_IMAGE_EDGE = 1568;

/**
 * Per-image ceiling on the *base64 string*, not the file.
 *
 * The string is what crosses the bridge, lands in a Zustand value and is written to
 * a SQLite cell, so it is the number that actually hurts. 1.5 MB of base64 is
 * ~1.1 MB of JPEG, which a 1568px long edge lands well under at quality 0.8 —
 * hitting this limit means the ladder below has already had several goes.
 */
export const MAX_IMAGE_BASE64_CHARS = 1_500_000;

/**
 * Ceiling on all attachments in one message, again as base64 characters.
 *
 * Deliberately less than four times the per-image limit: the failure this prevents
 * is not one enormous photo, it is five ordinary ones. A refusal here is cheap; a
 * request the gateway drops after 40 seconds of upload is not.
 */
export const MAX_MESSAGE_ATTACHMENT_CHARS = 4_500_000;

/** Hard cap on attachment count, independent of size. */
export const MAX_ATTACHMENTS_PER_MESSAGE = 8;

/**
 * Compression attempts, in order, all at {@link MAX_IMAGE_EDGE}.
 *
 * Re-encoding is tried before refusing, because "that photo is too big" is a
 * useless thing to say about a photo the app could have shrunk. It stops at 0.3:
 * below that a screenshot's text stops being legible, and an image the model
 * cannot read is worse than no image.
 */
export const QUALITY_LADDER = [0.8, 0.6, 0.45, 0.3] as const;

/**
 * Image media types worth accepting.
 *
 * Both APIs document exactly these four, and the encoder normalises everything to
 * JPEG anyway — the list is about what the *picker* may hand us, so that an
 * unexpected HEIC or AVIF is refused with a sentence rather than sent as bytes the
 * gateway rejects with `400`.
 */
export const ACCEPTED_IMAGE_TYPES = ['image/jpeg', 'image/png', 'image/gif', 'image/webp'] as const;

/**
 * Source-file ceiling for a native PDF, checked *before* any encoding work.
 *
 * Anthropic's own request limit is 32 MB, but base64 inflates by a third and the
 * string has to exist in JavaScript alongside the file — a 32 MB PDF is a 43 MB
 * string, which is an out-of-memory crash on a mid-range Android device, not a
 * slow request. 8 MB is the largest that leaves room to survive.
 */
export const MAX_PDF_BYTES = 8_000_000;

/** Source-file ceiling for a document we read as text rather than encode. */
export const MAX_TEXT_FILE_BYTES = 1_000_000;

/**
 * Extracted text kept from one document, in characters.
 *
 * ~32k tokens: large enough for a paper or a spec, small enough that one attached
 * file cannot consume a 200k window by itself. Text over this is truncated in the
 * middle *with the elision stated*, because a document that silently lost its
 * conclusion is worse than one that says where it stops.
 */
export const MAX_EXTRACTED_CHARS = 120_000;

/** Media types read as text on device rather than sent as a document block. */
const TEXTUAL_TYPES = new Set([
  'text/plain',
  'text/markdown',
  'text/csv',
  'text/html',
  'text/xml',
  'application/json',
  'application/xml',
  'application/x-yaml',
  'text/yaml',
  'application/javascript',
  'text/javascript',
  'application/typescript',
]);

/** Extensions the system failed to give a media type for. Lower-case, no dot. */
const TYPE_BY_EXTENSION: Record<string, string> = {
  txt: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  yaml: 'application/x-yaml',
  yml: 'application/x-yaml',
  xml: 'application/xml',
  html: 'text/html',
  htm: 'text/html',
  js: 'text/javascript',
  mjs: 'text/javascript',
  ts: 'application/typescript',
  tsx: 'application/typescript',
  py: 'text/plain',
  rs: 'text/plain',
  go: 'text/plain',
  java: 'text/plain',
  sql: 'text/plain',
  sh: 'text/plain',
  log: 'text/plain',
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  gif: 'image/gif',
  webp: 'image/webp',
};

/* ------------------------------------------------------------------------- */
/* Sizing                                                                     */
/* ------------------------------------------------------------------------- */

export interface Dimensions {
  width: number;
  height: number;
}

export interface ResizePlan {
  /** Target width in pixels. */
  width: number;
  /**
   * Target height, or `null` to let the encoder derive it from the aspect ratio.
   * Null is not a fallback — it is the correct instruction when the source
   * dimensions were not reported.
   */
  height: number | null;
  /** False when the source is already within the limit and must be left alone. */
  resized: boolean;
  /** The system gave no usable dimensions, so the width was clamped blind. */
  blind: boolean;
}

/**
 * The resize to apply before encoding.
 *
 * Only ever shrinks. Upscaling a small image to fill the budget would cost tokens
 * and bytes for pixels that were never captured, and the model sees no more than it
 * did before.
 *
 * `width: 0, height: 0` is a real case, not defensive coding: `ImagePickerAsset`
 * documents both as possibly zero when the platform did not report them. Guessing a
 * square would distort the photo, so the plan clamps the width and leaves the height
 * to the encoder, which has the real bitmap.
 */
export function planResize(source: Dimensions, maxEdge: number = MAX_IMAGE_EDGE): ResizePlan {
  const { width, height } = source;
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { width: maxEdge, height: null, resized: true, blind: true };
  }

  const longEdge = Math.max(width, height);
  if (longEdge <= maxEdge) {
    return { width: Math.round(width), height: Math.round(height), resized: false, blind: false };
  }

  const scale = maxEdge / longEdge;
  // At least one pixel on the short edge: a 4000×1 panorama scales to 1568×0.39,
  // and a zero-height resize is an error rather than a thin image.
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
    resized: true,
    blind: false,
  };
}

/**
 * Decoded byte count of a base64 string.
 *
 * Exact rather than `length × 3 / 4`: padding characters carry no data, and the
 * figure is shown to the user next to a refusal, where being 2 bytes out is fine
 * but being 25% out on a small file reads as a bug.
 */
export function base64Bytes(data: string): number {
  if (!data) return 0;
  let padding = 0;
  if (data.endsWith('==')) padding = 2;
  else if (data.endsWith('=')) padding = 1;
  return Math.max(0, Math.floor((data.length * 3) / 4) - padding);
}

/**
 * Bytes as a person reads them.
 *
 * Decimal units, because that is what Android's own file managers and share sheets
 * show — a limit stated as 1.5 MB here has to match the 1.5 MB the user sees there.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  if (bytes < 1_000) return `${Math.round(bytes)} B`;
  if (bytes < 1_000_000) return `${Math.round(bytes / 1_000)} kB`;
  const mb = bytes / 1_000_000;
  return `${mb < 10 ? mb.toFixed(1) : Math.round(mb)} MB`;
}

export interface AttachmentSize {
  /** Images plus documents. Text and thinking blocks are not attachments. */
  count: number;
  /** Base64 characters across every attachment — the string cost. */
  base64Chars: number;
  /** Decoded bytes across every attachment — the number worth showing. */
  bytes: number;
  /** Estimated prompt tokens, images at the flat per-image figure. */
  tokens: number;
}

/** What a set of blocks costs, in the three currencies that each bind separately. */
export function attachmentSize(blocks: readonly ContentBlock[]): AttachmentSize {
  let count = 0;
  let base64Chars = 0;
  let tokens = 0;

  for (const block of blocks) {
    if (block.type === 'image') {
      count += 1;
      base64Chars += block.data.length;
      tokens += estimateBlockTokens(block);
    } else if (block.type === 'document') {
      count += 1;
      base64Chars += block.data?.length ?? 0;
      tokens += estimateBlockTokens(block);
    }
  }

  return { count, base64Chars, bytes: Math.floor((base64Chars * 3) / 4), tokens };
}

/** Just the token figure, for the composer's gauge. */
export function attachmentTokens(blocks: readonly ContentBlock[]): number {
  return attachmentSize(blocks).tokens;
}

/* ------------------------------------------------------------------------- */
/* Admission                                                                  */
/* ------------------------------------------------------------------------- */

/**
 * Whether one more attachment may join the ones already staged.
 *
 * `ok: false` always carries a sentence, and the sentence always contains the two
 * numbers involved — what this file is and what the limit is. "Attachment too
 * large" tells the user to try again with something unspecified.
 */
export type Admission = { ok: true } | { ok: false; reason: string };

const OK: Admission = { ok: true };

function countLimit(existing: readonly ContentBlock[]): Admission {
  const { count } = attachmentSize(existing);
  if (count < MAX_ATTACHMENTS_PER_MESSAGE) return OK;
  return {
    ok: false,
    reason:
      `${MAX_ATTACHMENTS_PER_MESSAGE} attachments is the limit for one message. ` +
      `Send these first — the next message can carry more.`,
  };
}

function budgetLimit(existing: readonly ContentBlock[], addedChars: number): Admission {
  const before = attachmentSize(existing).base64Chars;
  const after = before + addedChars;
  if (after <= MAX_MESSAGE_ATTACHMENT_CHARS) return OK;
  const total = formatBytes(Math.floor((after * 3) / 4));
  const limit = formatBytes(Math.floor((MAX_MESSAGE_ATTACHMENT_CHARS * 3) / 4));
  return {
    ok: false,
    reason:
      `That would make ${total} of attachments in one message, over the ${limit} limit. ` +
      `Remove one of the others, or send them across two messages.`,
  };
}

/**
 * Whether an encoded image is allowed in.
 *
 * Called after the resize-and-recompress ladder has finished, so a refusal here
 * means the image is still too large at the bottom of the ladder — which is worth
 * saying, because the obvious user response ("I'll crop it") does work.
 */
export function admitImage(
  existing: readonly ContentBlock[],
  candidate: { mediaType: string; data: string },
): Admission {
  if (!(ACCEPTED_IMAGE_TYPES as readonly string[]).includes(candidate.mediaType)) {
    return {
      ok: false,
      reason:
        `${candidate.mediaType || 'That file'} is not an image format the models accept. ` +
        `JPEG, PNG, GIF and WebP are.`,
    };
  }

  const counted = countLimit(existing);
  if (!counted.ok) return counted;

  if (candidate.data.length > MAX_IMAGE_BASE64_CHARS) {
    return {
      ok: false,
      reason:
        `This image is still ${formatBytes(base64Bytes(candidate.data))} after being resized to ` +
        `${MAX_IMAGE_EDGE}px and recompressed, over the ${formatBytes(Math.floor((MAX_IMAGE_BASE64_CHARS * 3) / 4))} ` +
        `per-image limit. Cropping it to the part that matters will fit.`,
    };
  }

  return budgetLimit(existing, candidate.data.length);
}

/**
 * Whether a picked document is worth reading at all.
 *
 * Takes the *file size the picker reported*, deliberately, so a 60 MB PDF is
 * refused before a byte of it is read into memory. Reading first and checking after
 * is the version of this function that crashes.
 */
export function admitDocument(
  existing: readonly ContentBlock[],
  candidate: { mediaType: string; name?: string; size?: number },
): Admission {
  const counted = countLimit(existing);
  if (!counted.ok) return counted;

  const mediaType = candidate.mediaType;
  const textual = isTextualDocument(mediaType, candidate.name);
  const pdf = mediaType === 'application/pdf';

  if (!pdf && !textual) {
    return {
      ok: false,
      reason:
        `${candidate.name ? `${candidate.name} is` : 'That file is'} a ${mediaType || 'file of unknown type'}, ` +
        `which cannot be read on device or sent as a document. PDFs and text files can.`,
    };
  }

  const limit = pdf ? MAX_PDF_BYTES : MAX_TEXT_FILE_BYTES;
  const size = candidate.size;
  if (size !== undefined && Number.isFinite(size) && size > limit) {
    return {
      ok: false,
      reason:
        `${candidate.name ?? 'That file'} is ${formatBytes(size)}; the limit is ${formatBytes(limit)} for ` +
        `${pdf ? 'a PDF' : 'a text file'}. Nothing has been read yet — ` +
        `${pdf ? 'split it or export the pages you need' : 'attach an extract instead'}.`,
    };
  }

  // Base64 of a PDF still has to fit the per-message budget alongside the images.
  if (pdf && size !== undefined && Number.isFinite(size)) {
    return budgetLimit(existing, Math.ceil(size / 3) * 4);
  }

  return OK;
}

/* ------------------------------------------------------------------------- */
/* Capability gating                                                          */
/* ------------------------------------------------------------------------- */

export interface AttachSupport {
  supported: boolean;
  /** Why not, in the user's terms. Empty when supported. */
  reason: string;
}

/**
 * Whether this model can take an image at all.
 *
 * The flag is hand-edited, because `/v1/models` returns ids and nothing else, so
 * the reason says where to change it. A greyed-out attach button with no
 * explanation reads as a broken app on a gateway that never described itself.
 */
export function imageSupport(capabilities: ModelCapabilities | undefined): AttachSupport {
  if (capabilities?.vision) return { supported: true, reason: '' };
  return {
    supported: false,
    reason:
      'This model is not flagged as accepting images. Flip “Vision” in Settings → Models if it does — ' +
      'the gateway does not report capabilities, so the flag is manual.',
  };
}

/**
 * Whether this model and transport can take a document, and in what form.
 *
 * Three outcomes rather than two, because the OpenAI-compatible path has no
 * document block at all: a PDF there is not refused, it is *degraded* to whatever
 * text was extracted on device. The distinction has to reach the composer, since
 * "the model will read the text, not the layout" is something to say before sending
 * rather than after a disappointing answer.
 */
export function documentSupport(
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
  mediaType: string,
): AttachSupport & { native: boolean } {
  if (isTextualDocument(mediaType)) {
    return { supported: true, reason: '', native: transport === 'anthropic' && !!capabilities?.documents };
  }

  if (mediaType !== 'application/pdf') {
    return {
      supported: false,
      reason: `${mediaType || 'This file type'} cannot be read on device or sent as a document block.`,
      native: false,
    };
  }

  if (transport !== 'anthropic') {
    return {
      supported: false,
      reason:
        'This provider profile speaks the OpenAI-compatible API, which has no document block, and a PDF ' +
        'cannot be read as text on device. Attach it on an Anthropic-compatible profile instead.',
      native: false,
    };
  }

  if (!capabilities?.documents) {
    return {
      supported: false,
      reason:
        'This model is not flagged as accepting PDFs. Flip “Documents” in Settings → Models if it does — ' +
        'the flag is manual, because the gateway does not report capabilities.',
      native: false,
    };
  }

  return { supported: true, reason: '', native: true };
}

/**
 * The warning a composer shows for a staged document, or `undefined`.
 *
 * Only for the case that is silently lossy: a document going to a transport with no
 * native form, arriving as extracted text. The user is told before sending, because
 * afterwards the only evidence is an answer that ignored the tables.
 */
export function documentCaveat(
  transport: TransportKind,
  capabilities: ModelCapabilities | undefined,
  block: DocumentBlock,
): string | undefined {
  const support = documentSupport(transport, capabilities, block.mediaType);
  if (!support.supported) return support.reason;
  if (support.native) return undefined;
  if (block.text !== undefined) {
    return transport === 'anthropic'
      ? undefined
      : `${block.name ?? 'This document'} is sent as the text extracted on this device. Layout, tables and images in it are not included.`;
  }
  return `No text could be read from ${block.name ?? 'this document'}, and this profile has no document block to send it in. The model will only see the file name.`;
}

/* ------------------------------------------------------------------------- */
/* Text extraction                                                            */
/* ------------------------------------------------------------------------- */

export interface ExtractedText {
  text: string;
  /** True when {@link MAX_EXTRACTED_CHARS} forced an elision. */
  truncated: boolean;
}

/**
 * Extracted document text, bounded.
 *
 * `truncateMiddle` rather than a head slice: a report's conclusion is at the end,
 * and a document silently cut at 120k characters loses exactly the part that was
 * being asked about. The marker it leaves says how much went.
 */
export function boundExtractedText(raw: string, cap: number = MAX_EXTRACTED_CHARS): ExtractedText {
  if (raw.length <= cap) return { text: raw, truncated: false };
  return { text: truncateMiddle(raw, cap), truncated: true };
}

/**
 * Media type for a picked file, preferring what the system said.
 *
 * Android's document providers routinely return `application/octet-stream` for a
 * `.md` file, and a wildcard type that fails the textual check turns a readable
 * file into a refusal. The extension is the fallback, never the override.
 */
export function mediaTypeFor(name: string | undefined, provided: string | undefined): string {
  const given = (provided ?? '').toLowerCase();
  if (given && given !== 'application/octet-stream' && given !== '*/*') return given;
  const extension = (name ?? '').toLowerCase().split('.').pop() ?? '';
  return TYPE_BY_EXTENSION[extension] ?? given ?? '';
}

/** Whether the app can read this file as text rather than encoding its bytes. */
export function isTextualDocument(mediaType: string, name?: string): boolean {
  const type = (mediaType || '').toLowerCase();
  if (TEXTUAL_TYPES.has(type)) return true;
  if (type.startsWith('text/')) return true;
  if (!name) return false;
  const guess = mediaTypeFor(name, undefined);
  return TEXTUAL_TYPES.has(guess) || guess.startsWith('text/');
}

/* ------------------------------------------------------------------------- */
/* Description                                                                */
/* ------------------------------------------------------------------------- */

/**
 * One line describing what is staged, for the composer's strip.
 *
 * Size *and* tokens, because they are the two different reasons a user might drop
 * one: the first is what the upload costs on a phone connection, the second is what
 * it costs in the window for the rest of the conversation.
 */
export function describeAttachments(blocks: readonly ContentBlock[]): string {
  const { count, bytes, tokens } = attachmentSize(blocks);
  if (count === 0) return '';
  const images = blocks.filter((block) => block.type === 'image').length;
  const documents = count - images;
  const parts: string[] = [];
  if (images) parts.push(`${images} image${images === 1 ? '' : 's'}`);
  if (documents) parts.push(`${documents} document${documents === 1 ? '' : 's'}`);
  return `${parts.join(' · ')} · ${formatBytes(bytes)} · ~${tokens.toLocaleString('en-US')} tokens`;
}

/** A staged image, as the store and the composer pass it around. */
export function imageBlock(mediaType: string, data: string): ImageBlock {
  return { type: 'image', mediaType, data };
}
