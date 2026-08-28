/**
 * One conversation.
 *
 * The screen is three things stacked: a virtualised transcript, the live turn as
 * its footer, and the composer. The interesting parts are the seams between them.
 *
 * **Loading.** `open()` populates `messages`, and nothing else. `useConversation`
 * reads `conversations`, which only `loadList()` fills — so arriving here by deep
 * link, or after a process restart, gives a transcript with no title, no model and
 * no profile. Both are kicked off, and the screen distinguishes "still loading"
 * from "this conversation is gone" rather than showing an empty transcript for
 * either.
 *
 * **`now`.** Fixed at mount and refreshed on focus, not read per render. Every row
 * formats its timestamp against it, and a value that changed each render would
 * defeat `MessageView`'s memo on exactly the screen where it matters most — during
 * a stream, which re-renders the list several times a second.
 *
 * **Scrolling.** FlashList v2 keeps the visible content anchored by default, so
 * growing text at the bottom does not require a `scrollToEnd` per delta. The
 * transcript opts into rendering from the bottom, which is where a chat starts.
 */

import { FlashList } from '@shopify/flash-list';
import * as Clipboard from 'expo-clipboard';
import { Stack as NavStack, useFocusEffect, useLocalSearchParams, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, KeyboardAvoidingView, Modal, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PromptSheet, Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Composer } from '@/components/chat/Composer';
import { MessageView } from '@/components/chat/MessageView';
import { StreamView } from '@/components/chat/StreamView';
import { Body, Button, Empty, Field, Note, Segmented, Spinner, Stack, Stepper, SwitchRow } from '@/components/ui';
import { mergeParams } from '@/chat/request';
import { parseTags } from '@/chat/list';
import { toUnifiedMessages } from '@/db/conversations';
import type { StoredMessage } from '@/db/conversations';
import { estimateMessagesTokens, estimateTextTokens } from '@/lib/tokens';
import { useChat, useConversation, useDraft, useMessages, useStream } from '@/stores/chat';
import { capabilitiesFor, entryKey, pickableModelIds, useModels } from '@/stores/models';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { useTheme } from '@/theme';

/** Which one-line prompt is open, and what it is editing. */
type Prompt =
  | { kind: 'system' }
  | { kind: 'rename' }
  | { kind: 'tags' }
  | { kind: 'resend'; message: StoredMessage }
  | { kind: 'editInPlace'; message: StoredMessage };

