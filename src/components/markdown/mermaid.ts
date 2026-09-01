/**
 * Mermaid → geometry.
 *
 * A model asked for a diagram writes ```mermaid, and the transcript showed the
 * source. This module is the pure half of rendering it: text in, laid-out boxes and
 * lines out, no React and no measurement, so the layout can be tested in node.
 *
 * **No mermaid.js and no WebView**, for the reason `@/components/markdown/MathView`
 * gives about KaTeX, plus one more that is specific to diagrams. mermaid's own bundle
 * is several megabytes and version 11 loads each diagram type as a separate chunk —
 * which cannot work inside a `default-src 'none'` document with no origin to fetch
 * chunks from, and the sandboxing is not negotiable: the diagram source came from a
 * model that may have been reading somebody else's page a moment earlier.
 *
 * So this renders the two-thirds of real-world mermaid that is a flowchart, and shows
 * everything else as source. That is the same bargain the LaTeX parser strikes, and
 * the fallback is the important half: what cannot be drawn stays readable, and a
 * half-drawn diagram is never shown. Any statement this parser does not understand
 * makes the whole diagram fall back, deliberately — a flowchart missing one edge is a
 * lie, where the source is merely inconvenient.
 *
 * ponytail: flowcharts only. `sequenceDiagram`, `classDiagram`, `stateDiagram` and
 * friends parse as far as their type name and then fall back to source. Add one at a
 * time, each as its own parse + layout pair, when a transcript actually contains it.
 */

/** How a node is drawn. Every mermaid shape maps onto one of these. */
export type FlowShape = 'rect' | 'round' | 'stadium' | 'circle' | 'diamond' | 'hex';

/** The three line weights mermaid distinguishes. */
export type EdgeKind = 'solid' | 'dashed' | 'thick';

/** What sits at the target end of a link. */
export type ArrowHead = 'arrow' | 'cross' | 'dot' | 'none';

/** Which way the graph flows, in mermaid's own spelling. `TB` is normalised to `TD`. */
export type FlowAxis = 'TD' | 'BT' | 'LR' | 'RL';

export interface FlowNode {
  id: string;
  label: string;
  shape: FlowShape;
}

export interface FlowEdge {
  from: string;
  to: string;
  label?: string;
  kind: EdgeKind;
  arrow: ArrowHead;
}

export type Mermaid =
  | { kind: 'flow'; axis: FlowAxis; nodes: FlowNode[]; edges: FlowEdge[] }
  /** `what` names the diagram type, or why it was refused, for the fallback to show. */
  | { kind: 'unsupported'; what: string };

/* -------------------------------------------------------------------------- */
/* Tokens                                                                      */
/* -------------------------------------------------------------------------- */

/**
 * Node shapes, by the delimiters that spell them, longest opener first.
 *
 * Several of mermaid's shapes collapse onto `rect` here: a subroutine, a cylinder and
 * a parallelogram are all a labelled box on a phone, and the alternative is a clip
 * path per shape for a distinction nobody reads at this size. What matters is that the
 * *delimiters* are all known, because an unrecognised one would leave brackets in the
 * label — a visible lie about what the model wrote.
 */
const SHAPES: readonly (readonly [string, string, FlowShape])[] = [
  ['[[', ']]', 'rect'],
  ['[(', ')]', 'rect'],
  ['((', '))', 'circle'],
  ['([', '])', 'stadium'],
  ['{{', '}}', 'hex'],
  ['[', ']', 'rect'],
  ['(', ')', 'round'],
  ['{', '}', 'diamond'],
  ['>', ']', 'rect'],
];

/** Ids stop at the first character a link could start with, so `A-->B` splits. */
const ID = /^[A-Za-z0-9_]+/;

/** One run of link characters: `--`, `---`, `==`, `-.-`, `-.`. */
const RUN = /^(?:-\.+-*|-{2,}|={2,})/;

const HEADS: Readonly<Record<string, ArrowHead>> = { '>': 'arrow', o: 'dot', x: 'cross' };

/** `|Yes|` after a link, or between two runs of one. */
const PIPE = /^\s*\|([^|]*)\|/;

