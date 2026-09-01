/**
 * Command output, as a terminal instead of a blob.
 *
 * A remote shell over MCP is the only honest answer to "there is no terminal" on an
 * unrooted phone (see `progress-v1.1.md` §4), and the app already speaks that
 * protocol. What was missing is the last inch: a `run_command` result arrives with
 * colour escapes and progress-bar carriage returns in it, and a code block prints
 * them literally — `[0;32m` down the side of every line of `git status`.
 *
 * So this module reads the escapes rather than showing them. It is a renderer's
 * parser, not an emulator: enough of ANSI to make output legible, and deliberately
 * none of the cursor addressing that a real screen needs.
 *
 * `ponytail: no cursor addressing. A carriage return drops the line built so far
 * rather than overwriting it column by column, which is identical for a progress bar
 * that reprints its whole line — the case this exists for — and wrong for a program
 * that redraws in place. Full-screen output (vim, top) wants a real emulator; it is
 * shown as plain text instead, which is honest and does not pretend.`
 */

/** The eight ANSI colours, named. Bright variants collapse onto these. */
export type AnsiColor = 'black' | 'red' | 'green' | 'yellow' | 'blue' | 'magenta' | 'cyan' | 'white';

export interface TerminalSpan {
  text: string;
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
}

export interface TerminalScreen {
  /** One entry per line, each a run of styled spans. */
  lines: TerminalSpan[][];
  /** Lines dropped off the top by the line cap, so the view can say so. */
  dropped: number;
}

/**
 * Lines kept, counted from the end.
 *
 * The end is where a command says whether it worked, and 40k lines of build output in
 * a `FlashList` row is a dropped frame per scroll. The count that went is shown, so a
 * truncated log never looks like a complete one.
 */
const MAX_LINES = 500;

/** Characters kept per line. A minified bundle on one line is not output to read. */
const MAX_LINE_CHARS = 2_000;

const COLOURS: readonly AnsiColor[] = ['black', 'red', 'green', 'yellow', 'blue', 'magenta', 'cyan', 'white'];

/**
 * Any escape or control sequence, in one pattern.
 *
 * CSI (`ESC [ … letter`) is the only family read; OSC (`ESC ] … BEL`) is matched so a
 * window title cannot leak into the output as text, and everything else falls through
 * to the two-character form.
 */
