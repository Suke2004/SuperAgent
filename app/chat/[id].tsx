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
import { Alert, KeyboardAvoidingView, Modal, Platform, Pressable, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBadge, OfflineBanner } from '@/components/OfflineBanner';
import { useDialogKeys } from '@/components/dialog';
import { PromptSheet, Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { Composer } from '@/components/chat/Composer';
import { MessageView } from '@/components/chat/MessageView';
import { StreamView } from '@/components/chat/StreamView';
import {
  Body,
  Button,
  Empty,
  Field,
  Inline,
  Note,
  Segmented,
  Spinner,
  Stack,
  Stepper,
  SwitchRow,
} from '@/components/ui';
import { hasBlockingIssue, mergeParams, validateConfig } from '@/chat/request';
import { replyReservation } from '@/chat/budget';
import { captureImage, openAppSettings, pickDocuments, pickImages } from '@/chat/attach';
import { documentCaveat, documentSupport, imageSupport, MAX_ATTACHMENTS_PER_MESSAGE } from '@/chat/attachments';
import { useMemory } from '@/stores/memory';
import type { ConfigIssue } from '@/chat/request';
import { parseTags } from '@/chat/list';
import { deliverExport } from '@/chat/deliver';
import type { DeliveryMethod } from '@/chat/deliver';
import type { ExportFormat } from '@/chat/export';
import { plural } from '@/chat/selection';
import { toUnifiedMessages } from '@/db/conversations';
import type { StoredMessage } from '@/db/conversations';
import { estimateMessagesTokens, estimateTextTokens, formatCost, formatTokens, estimateCost } from '@/lib/tokens';
import { useChat, useAttachments, useConversation, useDraft, useMessages, useStream } from '@/stores/chat';
import { useCalibration } from '@/stores/calibration';
import { capabilitiesFor, entryKey, pickableModelIds, useModels } from '@/stores/models';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { availableEfforts, controlSupport } from '@/transports/support';
import type { ContentBlock } from '@/transports/types';
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
  const attachments = useAttachments(id);

  const open = useChat((s) => s.open);
  const loadList = useChat((s) => s.loadList);
  const setDraft = useChat((s) => s.setDraft);
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const dismissError = useChat((s) => s.dismissError);
  const addAttachments = useChat((s) => s.addAttachments);
  const removeAttachment = useChat((s) => s.removeAttachment);

  const profiles = useProviders((s) => s.profiles);
  const entries = useModels((s) => s.entries);
  const showThinkingByDefault = useSettings((s) => s.showThinkingByDefault);
  const memoryEnabled = useSettings((s) => s.memoryEnabled);

  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [menuFor, setMenuFor] = useState<StoredMessage | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [convMenu, setConvMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [configOpen, setConfigOpen] = useState(false);
  const [costFor, setCostFor] = useState<StoredMessage | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  /** What the last pick refused, and whether Settings is the only way to fix it. */
  const [attachNotes, setAttachNotes] = useState<{ notes: string[]; needsSettings: boolean } | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [configDraft, setConfigDraft] = useState<{
    maxTokens: string;
    temperature: string;
    topP: string;
    topK: string;
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

  // Everything the next request carries besides the draft. The memory block is in
  // here because it is in the request: a gauge that ignores it reads low by
  // exactly the size of the notes, which on a well-used install is thousands of
  // tokens and precisely when the warning matters.
  const memoryChars = useMemory((s) => (memoryEnabled ? (s.promptBlock().text?.length ?? 0) : 0));

  const baseTokens = useMemo(() => {
    const history = estimateMessagesTokens(toUnifiedMessages(messages));
    const system = systemPrompt ? estimateTextTokens(systemPrompt) : 0;
    const summary = summaryText ? estimateTextTokens(summaryText) : 0;
    // From the character count rather than the text: the block is re-rendered on
    // every memory change and this memo should not depend on its identity.
    const memory = Math.ceil(memoryChars / 3.8);
    return history + system + summary + memory;
  }, [messages, systemPrompt, summaryText, memoryChars]);

  // `replyReservation`, not `maxTokens + budgetTokens`. Thinking is billed inside
  // the output allowance, so adding it made the gauge claim a reasoning
  // conversation was far closer to the window than it was.
  const reserved = useMemo(() => {
    if (!capabilities || !conversation) return 0;
    const params = mergeParams(capabilities, conversation.config.params);
    return replyReservation(params, conversation.config.reasoning);
  }, [capabilities, conversation]);

  const onAction = useCallback((message: StoredMessage) => setMenuFor(message), []);

  /* ----------------------------------------------------------------------- */
  /* Attachments                                                              */
  /* ----------------------------------------------------------------------- */

  const transport = profile?.kind ?? 'openai';

  // Read out above the memos: the same React Compiler rule that governs
  // `systemPrompt` applies here, and `capabilities` is nullable rather than
  // optional so it has to be widened before it crosses into a pure module.
  const caps = capabilities ?? undefined;

  const images = useMemo(() => imageSupport(caps), [caps]);
  const pdfs = useMemo(() => documentSupport(transport, caps, 'application/pdf'), [transport, caps]);

  /**
   * Why the paperclip is unavailable, or `undefined`.
   *
   * Not capability-based: a vision-less model can still take a text file, and a
   * plain text file is prose appended to the message rather than a block anything
   * has to support, so the button is essentially always live. What does disable it
   * is a pick already running — see `runPick` for why a second one is not safe.
   */
  const attachDisabledReason = attachBusy ? 'Reading the last file.' : undefined;

  /** The first lossy thing about what is staged, if anything is. */
  const attachmentCaveat = useMemo(() => {
    for (const block of attachments) {
      if (block.type !== 'document') continue;
      const caveat = documentCaveat(transport, caps, block);
      if (caveat) return caveat;
    }
    return undefined;
  }, [attachments, transport, caps]);

  /**
   * Runs one picker and stages what it returned.
   *
   * `attachBusy` is not cosmetic: encoding four photos is seconds of work off the
   * JS thread's critical path but the picker can be reopened during it, and a
   * second concurrent run would check its budget against a staged set that the
   * first run has not finished adding to.
   */
  const runPick = useCallback(
    async (pick: () => Promise<{ blocks: ContentBlock[]; notes: string[]; needsSettings?: boolean }>) => {
      setAttachMenu(false);
      setAttachBusy(true);
      try {
        const result = await pick();
        if (result.blocks.length) addAttachments(id, result.blocks);
        if (result.notes.length) {
          setAttachNotes({ notes: result.notes, needsSettings: result.needsSettings ?? false });
        }
      } catch (error) {
        setAttachNotes({
          notes: [error instanceof Error ? error.message : 'The picker could not be opened.'],
          needsSettings: false,
        });
      } finally {
        setAttachBusy(false);
      }
    },
    [id, addAttachments],
  );

  // What this model's own reported prompt counts say about the estimator. Subscribed
  // to rather than read once, so the gauge tightens as soon as a turn lands.
  const calibration = useCalibration((s) =>
    conversation ? s.byModel[entryKey(conversation.profileId, model)] : undefined,
  );
  const onExplainCost = useCallback((message: StoredMessage) => setCostFor(message), []);

  /**
   * The draft's problems, recomputed on every keystroke.
   *
   * `validateConfig` already knew all of this; it was simply never called from the
   * sheet, so a temperature of 5 or a thinking budget above `max_tokens` was only
   * discovered when the gateway rejected the next message — one screen and one
   * round trip away from the field that caused it.
   */
  const configIssues = useMemo<ConfigIssue[]>(() => {
    if (!configDraft || !capabilities || !profile) return [];
    const maxTokens = Number.parseInt(configDraft.maxTokens, 10);
    const temperature = Number.parseFloat(configDraft.temperature);
    const topP = Number.parseFloat(configDraft.topP);
    const topK = Number.parseInt(configDraft.topK, 10);
    return validateConfig({
      transport: profile.kind,
      capabilities,
      params: {
        maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(topP) ? { topP } : {}),
        ...(Number.isFinite(topK) ? { topK } : {}),
      },
      reasoning: {
        enabled: configDraft.reasoningEnabled,
        effort: configDraft.effort,
        ...(profile.kind === 'anthropic' ? { budgetTokens: configDraft.budgetTokens } : {}),
      },
    });
  }, [configDraft, capabilities, profile]);

  // Errors win over warnings on the same control: one line under a field, and the
  // blocking one is the one that has to be read.
  const issueFor = useCallback(
    (field: ConfigIssue['field']): string | undefined => {
      const forField = configIssues.filter((issue) => issue.field === field);
      const worst = forField.find((issue) => issue.level === 'error') ?? forField[0];
      return worst?.message;
    },
    [configIssues],
  );
  const configBlocked = hasBlockingIssue(configIssues);

  // Escape and a Tab trap for the controls modal, same as the sheets get. Stable
  // identity, or the effect would re-run on every keystroke and steal focus back to
  // the first field mid-edit.
  const closeConfig = useCallback(() => setConfigOpen(false), []);
  const configTrap = useDialogKeys(configOpen && configDraft !== null, closeConfig);

  // Which sampling controls this transport and model can actually use. The sheet
  // used to hard-code `profile.kind === 'openai'` for Top P and offered no Top K at
  // all, which is backwards on both counts: the Anthropic Messages API takes both.
  const topPSupport = useMemo(
    () => controlSupport('topP', profile?.kind ?? 'openai', capabilities ?? undefined),
    [profile?.kind, capabilities],
  );
  const topKSupport = useMemo(
    () => controlSupport('topK', profile?.kind ?? 'openai', capabilities ?? undefined),
    [profile?.kind, capabilities],
  );
  const efforts = useMemo(
    () => availableEfforts(profile?.kind ?? 'openai', capabilities ?? undefined),
    [profile?.kind, capabilities],
  );

  /**
   * The arithmetic behind one row's `~$…`, spelled out.
   *
   * Built here rather than in the sheet because it needs the pricing entry for the
   * *message's* model, which only this screen can look up.
   */
  const costExplanation = useMemo<string | undefined>(() => {
    if (!costFor) return undefined;
    const usage = costFor.usage;
    const modelId = costFor.model ?? model;
    const pricing = entries[entryKey(conversation?.profileId ?? '', modelId)]?.pricing;
    const cost = usage ? estimateCost(usage, pricing) : null;
    if (!cost || !pricing || !usage) {
      return `No rates are saved for ${modelId}, so no cost is shown for this message.`;
    }
    const inputTokens = (usage.input ?? 0) + (usage.cacheRead ?? 0) + (usage.cacheWrite ?? 0);
    return [
      `${modelId}: $${pricing.inputPerMTok} per million input tokens, $${pricing.outputPerMTok} per million output.`,
      `${formatTokens(inputTokens)} in × input rate = $${formatCost(cost.input)}. ${formatTokens(usage.output ?? 0)} out × output rate = $${formatCost(cost.output)}. Total ~$${formatCost(cost.total)}.`,
      usage.cacheRead || usage.cacheWrite
        ? 'Cached tokens are charged at the full input rate here: both vendors discount them, but a gateway\'s own markup is not knowable from the app, so this figure is an upper bound.'
        : '',
      usage.input === undefined || usage.output === undefined
        ? 'The gateway did not report every token count, so the missing side is treated as zero and the real cost is higher.'
        : '',
      'These rates are typed in by hand in Settings → Models. Nothing verifies them against what the gateway actually bills — treat the number as an estimate, not an invoice.',
    ]
      .filter(Boolean)
      .join('\n\n');
  }, [costFor, entries, conversation?.profileId, model]);

  const renderItem = useCallback(    ({ item }: { item: StoredMessage }) => {
      const pricing = entries[entryKey(conversation?.profileId ?? '', item.model ?? model)]?.pricing;
      return (
        <MessageView
          message={item}
          now={now}
          thinkingExpanded={thinkingExpanded}
          onAction={onAction}
          onExplainCost={onExplainCost}
          {...(pricing ? { pricing } : {})}
        />
      );
    },
    [entries, conversation?.profileId, model, now, thinkingExpanded, onAction, onExplainCost],
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
    : !profile
      ? 'This conversation\'s provider profile no longer exists. Pick another one from the ⋯ menu before sending.'
      : undefined;

  /* ---------------------------------------------------------------------- */
  /* Actions                                                                 */
  /* ---------------------------------------------------------------------- */

  /**
   * Opens the sampling controls seeded from what the conversation currently sends.
   *
   * A function rather than an inline handler because the failure banner opens it
   * too: "the gateway rejected temperature" is only actionable if the thing that
   * set the temperature is one tap away.
   */
  const openModelControls = (): void => {
    const params = conversation.config.params ?? {};
    const reasoning = conversation.config.reasoning;
    setConfigDraft({
      maxTokens: String(params.maxTokens ?? 8192),
      temperature: params.temperature === undefined ? '' : String(params.temperature),
      topP: params.topP === undefined ? '' : String(params.topP),
      topK: params.topK === undefined ? '' : String(params.topK),
      reasoningEnabled: reasoning?.enabled ?? false,
      effort: reasoning?.effort ?? 'medium',
      budgetTokens: reasoning?.budgetTokens ?? 16_384,
    });
    setConvMenu(false);
    setConfigOpen(true);
  };

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

  /**
   * Export this conversation, from what is on screen rather than from SQLite.
   *
   * The messages are already in the store and are the ones the user is looking
   * at, so re-reading them would only introduce a way for the artefact to differ
   * from the transcript it claims to be.
   */
  const runExport = async (format: ExportFormat, method: DeliveryMethod, includeThinking = false): Promise<void> => {
    if (exportBusy || !conversation) return;
    setExportBusy(true);
    try {
      const outcome = await deliverExport([{ conversation, messages }], format, method, { includeThinking });
      setExportOpen(false);
      if (!outcome.delivered) return;
      const kb = Math.max(1, Math.round(outcome.result.bytes / 1024));
      Alert.alert(
        outcome.method === 'copy' ? 'Copied' : 'Shared',
        [
          `${plural(outcome.result.messages, 'message')}, ${kb} kB.`,
          outcome.fellBackToClipboard
            ? 'Too large for the share sheet, so it went to the clipboard instead.'
            : null,
          includeThinking ? 'Reasoning included.' : null,
          'Attachments and API keys are not included.',
        ]
          .filter(Boolean)
          .join(' '),
      );
    } catch (error) {
      Alert.alert('Could not export', error instanceof Error ? error.message : String(error));
    } finally {
      setExportBusy(false);
    }
  };

  const hasThinking = messages.some((message) => message.content.some((block) => block.type === 'thinking'));

  /**
   * The attach sheet.
   *
   * The two image entries are shown even when the model has no vision flag, with
   * the reason on the row: hiding them makes a hand-edited flag look like a missing
   * feature, and the fix — Settings → Models — is only discoverable if the refusal
   * names it. `documentSupport` is asked about PDFs specifically because that is the
   * only document kind a capability can refuse; a text file always goes.
   */
  const attachActions: SheetAction[] = [
    {
      label: 'Take a photo',
      subtitle: 'Resized to fit before it leaves the device. Nothing is sent until you press send.',
      disabled: !images.supported,
      ...(images.supported ? {} : { disabledReason: images.reason }),
      onPress: () => void runPick(() => captureImage(attachments)),
    },
    {
      label: 'Choose images',
      subtitle: `Up to ${MAX_ATTACHMENTS_PER_MESSAGE} attachments per message.`,
      disabled: !images.supported,
      ...(images.supported ? {} : { disabledReason: images.reason }),
      onPress: () => void runPick(() => pickImages(attachments)),
    },
    {
      label: 'Attach a document',
      subtitle: pdfs.supported
        ? 'PDFs go as documents; text files are read on device.'
        : 'Text files are read on device. PDFs are not available here.',
      onPress: () => void runPick(() => pickDocuments(attachments, transport, caps)),
    },
  ];

  const exportActions: SheetAction[] = [
    {
      label: 'Share as Markdown',
      subtitle: 'Readable anywhere. Best for sending to a person.',
      onPress: () => void runExport('markdown', 'share'),
    },
    {
      label: 'Copy as Markdown',
      subtitle: 'Straight to the clipboard.',
      onPress: () => void runExport('markdown', 'copy'),
    },
    ...(hasThinking
      ? [
          {
            label: 'Copy as Markdown, with reasoning',
            // Named as an exception rather than offered as a checkbox, because
            // reasoning restates private context in blunter terms than the reply
            // does and a checkbox is a thing people leave ticked.
            subtitle: 'Includes the model’s scratch work, labelled.',
            onPress: () => void runExport('markdown', 'copy', true),
          } as SheetAction,
        ]
      : []),
    {
      label: 'Share as JSON',
      subtitle: 'Every field, for another program to read.',
      onPress: () => void runExport('json', 'share'),
    },
    {
      label: 'Copy as JSON',
      subtitle: 'Straight to the clipboard.',
      onPress: () => void runExport('json', 'copy'),
    },
  ];

  const conversationActions: SheetAction[] = [
    {
      label: 'System prompt',
      subtitle: conversation.systemPrompt ? 'Set — tap to edit' : 'Not set',
      onPress: () => setPrompt({ kind: 'system' }),
    },
    { label: 'Model', subtitle: conversation.model, onPress: () => setModelMenu(true) },
    {
      // Present always, not only when the profile is missing: a conversation started
      // on the wrong gateway is a normal mistake, and this is where it is fixed.
      label: 'Provider profile',
      subtitle: profile ? profile.name : 'Missing — this conversation cannot send until you pick one',
      onPress: () => setProfileMenu(true),
    },
    {
      label: 'Model controls',
      subtitle: 'Sampling and reasoning for the next message',
      onPress: openModelControls,
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
    {
      label: 'Export…',
      subtitle: 'Markdown or JSON. Attachments and keys are left out.',
      onPress: () => setExportOpen(true),
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

  const profileActions: SheetAction[] = profiles.map((candidate) => ({
    label: candidate.name,
    subtitle:
      candidate.id === conversation.profileId
        ? 'Current'
        : `${candidate.kind === 'anthropic' ? '/v1/messages' : '/chat/completions'} · ${candidate.baseUrl}`,
    ...(candidate.hasKey ? {} : { disabled: true, disabledReason: 'No API key saved for this profile.' }),
    onPress: () => void useChat.getState().setProfile(id, candidate.id),
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
    // One keyboard mechanism, not two. Android resizes the window itself
    // (`softwareKeyboardLayoutMode: 'resize'` in app.json), so adding padding on top
    // of that moves the composer twice — once by the OS and once by React — and
    // leaves a gap the height of the keyboard. iOS does not resize, so there it is
    // this view's job.
    <KeyboardAvoidingView
      {...(Platform.OS === 'ios' ? { behavior: 'padding' as const } : {})}
      style={{ flex: 1 }}
    >
      <NavStack.Screen
        options={{
          title: conversation.title,
          // The model is the single most consequential thing about a conversation and
          // it was only visible two taps deep, in the ⋯ menu. Sending a long prompt
          // to the wrong one costs real money, so it is on screen.
          headerTitle: () => (
            <View style={{ gap: 1 }}>
              <Body size="md" weight="400" numberOfLines={1} style={{ fontFamily: t.serifFont }}>
                {conversation.title}
              </Body>
              <Inline gap="xs">
                <Body size="xs" tone="faint" numberOfLines={1} accessibilityLabel={`Model ${conversation.model}`}>
                  {conversation.model}
                </Body>
                <OfflineBadge />
              </Inline>
            </View>
          ),
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
        // Recycle a user bubble only onto another user bubble. The two roles have
        // very different subtrees — an assistant message carries markdown, a
        // reasoning pane and a usage footer — so reusing one for the other throws
        // away the whole view tree on the way past, which is the difference
        // between a smooth 1,000-message scroll and a visibly hitching one. An
        // errored turn gets its own pool for the same reason.
        getItemType={(item) => (item.error ? 'error' : item.role)}
        renderItem={renderItem}
        maintainVisibleContentPosition={{ startRenderingFromBottom: true, autoscrollToBottomThreshold: 0.2 }}
        contentContainerStyle={{ padding: t.spacing.md }}
        // Dragging the transcript puts the keyboard away with the gesture instead of
        // requiring a separate tap, and a tap on a message action still lands rather
        // than being swallowed by the dismiss.
        keyboardDismissMode="interactive"
        keyboardShouldPersistTaps="handled"
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
                  ? {
                      onRetry: () => { dismissError(id); void useChat.getState().regenerate(id, messages[messages.length - 1]?.id ?? ''); },
                      // A rejected parameter is fixable, and the fix is in a sheet the
                      // banner can open. Without this the user has to guess which of
                      // the ⋯ entries owns `temperature`.
                      onEditRequest: openModelControls,
                    }
                  : {})}
              />
            </View>
          ) : null
        }
      />

      <View style={{ paddingBottom: insets.bottom, gap: t.spacing.sm }}>
        {/* Above the composer rather than at the top of the screen: it is a
            statement about what will happen when you press send. */}
        <View style={{ paddingHorizontal: t.spacing.md }}>
          <OfflineBanner />
        </View>
        <Composer
          value={draft}
          onChangeText={(text) => setDraft(id, text)}
          onSend={() => void send(id, { text: draft, ...(attachments.length ? { attachments: [...attachments] } : {}) })}
          onStop={() => abort(id)}
          streaming={streaming}
          aborting={stream?.aborting ?? false}
          baseTokens={baseTokens}
          window={capabilities?.contextWindow ?? 0}
          reserved={reserved}
          model={conversation.model}
          onPressModel={() => setModelMenu(true)}
          attachments={attachments}
          onAttach={() => setAttachMenu(true)}
          onRemoveAttachment={(index) => removeAttachment(id, index)}
          {...(attachDisabledReason !== undefined ? { attachDisabledReason } : {})}
          {...(attachmentCaveat !== undefined ? { attachmentCaveat } : {})}
          {...(calibration ? { calibration } : {})}
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
        visible={exportOpen}
        title={exportBusy ? 'Exporting…' : 'Export'}
        subtitle={`${plural(messages.length, 'message')}. Attachment contents are left out and API keys never appear.`}
        actions={exportActions}
        onClose={() => setExportOpen(false)}
      />

      <Sheet
        visible={attachMenu}
        title="Attach"
        subtitle={
          attachments.length
            ? `${attachments.length} already staged. Everything goes with the next message.`
            : 'Nothing is uploaded until you press send.'
        }
        actions={attachActions}
        onClose={() => setAttachMenu(false)}
      />

      {/* What a pick refused, as prose. A partial success lands here too — four
          photos added and the fifth over budget is not a failure, and the sheet says
          which one did not make it rather than leaving the count to be recounted. */}
      <Sheet
        visible={attachNotes !== null}
        title={attachNotes && attachNotes.notes.length > 1 ? 'Some files were not attached' : 'Not attached'}
        {...(attachNotes ? { body: attachNotes.notes.join('\n\n') } : {})}
        actions={
          attachNotes?.needsSettings
            ? [
                {
                  label: 'Open Settings',
                  subtitle: 'The permission can only be turned back on there.',
                  onPress: () => {
                    setAttachNotes(null);
                    void openAppSettings();
                  },
                },
              ]
            : []
        }
        onClose={() => setAttachNotes(null)}
      />

      <Sheet
        visible={modelMenu}
        title="Model"
        subtitle="Applies to the next message, not the ones already sent."
        actions={modelActions}
        onClose={() => setModelMenu(false)}
      />

      <Sheet
        visible={profileMenu}
        title="Provider profile"
        subtitle="The model list and the wire format both come from this. Switching does not resend anything."
        actions={profileActions}
        onClose={() => setProfileMenu(false)}
      />

      {/* Where `~$0.0042` comes from, said once, on demand.
          The number is arithmetic on a price table this app cannot verify: the
          gateway does not publish rates, so the table is hand-entered and may be
          stale, wrong for a re-routed model, or missing the gateway's own markup.
          A row that shows a dollar figure without a way to learn that is claiming
          more than it knows. */}
      <Sheet
        visible={costFor !== null}
        title="Estimated cost"
        {...(costExplanation ? { body: costExplanation } : {})}
        actions={[
          {
            label: 'Edit model pricing',
            subtitle: 'Settings → Models, where these rates are entered by hand.',
            onPress: () => router.push('/settings/models'),
          },
        ]}
        onClose={() => setCostFor(null)}
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

      <Modal visible={configOpen && configDraft !== null} animationType="slide" transparent onRequestClose={closeConfig}>
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <View
            ref={configTrap}
            accessibilityViewIsModal
            style={{ maxHeight: '90%', backgroundColor: t.colors.bg, borderTopLeftRadius: t.radius.lg, borderTopRightRadius: t.radius.lg, padding: t.spacing.lg }}
          >
            {configDraft ? (
              <Stack gap="md">
                <Body size="lg" weight="700">Model controls</Body>
                <Field
                  label="Max output tokens"
                  value={configDraft.maxTokens}
                  onChangeText={(v) => setConfigDraft((d) => (d ? { ...d, maxTokens: v } : d))}
                  keyboardType="number-pad"
                  mono
                  {...(issueFor('maxTokens') ? { error: issueFor('maxTokens') } : {})}
                />
                <Field
                  label="Temperature"
                  value={configDraft.temperature}
                  onChangeText={(v) => setConfigDraft((d) => (d ? { ...d, temperature: v } : d))}
                  keyboardType="decimal-pad"
                  placeholder="Default"
                  mono
                  hint="0 to 2. Left blank, the gateway's own default is used."
                  {...(issueFor('temperature') ? { error: issueFor('temperature') } : {})}
                />
                {topPSupport.supported ? (
                  <Field
                    label="Top P"
                    value={configDraft.topP}
                    onChangeText={(v) => setConfigDraft((d) => (d ? { ...d, topP: v } : d))}
                    keyboardType="decimal-pad"
                    placeholder="Default"
                    mono
                    {...(issueFor('topP') ? { error: issueFor('topP') } : {})}
                  />
                ) : null}
                {/* Shown on the Anthropic path, where `top_k` is a real field, and
                    hidden on the OpenAI path rather than offered and silently
                    dropped — a control that does nothing is worse than no control. */}
                {topKSupport.supported ? (
                  <Field
                    label="Top K"
                    value={configDraft.topK}
                    onChangeText={(v) => setConfigDraft((d) => (d ? { ...d, topK: v } : d))}
                    keyboardType="number-pad"
                    placeholder="Default"
                    mono
                    hint="Anthropic only. Limits sampling to the K most likely tokens."
                  />
                ) : null}
                <SwitchRow label="Reasoning / thinking" value={configDraft.reasoningEnabled} onChange={(v) => setConfigDraft((d) => d ? { ...d, reasoningEnabled: v } : d)} />
                {configDraft.reasoningEnabled ? (
                  <>
                    <Segmented
                      label="Reasoning effort"
                      options={efforts.map((v) => ({ value: v as typeof configDraft.effort, label: v }))}
                      value={configDraft.effort}
                      onChange={(v) => setConfigDraft((d) => d ? { ...d, effort: v } : d)}
                    />
                    {issueFor('reasoningEffort') ? <Note tone="danger" live>{issueFor('reasoningEffort')}</Note> : null}
                    {profile?.kind === 'anthropic' ? <Stepper label="Thinking budget" value={configDraft.budgetTokens} onChange={(v) => setConfigDraft((d) => d ? { ...d, budgetTokens: v } : d)} step={1024} min={1024} max={127999} format={(v) => v.toLocaleString()} /> : null}
                    {issueFor('thinkingBudget') ? <Note tone="danger" live>{issueFor('thinkingBudget')}</Note> : null}
                  </>
                ) : null}
                {/* Warnings that belong to no single field, so they cannot be shown
                    under one. Errors are already under their control. */}
                {configIssues
                  .filter((issue) => issue.level === 'warning' && issue.message !== issueFor(issue.field))
                  .map((issue) => (
                    <Note key={`${issue.field}:${issue.message}`} tone="warning">
                      {issue.message}
                    </Note>
                  ))}
                <Note>These settings apply to the next message. Unsupported fields are omitted by the transport.</Note>
                <Stack gap="sm">
                  <Button
                    label="Save controls"
                    variant="primary"
                    full
                    disabled={configBlocked}
                    {...(configBlocked
                      ? { disabledReason: 'Fix the errors above first — the gateway would reject this combination.' }
                      : {})}
                    onPress={() => {
                    const d = configDraft;
                    const maxTokens = Number.parseInt(d.maxTokens, 10);
                    const temperature = Number.parseFloat(d.temperature);
                    const topP = Number.parseFloat(d.topP);
                    const topK = Number.parseInt(d.topK, 10);
                    void useChat.getState().setConfig(id, {
                      params: {
                        maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
                        ...(Number.isFinite(temperature) ? { temperature } : {}),
                        ...(Number.isFinite(topP) ? { topP } : {}),
                        ...(Number.isFinite(topK) ? { topK } : {}),
                      },
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