/**
 * The text a person meant, out of the text mermaid needs.
 *
 * Quotes are mermaid's escape for a label containing a bracket or a comma, so they are
 * a delimiter rather than content. The slashes come off the slanted shapes, which are
 * parsed as boxes above. `#quot;`-style entities are left alone: they are rare, and a
 * visible `#quot;` is a smaller wrong than a mangled label.
 */
function cleanLabel(raw: string): string {
  let label = raw.trim();
  if (label.length >= 2 && label.startsWith('"') && label.endsWith('"')) label = label.slice(1, -1).trim();
  return label.replace(/^[/\\]+/, '').replace(/[/\\]+$/, '').trim();
}

/** A node reference — a bare id, or an id with a shape and a label. */
function matchNode(text: string): { node: FlowNode; len: number } | null {
  const id = ID.exec(text);
  if (!id) return null;
  let len = id[0].length;
  const rest = text.slice(len);
  for (const [open, close, shape] of SHAPES) {
    if (!rest.startsWith(open)) continue;
    const end = rest.indexOf(close, open.length);
    // An opener with no closer is a fence that is still streaming, or a typo. Either
    // way it is not a diagram yet.
    if (end === -1) return null;
    return {
      node: { id: id[0], label: cleanLabel(rest.slice(open.length, end)) || id[0], shape },
      len: len + end + close.length,
    };
  }
  return { node: { id: id[0], label: id[0], shape: 'rect' }, len };
}

function kindOf(run: string): EdgeKind {
  if (run.startsWith('=')) return 'thick';
  return run.includes('.') ? 'dashed' : 'solid';
}

/**
 * A link, in the three shapes mermaid writes one.
 *
 * `A -->|yes| B`, `A -- yes --> B` and `A --- B`. The middle form is only tried when
 * the opening run is exactly two characters, which is mermaid's own rule and the only
 * thing that keeps `A --- B --> C` from reading node `B` as a label.
 *
 * A leading `<` (`A <--> B`) is consumed but not recorded — the head at the far end is
 * drawn and the near one is not. ponytail: one arrowhead per line; add the second when
 * a bidirectional diagram turns up.
 */
function matchEdge(text: string): { edge: Omit<FlowEdge, 'from' | 'to'>; len: number } | null {
  let len = 0;
  let body = text;
  if (body.startsWith('<')) {
    body = body.slice(1);
    len += 1;
  }
  const first = RUN.exec(body);
  if (!first) return null;
  const kind = kindOf(first[0]);
  len += first[0].length;
  let rest = body.slice(first[0].length);

  const head = HEADS[rest.slice(0, 1)];
  if (head) {
    len += 1;
    rest = rest.slice(1);
    const pipe = PIPE.exec(rest);
    if (pipe) return { edge: { kind, arrow: head, label: cleanLabel(pipe[1] ?? '') }, len: len + pipe[0].length };
    return { edge: { kind, arrow: head }, len };
  }

  const pipe = PIPE.exec(rest);
  if (pipe) return { edge: { kind, arrow: 'none', label: cleanLabel(pipe[1] ?? '') }, len: len + pipe[0].length };

  if (first[0].length === 2) {
    const mid = /^\s*(.+?)\s*(-\.+-*|-{2,}|={2,}|\.-+)([>ox])?/.exec(rest);
    if (mid) {
      const arrow = (mid[3] ? HEADS[mid[3]] : undefined) ?? 'none';
      return { edge: { kind, arrow, label: cleanLabel(mid[1] ?? '') }, len: len + mid[0].length };
    }
  }

  return { edge: { kind, arrow: 'none' }, len };
}

/* -------------------------------------------------------------------------- */
/* Parsing                                                                     */
/* -------------------------------------------------------------------------- */

/** Lines that only affect colour, interaction or accessibility metadata. */
const IGNORED = /^(classDef|class|style|linkStyle|click|direction|accTitle|accDescr)\b/i;

const HEADER = /^(?:graph|flowchart)(?:\s+(TD|TB|BT|LR|RL))?\b/i;

/** Record a mention. A later declaration with a real label wins over a bare id. */
function register(nodes: Map<string, FlowNode>, node: FlowNode): void {
  const seen = nodes.get(node.id);
  if (!seen || (seen.label === seen.id && node.label !== node.id) || (seen.shape === 'rect' && node.shape !== 'rect')) {
    nodes.set(node.id, node);
  }
}

