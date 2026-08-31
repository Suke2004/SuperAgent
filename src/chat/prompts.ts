/**
 * Prompt templates, and the `{{variable}}` substitution.
 *
 * Pure: the store and the screen do the storage and the typing, this decides what a
 * template's variables are and what filling them in produces.
 *
 * The syntax is `{{name}}` and nothing else — no filters, no defaults, no
 * conditionals. A template language is a program, a program needs debugging, and the
 * thing being built here is a way to avoid retyping "review this diff for" on a
 * phone keyboard.
 */

/** `{{ name }}`, tolerating whitespace inside the braces. */
const VARIABLE = /\{\{\s*([A-Za-z0-9_][A-Za-z0-9_ -]*?)\s*\}\}/g;

export interface PromptDraft {
  title: string;
  body: string;
}

export interface Prompt extends PromptDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
  uses: number;
  lastUsedAt?: number;
}

/**
 * The variables a template uses, in the order they first appear, deduplicated.
 *
 * First-appearance order is what the form renders in, so the fields read in the same
 * order as the sentence they are filling in.
 */
export function variablesIn(body: string): string[] {
  const seen: string[] = [];
  for (const match of body.matchAll(VARIABLE)) {
    const name = match[1]?.trim();
    if (name && !seen.includes(name)) seen.push(name);
  }
  return seen;
}

/**
 * Fill a template in.
 *
 * A variable with no value is left as its own placeholder rather than becoming an
 * empty string: `Summarise {{document}}` with nothing typed is a prompt that reads
 * as a mistake, which is better than one that silently asks the model to summarise
 * nothing. `$&`-style replacement patterns in the *values* are not interpreted —
 * a value is data, and `$1` is a thing people type.
 */
export function fillPrompt(body: string, values: Readonly<Record<string, string>>): string {
  return body.replace(VARIABLE, (whole, rawName: string) => {
    const name = rawName.trim();
    const value = values[name];
    return value !== undefined && value.trim() !== '' ? value : whole;
  });
}

/** Validation for the editor. Same shape as the skill editor's. */
export function validatePrompt(draft: PromptDraft): string | null {
  if (!draft.title.trim()) return 'Give the prompt a title.';
  if (!draft.body.trim()) return 'The prompt has no text.';
  if (draft.body.length > MAX_PROMPT_CHARS) {
    return `That is ${draft.body.length.toLocaleString()} characters; the limit is ${MAX_PROMPT_CHARS.toLocaleString()}.`;
  }
  return null;
}

/**
 * A ceiling on one template.
 *
 * Generous — a long prompt is a legitimate thing — but finite, because this ends up
 * in a composer draft and in a request, and neither wants a pasted novel.
 */
export const MAX_PROMPT_CHARS = 20_000;
