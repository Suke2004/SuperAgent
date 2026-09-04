import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useMemo, useState } from 'react';
import { Pressable, View } from 'react-native';

import { Badge, Body, Button, Empty, Field, Inline, Note, Row, Screen, Section, SkeletonRows } from '@/components/ui';
import { listTasks, completeTask } from '@/db/tasks';
import type { PersonalTask } from '@/db/tasks';
import { useMemory } from '@/stores/memory';
import { useProjects } from '@/stores/projects';
import { useTheme } from '@/theme';

const MAX_TODAY_TASKS = 5;

export default function JarvisScreen() {
  const router = useRouter();
  const t = useTheme();
  const allMemories = useMemory((state) => state.memories);
  const memories = useMemo(() => allMemories.filter((memory) => memory.approved), [allMemories]);
  const projects = useProjects((state) => state.projects);
  const [tasks, setTasks] = useState<PersonalTask[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setError(null);
    try {
      const open = await listTasks({ limit: MAX_TODAY_TASKS });
      setTasks(open);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setLoaded(true);
    }
  }, []);

  useFocusEffect(useCallback(() => {
    let active = true;
    void load().then(() => { if (!active) return; });
    return () => { active = false; };
  }, [load]));

  const ask = (): void => {
    const prompt = query.trim() || 'What should I focus on today?';
    router.push({ pathname: '/new', params: { q: prompt } });
  };

  const finish = async (task: PersonalTask): Promise<void> => {
    const changed = await completeTask(task.id);
    if (changed) setTasks((current) => current.filter((item) => item.id !== task.id));
  };

  const decisionMemories = memories
    .filter((memory) => /decision|avoid|keep|primary|prefer/i.test(memory.text))
    .slice(0, 3);

  return (
    <Screen>
      <View style={{ marginBottom: t.spacing.xl }}>
        <Inline gap="sm" style={{ marginTop: t.spacing.xs }}>
          <View style={{ width: 7, height: 7, borderRadius: 4, backgroundColor: t.colors.success, marginTop: 5 }} />
          <Body size="xs" tone="success">Ready · memory updated today</Body>
        </Inline>
      </View>

      <View style={{ marginBottom: t.spacing.xl }}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="What should I focus on today?"
          returnKeyType="send"
          onSubmitEditing={ask}
          right={<Pressable onPress={ask} accessibilityRole="button" accessibilityLabel="Ask Jarvis"><Body size="lg" tone="accent">↑</Body></Pressable>}
        />
      </View>

      {error ? <Note tone="warning" live>Could not load tasks. {error}</Note> : null}

      <Section title="Today">
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}><SkeletonRows count={3} label="Loading today's tasks" /></View>
        ) : tasks.length === 0 ? (
          <View style={{ padding: t.spacing.md }}><Empty icon="check" title="Nothing due" body="Ask Jarvis to turn a plan into a task." /></View>
        ) : tasks.map((task, index) => (
          <Row
            key={task.id}
            first={index === 0}
            label={task.title}
            subtitle={task.dueAt ? `Due ${new Date(task.dueAt).toLocaleString()}` : 'No due date'}
            right={<Button label="Done" size="sm" onPress={() => void finish(task)} />}
            accessibilityLabel={`Task: ${task.title}`}
          />
        ))}
      </Section>

      <Section title="Context">
        <Row first label={`${memories.length}`} value="approved memories" subtitle="Relevant notes are selected per request" />
        <Row label={`${Math.min(1600, memories.reduce((sum, memory) => sum + memory.text.length + 3, 0))}`} value="prompt characters" subtitle="Bounded before every send" />
        <Row label={`${projects.length}`} value="active projects" subtitle="Shared instructions and documents" />
        <Row label={`${tasks.length}`} value="open tasks" subtitle="Stored locally on this device" />
      </Section>

      <Section title="Recent decisions">
        {decisionMemories.length ? decisionMemories.map((memory, index) => (
          <Row key={memory.id} first={index === 0} label={memory.text} subtitle="Memory · approved" right={<Badge label="›" srLabel="Open memory" />} onPress={() => router.push('/settings/memory')} />
        )) : (
          <View style={{ padding: t.spacing.md }}><Empty title="No decisions recorded" body="Approved preferences and constraints will appear here." /></View>
        )}
      </Section>

      <Button label="Manage memory" size="sm" onPress={() => router.push('/settings/memory')} />
      <View style={{ height: t.spacing.lg }} />
      <Body size="xs" tone="faint">Daily maintenance runs automatically on app open.</Body>
    </Screen>
  );
}
