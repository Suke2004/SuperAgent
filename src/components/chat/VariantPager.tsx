/**
 * The ‹ 2 of 3 › under a regenerated reply.
 *
 * Regenerating used to delete the answer it replaced, which made "try again" a
 * gamble: the second attempt could be worse and the first was gone. The old reply
 * is now kept as a variant of the same turn, and this is the only way back to it.
 *
 * Only the newest reply has variants — see `@/db/variants` — so this lives at the
 * foot of the transcript rather than under every message. Renders nothing until
 * there is an actual choice: one answer is not a set, and an arrow with nowhere to
 * go is worse than no arrow.
 */

import { Pressable, View } from 'react-native';

import { Body } from '@/components/ui';
import type { TurnVariant } from '@/db/conversations';
import { useTheme } from '@/theme';

export function VariantPager({
  variants,
  onSelect,
}: {
  /** Oldest attempt first, with exactly one marked selected. */
  variants: readonly TurnVariant[];
  onSelect: (index: number) => void;
}) {
  const t = useTheme();
  const current = variants.findIndex((v) => v.selected);
  if (variants.length < 2 || current < 0) return null;

  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'center',
        gap: t.spacing.sm,
        paddingTop: t.spacing.md,
      }}
    >
      <Arrow
        label="Previous version of this reply"
        glyph="‹"
        disabled={current === 0}
        onPress={() => onSelect(current - 1)}
      />
      {/* Announced as one string rather than three nodes: a screen reader reading
          "‹", "2 of 3", "›" as separate stops is how a pager becomes unusable. */}
      <Body size="xs" tone="faint" accessibilityLabel={`Version ${current + 1} of ${variants.length}`}>
        {current + 1} of {variants.length}
      </Body>
      <Arrow
        label="Next version of this reply"
        glyph="›"
        disabled={current === variants.length - 1}
        onPress={() => onSelect(current + 1)}
      />
    </View>
  );
}

function Arrow({
  label,
  glyph,
  disabled,
  onPress,
}: {
  label: string;
  glyph: string;
  disabled: boolean;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ disabled }}
      // The glyph is small; the target is not. 44dp is the floor a thumb needs.
      hitSlop={12}
      style={({ pressed }) => ({
        minWidth: 32,
        alignItems: 'center',
        paddingVertical: t.spacing.xs,
        borderRadius: t.radius.md,
        opacity: disabled ? 0.35 : 1,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <Body size="sm" tone="faint">
        {glyph}
      </Body>
    </Pressable>
  );
}
