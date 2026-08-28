/**
 * Inline tokens → text runs, for paragraphs, headings, list items and table cells.
 *
 * Everything here has to nest inside a single `<Text>`, because that is what makes
 * a line wrap as one line of prose. React Native honours nested `<Text>` styling
 * but not nested `<View>` layout, with one exception it does handle: a `<View>`
 * inside a `<Text>` is laid out inline, which is how inline math gets a raised
 * superscript. Anything else that wants a box has to become a block instead.
 *
 * Two deliberate refusals:
 *
 * - **Links are checked, not trusted.** Every href goes through {@link safeHref};
 *   one that fails renders as plain text rather than as a tappable link to
 *   somewhere the platform should not go.
 * - **Images are never fetched.** A remote image request tells its host that this
 *   message was read, from this IP, at this time. Nothing else in the app talks to
 *   a third party, and a decorative image is not worth being the exception, so an
 *   image renders as its alt text.
 */

import { Alert, Linking, Text } from 'react-native';
import type { ReactNode } from 'react';
import type { StyleProp, TextStyle } from 'react-native';

import type { InlineToken } from '@/components/markdown/blocks';
import { safeHref } from '@/components/markdown/href';
import { InlineMath } from '@/components/markdown/MathView';
import { useTheme } from '@/theme';
import type { Theme } from '@/theme';

interface Ctx {
  t: Theme;
  /** The colour inherited from the enclosing block, so nested runs can restore it. */
  color: string;
  size: number;
}

/**
 * Hands a checked URL to the platform.
 *
 * `canOpenURL` is not consulted: on Android it needs the scheme declared in the
 * manifest's `queries` block and answers `false` otherwise, which would refuse
 * links that work. Trying and reporting the failure is both simpler and honest.
 */
function openLink(url: string): void {
  Linking.openURL(url).catch(() => {
    Alert.alert('Could not open link', url);
  });
}

function assertNever(token: never): null {
  void token;
  return null;
}

function renderToken(token: InlineToken, ctx: Ctx, key: number): ReactNode {
  switch (token.kind) {
    case 'text':
      // A bare string needs no key and no wrapper; wrapping every text run in a
      // `<Text>` would multiply the node count of a long answer for nothing.
      return token.text;

    case 'break':
      return '\n';

    case 'code':
      // Inline code gets a background but no padding: padding on a nested `<Text>`
      // is ignored on Android, and faking it with spaces would change what the
      // user copies.
      return (
        <Text
          key={key}
          style={{
            fontFamily: ctx.t.monoFont,
            fontSize: ctx.size * 0.92,
            backgroundColor: ctx.t.colors.surfaceAlt,
            color: ctx.t.colors.text,
          }}
        >
          {token.text}
        </Text>
      );

    case 'strong':
      return (
        <Text key={key} style={{ fontWeight: '700' }}>
          {renderInline(token.tokens, ctx)}
        </Text>
      );

    case 'em':
      return (
        <Text key={key} style={{ fontStyle: 'italic' }}>
          {renderInline(token.tokens, ctx)}
        </Text>
      );

    case 'del':
      return (
        <Text key={key} style={{ textDecorationLine: 'line-through', color: ctx.t.colors.textDim }}>
          {renderInline(token.tokens, ctx)}
        </Text>
      );

    case 'link': {
      const url = safeHref(token.href);
      const children = renderInline(token.tokens, ctx);
      if (!url) {
        // The label still says something; only the target was unusable.
        return <Text key={key}>{children}</Text>;
      }
      return (
        <Text
          key={key}
          accessibilityRole="link"
          accessibilityHint={url}
          onPress={() => openLink(url)}
          style={{ color: ctx.t.colors.accent, textDecorationLine: 'underline' }}
        >
          {children}
        </Text>
      );
    }

    case 'image': {
      const url = safeHref(token.href);
      const label = token.alt.trim() || 'image';
      if (!url) {
        return (
          <Text key={key} style={{ color: ctx.t.colors.textDim, fontStyle: 'italic' }}>
            {label}
          </Text>
        );
      }
      // Openable, so the image is reachable on purpose rather than by default.
      return (
        <Text
          key={key}
          accessibilityRole="link"
          accessibilityHint={url}
          onPress={() => openLink(url)}
          style={{ color: ctx.t.colors.accent, fontStyle: 'italic' }}
        >
          {label}
        </Text>
      );
    }

    case 'math':
      return <InlineMath key={key} latex={token.latex} size={ctx.size} />;

    default:
      // Exhaustive on purpose: a new inline kind must be given a rendering rather
      // than vanishing from the middle of a sentence.
      return assertNever(token);
  }
}

/** The children of a `<Text>`, not a component: callers supply the `<Text>`. */
export function renderInline(tokens: readonly InlineToken[], ctx: Ctx): ReactNode[] {
  return tokens.map((token, index) => renderToken(token, ctx, index));
}

/**
 * A run of inline tokens as one wrapping line of text.
 */
export function InlineText({
  tokens,
  size,
  color,
  style,
  numberOfLines,
  selectable = true,
}: {
  tokens: readonly InlineToken[];
  size?: number;
  color?: string;
  style?: StyleProp<TextStyle>;
  numberOfLines?: number;
  selectable?: boolean;
}) {
  const t = useTheme();
  const fontSize = size ?? t.fontSize.md;
  const textColor = color ?? t.colors.text;
  return (
    <Text
      selectable={selectable}
      numberOfLines={numberOfLines}
      style={[{ color: textColor, fontSize, lineHeight: Math.round(fontSize * 1.45) }, style]}
    >
      {renderInline(tokens, { t, color: textColor, size: fontSize })}
    </Text>
  );
}