/**
 * One statement: a chain of nodes joined by links.
 *
 * `A --> B --> C` is three nodes and two edges, which is why this is a loop rather
 * than a pair. Returns false on anything it cannot account for, and the caller turns
 * that into a fallback for the whole diagram.
 */
function parseStatement(text: string, nodes: Map<string, FlowNode>, edges: FlowEdge[]): boolean {
  let rest = text.trim();
  let previous: string | null = null;
  let pending: Omit<FlowEdge, 'from' | 'to'> | null = null;

  while (rest) {
    const node = matchNode(rest);
    if (!node) return false;
    register(nodes, node.node);
    if (previous !== null && pending) edges.push({ from: previous, to: node.node.id, ...pending });
    previous = node.node.id;
    pending = null;
    rest = rest.slice(node.len).trim();
    if (!rest) return true;
    const edge = matchEdge(rest);
    if (!edge) return false;
    pending = edge.edge;
    rest = rest.slice(edge.len).trim();
    // A link with nothing after it: the fence is mid-stream, or the line is broken.
    if (!rest) return false;
  }
  return true;
}

/**
 * Text between ```mermaid fences → something drawable, or a reason it is not.
 *
 * Never throws and never partially succeeds: every caller's fallback is the source
 * itself, so "no" is a normal answer.
 */
export function parseMermaid(source: string): Mermaid {
  const lines = source
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith('%%'));
  const head = lines[0];
  if (head === undefined) return { kind: 'unsupported', what: 'an empty diagram' };

  const header = HEADER.exec(head);
  if (!header) return { kind: 'unsupported', what: head.split(/[\s:]/)[0] || 'that diagram' };
  const direction = (header[1] ?? 'TD').toUpperCase();
  const axis: FlowAxis = direction === 'TB' ? 'TD' : (direction as FlowAxis);

  const nodes = new Map<string, FlowNode>();
  const edges: FlowEdge[] = [];
  const statements = [head.slice(header[0].length), ...lines.slice(1)]
    .flatMap((line) => line.split(';'))
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);

  for (const statement of statements) {
    // Grouping changes the geometry rather than decorating it, so a diagram with one
    // is shown as source rather than drawn flat with the boxes silently ungrouped.
    if (/^subgraph\b/i.test(statement) || /^end$/i.test(statement)) {
      return { kind: 'unsupported', what: 'a flowchart with subgraphs' };
    }
    if (IGNORED.test(statement)) continue;
    if (!parseStatement(statement, nodes, edges)) {
      return { kind: 'unsupported', what: `a flowchart this app cannot read (${statement.slice(0, 40)})` };
    }
  }

  if (nodes.size === 0) return { kind: 'unsupported', what: 'a flowchart with no nodes' };
  return { kind: 'flow', axis, nodes: [...nodes.values()], edges };
}

/* -------------------------------------------------------------------------- */
/* Layout                                                                      */
/* -------------------------------------------------------------------------- */

