/**
 * The parser is the part that has to be right: everything it gets wrong is shown to
 * the user as a confidently drawn diagram that does not match what the model wrote.
 * So the cases here are the ones where a wrong answer would be silent — a label eaten
 * by the link matcher, a node read as a label, a cycle that never settles.
 */

import { METRICS, describeFlow, layoutFlow, parseMermaid, wrapLabel } from '@/components/markdown/mermaid';
import type { Mermaid } from '@/components/markdown/mermaid';

function flow(source: string): Extract<Mermaid, { kind: 'flow' }> {
  const parsed = parseMermaid(source);
  if (parsed.kind !== 'flow') throw new Error(`expected a flowchart, got: ${parsed.what}`);
  return parsed;
}

function refusal(source: string): string {
  const parsed = parseMermaid(source);
  if (parsed.kind !== 'unsupported') throw new Error('expected a refusal, got a flowchart');
  return parsed.what;
}

/** Indexing, with a missing entry as a failure rather than a silent `undefined`. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at index ${index}`);
  return item;
}

describe('parseMermaid', () => {
  test('reads shapes, labels and the three ways of writing a link label', () => {
    const diagram = flow(`flowchart TD
      A[Start] --> B{Is it?}
      B -->|Yes| C(Done)
      B -- No --> D([Stop])
      C ---|then| D`);

    expect(diagram.axis).toBe('TD');
    expect(diagram.nodes).toEqual([
      { id: 'A', label: 'Start', shape: 'rect' },
      { id: 'B', label: 'Is it?', shape: 'diamond' },
      { id: 'C', label: 'Done', shape: 'round' },
      { id: 'D', label: 'Stop', shape: 'stadium' },
    ]);
    expect(diagram.edges).toEqual([
      { from: 'A', to: 'B', kind: 'solid', arrow: 'arrow' },
      { from: 'B', to: 'C', kind: 'solid', arrow: 'arrow', label: 'Yes' },
      { from: 'B', to: 'D', kind: 'solid', arrow: 'arrow', label: 'No' },
      { from: 'C', to: 'D', kind: 'solid', arrow: 'none', label: 'then' },
    ]);
  });

  test('a chain is a chain, not a labelled link', () => {
    // The `--- B -->` case: a three-character run cannot carry a label, so `B` is a
    // node. Reading it as a label would drop a box off the diagram entirely.
    const diagram = flow('graph LR\n A --- B --> C');
    expect(diagram.nodes.map((node) => node.id)).toEqual(['A', 'B', 'C']);
    expect(diagram.edges).toEqual([
      { from: 'A', to: 'B', kind: 'solid', arrow: 'none' },
      { from: 'B', to: 'C', kind: 'solid', arrow: 'arrow' },
    ]);
  });

  test('line weights and arrowheads', () => {
    const diagram = flow('graph LR\n A -.-> B\n B ==> C\n C --o D\n D --x E\n E -. maybe .-> A');
    expect(diagram.edges).toEqual([
      { from: 'A', to: 'B', kind: 'dashed', arrow: 'arrow' },
      { from: 'B', to: 'C', kind: 'thick', arrow: 'arrow' },
      { from: 'C', to: 'D', kind: 'solid', arrow: 'dot' },
      { from: 'D', to: 'E', kind: 'solid', arrow: 'cross' },
      { from: 'E', to: 'A', kind: 'dashed', arrow: 'arrow', label: 'maybe' },
    ]);
  });

  test('a label may contain the characters a link is made of', () => {
    const diagram = flow('graph LR\n A -- e.g. 2-3 items --> B\n B -->|"x, y"| C');
    expect(at(diagram.edges, 0).label).toBe('e.g. 2-3 items');
    // Quotes are mermaid's escape for a comma, so they are not part of the text.
    expect(at(diagram.edges, 1).label).toBe('x, y');
  });

  test('headers, semicolons and comments', () => {
    expect(flow('graph TD;A-->B').edges).toHaveLength(1);
    // `flowchart` with no direction is top-down, and `TB` is the same thing.
    expect(flow('flowchart\n A-->B').axis).toBe('TD');
    expect(flow('flowchart TB\n A-->B').axis).toBe('TD');
    expect(flow('flowchart RL\n A-->B').axis).toBe('RL');
    const commented = flow('graph TD\n %% A --> Z\n A --> B\n classDef big fill:#f00\n style A fill:#0f0');
    expect(commented.nodes.map((node) => node.id)).toEqual(['A', 'B']);
  });

  test('a bare mention keeps a label declared later, in either order', () => {
    expect(at(flow('graph TD\n A --> B\n B[Later]').nodes, 1).label).toBe('Later');
    expect(at(flow('graph TD\n B[Early] --> C\n A --> B').nodes, 0).label).toBe('Early');
  });

  test('what it refuses, and why', () => {
    expect(parseMermaid('sequenceDiagram\n A->>B: hi')).toEqual({ kind: 'unsupported', what: 'sequenceDiagram' });
    expect(parseMermaid('   ')).toEqual({ kind: 'unsupported', what: 'an empty diagram' });
    // Drawn flat, a subgraph's boxes would claim a grouping the source does not have.
    expect(refusal('graph TD\n subgraph one\n A-->B\n end')).toContain('subgraph');
    // A statement it cannot account for takes the whole diagram down to source, rather
    // than drawing the half it understood.
    expect(parseMermaid('graph TD\n A --> B\n A@{shape: circle}').kind).toBe('unsupported');
    expect(parseMermaid('graph TD\n A[unclosed --> B').kind).toBe('unsupported');
    expect(parseMermaid('graph TD\n A -->').kind).toBe('unsupported');
  });
});

describe('wrapLabel', () => {
  test('wraps on words and breaks on <br>', () => {
    expect(wrapLabel('one two three four five six seven', 10)).toEqual(['one two', 'three four', 'five six', 'seven']);
    expect(wrapLabel('top<br/>bottom', 40)).toEqual(['top', 'bottom']);
    // A word longer than the wrap width goes on its own line rather than nowhere.
    expect(wrapLabel('a supercalifragilistic b', 8)).toEqual(['a', 'supercalifragilistic', 'b']);
  });
});

describe('layoutFlow', () => {
  test('layers run along the flow direction and reverse with it', () => {
    const down = layoutFlow(flow('graph TD\n A --> B --> C'));
    const [a, b, c] = [at(down.boxes, 0), at(down.boxes, 1), at(down.boxes, 2)];
    expect(a.y).toBeLessThan(b.y);
    expect(b.y).toBeLessThan(c.y);

    const right = layoutFlow(flow('graph LR\n A --> B --> C'));
    expect(at(right.boxes, 0).x).toBeLessThan(at(right.boxes, 1).x);
    expect(at(right.boxes, 0).y).toBe(at(right.boxes, 1).y);

    // Bottom-up puts the first node last without changing anything else.
    const up = layoutFlow(flow('graph BT\n A --> B --> C'));
    expect(at(up.boxes, 0).y).toBeGreaterThan(at(up.boxes, 2).y);
    expect(up.height).toBeCloseTo(down.height);
    expect(c.y + c.h).toBeCloseTo(down.height);
  });

  test('siblings share a layer, centred against the widest one', () => {
    const laid = layoutFlow(flow('graph TD\n A --> B\n A --> C'));
    const [a, b, c] = [at(laid.boxes, 0), at(laid.boxes, 1), at(laid.boxes, 2)];
    expect(b.y).toBe(c.y);
    expect(b.x).toBeLessThan(c.x);
    // The parent sits over the middle of its children.
    expect(a.x + a.w / 2).toBeCloseTo((b.x + c.x + c.w) / 2);
    expect(laid.width).toBeCloseTo(b.w + c.w + METRICS.gapCross);
  });

  test('a decision node is square, and big enough for its label rotated', () => {
    const box = at(layoutFlow(flow('graph TD\n A{Is the cache warm?}')).boxes, 0);
    expect(box.w).toBeCloseTo(box.h);
    // The inscribed rectangle of a square rotated 45° has half the box's dimensions,
    // so the box is the label's width *plus* its height. Under that and the text is
    // outside the diamond it is meant to sit in.
    const labelWidth = at(box.lines, 0).length * METRICS.charWidth + METRICS.padX * 2;
    const labelHeight = box.lines.length * METRICS.lineHeight + METRICS.padY * 2;
    expect(box.w).toBeCloseTo(labelWidth + labelHeight);
  });

  test('lines start and end on the boxes they join', () => {
    const laid = layoutFlow(flow('graph TD\n A --> B'));
    const [a, b] = [at(laid.boxes, 0), at(laid.boxes, 1)];
    const line = at(laid.lines, 0);
    expect(line.y1).toBeCloseTo(a.y + a.h);
    expect(line.y2).toBeCloseTo(b.y);
    expect(line.x1).toBeCloseTo(a.x + a.w / 2);
  });

  test('a cycle settles instead of spinning', () => {
    const laid = layoutFlow(flow('graph TD\n A --> B\n B --> C\n C --> A'));
    expect(laid.boxes.map((box) => box.id).sort()).toEqual(['A', 'B', 'C']);
    expect(laid.lines).toHaveLength(3);
    // Three layers, one box each, and no empty band between them: relaxation on a
    // cycle keeps lifting the same nodes, so the ranks it leaves have to be compressed
    // or the diagram is mostly whitespace.
    const rows = new Set(laid.boxes.map((box) => box.y));
    expect(rows.size).toBe(3);
    expect(laid.height).toBeCloseTo(laid.boxes.reduce((sum, box) => sum + box.h, 0) + METRICS.gapMain * 2);
    // The back edge runs the other way up the diagram, which is what a cycle is.
    const back = laid.lines.find((line) => line.y1 > line.y2);
    expect(back).toBeDefined();
  });

  test('a self-link is dropped rather than drawn as a dot', () => {
    expect(layoutFlow(flow('graph TD\n A --> A')).lines).toEqual([]);
  });
});

describe('describeFlow', () => {
  test('says what the boxes and lines cannot', () => {
    expect(describeFlow(flow('graph LR\n A[Start] -->|ok| B[End]\n C[Aside]'))).toBe(
      'Flowchart, left to right. Start leads to End (ok). unconnected: Aside.',
    );
    expect(describeFlow(flow('graph TD\n A --- B'))).toBe('Flowchart, top to bottom. A connects to B.');
  });
});
