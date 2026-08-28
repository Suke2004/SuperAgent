/**
 * Incremental UTF-8 decoder.
 *
 * `expo/fetch` hands us `Uint8Array` chunks, and a chunk boundary can fall in
 * the middle of a multi-byte character — which happens constantly once responses
 * contain CJK text, emoji, or the `…` the gateway likes to use. Relying on
 * `TextDecoder({stream: true})` means relying on Hermes' Intl build shipping a
 * streaming-capable implementation, which is not something to bet the whole
 * streaming path on.
 *
 * So: hold back at most three trailing bytes that form an incomplete sequence,
 * and prepend them to the next chunk. Invalid sequences become U+FFFD rather
 * than throwing, because a malformed byte must not kill an in-flight stream.
 */

/** Expected total length of a UTF-8 sequence given its lead byte, or 0 if invalid. */
function sequenceLength(lead: number): number {
  if (lead < 0x80) return 1;
  if (lead >= 0xc2 && lead <= 0xdf) return 2;
  if (lead >= 0xe0 && lead <= 0xef) return 3;
  if (lead >= 0xf0 && lead <= 0xf4) return 4;
  return 0; // continuation byte or overlong/invalid lead
}

const REPLACEMENT = '�';

export class Utf8StreamDecoder {
  private leftover: Uint8Array = new Uint8Array(0);

  /** Decode a chunk, holding back any trailing incomplete sequence. */
  decode(chunk: Uint8Array): string {
    let buffer: Uint8Array;
    if (this.leftover.length === 0) {
      buffer = chunk;
    } else {
      buffer = new Uint8Array(this.leftover.length + chunk.length);
      buffer.set(this.leftover, 0);
      buffer.set(chunk, this.leftover.length);
    }

    // Walk back from the end looking for a lead byte that starts a sequence
    // extending past the buffer. At most 3 continuation bytes can precede it.
    let cut = buffer.length;
    for (let back = 1; back <= 4 && back <= buffer.length; back += 1) {
      const index = buffer.length - back;
      const byte = buffer[index] as number;
      if (byte < 0x80 || byte >= 0xc0) {
        // A lead byte (or ASCII). Does its sequence complete inside the buffer?
        const needed = sequenceLength(byte);
        if (needed > 0 && index + needed > buffer.length) cut = index;
        break;
      }
      // Continuation byte: keep scanning backwards for its lead.
    }

    this.leftover = cut < buffer.length ? buffer.slice(cut) : new Uint8Array(0);
    return decodeComplete(buffer, 0, cut);
  }

  /**
   * Flush any held-back bytes at end of stream. A truncated sequence here is
   * genuinely malformed, so it decodes to replacement characters.
   */
  flush(): string {
    if (this.leftover.length === 0) return '';
    const out = decodeComplete(this.leftover, 0, this.leftover.length, true);
    this.leftover = new Uint8Array(0);
    return out;
  }

  reset(): void {
    this.leftover = new Uint8Array(0);
  }
}

function decodeComplete(bytes: Uint8Array, start: number, end: number, atEnd = false): string {
  let out = '';
  let i = start;
  while (i < end) {
    const byte = bytes[i] as number;

    if (byte < 0x80) {
      out += String.fromCharCode(byte);
      i += 1;
      continue;
    }

    const needed = sequenceLength(byte);
    if (needed === 0) {
      out += REPLACEMENT;
      i += 1;
      continue;
    }
    if (i + needed > end) {
      // Only reachable via flush(); the streaming path holds these back.
      out += REPLACEMENT;
      i = atEnd ? end : i + 1;
      continue;
    }

    let codePoint: number;
    let valid = true;
    if (needed === 2) {
      const b1 = bytes[i + 1] as number;
      valid = (b1 & 0xc0) === 0x80;
      codePoint = ((byte & 0x1f) << 6) | (b1 & 0x3f);
    } else if (needed === 3) {
      const b1 = bytes[i + 1] as number;
      const b2 = bytes[i + 2] as number;
      valid = (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80;
      codePoint = ((byte & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f);
      // Reject overlong forms and UTF-16 surrogates encoded as UTF-8.
      if (codePoint < 0x800 || (codePoint >= 0xd800 && codePoint <= 0xdfff)) valid = false;
    } else {
      const b1 = bytes[i + 1] as number;
      const b2 = bytes[i + 2] as number;
      const b3 = bytes[i + 3] as number;
      valid = (b1 & 0xc0) === 0x80 && (b2 & 0xc0) === 0x80 && (b3 & 0xc0) === 0x80;
      codePoint = ((byte & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      if (codePoint < 0x10000 || codePoint > 0x10ffff) valid = false;
    }

    if (!valid) {
      out += REPLACEMENT;
      i += 1;
      continue;
    }

    if (codePoint > 0xffff) {
      const adjusted = codePoint - 0x10000;
      out += String.fromCharCode(0xd800 + (adjusted >> 10), 0xdc00 + (adjusted & 0x3ff));
    } else {
      out += String.fromCharCode(codePoint);
    }
    i += needed;
  }
  return out;
}

/** Encode a string to UTF-8 bytes. Used for byte-accurate request sizing. */
export function utf8Length(input: string): number {
  let bytes = 0;
  for (let i = 0; i < input.length; i += 1) {
    const code = input.charCodeAt(i);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff && i + 1 < input.length) {
      const next = input.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        i += 1;
      } else {
        bytes += 3;
      }
    } else bytes += 3;
  }
  return bytes;
}
