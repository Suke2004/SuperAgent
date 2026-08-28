/**
 * Rendered mathematics, from the AST {@link parseLatex} produces.
 *
 * No KaTeX and no WebView. A WebView per equation costs a process and a round of
 * layout each, a transcript can hold dozens, and the whole point of the parser is
 * that what it cannot render it shows as source rather than as nothing.
 *
 * Everything here is `View` and `Text`. React Native has no baseline-relative
 * positioning and no way to measure a glyph before laying it out, so the vertical
 * geometry is explicit: the ratios below come from TeX's own parameters
 * (`\scriptspace`, sup/sub shifts, script size 0.7) rather than from measurement.
 * They are gathered in one block because they are the part most likely to need a
 * nudge once this has been seen on a real screen — which it has not been.
 *
 * Inline math renders as a `View` inside the paragraph's `Text`. That is the only
 * way to get a raised superscript inside running prose, and it is the one thing
 * here that needs checking on a device.
 */

import { useMemo } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import type { ReactNode } from 'react';
import type { TextStyle } from 'react-native';

import { parseLatex } from '@/components/markdown/latex';
import type { AccentKind, MathNode } from '@/components/markdown/latex';
import { useTheme } from '@/theme';
import type { Theme } from '@/theme';

/* -------------------------------------------------------------------------- */
/* Geometry — em fractions of the current size                                 */
/* -------------------------------------------------------------------------- */

/** TeX uses 0.7; a hair larger survives a 13pt phone screen better. */
const SCRIPT_SCALE = 0.72;
/** A superscript on its own, raised. */
const SUP_SHIFT = -0.4;
/** A subscript on its own, lowered. */
const SUB_SHIFT = 0.2;
/** Both together: they stack naturally, so only the pair needs lifting. */
const PAIR_SHIFT = -0.3;
/** Space either side of a binary operator, then of a relation. */
const GAP_BIN = 0.22;
const GAP_REL = 0.3;
/** Space after a comma or semicolon, and none before. */
const GAP_PUNCT = 0.17;
/** Fraction bar thickness in dp, and the air above and below it. */
const RULE = 1.2;
const FRAC_GAP = 0.16;
/** How much a delimiter grows beside a two-line body. */
const DELIM_SCALE = 1.8;
/** A large operator's glyph, and the same operator's word form. */
const BIGOP_SCALE = 1.45;

const ACCENT_CHAR: Readonly<Record<AccentKind, string>> = {
  hat: 'ˆ',
  bar: '¯',
  vec: '→',
  tilde: '˜',
  dot: '˙',
  ddot: '¨',
  check: 'ˇ',
  acute: '´',
  grave: '`',
  breve: '˘',
  ring: '˚',
};

/* -------------------------------------------------------------------------- */
/* Height heuristic                                                            */
/* -------------------------------------------------------------------------- */

/**
 * Whether a node occupies more than one line of text.
 *
 * Rows of ordinary symbols align on their baselines, which is what makes `x + 1`
 * sit correctly. A fraction has no useful baseline of its own, so a row that
 * contains one centres instead. Deciding this from the tree costs a walk of a few
 * nodes and avoids needing to measure anything.
 */
function isTall(node: MathNode): boolean {
  switch (node.kind) {
    case 'frac':
    case 'binom':
    case 'root':
      return true;
    case 'accent':
      return true;
    case 'group':
      return node.nodes.some(isTall);
    case 'style':
      return isTall(node.body);
    case 'delimited':
      return isTall(node.body);
    case 'scripted':
      return isTall(node.base) || node.base.kind === 'bigop';
    default:
      return false;
  }
}

/* -------------------------------------------------------------------------- */
/* Rendering                                                                   */
/* -------------------------------------------------------------------------- */

interface Ctx {
  t: Theme;
  color: string;
  /** Block math sets limits above and below a large operator; inline math does not. */
  display: boolean;
  bold?: boolean;
  italic?: boolean;
}

function leafStyle(ctx: Ctx, size: number, italic: boolean): TextStyle {
  const style: TextStyle = {
    color: ctx.color,
    fontSize: size,
    lineHeight: size * 1.2,
  };
  if (italic || ctx.italic) style.fontStyle = 'italic';
  if (ctx.bold) style.fontWeight = '700';
  return style;
}

function assertNever(node: never): null {
  void node;
  return null;
}

