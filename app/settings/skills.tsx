/**
 * Skills.
 *
 * Write, import, edit, duplicate and delete the instruction sets a conversation can
 * switch on. The editor is inline rather than a second route: three fields do not
 * warrant a screen of their own, and keeping the list and the form in one file means
 * the "name is taken" message lands next to the field that caused it.
 *
 * The list shows the description, because the description is the only part the model
 * ever sees unasked — a skill that never fires usually has a description that does
 * not say when to use it, and that is only diagnosable if it is on screen.
 */

import { useCallback, useState } from 'react';
import { Alert, Share, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { Directory, File } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';

import { Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Body, Button, Empty, Field, Inline, Note, Row, Screen, Section, SkeletonRows } from '@/components/ui';
import {
  MAX_SKILL_BODY_CHARS,
  MAX_SKILL_DESCRIPTION_CHARS,
  serialiseSkill,
  skillFileName,
  slugifySkillName,
} from '@/chat/skill';
import type { Skill, SkillDraft } from '@/chat/skill';
import { packSkills, skillsZipName } from '@/chat/skillZip';
import { log } from '@/lib/log';
import { useSkills } from '@/stores/skills';
import { useTheme } from '@/theme';

const BLANK: SkillDraft = { name: '', description: '', body: '' };

export default function SkillsScreen() {
  const t = useTheme();
  const skills = useSkills((s) => s.skills);
  const loaded = useSkills((s) => s.loaded);
  const load = useSkills((s) => s.load);

  const [menuFor, setMenuFor] = useState<Skill | null>(null);
  /** The id being edited, `'new'` while adding, `null` when the list is showing. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<SkillDraft>(BLANK);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openEditor = (skill: Skill | null): void => {
    setDraft(skill ? { name: skill.name, description: skill.description, body: skill.body } : BLANK);
    setProblem(null);
    setEditing(skill ? skill.id : 'new');
  };

  const submit = async (): Promise<void> => {
    const result = editing === 'new' ? await useSkills.getState().create(draft) : await useSkills.getState().save(editing ?? '', draft);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setEditing(null);
    setOutcome(editing === 'new' ? `Saved “${slugifySkillName(draft.name)}”.` : 'Saved.');
  };

  const importSkill = async (): Promise<void> => {
    // `text/*` rather than a wildcard: a `SKILL.md` is Markdown, and offering every
    // file only means refusing most of them a tap later.
    const picked = await DocumentPicker.getDocumentAsync({ type: ['text/*'], copyToCacheDirectory: true });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    try {
      const text = await new File(asset.uri).text();
      const result = await useSkills.getState().importFile(text);
      setOutcome(result.ok ? `Imported “${result.skill.name}”.` : result.reason);
    } catch (error) {
      log.warn('skills', 'could not read the picked file', error);
      setOutcome('That file could not be read from storage.');
    }
  };

  /**
   * Every skill into one zip, in a folder the user picks.
   *
   * Not the share sheet, unlike a single skill: Android's share intent carries text
   * through a Binder parcel, and there is no way to hand it bytes. A folder picked
   * through the system picker is the one path that does not need a new dependency,
   * and "Downloads" is what a user means by "save it" anyway.
   */
  const exportAll = async (): Promise<void> => {
    if (!skills.length) return;
    let folder: Directory;
    try {
      folder = await Directory.pickDirectoryAsync();
    } catch {
      return; // Dismissed the picker. Not an error, and not worth a message.
    }
    try {
      const file = folder.createFile(skillsZipName(), 'application/zip');
      file.write(packSkills(skills));
      setOutcome(`Wrote ${skills.length} skill${skills.length === 1 ? '' : 's'} to ${file.name}.`);
    } catch (error) {
      log.warn('skills', 'could not write the archive', error);
      setOutcome('That folder could not be written to. Pick another one, or try Downloads.');
    }
  };

  const importZip = async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({
      // Android hands a zip either MIME depending on where it came from.
      type: ['application/zip', 'application/octet-stream'],
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    try {
      const bytes = await new File(asset.uri).bytes();
      const { added, skipped } = await useSkills.getState().importZip(bytes);
      const tail = skipped.length ? ` ${skipped.length} file${skipped.length === 1 ? '' : 's'} skipped: ${skipped[0]}` : '';
      setOutcome(added.length ? `Imported ${added.length}: ${added.join(', ')}.${tail}` : `Nothing imported.${tail}`);
    } catch (error) {
      log.warn('skills', 'could not read the picked archive', error);
      setOutcome('That file could not be read from storage.');
    }
  };

  const remove = (skill: Skill): void => {    Alert.alert('Delete skill', `Delete “${skill.name}”? Conversations using it will simply stop seeing it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void useSkills.getState().remove(skill.id);
        },
      },
    ]);
  };

  const menuActions = (skill: Skill): SheetAction[] => [
    {
      label: 'Edit',
      onPress: () => {
        openEditor(skill);
        setMenuFor(null);
      },
    },
    {
      label: 'Duplicate',
      subtitle: 'A copy under a free name, to edit without losing this one',
      onPress: () => {
        void useSkills.getState().duplicate(skill.id);
        setMenuFor(null);
      },
    },
    {
      label: 'Export',
      subtitle: `${skillFileName(skill)} through the share sheet`,
      onPress: () => {
        void Share.share({ message: serialiseSkill(skill), title: skillFileName(skill) });
        setMenuFor(null);
      },
    },
    {
      label: 'Delete',
      destructive: true,
      onPress: () => {
        remove(skill);
        setMenuFor(null);
      },
    },
  ];

  if (editing !== null) {
    return (
      <Screen>
        <Section title={editing === 'new' ? 'New skill' : 'Edit skill'}>
          <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
            <Field
              label="Name"
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder="pdf-processing"
              hint="Lowercase, digits and hyphens. The model types this back to load the skill."
            />
            <Field
              label="Description"
              value={draft.description}
              onChangeText={(description) => setDraft((d) => ({ ...d, description }))}
              placeholder="Extracts text and tables from a PDF."
              rows={2}
              hint={`When to use it — this is all the model sees before it decides. Up to ${MAX_SKILL_DESCRIPTION_CHARS} characters.`}
            />
            <Field
              label="Instructions"
              value={draft.body}
              onChangeText={(body) => setDraft((d) => ({ ...d, body }))}
              rows={12}
              mono
              placeholder={'# Steps\n\n1. …'}
              hint={`Markdown. Sent only when the model asks for it. Up to ${MAX_SKILL_BODY_CHARS.toLocaleString()} characters.`}
              {...(problem ? { error: problem } : {})}
            />
          </View>
        </Section>

        <Inline gap="md">
          <Button label="Save" onPress={() => void submit()} />
          <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
        </Inline>
      </Screen>
    );
  }

  return (
    <Screen>
      <Section
        title={`Skills (${skills.length})`}
        note={
          'A skill is a set of instructions with a name and a one-line description. Conversations switch them on ' +
          'individually. Only the names and descriptions go into the prompt — the instructions are sent when the ' +
          'model asks for them, so several skills cost a couple of lines a turn rather than several pages.'
        }
      >
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}>
            <SkeletonRows count={4} label="Loading your skills" />
          </View>
        ) : skills.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty icon="skills" title="No skills yet" body="Write one, or import a SKILL.md you already have." />
          </View>
        ) : (
          skills.map((skill, index) => (
            <Row
              key={skill.id}
              first={index === 0}
              label={skill.name}
              subtitle={skill.description}
              onPress={() => setMenuFor(skill)}
              accessibilityHint="Opens edit, duplicate, export and delete"
            />
          ))
        )}
      </Section>

      {outcome ? <Note tone="success">{outcome}</Note> : null}

      <Inline gap="md">
        <Button label="New skill" size="sm" onPress={() => openEditor(null)} />
        <Button label="Import a SKILL.md" size="sm" variant="ghost" onPress={() => void importSkill()} />
      </Inline>

      <Inline gap="md">
        <Button label="Import a zip" size="sm" variant="ghost" onPress={() => void importZip()} />
        {skills.length ? (
          <Button label="Export all as zip" size="sm" variant="ghost" onPress={() => void exportAll()} />
        ) : null}
      </Inline>

      <Body tone="dim" size="sm">
        Importing a skill runs somebody else’s instructions in your conversations — the same trust decision as
        pasting them into the composer. Read one before switching it on.
      </Body>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.name ?? ''}
        {...(menuFor ? { subtitle: menuFor.description } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </Screen>
  );
}
