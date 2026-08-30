/**
 * A bottom sheet of actions.
 *
 * Android's own long-press menus are `Alert.alert` with three buttons, which is
 * where a seven-action message menu goes to die. This is a `Modal` instead: it
 * scrolls, it can explain why an action is unavailable, and it closes on the
 * hardware back button — which `Alert` on Android will also do, but only by
 * cancelling, and only if you remember to mark a cancel button.
 *
 * Actions that cannot be taken are shown and explained rather than hidden.
 * "Regenerate" vanishing from the menu teaches the user nothing; "Regenerate —
 * needs an API key" tells them what to go and do.
 */

import { useState } from 'react';
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';

import { useDialogKeys } from '@/components/dialog';
import { Body, Button, Divider, Field, Inline, useKeyboardHeight } from '@/components/ui';
import { useTheme } from '@/theme';

export interface SheetAction {
  label: string;
  onPress: () => void;
  /** Rendered in the danger colour. Does not add a confirmation — do that yourself. */
  destructive?: boolean;
  disabled?: boolean;
  /** Why it is unavailable. Shown under the label; required in spirit if disabled. */
  disabledReason?: string;
  subtitle?: string;
}

export function Sheet({
  visible,
  title,
  subtitle,
  body,
  actions,
  onClose,
}: {
  visible: boolean;
  title: string;
  subtitle?: string;
  /**
   * A paragraph above the actions, for a sheet whose job is to explain something.
   *
   * `subtitle` is clamped to two lines because it describes the thing the actions
   * act on; this is for the sheets that are the explanation.
   */
  body?: string;
  actions: readonly SheetAction[];
  onClose: () => void;
}) {
  const t = useTheme();
  const trap = useDialogKeys(visible, onClose);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="fade"
      // The Android back button. Without this the sheet is a trap.
      onRequestClose={onClose}
      statusBarTranslucent
    >
      <Pressable
        onPress={onClose}
        accessibilityLabel="Close menu"
        style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }}
      >
        {/* A second Pressable that swallows the press, so a tap inside the sheet
            does not fall through to the backdrop and close it. */}
        <Pressable
          ref={trap}
          onPress={() => {}}
          // iOS's own focus trap: VoiceOver stops offering the screen underneath.
          accessibilityViewIsModal
          style={{
            backgroundColor: t.colors.surface,
            borderTopLeftRadius: t.radius.lg,
            borderTopRightRadius: t.radius.lg,
            paddingBottom: t.spacing.xl,
            maxHeight: '80%',
          }}
        >
          <View style={{ padding: t.spacing.md, gap: 2 }}>
            <Text style={{ color: t.colors.text, fontSize: t.fontSize.md, fontWeight: '700' }}>{title}</Text>
            {subtitle ? (
              <Body size="xs" tone="faint" numberOfLines={2}>
                {subtitle}
              </Body>
            ) : null}
          </View>
          <Divider />

          <ScrollView>
            {body ? (
              <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md }}>
                <Body size="sm" tone="dim">
                  {body}
                </Body>
              </View>
            ) : null}
            {actions.map((action, index) => (
              <View key={action.label}>
                {index > 0 ? <Divider /> : null}
                <Pressable
                  disabled={action.disabled}
                  accessibilityRole="button"
                  accessibilityState={{ disabled: Boolean(action.disabled) }}
                  accessibilityHint={action.disabled ? action.disabledReason : action.subtitle}
                  onPress={() => {
                    // Close first: several of these navigate, and a sheet still
                    // mounted over a push is a sheet over the wrong screen.
                    onClose();
                    action.onPress();
                  }}
                  style={({ pressed }) => ({
                    paddingHorizontal: t.spacing.md,
                    paddingVertical: t.spacing.md,
                    gap: 2,
                    opacity: action.disabled ? 0.45 : 1,
                    backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
                  })}
                >
                  <Text
                    style={{
                      color: action.destructive ? t.colors.danger : t.colors.text,
                      fontSize: t.fontSize.md,
                    }}
                  >
                    {action.label}
                  </Text>
                  {action.disabled && action.disabledReason ? (
                    <Body size="xs" tone="faint">
                      {action.disabledReason}
                    </Body>
                  ) : action.subtitle ? (
                    <Body size="xs" tone="faint">
                      {action.subtitle}
                    </Body>
                  ) : null}
                </Pressable>
              </View>
            ))}
          </ScrollView>
        </Pressable>
      </Pressable>
    </Modal>
  );
}

