import {
  CHART_METRICS,
  describeChart,
  layoutChart,
  parseChart,
  tickText,
  type Chart,
  type ChartKind,
} from '@/components/markdown/chart';

/** The drawn half of the union, or a failure naming what came back instead. */
function drawn(source: string): Extract<Chart, { kind: ChartKind }> {
  const chart = parseChart(source);
  if (chart.kind === 'unsupported') throw new Error(`expected a chart, got: ${chart.why}`);
  return chart;
}

describe('parseChart', () => {
  it('reads this app own shape', () => {
    const chart = drawn('{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"series":[{"name":"2025","data":[12,18]}]}');
    expect(chart.kind).toBe('bar');
    expect(chart.title).toBe('Revenue');
    expect(chart.labels).toEqual(['Q1', 'Q2']);
    expect(chart.series).toEqual([{ name: '2025', points: [{ x: 0, y: 12 }, { x: 1, y: 18 }] }]);
  });

  it('reads a Chart.js spec, labels and datasets nested under data', () => {
    const chart = drawn('{"type":"line","data":{"labels":["a","b"],"datasets":[{"label":"hits","data":[1,2]}]}}');
    expect(chart.kind).toBe('line');
    expect(chart.labels).toEqual(['a', 'b']);
    expect(chart.series[0]?.name).toBe('hits');
  });

  it('reads a bare one-series spec', () => {
    const chart = drawn('{"type":"column","labels":["x"],"data":[7]}');
    expect(chart.kind).toBe('bar');
    expect(chart.series).toEqual([{ name: '', points: [{ x: 0, y: 7 }] }]);
  });

  it('takes scatter points as pairs and as objects', () => {
    const pairs = drawn('{"type":"scatter","series":[{"data":[[1,2],[3,4]]}]}');
    expect(pairs.series[0]?.points).toEqual([{ x: 1, y: 2 }, { x: 3, y: 4 }]);
    const objects = drawn('{"type":"scatter","series":[{"points":[{"x":10,"y":20}]}]}');
    expect(objects.series[0]?.points).toEqual([{ x: 10, y: 20 }]);
  });

  it('puts the nth number under the nth label whatever x the spec claimed', () => {
    // A category axis: the label decides the position. Honouring a `x: 2000` here
    // would place the bar two thousand slots off the right of the screen.
    const chart = drawn('{"type":"bar","labels":["2000","2001"],"series":[{"data":[{"x":2000,"y":5},{"x":2001,"y":6}]}]}');
    expect(chart.series[0]?.points).toEqual([{ x: 0, y: 5 }, { x: 1, y: 6 }]);
  });

  it('reads a number a model formatted for a person', () => {
    const chart = drawn('{"type":"bar","labels":["a","b","c"],"data":["1,200","42%","-3.5"]}');
    expect(chart.series[0]?.points.map((point) => point.y)).toEqual([1200, 42, -3.5]);
  });

  it('drops a null rather than reading it as zero', () => {
    const chart = drawn('{"type":"line","labels":["a","b","c"],"data":[1,null,3]}');
    expect(chart.series[0]?.points).toEqual([{ x: 0, y: 1 }, { x: 2, y: 3 }]);
  });

  it('pads the labels to the longest series', () => {
    const chart = drawn('{"type":"bar","labels":["a"],"data":[1,2,3]}');
    expect(chart.labels).toEqual(['a', '', '']);
  });

  it('refuses rather than half-drawing', () => {
    const why = (source: string) => {
      const chart = parseChart(source);
      return chart.kind === 'unsupported' ? chart.why : null;
    };
    expect(why('not json')).toMatch(/valid JSON/);
    expect(why('[1,2,3]')).toMatch(/not an object/);
    expect(why('{"labels":["a"],"data":[1]}')).toMatch(/no "type"/);
    expect(why('{"type":"pie","data":[1,2]}')).toMatch(/pie charts are not drawn/);
    expect(why('{"type":"bar","data":["nonsense"]}')).toMatch(/no numbers/);
    expect(why('{"type":"bar"}')).toMatch(/no numbers/);
  });

  it('refuses more than a phone can show, rather than truncating it', () => {
    const seven = Array.from({ length: 7 }, (_, at) => ({ name: `s${at}`, data: [1, 2] }));
    expect(parseChart(JSON.stringify({ type: 'line', series: seven }))).toEqual({
      kind: 'unsupported',
      why: '7 series is more than a phone can tell apart',
    });

    const manyBars = Array.from({ length: 41 }, (_, at) => at);
    expect(parseChart(JSON.stringify({ type: 'bar', data: manyBars }))).toEqual({
      kind: 'unsupported',
      why: '41 bars is too many to label',
    });

    // Past the point cap, and under the bar cap, so it is the points that refuse.
    const dense = Array.from({ length: 3 }, () => ({ data: Array.from({ length: 200 }, (_, at) => at) }));
    expect(parseChart(JSON.stringify({ type: 'scatter', series: dense }))).toEqual({
      kind: 'unsupported',
      why: '600 points is too many to draw legibly',
    });
  });
});

