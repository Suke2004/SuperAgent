/**
 * Haptics cannot break the thing they decorate.
 *
 * The only logic in `@/lib/haptics` is the failure swallowing, and it is the whole
 * point of the module: `expo-haptics` rejects on web, on a simulator and on a phone
 * whose motor is off, and it throws outright when the native module is not in the
 * running binary. Every call site fires without awaiting, so either one would surface
 * as an unhandled rejection or a red box on an otherwise successful send.
 *
 * The module is mocked rather than spied on because it ships ESM this CommonJS suite
 * cannot parse — the same reason `chat.tools.test.ts` mocks `expo-file-system`.
 */

/** What each wrapper asked for, recorded from inside the mock. */
const mockCalls: string[] = [];

jest.mock('expo-haptics', () => ({
  // The two ways it goes wrong, one each: a throw (module not linked) and a
  // rejection (linked, but the hardware said no).
  impactAsync: (style: string) => {
    mockCalls.push(`impact:${style}`);
    throw new Error('expo-haptics is not in this binary');
  },
  notificationAsync: (type: string) => {
    mockCalls.push(`notify:${type}`);
    return Promise.reject(new Error('no vibrator'));
  },
  ImpactFeedbackStyle: { Light: 'light' },
  NotificationFeedbackType: { Success: 'success', Warning: 'warning' },
}));

import * as haptics from '@/lib/haptics';

test('a device that cannot buzz is not an error', async () => {
  const unhandled = jest.fn();
  process.on('unhandledRejection', unhandled);

  expect(() => {
    haptics.tap();
    haptics.confirm();
    haptics.warn();
  }).not.toThrow();

  // Two ticks: one for the rejection, one for Node to decide it was unhandled.
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
  await new Promise<void>((resolve) => setImmediate(() => resolve()));
  process.off('unhandledRejection', unhandled);

  expect(unhandled).not.toHaveBeenCalled();
  expect(mockCalls).toEqual(['impact:light', 'notify:success', 'notify:warning']);
});
