/**
 * The database key, as SQLCipher wants to see it.
 *
 * Pure string handling, kept out of `./schema` so it can be tested without
 * `expo-sqlite`, `expo-crypto` or a device.
 *
 * The one decision worth explaining is the *raw key* form. `PRAGMA key = 'text'`
 * treats the value as a passphrase and runs 256,000 rounds of PBKDF2 over it on
 * every open, which is the right thing for something a human typed and pure cost
 * for 32 bytes that came out of a CSPRNG — there is no weaker guess to slow down.
 * `PRAGMA key = "x'<64 hex>'"` hands SQLCipher the key material directly and skips
 * derivation, so a cold start does not pay for stretching entropy that is already
 * full strength.
 */

/** 32 bytes: SQLCipher's raw key is AES-256, so this length is not negotiable. */
export const KEY_BYTES = 32;

const KEY_HEX = /^[0-9a-f]{64}$/;

/** Whether a stored value is usable as a raw key, rather than truncated or re-encoded. */
export function isKeyHex(value: string): boolean {
  return KEY_HEX.test(value);
}

/**
 * Lower-case hex for `bytes`, refusing anything that is not a full key.
 *
 * Throwing rather than padding is deliberate: a short read from the random source
 * would otherwise silently encrypt the database under a weaker key, and there is
 * no later point at which that becomes visible.
 */
export function keyHexFrom(bytes: Uint8Array): string {
  if (bytes.length !== KEY_BYTES) {
    throw new Error(`A database key needs ${KEY_BYTES} bytes of entropy, got ${bytes.length}`);
  }
  let hex = '';
  for (const byte of bytes) hex += byte.toString(16).padStart(2, '0');
  return hex;
}

/**
 * The `PRAGMA key` statement for a raw key.
 *
 * Validated even though the only caller reads from the Keystore: this is string
 * interpolation into SQL that cannot be parameterised — `PRAGMA` takes no bindings —
 * so the guard is the only thing standing between a corrupted Keystore entry and a
 * statement of somebody else's choosing.
 */
export function keyPragma(hex: string): string {
  if (!isKeyHex(hex)) throw new Error('Refusing to open the database with a malformed key');
  return `PRAGMA key = "x'${hex}'"`;
}

/** The same, for the `KEY` clause of `ATTACH`, which the plaintext migration needs. */
export function attachKeyClause(hex: string): string {
  if (!isKeyHex(hex)) throw new Error('Refusing to attach a database with a malformed key');
  return `KEY "x'${hex}'"`;
}
