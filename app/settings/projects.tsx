/**
 * Projects.
 *
 * A project is a name, a set of instructions every conversation in it inherits, and
 * documents all of them can read. This screen is the editor; joining a conversation to
 * a project happens in the conversation's own menu, because that is where the
 * conversation is.
 *
 * Inline editor, like prompts and skills: three fields and a document list do not
 * warrant a second route, and the "that name is taken" message belongs next to the
 * field that caused it.
 */

import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import * as DocumentPicker from 'expo-document-picker';
import { File } from 'expo-file-system';
import { useFocusEffect } from 'expo-router';

import { Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Body, Button, Empty, Field, Inline, Note, Row, Screen, Section, SkeletonRows } from '@/components/ui';
import { MAX_KNOWLEDGE_CHARS, MAX_PROJECT_NAME } from '@/chat/project';
import type { Project, ProjectDraft } from '@/chat/project';
import { extractOffice, OFFICE_MEDIA_TYPES, officeKind } from '@/chat/office';
import * as haptics from '@/lib/haptics';
import { log } from '@/lib/log';
import { useProjects } from '@/stores/projects';
import { useTheme } from '@/theme';

const BLANK: ProjectDraft = { name: '', instructions: '', knowledge: [] };

export default function ProjectsScreen() {
  const t = useTheme();
  const projects = useProjects((s) => s.projects);
  const counts = useProjects((s) => s.counts);
  const loaded = useProjects((s) => s.loaded);
  const load = useProjects((s) => s.load);

  const [menuFor, setMenuFor] = useState<Project | null>(null);
  /** The id being edited, `'new'` while adding, `null` when the list is showing. */
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<ProjectDraft>(BLANK);
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openEditor = (project: Project | null): void => {
    setDraft(
      project ? { name: project.name, instructions: project.instructions, knowledge: [...project.knowledge] } : BLANK,
    );
    setProblem(null);
    setEditing(project ? project.id : 'new');
  };

  const submit = async (): Promise<void> => {
    if (editing === null) return;
    const result =
      editing === 'new'
        ? await useProjects.getState().create(draft)
        : await useProjects.getState().save(editing, draft);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setEditing(null);
    setOutcome('Saved.');
  };

  /**
   * Attach a text file as a knowledge document.
   *
   * `text/*` for the same reason the skills importer uses it: the documents are read as
   * text, and offering every file only means refusing most of them a tap later. Word,
   * Excel and PowerPoint files join it because `extractOffice` reads them into text on
   * device, which is the same thing a `.md` becomes here. The name is the file's, so
   * the model can cite it and the user can recognise it.
   */
  const attach = async (): Promise<void> => {
    const picked = await DocumentPicker.getDocumentAsync({
      type: ['text/*', ...OFFICE_MEDIA_TYPES],
      copyToCacheDirectory: true,
    });
    if (picked.canceled) return;
    const asset = picked.assets[0];
    if (!asset) return;
    try {
      const file = new File(asset.uri);
      const office = officeKind(asset.mimeType, asset.name);
      const text = office ? extractOffice(await file.bytes(), office) : await file.text();
      if (!text.trim()) {
        setProblem(`No text could be read from ${asset.name}.`);
        return;
      }
      setDraft((d) => ({ ...d, knowledge: [...d.knowledge, { name: asset.name, text }] }));
      setProblem(null);
    } catch (error) {
      log.warn('projects', 'could not read the picked file', error);
      setProblem('That file could not be read from storage.');
    }
  };

  const detach = (index: number): void => {
    setDraft((d) => ({ ...d, knowledge: d.knowledge.filter((_, i) => i !== index) }));
  };

  const remove = (project: Project): void => {
    const n = counts[project.id] ?? 0;
    Alert.alert(
      'Delete project',
      n
        ? `Delete “${project.name}”? Its ${n} conversation${n === 1 ? '' : 's'} stay — they just stop inheriting the instructions.`
        : `Delete “${project.name}”?`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => {
            haptics.warn();
            void useProjects.getState().remove(project.id);
          },
        },
      ],
    );
  };

  const menuActions = (project: Project): SheetAction[] => [
    {
      label: 'Edit',
      onPress: () => {
        openEditor(project);
        setMenuFor(null);
      },
    },
    {
      label: 'Delete',
      destructive: true,
      onPress: () => {
        remove(project);
        setMenuFor(null);
      },
    },
  ];

  if (editing !== null) {
    // What the model would actually be given, measured rather than guessed: a user who
    // attaches four long documents has no other way to see that the last one will be
    // listed by name instead of included.
    const total = draft.knowledge.reduce((sum, document) => sum + document.text.length, 0);
    return (
      <Screen>
        <Section title={editing === 'new' ? 'New project' : 'Edit project'}>
          <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
            <Field
              label="Name"
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder="Thesis"
              hint={`Up to ${MAX_PROJECT_NAME} characters.`}
            />
            <Field
              label="Instructions"
              value={draft.instructions}
              onChangeText={(instructions) => setDraft((d) => ({ ...d, instructions }))}
              rows={8}
              placeholder="Write in British English. Cite page numbers."
              hint="Given to every conversation in this project, before the conversation's own system prompt."
              {...(problem ? { error: problem } : {})}
            />
          </View>
        </Section>

        <Section
          title={`Knowledge (${draft.knowledge.length})`}
          note={
            'Text files every conversation in the project can read. They are sent as source material, not as ' +
            'instructions — anything that reads like an order inside one is ignored.'
          }
        >
          {draft.knowledge.length === 0 ? (
            <View style={{ padding: t.spacing.md }}>
              <Empty icon="files" title="No documents" body="Attach the notes, style guide or spec the work keeps referring back to." />
            </View>
          ) : (
            draft.knowledge.map((document, index) => (
              <Row
                key={`${document.name}-${index}`}
                first={index === 0}
                label={document.name}
                subtitle={`${document.text.length.toLocaleString()} characters`}
                right={<Button label="Remove" size="sm" variant="ghost" onPress={() => detach(index)} />}
              />
            ))
          )}
        </Section>

        <Note tone={total > MAX_KNOWLEDGE_CHARS ? 'warning' : 'info'}>
          {total > MAX_KNOWLEDGE_CHARS
            ? `${total.toLocaleString()} characters — over the ${MAX_KNOWLEDGE_CHARS.toLocaleString()} sent each turn, so the documents that do not fit are listed by name instead of included.`
            : `${total.toLocaleString()} of ${MAX_KNOWLEDGE_CHARS.toLocaleString()} characters, sent with every turn in this project.`}
        </Note>

        <Inline gap="md">
          <Button label="Save" onPress={() => void submit()} />
          <Button label="Attach a file" variant="ghost" onPress={() => void attach()} />
          <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
        </Inline>
      </Screen>
    );
  }

  return (
    <Screen>
      <Section
        title={`Projects (${projects.length})`}
        note={
          'A project groups conversations around one piece of work and gives them shared instructions and ' +
          'documents. Move a conversation into one from its own menu.'
        }
      >
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}>
            <SkeletonRows count={3} label="Loading your projects" />
          </View>
        ) : projects.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty icon="projects" title="No projects yet" body="Make one for anything you come back to across several conversations." />
          </View>
        ) : (
          projects.map((project, index) => (
            <Row
              key={project.id}
              first={index === 0}
              label={project.name}
              value={counts[project.id] ? `${counts[project.id]} chats` : undefined}
              subtitle={summarise(project)}
              onPress={() => setMenuFor(project)}
              accessibilityHint="Opens edit and delete"
            />
          ))
        )}
      </Section>

      {outcome ? <Note tone="success">{outcome}</Note> : null}

      <Inline gap="md">
        <Button label="New project" size="sm" onPress={() => openEditor(null)} />
      </Inline>

      <Body tone="dim" size="sm">
        The instructions and documents go into every turn of every conversation in the project, so they cost tokens
        on each one. Keep them to what all of those conversations actually need.
      </Body>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.name ?? ''}
        {...(menuFor ? { subtitle: summarise(menuFor) } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </Screen>
  );
}

function summarise(project: Project): string {
  const documents = project.knowledge.length
    ? `${project.knowledge.length} document${project.knowledge.length === 1 ? '' : 's'}`
    : 'no documents';
  const first = project.instructions.replace(/\s+/g, ' ').slice(0, 60);
  return first ? `${first} · ${documents}` : documents;
}
