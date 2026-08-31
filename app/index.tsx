/**
 * Home: the conversation list.
 *
 * The gateway status stays here as a banner rather than moving into Settings,
 * because "which profile am I about to spend credits on" is worth knowing before
 * every message rather than being buried two screens deep. It scrolls away with
 * the list header — visible on arrival, not permanently in the way.
 *
 * Search runs in two passes with different latencies, and the screen shows both
 * for what they are. Typing filters the loaded conversations immediately, on
 * title, preview, model and tags; a debounced full-text pass then adds message
 * hits underneath, each labelled with which index found it. A single merged
 * result list would hide the fact that one half is instant and the other is a
 * query — and that the slow half can find things the fast half structurally
 * cannot, like a word that only ever appeared in the middle of a reply.
 */

import { FlashList } from '@shopify/flash-list';
import { useFocusEffect, useRouter } from 'expo-router';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Alert, Pressable, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';

import { PromptSheet, Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import { OfflineBanner } from '@/components/OfflineBanner';
import { Glyph } from '@/components/Glyph';
import {
  Badge,
  Body,
  Button,
  Divider,
  Empty,
  Field,
  Heading,
  Inline,
  MIN_TARGET,
  Note,
  Spinner,
  verticalSlop,
} from '@/components/ui';
import { buildRows, filterConversations, parseTags, tagCounts } from '@/chat/list';
import type { ListRow } from '@/chat/list';
import { launchTarget } from '@/chat/launch';
import { deliverExport, gatherExport } from '@/chat/deliver';
import type { DeliveryMethod } from '@/chat/deliver';
import type { ExportFormat } from '@/chat/export';
import {
  archiveEffect,
  plural,
  pruneSelection,
  selectAll,
  summariseSelection,
  toggleSelected,
  describeDelete,
} from '@/chat/selection';
import { searchMessages } from '@/db/conversations';
import type { Conversation, SearchHit, TagMode } from '@/db/conversations';
import { splitOnMatches } from '@/db/search';
import { streamingAvailable } from '@/lib/gateway';
import { whenBucket } from '@/lib/when';
import { useChat } from '@/stores/chat';
import { useProjects } from '@/stores/projects';
import { useProviders } from '@/stores/providers';
import { useReachability } from '@/stores/reachability';
import { useTheme } from '@/theme';

/**
 * Whether this process has already been sent to a chat on launch.
 *
 * Module scope, not state: the redirect is a property of the app having just
 * started, and this screen mounts again every time the user comes back to the
 * list from a chat. A flag inside the component would fire on each of those and
 * make the list unreachable.
 */
let launched = false;

/** How long to wait after the last keystroke before hitting the database. */
const SEARCH_DEBOUNCE_MS = 250;
/** One character matches most of the corpus; two is where a query means something. */
const MIN_SEARCH_LENGTH = 2;
/** A stable empty result, so "no hits" does not count as a change. */
const NO_HITS: readonly SearchHit[] = [];

/** The greeting reads the clock rather than the calendar; nothing depends on it. */
function greeting(at: number): string {
  const hour = new Date(at).getHours();
  if (hour < 5) return 'Still up';
  if (hour < 12) return 'Good morning';
  if (hour < 18) return 'Good afternoon';
  return 'Good evening';
}

type Row = ListRow | { kind: 'hit'; key: string; hit: SearchHit };

function shortWhen(at: number, now: number): string {
  const date = new Date(at);
  if (whenBucket(at, now) === 'today') {
    return date.toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
  }
  return date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

/** A snippet with the query's terms marked. Nested `Text` is how RN does this. */
function Highlighted({ text, query }: { text: string; query: string }) {
  const t = useTheme();
  const parts = useMemo(() => splitOnMatches(text, query), [text, query]);
  return (
    <Text style={{ color: t.colors.textDim, fontSize: t.fontSize.sm }} numberOfLines={2}>
      {parts.map((part, index) => (
        <Text
          key={`${index}:${part.text}`}
          style={part.match ? { color: t.colors.text, fontWeight: '700' } : null}
        >
          {part.text}
        </Text>
      ))}
    </Text>
  );
}

/**
 * The selection affordance, drawn rather than imported.
 *
 * A filled ring with a tick, sized to read at a glance from the same distance as
 * the row's own glyph. It replaces the mark in the leading slot rather than
 * sitting beside it: two circles a few pixels apart, one meaningful and one
 * decorative, is the version of this that gets mis-tapped.
 */
function SelectMark({ on }: { on: boolean }) {
  const t = useTheme();
  return (
    <View
      style={{
        width: 20,
        height: 20,
        borderRadius: 10,
        marginTop: 2,
        alignItems: 'center',
        justifyContent: 'center',
        borderWidth: 1.5,
        borderColor: on ? t.colors.accentFill : t.colors.border,
        backgroundColor: on ? t.colors.accentFill : 'transparent',
      }}
    >
      {on ? (
        <Text style={{ color: t.colors.bg, fontSize: 12, lineHeight: 14, fontWeight: '900' }}>✓</Text>
      ) : null}
    </View>
  );
}

function ConversationRow({
  conversation,
  now,
  query,
  selecting,
  selected,
  onOpen,
  onMenu,
}: {
  conversation: Conversation;
  now: number;
  query: string;
  selecting: boolean;
  selected: boolean;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const t = useTheme();
  const preview = conversation.preview ?? '';

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onMenu}
      delayLongPress={300}
      // A checkbox while selecting, a button otherwise. The role is what a screen
      // reader uses to decide whether to announce a checked state at all, so
      // leaving it as `button` in selection mode makes the mode invisible to
      // anyone not looking at the ring.
      accessibilityRole={selecting ? 'checkbox' : 'button'}
      {...(selecting ? { accessibilityState: { checked: selected } } : {})}
      accessibilityHint={selecting ? 'Toggles selection' : 'Long press for options, or to select'}
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.md,
        gap: t.spacing.md,
        backgroundColor: pressed
          ? t.colors.surfaceActive
          : selected
            ? t.colors.surface
            : 'transparent',
      })}
    >
      {/* The mark rather than initials: two letters cut out of a title said less than
          the title itself, which is on the next line anyway. Pinned rows carry it in
          clay, which is the only thing on this screen that needs picking out. */}
      {selecting ? (
        <SelectMark on={selected} />
      ) : (
        <Glyph
          size={18}
          color={conversation.pinned ? t.colors.accentFill : t.colors.textFaint}
          style={{ marginTop: 3 }}
        />
      )}


      <View style={{ flex: 1, gap: 3, minWidth: 0 }}>
        <Inline gap="sm">
          {conversation.pinned ? <Badge label="Pinned" tone="accent" /> : null}
          <Body weight="600" numberOfLines={1} style={{ flex: 1 }}>
            {conversation.title}
          </Body>
          <Body size="xs" tone="faint" mono>
            {shortWhen(conversation.updatedAt, now)}
          </Body>
        </Inline>

        {preview ? (
          query ? (
            <Highlighted text={preview} query={query} />
          ) : (
            <Body size="sm" tone="dim" numberOfLines={2}>
              {preview}
            </Body>
          )
        ) : (
          <Body size="sm" tone="faint">
            No messages yet
          </Body>
        )}

        <Inline gap="xs">
          <Body size="xs" tone="faint" mono numberOfLines={1} style={{ flexShrink: 1 }}>
            {conversation.model}
          </Body>
          {conversation.messageCount ? (
            <Body size="xs" tone="faint">
              {`${conversation.messageCount} message${conversation.messageCount === 1 ? '' : 's'}`}
            </Body>
          ) : null}
          {conversation.forkedFromId ? <Badge label="Fork" tone="neutral" /> : null}
          {conversation.tags.slice(0, 3).map((tag) => (
            <Badge key={tag} label={tag} tone="neutral" />
          ))}
          {conversation.tags.length > 3 ? <Badge label={`+${conversation.tags.length - 3}`} tone="neutral" /> : null}
        </Inline>
      </View>
    </Pressable>
  );
}

