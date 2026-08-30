/**
 * A folder of skills as one file.
 *
 * Exporting one skill is the share sheet and a string. Exporting fourteen that way
 * is fourteen taps, and importing them back is fourteen more — which is how a
 * feature people would use monthly becomes one they use never. A zip is the format
 * every phone, desktop and mail client already understands, so it needs no reader
 * on the other end.
 *
 * `fflate` is already a dependency and its sync API is the whole of what is needed:
 * skills are a few tens of kilobytes of text, so streaming buys nothing and costs a
 * callback.
 *
 * What this module does *not* do is trust the archive. A zip is arbitrary bytes off
 * the filesystem: entry names can carry `../`, the archive can be a hundred
 * thousand entries or a gigabyte of decompressed text, and every member still has
 * to survive {@link parseSkill}. All four of those are bounded here rather than at
 * the call site.
 */

import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';

import { serialiseSkill, skillFileName } from '@/chat/skill';
import type { SkillDraft } from '@/chat/skill';

/**
 * Most members an archive may have.
 *
 * Not a guess at how many skills a person owns — it is the zip-bomb bound. A
 * hostile archive is a handful of bytes per entry, so the cost of "just try them
 * all" is paid in wall clock on the main thread.
 */
export const MAX_ZIP_ENTRIES = 200;

/** Most decompressed text to read out of one archive, across all members. */
export const MAX_ZIP_TEXT_BYTES = 8 * 1024 * 1024;

/** The name a bulk export gets. Dated, because the second one wants a different name. */
export function skillsZipName(at: Date = new Date()): string {
  const stamp = at.toISOString().slice(0, 10);
  return `skills-${stamp}.zip`;
}

/**
 * Every skill as a `SKILL.md` inside one archive.
 *
 * Round-trips through {@link unpackSkills}: the members are exactly the files a
 * single export produces, so an archive can be unzipped by hand and the pieces
 * imported one at a time.
 */
export function packSkills(skills: readonly SkillDraft[]): Uint8Array {
  const files: Record<string, Uint8Array> = {};
  const used = new Set<string>();
  for (const skill of skills) {
    // Two skills cannot share a name in the database, but an export of a list that
    // came from somewhere else could — and a duplicate key would silently drop one.
    let name = skillFileName(skill);
    for (let n = 2; used.has(name); n += 1) name = `${skill.name || 'skill'}-${n}.SKILL.md`;
    used.add(name);
    files[name] = strToU8(serialiseSkill(skill));
  }
  // level 6: text compresses to a fifth either way, and 9 is measurably slower on a
  // phone for a file nobody notices the size of.
  return zipSync(files, { level: 6 });
}

export interface UnpackedSkills {
  /** The file text of each member that looks like a skill, in archive order. */
  files: string[];
  /** Members skipped, with why — shown as a count so a partial import is not silent. */
  skipped: string[];
}

/**
 * The `SKILL.md` members of an archive, as text.
 *
 * Parsing is left to {@link parseSkill} through the store, so a member that is not a
 * skill fails the same way a single bad import does — with a reason, per file, and
 * without taking the rest of the archive down with it.
 */
export function unpackSkills(bytes: Uint8Array): UnpackedSkills {
  const files: string[] = [];
  const skipped: string[] = [];

  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(bytes);
  } catch (error) {
    return { files: [], skipped: [`That file is not a readable zip: ${error instanceof Error ? error.message : 'unknown'}`] };
  }

  let budget = MAX_ZIP_TEXT_BYTES;
  let seen = 0;
  for (const [name, data] of Object.entries(entries)) {
    if ((seen += 1) > MAX_ZIP_ENTRIES) {
      skipped.push(`Stopped after ${MAX_ZIP_ENTRIES} files.`);
      break;
    }
    // Directory entries, macOS resource forks, and anything that is not text.
    if (name.endsWith('/') || name.startsWith('__MACOSX/') || name.split('/').pop()?.startsWith('.')) continue;
    if (!/\.(?:md|markdown|txt)$/i.test(name)) {
      skipped.push(`${name}: not a Markdown file.`);
      continue;
    }
    if (data.length > budget) {
      skipped.push(`${name}: the archive is larger than ${Math.round(MAX_ZIP_TEXT_BYTES / 1024 / 1024)} MB of text.`);
      break;
    }
    budget -= data.length;
    files.push(strFromU8(data));
  }

  return { files, skipped };
}
