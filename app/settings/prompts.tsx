/**
 * The prompt library.
 *
 * List, write and edit templates. Inserting one happens in the chat screen, because
 * that is where the draft is; this screen is the editor and the ranking made visible.
 *
 * The inline editor is the same trade as the skills screen: two fields do not warrant
 * a route, and the validation message belongs next to the field.
 */

import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Body, Button, Empty, Field, Inline, Note, Row, Screen, Section, SkeletonRows } from '@/components/ui';
import { MAX_PROMPT_CHARS, variablesIn } from '@/chat/prompts';
import type { Prompt, PromptDraft } from '@/chat/prompts';
import * as haptics from '@/lib/haptics';
import { usePrompts } from '@/stores/prompts';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';

const BLANK: PromptDraft = { title: '', body: '' };

export default function PromptsScreen() {
  const t = useTheme();
  const prompts = usePrompts((s) => s.prompts);
  const loaded = usePrompts((s) => s.loaded);
  const load = usePrompts((s) => s.load);

  const [menuFor, setMenuFor] = useState<Prompt | null>(null);
  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<PromptDraft>(BLANK);
  const [problem, setProblem] = useState<string | null>(null);

  // Held locally and committed on blur rather than on every keystroke: the settings
  // store persists to AsyncStorage on change, and a multi-line prompt would be one
  // write per character.
  const defaultSystemPrompt = useSettings((s) => s.defaultSystemPrompt);
  const setSetting = useSettings((s) => s.set);
  const [systemDraft, setSystemDraft] = useState(defaultSystemPrompt);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const openEditor = (prompt: Prompt | null): void => {
    setDraft(prompt ? { title: prompt.title, body: prompt.body } : BLANK);
    setProblem(null);
    setEditing(prompt ? prompt.id : 'new');
  };

  const submit = async (): Promise<void> => {
    if (editing === null) return;
    const result =
      editing === 'new' ? await usePrompts.getState().create(draft) : await usePrompts.getState().save(editing, draft);
    if (!result.ok) {
      setProblem(result.reason);
      return;
    }
    setEditing(null);
  };

  const remove = (prompt: Prompt): void => {
    Alert.alert('Delete prompt', `Delete “${prompt.title}”?`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          haptics.warn();
          void usePrompts.getState().remove(prompt.id);
        },
      },
    ]);
  };

  const menuActions = (prompt: Prompt): SheetAction[] => [
    { label: 'Edit', onPress: () => { openEditor(prompt); setMenuFor(null); } },
    { label: 'Delete', destructive: true, onPress: () => { remove(prompt); setMenuFor(null); } },
  ];

  if (editing !== null) {
    const variables = variablesIn(draft.body);
    return (
      <Screen>
        <Section title={editing === 'new' ? 'New prompt' : 'Edit prompt'}>
          <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
            <Field
              label="Title"
              value={draft.title}
              onChangeText={(title) => setDraft((d) => ({ ...d, title }))}
              placeholder="Review a diff"
            />
            <Field
              label="Template"
              value={draft.body}
              onChangeText={(body) => setDraft((d) => ({ ...d, body }))}
              rows={10}
              mono
              placeholder={'Review {{diff}} for {{concern}}, and say what you would change first.'}
              hint={`Write {{a name}} where you want to fill something in. Up to ${MAX_PROMPT_CHARS.toLocaleString()} characters.`}
              {...(problem ? { error: problem } : {})}
            />
            {variables.length ? (
              <Note tone="info">Fills in: {variables.join(', ')}</Note>
            ) : (
              <Body tone="dim" size="sm">
                No variables yet — this will be inserted as written.
              </Body>
            )}
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
        title="Default system prompt"
        note={
          'Copied into every new conversation, where it stays editable. Changing it here leaves conversations ' +
          'that already exist alone.'
        }
      >
        <View style={{ padding: t.spacing.md }}>
          <Field
            label="Given to new conversations"
            value={systemDraft}
            onChangeText={setSystemDraft}
            onBlur={() => setSetting('defaultSystemPrompt', systemDraft)}
            rows={5}
            placeholder="Leave empty for none."
            hint="Saved when you tap away."
          />
        </View>
      </Section>

      <Section
        title={`Prompts (${prompts.length})`}
        note={
          'Templates you insert into the composer. The ones you use most float to the top. Insert them from a ' +
          'conversation’s menu — this is where they are written.'
        }
      >
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}>
            <SkeletonRows count={4} label="Loading your prompts" />
          </View>
        ) : prompts.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty icon="prompts" title="No prompts yet" body="Write one, with {{variables}} for the parts that change." />
          </View>
        ) : (
          prompts.map((prompt, index) => (
            <Row
              key={prompt.id}
              first={index === 0}
              label={prompt.title}
              value={prompt.uses ? `${prompt.uses}×` : undefined}
              subtitle={summarise(prompt)}
              onPress={() => setMenuFor(prompt)}
              accessibilityHint="Opens edit and delete"
            />
          ))
        )}
      </Section>

      <Inline gap="md">
        <Button label="New prompt" size="sm" onPress={() => openEditor(null)} />
      </Inline>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.title ?? ''}
        {...(menuFor ? { subtitle: summarise(menuFor) } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </Screen>
  );
}

function summarise(prompt: Prompt): string {
  const variables = variablesIn(prompt.body);
  const first = prompt.body.replace(/\s+/g, ' ').slice(0, 80);
  return variables.length ? `${first} · fills in ${variables.join(', ')}` : first;
}
