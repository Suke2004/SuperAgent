/**
 * The app lock.
 *
 * What it is for: the phone is unlocked and in someone else's hand. Android's
 * file-based encryption already protects the transcript database while the device is
 * locked, and `expo-sqlite` offers no SQLCipher option, so a passphrase on the
 * database would mean shipping our own crypto — this instead removes the only attack
 * the platform leaves open, a borrowed unlocked phone.
 *
 * What it is not: protection against a rooted device or a physical attacker with the
 * PIN. Both read the database directly and never see this screen. `docs/flaws.md`
 * §2.2 says so plainly rather than implying the lock is encryption.
 *
 * Device credentials are deliberately allowed as a fallback (`disableDeviceFallback`
 * left at its default): a user whose fingerprint sensor stops reading must not be
 * locked out of their own conversations.
 */

import * as LocalAuthentication from 'expo-local-authentication';

/**
 * Can this device lock at all?
 *
 * Hardware alone is not enough — a phone with a sensor and nothing enrolled would
 * offer a switch that then refuses every unlock, which is the one outcome worse than
 * no lock. Enrolment covers the PIN/pattern path too, so it is the single check.
 */
export async function appLockAvailable(): Promise<boolean> {
  try {
    return (await LocalAuthentication.hasHardwareAsync()) && (await LocalAuthentication.isEnrolledAsync());
  } catch {
    return false;
  }
}

/** Prompt, and report whether the user got through. Never throws. */
export async function unlockApp(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Jarvis',
      cancelLabel: 'Cancel',
    });
    return result.success;
  } catch {
    // A thrown authenticate is a broken sensor, not a granted unlock.
    return false;
  }
}