describe('tickText', () => {
  it('trims the float noise a summed step leaves behind', () => {
    expect(tickText(0.1 + 0.1 + 0.1)).toBe('0.3');
  });

  it('shortens a big number instead of spending the gutter on it', () => {
    expect(tickText(1_500_000)).toBe('1.5M');
    expect(tickText(-2_000)).toBe('-2k');
    expect(tickText(999)).toBe('999');
  });

  it('keeps the long form when the short one would collide with the next tick', () => {
    // 1001000 and 1002000 both round to `1M`, which would put two identical labels at
    // two heights on the same axis.
    expect(tickText(1_001_000)).toBe('1001000');
  });
});

describe('layoutChart', () => {
  const WIDTH = 320;

  it('puts every bar inside the plot, and the axis on a round number', () => {
    const chart = drawn('{"type":"bar","labels":["a","b","c"],"data":[12,18,25]}');
    const laid = layoutChart(chart, WIDTH);
    expect(laid.bars).toHaveLength(3);
    for (const bar of laid.bars) {
      expect(bar.x).toBeGreaterThanOrEqual(laid.plot.x);
      expect(bar.x + bar.w).toBeLessThanOrEqual(laid.plot.x + laid.plot.w + 0.001);
      expect(bar.y).toBeGreaterThanOrEqual(0);
      expect(bar.y + bar.h).toBeLessThanOrEqual(laid.plot.h + 0.001);
    }
    expect(laid.yTicks.map((tick) => tick.text)).toEqual(['0', '10', '20', '30']);
    expect(laid.width).toBe(WIDTH);
    expect(laid.height).toBe(CHART_METRICS.plotHeight + CHART_METRICS.footer);
  });

  it('anchors a bar axis at zero, so a near-flat series is not exaggerated', () => {
    const chart = drawn('{"type":"bar","labels":["a","b"],"data":[98,100]}');
    const laid = layoutChart(chart, WIDTH);
    expect(laid.yTicks[0]?.text).toBe('0');
    // Both bars nearly full height: the honest reading of 98 against 100.
    const heights = laid.bars.map((bar) => bar.h / laid.plot.h);
    expect(Math.min(...heights)).toBeGreaterThan(0.9);
  });

  it('gives a line its own range instead, and does not force zero in', () => {
    const chart = drawn('{"type":"line","labels":["a","b"],"data":[98,100]}');
    const laid = layoutChart(chart, WIDTH);
    expect(Number(laid.yTicks[0]?.text)).toBeGreaterThan(0);
    expect(laid.segments).toHaveLength(1);
  });

  it('grows a negative bar downward from the baseline', () => {
    const chart = drawn('{"type":"bar","labels":["up","down"],"data":[10,-10]}');
    const laid = layoutChart(chart, WIDTH);
    const [up, down] = laid.bars;
    expect(up?.y).toBeLessThan(laid.zero);
    expect(down?.y).toBeCloseTo(laid.zero, 5);
    expect(laid.zero).toBeGreaterThan(0);
    expect(laid.zero).toBeLessThan(laid.plot.h);
  });

  it('centres a flat series rather than dividing by a zero span', () => {
    const chart = drawn('{"type":"line","labels":["a","b"],"data":[5,5]}');
    const laid = layoutChart(chart, WIDTH);
    for (const segment of [...laid.segments]) {
      expect(segment.y1).toBeCloseTo(laid.plot.h / 2, 5);
      expect(Number.isFinite(segment.y1)).toBe(true);
    }
  });

  it('keeps a one-point series visible as a dot', () => {
    const laid = layoutChart(drawn('{"type":"line","labels":["a"],"data":[3]}'), WIDTH);
    expect(laid.segments).toHaveLength(0);
    expect(laid.dots).toHaveLength(1);
  });

  it('thins the x labels instead of overlapping them', () => {
    const labels = Array.from({ length: 24 }, (_, at) => `m${at}`);
    const chart = drawn(JSON.stringify({ type: 'bar', labels, data: labels.map((_, at) => at) }));
    const laid = layoutChart(chart, WIDTH);
    expect(laid.xTicks.length).toBeLessThanOrEqual(CHART_METRICS.xTicks);
    expect(laid.xTicks[0]?.text).toBe('m0');
  });

  it('splits a bar group between series without overlapping them', () => {
    const chart = drawn('{"type":"bar","labels":["a","b"],"series":[{"data":[1,2]},{"data":[3,4]}]}');
    const laid = layoutChart(chart, WIDTH);
    const first = laid.bars.filter((bar) => bar.series === 0);
    const second = laid.bars.filter((bar) => bar.series === 1);
    expect(first).toHaveLength(2);
    expect(second).toHaveLength(2);
    expect(first[0]!.x + first[0]!.w).toBeLessThanOrEqual(second[0]!.x);
  });

  it('scales a scatter on both axes and labels x with numbers', () => {
    const chart = drawn('{"type":"scatter","series":[{"data":[[0,0],[10,100]]}]}');
    const laid = layoutChart(chart, WIDTH);
    expect(laid.dots).toHaveLength(2);
    expect(laid.dots[0]!.x).toBeCloseTo(laid.plot.x, 5);
    expect(laid.dots[0]!.y).toBeCloseTo(laid.plot.h, 5);
    expect(laid.dots[1]!.y).toBeCloseTo(0, 5);
    expect(laid.xTicks.map((tick) => tick.text)).toEqual(['0', '2', '4', '6', '8', '10']);
  });

  it('never lets the plot collapse at an absurd width', () => {
    const laid = layoutChart(drawn('{"type":"bar","labels":["a"],"data":[1]}'), 10);
    expect(laid.plot.w).toBeGreaterThan(0);
  });
});