function render(node: MathNode, size: number, ctx: Ctx, key?: number): ReactNode {
  switch (node.kind) {
    case 'ident':
      return (
        <Text key={key} style={leafStyle(ctx, size, true)}>
          {node.text}
        </Text>
      );

    case 'number':
      return (
        <Text key={key} style={leafStyle(ctx, size, false)}>
          {node.text}
        </Text>
      );

    case 'text': {
      const style = leafStyle(ctx, size, Boolean(node.italic));
      if (node.bold) style.fontWeight = '700';
      if (node.mono) style.fontFamily = ctx.t.monoFont;
      return (
        <Text key={key} style={style}>
          {node.text}
        </Text>
      );
    }

    case 'op': {
      const gap = size * (node.rel ? GAP_REL : GAP_BIN);
      return (
        <Text key={key} style={[leafStyle(ctx, size, false), { marginLeft: gap, marginRight: gap }]}>
          {node.text}
        </Text>
      );
    }

    case 'punct':
      return (
        <Text key={key} style={[leafStyle(ctx, size, false), { marginRight: size * GAP_PUNCT }]}>
          {node.text}
        </Text>
      );

    case 'bigop':
      return (
        <Text key={key} style={leafStyle(ctx, node.word ? size : size * BIGOP_SCALE, false)}>
          {node.text}
        </Text>
      );

    case 'space':
      // A negative thin space really does pull the next atom back; `\!` exists to
      // close the gap `\int f` leaves.
      return <View key={key} style={{ width: size * node.em }} />;

    case 'group':
      return (
        <View
          key={key}
          style={{ flexDirection: 'row', alignItems: node.nodes.some(isTall) ? 'center' : 'baseline' }}
        >
          {node.nodes.map((child, index) => render(child, size, ctx, index))}
        </View>
      );

    case 'style': {
      const inner: Ctx = { ...ctx };
      if (node.bold) inner.bold = true;
      if (node.italic) inner.italic = true;
      return <View key={key}>{render(node.body, size, inner)}</View>;
    }

    case 'scripted':
      return renderScripted(node, size, ctx, key);

    case 'frac':
      return renderFrac(node.num, node.den, size, ctx, key, true);

    case 'binom':
      return renderFrac(node.top, node.bottom, size, ctx, key, false);

    case 'root':
      return renderRoot(node, size, ctx, key);

    case 'accent':
      return renderAccent(node, size, ctx, key);

    case 'delimited':
      return renderDelimited(node, size, ctx, key);

    case 'raw':
      // The whole point of the fallback: it must be legible as source, and it must
      // not look like a rendering that went wrong.
      return (
        <Text
          key={key}
          selectable
          style={{
            color: ctx.t.colors.warning,
            fontFamily: ctx.t.monoFont,
            fontSize: size * 0.92,
            lineHeight: size * 1.2,
          }}
        >
          {node.latex}
        </Text>
      );

    default:
      // Exhaustive on purpose: a new node kind must be given a rendering rather
      // than silently disappearing from an equation.
      return assertNever(node);
  }
}

function renderScripted(
  node: Extract<MathNode, { kind: 'scripted' }>,
  size: number,
  ctx: Ctx,
  key?: number,
): ReactNode {
  const scriptSize = size * SCRIPT_SCALE;
  const sup = node.sup ? render(node.sup, scriptSize, ctx) : null;
  const sub = node.sub ? render(node.sub, scriptSize, ctx) : null;

  // `\sum_{i=1}^{n}` puts its limits above and below in display style and beside
  // in text style. That is TeX's rule and it is the right one: stacked limits in
  // running prose would push the lines apart.
  if (node.base.kind === 'bigop' && ctx.display) {
    return (
      <View key={key} style={{ alignItems: 'center', paddingHorizontal: size * 0.1 }}>
        {sup}
        {render(node.base, size, ctx)}
        {sub}
      </View>
    );
  }

  const base = render(node.base, size, ctx);
  const tall = isTall(node.base);

  if (sup && sub) {
    return (
      <View key={key} style={{ flexDirection: 'row', alignItems: tall ? 'center' : 'baseline' }}>
        {base}
        <View style={{ transform: [{ translateY: size * PAIR_SHIFT }] }}>
          {sup}
          {sub}
        </View>
      </View>
    );
  }

  const shift = sup ? SUP_SHIFT : SUB_SHIFT;
  return (
    <View key={key} style={{ flexDirection: 'row', alignItems: tall ? 'center' : 'baseline' }}>
      {base}
      <View style={{ transform: [{ translateY: size * shift }] }}>{sup ?? sub}</View>
    </View>
  );
}

function renderFrac(
  top: MathNode,
  bottom: MathNode,
  size: number,
  ctx: Ctx,
  key: number | undefined,
  ruled: boolean,
): ReactNode {
  // A nested fraction shrinks, as TeX's `\scriptstyle` does, or a continued
  // fraction walks off the side of the screen.
  const inner = size * 0.94;
  return (
    <View key={key} style={{ alignItems: 'center', paddingHorizontal: size * 0.12 }}>
      <View style={{ paddingBottom: size * FRAC_GAP }}>{render(top, inner, ctx)}</View>
      {ruled ? (
        <View style={{ alignSelf: 'stretch', height: RULE, backgroundColor: ctx.color }} />
      ) : null}
      <View style={{ paddingTop: size * FRAC_GAP }}>{render(bottom, inner, ctx)}</View>
    </View>
  );
}

