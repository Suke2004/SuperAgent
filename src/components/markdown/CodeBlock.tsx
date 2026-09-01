/**
 * A fenced code block.
 *
 * The one module that imports refractor. It highlights, hands the HAST tree to
 * the pure {@link highlightLines}, and renders one non-wrapping `<Text>` per line
 * inside a horizontal scroller — code is not prose, and rewrapping a line at 40
 * characters destroys the indentation that carries its structure.
 *
 * refractor's default entry point is its ~35-language common bundle rather than
 * `refractor/all`, which registers 594 grammars into the JS bundle for languages
 * nobody will paste into a phone.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import * as Clipboard from 'expo-clipboard';
import { refractor } from 'refractor';

import { highlightLines, plainLines } from '@/components/markdown/highlight';
import type { HighlightSpan } from '@/components/markdown/highlight';
import { resolveLanguage, shouldHighlight } from '@/components/markdown/lang';
import { SYNTAX_ITALIC, syntaxColors } from '@/components/markdown/syntax';
import { ArtifactPreview } from '@/components/ArtifactPreview';
import { artifactKind } from '@/chat/artifact';
import * as haptics from '@/lib/haptics';
import { useTheme } from '@/theme';

const COPIED_MS = 1600;

/** refractor's own registry, as the predicate {@link resolveLanguage} wants. */
function isRegistered(name: string): boolean {
  return refractor.registered(name);
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const t = useTheme();
  const colors = syntaxColors(t.scheme);
  const [copied, setCopied] = useState(false);
  const [previewing, setPreviewing] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Clearing on unmount matters here: a transcript scrolls blocks out of the
  // window mid-timer, and setting state afterwards is a leak warning per block.
  useEffect(
    () => () => {
      if (timer.current) clearTimeout(timer.current);
    },
    [],
  );

  const language = useMemo(() => resolveLanguage(lang, isRegistered), [lang]);

  /**
   * The expensive part, and it runs again on every stream delta while the fence
   * is still open — hence the memo, and hence the size cap in `shouldHighlight`.
   *
   * A grammar can throw on input Prism's own lexer trips over, and a code block
   * that takes the transcript down with it is far worse than an uncoloured one.
   */
  const lines = useMemo<HighlightSpan[][]>(() => {
    if (!shouldHighlight(code, language)) return plainLines(code);
    try {
      return highlightLines(refractor.highlight(code, language));
    } catch {
      return plainLines(code);
    }
  }, [code, language]);

  const onCopy = useCallback(() => {
    void Clipboard.setStringAsync(code);
    haptics.confirm();
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  }, [code]);

  const lineHeight = Math.round(t.fontSize.code * 1.5);

  // A view of this fence, not a new kind of content: whether it can be rendered is a
  // property of the tag and the text, so old messages get the button too.
  const kind = useMemo(() => artifactKind(lang, code), [lang, code]);

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
        <Text
          style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, fontWeight: '700' }}
          numberOfLines={1}
        >
          {(lang ?? '').trim() || 'text'}
        </Text>
        <View style={{ flexDirection: 'row', alignItems: 'center' }}>
          {kind ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Preview this code rendered"
              accessibilityHint="Opens it full screen, with no network access"
              onPress={() => setPreviewing(true)}
              hitSlop={8}
              style={({ pressed }) => ({
                paddingHorizontal: t.spacing.sm,
                paddingVertical: t.spacing.xs,
                borderRadius: t.radius.sm,
                backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
              })}
            >
              <Text style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>Preview</Text>
            </Pressable>
          ) : null}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={copied ? 'Copied' : 'Copy code'}
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
      </View>

      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        // The transcript is a vertical list; without this a drag that starts on a
        // code block is claimed by the horizontal scroller and the list stalls.
        directionalLockEnabled
        contentContainerStyle={{ padding: t.spacing.md }}
      >
        <View>
          {lines.map((spans, index) => (
            <Text
              // Lines have no identity of their own, and the whole block is
              // rebuilt whenever the code changes, so the index is the key.
              key={index}
              selectable
              style={{
                fontFamily: t.monoFont,
                fontSize: t.fontSize.code,
                lineHeight,
                color: colors.plain,
              }}
            >
              {spans.length === 0
                ? // An empty line still needs to occupy one, and a zero-width
                  // string collapses it.
                  ' '
                : spans.map((span, spanIndex) => (
                    <Text
                      key={spanIndex}
                      style={{
                        color: colors[span.color],
                        ...(SYNTAX_ITALIC.has(span.color) ? { fontStyle: 'italic' as const } : null),
                      }}
                    >
                      {span.text}
                    </Text>
                  ))}
            </Text>
          ))}
        </View>
      </ScrollView>

      {/* Mounted only while open: a transcript with twenty fences in it should not be
          holding twenty WebViews, each of which is a browser. */}
      {kind && previewing ? (
        <ArtifactPreview visible code={code} kind={kind} onClose={() => setPreviewing(false)} />
      ) : null}
    </View>
  );
}
