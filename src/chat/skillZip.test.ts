/**
 * The archive layer, round-trip and hostile-input.
 *
 * The round trip is the feature. The rest of this file is the part that matters
 * more: an archive is arbitrary bytes off the filesystem, so the entry cap, the
 * decompressed-size cap, and the refusal to be fooled by a non-Markdown or
 * dot-prefixed member each get a test that fails if the bound is removed.
 */

import { parseSkill, serialiseSkill } from '@/chat/skill';
import type { SkillDraft } from '@/chat/skill';
import { MAX_ZIP_ENTRIES, packSkills, skillsZipName, unpackSkills } from '@/chat/skillZip';
import { strToU8, zipSync } from 'fflate';

function draft(name: string, body = '# Steps\n\n1. Do the thing.'): SkillDraft {
  return { name, description: `Handles ${name} work: colons, and commas.`, body };
}

/** `noUncheckedIndexedAccess`: index once, through a guard, rather than everywhere. */
function at<T>(items: readonly T[], index: number): T {
  const item = items[index];
  if (item === undefined) throw new Error(`nothing at ${index}`);
  return item;
}

describe('packing a folder of skills', () => {
  it('round-trips every skill through the archive', () => {
    const skills = [draft('pdf-processing'), draft('commit-messages'), draft('code-review')];
    const { files, skipped } = unpackSkills(packSkills(skills));

    expect(skipped).toEqual([]);
    expect(files).toHaveLength(3);
    const parsed = files.map((text) => parseSkill(text));
    expect(parsed.every((result) => result.ok)).toBe(true);
    const names = parsed.flatMap((result) => (result.ok ? [result.skill.name] : []));
    expect(names.sort()).toEqual(['code-review', 'commit-messages', 'pdf-processing']);
  });

  it('does not drop a skill when two would claim the same file name', () => {
    // Cannot happen from the database, can happen from a list that came from a
    // backup — and a duplicate object key would silently lose one.
    const { files } = unpackSkills(packSkills([draft('same'), draft('same', '# Other body')]));
    expect(files).toHaveLength(2);
  });

  it('names the export after the day it was made', () => {
    expect(skillsZipName(new Date('2026-08-30T11:00:00Z'))).toBe('skills-2026-08-30.zip');
  });
});

describe('unpacking something that is not a skill archive', () => {
  it('reports a reason rather than throwing on bytes that are not a zip', () => {
    const { files, skipped } = unpackSkills(strToU8('this is a text file, not an archive'));
    expect(files).toEqual([]);
    expect(at(skipped, 0)).toContain('not a readable zip');
  });

  it('skips members that are not Markdown, and says which', () => {
    const bytes = zipSync({
      'keep.SKILL.md': strToU8(serialiseSkill(draft('keep'))),
      'photo.png': strToU8('not really a png'),
      'nested/dir/': strToU8(''),
      '__MACOSX/._keep.SKILL.md': strToU8('resource fork'),
      '.DS_Store': strToU8('junk'),
    });
    const { files, skipped } = unpackSkills(bytes);
    expect(files).toHaveLength(1);
    // Only the png is worth reporting; the platform junk is not the user's doing.
    expect(skipped).toEqual(['photo.png: not a Markdown file.']);
  });

  it('stops at the entry cap rather than working through a zip bomb', () => {
    const many: Record<string, Uint8Array> = {};
    for (let i = 0; i < MAX_ZIP_ENTRIES + 50; i += 1) many[`skill-${i}.md`] = strToU8('x');
    const { files, skipped } = unpackSkills(zipSync(many));
    expect(files).toHaveLength(MAX_ZIP_ENTRIES);
    expect(at(skipped, 0)).toContain(`Stopped after ${MAX_ZIP_ENTRIES} files`);
  });

  it('stops before reading more text than the budget allows', () => {
    // One member that decompresses far past the cap: highly compressible, so the
    // archive itself is a few kilobytes. This is the zip bomb the cap is for.
    const bytes = zipSync({ 'huge.md': strToU8('a'.repeat(9 * 1024 * 1024)) }, { level: 9 });
    expect(bytes.length).toBeLessThan(256 * 1024);
    const { files, skipped } = unpackSkills(bytes);
    expect(files).toEqual([]);
    expect(at(skipped, 0)).toContain('MB of text');
  });

  it('leaves a member that parses badly to the parser, not to itself', () => {
    // `unpackSkills` hands back text; the reason a bad file is rejected comes from
    // `parseSkill`, so the two halves cannot disagree about what a skill is.
    const bytes = zipSync({ 'notes.md': strToU8('just some notes, no frontmatter') });
    const { files, skipped } = unpackSkills(bytes);
    expect(skipped).toEqual([]);
    expect(parseSkill(at(files, 0)).ok).toBe(false);
  });
});