export default function Home() {
  const t = useTheme();
  const router = useRouter();
  const insets = useSafeAreaInsets();

  const conversations = useChat((s) => s.conversations);
  const listLoading = useChat((s) => s.listLoading);
  const listLoadingMore = useChat((s) => s.listLoadingMore);
  const listError = useChat((s) => s.listError);
  const loadList = useChat((s) => s.loadList);
  const loadMore = useChat((s) => s.loadMore);

  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const failover = useProviders((s) => s.activeFailover);
  const refreshKeyStatus = useProviders((s) => s.refreshKeyStatus);
  const reach = useReachability((s) => s.status);
  const projects = useProjects((s) => s.projects);
  const projectCounts = useProjects((s) => s.counts);

  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [projectId, setProjectId] = useState<string | undefined>(undefined);
  const [found, setFound] = useState<{ query: string; tag?: string; projectId?: string; hits: SearchHit[] } | null>(
    null,
  );
  const [menuFor, setMenuFor] = useState<Conversation | null>(null);
  const [prompt, setPrompt] = useState<{ kind: 'rename' | 'tags'; conversation: Conversation } | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);
  const [starting, setStarting] = useState(false);
  /** True until the launch redirect below has fired, or given up. */
  const [redirecting, setRedirecting] = useState(!launched);
  /**
   * Whether the list is showing the archive.
   *
   * Two lists rather than one list with the archived rows dimmed in it: the point of
   * archiving is that the row is gone from the place you were looking.
   */
  const [showArchived, setShowArchived] = useState(false);
  /**
   * The bulk-select state: a set of ids, and `null` for "not selecting".
   *
   * `null` rather than an empty set, because "selection mode with nothing
   * selected" is a real and necessary state — it is what you are in immediately
   * after tapping Select — and collapsing it into "not selecting" would make the
   * mode exit itself the moment you deselected the last row.
   */
  const [selected, setSelected] = useState<Set<string> | null>(null);
  const [bulkSheet, setBulkSheet] = useState(false);
  const [bulkTag, setBulkTag] = useState<TagMode | null>(null);
  const [bulkBusy, setBulkBusy] = useState(false);
  /**
   * The conversations an open export sheet would write, and their titles.
   *
   * Ids are captured when the sheet opens rather than read when a format is
   * tapped, so a list that reloads underneath — the focus effect does that — can
   * not change what the sheet is about to export halfway through the decision.
   */
  const [exportFor, setExportFor] = useState<{ ids: string[]; label: string } | null>(null);
  const [exportBusy, setExportBusy] = useState(false);

  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];

  // Results carry the query *and the tag* that produced them, and both "which hits"
  // and "still searching" are derived from that one comparison. Storing them
  // separately is how you end up rendering the previous query's hits under the
  // current query's text; leaving the tag out is how you end up showing hits from
  // outside the tag you just picked.
  const trimmed = query.trim();
  const searchable = trimmed.length >= MIN_SEARCH_LENGTH;
  const fresh = found?.query === trimmed && found?.tag === tag && found?.projectId === projectId;
  // Memoised for its identity, not its cost: the row list below depends on it, and a
  // fresh `[]` each render would rebuild every row on every keystroke.
  const hits = useMemo(() => (searchable && fresh && found ? found.hits : NO_HITS), [searchable, fresh, found]);
  const searching = searchable && !fresh;

  // Re-read on focus: a conversation opened and replied to changes its preview and
  // its place in the order, and both are computed by the query rather than locally.
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      void useProjects.getState().load();
      void loadList({ archived: showArchived, ...(projectId ? { projectId } : {}) });
    }, [loadList, showArchived, projectId]),
  );

  // SecureStore is the source of truth for whether a key exists; the store only
  // caches it. Re-reading keeps the badge honest after an OS-level wipe or a
  // restore from backup, where the Keystore entry can vanish under us.
  useEffect(() => {
    if (keyChecked || !active) return;
    void refreshKeyStatus(active.id).finally(() => setKeyChecked(true));
  }, [active, keyChecked, refreshKeyStatus]);

  // Debounced, and cancelled on every keystroke, so a fast typist runs one query
  // rather than one per character. Nothing is written synchronously here: a short
  // query simply has no matching `found` entry, so the derivation above yields no
  // hits without an effect having to clear anything.
  useEffect(() => {
    if (!searchable) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      // The tag and project filters belong in the query, not on top of the results:
      // the hits are message rows, so there is nothing tag- or project-shaped to
      // filter them by afterwards.
      const filters = { ...(tag ? { tag } : {}), ...(projectId ? { projectId } : {}) };
      void searchMessages(trimmed, filters)
        .then((rows) => {
          if (!cancelled) setFound({ query: trimmed, ...filters, hits: rows });
        })
        .catch(() => {
          // The list above is still correct; a failed full-text pass should not
          // blank the screen. `searchMessages` has already logged it. Recording an
          // empty result against this query stops it retrying on every render.
          if (!cancelled) setFound({ query: trimmed, ...filters, hits: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchable, tag, projectId]);

  const filtered = useMemo(
    () => filterConversations(conversations, { query, ...(tag ? { tag } : {}) }),
    [conversations, query, tag],
  );

  const tags = useMemo(() => tagCounts(conversations), [conversations]);

  const selecting = selected !== null;

  /**
   * The selection as it applies to what is actually on screen.
   *
   * Derived rather than pruned in an effect. The raw `selected` set can hold ids
   * that have since left the list — archiving a selection is the ordinary way
   * that happens — and every consumer below reads this instead, so a bulk action
   * can never reach a conversation the user cannot see. Pruning in an effect
   * would do the same thing one render later, which is one render in which the
   * count on the button and the rows it would touch disagree.
   */
  const picked = useMemo(
    () => (selected === null ? null : pruneSelection(selected, filtered)),
    [selected, filtered],
  );
  const summary = useMemo(
    () => summariseSelection(picked ?? new Set<string>(), filtered),
    [picked, filtered],
  );

  const exitSelection = useCallback(() => setSelected(null), []);

  /** What the rows read from the closure rather than from `data`. See `extraData`. */
  const rowContext = useMemo(() => ({ now, picked }), [now, picked]);

  const rows = useMemo<Row[]>(() => {
    const out: Row[] = buildRows(filtered, now);
    // Message hits go last, and only while searching: they answer a different
    // question ("where did I say that") than the list above.
    if (hits.length) {
      out.push({ kind: 'header', key: 'header:hits', label: 'In messages', count: hits.length });
      for (const hit of hits) out.push({ kind: 'hit', key: `hit:${hit.messageId}`, hit });
    }
    return out;
  }, [filtered, now, hits]);

  const openConversation = useCallback(
    (id: string) => router.push({ pathname: '/chat/[id]', params: { id } }),
    [router],
  );

  const startConversation = useCallback(async () => {
    if (starting) return;
    setStarting(true);
    try {
      // Started inside whatever project is being shown: the filter is the answer to
      // "which work am I looking at", and a new chat started from that view belongs
      // to it. Nothing is picked when the filter is off.
      const id = await useChat.getState().start(projectId ? { projectId } : undefined);
      openConversation(id);
    } catch (error) {
      Alert.alert('Could not start a conversation', error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [openConversation, starting, projectId]);

  /**
   * The launch redirect: the app opens on a chat, not on this list.
   *
   * It reuses the newest empty conversation rather than creating one per launch —
   * see {@link launchTarget} — and it runs once per process, so coming back here
   * from a chat shows the list instead of bouncing straight out of it again.
   *
   * A failure leaves the list on screen with its own error banner. Landing on a
   * usable history is a better answer to "the database would not open" than a
   * spinner that never resolves.
   */
  useEffect(() => {
    if (launched) return;
    launched = true;
    let cancelled = false;
    void (async () => {
      try {
        await useChat.getState().loadList({ archived: false });
        const existing = launchTarget(useChat.getState().conversations);
        const target = existing ?? (await useChat.getState().start());
        if (!cancelled) router.replace({ pathname: '/chat/[id]', params: { id: target } });
      } catch {
        if (!cancelled) setRedirecting(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [router]);

  /**
   * Delete, but only after offering the reversible version of the same wish.
   *
   * Deleting a conversation destroys every message in it and there is no undo, so
   * the first thing the dialog offers is archiving — which is what "get this out of
   * my list" actually means most of the time. Delete stays, one tap further away and
   * still marked destructive.
   */
  const confirmDelete = (conversation: Conversation): void => {
    Alert.alert(
      'Delete this conversation?',
      `"${conversation.title}" and every message in it. This cannot be undone — archiving keeps it and takes it out of the list.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Archive instead',
          onPress: () => void archive(conversation, true),
        },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: () => void useChat.getState().remove(conversation.id),
        },
      ],
    );
  };

  /**
   * Archive or restore, with the reverse offered straight away.
   *
   * The undo is a toast-shaped `Alert` rather than a real snackbar because that is
   * the confirmation mechanism this app already has; it is honest about what
   * happened and one tap from putting it back.
   */
  const archive = async (conversation: Conversation, archived: boolean): Promise<void> => {
    await useChat.getState().setArchived(conversation.id, archived);
    Alert.alert(
      archived ? 'Archived' : 'Restored',
      archived
        ? `"${conversation.title}" is out of the list. Nothing was deleted — it is under Archived.`
        : `"${conversation.title}" is back in the list.`,
      [
        { text: 'OK', style: 'cancel' },
        { text: 'Undo', onPress: () => void useChat.getState().setArchived(conversation.id, !archived) },
      ],
    );
  };

  const menuActions = (conversation: Conversation): SheetAction[] => [
    { label: 'Open', onPress: () => openConversation(conversation.id) },
    { label: 'Rename', subtitle: conversation.title, onPress: () => setPrompt({ kind: 'rename', conversation }) },
    {
      label: 'Tags',
      subtitle: conversation.tags.length ? conversation.tags.join(', ') : 'None',
      onPress: () => setPrompt({ kind: 'tags', conversation }),
    },
    {
      label: conversation.pinned ? 'Unpin' : 'Pin to the top',
      onPress: () => void useChat.getState().setPinned(conversation.id, !conversation.pinned),
    },
    {
      label: conversation.archived ? 'Restore from the archive' : 'Archive',
      subtitle: conversation.archived
        ? 'Puts it back in the list.'
        : 'Keeps every message; takes the row out of this list.',
      onPress: () => void archive(conversation, !conversation.archived),
    },
    {
      label: 'Export…',
      subtitle: 'Markdown or JSON. Attachments and keys are left out.',
      onPress: () => setExportFor({ ids: [conversation.id], label: conversation.title }),
    },
    {
      label: 'Select…',
      subtitle: 'Act on several conversations at once.',
      onPress: () => setSelected(new Set([conversation.id])),
    },
    { label: 'Delete', destructive: true, onPress: () => confirmDelete(conversation) },
  ];

  /* ---------------------------------------------------------------- bulk ---- */

  /**
   * Runs a bulk action and reports what it did, not what was asked.
   *
   * The count comes back from the store, which gets it from the statement's own
   * `changes` — so a selection that was partly stale reports the truth rather
   * than the size of the selection. Selection mode is left on success only: a
   * failed action leaves the selection intact so it can be retried without
   * re-tapping twelve rows.
   */
  const runBulk = async (label: string, action: () => Promise<number>): Promise<void> => {
    if (bulkBusy) return;
    setBulkBusy(true);
    try {
      const affected = await action();
      exitSelection();
      Alert.alert(label, affected === 0 ? 'Nothing changed.' : `${plural(affected, 'conversation')}.`);
    } catch (error) {
      Alert.alert(`Could not ${label.toLowerCase()}`, error instanceof Error ? error.message : String(error));
    } finally {
      setBulkBusy(false);
    }
  };

  const bulkArchive = (archived: boolean): void => {
    const ids = [...(picked ?? [])];
    const { changing, already } = archiveEffect(summary, archived);
    if (changing === 0) {
      Alert.alert(
        archived ? 'Already archived' : 'Not archived',
        `All ${plural(already, 'selected conversation')} ${already === 1 ? 'is' : 'are'} already ${archived ? 'in the archive' : 'in the list'}.`,
      );
      return;
    }
    void runBulk(archived ? 'Archived' : 'Restored', () => useChat.getState().archiveMany(ids, archived));
  };

  /**
   * Bulk delete, behind the same offer the single-row version makes.
   *
   * Archiving is the first option because it is the reversible version of the
   * same wish, and at this scale that matters more than it does for one row: a
   * mis-tapped bulk delete destroys a selection nobody can reconstruct. The body
   * text comes from `describeDelete`, which names the message count — twelve rows
   * can be four thousand messages, and the row count alone systematically
   * understates what is about to go.
   */
  const bulkDelete = (): void => {
    const ids = [...(picked ?? [])];
    if (!ids.length) return;
    Alert.alert(`Delete ${plural(summary.count, 'conversation')}?`, describeDelete(summary), [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Archive instead',
        onPress: () => void runBulk('Archived', () => useChat.getState().archiveMany(ids, true)),
      },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void runBulk('Deleted', () => useChat.getState().removeMany(ids)),
      },
    ]);
  };

  /* -------------------------------------------------------------- export ---- */

  /**
   * Builds an export and hands it to the clipboard or the share sheet.
   *
   * The confirmation names the size, because sharing a transcript sends it
   * somewhere the app cannot see afterwards and "12 conversations, 480 kB" is the
   * last chance to notice that is more than was intended. It also states that
   * keys were not included — a promise the exporter's own gating test enforces
   * rather than one this dialog is trusted on.
   */
  const runExport = async (format: ExportFormat, method: DeliveryMethod): Promise<void> => {
    const target = exportFor;
    if (!target || exportBusy) return;
    setExportBusy(true);
    try {
      const inputs = await gatherExport(target.ids);
      if (!inputs.length) {
        Alert.alert('Nothing to export', 'Those conversations are no longer here.');
        return;
      }
      const outcome = await deliverExport(inputs, format, method);
      setExportFor(null);
      exitSelection();
      if (!outcome.delivered) return;
      const kb = Math.max(1, Math.round(outcome.result.bytes / 1024));
      Alert.alert(
        outcome.method === 'copy' ? 'Copied' : 'Shared',
        [
          `${plural(inputs.length, 'conversation')}, ${plural(outcome.result.messages, 'message')}, ${kb} kB.`,
          outcome.fellBackToClipboard
            ? 'Too large for the share sheet, so it went to the clipboard instead — paste it wherever you meant to send it.'
            : null,
          'Attachments and API keys are not included.',
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

  const bulkActions: SheetAction[] = [
    {
      label: showArchived ? 'Restore from the archive' : 'Archive',
      subtitle: `${plural(archiveEffect(summary, !showArchived).changing, 'conversation')} would move. Nothing is deleted.`,
      onPress: () => bulkArchive(!showArchived),
    },
    { label: 'Add tags', subtitle: 'Keeps the tags they already have.', onPress: () => setBulkTag('add') },
    {
      label: 'Replace tags',
      subtitle: summary.tags.length ? `Discards: ${summary.tags.join(', ')}` : 'They carry no tags yet.',
      onPress: () => setBulkTag('replace'),
    },
    ...(summary.tags.length
      ? [{ label: 'Remove tags', subtitle: summary.tags.join(', '), onPress: () => setBulkTag('remove') } as SheetAction]
      : []),
    {
      label: 'Export…',
      subtitle: `${plural(summary.messages, 'message')} across ${plural(summary.count, 'conversation')}.`,
      onPress: () => setExportFor({ ids: [...(picked ?? [])], label: `${plural(summary.count, 'conversation')}` }),
    },
    {
      label: `Delete ${plural(summary.count, 'conversation')}`,
      subtitle: `${plural(summary.messages, 'message')} would go with them.`,
      destructive: true,
      onPress: bulkDelete,
    },
  ];

  /**
   * The bar that replaces the New-conversation footer while selecting.
   *
   * It replaces rather than joins it: starting a new conversation mid-selection
   * would navigate away and silently discard the selection, so the button is not
   * offered. Cancel is on the left, where a back gesture would be.
   */
  const selectionBar = (
    <View style={{ gap: t.spacing.sm }}>
      <Inline gap="sm">
        <Body weight="600" style={{ flex: 1 }}>
          {summary.count === 0 ? 'Select conversations' : `${plural(summary.count, 'selected', 'selected')}`}
        </Body>
        {summary.count ? (
          <Body size="xs" tone="faint" mono>
            {plural(summary.messages, 'message')}
          </Body>
        ) : null}
      </Inline>
      <Inline gap="sm">
        <Button label="Cancel" size="sm" onPress={exitSelection} />
        <Button
          label={summary.count === filtered.length && filtered.length > 0 ? 'None' : 'All'}
          size="sm"
          onPress={() =>
            setSelected(summary.count === filtered.length && filtered.length > 0 ? new Set() : selectAll(filtered))
          }
        />
        <View style={{ flex: 1 }} />
        <Button
          label={bulkBusy ? 'Working…' : 'Actions'}
          variant="primary"
          size="sm"
          busy={bulkBusy}
          disabled={summary.count === 0}
          onPress={() => setBulkSheet(true)}
        />
      </Inline>
    </View>
  );

  const renderItem = useCallback(
    ({ item }: { item: Row }) => {
      if (item.kind === 'header') {
        return (
          <View
            style={{
              paddingHorizontal: t.spacing.md,
              paddingTop: t.spacing.md,
              paddingBottom: t.spacing.xs,
              backgroundColor: t.colors.bg,
            }}
          >
            <Body size="xs" tone="faint" weight="700">
              {`${item.label.toUpperCase()} · ${item.count}`}
            </Body>
          </View>
        );
      }

      if (item.kind === 'hit') {
        const hit = item.hit;
        return (
          <Pressable
            onPress={() => openConversation(hit.conversationId)}
            accessibilityRole="button"
            style={({ pressed }) => ({
              paddingHorizontal: t.spacing.md,
              paddingVertical: t.spacing.sm,
              gap: 2,
              backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
            })}
          >
            <Inline gap="sm">
              <Body size="sm" weight="600" numberOfLines={1} style={{ flexShrink: 1 }}>
                {hit.conversationTitle}
              </Body>
              <Badge label={hit.role === 'user' ? 'You' : 'Reply'} tone="neutral" />
              {/* Which pass found it: an FTS hit is a word match, a LIKE hit is a
                  substring the index could not have found. */}
              <Badge label={hit.via === 'fts' ? 'index' : 'scan'} tone="neutral" />
              <Body size="xs" tone="faint" mono>
                {shortWhen(hit.createdAt, now)}
              </Body>
            </Inline>
            <Highlighted text={hit.snippet} query={query} />
          </Pressable>
        );
      }

      return (
        <ConversationRow
          conversation={item.conversation}
          now={now}
          query={query}
          selecting={selecting}
          selected={picked?.has(item.conversation.id) ?? false}
          // While selecting, a tap toggles instead of opening. Long press *enters*
          // selection with that row already picked, which is the gesture every
          // list on this platform uses and the reason there is no permanent
          // Select button competing with the search field.
          onOpen={() =>
            selecting
              ? setSelected((current) => toggleSelected(current ?? new Set(), item.conversation.id))
              : openConversation(item.conversation.id)
          }
          onMenu={() =>
            selecting
              ? setSelected((current) => toggleSelected(current ?? new Set(), item.conversation.id))
              : setMenuFor(item.conversation)
          }
        />
      );
    },
    [t, now, query, openConversation, selecting, picked],
  );

  const banner = (
    <View style={{ gap: t.spacing.sm, paddingHorizontal: t.spacing.md, paddingTop: t.spacing.sm }}>
      {active ? (
        <Pressable
          onPress={() => router.push('/settings')}
          accessibilityRole="button"
          accessibilityHint="Opens Settings"
          style={{ gap: t.spacing.xs }}
        >
          <Inline gap="sm">
            <Body weight="600">{active.name}</Body>
            {active.hasKey ? (
              <Badge label={`Key ${active.keyFingerprint}`} tone="success" />
            ) : (
              <Badge label="No key" tone="danger" />
            )}
            <Badge label={active.kind === 'anthropic' ? '/v1/messages' : '/chat/completions'} tone="accent" />
            {streamingAvailable() ? null : <Badge label="No streaming" tone="warning" />}
          </Inline>
          <Body size="xs" tone="faint" mono numberOfLines={1}>
            {`${active.baseUrl} · ${active.defaultModel}`}
          </Body>
        </Pressable>
      ) : (
        <Note tone="danger">No provider profiles. Open Settings → Providers and add one.</Note>
      )}

      {/* Above the per-profile notes: if the gateway cannot be reached at all, the
          missing key three lines down is not the problem to go and fix first. */}
      <OfflineBanner />

      {active && !active.hasKey ? (
        <Note tone="danger">
          No API key saved for this profile. Requests will come back 401, which this gateway also uses for a
          rejected client — so save the token first to keep the two apart.
        </Note>
      ) : null}

      {failover ? (
        <Note tone="warning">
          {`Failed over to ${failover.to} — ${failover.from} was unreachable. New requests use the backup until you switch back.`}
        </Note>
      ) : null}

      {listError ? <Note tone="danger" mono>{listError}</Note> : null}

      {/* The archive switch. A chip rather than a `SwitchRow` because it belongs
          beside the tag filter — it is the same kind of thing: which rows am I
          looking at. */}
      <Inline gap="xs">
        <Pressable
          onPress={() => setShowArchived((on) => !on)}
          accessibilityRole="switch"
          accessibilityState={{ checked: showArchived }}
          accessibilityLabel="Show archived conversations"
          hitSlop={verticalSlop(MIN_TARGET)}
        >
          <Badge label={showArchived ? 'Archived · showing' : 'Archived'} tone={showArchived ? 'accent' : 'neutral'} />
        </Pressable>
      </Inline>

      {tags.length ? (
        // A tag filter is a single-choice control, so it is announced as one:
        // `radiogroup` with `radio` children and a `checked` state. Wrapping the
        // selected state on an inner `View`, as this did, hides it from the
        // accessibility tree entirely — the chip reads the same either way.
        <Inline gap="xs" accessibilityRole="radiogroup" accessibilityLabel="Filter by tag">
          <Pressable
            onPress={() => setTag(undefined)}
            accessibilityRole="radio"
            accessibilityState={{ checked: tag === undefined, selected: tag === undefined }}
            accessibilityLabel="All tags"
            accessibilityHint="Clears the tag filter"
            hitSlop={verticalSlop(MIN_TARGET)}
          >
            <Badge label="All" tone={tag === undefined ? 'accent' : 'neutral'} />
          </Pressable>
          {tags.map((entry) => (
            <Pressable
              key={entry.tag}
              onPress={() => setTag(tag === entry.tag ? undefined : entry.tag)}
              accessibilityRole="radio"
              accessibilityState={{ checked: tag === entry.tag, selected: tag === entry.tag }}
              accessibilityLabel={`${entry.tag}, ${entry.count} conversation${entry.count === 1 ? '' : 's'}`}
              hitSlop={verticalSlop(MIN_TARGET)}
            >
              <Badge
                label={`${entry.tag} · ${entry.count}`}
                tone={tag === entry.tag ? 'accent' : 'neutral'}
              />
            </Pressable>
          ))}
        </Inline>
      ) : null}

      {projects.length ? (
        // Same control as the tag filter, and announced the same way. It is a query
        // filter rather than a client-side one, because a project's conversations can
        // sit past the end of the loaded page.
        <Inline gap="xs" accessibilityRole="radiogroup" accessibilityLabel="Filter by project">
          <Pressable
            onPress={() => setProjectId(undefined)}
            accessibilityRole="radio"
            accessibilityState={{ checked: projectId === undefined, selected: projectId === undefined }}
            accessibilityLabel="All projects"
            accessibilityHint="Clears the project filter"
            hitSlop={verticalSlop(MIN_TARGET)}
          >
            <Badge label="All chats" tone={projectId === undefined ? 'accent' : 'neutral'} />
          </Pressable>
          {projects.map((project) => (
            <Pressable
              key={project.id}
              onPress={() => setProjectId(projectId === project.id ? undefined : project.id)}
              accessibilityRole="radio"
              accessibilityState={{ checked: projectId === project.id, selected: projectId === project.id }}
              accessibilityLabel={`Project ${project.name}, ${projectCounts[project.id] ?? 0} conversation${(projectCounts[project.id] ?? 0) === 1 ? '' : 's'}`}
              hitSlop={verticalSlop(MIN_TARGET)}
            >
              <Badge
                label={projectCounts[project.id] ? `${project.name} · ${projectCounts[project.id]}` : project.name}
                tone={projectId === project.id ? 'accent' : 'neutral'}
              />
            </Pressable>
          ))}
        </Inline>
      ) : null}
    </View>
  );

  /**
   * The line under the greeting.
   *
   * Only states things this app has evidence for: how many rows are loaded, and the
   * gateway's *last observed* reachability — never "you are online", which nothing
   * here knows. Before any request has been made it says so rather than guessing.
   */
  const subtitle = useMemo(() => {
    const parts: string[] = [
      showArchived
        ? `${conversations.length} archived`
        : `${conversations.length} conversation${conversations.length === 1 ? '' : 's'}`,
    ];
    if (reach === 'reachable') parts.push('gateway reachable');
    else if (reach === 'unreachable') parts.push('gateway unreachable');
    else parts.push('gateway not yet tried');
    return parts.join(' · ');
  }, [conversations.length, showArchived, reach]);

  // "Nothing matched" is a verdict, and it must not be delivered while the message
  // pass is still running: the list filter resolves synchronously, the SQLite search
  // does not, so for a few hundred milliseconds every query looked like a miss.
  const empty = query.trim() ? (
    searching ? (
      <View style={{ alignItems: 'center', paddingVertical: t.spacing.xxl }}>
        <Spinner label="Searching messages" />
      </View>
    ) : (
      <Empty
        title="Nothing matched"
        body="No conversation title, preview, model or tag contains that, and no message does either."
      />
    )
  ) : tag ? (
    <Empty title="No conversations with that tag" body="Tap All to clear the filter." />
  ) : projectId ? (
    <Empty title="Nothing in this project yet" body="Move a conversation into it from its ⋯ menu, or tap All chats." />
  ) : listLoading ? (
    <Spinner label="Loading" />
  ) : showArchived ? (
    <Empty title="Nothing archived" body="Archive a conversation from its ⋯ menu to keep it without keeping it here." />
  ) : (
    <Empty title="No conversations yet" body="Start one below." />
  );

  // Nothing of the list is shown while the redirect is in flight: it would appear
  // for one frame and be replaced, which reads as a flicker rather than a screen.
  if (redirecting) {
    return (
      <View style={{ flex: 1, justifyContent: 'center' }}>
        <Spinner label="Opening a chat" />
      </View>
    );
  }

  return (
    <View style={{ flex: 1 }}>
      {/* A greeting rather than a title bar. The navigator's header is hidden on this
          screen, so this is the only heading — which is also why the status-bar inset
          is paid here rather than by a header. */}
      <View style={{ paddingHorizontal: t.spacing.md, paddingTop: insets.top + t.spacing.lg }}>
        <Heading style={{ fontSize: t.fontSize.xxl }}>{greeting(now)}</Heading>
        <Body size="sm" tone="faint" style={{ marginTop: 2 }}>
          {subtitle}
        </Body>
      </View>

      {/* Fixed rather than in the list header: a search field that scrolls out of
          reach while you refine the query is a search field you fight. */}
      <View style={{ padding: t.spacing.md, paddingBottom: t.spacing.sm }}>
        <Field
          value={query}
          onChangeText={setQuery}
          placeholder="Search conversations and messages"
          returnKeyType="search"
          right={
            query ? (
              <Pressable onPress={() => setQuery('')} accessibilityLabel="Clear search" hitSlop={8}>
                <Body tone="faint">✕</Body>
              </Pressable>
            ) : undefined
          }
        />
      </View>
      <Divider />

      <FlashList
        data={rows}
        // Rows read `now` and the selection from the closure, neither of which is
        // part of `data`, so FlashList has to be told they changed or recycled
        // cells keep the previous tick's timestamp and the previous selection's
        // ticks. Cheap to build and only changes when one of them actually does.
        extraData={rowContext}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        ListHeaderComponent={banner}
        ListEmptyComponent={<View style={{ padding: t.spacing.md }}>{empty}</View>}
        ItemSeparatorComponent={() => <Divider />}
        ListFooterComponent={
          listLoadingMore ? (
            <View style={{ paddingVertical: t.spacing.lg }}>
              <Spinner label="Loading more" />
            </View>
          ) : null
        }
        // Paging is off while a search is running: the query filters what is
        // already loaded, so fetching the next page mid-search would append rows
        // the filter immediately hides and make the spinner look stuck.
        onEndReached={query.trim() ? undefined : () => void loadMore()}
        onEndReachedThreshold={0.5}
        contentContainerStyle={{ paddingBottom: t.spacing.lg }}
        keyboardShouldPersistTaps="handled"
      />

      <Divider />
      <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, paddingBottom: Math.max(t.spacing.md, insets.bottom), gap: t.spacing.sm }}>
        {selecting ? (
          selectionBar
        ) : (
          <>
            <Button
              label={starting ? 'Starting…' : 'New conversation'}
              variant="primary"
              full
              busy={starting}
              onPress={() => void startConversation()}
            />
            <Inline gap="md">
              <Button label="Settings" size="sm" onPress={() => router.push('/settings')} />
              <Button label="Debug log" size="sm" onPress={() => router.push('/settings/debug')} />
              <View style={{ flex: 1 }} />
              <Button label="Select" size="sm" disabled={!filtered.length} onPress={() => setSelected(new Set())} />
            </Inline>
          </>
        )}
      </View>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.title ?? ''}
        {...(menuFor?.preview ? { subtitle: menuFor.preview } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />

      <Sheet
        visible={bulkSheet}
        title={`${plural(summary.count, 'conversation')} selected`}
        subtitle={`${plural(summary.messages, 'message')}${summary.pinned ? ` · ${summary.pinned} pinned` : ''}`}
        actions={bulkActions}
        onClose={() => setBulkSheet(false)}
      />

      <Sheet
        visible={exportFor !== null}
        title={exportBusy ? 'Exporting…' : 'Export'}
        subtitle={
          exportFor
            ? `${exportFor.label}. Reasoning and attachment contents are left out; API keys never appear.`
            : ''
        }
        actions={exportActions}
        onClose={() => setExportFor(null)}
      />

      {bulkTag ? (
        <PromptSheet
          visible
          title={bulkTag === 'add' ? 'Add tags' : bulkTag === 'remove' ? 'Remove tags' : 'Replace tags'}
          // Pre-filled only for `replace`, and with what the selection currently
          // carries, so the destructive mode opens showing what it is about to
          // discard. Pre-filling `add` or `remove` would suggest those tags are
          // what you want to add or take away, which is the opposite of the truth.
          initial={bulkTag === 'replace' ? summary.tags.join(', ') : ''}
          allowEmpty={bulkTag === 'replace'}
          hint={
            bulkTag === 'replace'
              ? `Comma separated. Replaces every tag on ${plural(summary.count, 'conversation')} — leave empty to clear them.`
              : 'Comma separated.'
          }
          placeholder="work, drafts"
          onCancel={() => setBulkTag(null)}
          onConfirm={(text) => {
            const ids = [...(picked ?? [])];
            const mode = bulkTag;
            setBulkTag(null);
            setBulkSheet(false);
            void runBulk('Retagged', () => useChat.getState().tagMany(ids, parseTags(text), mode));
          }}
        />
      ) : null}

      {prompt ? (
        <PromptSheet
          visible
          title={prompt.kind === 'rename' ? 'Rename' : 'Tags'}
          initial={prompt.kind === 'rename' ? prompt.conversation.title : prompt.conversation.tags.join(', ')}
          allowEmpty={prompt.kind === 'tags'}
          {...(prompt.kind === 'tags' ? { hint: 'Comma separated.', placeholder: 'work, drafts' } : {})}
          onCancel={() => setPrompt(null)}
          onConfirm={(text) => {
            const store = useChat.getState();
            if (prompt.kind === 'rename') void store.rename(prompt.conversation.id, text);
            else void store.setTags(prompt.conversation.id, parseTags(text));
            setPrompt(null);
          }}
        />
      ) : null}
    </View>
  );
}
