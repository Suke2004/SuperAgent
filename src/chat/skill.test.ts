/**
 * The skill parser and the progressive-disclosure block.
 *
 * The parser is the part that reads a file off the filesystem, so most of these
 * cases are malformed input rather than the happy path. The catalogue and the tool
 * definition are checked for the two properties the feature depends on: that a
 * body never appears in the prompt, and that the empty case emits nothing at all.
 */

import {
  INVOKE_SKILL,
  MAX_SKILL_DESCRIPTION_CHARS,
  invokeSkillTool,
  normaliseSkill,
  parseSkill,
  renderSkillCatalogue,
  resolveSkillCall,
  serialiseSkill,
  skillFileName,
  slugifySkillName,
  validateSkill,
} from '@/chat/skill';
import type { Skill } from '@/chat/skill';

const FILE = `---
name: pdf-processing
description: Extracts text and tables from a PDF.
---

# PDF processing

1. Read the file.
2. Do the thing.
`;

const skill = (name: string, body = 'Do the thing.'): Skill => ({
  id: `skl_${name}`,
  createdAt: 1,
  updatedAt: 1,
  name,
  description: `Does ${name}.`,
  body,
});

describe('parseSkill', () => {
  it('reads frontmatter and body', () => {
    const result = parseSkill(FILE);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.name).toBe('pdf-processing');
    expect(result.skill.description).toBe('Extracts text and tables from a PDF.');
    expect(result.skill.body).toContain('# PDF processing');
  });

  it('tolerates CRLF, a byte-order mark and unknown keys', () => {
    const result = parseSkill('﻿---\r\nname: a-skill\r\ndescription: Does a thing.\r\nallowed-tools: Read\r\n---\r\n\r\nBody.\r\n');
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.skill.name).toBe('a-skill');
    expect(result.skill.body).toContain('Body.');
  });

  it('slugifies a hand-written display name rather than refusing it', () => {
    const result = parseSkill('---\nname: PDF Processing\ndescription: Reads PDFs.\n---\n\nBody.\n');
    expect(result.ok && result.skill.name).toBe('pdf-processing');
  });

  it('quotes survive a colon in the description', () => {
    const result = parseSkill('---\nname: review\ndescription: "Reviews code: style, then correctness."\n---\n\nBody.\n');
    expect(result.ok && result.skill.description).toBe('Reviews code: style, then correctness.');
  });

  it('reports a reason instead of throwing', () => {
    expect(parseSkill('no frontmatter here')).toEqual({
      ok: false,
      reason: expect.stringContaining('no YAML frontmatter'),
    });
    expect(parseSkill('---\nname: [unclosed\n---\n\nBody.\n').ok).toBe(false);
    expect(parseSkill('---\n- a\n- b\n---\n\nBody.\n')).toEqual({
      ok: false,
      reason: expect.stringContaining('key: value'),
    });
    expect(parseSkill('---\nname: a-skill\n---\n\nBody.\n')).toEqual({
      ok: false,
      reason: expect.stringContaining('description'),
    });
    expect(parseSkill('---\nname: a-skill\ndescription: Does a thing.\n---\n')).toEqual({
      ok: false,
      reason: expect.stringContaining('instructions'),
    });
  });

  it('round-trips through serialiseSkill', () => {
    const first = parseSkill(FILE);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    const again = parseSkill(serialiseSkill(first.skill));
    expect(again.ok && again.skill).toEqual(first.skill);
  });

  it('names the export file after the skill', () => {
    expect(skillFileName({ name: 'pdf-processing', description: 'x', body: 'y' })).toBe('pdf-processing.SKILL.md');
  });
});

describe('validateSkill', () => {
  it('rejects a name the model cannot type back exactly', () => {
    expect(validateSkill({ name: 'PDF Processing', description: 'x', body: 'y' })).toContain('lowercase');
    expect(validateSkill({ name: 'a--b', description: 'x', body: 'y' })).toContain('lowercase');
    expect(validateSkill({ name: 'a-b', description: 'x', body: 'y' })).toBeNull();
  });

  it('caps the description, because it costs on every turn', () => {
    const long = `${'A sentence about the skill. '.repeat(40)}`;
    const draft = normaliseSkill({ name: 'x', description: long, body: 'Body.' });
    expect(draft.description.length).toBeLessThanOrEqual(MAX_SKILL_DESCRIPTION_CHARS);
  });

  it('slugifies to nothing rather than to a hyphen', () => {
    expect(slugifySkillName('   !!!  ')).toBe('');
    expect(validateSkill({ name: '', description: 'x', body: 'y' })).toContain('needs a name');
  });
});

describe('renderSkillCatalogue', () => {
  it('emits nothing when nothing is enabled', () => {
    expect(renderSkillCatalogue([])).toBe('');
  });

  it('carries names and descriptions but never a body', () => {
    const block = renderSkillCatalogue([skill('one', 'SECRET BODY'), skill('two')]);
    expect(block).toContain('`one`');
    expect(block).toContain('Does two.');
    expect(block).toContain(INVOKE_SKILL);
    expect(block).not.toContain('SECRET BODY');
  });
});

describe('invokeSkillTool', () => {
  it('constrains the argument to the enabled names', () => {
    const tool = invokeSkillTool([skill('one'), skill('two')]);
    const properties = tool.inputSchema.properties as { name: { enum: string[] } };
    expect(tool.name).toBe(INVOKE_SKILL);
    expect(properties.name.enum).toEqual(['one', 'two']);
    expect(tool.inputSchema.required).toEqual(['name']);
  });
});

describe('resolveSkillCall', () => {
  const skills = [skill('one', 'Instructions for one.'), skill('two')];

  it('returns the body and the name it resolved', () => {
    const result = resolveSkillCall({ name: 'one' }, skills);
    expect(result.isError).toBeUndefined();
    expect(result.name).toBe('one');
    expect(result.content).toContain('Instructions for one.');
  });

  it('answers a miss with an error result naming what is available', () => {
    const result = resolveSkillCall({ name: 'three' }, skills);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('"one"');
    expect(result.name).toBeUndefined();
  });

  it('survives an argument that is not the shape it asked for', () => {
    for (const input of [null, undefined, 'one', {}, { name: 42 }, []]) {
      expect(resolveSkillCall(input, skills).isError).toBe(true);
    }
  });

  it('accepts a name the model capitalised', () => {
    expect(resolveSkillCall({ name: 'One' }, skills).name).toBe('one');
  });
});
