/**
 * Charts → geometry.
 *
 * A model asked for a chart writes ```chart, and before this the transcript showed
 * the JSON. This module is the pure half: spec in, laid-out bars, segments and ticks
 * out, no React and no measurement, so the arithmetic can be tested in node.
 *
 * **No chart library, no WebView, no SVG.** The reasons are the ones
 * `@/components/markdown/MathView` and `@/components/markdown/mermaid` give — a
 * WebView per block costs a process, and the sandboxing that makes a WebView safe for
 * model output also makes it unable to fetch the library it would need. What is left
 * is `View` and `Text`, which is enough: a bar is a rectangle, a scatter dot is a
 * rounded one, and a line segment is a rotated rectangle. `react-native-svg` would
 * draw smoother lines at the cost of a native module and a new dev build, and it is
 * the one dependency this file exists to avoid.
 *
 * ## What it accepts
 *
 * Three shapes, because a model writing "a chart" writes whichever it happens to
 * think of, and refusing two of them means showing JSON to a reader who asked for a
 * picture: this app's own `{type, labels, series}`, Chart.js's
 * `{type, data: {labels, datasets}}`, and a bare `{type, labels, data}` for one
 * series. Everything is normalised to {@link Series} of `{x, y}` points before it
 * reaches the layout, so the layout has one shape to reason about.
 *
 * Anything unparseable, or any spec asking for more than a phone screen can hold,
 * comes back as `unsupported` with the reason — the same bargain the LaTeX and
 * mermaid parsers strike. A chart drawn from data it silently truncated would be a
 * lie; the source is merely inconvenient.
 *
 * ponytail: bar, line and scatter. Pie, area and candlestick fall back to source.
 * Add one when a transcript actually contains it.
 */

/** The three chart types that are drawn. Anything else falls back to source. */
export type ChartKind = 'bar' | 'line' | 'scatter';

export interface Point {
  /** Category index for bar and line; a real number for scatter. */
  x: number;
  y: number;
}

export interface Series {
  /** Empty when the spec did not name it, which is normal for a single series. */
  name: string;
  points: Point[];
}

export type Chart =
  | { kind: ChartKind; title: string; labels: string[]; series: Series[] }
  /** `why` is a sentence for the fallback to show. It names the refusal, not the fix. */
  | { kind: 'unsupported'; why: string };

/**
 * The caps.
 *
 * Not arbitrary: they are the point past which the drawing stops being readable on a
 * phone, and a chart nobody can read is worse than the numbers it came from. Six
 * series is the limit of the colour ramp; 40 bars is about 4dp each at phone width;
 * 400 points is where a scatter becomes a smear.
 */
const MAX_SERIES = 6;
const MAX_BARS = 40;
const MAX_POINTS = 400;

