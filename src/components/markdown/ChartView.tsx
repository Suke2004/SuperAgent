/**
 * A ```chart fence, drawn.
 *
 * Views and `Text` only — the arithmetic is {@link layoutChart}, and the reasons there
 * is no chart library, no SVG and no WebView are in `@/components/markdown/chart`.
 *
 * The one thing this adds to the geometry is the width, which arrives from `onLayout`
 * and is zero on the first frame: a chart cannot be placed until the column it sits in
 * has been measured. Nothing is drawn until it has, which costs a frame and means the
 * bars are never laid out against a guess and then seen to jump.
 *
 * Colour carries the series here, which it does nowhere else in this app, so the ramp
 * varies lightness as well as hue and a legend names every series that has a name. See
 * `SERIES` in `@/theme`.
 *
 * A spec this cannot draw, and a chart a reader would rather read as numbers, both end
 * up in {@link CodeBlock}: the JSON is one tap away and never lost.
 */

import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { CodeBlock } from '@/components/markdown/CodeBlock';
import { CHART_METRICS, describeChart, layoutChart, parseChart } from '@/components/markdown/chart';
import type { ChartLayout, Segment } from '@/components/markdown/chart';
import { useTheme } from '@/theme';

/** A scatter dot's diameter and a line's weight — drawing, not geometry. */
const DOT = 7;
const STROKE = 2;
/** Line box for a tick label, so it can be centred on a coordinate exactly. */
const TICK_LINE = 14;
/** The narrowest an x label may be before it starts clipping neighbours instead. */
const TICK_MIN = 40;

function Stroke({ segment, color }: { segment: Segment; color: string }) {
  const dx = segment.x2 - segment.x1;
  const dy = segment.y2 - segment.y1;
  const length = Math.hypot(dx, dy);
  if (!(length > 0)) return null;

  return (
    <View
      style={{
        position: 'absolute',
        // Placed by its midpoint, because React Native rotates a view about its centre
        // and that makes the placement independent of the angle. Same trick, and same
        // reason, as the edges in `MermaidView`.
        left: (segment.x1 + segment.x2) / 2 - length / 2,
        top: (segment.y1 + segment.y2) / 2 - STROKE / 2,
        width: length,
        height: STROKE,
        borderRadius: STROKE / 2,
        backgroundColor: color,
        transform: [{ rotate: `${Math.atan2(dy, dx)}rad` }],
      }}
    />
  );
}

/**
 * The axes: a rule and a number per y tick, the baseline, and the x labels.
 *
 * Rules rather than a boxed frame, because a bar sitting on a rule is readable against
 * a value without a border around the whole plot competing with the bars themselves.
 */
function Grid({ laid }: { laid: ChartLayout }) {
  const t = useTheme();
  const label = { color: t.colors.textFaint, fontSize: t.fontSize.xs, lineHeight: TICK_LINE } as const;

  return (
    <>
      {laid.yTicks.map((tick, index) => (
        <View key={`y${index}`}>
          <View
            style={{
              position: 'absolute',
              left: laid.plot.x,
              top: tick.at,
              width: laid.plot.w,
              height: StyleSheet.hairlineWidth,
              backgroundColor: t.colors.border,
            }}
          />
          <Text
            numberOfLines={1}
            style={{
              ...label,
              position: 'absolute',
              left: 0,
              top: tick.at - TICK_LINE / 2,
              width: Math.max(0, laid.plot.x - 4),
              textAlign: 'right',
            }}
          >
            {tick.text}
          </Text>
        </View>
      ))}

      {/* The zero line, drawn over the grid: bars grow from it, and on a chart that
          crosses zero it is the one rule that has to be findable. */}
      <View
        style={{
          position: 'absolute',
          left: laid.plot.x,
          top: laid.zero,
          width: laid.plot.w,
          height: 1,
          backgroundColor: t.colors.borderStrong,
        }}
      />

      {laid.xTicks.map((tick, index) => (
        <Text
          key={`x${index}`}
          numberOfLines={1}
          style={{
            ...label,
            position: 'absolute',
            // Clamped, so a label under the leftmost slot stays inside the card rather
            // than reaching back over the y numbers.
            left: Math.max(0, tick.at - Math.max(laid.slot, TICK_MIN) / 2),
            top: laid.plot.h + 2,
            width: Math.max(laid.slot, TICK_MIN),
            textAlign: 'center',
          }}
        >
          {tick.text}
        </Text>
      ))}
    </>
  );
}

/**
 * Swatch and name per series.
 *
 * Only drawn when the spec named its series — a legend reading "series 1" against one
 * colour is furniture. It wraps, because six names do not fit across a phone.
 */