const SEQUENCE = /\x1b\[([0-9;?]*)([A-Za-z])|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g;

const HAS_ESCAPE = /\x1b\[[0-9;?]*[A-Za-z]/;
/** A carriage return that is not simply a Windows line ending. */
const HAS_OVERWRITE = /\r(?!\n)/;

/**
 * Whether this text is command output rather than prose or JSON.
 *
 * Deliberately based on the content, not on the tool's name: any MCP server may
 * shell out, the names they choose are their own, and a `tool_result` block does not
 * carry the name of the call it answers. Escapes and in-place redraws are what a
 * terminal produces and nothing else in a transcript does, so they are the signal.
 */
export function looksLikeTerminal(text: string): boolean {
  return HAS_ESCAPE.test(text) || HAS_OVERWRITE.test(text);
}

interface Style {
  color?: AnsiColor;
  bold?: boolean;
  dim?: boolean;
}

/** SGR parameters applied to a style. Unknown codes are ignored, not an error. */
function applySgr(style: Style, parameters: readonly number[]): Style {
  let next: Style = { ...style };
  for (const code of parameters) {
    if (code === 0) next = {};
    else if (code === 1) next.bold = true;
    else if (code === 2) next.dim = true;
    else if (code === 22) {
      delete next.bold;
      delete next.dim;
    } else if (code >= 30 && code <= 37) next.color = COLOURS[code - 30];
    else if (code >= 90 && code <= 97) next.color = COLOURS[code - 90];
    else if (code === 39) delete next.color;
  }
  return next;
}

function styled(text: string, style: Style): TerminalSpan {
  return {
    text,
    ...(style.color !== undefined ? { color: style.color } : {}),
    ...(style.bold ? { bold: true } : {}),
    ...(style.dim ? { dim: true } : {}),
  };
}

/** Tabs to the next eight-column stop, given how far into the line we already are. */
function expandTabs(text: string, startColumn: number): string {
  if (!text.includes('\t')) return text;
  let out = '';
  let column = startColumn;
  for (const character of text) {
    if (character === '\t') {
      const width = 8 - (column % 8);
      out += ' '.repeat(width);
      column += width;
    } else {
      out += character;
      column += 1;
    }
  }
  return out;
}

/**
 * Command output as styled lines.
 *
 * One pass over the text, alternating between escape sequences and the characters
 * between them; a line is closed on `\n` and restarted on `\r`. Backspace deletes,
 * because `\b` is how a shell's own line editor and some installers rub out a
 * character, and printing it as a control glyph is worse than honouring it.
 */
export function parseTerminal(text: string, maxLines: number = MAX_LINES): TerminalScreen {
  const lines: TerminalSpan[][] = [];
  let current: TerminalSpan[] = [];
  let style: Style = {};
  let column = 0;

  const push = (chunk: string): void => {
    if (!chunk) return;
    const room = MAX_LINE_CHARS - column;
    if (room <= 0) return;
    const text = expandTabs(chunk, column).slice(0, room);
    column += text.length;
    const last = current[current.length - 1];
    // Merged with the previous span when the style is unchanged: one span per
    // character is what a naive version produces, and it is thousands of `Text` nodes.
    if (
      last !== undefined &&
      last.color === style.color &&
      !!last.bold === !!style.bold &&
      !!last.dim === !!style.dim
    ) {
      last.text += text;
    } else {
      current.push(styled(text, style));
    }
  };

  const newline = (): void => {
    lines.push(current);
    current = [];
    column = 0;
  };

  const backspace = (): void => {
    const last = current[current.length - 1];
    if (!last || !last.text) return;
    last.text = last.text.slice(0, -1);
    column -= 1;
    if (!last.text) current.pop();
  };

  let cursor = 0;
  SEQUENCE.lastIndex = 0;
  let match: RegExpExecArray | null;

  const plain = (chunk: string): void => {
    let start = 0;
    for (let index = 0; index < chunk.length; index += 1) {
      const character = chunk[index];
      if (character === '\n') {
        push(chunk.slice(start, index));
        newline();
        start = index + 1;
      } else if (character === '\r') {
        push(chunk.slice(start, index));
        // The line so far is discarded: a progress bar reprints itself, and what
        // matters is the last thing it printed.
        current = [];
        column = 0;
        start = index + 1;
      } else if (character === '\b') {
        push(chunk.slice(start, index));
        backspace();
        start = index + 1;
      }
    }
    push(chunk.slice(start));
  };

  while ((match = SEQUENCE.exec(text)) !== null) {
    plain(text.slice(cursor, match.index));
    cursor = SEQUENCE.lastIndex;
    // `m` is Select Graphic Rendition — the colours. Every other final byte is cursor
    // movement or a mode change this does not model, and is dropped rather than shown.
    if (match[2] === 'm') {
      const parameters = (match[1] ?? '')
        .split(';')
        .map((part) => (part === '' ? 0 : Number.parseInt(part, 10)))
        .filter((value) => Number.isFinite(value));
      style = applySgr(style, parameters);
    }
  }
  plain(text.slice(cursor));

  if (current.length > 0) lines.push(current);
  // A trailing newline leaves one empty line, which is a blank row under the output.
  while (lines.length > 0 && (lines[lines.length - 1]?.length ?? 0) === 0) lines.pop();

  const dropped = Math.max(0, lines.length - maxLines);
  return { lines: dropped ? lines.slice(dropped) : lines, dropped };
}

/** The output with every escape removed, for a copy button and for an export. */
export function plainTerminal(text: string): string {
  return parseTerminal(text, Number.MAX_SAFE_INTEGER)
    .lines.map((line) => line.map((span) => span.text).join(''))
    .join('\n');
}
