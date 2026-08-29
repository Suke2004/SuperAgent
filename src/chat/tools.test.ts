/**
 * Tool manifest cost control.
 *
 * The test to keep if these are ever thinned is `emits in the caller's original
 * order`: a recency-ordered manifest invalidates the largest cacheable block in
 * the request on almost every turn, which costs more than the selection saves.
 */

import type { ToolDefinition } from '@/transports/types';
import { estimateToolTokens } from '@/lib/tokens';
import {
  DESCRIPTION_CAP,
  PROPERTY_DESCRIPTION_CAP,
  clampProse,
  describeWithheldTools,
  selectTools,
  slimSchema,
  slimTool,
  toolCosts,
} from './tools';

const tool = (name: string, description = 'Does a thing.'): ToolDefinition => ({
  name,
  description,
  inputSchema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
});

describe('clampProse', () => {
  it('collapses whitespace and leaves short prose alone', () => {
    expect(clampProse('  Reads   a\n\nfile.  ', 100)).toBe('Reads a file.');
  });

  it('cuts at a sentence boundary rather than mid-clause', () => {
    const text = `${'A'.repeat(60)}. ${'B'.repeat(200)}. ${'C'.repeat(200)}.`;
    const cut = clampProse(text, 120);
    expect(cut).toBe(`${'A'.repeat(60)}.`);
    expect(cut).not.toContain('C');
  });

  it('falls back to a word boundary with an ellipsis when there is no sentence end', () => {
    const cut = clampProse('word '.repeat(100), 50);
    expect(cut.endsWith('…')).toBe(true);
    expect(cut.length).toBeLessThanOrEqual(51);
  });
});

describe('slimSchema', () => {
  const schema = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    $id: 'urn:read-file',
    title: 'Read file input',
    description: `Arguments. ${'Background prose that no model reads. '.repeat(20)}`,
    type: 'object',
    required: ['path'],
    additionalProperties: false,
    properties: {
      path: {
        type: 'string',
        title: 'Path',
        examples: ['src/index.ts'],
        minLength: 1,
        description: `The path to read. ${'Extra guidance. '.repeat(30)}`,
      },
      mode: { type: 'string', enum: ['text', 'binary'], deprecated: false, $comment: 'legacy' },
      lines: { type: 'integer', minimum: 1, maximum: 5_000, readOnly: false },
      filter: { anyOf: [{ type: 'string' }, { type: 'null', title: 'None' }] },
    },
  };

  it('drops the decorative keys at every depth', () => {
    const slim = slimSchema(schema) as Record<string, unknown>;
    const json = JSON.stringify(slim);
    for (const key of ['$schema', '$id', '$comment', 'title', 'examples', 'deprecated', 'readOnly']) {
      expect(json).not.toContain(key);
    }
  });

  it('keeps everything semantic, which is the difference between a callable tool and a guess', () => {
    const slim = slimSchema(schema) as Record<string, unknown>;
    const properties = slim.properties as Record<string, Record<string, unknown>>;
    expect(slim.type).toBe('object');
    expect(slim.required).toEqual(['path']);
    expect(slim.additionalProperties).toBe(false);
    expect(properties.mode?.enum).toEqual(['text', 'binary']);
    expect(properties.lines?.minimum).toBe(1);
    expect(properties.lines?.maximum).toBe(5_000);
    expect(properties.path?.minLength).toBe(1);
    expect(Array.isArray(properties.filter?.anyOf)).toBe(true);
  });

  it('clamps property descriptions to the tighter cap, since there are many of them', () => {
    const slim = slimSchema(schema) as Record<string, unknown>;
    const properties = slim.properties as Record<string, Record<string, unknown>>;
    expect(String(properties.path?.description).length).toBeLessThanOrEqual(PROPERTY_DESCRIPTION_CAP);
    expect(String(properties.path?.description)).toContain('The path to read.');
  });

  it('leaves prose alone when only decoration is meant to go', () => {
    const slim = slimSchema(schema, { trimDescriptions: false }) as Record<string, unknown>;
    const properties = slim.properties as Record<string, Record<string, unknown>>;
    expect(String(properties.path?.description).length).toBeGreaterThan(PROPERTY_DESCRIPTION_CAP);
    expect(JSON.stringify(slim)).not.toContain('$schema');
  });

  it('is measurably cheaper than the original', () => {
    const original: ToolDefinition = { name: 'read_file', description: 'Reads a file.', inputSchema: schema };
    const slim = slimTool(original);
    expect(estimateToolTokens(slim)).toBeLessThan(estimateToolTokens(original) * 0.75);
  });

  it('passes primitives and arrays through untouched', () => {
    expect(slimSchema(null)).toBeNull();
    expect(slimSchema(7)).toBe(7);
    expect(slimSchema(['a', { title: 'x', type: 'string' }])).toEqual(['a', { type: 'string' }]);
  });
});