/** Spellings of the three kinds that a model plausibly writes. */
const KINDS: Record<string, ChartKind> = {
  bar: 'bar',
  column: 'bar',
  bars: 'bar',
  histogram: 'bar',
  line: 'line',
  lines: 'line',
  spline: 'line',
  scatter: 'scatter',
  points: 'scatter',
  bubble: 'scatter',
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** A finite number, or `null`. `null` in a series is a gap, not a zero. */
function numberOf(value: unknown): number | null {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  // A model that formatted its own numbers writes "1,200" or "42%". The chart is
  // still about the number, so it is read out rather than refused.
  if (typeof value === 'string') {
    const cleaned = value.replace(/[\s,%$£€]/g, '');
    if (!cleaned || !/^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(cleaned)) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

/** One `{x, y}`, from any of the three ways a point is written. */
function pointOf(value: unknown, index: number): Point | null {
  if (Array.isArray(value)) {
    const x = numberOf(value[0]);
    const y = numberOf(value[1]);
    return x === null || y === null ? null : { x, y };
  }
  if (isRecord(value)) {
    const x = numberOf(value.x);
    const y = numberOf(value.y ?? value.value);
    return x === null || y === null ? null : { x, y };
  }
  const y = numberOf(value);
  return y === null ? null : { x: index, y };
}

/**
 * The numbers in one series.
 *
 * `categorical` is true for bar and line, where the nth number belongs under the nth
 * label whatever `x` the spec put on it — only scatter has an x axis of its own. A
 * `null` is dropped rather than read as zero, so a line spans its gap.
 *
 * ponytail: a dropped null joins its neighbours. Break the line if transcripts turn
 * out to contain sparse series.
 */
function pointsOf(value: unknown, categorical: boolean): Point[] {
  if (!Array.isArray(value)) return [];
  const out: Point[] = [];
  value.forEach((entry, at) => {
    const point = pointOf(entry, at);
    if (point) out.push(categorical ? { x: at, y: point.y } : point);
  });
  return out;
}

/** The series in a spec, in whichever of the three shapes it arrived. */
function seriesOf(body: Record<string, unknown>, categorical: boolean): Series[] {
  const list = body.datasets ?? body.series;
  if (Array.isArray(list)) {
    return list.map((entry) => {
      if (!isRecord(entry)) return { name: '', points: pointsOf(entry, categorical) };
      const named = entry.label ?? entry.name;
      return {
        name: typeof named === 'string' ? named.trim() : '',
        points: pointsOf(entry.data ?? entry.points ?? entry.values, categorical),
      };
    });
  }
  return [{ name: '', points: pointsOf(body.data ?? body.values, categorical) }];
}

/** A string for a label cell, or `''` for anything that is not one. */
function labelOf(value: unknown): string {
  if (typeof value === 'string') return value.trim();
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '';
}

/**
 * A ```chart fence, as data ready to be laid out or a reason it is not.
 *
 * Never throws and never half-succeeds: the caller's fallback is the JSON itself, so
 * "no" is a normal answer, and `why` is the sentence the fallback shows.
 */
export function parseChart(source: string): Chart {
  let raw: unknown;
  try {
    raw = JSON.parse(source);
  } catch {
    return { kind: 'unsupported', why: 'this chart is not valid JSON' };
  }
  if (!isRecord(raw)) return { kind: 'unsupported', why: 'this chart is not an object' };

  const asked = typeof raw.type === 'string' ? raw.type.trim().toLowerCase() : '';
  const kind = KINDS[asked];
  if (!kind) {
    return {
      kind: 'unsupported',
      why: asked ? `${asked} charts are not drawn` : 'this chart has no "type"',
    };
  }

  // Chart.js nests labels and datasets under `data`, where this app's shape and the
  // bare shape keep them at the top. Looking in both accepts all three for one line.
  const body = isRecord(raw.data) ? raw.data : raw;
  const series = seriesOf(body, kind !== 'scatter').filter((entry) => entry.points.length > 0);
  if (series.length === 0) return { kind: 'unsupported', why: 'this chart has no numbers in it' };
  if (series.length > MAX_SERIES) {
    return { kind: 'unsupported', why: `${series.length} series is more than a phone can tell apart` };
  }

  const total = series.reduce((sum, entry) => sum + entry.points.length, 0);
  if (total > MAX_POINTS) {
    return { kind: 'unsupported', why: `${total} points is too many to draw legibly` };
  }

  const spread = Math.max(...series.map((entry) => entry.points.length));
  if (kind === 'bar' && spread > MAX_BARS) {
    return { kind: 'unsupported', why: `${spread} bars is too many to label` };
  }

  const given = Array.isArray(body.labels) ? body.labels : [];
  const labels = Array.from({ length: spread }, (_, at) => labelOf(given[at]));
  const titled = raw.title ?? body.title;
  return { kind, title: typeof titled === 'string' ? titled.trim() : '', labels, series };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

/** A bar, in plot coordinates: y grows downward from the top of the plot. */
export interface Bar {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Index into the colour ramp, and into `legend`. */
  series: number;
}

/** A line segment. The view rotates a rectangle onto it, as `MermaidView` does. */
export interface Segment {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  series: number;
}

export interface Dot {
  x: number;
  y: number;
  series: number;
}

export interface Tick {
  text: string;
  /** y for a value tick, x for a category tick. */
  at: number;
}

export interface ChartLayout {
  width: number;
  height: number;
  plot: { x: number; y: number; w: number; h: number };
  /** Where the value 0 sits, clamped into the plot. The baseline bars grow from. */
  zero: number;
  /** One category slot, for centring an x label under what it names. */
  slot: number;
  bars: Bar[];
  segments: Segment[];
  dots: Dot[];
  /** Right-aligned against `plot.x`, centred on `at`. */
  yTicks: Tick[];
  /** Centred on `at`, under the plot, thinned to about `ChartMetrics.xTicks`. */
  xTicks: Tick[];
  /** Series names in series order. All empty when the spec named none. */
  legend: string[];
}

/**
 * Everything the geometry depends on that a browser would have measured.
 *
 * React Native cannot measure a string before laying it out, so the y gutter is sized
 * from a character count — over-estimated, because a gutter a few points too wide looks
 * fine where one too narrow clips its own numbers. These are the numbers to nudge once
 * this has been seen on a real screen.
 */
export interface ChartMetrics {
  /** Height of the plot rectangle. About a third of a phone screen. */
  plotHeight: number;
  /** Mean advance width at `fontSize.xs`, over-estimated. */
  charWidth: number;
  /** Height under the plot for one line of x labels. */
  footer: number;
  /** Between the y numbers and the plot's left edge. */
  gutterGap: number;
  /** Room on the right, so the last point is not cut off by the edge. */
  padRight: number;
  /** How many y ticks to aim for. The nice-number step decides the actual count. */
  yTicks: number;
  /** How many x labels to aim for; the rest are thinned out. */
  xTicks: number;
  /** The share of a category slot left empty between groups. */
  barGap: number;
}

export const CHART_METRICS: ChartMetrics = {
  plotHeight: 160,
  charWidth: 6.6,
  footer: 18,
  gutterGap: 6,
  padRight: 8,
  yTicks: 4,
  xTicks: 6,
  barGap: 0.3,
};

/** Suffixes, so a tick reads `1.2M` instead of spending a third of the width. */
const UNITS: readonly (readonly [number, string])[] = [
  [1e9, 'B'],
  [1e6, 'M'],
  [1e3, 'k'],
];

/**
 * A number as a tick label.
 *
 * Ticks are reached by repeated addition, so `0.1 × 3` arrives as
 * `0.30000000000000004` and has to have the float noise trimmed before it is shown.
 *
 * The `k`/`M`/`B` form is only used when it round-trips exactly. `1500000` is `1.5M`
 * and loses nothing, but `1001000` would become `1M` — and so would the tick above it,
 * leaving an axis with two identical labels at different heights. A long number is
 * worse-looking than a short one; two ticks that read the same is worse than either.
 */
export function tickText(value: number): string {
  const rounded = Number(value.toFixed(10));
  for (const [scale, suffix] of UNITS) {
    if (Math.abs(rounded) < scale) continue;
    const short = Number((rounded / scale).toFixed(2));
    if (short * scale === rounded) return `${short}${suffix}`;
    break;
  }
  return String(rounded);
}

/**
 * A step a person would have chosen: 1, 2, 2.5 or 5 times a power of ten.
 *
 * Dividing the span by the tick count gives ticks at 3.7 and 7.4, which nobody reads
 * a value off. Rounding the step up to the next familiar number instead means the
 * axis is labelled 0, 5, 10 — and the domain then grows to the next whole step, so
 * the top of the plot is a number rather than wherever the data happened to stop.
 */
function niceStep(span: number, count: number): number {
  const rough = span / Math.max(1, count);
  const magnitude = 10 ** Math.floor(Math.log10(rough));
  for (const multiple of [1, 2, 2.5, 5]) {
    if (rough <= magnitude * multiple) return magnitude * multiple;
  }
  return magnitude * 10;
}

/**
 * The domain to draw, as `[low, high, step]`, both ends on a step.
 *
 * A span of zero — every value the same, or a single point — has nothing to divide by,
 * and drawing the row along the top edge would imply it is the maximum of something.
 * The domain is opened out around the value instead, which puts the row in the middle
 * where a flat series belongs.
 */
function niceDomain(from: number, to: number, count: number): [number, number, number] {
  if (!(to > from)) {
    const pad = Math.abs(to) > 0 ? Math.abs(to) : 1;
    return niceDomain(to - pad, to + pad, count);
  }
  const step = niceStep(to - from, count);
  return [Math.floor(from / step) * step, Math.ceil(to / step) * step, step];
}

/** The tick values across a domain, inclusive of both ends. */
function ticksAcross(lo: number, hi: number, step: number): number[] {
  const out: number[] = [];
  // Half a step of slack: the last tick is reached by addition and lands a float
  // whisker past `hi`, which would otherwise drop the top label off the axis.
  for (let value = lo; value <= hi + step / 2; value += step) out.push(value);
  return out;
}

/**
 * A chart as rectangles, at a known width.
 *
 * Coordinates are dp inside the drawing, y downward, which is what an
 * absolutely-positioned `View` wants. The width comes from the view's `onLayout`
 * because it is the one thing the geometry cannot know; everything else is arithmetic
 * and therefore testable in node.
 *
 * ponytail: one plot rectangle, no stacking, no second y axis. Add either when a
 * transcript actually asks for it.
 */
export function layoutChart(
  chart: Extract<Chart, { kind: ChartKind }>,
  width: number,
  m: ChartMetrics = CHART_METRICS,
): ChartLayout {
  const values = chart.series.flatMap((series) => series.points.map((point) => point.y));
  // A bar is measured from zero, so the axis has to contain zero: three bars of 98, 99
  // and 100 on a 98–100 axis show the first as nothing at all, which is the oldest
  // misleading-graph trick there is. A line or a scatter is about the shape, so it
  // gets the data's own range.
  const anchored = chart.kind === 'bar';
  const [lo, hi, step] = niceDomain(
    anchored ? Math.min(0, ...values) : Math.min(...values),
    anchored ? Math.max(0, ...values) : Math.max(...values),
    m.yTicks,
  );

  const tickValues = ticksAcross(lo, hi, step);
  const texts = tickValues.map(tickText);
  const gutter = Math.max(0, ...texts.map((text) => text.length)) * m.charWidth + m.gutterGap;
  const plot = {
    x: gutter,
    y: 0,
    w: Math.max(m.charWidth * 8, width - gutter - m.padRight),
    h: m.plotHeight,
  };
  const yOf = (value: number) => plot.h * (1 - (value - lo) / (hi - lo));
  const yTicks: Tick[] = tickValues.map((value, at) => ({ text: texts[at] ?? '', at: yOf(value) }));
  const zero = yOf(Math.min(hi, Math.max(lo, 0)));
  const legend = chart.series.map((series) => series.name);

  const bars: Bar[] = [];
  const segments: Segment[] = [];
  const dots: Dot[] = [];

  // Scatter is the only kind with an x axis of its own, so it leaves here with
  // numeric x ticks rather than the category labels the other two share.
  if (chart.kind === 'scatter') {
    const xs = chart.series.flatMap((series) => series.points.map((point) => point.x));
    const [xlo, xhi, xstep] = niceDomain(Math.min(...xs), Math.max(...xs), m.xTicks);
    const xOf = (value: number) => plot.x + plot.w * ((value - xlo) / (xhi - xlo));
    chart.series.forEach((series, index) => {
      for (const point of series.points) {
        dots.push({ x: xOf(point.x), y: yOf(point.y), series: index });
      }
    });
    const across = ticksAcross(xlo, xhi, xstep);
    return {
      width,
      height: plot.h + m.footer,
      plot,
      zero,
      slot: plot.w / Math.max(1, across.length),
      bars,
      segments,
      dots,
      yTicks,
      xTicks: across.map((value) => ({ text: tickText(value), at: xOf(value) })),
      legend,
    };
  }

  // One slot per label, points and bar groups on the slot centres.
  const slot = plot.w / Math.max(1, chart.labels.length);
  const xOf = (index: number) => plot.x + slot * (index + 0.5);

  if (chart.kind === 'bar') {
    const group = slot * (1 - m.barGap);
    const each = group / chart.series.length;
    chart.series.forEach((series, index) => {
      for (const point of series.points) {
        const top = yOf(point.y);
        bars.push({
          x: plot.x + slot * point.x + (slot - group) / 2 + each * index,
          y: Math.min(top, zero),
          w: Math.max(1, each - 1),
          // A hairline for a zero, so that category still reads as present and empty
          // rather than as one the chart forgot to draw.
          h: Math.max(1, Math.abs(top - zero)),
          series: index,
        });
      }
    });
  } else {
    chart.series.forEach((series, index) => {
      // A series of one point draws no segments, and a series of one point is a real
      // spec. A dot is the only thing that keeps it on the chart at all.
      const only = series.points.length === 1 ? series.points[0] : undefined;
      if (only) dots.push({ x: xOf(only.x), y: yOf(only.y), series: index });
      series.points.forEach((point, at) => {
        const next = series.points[at + 1];
        if (!next) return;
        segments.push({
          x1: xOf(point.x),
          y1: yOf(point.y),
          x2: xOf(next.x),
          y2: yOf(next.y),
          series: index,
        });
      });
    });
  }

  // Thinned to about `m.xTicks`: 40 labels under a phone-width axis overlap into a
  // grey smear, and a label you cannot read is not a label.
  const every = Math.max(1, Math.ceil(chart.labels.length / m.xTicks));
  return {
    width,
    height: plot.h + m.footer,
    plot,
    zero,
    slot,
    bars,
    segments,
    dots,
    yTicks,
    xTicks: chart.labels.flatMap<Tick>((text, at) =>
      at % every === 0 && text ? [{ text, at: xOf(at) }] : [],
    ),
    legend,
  };
}

const KIND_NAMES: Readonly<Record<ChartKind, string>> = {
  bar: 'Bar chart',
  line: 'Line chart',
  scatter: 'Scatter plot',
};

/**
 * The chart as a sentence, for the screen reader.
 *
 * Bars and dots are `View`s, so without this a chart is announced as nothing at all —
 * and the chart is often the answer rather than decoration around it. Bar and line
 * enumerate every value, because there is no other way to reach them and the cap is
 * already low enough for that to be a list rather than a monologue. A scatter of 400
 * points is not a list anybody can follow, so it is summarised by its extents.
 */
export function describeChart(chart: Extract<Chart, { kind: ChartKind }>): string {
  const head = chart.title ? `${KIND_NAMES[chart.kind]}, ${chart.title}.` : `${KIND_NAMES[chart.kind]}.`;
  const parts = chart.series.map((series, index) => {
    // Unnamed is normal for one series and ambiguous for several: without a marker,
    // two series read as one long list of numbers. The position is what the legend
    // shows in that case too, so the two agree.
    const name = series.name || (chart.series.length > 1 ? `Series ${index + 1}` : '');
    if (chart.kind === 'scatter') {
      const xs = series.points.map((point) => point.x);
      const ys = series.points.map((point) => point.y);
      const extent = `${series.points.length} points, x from ${tickText(Math.min(...xs))} to ${tickText(
        Math.max(...xs),
      )}, y from ${tickText(Math.min(...ys))} to ${tickText(Math.max(...ys))}`;
      return name ? `${name}: ${extent}` : extent;
    }
    const listed = series.points
      .map((point) => `${chart.labels[point.x] || point.x + 1}: ${tickText(point.y)}`)
      .join(', ');
    return name ? `${name} — ${listed}` : listed;
  });
  return `${head} ${parts.join('. ')}.`;
}
