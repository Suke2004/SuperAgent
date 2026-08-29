/**
 * Keyboard behaviour every modal in this app owes its users.
 *
 * React Native's `Modal` gives you a `Pressable` backdrop and the Android back
 * button, and nothing else. On web that leaves two real defects: Tab walks straight
 * out of the sheet and into the screen underneath — which is still rendered, still
 * focusable, and invisible behind the scrim — and Escape does nothing, so a
 * keyboard-only user who opens a sheet by mistake has no way out that does not
 * involve tabbing blindly until something closes.
 *
 * Both are fixed here rather than in each sheet, because there are four modals and
 * they would each get a slightly different half of the behaviour.
 *
 * Native is not neglected, only served differently: `accessibilityViewIsModal` on
 * the container is the platform's own version of this, and the hardware back button
 * already maps to `onRequestClose`. So this hook is deliberately web-only, and
 * returns a ref that is harmless to attach on every platform.
 */

import { useEffect, useRef } from 'react';
import { Platform } from 'react-native';
import type { View } from 'react-native';

/** What the browser will let you focus. Excludes anything explicitly removed from the tab order. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

/**
 * Traps Tab inside the returned ref's subtree and closes on Escape.
 *
 * Attach the ref to the sheet's own container — not the backdrop — or the trap will
 * happily include the backdrop's close button as its only stop.
 *
 * Focus is restored to whatever was focused before the sheet opened, so dismissing
 * a message menu puts the caret back on the message rather than at the top of the
 * transcript.
 */
export function useDialogKeys(visible: boolean, onClose: () => void) {
  const ref = useRef<View | null>(null);

  useEffect(() => {
    if (!visible || Platform.OS !== 'web') return;

    // On react-native-web a `View` ref *is* the DOM node; the cast is the price of
    // one type shared across platforms that do not have a DOM at all.
    const node = ref.current as unknown as HTMLElement | null;
    if (!node) return;

    const stops = (): HTMLElement[] =>
      Array.from(node.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
        (el) => el.getAttribute('aria-hidden') !== 'true',
      );

    const restoreTo = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // Focus the first control rather than the container: a screen reader then reads
    // the sheet's first action instead of announcing an empty group.
    const [firstOnOpen] = stops();
    (firstOnOpen ?? node).focus?.();

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const items = stops();
      const first = items[0];
      const last = items[items.length - 1];
      if (!first || !last) return;

      const active = document.activeElement;
      if (!(active instanceof HTMLElement) || !node.contains(active)) {
        event.preventDefault();
        first.focus();
        return;
      }
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };

    // Capture phase: the sheet's own children must not be able to swallow Escape.
    document.addEventListener('keydown', onKeyDown, true);
    return () => {
      document.removeEventListener('keydown', onKeyDown, true);
      restoreTo?.focus?.();
    };
  }, [visible, onClose]);

  return ref;
}