/**
 * A sheet that asks for one piece of text.
 *
 * Rename, tags, system prompt and edit-in-place are all this shape, and
 * `Alert.prompt` does not exist on Android.
 *
 * The draft lives in {@link PromptBody}, which exists only while the sheet is
 * open, so mounting *is* the reset: cancelling genuinely discards, and reopening
 * shows the stored value again. That is why there is no effect syncing `initial`
 * into state — a synced draft is the version of this component where an abandoned
 * edit reappears three screens later.
 */
export function PromptSheet(props: PromptSheetProps) {
  return (
    <Modal
      visible={props.visible}
      transparent
      animationType="fade"
      onRequestClose={props.onCancel}
      statusBarTranslucent
    >
      {/* Explicit rather than relying on `Modal` to unmount its children when
          hidden: the state reset depends on it. */}
      {props.visible ? <PromptBody {...props} /> : null}
    </Modal>
  );
}

interface PromptSheetProps {
  visible: boolean;
  title: string;
  hint?: string;
  initial: string;
  placeholder?: string;
  rows?: number;
  confirmLabel?: string;
  /** For fields where clearing is a meaningful action, e.g. the system prompt. */
  allowEmpty?: boolean;
  onCancel: () => void;
  onConfirm: (text: string) => void;
}

function PromptBody({
  title,
  hint,
  initial,
  placeholder,
  rows = 1,
  confirmLabel = 'Save',
  allowEmpty = false,
  onCancel,
  onConfirm,
}: PromptSheetProps) {
  const t = useTheme();
  const [text, setText] = useState(initial);
  const trap = useDialogKeys(true, onCancel);
  // The field autofocuses, so the keyboard is always up while this sheet is open —
  // and an edge-to-edge Android window does not resize for it, so the sheet has to
  // lift itself or it opens underneath the keys. See `useKeyboardHeight`.
  const keyboardHeight = useKeyboardHeight();

  const blocked = !allowEmpty && text.trim().length === 0;

  return (
    <Pressable
      onPress={onCancel}
      accessibilityLabel="Cancel"
      style={{ flex: 1, backgroundColor: '#00000088', justifyContent: 'flex-end' }}
    >
      <Pressable
        ref={trap}
        onPress={() => {}}
        accessibilityViewIsModal
        style={{
          backgroundColor: t.colors.surface,
          borderTopLeftRadius: t.radius.lg,
          borderTopRightRadius: t.radius.lg,
          padding: t.spacing.md,
          paddingBottom: t.spacing.xl,
          marginBottom: keyboardHeight,
          gap: t.spacing.md,
        }}
      >
        <Text style={{ color: t.colors.text, fontSize: t.fontSize.md, fontWeight: '700' }}>{title}</Text>
        <Field
          value={text}
          onChangeText={setText}
          rows={rows}
          autoFocus
          // `Field` defaults to identifier-friendly input, which is wrong here:
          // every one of these fields is prose the user wrote.
          autoCapitalize="sentences"
          autoCorrect
          {...(placeholder !== undefined ? { placeholder } : {})}
          {...(hint !== undefined ? { hint } : {})}
        />
        <Inline gap="sm">
          <Button
            label={confirmLabel}
            onPress={() => onConfirm(text)}
            variant="primary"
            disabled={blocked}
            {...(blocked ? { disabledReason: 'Nothing to save yet.' } : {})}
          />
          <Button label="Cancel" onPress={onCancel} variant="ghost" />
        </Inline>
      </Pressable>
    </Pressable>
  );
}