export default function ChatScreen() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();
  const { id } = useLocalSearchParams<{ id: string }>();

  const conversation = useConversation(id);
  const messages = useMessages(id);
  const stream = useStream(id);
  const draft = useDraft(id);

  const open = useChat((s) => s.open);
  const loadList = useChat((s) => s.loadList);
  const setDraft = useChat((s) => s.setDraft);
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const dismissError = useChat((s) => s.dismissError);

  const profiles = useProviders((s) => s.profiles);
  const entries = useModels((s) => s.entries);
  const showThinkingByDefault = useSettings((s) => s.showThinkingByDefault);

  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [menuFor, setMenuFor] = useState<StoredMessage | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [convMenu, setConvMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [configDraft, setConfigDraft] = useState<{
    maxTokens: string;
    temperature: string;
    topP: string;
    reasoningEnabled: boolean;
    effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budgetTokens: number;
  } | null>(null);

  // Both, because they fill different halves of the screen and only one of them
  // runs when you arrive from the list.
  useEffect(() => {
    let cancelled = false;
    void Promise.all([open(id), loadList()]).finally(() => {
      if (!cancelled) setLoaded(true);
    });
    return () => {
      cancelled = true;
    };
  }, [id, open, loadList]);

  // Coming back after an hour should not still say "14:32" was today.
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
    }, []),
  );

  const profile = profiles.find((p) => p.id === conversation?.profileId);
  const model = conversation?.model ?? '';
  const capabilities = useMemo(
    () =>
      conversation
        ? (entries[entryKey(conversation.profileId, model)]?.capabilities ??
          capabilitiesFor(conversation.profileId, model))
        : null,
    [conversation, entries, model],
  );

  const thinkingExpanded = conversation?.config.showThinking ?? showThinkingByDefault;

  // Read out before the memo rather than inside it. Reaching through
  // `conversation?.…` in the body makes the whole object the real dependency, so
  // the memo would recompute on every unrelated conversation change — and the
  // React Compiler rejects a dependency list that claims otherwise.
  const systemPrompt = conversation?.systemPrompt;
  const summaryText = conversation?.config.summary?.text;

  const baseTokens = useMemo(() => {
    const history = estimateMessagesTokens(toUnifiedMessages(messages));
    const system = systemPrompt ? estimateTextTokens(systemPrompt) : 0;
    const summary = summaryText ? estimateTextTokens(summaryText) : 0;
    return history + system + summary;
  }, [messages, systemPrompt, summaryText]);

  const reserved = useMemo(() => {
    if (!capabilities || !conversation) return 0;
    const params = mergeParams(capabilities, conversation.config.params);
    return params.maxTokens + (conversation.config.reasoning?.budgetTokens ?? 0);
  }, [capabilities, conversation]);

  const onAction = useCallback((message: StoredMessage) => setMenuFor(message), []);

  const renderItem = useCallback(
    ({ item }: { item: StoredMessage }) => {
      const pricing = entries[entryKey(conversation?.profileId ?? '', item.model ?? model)]?.pricing;
      return (
        <MessageView
          message={item}
          now={now}
          thinkingExpanded={thinkingExpanded}
          onAction={onAction}
          {...(pricing ? { pricing } : {})}
        />
      );
    },
    [entries, conversation?.profileId, model, now, thinkingExpanded, onAction],
  );

  // FlashList only re-renders rows when `data` or `extraData` changes identity, and
  // every one of these is read by `renderItem` from outside `data`.
  const extraData = useMemo(
    () => ({ now, thinkingExpanded, entries, model }),
    [now, thinkingExpanded, entries, model],
  );

  if (!loaded) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Spinner label="Opening" />
      </View>
    );
  }

  if (!conversation) {
    return (
      <View style={{ flex: 1, padding: t.spacing.md }}>
        <NavStack.Screen options={{ title: 'Gone' }} />
        <Note tone="danger">
          This conversation no longer exists. It was probably deleted on another screen.
        </Note>
      </View>
    );
  }

  const streaming = stream !== undefined && stream.error === undefined;
  const blocked = profile && !profile.hasKey
    ? `No API key saved for ${profile.name}. Settings → Providers → ${profile.name}.`
    : undefined;

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  const confirmDelete = (message: StoredMessage): void => {
    Alert.alert('Delete this message?', 'It is removed from the transcript and from the database.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void useChat.getState().deleteMessage(id, message.id),
      },
    ]);
  };

  const confirmDeleteConversation = (): void => {
    Alert.alert('Delete this conversation?', `"${conversation.title}" and every message in it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          void useChat.getState().remove(id);
          router.back();
        },
      },
    ]);
  };

  const messageActions = (message: StoredMessage): SheetAction[] => {
    const busy = streaming;
    const reason = busy ? 'Wait for the current reply to finish.' : undefined;
    return [
      {
        label: 'Copy text',
        subtitle: message.text ? undefined : 'This message has no text to copy.',
        disabled: !message.text,
        ...(message.text ? {} : { disabledReason: 'This message has no text to copy.' }),
        onPress: () => void Clipboard.setStringAsync(message.text),
      },
      {
        label: 'Edit and resend',
        subtitle: 'Rewrites this message and drops everything after it.',
        disabled: busy || message.role !== 'user',
        ...(busy
          ? { disabledReason: reason }
          : message.role !== 'user'
            ? { disabledReason: 'Only your own messages can be resent.' }
            : {}),
        onPress: () => setPrompt({ kind: 'resend', message }),
      },
      {
        label: 'Edit in place',
        subtitle: 'Changes the text without re-running anything.',
        onPress: () => setPrompt({ kind: 'editInPlace', message }),
      },
      {
        label: 'Regenerate',
        subtitle: 'Asks again from this point.',
        disabled: busy,
        ...(busy ? { disabledReason: reason } : {}),
        onPress: () => void useChat.getState().regenerate(id, message.id),
      },
      {
        label: 'Fork from here',
        subtitle: 'Copies the conversation up to this message into a new one.',
        onPress: () => {
          void useChat
            .getState()
            .fork(id, message.id)
            .then((forkId) => router.push({ pathname: '/chat/[id]', params: { id: forkId } }));
        },
      },
      {
        label: message.excluded ? 'Include in context' : 'Exclude from context',
        subtitle: message.excluded
          ? 'Send this message again on the next turn.'
          : 'Keep it in the transcript but stop sending it.',
        onPress: () => void useChat.getState().setExcluded(id, message.id, !message.excluded),
      },
      {
        label: 'Delete',
        destructive: true,
        onPress: () => confirmDelete(message),
      },
    ];
  };

  const conversationActions: SheetAction[] = [
    {
      label: 'System prompt',
      subtitle: conversation.systemPrompt ? 'Set — tap to edit' : 'Not set',
      onPress: () => setPrompt({ kind: 'system' }),
    },
    { label: 'Model', subtitle: conversation.model, onPress: () => setModelMenu(true) },
    {
      label: 'Model controls',
      subtitle: 'Sampling and reasoning for the next message',
      onPress: () => {
        const params = conversation.config.params ?? {};
        const reasoning = conversation.config.reasoning;
        setConfigDraft({
          maxTokens: String(params.maxTokens ?? 8192),
          temperature: params.temperature === undefined ? '' : String(params.temperature),
          topP: params.topP === undefined ? '' : String(params.topP),
          reasoningEnabled: reasoning?.enabled ?? false,
          effort: reasoning?.effort ?? (profile?.kind === 'openai' ? 'medium' : 'medium'),
          budgetTokens: reasoning?.budgetTokens ?? 16_384,
        });
        setConvMenu(false);
        setConfigOpen(true);
      },
    },
    { label: 'Rename', subtitle: conversation.title, onPress: () => setPrompt({ kind: 'rename' }) },
    {
      label: 'Tags',
      subtitle: conversation.tags.length ? conversation.tags.join(', ') : 'None',
      onPress: () => setPrompt({ kind: 'tags' }),
    },
    {
      label: conversation.pinned ? 'Unpin' : 'Pin to the top',
      onPress: () => void useChat.getState().setPinned(id, !conversation.pinned),
    },
    { label: 'Delete conversation', destructive: true, onPress: confirmDeleteConversation },
  ];

  const modelActions: SheetAction[] = pickableModelIds(conversation.profileId, [
    conversation.model,
  ]).map((candidate) => ({
    label: candidate,
    ...(candidate === conversation.model ? { subtitle: 'Current' } : {}),
    onPress: () => void useChat.getState().setModel(id, candidate),
  }));

  const promptProps = ((): {
    title: string;
    initial: string;
    rows: number;
    allowEmpty: boolean;
    hint?: string;
    placeholder?: string;
    onConfirm: (text: string) => void;
  } | null => {
    if (!prompt) return null;
    switch (prompt.kind) {
      case 'system':
        return {
          title: 'System prompt',
          initial: conversation.systemPrompt ?? '',
          rows: 6,
          allowEmpty: true,
          hint: 'Sent ahead of every message in this conversation. Editing it changes the next turn, not the ones already sent.',
          placeholder: 'You are…',
          onConfirm: (text) => void useChat.getState().setSystemPrompt(id, text),
        };
      case 'rename':
        return {
          title: 'Rename',
          initial: conversation.title,
          rows: 1,
          allowEmpty: false,
          onConfirm: (text) => void useChat.getState().rename(id, text),
        };
      case 'tags':
        return {
          title: 'Tags',
          initial: conversation.tags.join(', '),
          rows: 1,
          allowEmpty: true,
          hint: 'Comma separated.',
          placeholder: 'work, drafts',
          onConfirm: (text) => void useChat.getState().setTags(id, parseTags(text)),
        };
      case 'resend':
        return {
          title: 'Edit and resend',
          initial: prompt.message.text,
          rows: 4,
          allowEmpty: false,
          hint: 'Everything after this message is deleted, then it is sent again.',
          onConfirm: (text) => void useChat.getState().editAndResend(id, prompt.message.id, text),
        };
      case 'editInPlace':
        return {
          title: 'Edit in place',
          initial: prompt.message.text,
          rows: 4,
          allowEmpty: true,
          hint: 'Only the stored text changes. Nothing is re-sent, so the reply below still answers the old wording.',
          onConfirm: (text) => void useChat.getState().editInPlace(id, prompt.message.id, text),
        };
    }
  })();

  /* ---------------------------------------------------------------------- */

  return (
    <KeyboardAvoidingView behavior="padding" style={{ flex: 1 }}>
      <NavStack.Screen
        options={{
          title: conversation.title,
          headerRight: () => (
            <Pressable
              onPress={() => setConvMenu(true)}
              accessibilityRole="button"
              accessibilityLabel="Conversation options"
              hitSlop={12}
            >
              <Body size="lg" weight="700">
                ⋯
              </Body>
            </Pressable>
          ),
        }}
      />

      <FlashList
        data={messages}
        extraData={extraData}
        keyExtractor={(item) => item.id}
        renderItem={renderItem}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
        contentContainerStyle={{ padding: t.spacing.md }}
        ItemSeparatorComponent={() => <View style={{ height: t.spacing.lg }} />}
        ListEmptyComponent={
          stream ? null : (
            <Empty
              title="Nothing here yet"
              body={`Send a message and ${conversation.model} answers below.`}
            />
          )
        }
        ListFooterComponent={
          stream ? (
            <View style={{ paddingTop: messages.length ? t.spacing.lg : 0 }}>
              <StreamView
                stream={stream}
                showThinking={thinkingExpanded || stream.text.length === 0}
                onStop={() => abort(id)}
                onDismiss={() => dismissError(id)}
                {...(stream.error !== undefined
                  ? { onRetry: () => { dismissError(id); void useChat.getState().regenerate(id, messages[messages.length - 1]?.id ?? ''); } }
                  : {})}
              />
            </View>
          ) : null
        }
      />

      <View style={{ paddingBottom: insets.bottom }}>
        <Composer
          value={draft}
          onChangeText={(text) => setDraft(id, text)}
          onSend={() => void send(id, { text: draft })}
          onStop={() => abort(id)}
          streaming={streaming}
          aborting={stream?.aborting ?? false}
          baseTokens={baseTokens}
          window={capabilities?.contextWindow ?? 0}
          reserved={reserved}
          {...(blocked ? { disabledReason: blocked } : {})}
        />
      </View>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.role === 'user' ? 'Your message' : 'Reply'}
        {...(menuFor?.text ? { subtitle: menuFor.text } : {})}
        actions={menuFor ? messageActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />

      <Sheet
        visible={convMenu}
        title={conversation.title}
        subtitle={`${conversation.model} · ${messages.length} message${messages.length === 1 ? '' : 's'}`}
        actions={conversationActions}
        onClose={() => setConvMenu(false)}
      />

      <Sheet
        visible={modelMenu}
        title="Model"
        subtitle="Applies to the next message, not the ones already sent."
        actions={modelActions}
        onClose={() => setModelMenu(false)}
      />

      {/* Mounted only while open, so the draft is seeded from the stored value
          every time rather than surviving a cancel. */}
      {promptProps ? (
        <PromptSheet
          visible
          title={promptProps.title}
          initial={promptProps.initial}
          rows={promptProps.rows}
          allowEmpty={promptProps.allowEmpty}
          {...(promptProps.hint !== undefined ? { hint: promptProps.hint } : {})}
          {...(promptProps.placeholder !== undefined ? { placeholder: promptProps.placeholder } : {})}
          onCancel={() => setPrompt(null)}
          onConfirm={(text) => {
            promptProps.onConfirm(text);
            setPrompt(null);
          }}
        />
      ) : null}

      <Modal visible={configOpen && configDraft !== null} animationType="slide" transparent onRequestClose={() => setConfigOpen(false)}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <View style={{ maxHeight: '90%', backgroundColor: t.colors.bg, borderTopLeftRadius: t.radius.lg, borderTopRightRadius: t.radius.lg, padding: t.spacing.lg }}>
            {configDraft ? (
              <Stack gap="md">
                <Body size="lg" weight="700">Model controls</Body>
                <Field label="Max output tokens" value={configDraft.maxTokens} onChangeText={(v) => setConfigDraft((d) => d ? { ...d, maxTokens: v } : d)} keyboardType="number-pad" mono />
                <Field label="Temperature" value={configDraft.temperature} onChangeText={(v) => setConfigDraft((d) => d ? { ...d, temperature: v } : d)} keyboardType="decimal-pad" placeholder="Default" mono />
                {profile?.kind === 'openai' ? <Field label="Top P" value={configDraft.topP} onChangeText={(v) => setConfigDraft((d) => d ? { ...d, topP: v } : d)} keyboardType="decimal-pad" placeholder="Default" mono /> : null}
                <SwitchRow label="Reasoning / thinking" value={configDraft.reasoningEnabled} onChange={(v) => setConfigDraft((d) => d ? { ...d, reasoningEnabled: v } : d)} />
                {configDraft.reasoningEnabled ? (
                  <>
                    <Segmented
                      options={(profile?.kind === 'openai' ? ['minimal', 'low', 'medium', 'high'] : ['low', 'medium', 'high', 'xhigh', 'max']).map((v) => ({ value: v as typeof configDraft.effort, label: v }))}
                      value={configDraft.effort}
                      onChange={(v) => setConfigDraft((d) => d ? { ...d, effort: v } : d)}
                    />
                    {profile?.kind === 'anthropic' ? <Stepper label="Thinking budget" value={configDraft.budgetTokens} onChange={(v) => setConfigDraft((d) => d ? { ...d, budgetTokens: v } : d)} step={1024} min={1024} max={127999} format={(v) => v.toLocaleString()} /> : null}
                  </>
                ) : null}
                <Note>These settings apply to the next message. Unsupported fields are omitted by the transport.</Note>
                <Stack gap="sm">
                  <Button label="Save controls" variant="primary" full onPress={() => {
                    const d = configDraft;
                    const maxTokens = Number.parseInt(d.maxTokens, 10);
                    const temperature = Number.parseFloat(d.temperature);
                    const topP = Number.parseFloat(d.topP);
                    void useChat.getState().setConfig(id, {
                      params: { maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined, ...(Number.isFinite(temperature) ? { temperature } : {}), ...(Number.isFinite(topP) ? { topP } : {}) },
                      reasoning: { enabled: d.reasoningEnabled, effort: d.effort, ...(profile?.kind === 'anthropic' ? { budgetTokens: d.budgetTokens } : {}) },
                    });
                    setConfigOpen(false);
                  }} />
                  <Button label="Cancel" variant="ghost" full onPress={() => setConfigOpen(false)} />
                </Stack>
              </Stack>
            ) : null}
          </View>
        </View>
      </Modal>
    </KeyboardAvoidingView>
  );
}
