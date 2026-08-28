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
import { Badge, Body, Button, Divider, Empty, Field, Inline, Note, Spinner } from '@/components/ui';
import { buildRows, filterConversations, parseTags, tagCounts } from '@/chat/list';
import type { ListRow } from '@/chat/list';
import { searchMessages } from '@/db/conversations';
import type { Conversation, SearchHit } from '@/db/conversations';
import { splitOnMatches } from '@/db/search';
import { streamingAvailable } from '@/lib/gateway';
import { whenBucket } from '@/lib/when';
import { useChat } from '@/stores/chat';
import { useProviders } from '@/stores/providers';
import { useTheme } from '@/theme';

/** How long to wait after the last keystroke before hitting the database. */
const SEARCH_DEBOUNCE_MS = 250;
/** One character matches most of the corpus; two is where a query means something. */
const MIN_SEARCH_LENGTH = 2;
/** A stable empty result, so "no hits" does not count as a change. */
const NO_HITS: readonly SearchHit[] = [];

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

function ConversationRow({
  conversation,
  now,
  query,
  onOpen,
  onMenu,
}: {
  conversation: Conversation;
  now: number;
  query: string;
  onOpen: () => void;
  onMenu: () => void;
}) {
  const t = useTheme();
  const preview = conversation.preview ?? '';
  const initials = conversation.title
    .trim()
    .split(/\s+/)
    .slice(0, 2)
    .map((part) => part[0] ?? '')
    .join('')
    .toUpperCase() || '?';

  return (
    <Pressable
      onPress={onOpen}
      onLongPress={onMenu}
      delayLongPress={300}
      accessibilityRole="button"
      accessibilityHint="Long press for options"
      style={({ pressed }) => ({
        flexDirection: 'row',
        alignItems: 'flex-start',
        paddingHorizontal: t.spacing.md,
        paddingVertical: t.spacing.md,
        gap: t.spacing.sm,
        backgroundColor: pressed ? t.colors.surfaceActive : 'transparent',
      })}
    >
      <View
        accessible={false}
        style={{
          width: 34,
          height: 34,
          borderRadius: 17,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: conversation.pinned ? t.colors.accentSoft : t.colors.surfaceAlt,
        }}
      >
        <Body size="sm" weight="700" tone={conversation.pinned ? 'accent' : 'dim'}>
          {initials}
        </Body>
      </View>

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
  const listError = useChat((s) => s.listError);
  const loadList = useChat((s) => s.loadList);

  const profiles = useProviders((s) => s.profiles);
  const activeId = useProviders((s) => s.activeId);
  const failover = useProviders((s) => s.activeFailover);
  const refreshKeyStatus = useProviders((s) => s.refreshKeyStatus);

  const [now, setNow] = useState(() => Date.now());
  const [query, setQuery] = useState('');
  const [tag, setTag] = useState<string | undefined>(undefined);
  const [found, setFound] = useState<{ query: string; hits: SearchHit[] } | null>(null);
  const [menuFor, setMenuFor] = useState<Conversation | null>(null);
  const [prompt, setPrompt] = useState<{ kind: 'rename' | 'tags'; conversation: Conversation } | null>(null);
  const [keyChecked, setKeyChecked] = useState(false);
  const [starting, setStarting] = useState(false);

  const active = profiles.find((p) => p.id === activeId) ?? profiles[0];

  // Results carry the query that produced them, and both "which hits" and "still
  // searching" are derived from that one comparison. Storing them separately is how
  // you end up rendering the previous query's hits under the current query's text.
  const trimmed = query.trim();
  const searchable = trimmed.length >= MIN_SEARCH_LENGTH;
  // Memoised for its identity, not its cost: the row list below depends on it, and a
  // fresh `[]` each render would rebuild every row on every keystroke.
  const hits = useMemo(
    () => (searchable && found?.query === trimmed ? found.hits : NO_HITS),
    [searchable, found, trimmed],
  );
  const searching = searchable && found?.query !== trimmed;

  // Re-read on focus: a conversation opened and replied to changes its preview and
  // its place in the order, and both are computed by the query rather than locally.
  useFocusEffect(
    useCallback(() => {
      setNow(Date.now());
      void loadList();
    }, [loadList]),
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
      void searchMessages(trimmed)
        .then((rows) => {
          if (!cancelled) setFound({ query: trimmed, hits: rows });
        })
        .catch(() => {
          // The list above is still correct; a failed full-text pass should not
          // blank the screen. `searchMessages` has already logged it. Recording an
          // empty result against this query stops it retrying on every render.
          if (!cancelled) setFound({ query: trimmed, hits: [] });
        });
    }, SEARCH_DEBOUNCE_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [trimmed, searchable]);

  const filtered = useMemo(
    () => filterConversations(conversations, { query, ...(tag ? { tag } : {}) }),
    [conversations, query, tag],
  );

  const tags = useMemo(() => tagCounts(conversations), [conversations]);

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
      const id = await useChat.getState().start();
      openConversation(id);
    } catch (error) {
      Alert.alert('Could not start a conversation', error instanceof Error ? error.message : String(error));
    } finally {
      setStarting(false);
    }
  }, [openConversation, starting]);

  const confirmDelete = (conversation: Conversation): void => {
    Alert.alert('Delete this conversation?', `"${conversation.title}" and every message in it.`, [
      { text: 'Cancel', style: 'cancel' },
      {
        text: 'Delete',
        style: 'destructive',
        onPress: () => void useChat.getState().remove(conversation.id),
      },
    ]);
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
    { label: 'Delete', destructive: true, onPress: () => confirmDelete(conversation) },
  ];

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
          onOpen={() => openConversation(item.conversation.id)}
          onMenu={() => setMenuFor(item.conversation)}
        />
      );
    },
    [t, now, query, openConversation],
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

      {tags.length ? (
        <Inline gap="xs">
          <Pressable onPress={() => setTag(undefined)} accessibilityRole="button">
            <View accessibilityState={{ selected: tag === undefined }}>
              <Badge label="All" tone={tag === undefined ? 'accent' : 'neutral'} />
            </View>
          </Pressable>
          {tags.map((entry) => (
            <Pressable
              key={entry.tag}
              onPress={() => setTag(tag === entry.tag ? undefined : entry.tag)}
              accessibilityRole="button"
              accessibilityState={{ selected: tag === entry.tag }}
            >
              <Badge
                label={`${entry.tag} · ${entry.count}`}
                tone={tag === entry.tag ? 'accent' : 'neutral'}
              />
            </Pressable>
          ))}
        </Inline>
      ) : null}
    </View>
  );

  const empty = query.trim() ? (
    <Empty
      title="Nothing matched"
      body={
        searching
          ? 'Still searching the messages…'
          : 'No conversation title, preview, model or tag contains that, and no message does either.'
      }
    />
  ) : tag ? (
    <Empty title="No conversations with that tag" body="Tap All to clear the filter." />
  ) : listLoading ? (
    <Spinner label="Loading" />
  ) : (
    <Empty title="No conversations yet" body="Start one below." />
  );

  return (
    <View style={{ flex: 1 }}>
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
        extraData={now}
        keyExtractor={(item) => item.key}
        getItemType={(item) => item.kind}
        renderItem={renderItem}
        ListHeaderComponent={banner}
        ListEmptyComponent={<View style={{ padding: t.spacing.md }}>{empty}</View>}
        ItemSeparatorComponent={() => <Divider />}
        contentContainerStyle={{ paddingBottom: t.spacing.lg }}
        keyboardShouldPersistTaps="handled"
      />

      <Divider />
      <View style={{ paddingHorizontal: t.spacing.md, paddingTop: t.spacing.md, paddingBottom: Math.max(t.spacing.md, insets.bottom), gap: t.spacing.sm }}>
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
        </Inline>
      </View>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.title ?? ''}
        {...(menuFor?.preview ? { subtitle: menuFor.preview } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />

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