function Legend({ names }: { names: string[] }) {
  const t = useTheme();
  return (
    <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: t.spacing.sm }}>
      {names.map((name, index) => (
        <View key={`${index}:${name}`} style={{ flexDirection: 'row', alignItems: 'center', gap: t.spacing.xs }}>
          <View
            style={{
              width: 10,
              height: 10,
              borderRadius: 2,
              backgroundColor: t.series[index % t.series.length],
            }}
          />
          <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.xs }}>{name || `Series ${index + 1}`}</Text>
        </View>
      ))}
    </View>
  );
}

export function ChartView({ code }: { code: string }) {
  const t = useTheme();
  const chart = useMemo(() => parseChart(code), [code]);
  const [asSource, setAsSource] = useState(false);
  const [width, setWidth] = useState(0);
  const drawable = chart.kind === 'unsupported' ? null : chart;
  const laid = useMemo(
    () => (drawable && width > 0 ? layoutChart(drawable, width) : null),
    [drawable, width],
  );

  // Everything this cannot draw is still readable, and says why in one line rather than
  // failing silently. A fence that is still streaming lands here too, since half a JSON
  // object does not parse.
  if (!drawable) {
    return (
      <View style={{ gap: t.spacing.xs }}>
        <CodeBlock code={code} lang="json" />
        {chart.kind === 'unsupported' ? (
          <Text style={{ color: t.colors.textFaint, fontSize: t.fontSize.xs, paddingHorizontal: t.spacing.xs }}>
            {`Shown as source: ${chart.why}.`}
          </Text>
        ) : null}
      </View>
    );
  }

  if (asSource) {
    return (
      <View style={{ gap: t.spacing.xs }}>
        <CodeBlock code={code} lang="json" />
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the chart"
          onPress={() => setAsSource(false)}
          hitSlop={8}
          style={{ alignSelf: 'flex-start', paddingHorizontal: t.spacing.xs }}
        >
          <Text style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>Show chart</Text>
        </Pressable>
      </View>
    );
  }

  // A legend earns its space when there is something to tell apart: two series, or one
  // the spec bothered to name. One unnamed series against one colour is furniture.
  const named = drawable.series.length > 1 || drawable.series.some((series) => series.name);

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
          gap: t.spacing.sm,
          paddingLeft: t.spacing.md,
          paddingRight: t.spacing.xs,
          paddingVertical: t.spacing.xs,
          borderBottomWidth: StyleSheet.hairlineWidth,
          borderBottomColor: t.colors.border,
        }}
      >
        {/* The spec's title, or the kind when it gave none — this is where a code block
            puts its language, and a header reading "chart" says nothing at all. */}
        <Text
          numberOfLines={1}
          style={{ flexShrink: 1, color: t.colors.textFaint, fontSize: t.fontSize.xs, fontWeight: '700' }}
        >
          {drawable.title || drawable.kind}
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Show the chart data"
          onPress={() => setAsSource(true)}
          hitSlop={8}
          style={({ pressed }) => ({
            paddingHorizontal: t.spacing.sm,
            paddingVertical: t.spacing.xs,
            borderRadius: t.radius.sm,
            backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
          })}
        >
          <Text style={{ color: t.colors.accent, fontSize: t.fontSize.xs, fontWeight: '700' }}>Data</Text>
        </Pressable>
      </View>

      <View style={{ padding: t.spacing.md, gap: t.spacing.sm }}>
        {/* The measured child. Its width is the plot's width, so the padding above is
            what keeps the drawing off the card's edges. */}
        <View onLayout={(event) => setWidth(event.nativeEvent.layout.width)}>
          {laid ? (
            <View
              accessible
              accessibilityRole="image"
              accessibilityLabel={describeChart(drawable)}
              style={{ width: laid.width, height: laid.height }}
            >
              <Grid laid={laid} />
              {laid.bars.map((bar, index) => (
                <View
                  key={`b${index}`}
                  style={{
                    position: 'absolute',
                    left: bar.x,
                    top: bar.y,
                    width: bar.w,
                    height: bar.h,
                    borderRadius: 2,
                    backgroundColor: t.series[bar.series % t.series.length],
                  }}
                />
              ))}
              {laid.segments.map((segment, index) => (
                <Stroke
                  key={`s${index}`}
                  segment={segment}
                  color={t.series[segment.series % t.series.length] ?? t.colors.accent}
                />
              ))}
              {laid.dots.map((dot, index) => (
                <View
                  key={`d${index}`}
                  style={{
                    position: 'absolute',
                    left: dot.x - DOT / 2,
                    top: dot.y - DOT / 2,
                    width: DOT,
                    height: DOT,
                    borderRadius: DOT / 2,
                    backgroundColor: t.series[dot.series % t.series.length],
                  }}
                />
              ))}
            </View>
          ) : (
            // One frame, before `onLayout` reports the width. Reserving the height keeps
            // the transcript from jumping when the drawing lands.
            <View style={{ height: CHART_METRICS.plotHeight + CHART_METRICS.footer }} />
          )}
        </View>
        {named ? <Legend names={laid?.legend ?? []} /> : null}
      </View>
    </View>
  );
}
