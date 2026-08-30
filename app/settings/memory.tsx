/**
 * Memory.
 *
 * What the app has learned about the user, with the switch that stops it learning
 * and the button that deletes the lot.
 *
 * The whole screen exists because the feature is otherwise invisible: memories are
 * written by a background pass and spent inside a system prompt the user never
 * sees. A feature that silently accumulates statements about someone and replays
 * them into every future request has to be inspectable, correctable and
 * destroyable, or it is just a hidden profile. So every memory is listed verbatim,
 * every one can be edited or deleted individually, and "Forget everything" is one
 * tap and one confirmation away rather than buried.
 */

import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { PromptSheet, Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Badge, Button, Empty, Inline, Note, Row, Screen, Section, Spinner, SwitchRow } from '@/components/ui';
import { MEMORY_BUDGET_CHARS, MEMORY_KINDS, approvedOnly, renderMemoryBlock } from '@/chat/memory';
import type { Memory, MemoryKind } from '@/chat/memory';
import { useMemory } from '@/stores/memory';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';

const KIND_LABEL: Record<MemoryKind, string> = {
  preference: 'preference',
  fact: 'fact',
  project: 'project',
  style: 'style',
};

export default function MemoryScreen() {
  const t = useTheme();
  const enabled = useSettings((s) => s.memoryEnabled);
  const setSetting = useSettings((s) => s.set);

  const memories = useMemory((s) => s.memories);
  const loaded = useMemory((s) => s.loaded);
  const distilling = useMemory((s) => s.distilling);
  const load = useMemory((s) => s.load);

  const [menuFor, setMenuFor] = useState<Memory | null>(null);
  const [reviewing, setReviewing] = useState<Memory | null>(null);
  const [editing, setEditing] = useState<Memory | null>(null);
  const [adding, setAdding] = useState(false);
  const [outcome, setOutcome] = useState<string | null>(null);

  // Reloaded on focus rather than on mount: a distillation pass triggered by the
  // conversation the user just came back from will have written rows since.
  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  // What a request would actually carry, computed from the same function the
  // request builder uses — so the number on this screen cannot drift from the
  // number being spent. `approvedOnly` for the same reason: pending memories cost
  // nothing because they are not sent.
  const pending = memories.filter((memory) => !memory.approved);
  const kept = approvedOnly(memories);
  const block = renderMemoryBlock(kept);
  const share = Math.round((block.chars / MEMORY_BUDGET_CHARS) * 100);

  const menuActions = (memory: Memory): SheetAction[] => [
    {
      label: memory.pinned ? 'Unpin' : 'Pin',
      subtitle: memory.pinned
        ? 'Lets the budget drop this one again'
        : 'Keeps this one in the prompt even when the budget is full',
      onPress: () => {
        void useMemory.getState().setPinned(memory.id, !memory.pinned);
        setMenuFor(null);
      },
    },
    {
      label: 'Edit',
      onPress: () => {
        setEditing(memory);
        setMenuFor(null);
      },
    },
    {
      label: 'Forget this',
      destructive: true,
      onPress: () => {
        void useMemory.getState().forget(memory.id);
        setMenuFor(null);
      },
    },
  ];

  /** Keep / edit / discard, for a memory the user has not agreed to yet. */
  const reviewActions = (memory: Memory): SheetAction[] => [
    {
      label: 'Keep it',
      subtitle: 'Starts carrying this into new conversations',
      onPress: () => {
        void useMemory.getState().approve(memory.id);
        setReviewing(null);
      },
    },
    {
      label: 'Edit, then keep',
      onPress: () => {
        setEditing(memory);
        setReviewing(null);
      },
    },
    {
      label: 'Discard',
      destructive: true,
      onPress: () => {
        void useMemory.getState().forget(memory.id);
        setReviewing(null);
      },
    },
  ];

  const forgetEverything = (): void => {
    Alert.alert(
      'Forget everything',
      `Delete all ${memories.length} memor${memories.length === 1 ? 'y' : 'ies'}? Conversations are not affected, ` +
        'and this cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Forget everything',
          style: 'destructive',
          onPress: () => {
            void useMemory
              .getState()
              .forgetEverything()
              .then((removed) => setOutcome(`Forgot ${removed} memor${removed === 1 ? 'y' : 'ies'}.`));
          },
        },
      ],
    );
  };

  return (
    <Screen>
      <Section
        title="Memory"
        note={
          'When this is on, the app occasionally asks the model what it learned about you that would still be true ' +
          'in a different conversation, and carries those notes into every later chat. Turning it off stops both ' +
          'halves — nothing is collected and nothing is sent — but keeps what is already here.'
        }
      >
        <SwitchRow
          first
          label="Remember things about me"
          subtitle="Carries preferences and facts into new conversations"
          value={enabled}
          onChange={(v) => setSetting('memoryEnabled', v)}
        />
        <Row
          label="Prompt cost"
          value={block.text ? `${block.chars} chars · ${share}% of budget` : 'Nothing sent'}
          subtitle={
            block.dropped > 0
              ? `${block.dropped} memor${block.dropped === 1 ? 'y' : 'ies'} do not fit the budget and are left out. Pin the ones that matter.`
              : 'Added to the system prompt of every conversation while memory is on.'
          }
        />
      </Section>

      {outcome ? <Note tone="success">{outcome}</Note> : null}
      {distilling ? (
        <View style={{ paddingBottom: t.spacing.md }}>
          <Spinner label="Working out what to remember" />
        </View>
      ) : null}

      {pending.length ? (
        <Section
          title={`Waiting for you (${pending.length})`}
          note={
            'The model wrote these; nothing is sent until you keep it. A note it picked up from something you pasted ' +
            'or attached would otherwise become a standing instruction in every later conversation.'
          }
        >
          {pending.map((memory, index) => (
            <Row
              key={memory.id}
              first={index === 0}
              label={memory.text}
              subtitle={subtitleFor(memory)}
              right={<Badge label="not sent" tone="warning" />}
              onPress={() => setReviewing(memory)}
              accessibilityLabel={`Pending ${KIND_LABEL[memory.kind]}: ${memory.text}`}
              accessibilityHint="Opens keep, edit and discard"
            />
          ))}
        </Section>
      ) : null}

      <Section title={`Remembered (${kept.length})`}>
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}>
            <Spinner label="Loading" />
          </View>
        ) : kept.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty
              title="Nothing remembered yet"
              body="Keep chatting and durable preferences will collect here, or add one yourself."
            />
          </View>
        ) : (
          kept.map((memory, index) => (
            <Row
              key={memory.id}
              first={index === 0}
              label={memory.text}
              subtitle={subtitleFor(memory)}
              right={memory.pinned ? <Badge label="pinned" tone="neutral" /> : undefined}
              onPress={() => setMenuFor(memory)}
              accessibilityLabel={`${KIND_LABEL[memory.kind]}: ${memory.text}`}
              accessibilityHint="Opens pin, edit and forget"
            />
          ))
        )}
      </Section>

      <Inline gap="md">
        <Button label="Add a memory" size="sm" onPress={() => setAdding(true)} />
        {memories.length ? (
          <Button label="Forget everything" size="sm" variant="danger" onPress={forgetEverything} />
        ) : null}
      </Inline>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.text ?? ''}
        {...(menuFor ? { subtitle: subtitleFor(menuFor) } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />

      <Sheet
        visible={reviewing !== null}
        title={reviewing?.text ?? ''}
        {...(reviewing ? { subtitle: subtitleFor(reviewing) } : {})}
        actions={reviewing ? reviewActions(reviewing) : []}
        onClose={() => setReviewing(null)}
      />

      {editing ? (
        <PromptSheet
          visible
          title="Edit memory"
          hint="One sentence, in the third person."
          initial={editing.text}
          onCancel={() => setEditing(null)}
          onConfirm={(text) => {
            void useMemory.getState().edit(editing.id, text);
            // Editing a pending memory is the user taking ownership of the sentence,
            // which is the same act as keeping it — asking twice would be theatre.
            if (!editing.approved) void useMemory.getState().approve(editing.id);
            setEditing(null);
          }}
        />
      ) : null}

      {adding ? (
        <PromptSheet
          visible
          title="Add a memory"
          hint="One sentence, in the third person — “prefers TypeScript over JavaScript”."
          placeholder="prefers short answers"
          initial=""
          onCancel={() => setAdding(false)}
          onConfirm={(text) => {
            void useMemory.getState().add(text);
            setAdding(false);
          }}
        />
      ) : null}
    </Screen>
  );
}

/**
 * The provenance line under a memory.
 *
 * `hits` is shown because it is the only reason one memory outranks another when
 * the budget is tight, and a ranking the user cannot see is a ranking they cannot
 * correct.
 */
function subtitleFor(memory: Memory): string {
  const parts: string[] = [KIND_LABEL[memory.kind]];
  if (memory.hits > 1) parts.push(`said ${memory.hits} times`);
  parts.push(`learned ${new Date(memory.createdAt).toLocaleDateString()}`);
  if (memory.lastUsedAt) parts.push(`last used ${new Date(memory.lastUsedAt).toLocaleDateString()}`);
  return parts.join(' · ');
}

/** Kept exported-adjacent for the type checker: every kind has a label. */
void MEMORY_KINDS;
