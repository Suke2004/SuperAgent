/**
 * A ```mermaid fence, drawn.
 *
 * Views and `Text` only — the geometry comes from {@link layoutFlow}, and the reasons
 * there is no mermaid.js and no WebView are in `@/components/markdown/mermaid`.
 *
 * Two things here are not obvious. Lines are rotated rectangles placed by their
 * midpoint, because React Native rotates about a view's centre and that makes the
 * placement independent of the rotation. Arrowheads are the CSS border triangle, whose
 * apex sits half its height ahead of the centre it rotates about, so the centre is set
 * back along the line by exactly that much to put the point on the box edge.
 *
 * A diagram this app cannot draw, and a diagram the reader would rather read, both end
 * up in {@link CodeBlock}: the source is always one tap away, and it is never lost.
 */

import { useMemo, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { METRICS, describeFlow, layoutFlow, parseMermaid } from '@/components/markdown/mermaid';
import type { FlowShape, LaidBox, LaidLine } from '@/components/markdown/mermaid';
import { useTheme } from '@/theme';
import type { Theme } from '@/theme';

/** Half the width of an arrowhead; its length is 1.6 of these. */
const HEAD = 5;
/** Mean advance width at `fontSize.xs`, for centring an edge label without measuring. */
const LABEL_CHAR = 6.6;

function radiusOf(shape: FlowShape, box: LaidBox, t: Theme): number {
  switch (shape) {
    case 'circle':
      return box.w / 2;
    case 'stadium':
      return t.radius.pill;
    case 'round':
    case 'hex':
      return t.radius.md;
    default:
      return t.radius.sm;
  }
}

function Line({ line, color }: { line: LaidLine; color: string }) {
  const t = useTheme();
  const dx = line.x2 - line.x1;
  const dy = line.y2 - line.y1;
  const length = Math.hypot(dx, dy);
  if (length < 1) return null;
  const angle = Math.atan2(dy, dx);
  const weight = line.kind === 'thick' ? 3 : 1.5;
  const midX = (line.x1 + line.x2) / 2;
  const midY = (line.y1 + line.y2) / 2;

  return (
    <>
      <View
        style={{
          position: 'absolute',
          left: midX - length / 2,
          top: midY - weight / 2,
          width: length,
          height: line.kind === 'dashed' ? 0 : weight,
          ...(line.kind === 'dashed'
            ? { borderTopWidth: weight, borderColor: color, borderStyle: 'dashed' as const }
            : { backgroundColor: color }),
          transform: [{ rotate: `${angle}rad` }],
        }}
      />
      {line.arrow === 'arrow' ? (
        <View
          style={{
            position: 'absolute',
            // The apex is 0.8 × the triangle's height ahead of the centre it turns
            // about, so the centre goes that far back along the line.
            left: line.x2 - Math.cos(angle) * HEAD * 0.8 - HEAD,
            top: line.y2 - Math.sin(angle) * HEAD * 0.8 - HEAD * 0.8,
            width: 0,
            height: 0,
            borderLeftWidth: HEAD,
            borderRightWidth: HEAD,
            borderBottomWidth: HEAD * 1.6,
            borderLeftColor: 'transparent',
            borderRightColor: 'transparent',
            borderBottomColor: color,
            // The border triangle points up; `+ π/2` turns "up" into "along the line".
            transform: [{ rotate: `${angle + Math.PI / 2}rad` }],
          }}
        />
      ) : null}
      {line.arrow === 'dot' || line.arrow === 'cross' ? (
        <View
          style={{
            position: 'absolute',
            left: line.x2 - HEAD,
            top: line.y2 - HEAD,
            width: HEAD * 2,
            height: HEAD * 2,
            borderRadius: line.arrow === 'dot' ? HEAD : 0,
            borderWidth: 1.5,
            borderColor: color,
            ...(line.arrow === 'dot' ? { backgroundColor: color } : {}),
            ...(line.arrow === 'cross' ? { transform: [{ rotate: '45deg' }] } : {}),
          }}
        />
      ) : null}
      {line.label ? (
        <Text
          numberOfLines={1}
          style={{
            position: 'absolute',
            left: midX - (line.label.length * LABEL_CHAR) / 2 - t.spacing.xs,
            top: midY - t.fontSize.xs,
            paddingHorizontal: t.spacing.xs,
            backgroundColor: t.colors.surfaceAlt,
            color: t.colors.textDim,
            fontSize: t.fontSize.xs,
          }}
        >
          {line.label}
        </Text>
      ) : null}
    </>
  );
}

function Box({ box }: { box: LaidBox }) {
  const t = useTheme();
  const border = { borderWidth: StyleSheet.hairlineWidth * 2, borderColor: t.colors.borderStrong };
  const fill = box.shape === 'diamond' ? t.colors.accentSoft : t.colors.surface;

  return (
    <View
      style={{
        position: 'absolute',
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      {box.shape === 'diamond' ? (
        // A square whose diagonal is the box: side = box / √2. The label is a separate
        // layer, so it stays upright inside the rotated shape.
        <View
          style={{
            position: 'absolute',
            width: box.w / Math.SQRT2,
            height: box.h / Math.SQRT2,
            backgroundColor: fill,
            borderRadius: t.radius.sm / 2,
            transform: [{ rotate: '45deg' }],
            ...border,
          }}
        />
      ) : (
        <View
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            right: 0,
            bottom: 0,
            backgroundColor: fill,
            borderRadius: radiusOf(box.shape, box, t),
            ...border,
          }}
        />
      )}
      {box.lines.map((line, index) => (
        <Text
          key={index}
          style={{ color: t.colors.text, fontSize: t.fontSize.sm, lineHeight: METRICS.lineHeight }}
        >
          {line}
        </Text>
      ))}
    </View>
  );
}

export function MermaidView({ code }: { code: string }) {
  const t = useTheme();
  const diagram = useMemo(() => parseMermaid(code), [code]);
  const [asSource, setAsSource] = useState(false);
  const laid = useMemo(() => (diagram.kind === 'flow' ? layoutFlow(diagram) : null), [diagram]);

  // Everything this cannot draw is still readable, and says why in one line rather
  // than failing silently. A fence that is still streaming lands here too.
  if (!laid || diagram.kind !== 'flow') {
    return (
      <View style={{ gap: t.spacing.xs }}>
        <CodeBlock code={code} lang="mermaid" />
        {!asSource && diagram.kind === 'unsupported' ? (
          <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, paddingHorizontal: t.spacing.xs }}>
            {`Shown as source: this app draws flowcharts, not ${diagram.what}.`}
          </Text>
        ) : null}
      </View>
    );
  }

  if (asSource) {
    return (
      <View style={{ gap: t.spacing.xs }}>
        <CodeBlock code={code} lang="mermaid" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the diagram"
          onPress={() => setAsSource(false)}
          hitSlop={8}
          style={{ alignSelf: 'flex-start', paddingHorizontal: t.spacing.xs }}
        >
          <Text style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>Show diagram</Text>
        </Pressable>
      </View>
    );
  }

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
        <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, fontWeight: '700' }}>mermaid</Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the diagram source"
          onPress={() => setAsSource(true)}
          hitSlop={8}
          style={({ pressed }) => ({
            paddingHorizontal: t.spacing.sm,
            paddingVertical: t.spacing.xs,
            borderRadius: t.radius.sm,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
          })}
        >
          <Text style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>Source</Text>
        </Pressable>
      </View>

      {/* A diagram cannot be rewrapped, so it scrolls sideways like a code block does. */}
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        directionalLockEnabled
        contentContainerStyle={{ padding: t.spacing.md }}
      >
        <View
          accessible
          accessibilityRole="image"
          accessibilityLabel={describeFlow(diagram)}
          style={{ width: laid.width, height: laid.height }}
        >
          {/* Lines first: a box drawn over the end of a line hides the seam. */}
          {laid.lines.map((line, index) => (
            <Line key={index} line={line} color={t.colors.borderStrong} />
          ))}
          {laid.boxes.map((box) => (
            <Box key={box.id} box={box} />
          ))}
        </View>
      </ScrollView>
    </View>
  );
}
