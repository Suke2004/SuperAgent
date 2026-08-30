/**
 * Skills: reusable instruction bundles, and the progressive disclosure that keeps
 * them affordable.
 *
 * A skill is a `SKILL.md` file — YAML frontmatter with a `name` and a
 * `description`, then a Markdown body of instructions. The body is the expensive
 * part: a useful skill runs to hundreds of lines, and a handful of them injected
 * into every system prompt would cost more per turn than the conversation.
 *
 * So the body is never sent unasked. The prompt carries only the catalogue —
 * one line per enabled skill, name and description — plus an `invoke_skill` tool.
 * The model reads the descriptions, decides one applies, calls the tool, and the
 * body comes back as the tool result. A conversation that needs no skill pays for
 * the catalogue and nothing else; one that needs a skill pays for that body once,
 * where the whole exchange can see it. That is the PRD's "progressive disclosure",
 * and it is the only reason a phone can afford this feature at all.
 *
 * Two things this module deliberately does *not* do:
 *
 *  - **Trust the frontmatter.** An imported file is arbitrary text off the
 *    filesystem. {@link parseSkill} is a tolerant parser that reports a reason
 *    rather than throwing, and every field is bounded before it can reach the
 *    database.
 *  - **Screen the body for instructions.** Unlike a memory, a skill *is*
 *    instructions, written or imported on purpose by the person whose prompt it
 *    joins, and only for conversations they switched it on for. Importing a skill
 *    from a stranger is running a stranger's prompt — the same trust decision as
 *    pasting one into the composer, and the import confirmation is where it is
 *    made.
 *
 * Pure. Persistence is `@/db/skills`, orchestration is `@/stores/skills` and the
 * tool loop in `@/stores/chat`.
 */

import { dump, load } from 'js-yaml';

import { clampProse } from '@/chat/tools';
import type { ToolDefinition } from '@/transports/types';

/** The tool the model calls to read a body. One name, so the loop can dispatch on it. */
export const INVOKE_SKILL = 'invoke_skill';

/** Longest name. Long enough for `writing-conventional-commits`, short enough to list. */
export const MAX_SKILL_NAME_CHARS = 64;

/**
 * Longest description, in characters.
 *
 * This is the field that costs on *every* turn — it is the catalogue line — so it
 * is capped harder than the body, which costs only when invoked.
 */
export const MAX_SKILL_DESCRIPTION_CHARS = 240;

/** Longest body. A skill past this is a document, and documents attach. */
export const MAX_SKILL_BODY_CHARS = 40_000;

/**
 * Names are slugs: lowercase, digits, single hyphens.
 *
 * Not cosmetic. The name is the tool argument's `enum`, so it goes on the wire on
 * every turn and comes back from the model verbatim; a name with spaces or case to
 * get wrong is a name the model will get wrong, and the failure looks like the
 * skill not working rather than like a typo.
 */
export const SKILL_NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

export interface SkillDraft {
  name: string;
  description: string;
  body: string;
}

export interface Skill extends SkillDraft {
  id: string;
  createdAt: number;
  updatedAt: number;
}

/** A skill as the catalogue sees it: no body, because the catalogue never carries one. */
export type SkillSummary = Pick<Skill, 'name' | 'description'>;

/**
 * Turns a display name into a slug, so a hand-written `PDF Processing` imports
 * rather than being rejected over punctuation the user did not know mattered.
 */
export function slugifySkillName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, MAX_SKILL_NAME_CHARS)
    .replace(/-+$/, '');
}

/**
 * Everything wrong with a draft, or `null` when it is fit to store.
 *
 * One message rather than a list: this is shown under a two-field form, and the
 * first thing wrong is the thing to fix.
 */
export function validateSkill(draft: SkillDraft): string | null {
  if (!draft.name) return 'A skill needs a name.';
  if (!SKILL_NAME_RE.test(draft.name)) {
    return 'The name must be lowercase letters, digits and single hyphens — the model has to type it back exactly.';
  }
  if (draft.name.length > MAX_SKILL_NAME_CHARS) return `The name must be under ${MAX_SKILL_NAME_CHARS} characters.`;
  if (!draft.description.trim()) {
    return 'A skill needs a description. It is the only thing the model sees before deciding to use it.';
  }
  if (!draft.body.trim()) return 'A skill needs instructions in its body.';
  if (draft.body.length > MAX_SKILL_BODY_CHARS) {
    return `The body must be under ${MAX_SKILL_BODY_CHARS.toLocaleString()} characters. Attach a document instead.`;
  }
  return null;
}

/** Bounds every field to what the database and the prompt will accept. */
export function normaliseSkill(draft: SkillDraft): SkillDraft {
  return {
    name: slugifySkillName(draft.name),
    description: clampProse(draft.description, MAX_SKILL_DESCRIPTION_CHARS),
    body: draft.body.trim().slice(0, MAX_SKILL_BODY_CHARS),
  };
}

export type ParseResult = { ok: true; skill: SkillDraft } | { ok: false; reason: string };

/**
 * `---` fence, YAML, `---` fence, body. `\r\n` tolerated because a file that
 * arrives from a desktop editor is not a malformed file.
 */
const FRONTMATTER_RE = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n([\s\S]*))?$/;

/**
 * Reads a `SKILL.md`.
 *
 * Reports a reason rather than throwing: this runs on a file the user picked, and
 * "that file has no frontmatter" is something to show them, not an exception to
 * catch two layers up. Unknown frontmatter keys are ignored rather than refused,
 * so a file written for another tool — Claude Code's own skills carry
 * `allowed-tools` and more — still imports.
 */
