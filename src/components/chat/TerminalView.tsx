/**
 * Command output, rendered as a terminal.
 *
 * Same chrome as {@link CodeBlock} — a header, a copy button, one non-wrapping line
 * per line inside a horizontal scroller — because command output is code by every
 * property that matters: monospaced, indentation-carrying, and ruined by rewrapping.
 * What it adds is the colour a shell actually sent, which a code block prints as
 * `[0;32m` down the side of every line.
 *
 * The ANSI palette is the highlighter's, mapped by hue rather than invented: eight
 * more theme keys for a pane most users never open is worse than reusing twelve that
 * are already contrast-tested against `surfaceAlt`.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';

import { parseTerminal, plainTerminal } from '@/chat/terminal';
import type { AnsiColor } from '@/chat/terminal';
import { syntaxColors } from '@/components/markdown/syntax';
import { Body } from '@/components/ui';
import * as haptics from '@/lib/haptics';
import { useTheme } from '@/theme';
import type { ResolvedScheme } from '@/theme';

const COPIED_MS = 1600;

/** ANSI's eight colours onto the highlighter's roles, by hue. */
function ansiColors(scheme: ResolvedScheme): Readonly<Record<AnsiColor, string>> {
  const s = syntaxColors(scheme);
  return {
    // Never the literal black: a shell that prints it assumes a light background.
    black: s.punctuation,
    red: s.keyword,
    green: s.inserted,
    yellow: s.type,
    blue: s.number,
    magenta: s.function,
    cyan: s.operator,
    white: s.plain,
  };
}

export function TerminalView({ output }: { output: string }) {
  const t = useTheme();
  const palette = useMemo(() => ansiColors(t.scheme), [t.scheme]);
  const plain = syntaxColors(t.scheme).plain;
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  // Re-parsed only when the text changes: a streaming tool result re-renders the
  // transcript row on every delta, and this walks the whole output.
  const screen = useMemo(() => parseTerminal(output), [output]);

  const onCopy = useCallback(() => {
    // The escapes are stripped for the clipboard — what is pasted should be what was
    // read, not the control codes behind it.
    void Clipboard.setStringAsync(plainTerminal(output));
    haptics.confirm();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [output]);

  const lineHeight = Math.round(t.fontSize.code * 1.5);

  return (
    <View
      style={{
        backgroundColor: t.colors.surfaceAlt,
        borderWidth: StyleSheet.hairlineWidth,
        borderColor: t.colors.border,
        borderRadius: t.radius.md,
        overflow: 'hidden',
      }}
    >
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingLeft: t.spacing.md,
          paddingRight: t.spacing.xs,
          paddingVertical: t.spacing.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.colors.border,
        }}
      >
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, fontWeight: '700' }} numberOfLines={1}>
          {screen.dropped
            ? `terminal · first ${screen.dropped.toLocaleString()} lines not shown`
            : 'terminal'}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={copied ? 'Copied' : 'Copy output'}
          accessibilityHint="Copies the output without its colour codes"
          onPress={onCopy}
          hitSlop={8}
          style={({ pressed }) => ({
            paddingHorizontal: t.spacing.sm,
            paddingVertical: t.spacing.xs,
            borderRadius: t.radius.sm,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
          })}
        >
          <Text style={{ color: copied ? t.colors.success : t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>
            {copied ? 'Copied' : 'Copy'}
          </Text>
        </Pressable>
      </View>

      {screen.lines.length === 0 ? (
        <View style={{ padding: t.spacing.md }}>
          <Body size="sm" tone="faint">
            The command printed nothing.
          </Body>
        </View>
      ) : (
        <ScrollView
          horizontal
          showsHorizontalScrollIndicator
          directionalLockEnabled
          contentContainerStyle={{ padding: t.spacing.md }}
          // One label for the pane: a screen reader that reads 500 rows of build
          // output line by line is unusable, and the copy button is the way out.
          accessible
          accessibilityLabel={`Command output, ${screen.lines.length.toLocaleString()} lines`}
        >
          <View>
            {screen.lines.map((spans, index) => (
              <Text
                key={index}
                selectable
                style={{ fontFamily: t.monoFont, fontSize: t.fontSize.code, lineHeight, color: plain }}
              >
                {spans.length === 0
                  ? ' '
                  : spans.map((span, spanIndex) => (
                      <Text
                        key={spanIndex}
                        style={{
                          ...(span.color !== undefined ? { color: palette[span.color] } : null),
                          ...(span.bold ? { fontWeight: '700' as const } : null),
                          ...(span.dim ? { opacity: 0.6 } : null),
                        }}
                      >
                        {span.text}
                      </Text>
                    ))}
              </Text>
            ))}
          </View>
        </ScrollView>
      )}
    </View>
  );
}
