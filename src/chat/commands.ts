/**
 * Slash commands: one list over everything that can be dropped into a draft.
 *
 * Before this, a prompt template, a skill toggle and a model switch each lived at
 * the end of a different path through the conversation menu — twelve entries in one
 * sheet, none of them reachable in fewer than three taps. The composer already has
 * the user's thumb and the user's attention; `/` is the shortest route from "I want
 * the diff-review template" to having it in the draft.
 *
 * Pure. The index is assembled from four stores by the screen, ranked here, and
 * dispatched by the screen. Nothing in this module knows what a prompt *does*.
 *
 * **Why start-of-draft only.** A `/` anywhere in the text would mean parsing around
 * the caret, and every URL, path and date the user types would open a menu over the
 * keyboard. The trigger is the whole draft being a single `/word` — which is what a
 * command is — and the moment a space or a second line appears, the draft is a
 * message again.
 */

/** Where a command came from, which decides what selecting it does. */
export type CommandKind = 'app' | 'prompt' | 'skill' | 'mcp-prompt';

export interface CommandItem {
  kind: CommandKind;
  /** What the screen dispatches on. Unique within an index. */
  id: string;
  /** What the user types after the slash. Lowercase, no spaces. */
  name: string;
  /** The human label for the row. */
  label: string;
  /** One line under the label. A description, a server name, a template's first words. */
  hint?: string;
}

/**
 * The commands that act on the app rather than on the draft.
 *
 * Named after what they open, not after the store they poke: a user typing `/model`
 * wants the model picker, and does not know there is a conversation config.
 */
export const APP_COMMANDS: readonly CommandItem[] = [
  { kind: 'app', id: 'model', name: 'model', label: 'Model', hint: 'Switch the model for this conversation' },
  { kind: 'app', id: 'system', name: 'system', label: 'System prompt', hint: 'Edit the instructions for this conversation' },
  { kind: 'app', id: 'skills', name: 'skills', label: 'Skills', hint: 'Turn skills on or off for this conversation' },
  { kind: 'app', id: 'servers', name: 'servers', label: 'MCP servers', hint: 'Choose which servers this conversation may call' },
  { kind: 'app', id: 'controls', name: 'controls', label: 'Model controls', hint: 'Sampling, thinking budget, max tokens' },
  { kind: 'app', id: 'files', name: 'files', label: 'Files', hint: 'Files this conversation has produced' },
  { kind: 'app', id: 'export', name: 'export', label: 'Export', hint: 'Markdown or JSON, to the share sheet or the clipboard' },
  { kind: 'app', id: 'reference', name: 'reference', label: 'Quote another chat', hint: 'Search every conversation and quote one message' },
  { kind: 'app', id: 'attach', name: 'attach', label: 'Attach', hint: 'Camera, photo library, or a document' },
];

/** Longest command name worth matching. Past this the user is writing a message. */
const MAX_QUERY = 48;

/**
 * The query being typed, or `null` when the draft is not a command.
 *
 * `'/'` on its own returns `''` — an empty query that opens the full list, which is
 * the discovery path for someone who does not yet know what is in here.
 */
export function commandQuery(draft: string): string | null {
  if (!draft.startsWith('/')) return null;
  const rest = draft.slice(1);
  if (rest.length > MAX_QUERY) return null;
  // A space or a newline ends it: `/model` is a command, `/model please` is a
  // sentence that happens to start with a slash.
  if (/[\s]/.test(rest)) return null;
  return rest.toLowerCase();
}

/** Score for one item against a query. Lower sorts first; `null` excludes it. */
function score(item: CommandItem, query: string): number | null {
  if (!query) return 0;
  const name = item.name.toLowerCase();
  const label = item.label.toLowerCase();
  if (name === query) return 0;
  if (name.startsWith(query)) return 1;
  if (label.startsWith(query)) return 2;
  // A word boundary inside the label — `/pdf` finding "Write a PDF report".
  if (label.split(/[\s-]+/).some((word) => word.startsWith(query))) return 3;
  if (name.includes(query)) return 4;
  if (label.includes(query)) return 5;
  return null;
}