export function parseSkill(text: string): ParseResult {
  // A byte-order mark before the opening fence is common in files that have been
  // through a Windows editor, and it makes the fence unmatchable.
  const source = text.replace(/^﻿/, '').trim();
  const match = FRONTMATTER_RE.exec(source);
  if (!match) return { ok: false, reason: 'That file has no YAML frontmatter between --- fences.' };

  let front: unknown;
  try {
    // `load` in js-yaml 5 resolves only the core schema — no custom tags, no
    // constructors — so a hostile file is a parse error, not code.
    front = load(match[1] ?? '');
  } catch (error) {
    return { ok: false, reason: `The frontmatter is not valid YAML: ${error instanceof Error ? error.message : 'unknown'}` };
  }
  if (front === null || typeof front !== 'object' || Array.isArray(front)) {
    return { ok: false, reason: 'The frontmatter must be a set of key: value pairs.' };
  }

  const record = front as Record<string, unknown>;
  const rawName = typeof record.name === 'string' ? record.name : '';
  const rawDescription = typeof record.description === 'string' ? record.description : '';

  const draft = normaliseSkill({ name: rawName, description: rawDescription, body: match[2] ?? '' });
  const problem = validateSkill(draft);
  if (problem) return { ok: false, reason: problem };
  return { ok: true, skill: draft };
}

/** A `SKILL.md`, for export. Round-trips through {@link parseSkill}. */
export function serialiseSkill(skill: SkillDraft): string {
  // `dump` rather than string interpolation: a description with a colon in it —
  // "Reviews code: style, then correctness" — is invalid YAML unquoted, and this
  // is the kind of file people hand-edit and re-import.
  const front = dump({ name: skill.name, description: skill.description }, { lineWidth: -1 }).trimEnd();
  return `---\n${front}\n---\n\n${skill.body.trim()}\n`;
}

/** `pdf-processing.SKILL.md`. Prefixed with the name so a folder of exports is readable. */
export function skillFileName(skill: SkillDraft): string {
  return `${skill.name || 'skill'}.SKILL.md`;
}

/**
 * The catalogue block for the system prompt, or `''` when nothing is enabled.
 *
 * Empty string rather than a heading with no entries, so the prompt of a
 * conversation with no skills is byte-identical to what it was before the feature
 * existed — which is what keeps its cache prefix warm.
 *
 * The wording does two jobs: it says the descriptions are all the model has, and
 * it says what to do about that. Without the second half a model reads a
 * description as a summary it can act on and never calls the tool, which is the
 * failure mode that makes progressive disclosure look like it is not working.
 */
export function renderSkillCatalogue(skills: readonly SkillSummary[]): string {
  if (!skills.length) return '';
  const lines = skills.map((skill) => `- \`${skill.name}\`: ${skill.description}`);
  return [
    '# Skills',
    '',
    'Instruction sets the user has written and switched on for this conversation. Listed by name and',
    'description only — the instructions themselves are not here. When one of them applies, call the',
    `\`${INVOKE_SKILL}\` tool with its name, read what comes back, and follow it for the rest of the turn.`,
    'Do not guess at the contents of a skill from its description, and do not mention this list to the user.',
    '',
    ...lines,
  ].join('\n');
}

/**
 * The tool definition, with the enabled names as an `enum`.
 *
 * The `enum` is the cheap half of the correctness: a model that can only emit a
 * name from the list cannot invent `pdf-tools` for `pdf-processing`, so the
 * error path below is for a stale conversation rather than for everyday typos.
 */
export function invokeSkillTool(skills: readonly SkillSummary[]): ToolDefinition {
  return {
    name: INVOKE_SKILL,
    description:
      'Load the full instructions for one of the skills listed under "# Skills" in the system prompt. ' +
      'Call this before acting on a skill: the system prompt has only its description.',
    inputSchema: {
      type: 'object',
      properties: {
        name: {
          type: 'string',
          enum: skills.map((skill) => skill.name),
          description: 'The name of the skill to load, exactly as listed.',
        },
      },
      required: ['name'],
      additionalProperties: false,
    },
  };
}

export interface SkillResult {
  /** The tool result content. */
  content: string;
  isError?: true;
  /** The name that was resolved, for `MessageMeta.skillsInvoked`. Absent on error. */
  name?: string;
}

/**
 * Resolves one `invoke_skill` call against the enabled set.
 *
 * A miss is a tool result with `isError`, not a thrown turn: the model asked for
 * something reasonable — the skill may have been renamed or switched off since the
 * catalogue was written — and telling it what *is* available lets it recover
 * inside the same turn instead of failing the send.
 */
export function resolveSkillCall(input: unknown, skills: readonly Skill[]): SkillResult {
  const asked =
    input !== null && typeof input === 'object' && typeof (input as { name?: unknown }).name === 'string'
      ? slugifySkillName((input as { name: string }).name)
      : '';

  if (!asked) {
    return { content: `${INVOKE_SKILL} needs a "name". Available: ${nameList(skills)}.`, isError: true };
  }

  const skill = skills.find((candidate) => candidate.name === asked);
  if (!skill) {
    return { content: `There is no skill called "${asked}" in this conversation. Available: ${nameList(skills)}.`, isError: true };
  }

  // The name is repeated above the body so a long tool result stays attributable
  // when it is the only thing left of a trimmed turn.
  return { content: `# Skill: ${skill.name}\n\n${skill.body}`, name: skill.name };
}

function nameList(skills: readonly Skill[]): string {
  return skills.length ? skills.map((skill) => `"${skill.name}"`).join(', ') : 'none';
}