function renderRoot(
  node: Extract<MathNode, { kind: 'root' }>,
  size: number,
  ctx: Ctx,
  key?: number,
): ReactNode {
  const tall = isTall(node.radicand);
  return (
    <View key={key} style={{ flexDirection: 'row', alignItems: 'flex-start' }}>
      {node.index ? (
        <View style={{ transform: [{ translateY: size * 0.12 }] }}>
          {render(node.index, size * 0.6, ctx)}
        </View>
      ) : null}
      <Text style={leafStyle(ctx, size * (tall ? DELIM_SCALE : 1.1), false)}>√</Text>
      <View
        style={{
          borderTopWidth: RULE,
          borderTopColor: ctx.color,
          paddingTop: size * 0.1,
          paddingLeft: size * 0.08,
          marginTop: size * 0.14,
        }}
      >
        {render(node.radicand, size, ctx)}
      </View>
    </View>
  );
}

function renderAccent(
  node: Extract<MathNode, { kind: 'accent' }>,
  size: number,
  ctx: Ctx,
  key?: number,
): ReactNode {
  // A wide bar is a rule, not a glyph: `\overline{x + y}` has to span the whole
  // expression, and a stretched `¯` would only ever cover one character.
  if (node.wide && node.accent === 'bar') {
    return (
      <View
        key={key}
        style={{ borderTopWidth: RULE, borderTopColor: ctx.color, paddingTop: size * 0.08 }}
      >
        {render(node.base, size, ctx)}
      </View>
    );
  }

  return (
    <View key={key} style={{ alignItems: 'center' }}>
      <Text
        style={{
          color: ctx.color,
          fontSize: size * (node.accent === 'vec' ? 0.62 : 0.95),
          // A combining-height glyph on its own line would push the row apart, so
          // its line box is deliberately shorter than the glyph.
          lineHeight: size * 0.5,
        }}
      >
        {ACCENT_CHAR[node.accent]}
      </Text>
      {render(node.base, size, ctx)}
    </View>
  );
}

function renderDelimited(
  node: Extract<MathNode, { kind: 'delimited' }>,
  size: number,
  ctx: Ctx,
  key?: number,
): ReactNode {
  const tall = isTall(node.body);
  const delimSize = size * (tall ? DELIM_SCALE : 1);
  const style = leafStyle(ctx, delimSize, false);
  return (
    <View key={key} style={{ flexDirection: 'row', alignItems: 'center' }}>
      {node.open ? <Text style={style}>{node.open}</Text> : null}
      {render(node.body, size, ctx)}
      {node.close ? <Text style={style}>{node.close}</Text> : null}
    </View>
  );
}

/* -------------------------------------------------------------------------- */
/* Entry points                                                                */
/* -------------------------------------------------------------------------- */

/**
 * Inline math, sized to the surrounding prose.
 *
 * Returns a `View`, which the paragraph embeds in its `Text`.
 */
export function InlineMath({ latex, size }: { latex: string; size?: number }) {
  const t = useTheme();
  const expr = useMemo(() => parseLatex(latex), [latex]);
  const em = size ?? t.fontSize.md;
  const ctx: Ctx = { t, color: t.colors.text, display: false };
  return <View style={{ flexDirection: 'row', alignItems: 'baseline' }}>{render(expr.body, em, ctx)}</View>;
}

/**
 * Display math: its own centred, horizontally scrollable line.
 *
 * The scroller is not optional. A derivation that is two characters too wide
 * would otherwise be clipped with nothing to indicate it, and unlike prose an
 * equation cannot be rewrapped.
 */
export function BlockMath({ latex }: { latex: string }) {
  const t = useTheme();
  const expr = useMemo(() => parseLatex(latex), [latex]);
  const ctx: Ctx = { t, color: t.colors.text, display: true };

  // A wholly unrenderable expression is shown as source in a box, the same shape
  // as a code block, rather than as a broken attempt at layout.
  if (expr.body.kind === 'raw') {
    return (
      <View
        style={{
          backgroundColor: t.colors.surfaceAlt,
          borderWidth: StyleSheet.hairlineWidth,
          borderColor: t.colors.border,
          borderRadius: t.radius.md,
          padding: t.spacing.md,
        }}
      >
        <Text
          style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, fontWeight: '700', marginBottom: t.spacing.xs }}
        >
          latex
        </Text>
        <Text
          selectable
          style={{ color: t.colors.text, fontFamily: t.monoFont, fontSize: t.fontSize.code, lineHeight: 19 }}
        >
          {expr.body.latex}
        </Text>
      </View>
    );
  }

  return (
    <ScrollView
      horizontal
      showsHorizontalScrollIndicator={false}
      directionalLockEnabled
      contentContainerStyle={{
        flexGrow: 1,
        justifyContent: 'center',
        paddingHorizontal: t.spacing.sm,
        paddingVertical: t.spacing.xs,
      }}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center' }}>
        {render(expr.body, t.fontSize.lg, ctx)}
      </View>
    </ScrollView>
  );
}
