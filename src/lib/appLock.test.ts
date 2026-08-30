/**
 * The two failure modes worth a test: hardware without enrolment must not offer the
 * lock, and a throwing sensor must not read as a successful unlock.
 */

// Built inside the factory: `jest.mock` is hoisted above any `const` out here.
jest.mock('expo-local-authentication', () => ({
  __esModule: true,
  hasHardwareAsync: jest.fn(async () => true),
  isEnrolledAsync: jest.fn(async () => true),
  authenticateAsync: jest.fn(async () => ({ success: true })),
}));

import * as LocalAuthentication from 'expo-local-authentication';

import { appLockAvailable, unlockApp } from './appLock';

const auth = LocalAuthentication as unknown as {
  hasHardwareAsync: jest.Mock;
  isEnrolledAsync: jest.Mock;
  authenticateAsync: jest.Mock;
};

describe('app lock', () => {
  it('is unavailable when nothing is enrolled, even with the hardware', async () => {
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(false);
    await expect(appLockAvailable()).resolves.toBe(false);
  });

  it('is available with hardware and an enrolment', async () => {
    auth.hasHardwareAsync.mockResolvedValue(true);
    auth.isEnrolledAsync.mockResolvedValue(true);
    await expect(appLockAvailable()).resolves.toBe(true);
  });

  it('treats a thrown prompt as a failed unlock, not a granted one', async () => {
    auth.authenticateAsync.mockRejectedValue(new Error('sensor unavailable'));
    await expect(unlockApp()).resolves.toBe(false);
  });

  it('passes a cancelled prompt through as a failure', async () => {
    auth.authenticateAsync.mockResolvedValue({ success: false, error: 'user_cancel' });
    await expect(unlockApp()).resolves.toBe(false);
  });
});