/**
 * Kind order for equal-scoring matches.
 *
 * App commands first: they are the ones with a fixed, learnable name, so a user who
 * typed `/model` expecting the picker gets the picker even if a template is called
 * "model notes". Everything after that is the user's own material.
 */
const KIND_ORDER: Record<CommandKind, number> = { app: 0, prompt: 1, skill: 2, 'mcp-prompt': 3 };

/**
 * The list to show, best first.
 *
 * Stable within a score: the index arrives in an order the stores chose (recently
 * used templates first, server order for MCP prompts), and re-sorting inside a tie
 * would throw that away.
 */
export function rankCommands(items: readonly CommandItem[], query: string, limit = 40): CommandItem[] {
  const scored: { item: CommandItem; score: number; index: number }[] = [];
  items.forEach((item, index) => {
    const value = score(item, query);
    if (value !== null) scored.push({ item, score: value, index });
  });
  scored.sort(
    (a, b) => a.score - b.score || KIND_ORDER[a.item.kind] - KIND_ORDER[b.item.kind] || a.index - b.index,
  );
  return scored.slice(0, limit).map((entry) => entry.item);
}

/**
 * A title turned into something typeable after a slash.
 *
 * Templates have free-text titles — "Review this diff (strict)" — and a command
 * name has to be typeable on a phone keyboard without punctuation.
 */
export function commandName(title: string): string {
  return (
    title
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, MAX_QUERY) || 'untitled'
  );
}

/**
 * Makes every name in an index unique, in place order.
 *
 * Two templates called "Review" would otherwise both answer to `/review` and the
 * user would have no way to say which — a numeric suffix is ugly and unambiguous,
 * which is the right trade for a name the user reads in a list before choosing.
 */
export function uniqueNames(items: readonly CommandItem[]): CommandItem[] {
  const taken = new Set<string>();
  return items.map((item) => {
    let name = item.name;
    let n = 2;
    while (taken.has(name)) {
      name = `${item.name}-${n}`;
      n += 1;
    }
    taken.add(name);
    return name === item.name ? item : { ...item, name };
  });
}

export interface IndexInput {
  prompts: readonly { id: string; title: string; body: string }[];
  skills: readonly { name: string; description: string }[];
  mcpPrompts: readonly { serverId: string; serverName: string; name: string; description: string }[];
}

/**
 * The whole index, in the order it should be offered.
 *
 * A skill's entry does *not* insert its body — bodies are loaded by the model
 * through `invoke_skill`, and putting one in a draft would defeat the progressive
 * disclosure the whole skills feature is built on. Selecting a skill turns it on for
 * the conversation, which is the thing a user actually wants from `/skill-name`.
 */
export function buildCommandIndex(input: IndexInput): CommandItem[] {
  const items: CommandItem[] = [
    ...APP_COMMANDS,
    ...input.prompts.map((prompt) => ({
      kind: 'prompt' as const,
      id: prompt.id,
      name: commandName(prompt.title),
      label: prompt.title,
      hint: firstLine(prompt.body),
    })),
    ...input.skills.map((skill) => ({
      kind: 'skill' as const,
      id: skill.name,
      name: skill.name,
      label: skill.name,
      hint: skill.description,
    })),
    ...input.mcpPrompts.map((prompt) => ({
      kind: 'mcp-prompt' as const,
      id: `${prompt.serverId}::${prompt.name}`,
      name: commandName(prompt.name),
      label: prompt.name,
      hint: prompt.description || prompt.serverName,
    })),
  ];
  return uniqueNames(items);
}

/** The first line of a template, as a one-line preview. */
function firstLine(body: string): string {
  const line = body.split('\n').find((candidate) => candidate.trim().length > 0) ?? '';
  return line.trim().length > 80 ? `${line.trim().slice(0, 79)}…` : line.trim();
}
