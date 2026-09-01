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
import { Alert, Modal, PanResponder, Pressable, ScrollView, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { OfflineBadge, OfflineBanner } from '@/components/OfflineBanner';
import { CodeSandbox } from '@/components/CodeSandbox';
import { Glyph } from '@/components/Glyph';
import { useDialogKeys } from '@/components/dialog';
import { PromptSheet, Sheet } from '@/components/Sheet';
import { Sidebar } from '@/components/Sidebar';
import type { SidebarLink } from '@/components/Sidebar';
import type { SheetAction } from '@/components/Sheet';
import { CommandBar } from '@/components/chat/CommandBar';
import { Composer } from '@/components/chat/Composer';
import { MessageView } from '@/components/chat/MessageView';
import { ReferenceSheet } from '@/components/chat/ReferenceSheet';
import { StreamView } from '@/components/chat/StreamView';
import { VariantPager } from '@/components/chat/VariantPager';
import {
  Body,
  Button,
  Field,
  Inline,
  MIN_TARGET,
  Note,
  Segmented,
  Stack,
  Stepper,
  SwitchRow,
  useKeyboardHeight,
} from '@/components/ui';
import { formatStopSequences, hasBlockingIssue, mergeParams, parseStopSequences, validateConfig } from '@/chat/request';
import { replyReservation, sendConfirmation } from '@/chat/budget';
import { buildCommandIndex, buildMentionIndex, commandQuery, mentionQuery, rankCommands, replaceMention } from '@/chat/commands';
import type { CommandItem } from '@/chat/commands';
import { deleteGeneratedFile, listGeneratedFiles, shareGeneratedFile } from '@/chat/files';
import type { GeneratedFile } from '@/chat/files';
import { appendQuote, quoteMessage } from '@/chat/reference';
import { attachExistingFile, captureImage, openAppSettings, pickDocuments, pickImages } from '@/chat/attach';
import { documentCaveat, documentSupport, formatBytes, imageSupport, MAX_ATTACHMENTS_PER_MESSAGE } from '@/chat/attachments';
import { useMemory } from '@/stores/memory';
import type { ConfigIssue } from '@/chat/request';
import { parseTags } from '@/chat/list';
import { deliverExport } from '@/chat/deliver';
import type { DeliveryMethod } from '@/chat/deliver';
import type { ExportFormat } from '@/chat/export';
import { plural } from '@/chat/selection';
import { speakOrStop } from '@/chat/speech';
import { toUnifiedMessages } from '@/db/conversations';
import type { SearchHit, StoredMessage } from '@/db/conversations';
import * as haptics from '@/lib/haptics';
import { estimateMessagesTokens, estimateTextTokens, formatCost, formatTokens, estimateCost } from '@/lib/tokens';
import type { ContextPressure } from '@/lib/tokens';
import {
  useChat,
  useAttachments,
  useCanContinue,
  useContextNote,
  useConversation,
  useDraft,
  useMessages,
  useStream,
  useVariants,
} from '@/stores/chat';
import { useCalibration } from '@/stores/calibration';
import { capabilitiesFor, entryKey, pickableModelIds, useModels } from '@/stores/models';
import { useProviders } from '@/stores/providers';
import { useSettings } from '@/stores/settings';
import { useSkills } from '@/stores/skills';
import { useMcp } from '@/stores/mcp';
import { describeArguments } from '@/mcp/protocol';
import { usePrompts } from '@/stores/prompts';
import { useProjects } from '@/stores/projects';
import { fillPrompt, variablesIn } from '@/chat/prompts';
import type { Prompt as LibraryPrompt } from '@/chat/prompts';
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
  // Already includes the navigation bar on Android, so it replaces `insets.bottom`
  // while the keyboard is open rather than adding to it.
  const keyboardHeight = useKeyboardHeight();
  const { id } = useLocalSearchParams<{ id: string }>();

  const conversation = useConversation(id);
  const messages = useMessages(id);
  const stream = useStream(id);
  const draft = useDraft(id);
  const attachments = useAttachments(id);
  const variants = useVariants(id);
  const selectVariant = useChat((s) => s.selectVariant);

  const open = useChat((s) => s.open);
  const loadList = useChat((s) => s.loadList);
  const setDraft = useChat((s) => s.setDraft);
  const send = useChat((s) => s.send);
  const abort = useChat((s) => s.abort);
  const dismissError = useChat((s) => s.dismissError);
  const addAttachments = useChat((s) => s.addAttachments);
  const removeAttachment = useChat((s) => s.removeAttachment);
  const contextNote = useContextNote(id);
  const canContinue = useCanContinue(id);
  const continueTurn = useChat((s) => s.continueTurn);
  const dismissContextNote = useChat((s) => s.dismissContextNote);

  const profiles = useProviders((s) => s.profiles);
  const installedSkills = useSkills((s) => s.skills);
  const mcpServers = useMcp((s) => s.servers);
  const pendingApproval = useMcp((s) => s.pending[0] ?? null);
  const library = usePrompts((s) => s.prompts);
  const projects = useProjects((s) => s.projects);
  const entries = useModels((s) => s.entries);
  const showThinkingByDefault = useSettings((s) => s.showThinkingByDefault);
  const memoryEnabled = useSettings((s) => s.memoryEnabled);
  const contextStrategy = useSettings((s) => s.contextStrategy);
  const allowRunCode = useSettings((s) => s.allowRunCode);
  const devPanel = useSettings((s) => s.devPanelEnabled);

  const [loaded, setLoaded] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const [menuFor, setMenuFor] = useState<StoredMessage | null>(null);
  const [prompt, setPrompt] = useState<Prompt | null>(null);
  const [convMenu, setConvMenu] = useState(false);
  const [modelMenu, setModelMenu] = useState(false);
  const [profileMenu, setProfileMenu] = useState(false);
  const [skillMenu, setSkillMenu] = useState(false);
  const [serverMenu, setServerMenu] = useState(false);
  const [projectMenu, setProjectMenu] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** The template being filled in, and what has been typed for its variables. */
  /**
   * The fill-in form, as a request rather than a prompt.
   *
   * It started as `LibraryPrompt | null`, which meant the form could only ever fill a
   * template from the library. MCP prompts also declare arguments, and so does
   * anything else that needs a few strings before it can run, so the form now takes
   * the three things it actually needs: a title, the field names, and what to do with
   * the answers.
   */
  const [filling, setFilling] = useState<{
    title: string;
    fields: readonly string[];
    /** Which fields must be non-empty before Insert is available. */
    required?: readonly string[];
    insert: (values: Record<string, string>) => void;
  } | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [configOpen, setConfigOpen] = useState(false);
  const [costFor, setCostFor] = useState<StoredMessage | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [attachMenu, setAttachMenu] = useState(false);
  /** The collapsible history drawer. Collapsed is unmounted — see `Sidebar`. */
  const [sidebar, setSidebar] = useState(false);

  /**
   * Swipe in from the left edge to open the drawer.
   *
   * Up here with the state it drives rather than next to the strip it is attached to,
   * because the screen returns early while the conversation is still loading and a
   * hook after that return would not be called on every render.
   *
   * The drawer is opened on recognition rather than tracked under the finger: it
   * animates itself in over 240ms, so the panel is already moving before the thumb has
   * travelled much further, and following the finger here would mean reimplementing
   * the drawer's own gesture from the outside.
   */
  const edgePan = useMemo(
    () =>
      PanResponder.create({
        // Capture, for the same reason the drawer's own gesture captures: the strip sits
        // over a `FlashList`, and in the bubbling phase the list claims the drag first —
        // so the swipe-in worked only if the finger happened to start moving before the
        // list saw it. `dy` is checked so a diagonal scroll is still a scroll.
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          gesture.dx > 8 && Math.abs(gesture.dx) > Math.abs(gesture.dy) * 1.5,
        onPanResponderGrant: () => setSidebar(true),
      }),
    [],
  );
  const [reference, setReference] = useState(false);
  /** The generated-files sheet, and the one file whose actions are open. */
  const [filesOpen, setFilesOpen] = useState(false);
  const [files, setFiles] = useState<GeneratedFile[]>([]);
  const [fileFor, setFileFor] = useState<GeneratedFile | null>(null);
  const [referenceBusy, setReferenceBusy] = useState(false);
  /** What the last pick refused, and whether Settings is the only way to fix it. */
  const [attachNotes, setAttachNotes] = useState<{ notes: string[]; needsSettings: boolean } | null>(null);
  const [attachBusy, setAttachBusy] = useState(false);
  const [configDraft, setConfigDraft] = useState<{
    maxTokens: string;
    temperature: string;
    topP: string;
    topK: string;
    /** One sequence per line; see `parseStopSequences`. */
    stopSequences: string;
    reasoningEnabled: boolean;
    effort: 'minimal' | 'low' | 'medium' | 'high' | 'xhigh' | 'max';
    budgetTokens: number;
    /** The conversation's memory opt-out, inverted for the switch. */
    useMemory: boolean;
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

  // `@` offers generated files, so the list has to exist before the files sheet has
  // ever been opened. A turn is the only thing that produces one, which makes the
  // message count exactly the right trigger and not a poll.
  useEffect(() => {
    void listGeneratedFiles().then(setFiles);
  }, [messages.length]);

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
  // tokens and precisely when the warning matters. The conversation's own opt-out
  // counts too, or the gauge over-reads on the one chat that sends no memory.
  const conversationMemory = conversation?.config.memory;
  const memoryChars = useMemory((s) =>
    memoryEnabled && conversationMemory !== false ? (s.promptBlock().text?.length ?? 0) : 0,
  );

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
    const stopSequences = parseStopSequences(configDraft.stopSequences);
    return validateConfig({
      transport: profile.kind,
      capabilities,
      params: {
        maxTokens: Number.isFinite(maxTokens) ? maxTokens : 0,
        ...(Number.isFinite(temperature) ? { temperature } : {}),
        ...(Number.isFinite(topP) ? { topP } : {}),
        ...(Number.isFinite(topK) ? { topK } : {}),
        ...(stopSequences.length ? { stopSequences } : {}),
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

  const enabledServerNames = conversation?.config.servers;

  /**
   * Every MCP prompt the servers in this conversation advertise.
   *
   * Derived from the store's own `servers` array rather than read through
   * `getState()`, so the memo below actually re-runs when a server is switched on.
   */
  const mcpPromptsHere = useMemo(
    () => useMcp.getState().prompts(enabledServerNames),
    // `prompts()` reads `servers` off the store, so `mcpServers` is a real input even
    // though the body does not name it — without it this memo would never see a
    // server being switched on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mcpServers, enabledServerNames],
  );

  /**
   * Every command this conversation can run.
   *
   * Rebuilt when the material changes, not per keystroke: the index is a few hundred
   * strings and the ranking below runs on every character typed after the slash.
   */
  const commandItems = useMemo(
    () =>
      buildCommandIndex({
        prompts: library.map((entry) => ({ id: entry.id, title: entry.title, body: entry.body })),
        skills: installedSkills.map((skill) => ({ name: skill.name, description: skill.description })),
        mcpPrompts: mcpPromptsHere,
      }),
    [library, installedSkills, mcpPromptsHere],
  );

  const query = commandQuery(draft);
  const commandMatches = useMemo(
    () => (query === null ? [] : rankCommands(commandItems, query, 8)),
    [commandItems, query],
  );

  /** Everything an `@` can bring into this conversation. Same rows, same ranking. */
  const mentionItems = useMemo(
    () =>
      buildMentionIndex({
        files: files.map((file) => ({ name: file.name, uri: file.uri, hint: formatBytes(file.bytes) })),
        skills: installedSkills.map((skill) => ({ name: skill.name, description: skill.description })),
        // Keyed on the name, not the row id: `config.servers` stores names, so this is
        // the value the dispatch below has to put in it.
        servers: mcpServers.map((server) => ({ id: server.name, name: server.name, hint: server.url })),
      }),
    [files, installedSkills, mcpServers],
  );

  // Only one list can be open, and a command wins: the draft cannot be both `/x` and
  // a sentence ending in `@x`, but a query of `null` from either must not blank the
  // other's rows while it is being typed.
  const mention = query === null ? mentionQuery(draft) : null;
  const mentionMatches = useMemo(
    () => (mention === null ? [] : rankCommands(mentionItems, mention, 8)),
    [mentionItems, mention],
  );


  if (!loaded) {
    return (
      // The mark, not a bare spinner: this is the first frame after the splash on a
      // cold launch, and the splash is the same mark on the same colour, so anything
      // else here reads as a flash of a different app. The header is set explicitly so
      // the row above is empty rather than briefly carrying the previous screen's title.
      <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: t.spacing.md }}>
        <NavStack.Screen options={{ title: '', headerRight: () => null }} />
        <Glyph size={40} state="thinking" />
        <Body size="sm" tone="faint" live>
          Opening
        </Body>
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
      stopSequences: formatStopSequences(params.stopSequences),
      reasoningEnabled: reasoning?.enabled ?? false,
      effort: reasoning?.effort ?? 'medium',
      budgetTokens: reasoning?.budgetTokens ?? 16_384,
      useMemory: conversation.config.memory !== false,
    });
    setConvMenu(false);
    setConfigOpen(true);
  };

  /**
   * Send, with the one confirmation an over-window send owes the user.
   *
   * The pressure reading comes from the composer rather than being recomputed here:
   * the dialog quotes a number the user can see on the gauge, and computing it twice
   * is two chances for the two to disagree. {@link sendConfirmation} returns `null`
   * for every case that does not need asking — which is all of them except `warn`
   * at `over`, the one strategy that neither trims nor blocks.
   */
  const submit = (pressure: ContextPressure): void => {
    haptics.tap();
    const payload = { text: draft, ...(attachments.length ? { attachments: [...attachments] } : {}) };
    const ask = sendConfirmation(pressure, contextStrategy);
    if (!ask) {
      void send(id, payload);
      return;
    }
    Alert.alert(ask.title, ask.body, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Send anyway', onPress: () => void send(id, payload) },
    ]);
  };

  /** Switches chats without deepening the stack: the drawer is not a push. */
  const switchTo = (target: string): void => {
    setSidebar(false);
    if (target !== id) router.replace({ pathname: '/chat/[id]', params: { id: target } });
  };

  const startAnother = (): void => {
    void useChat
      .getState()
      .start()
      .then(switchTo)
      .catch((error: unknown) =>
        Alert.alert('Could not start a chat', error instanceof Error ? error.message : String(error)),
      );
  };

  /**
   * Puts a template into the draft.
   *
   * Appended rather than replacing: a draft with half a thought in it is the usual
   * reason to reach for a template, and losing that would be worse than a tidy
   * composer. A template with variables goes through the fill-in form first —
   * `fillPrompt` leaves an unfilled one visible, so nothing is silently blanked.
   */
  const insertPrompt = (prompt: LibraryPrompt, filled: Record<string, string>): void => {
    const text = fillPrompt(prompt.body, filled);
    setDraft(id, draft.trim() ? `${draft.trimEnd()}

${text}` : text);
    void usePrompts.getState().noteUsed(prompt.id);
    setFilling(null);
    setValues({});
    setLibraryOpen(false);
  };

  /**
   * Quotes a message from another conversation into this draft.
   *
   * The hit only carries a snippet — a one-line window around the match — so the
   * message itself is read out of the store, which loads it if this is the first
   * time that conversation has been opened. Quoting the snippet instead would put
   * half a sentence in the draft and call it a quote.
   */
  const bringIn = async (hit: SearchHit): Promise<void> => {
    if (referenceBusy) return;
    setReferenceBusy(true);
    try {
      await useChat.getState().open(hit.conversationId);
      const source = useChat.getState().messages[hit.conversationId]?.find((m) => m.id === hit.messageId);
      if (!source) {
        Alert.alert('That message is gone', 'It was deleted after the search ran.');
        return;
      }
      if (!source.text.trim()) {
        Alert.alert('Nothing to quote', 'That message is an attachment with no text of its own.');
        return;
      }
      setDraft(
        id,
        appendQuote(draft, quoteMessage({ title: hit.conversationTitle, role: source.role, text: source.text })),
      );
      setReference(false);
    } catch (error) {
      Alert.alert('Could not read that message', error instanceof Error ? error.message : String(error));
    } finally {
      setReferenceBusy(false);
    }
  };

  const confirmDelete = (message: StoredMessage): void => {    Alert.alert('Delete this message?', 'It is removed from the transcript and from the database.', [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => {
          haptics.warn();
          void useChat.getState().deleteMessage(id, message.id);
        },
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
        onPress: () => {
          haptics.confirm();
          void Clipboard.setStringAsync(message.text);
        },
      },
      {
        label: 'Read aloud',
        subtitle: message.text ? 'The system voice. Choose it again to stop.' : 'This message has no text to read.',
        disabled: !message.text,
        ...(message.text ? {} : { disabledReason: 'This message has no text to read.' }),
        onPress: () => void speakOrStop(message.text),
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
        onPress: () => {
          haptics.tap();
          void useChat.getState().regenerate(id, message.id);
        },
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
      // Last, and only for the person who switched it on: the ⋯ menu is where text is
      // copied from, not where an API payload is read.
      ...(devPanel && message.role === 'assistant'
        ? [
            {
              label: 'Developer details',
              subtitle: 'Raw request and response, tokens, latency, copy as curl.',
              onPress: () => router.push({ pathname: '/chat/inspect', params: { c: id, m: message.id } }),
            } satisfies SheetAction,
          ]
        : []),
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
          // Android offers no "sensitive" flag through expo-clipboard, and clearing
          // the clipboard on a timer would silently destroy whatever the user copied
          // next. So the persistence is stated instead of quietly worked around.
          outcome.method === 'copy' ? 'The clipboard holds it until you copy something else.' : null,
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
        ? 'PDFs go as documents; text, Word, Excel and PowerPoint files are read on device.'
        : 'Text, Word, Excel and PowerPoint files are read on device. PDFs are not available here.',
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

  const currentProject = projects.find((project) => project.id === conversation.projectId);

  /**
   * The ⋯ menu.
   *
   * Subtitles here are the *state* of the thing and nothing else — the model id, the
   * project it is in, which skills are on. The explanations that used to sit under
   * each row turned a menu of eleven choices into a wall of prose you had to read
   * past to find the one you came for, on the screen with the least room for it.
   * What each row does is what its label says.
   */
  const conversationActions: SheetAction[] = [
    {
      label: 'System prompt',
      subtitle: conversation.systemPrompt ? 'Set' : 'Not set',
      onPress: () => setPrompt({ kind: 'system' }),
    },
    { label: 'Model', subtitle: conversation.model, onPress: () => setModelMenu(true) },
    {
      // Present always, not only when the profile is missing: a conversation started
      // on the wrong gateway is a normal mistake, and this is where it is fixed.
      label: 'Provider profile',
      // The one subtitle that is not purely state: without a profile the conversation
      // cannot send at all, and the row is where that is discovered.
      subtitle: profile ? profile.name : 'Missing — pick one to send',
      onPress: () => setProfileMenu(true),
    },
    { label: 'Model controls', onPress: openModelControls },
    {
      // A toggle rather than a screen: it has one state, and burying a safety gate
      // behind another sheet is how it stops being used.
      label: conversation.config.planMode ? 'Plan mode: on — turn it off' : 'Plan mode: off — turn it on',
      onPress: () => void useChat.getState().setConfig(id, { planMode: !conversation.config.planMode }),
    },
    {
      label: 'Skills',
      subtitle:
        (conversation.config.skills ?? []).length > 0
          ? (conversation.config.skills ?? []).join(', ')
          : installedSkills.length
            ? 'None on'
            : 'None yet',
      onPress: () => setSkillMenu(true),
    },
    {
      label: 'MCP servers',
      subtitle:
        (conversation.config.servers ?? []).length > 0
          ? (conversation.config.servers ?? []).join(', ')
          : mcpServers.length
            ? 'None on'
            : 'None yet',
      onPress: () => setServerMenu(true),
    },
    {
      label: 'Project',
      subtitle: currentProject ? currentProject.name : projects.length ? 'Not in a project' : 'None yet',
      onPress: () => {
        void useProjects.getState().load();
        setProjectMenu(true);
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
    {
      label: 'Bring in a message…',
      onPress: () => setReference(true),
    },
    {
      label: 'Prompt library…',
      subtitle: library.length ? `${library.length} saved` : 'None yet',
      onPress: () => {
        void usePrompts.getState().load();
        setLibraryOpen(true);
      },
    },
    {
      label: 'Export…',
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

  // Toggles rather than a picker, and the sheet is left open: switching two skills
  // on is one visit, and the subtitle is the state — there is no `selected` in a
  // `SheetAction`, and a checkmark nobody can read to a screen reader would be worse
  // than the word.
  const enabledSkills = conversation.config.skills ?? [];
  const skillActions: SheetAction[] = installedSkills.map((skill) => {
    const on = enabledSkills.includes(skill.name);
    return {
      label: skill.name,
      subtitle: `${on ? 'On' : 'Off'} · ${skill.description}`,
      onPress: () =>
        void useChat.getState().setConfig(id, {
          skills: on ? enabledSkills.filter((name) => name !== skill.name) : [...enabledSkills, skill.name],
        }),
    };
  });

  // Same shape as the skills toggles: whole servers, not individual tools. Which
  // tools a server offers is its own setting and applies everywhere, so putting it
  // here as well would give two places to switch one thing off.
  const enabledServers = conversation.config.servers ?? [];
  const serverActions: SheetAction[] = mcpServers.map((server) => {
    const on = enabledServers.includes(server.name);
    const ready = server.enabled.length > 0;
    return {
      label: server.name,
      subtitle: ready
        ? `${on ? 'On' : 'Off'} · ${server.enabled.length} ${server.enabled.length === 1 ? 'tool' : 'tools'}`
        : 'No tools yet — connect it in Settings → MCP servers',
      ...(ready ? {} : { disabled: true, disabledReason: 'Nothing discovered yet.' }),
      onPress: () =>
        void useChat.getState().setConfig(id, {
          servers: on ? enabledServers.filter((name) => name !== server.name) : [...enabledServers, server.name],
        }),
    };
  });

  // "None" first and always present: taking a conversation out of a project has to be
  // as reachable as putting it in one, and it is the option a mis-tap needs.
  const projectActions: SheetAction[] = [
    {
      label: 'No project',
      subtitle: currentProject ? 'Takes this conversation out — the project itself stays' : 'Current',
      onPress: () => {
        void useChat.getState().setProject(id, undefined);
        setProjectMenu(false);
      },
    },
    ...projects.map((project) => ({
      label: project.name,
      subtitle:
        project.id === conversation.projectId
          ? 'Current'
          : project.knowledge.length
            ? `${project.knowledge.length} document${project.knowledge.length === 1 ? '' : 's'}`
            : 'Instructions only',
      onPress: () => {
        void useChat.getState().setProject(id, project.id);
        setProjectMenu(false);
      },
    })),
  ];

  const libraryActions: SheetAction[] = library.map((prompt) => {
    const variables = variablesIn(prompt.body);
    return {
      label: prompt.title,
      subtitle: variables.length ? `Fills in ${variables.join(', ')}` : prompt.body.replace(/\s+/g, ' ').slice(0, 60),
      onPress: () => {
        if (!variables.length) {
          insertPrompt(prompt, {});
          return;
        }
        setValues({});
        setFilling({
          title: prompt.title,
          fields: variables,
          insert: (filled) => insertPrompt(prompt, filled),
        });
        setLibraryOpen(false);
      },
    };
  });

  /* ---------------------------------------------------------------------- */
  /* Slash commands                                                          */
  /* ---------------------------------------------------------------------- */

  /** Loads the files list and opens the sheet. Refreshed every time — files move. */
  const openFiles = (): void => {
    void listGeneratedFiles().then(setFiles);
    setFilesOpen(true);
  };

  /**
   * Runs one command.
   *
   * The draft is cleared first in every branch: the `/word` the user typed is the
   * command, not part of the message, and leaving it in would mean every command
   * needed the user to delete it afterwards.
   */
  const runCommand = (item: CommandItem): void => {
    setDraft(id, '');
    switch (item.kind) {
      case 'app':
        switch (item.id) {
          case 'model':
            setModelMenu(true);
            return;
          case 'system':
            setPrompt({ kind: 'system' });
            return;
          case 'skills':
            setSkillMenu(true);
            return;
          case 'servers':
            setServerMenu(true);
            return;
          case 'controls':
            openModelControls();
            return;
          case 'files':
            openFiles();
            return;
          case 'export':
            setExportOpen(true);
            return;
          case 'reference':
            setReference(true);
            return;
          case 'attach':
            setAttachMenu(true);
            return;
          default:
            return;
        }

      case 'prompt': {
        const template = library.find((candidate) => candidate.id === item.id);
        if (!template) return;
        const variables = variablesIn(template.body);
        if (!variables.length) {
          insertPrompt(template, {});
          return;
        }
        setValues({});
        setFilling({
          title: template.title,
          fields: variables,
          insert: (filled) => insertPrompt(template, filled),
        });
        return;
      }

      // Turning it on rather than pasting its body: the body is what `invoke_skill`
      // loads on demand, and putting it in the draft would spend the tokens the whole
      // progressive-disclosure design exists to avoid.
      case 'skill':
        if (!enabledSkills.includes(item.id)) {
          void useChat.getState().setConfig(id, { skills: [...enabledSkills, item.id] });
        }
        return;

      case 'mcp-prompt': {
        const [serverId = '', name = ''] = item.id.split('::');
        const declared =
          useMcp
            .getState()
            .prompts(conversation.config.servers)
            .find((candidate) => candidate.serverId === serverId && candidate.name === name)?.arguments ?? [];
        if (!declared.length) {
          void runMcpPrompt(serverId, name, {});
          return;
        }
        setValues({});
        setFilling({
          title: name,
          fields: declared.map((argument) => argument.name),
          required: declared.filter((argument) => argument.required).map((argument) => argument.name),
          insert: (filled) => {
            setFilling(null);
            setValues({});
            void runMcpPrompt(serverId, name, filled);
          },
        });
        return;
      }

      default:
        return;
    }
  };

  /**
   * Completes one mention.
   *
   * The name goes back into the draft in every branch — a mention is part of the
   * sentence, so "summarise @report.md" has to still read as one. What varies is the
   * side effect: a file is staged as an attachment, a skill or a server is switched on
   * for the conversation. Deliberately the same dispatch a slash command uses for the
   * latter two, so `@files` and `/files` cannot come to mean different things.
   */
  const runMention = (item: CommandItem): void => {
    setDraft(id, replaceMention(useChat.getState().drafts[id] ?? '', item.name));

    switch (item.kind) {
      case 'file': {
        const file = files.find((candidate) => candidate.uri === item.id);
        if (!file) return;
        // Same admission path as the picker, including the size ceiling: a file this
        // app wrote is not exempt from what the request can carry.
        void runPick(() =>
          attachExistingFile(attachments, transport, caps, { uri: file.uri, name: file.name, size: file.bytes }),
        );
        return;
      }

      case 'skill':
        if (!enabledSkills.includes(item.id)) {
          void useChat.getState().setConfig(id, { skills: [...enabledSkills, item.id] });
        }
        return;

      case 'server': {
        const servers = conversation.config.servers ?? [];
        if (!servers.includes(item.id)) {
          void useChat.getState().setConfig(id, { servers: [...servers, item.id] });
        }
        return;
      }

      default:
        return;
    }
  };

  /**
   * Fetches an MCP prompt and puts it in the draft.
   *
   * Into the draft rather than straight into a send: a server-side template is
   * somebody else's text, and the user should read what they are about to say. A
   * failure is an alert rather than a silent no-op — the prompt came from a server
   * that may simply be unreachable.
   */
  const runMcpPrompt = async (
    serverId: string,
    name: string,
    args: Record<string, string>,
  ): Promise<void> => {
    const result = await useMcp.getState().getPrompt(serverId, name, args);
    if (result.isError) {
      Alert.alert('Could not load that prompt', result.content);
      return;
    }
    const current = useChat.getState().drafts[id] ?? '';
    setDraft(id, current.trim() ? `${current.trimEnd()}

${result.content}` : result.content);
  };

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

  /**
   * The app's other places, for the drawer.
   *
   * Built here rather than inside `Sidebar` because routing is the screen's job and
   * two of these are not routes at all — files is a sheet, and projects wants its
   * store loaded before the screen it lands on renders empty. The details are counts
   * already in hand; nothing here fetches to fill a subtitle.
   */
  const sidebarLinks: readonly SidebarLink[] = [
    {
      label: 'Projects',
      ...(currentProject ? { detail: currentProject.name } : projects.length ? { detail: String(projects.length) } : {}),
      onPress: () => {
        setSidebar(false);
        void useProjects.getState().load();
        router.push('/settings/projects');
      },
    },
    {
      label: 'Files',
      onPress: () => {
        setSidebar(false);
        openFiles();
      },
    },
    {
      label: 'Skills',
      ...(installedSkills.length ? { detail: String(installedSkills.length) } : {}),
      onPress: () => {
        setSidebar(false);
        router.push('/settings/skills');
      },
    },
    {
      label: 'Prompts',
      ...(library.length ? { detail: String(library.length) } : {}),
      onPress: () => {
        setSidebar(false);
        void usePrompts.getState().load();
        router.push('/settings/prompts');
      },
    },
    {
      label: 'Memory',
      ...(memoryEnabled ? {} : { detail: 'Off' }),
      onPress: () => {
        setSidebar(false);
        router.push('/settings/memory');
      },
    },
    {
      label: 'Usage',
      onPress: () => {
        setSidebar(false);
        router.push('/settings/usage');
      },
    },
  ];

  /* ---------------------------------------------------------------------- */

  return (
    // A plain View, not a `KeyboardAvoidingView`. That component's padding is
    // `frame.y + frame.height - keyboard.screenY`, where `frame` is its layout
    // *inside the navigator card* — so under a header it computes a lift short by
    // the header's height, which is the second half of "it moves, but not above
    // the keyboard". The composer's own `paddingBottom` below does the whole job
    // from the one number that is actually authoritative: `useKeyboardHeight()`.
    <View style={{ flex: 1 }}>
      <NavStack.Screen
        options={{
          title: conversation.title,
          // The model is the single most consequential thing about a conversation and
          // it was only visible two taps deep, in the ⋯ menu. Sending a long prompt
          // to the wrong one costs real money, so it is on screen.
          headerTitle: () => (
            // `minWidth: 0` so the two lines actually truncate instead of pushing the
            // header's own row wider than the ☰ and ⋯ leave room for.
            <View style={{ gap: 1, flexShrink: 1, minWidth: 0 }}>
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
          // Where the back arrow was. The app launches straight into a chat, so on
          // most launches there is nothing to go back to and the slot was empty;
          // when there is, the gesture and the hardware button still go back, and
          // the drawer's own "All chats" reaches the list either way.
          headerLeft: () => (
            <HeaderIcon
              glyph="☰"
              label="Chats"
              hint="Opens the list of your chats"
              onPress={() => setSidebar(true)}
            />
          ),
          headerRight: () => (
            <HeaderIcon glyph="⋯" label="Conversation options" onPress={() => setConvMenu(true)} />
          ),
        }}
      />

      <View style={{ flex: 1 }}>
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
              // The mark and one question, centred, the way the reference apps open: an
              // empty chat is not an error state and a bordered "Nothing here yet" card
              // read like one. The model is still named, because which model answers is
              // the one fact that changes what you should type.
              <View style={{ paddingTop: t.spacing.xxl * 2, alignItems: 'center', gap: t.spacing.md }}>
                <Glyph size={44} />
                <Body size="xl" style={{ fontFamily: t.serifFont, textAlign: 'center' }}>
                  What can we tackle together?
                </Body>
                <Body size="xs" tone="faint" style={{ textAlign: 'center' }}>
                  {conversation.model} answers below.
                </Body>
              </View>
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
                        onRetry: () => void useChat.getState().retryTurn(id),
                        // A rejected parameter is fixable, and the fix is in a sheet the
                        // banner can open. Without this the user has to guess which of
                        // the ⋯ entries owns `temperature`.
                        onEditRequest: openModelControls,
                      }
                    : {})}
                />
              </View>
            ) : (
              <VariantPager variants={variants} onSelect={(index) => void selectVariant(id, index)} />
            )
          }
        />

        {/* The drawer's edge. Last child, so it is above the list; a thumb's width
            rather than the transcript's padding, because the gesture has to be findable
            without looking — and the strip only recognises a horizontal drag, so a
            vertical scroll that starts inside it still scrolls. Over the transcript
            only: the composer's attach button is in the same corner. */}
        <View
          {...edgePan.panHandlers}
          style={{ position: 'absolute', left: 0, top: 0, bottom: 0, width: t.spacing.xl }}
        />
      </View>
      <View style={{ paddingBottom: keyboardHeight > 0 ? keyboardHeight : insets.bottom, gap: t.spacing.sm }}>
        {/* Above the composer rather than at the top of the screen: it is a
            statement about what will happen when you press send. */}
        <View style={{ paddingHorizontal: t.spacing.md }}>
          <OfflineBanner />
        </View>

        {/* Between the transcript and the composer: it is a menu over what is being
            typed, so it belongs against the input rather than over the conversation. */}
        <CommandBar items={commandMatches} onSelect={runCommand} />
        <CommandBar items={mentionMatches} onSelect={runMention} prefix="@" />
        <Composer
          value={draft}
          onChangeText={(text) => setDraft(id, text)}
          onSend={(pressure) => submit(pressure)}
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
          {...(contextNote !== undefined ? { contextNote } : {})}
          onDismissContextNote={() => dismissContextNote(id)}
          {...(canContinue && !streaming ? { onContinue: () => continueTurn(id) } : {})}
        />
      </View>

      <Sidebar
        visible={sidebar}
        currentId={id}
        links={sidebarLinks}
        onClose={() => setSidebar(false)}
        onOpen={switchTo}
        onNew={startAnother}
        onAllConversations={() => {
          setSidebar(false);
          // `navigate` rather than `push`: the list is a single place, not one more
          // copy of itself on top of the last one.
          router.navigate('/');
        }}
        onSettings={() => {
          setSidebar(false);
          router.push('/settings');
        }}
        onReference={() => {
          setSidebar(false);
          setReference(true);
        }}
      />

      {/* Files the model produced. Reopened rather than cached: `writePdf` can add one
          between two visits, and a stale list is a file the user cannot find. */}
      <Sheet
        visible={filesOpen}
        title="Files"
        subtitle={files.length ? `${files.length} ${plural(files.length, 'file')} in this app's storage` : undefined}
        body={
          files.length
            ? undefined
            : 'Nothing yet. Ask for a document — a report, a CSV, a PDF — and it will appear here.'
        }
        actions={files.map((file) => ({
          label: file.name,
          subtitle: formatBytes(file.bytes),
          onPress: () => {
            setFilesOpen(false);
            setFileFor(file);
          },
        }))}
        onClose={() => setFilesOpen(false)}
      />

      <Sheet
        visible={fileFor !== null}
        title={fileFor?.name ?? ''}
        subtitle={fileFor ? formatBytes(fileFor.bytes) : undefined}
        actions={
          fileFor
            ? [
                {
                  label: 'Share',
                  subtitle: 'Hands the file to another app, or saves it where you choose',
                  onPress: () => {
                    const target = fileFor;
                    setFileFor(null);
                    void shareGeneratedFile(target.uri).then((shared) => {
                      if (!shared) Alert.alert('Sharing is unavailable', 'This device has no share sheet.');
                    });
                  },
                },
                {
                  label: 'Delete',
                  destructive: true,
                  onPress: () => {
                    const target = fileFor;
                    Alert.alert('Delete this file?', `${target.name} cannot be recovered.`, [
                      { text: 'Cancel', style: 'cancel' },
                      {
                        text: 'Delete',
                        style: 'destructive',
                        onPress: () => {
                          deleteGeneratedFile(target.uri);
                          setFileFor(null);
                          void listGeneratedFiles().then(setFiles);
                        },
                      },
                    ]);
                  },
                },
              ]
            : []
        }
        onClose={() => setFileFor(null)}
      />

      <ReferenceSheet
        visible={reference}
        excludeConversationId={id}
        busy={referenceBusy}
        onPick={(hit) => void bringIn(hit)}
        onClose={() => setReference(false)}
      />

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

      <Sheet
        visible={skillMenu}
        title="Skills"
        body={
          installedSkills.length
            ? 'The names and descriptions of the skills switched on here go into this conversation’s prompt. The instructions themselves are sent only when the model asks for them.'
            : 'Skills are reusable instruction sets. Write or import one in Settings → Skills, then switch it on here.'
        }
        actions={
          installedSkills.length
            ? skillActions
            : [{ label: 'Open Settings → Skills', onPress: () => router.push('/settings/skills') }]
        }
        onClose={() => setSkillMenu(false)}
      />

      <Sheet
        visible={serverMenu}
        title="MCP servers"
        body={
          mcpServers.length
            ? 'Each server switched on here adds its enabled tools to this conversation’s requests. A call can stop and ask you first.'
            : 'An MCP server lends its tools over the network. Add one in Settings → MCP servers, then switch it on here.'
        }
        actions={
          mcpServers.length
            ? serverActions
            : [{ label: 'Open Settings → MCP servers', onPress: () => router.push('/settings/mcp') }]
        }
        onClose={() => setServerMenu(false)}
      />

      <Sheet
        visible={projectMenu}
        title="Project"
        body={
          projects.length
            ? 'A project’s instructions and documents are added to every turn of every conversation in it. Moving this conversation changes what the next message carries, not what has already been said.'
            : 'A project groups conversations around one piece of work and gives them shared instructions and documents. Make one in Settings → Projects.'
        }
        actions={
          projects.length
            ? projectActions
            : [{ label: 'Open Settings → Projects', onPress: () => router.push('/settings/projects') }]
        }
        onClose={() => setProjectMenu(false)}
      />

      {/* The approval gate. The turn is blocked on this answer, so it is not
          dismissible by tapping away: closing without deciding would leave the model
          waiting on a question nothing will ever answer. The arguments are shown in
          full, untruncated, because a shortened argument list is exactly where a
          surprising path or recipient would hide. */}
      <Sheet
        visible={pendingApproval !== null}
        title={pendingApproval ? `Run ${pendingApproval.tool}?` : ''}
        {...(pendingApproval ? { subtitle: `${pendingApproval.serverName} wants to run this with:` } : {})}
        {...(pendingApproval ? { body: describeArguments(pendingApproval.input) } : {})}
        actions={
          pendingApproval
            ? [
                { label: 'Allow once', onPress: () => useMcp.getState().resolve(pendingApproval.id, 'once') },
                {
                  label: 'Always allow this tool',
                  subtitle: 'Remembered until you change it in Settings → MCP servers',
                  onPress: () => useMcp.getState().resolve(pendingApproval.id, 'always'),
                },
                { label: 'Deny', destructive: true, onPress: () => useMcp.getState().resolve(pendingApproval.id, 'deny') },
                {
                  label: 'Never allow this tool',
                  destructive: true,
                  onPress: () => useMcp.getState().resolve(pendingApproval.id, 'never'),
                },
              ]
            : []
        }
        onClose={() => {
          if (pendingApproval) useMcp.getState().resolve(pendingApproval.id, 'deny');
        }}
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

      <Sheet
        visible={libraryOpen}
        title="Prompt library"
        body={
          library.length
            ? 'Inserted at the end of the draft. A template with {{variables}} asks for them first.'
            : 'Templates for the things you type often. Write one in Settings → Prompts.'
        }
        actions={
          library.length
            ? libraryActions
            : [{ label: 'Open Settings → Prompts', onPress: () => router.push('/settings/prompts') }]
        }
        onClose={() => setLibraryOpen(false)}
      />

      {/* The fill-in form. One field per variable, in the order they appear in the
          template, so the fields read in the order of the sentence they complete. */}
      <Modal
        visible={filling !== null}
        animationType="slide"
        transparent
        onRequestClose={() => setFilling(null)}
      >
        <View style={{ flex: 1, justifyContent: 'flex-end', backgroundColor: 'rgba(0,0,0,0.45)' }}>
          <View
            accessibilityViewIsModal
            style={{
              maxHeight: '90%',
              backgroundColor: t.colors.bg,
              borderTopLeftRadius: t.radius.lg,
              borderTopRightRadius: t.radius.lg,
              padding: t.spacing.lg,
            }}
          >
            {filling ? (
              <Stack gap="md">
                <Body size="lg" weight="700">
                  {filling.title}
                </Body>
                <ScrollView keyboardShouldPersistTaps="handled">
                  <Stack gap="md">
                    {filling.fields.map((name) => (
                      <Field
                        key={name}
                        label={name}
                        value={values[name] ?? ''}
                        onChangeText={(text) => setValues((current) => ({ ...current, [name]: text }))}
                        rows={2}
                      />
                    ))}
                  </Stack>
                </ScrollView>
                <Inline gap="md">
                  <Button
                    label="Insert"
                    disabled={(filling.required ?? filling.fields).some((name) => !values[name]?.trim())}
                    onPress={() => filling.insert(values)}
                  />
                  <Button label="Cancel" variant="ghost" onPress={() => setFilling(null)} />
                </Inline>
              </Stack>
            ) : null}
          </View>
        </View>
      </Modal>

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
                <Field
                  label="Stop sequences"
                  value={configDraft.stopSequences}
                  onChangeText={(v) => setConfigDraft((d) => (d ? { ...d, stopSequences: v } : d))}
                  rows={3}
                  mono
                  autoCapitalize="none"
                  autoCorrect={false}
                  placeholder={'One per line\nHuman:'}
                  hint="One per line. The reply stops before the sequence, and it is not included."
                  {...(issueFor('stopSequences') ? { error: issueFor('stopSequences') } : {})}
                />
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
                {/* An opt-out, which is why it is disabled rather than hidden when
                    memory is off app-wide: a switch that cannot grant what the
                    global setting withholds should say so, not vanish. */}
                <SwitchRow
                  label="Use long-term memory here"
                  value={memoryEnabled && configDraft.useMemory}
                  disabled={!memoryEnabled}
                  disabledReason="Memory is off for the whole app. Settings → Memory."
                  onChange={(v) => setConfigDraft((d) => (d ? { ...d, useMemory: v } : d))}
                />
                {memoryEnabled && !configDraft.useMemory ? (
                  <Note>
                    This conversation sends no memory block and contributes nothing back. What is already
                    remembered is kept.
                  </Note>
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
                    const stopSequences = parseStopSequences(d.stopSequences);
                    void useChat.getState().setConfig(id, {
                      params: {
                        maxTokens: Number.isFinite(maxTokens) ? maxTokens : undefined,
                        ...(Number.isFinite(temperature) ? { temperature } : {}),
                        ...(Number.isFinite(topP) ? { topP } : {}),
                        ...(Number.isFinite(topK) ? { topK } : {}),
                        // Written unconditionally: an emptied field has to clear the
                        // stored list, not leave the old one in place.
                        stopSequences,
                      },
                      // `undefined` rather than `true` for the ordinary case, so the
                      // stored config stays free of a key that means "the default".
                      memory: d.useMemory ? undefined : false,
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

      {/* One host per screen, not one per message: the queue in `@/chat/sandbox` is
          keyed by run id, so a second WebView would just be a second engine nobody
          routes to. Mounted only while the tool is switched on — an idle WebView is
          a process. */}
      {allowRunCode ? <CodeSandbox /> : null}
    </View>
  );
}

/**
 * A header button.
 *
 * A fixed square, centred, rather than a bare `<Text>`: the glyph grows with the
 * system font scale and a `<Text>` in the header slot grew with it, drifting off the
 * row and leaving a target smaller than a thumb at the default size. The box is the
 * platform minimum, the glyph is centred inside it whatever size it renders at, and
 * the negative margin keeps the *visual* edge where the header's own padding put it —
 * a 44dp box flush against the screen edge looks indented next to a 17dp glyph.
 */
function HeaderIcon({
  glyph,
  label,
  hint,
  onPress,
}: {
  glyph: string;
  label: string;
  hint?: string;
  onPress: () => void;
}) {
  const t = useTheme();
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      {...(hint !== undefined ? { accessibilityHint: hint } : {})}
      style={({ pressed }) => ({
        width: MIN_TARGET - 4,
        height: MIN_TARGET - 4,
        marginHorizontal: -t.spacing.sm,
        alignItems: 'center',
        justifyContent: 'center',
        borderRadius: t.radius.pill,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <Body size="lg" weight="700" style={{ lineHeight: t.fontSize.lg + 4 }}>
        {glyph}
      </Body>
    </Pressable>
  );
}