describe('slimTool', () => {
  it('clamps the tool description and does not mutate the input', () => {
    const verbose = tool('read_file', `First sentence. ${'Filler sentence. '.repeat(60)}`);
    const before = JSON.stringify(verbose);
    const slim = slimTool(verbose);
    expect(slim.description.length).toBeLessThanOrEqual(DESCRIPTION_CAP);
    expect(JSON.stringify(verbose)).toBe(before);
  });
});

describe('toolCosts', () => {
  it('lists the most expensive first, ties broken by name', () => {
    const costs = toolCosts([tool('cheap'), tool('expensive', 'x'.repeat(4_000)), tool('also_cheap')]);
    expect(costs[0]?.name).toBe('expensive');
    expect(costs[1]?.name).toBe('also_cheap');
    expect(costs[0]?.tokens).toBeGreaterThan(costs[1]?.tokens ?? 0);
  });
});

describe('selectTools', () => {
  const a = tool('alpha');
  const b = tool('bravo');
  const c = tool('charlie');
  const each = estimateToolTokens(a);

  it('keeps everything when the budget allows', () => {
    const selection = selectTools({ tools: [a, b, c], budget: 100_000 });
    expect(selection.tools.map((t) => t.name)).toEqual(['alpha', 'bravo', 'charlie']);
    expect(selection.withheld).toEqual([]);
    expect(selection.tokens).toBeGreaterThan(0);
  });

  it('prefers recently used tools when the budget does not', () => {
    const selection = selectTools({ tools: [a, b, c], budget: each * 2, recent: ['charlie'] });
    expect(selection.tools.map((t) => t.name)).toContain('charlie');
    expect(selection.withheld).toEqual(['bravo']);
  });

  it("emits in the caller's original order, so the cached tools block does not churn", () => {
    // charlie is ranked first for *inclusion* and still emitted last.
    const selection = selectTools({ tools: [a, b, c], budget: each * 2, recent: ['charlie'] });
    expect(selection.tools.map((t) => t.name)).toEqual(['alpha', 'charlie']);
  });

  it('keeps required tools whatever the budget says', () => {
    const selection = selectTools({ tools: [a, b, c], budget: 1, required: ['bravo'] });
    expect(selection.tools.map((t) => t.name)).toEqual(['bravo']);
    expect(selection.withheld).toEqual(['alpha', 'charlie']);
    expect(selection.tokens).toBeGreaterThan(1);
  });

  it('reports withheld names alphabetically, for a stable sentence', () => {
    const selection = selectTools({ tools: [c, b, a], budget: 1 });
    expect(selection.withheld).toEqual(['alpha', 'bravo', 'charlie']);
  });

  it('reports what slimming alone saved, before anything was withheld', () => {
    const verbose = tool('verbose', `First. ${'Filler sentence here. '.repeat(80)}`);
    const selection = selectTools({ tools: [verbose], budget: 100_000 });
    expect(selection.slimmed).toBeGreaterThan(0);
    expect(selection.tools[0]?.description.length).toBeLessThanOrEqual(DESCRIPTION_CAP);
  });

  it('can be asked not to slim at all', () => {
    const verbose = tool('verbose', `First. ${'Filler sentence here. '.repeat(80)}`);
    const selection = selectTools({ tools: [verbose], budget: 100_000, slim: false });
    expect(selection.slimmed).toBe(0);
    expect(selection.tools[0]).toBe(verbose);
  });

  it('handles an empty manifest', () => {
    expect(selectTools({ tools: [], budget: 1_000 })).toEqual({ tools: [], withheld: [], tokens: 0, slimmed: 0 });
  });
});

describe('describeWithheldTools', () => {
  it('says nothing when nothing was withheld, keeping the prefix byte-identical', () => {
    expect(describeWithheldTools([])).toBe('');
  });

  it('names them, because a model that cannot see a tool invents a workaround', () => {
    const text = describeWithheldTools(['alpha', 'bravo']);
    expect(text).toContain('`alpha`');
    expect(text).toContain('`bravo`');
    expect(text).toContain('Do not attempt to call them');
  });
});
