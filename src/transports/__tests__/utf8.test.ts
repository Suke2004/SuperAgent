import { Utf8StreamDecoder, utf8Length } from '../utf8';

function bytes(...values: number[]): Uint8Array {
  return new Uint8Array(values);
}

/** Encode with the platform encoder so tests describe real byte sequences. */
function encode(text: string): Uint8Array {
  const out: number[] = [];
  for (const char of text) {
    const code = char.codePointAt(0) as number;
    if (code < 0x80) out.push(code);
    else if (code < 0x800) out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    else if (code < 0x10000) out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    else
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
  }
  return new Uint8Array(out);
}

describe('Utf8StreamDecoder', () => {
  it('decodes ASCII', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(encode('hello world'))).toBe('hello world');
    expect(decoder.flush()).toBe('');
  });

  it('decodes two, three and four byte sequences', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(encode('é 中 😀'))).toBe('é 中 😀');
  });

  it('holds back a two-byte sequence split across chunks', () => {
    const decoder = new Utf8StreamDecoder();
    const encoded = encode('é'); // 0xC3 0xA9
    expect(decoder.decode(encoded.slice(0, 1))).toBe('');
    expect(decoder.decode(encoded.slice(1))).toBe('é');
  });

  it('holds back a three-byte sequence split at either boundary', () => {
    const encoded = encode('中'); // 0xE4 0xB8 0xAD
    for (const cut of [1, 2]) {
      const decoder = new Utf8StreamDecoder();
      expect(decoder.decode(encoded.slice(0, cut))).toBe('');
      expect(decoder.decode(encoded.slice(cut))).toBe('中');
    }
  });

  it('holds back a four-byte emoji split at every boundary', () => {
    const encoded = encode('😀');
    for (const cut of [1, 2, 3]) {
      const decoder = new Utf8StreamDecoder();
      expect(decoder.decode(encoded.slice(0, cut))).toBe('');
      expect(decoder.decode(encoded.slice(cut))).toBe('😀');
    }
  });

  it('decodes a long mixed string byte-by-byte identically to all at once', () => {
    const text = 'Hello 世界 — naïve café 😀🎉 done. Здравствуй, Grüße!';
    const encoded = encode(text);

    const whole = new Utf8StreamDecoder();
    expect(whole.decode(encoded) + whole.flush()).toBe(text);

    const oneByte = new Utf8StreamDecoder();
    let out = '';
    for (let i = 0; i < encoded.length; i += 1) {
      out += oneByte.decode(encoded.slice(i, i + 1));
    }
    expect(out + oneByte.flush()).toBe(text);
  });

  it('decodes correctly at every chunk size', () => {
    const text = 'streaming 流式 tokens 😀 arrive at arbitrary boundaries';
    const encoded = encode(text);
    for (const size of [1, 2, 3, 4, 5, 8, 16, 31]) {
      const decoder = new Utf8StreamDecoder();
      let out = '';
      for (let i = 0; i < encoded.length; i += size) {
        out += decoder.decode(encoded.slice(i, i + size));
      }
      expect(out + decoder.flush()).toBe(text);
    }
  });

  it('replaces a lone continuation byte rather than throwing', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(bytes(0x41, 0x80, 0x42))).toBe('A�B');
  });

  it('replaces an invalid lead byte', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(bytes(0x41, 0xff, 0x42))).toBe('A�B');
  });

  it('replaces a truncated sequence on flush', () => {
    const decoder = new Utf8StreamDecoder();
    expect(decoder.decode(bytes(0xe4, 0xb8))).toBe('');
    expect(decoder.flush()).toBe('�');
  });

  it('rejects overlong three-byte encodings', () => {
    const decoder = new Utf8StreamDecoder();
    // 0xE0 0x80 0x80 would decode to U+0000 as an overlong form.
    expect(decoder.decode(bytes(0xe0, 0x80, 0x80))).toBe('���');
  });

  it('rejects UTF-8-encoded surrogates', () => {
    const decoder = new Utf8StreamDecoder();
    // 0xED 0xA0 0x80 is U+D800, which is not a valid scalar value.
    expect(decoder.decode(bytes(0xed, 0xa0, 0x80))).toContain('�');
  });

  it('resets held-back state', () => {
    const decoder = new Utf8StreamDecoder();
    decoder.decode(bytes(0xe4, 0xb8));
    decoder.reset();
    expect(decoder.flush()).toBe('');
    expect(decoder.decode(encode('ok'))).toBe('ok');
  });
});

describe('utf8Length', () => {
  it('counts ASCII as one byte each', () => {
    expect(utf8Length('hello')).toBe(5);
  });

  it('counts multi-byte characters correctly', () => {
    expect(utf8Length('é')).toBe(2);
    expect(utf8Length('中')).toBe(3);
    expect(utf8Length('😀')).toBe(4);
  });

  it('matches the encoder for a mixed string', () => {
    const text = 'a é 中 😀 end';
    expect(utf8Length(text)).toBe(encode(text).length);
  });

  it('counts an unpaired high surrogate as three bytes', () => {
    expect(utf8Length('\uD800')).toBe(3);
  });
});