describe('describeChart', () => {
  it('reads out every value on a category chart', () => {
    const chart = drawn('{"type":"bar","title":"Revenue","labels":["Q1","Q2"],"data":[12,18]}');
    expect(describeChart(chart)).toBe('Bar chart, Revenue. Q1: 12, Q2: 18.');
  });

  it('names each series', () => {
    const chart = drawn('{"type":"line","labels":["a"],"series":[{"name":"one","data":[1]},{"name":"two","data":[2]}]}');
    expect(describeChart(chart)).toBe('Line chart. one — a: 1. two — a: 2.');
  });

  it('numbers the series when the spec named none, so two lists do not read as one', () => {
    const chart = drawn('{"type":"bar","labels":["a"],"series":[{"data":[1]},{"data":[2]}]}');
    expect(describeChart(chart)).toBe('Bar chart. Series 1 — a: 1. Series 2 — a: 2.');
  });

  it('falls back to a position when a label is missing', () => {
    expect(describeChart(drawn('{"type":"bar","data":[4]}'))).toBe('Bar chart. 1: 4.');
  });

  it('summarises a scatter by its extents rather than listing it', () => {
    const chart = drawn('{"type":"scatter","series":[{"data":[[1,2],[3,4]]}]}');
    expect(describeChart(chart)).toBe('Scatter plot. 2 points, x from 1 to 3, y from 2 to 4.');
  });
});
