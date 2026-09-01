/**
 * The three taps the app is allowed to make.
 *
 * A wrapper rather than calling `expo-haptics` at each site, for two reasons:
 *
 * 1. **It must never be able to break the thing it decorates.** The web build has no
 *    haptics at all and a simulator or a phone with the motor disabled rejects the
 *    call, so every one of these swallows its rejection. A send that fails because
 *    the buzz failed would be absurd.
 * 2. **Three names, not a taxonomy.** Deciding between eight `ImpactFeedbackStyle`
 *    values at the call site is how an app ends up feeling different in every
 *    corner. `tap` for "the app heard you", `confirm` for "it worked", `warn` for
 *    "something is gone".
 *
 * Fire and forget: none of these is awaited anywhere, because the feedback is for
 * the finger, not for the code that follows it.
 */

import * as Haptics from 'expo-haptics';

/**
 * Runs one buzz and drops whatever it does wrong.
 *
 * Both halves are load-bearing: the native module rejects when the hardware refuses,
 * and it throws outright when it is not linked into the running binary at all —
 * Expo Go, or a dev client built before this dependency was added.
 */
function fire(buzz: () => Promise<void>): void {
  try {
    void buzz().catch(() => {});
  } catch {
    /* no motor, no problem */
  }
}

/** A press landed — send, or a button that starts work. */
export function tap(): void {
  fire(() => Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light));
}

/** Something finished and there may be nothing on screen to show it — a copy. */
export function confirm(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success));
}

/** Something was destroyed. Heavier, because it is worth noticing. */
export function warn(): void {
  fire(() => Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning));
}
