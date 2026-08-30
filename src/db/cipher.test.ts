/**
 * The database key's string handling.
 *
 * Small surface, but it is the only thing between the Keystore and interpolated
 * SQL, so the malformed cases are what is actually worth pinning.
 */

import { attachKeyClause, isKeyHex, KEY_BYTES, keyHexFrom, keyPragma } from './cipher';

const KEY = 'a'.repeat(64);

describe('the raw database key', () => {
  it('renders 32 bytes as lower-case hex', () => {
    const bytes = new Uint8Array(KEY_BYTES).map((_v, i) => i);
    const hex = keyHexFrom(bytes);
    expect(hex).toHaveLength(64);
    expect(hex.startsWith('000102')).toBe(true);
    expect(isKeyHex(hex)).toBe(true);
  });

  it('refuses short entropy rather than padding it', () => {
    expect(() => keyHexFrom(new Uint8Array(16))).toThrow(/32 bytes/);
  });

  it('only accepts a full, lower-case key', () => {
    expect(isKeyHex(KEY.slice(0, 63))).toBe(false);
    expect(isKeyHex(KEY.toUpperCase())).toBe(false);
    expect(isKeyHex('')).toBe(false);
  });

  it('builds the raw-key pragma, which skips PBKDF2', () => {
    expect(keyPragma(KEY)).toBe(`PRAGMA key = "x'${KEY}'"`);
    expect(attachKeyClause(KEY)).toBe(`KEY "x'${KEY}'"`);
  });

  it('refuses to interpolate anything that is not a key', () => {
    // The Keystore is not a trust boundary the way a text field is, but this is the
    // one place a corrupt value would become SQL.
    expect(() => keyPragma(`${KEY.slice(0, 62)}'; DROP TABLE messages; --`)).toThrow(/malformed/);
    expect(() => attachKeyClause('')).toThrow(/malformed/);
  });
});