export interface LaidBox extends FlowNode {
  /** The label, already wrapped: the renderer draws one `Text` per entry. */
  lines: string[];
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LaidLine extends FlowEdge {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface FlowLayout {
  width: number;
  height: number;
  boxes: LaidBox[];
  lines: LaidLine[];
}

/**
 * Everything the geometry depends on that a browser would have measured.
 *
 * React Native cannot measure a string before laying it out, so a box is sized from a
 * character count — deliberately a slight over-estimate, because a box that is a few
 * points too wide looks fine and one that is too narrow clips its own label. These are
 * the numbers to nudge once this has been seen on a real screen.
 */
export interface Metrics {
  /** Mean advance width at `fontSize.sm`, over-estimated. */
  charWidth: number;
  lineHeight: number;
  padX: number;
  padY: number;
  /** Between layers — the direction the arrows run, so labels need room here. */
  gapMain: number;
  /** Between siblings in one layer. */
  gapCross: number;
  /** Wrap width, in characters. */
  maxChars: number;
}

export const METRICS: Metrics = {
  charWidth: 7.8,
  lineHeight: 18,
  padX: 10,
  padY: 7,
  gapMain: 46,
  gapCross: 16,
  maxChars: 22,
};

/** Greedy wrap, honouring mermaid's own `<br>` as a hard break. */
export function wrapLabel(label: string, maxChars: number): string[] {
  const out: string[] = [];
  for (const hard of label.split(/<br\s*\/?>/i)) {
    let line = '';
    for (const word of hard.trim().split(/\s+/).filter(Boolean)) {
      if (!line) line = word;
      else if (line.length + 1 + word.length <= maxChars) line += ` ${word}`;
      else {
        out.push(line);
        line = word;
      }
    }
    out.push(line);
  }
  return out.length ? out : [''];
}

/**
 * A box big enough to hold its label, given its shape.
 *
 * The two interesting cases are exact rather than fudged. A square rotated 45° contains
 * a centred `w × h` rectangle when its side is `(w + h) / √2`, whose bounding box is
 * therefore `w + h` square — that is the diamond. A circle needs its diameter to be the
 * label's diagonal. Both fall out of the geometry, so a long label in a decision node
 * grows the diamond instead of spilling out of it.
 */
function sizeOf(shape: FlowShape, lines: string[], m: Metrics): { w: number; h: number } {
  const longest = lines.reduce((most, line) => Math.max(most, line.length), 0);
  const w = longest * m.charWidth + m.padX * 2;
  const h = lines.length * m.lineHeight + m.padY * 2;
  if (shape === 'diamond') return { w: w + h, h: w + h };
  if (shape === 'circle') {
    const d = Math.hypot(w, h);
    return { w: d, h: d };
  }
  // A hexagon and a stadium both lose their corners, so the text needs room inboard.
  if (shape === 'hex' || shape === 'stadium') return { w: w + h * 0.5, h };
  return { w, h };
}

/**
 * Which layer each node belongs to.
 *
 * Longest-path layering by relaxation: every edge wants its target at least one layer
 * past its source, and `|V|` passes is enough for that to settle on a DAG. A cycle
 * never settles, so the pass count is also the bound — `A --> B --> A` ends up with the
 * two on adjacent layers and a line that runs back up the diagram, which is exactly
 * what a cycle looks like when it is drawn.
 */
function layersOf(nodes: FlowNode[], edges: FlowEdge[]): number[] {
  const index = new Map(nodes.map((node, at) => [node.id, at]));
  const layer = new Array<number>(nodes.length).fill(0);
  for (let pass = 0; pass < nodes.length; pass += 1) {
    let moved = false;
    for (const edge of edges) {
      const from = index.get(edge.from);
      const to = index.get(edge.to);
      if (from === undefined || to === undefined) continue;
      const want = (layer[from] ?? 0) + 1;
      if ((layer[to] ?? 0) < want) {
        layer[to] = want;
        moved = true;
      }
    }
    if (!moved) break;
  }
  // Compressed to consecutive ranks. Relaxation on a cycle keeps lifting the same
  // nodes until the pass limit, which leaves gaps like 7, 8, 9 — and a gap is an empty
  // band, which would draw as a screenful of nothing between two boxes.
  const ranks = [...new Set(layer)].sort((a, b) => a - b);
  return layer.map((value) => ranks.indexOf(value));
}

/** Where a line leaving `box` towards `toward` crosses the box's own edge. */
function borderPoint(box: LaidBox, toward: LaidBox): { x: number; y: number } {
  const cx = box.x + box.w / 2;
  const cy = box.y + box.h / 2;
  const dx = toward.x + toward.w / 2 - cx;
  const dy = toward.y + toward.h / 2 - cy;
  if (dx === 0 && dy === 0) return { x: cx, y: cy };
  const scale = Math.min(
    dx === 0 ? Infinity : box.w / 2 / Math.abs(dx),
    dy === 0 ? Infinity : box.h / 2 / Math.abs(dy),
  );
  return { x: cx + dx * scale, y: cy + dy * scale };
}

/**
 * A parsed flowchart → absolute positions, with the origin at the top left.
 *
 * Layers stack along the flow direction and siblings spread across it, each layer
 * centred against the widest one. Edges are single straight segments between box
 * edges: a long edge that skips a layer can therefore pass behind a box, which is the
 * known ceiling of not having a router. ponytail: straight lines. Add orthogonal
 * routing if real diagrams turn out to be dense enough to need it.
 */
export function layoutFlow(diagram: Extract<Mermaid, { kind: 'flow' }>, m: Metrics = METRICS): FlowLayout {
  const vertical = diagram.axis === 'TD' || diagram.axis === 'BT';
  const reversed = diagram.axis === 'BT' || diagram.axis === 'RL';
  const layer = layersOf(diagram.nodes, diagram.edges);

  const sized = diagram.nodes.map((node, at) => {
    const lines = wrapLabel(node.label, m.maxChars);
    return { node, lines, layer: layer[at] ?? 0, ...sizeOf(node.shape, lines, m) };
  });
  const main = (item: (typeof sized)[number]) => (vertical ? item.h : item.w);
  const cross = (item: (typeof sized)[number]) => (vertical ? item.w : item.h);

  const bands: (typeof sized)[] = Array.from({ length: Math.max(0, ...layer) + 1 }, () => []);
  for (const item of sized) bands[item.layer]?.push(item);
  const bandMain = bands.map((band) => Math.max(0, ...band.map(main)));
  const bandCross = bands.map(
    (band) => band.reduce((sum, item) => sum + cross(item), 0) + m.gapCross * Math.max(0, band.length - 1),
  );
  const totalCross = Math.max(0, ...bandCross);
  const totalMain = bandMain.reduce((sum, size) => sum + size, 0) + m.gapMain * Math.max(0, bands.length - 1);

  const boxes: LaidBox[] = [];
  const placed = new Map<string, LaidBox>();
  let mainCursor = 0;
  bands.forEach((band, at) => {
    const bandSpan = bandMain[at] ?? 0;
    let crossCursor = (totalCross - (bandCross[at] ?? 0)) / 2;
    for (const item of band) {
      const centred = mainCursor + (bandSpan - main(item)) / 2;
      const along = reversed ? totalMain - centred - main(item) : centred;
      const box: LaidBox = {
        ...item.node,
        lines: item.lines,
        w: item.w,
        h: item.h,
        x: vertical ? crossCursor : along,
        y: vertical ? along : crossCursor,
      };
      boxes.push(box);
      placed.set(box.id, box);
      crossCursor += cross(item) + m.gapCross;
    }
    mainCursor += bandSpan + m.gapMain;
  });

  const lines = diagram.edges.flatMap<LaidLine>((edge) => {
    const from = placed.get(edge.from);
    const to = placed.get(edge.to);
    if (!from || !to || from === to) return [];
    const start = borderPoint(from, to);
    const end = borderPoint(to, from);
    return [{ ...edge, x1: start.x, y1: start.y, x2: end.x, y2: end.y }];
  });

  return {
    width: vertical ? totalCross : totalMain,
    height: vertical ? totalMain : totalCross,
    boxes,
    lines,
  };
}

const DIRECTIONS: Readonly<Record<FlowAxis, string>> = {
  TD: 'top to bottom',
  BT: 'bottom to top',
  LR: 'left to right',
  RL: 'right to left',
};

/**
 * The diagram as a sentence, for the screen reader.
 *
 * Boxes and lines are `View`s, so without this a flowchart is announced as nothing at
 * all — and the diagram often carries the answer, not decoration around it. Nodes with
 * no links are named too: an isolated box is still content.
 */
export function describeFlow(diagram: Extract<Mermaid, { kind: 'flow' }>): string {
  const labelOf = (id: string) => diagram.nodes.find((node) => node.id === id)?.label ?? id;
  const linked = new Set(diagram.edges.flatMap((edge) => [edge.from, edge.to]));
  const steps = diagram.edges.map((edge) => {
    const verb = edge.arrow === 'none' ? 'connects to' : 'leads to';
    return `${labelOf(edge.from)} ${verb} ${labelOf(edge.to)}${edge.label ? ` (${edge.label})` : ''}`;
  });
  const alone = diagram.nodes.filter((node) => !linked.has(node.id)).map((node) => node.label);
  if (alone.length) steps.push(`unconnected: ${alone.join(', ')}`);
  return `Flowchart, ${DIRECTIONS[diagram.axis]}. ${steps.join('. ')}.`;
}
