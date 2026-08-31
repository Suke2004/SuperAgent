/**
 * The slash-command list.
 *
 * Typing `/` at the start of a draft is the fastest way to reach the things this app
 * keeps behind sheets — a model, a skill, a server, a saved prompt, an MCP prompt —
 * and before this existed there was no way to reach them at all without leaving the
 * keyboard. The ranking and the index live in `@/chat/commands`, which is pure and
 * tested; this file is the list and nothing else.
 *
 * It sits above the composer rather than in a modal: the query is being typed into
 * the composer, so a sheet that covers it would hide the thing the list is filtering
 * on. It is capped in height and scrolls, because "every tool on every server" is a
 * plausible index and a list that pushes the input off screen is worse than no list.
 */

import { ScrollView, StyleSheet, Pressable, View } from 'react-native';

import type { CommandItem, CommandKind } from '@/chat/commands';
import { Body } from '@/components/ui';
import { useTheme } from '@/theme';

/** Roughly four rows. Past that the composer starts leaving the screen. */
const MAX_HEIGHT = 220;

/** What each kind is called in the list, so a name collision is still readable. */
const KIND_LABEL: Record<CommandKind, string> = {
  app: 'App',
  prompt: 'Prompt',
  skill: 'Skill',
  'mcp-prompt': 'Server',
};

export function CommandBar({
  items,
  onSelect,
}: {
  /** Already ranked and capped by `rankCommands`. Empty ⇒ nothing renders. */
  items: readonly CommandItem[];
  onSelect: (item: CommandItem) => void;
}) {
  const t = useTheme();
  if (!items.length) return null;

  return (
    <View
      accessibilityLabel="Commands"
      style={{
        marginHorizontal: t.spacing.md,
        maxHeight: MAX_HEIGHT,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        borderRadius: t.radius.lg,
        backgroundColor: t.colors.surface,
        overflow: 'hidden',
      }}
    >
      <ScrollView keyboardShouldPersistTaps="handled">
        {items.map((item, index) => (
          <Pressable
            key={`${item.kind}:${item.id}`}
            accessibilityRole="button"
            accessibilityLabel={`${KIND_LABEL[item.kind]}: ${item.label}`}
            {...(item.hint !== undefined ? { accessibilityHint: item.hint } : {})}
            onPress={() => onSelect(item)}
            style={({ pressed }) => ({
              paddingHorizontal: t.spacing.md,
              paddingVertical: t.spacing.sm,
              // 44dp minimum: this is a list of small targets stacked vertically,
              // which is exactly where a mis-tap costs the most.
              minHeight: 44,
              justifyContent: 'center',
              backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
              borderTopWidth: index === 0 ? 0 : StyleSheet.hairlineWidth,
              borderTopColor: t.colors.border,
            })}
          >
            <View style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.sm }}>
              <Body mono numberOfLines={1}>{`/${item.name}`}</Body>
              <Body size="xs" tone="faint">
                {KIND_LABEL[item.kind]}
              </Body>
            </View>
            {item.hint ? (
              <Body size="xs" tone="dim" numberOfLines={1}>
                {item.hint}
              </Body>
            ) : null}
          </Pressable>
        ))}
      </ScrollView>
    </View>
  );
}
