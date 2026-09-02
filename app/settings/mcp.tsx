/**
 * MCP servers.
 *
 * Browse a connector, or add one by URL; sign in if it wants OAuth, see what it
 * advertises, and switch individual tools on and off. The list, the directory and the
 * form share this file for the same reason the skills screen does: the "that name is
 * taken" message has to land next to the field that caused it.
 *
 * The directory (`@/mcp/catalog`) is a shortcut into the form, not a second way to
 * create a server. Tapping an entry fills the same fields you would have typed and
 * stops there, so the URL, the transport and the auth kind are all on screen before
 * anything is saved — which is what keeps a bundled list of other people's endpoints
 * honest when one of them moves.
 *
 * Two things on this screen are security decisions rather than layout ones:
 *
 *  - The bearer token field is write-only. It goes to the Keystore on save and is
 *    never read back, so a stored token cannot be shoulder-surfed off this screen.
 *  - `stdio` is not a transport here and cannot be typed into the URL field. A phone
 *    has no local process to speak to, and pretending otherwise would mean a URL
 *    scheme that silently does nothing.
 */

import { useCallback, useState } from 'react';
import { Alert, View } from 'react-native';
import { useFocusEffect } from 'expo-router';

import { Sheet } from '@/components/Sheet';
import type { SheetAction } from '@/components/Sheet';
import {
  Badge,
  Body,
  Button,
  Empty,
  Field,
  Inline,
  Note,
  Row,
  Screen,
  Section,
  Segmented,
  SkeletonRows,
  Spinner,
  SwitchRow,
} from '@/components/ui';
import { CATALOG_AS_OF, connectorAdded, draftFromEntry, searchConnectors } from '@/mcp/catalog';
import type { ConnectorEntry } from '@/mcp/catalog';
import { qualifyToolName, slugFromHost } from '@/mcp/protocol';
import type { ApprovalMode } from '@/mcp/protocol';
import type { McpAuthKind, McpServer, McpServerDraft } from '@/db/mcp';
import { redirectUri } from '@/mcp/oauth';
import * as haptics from '@/lib/haptics';
import { saveBearerToken, useMcp } from '@/stores/mcp';
import { useTheme } from '@/theme';

const BLANK: McpServerDraft = { name: '', url: '', transport: 'http', authKind: 'none', headers: {} };

/** Resources shown before the "Show all" row. */
const RESOURCE_PREVIEW = 20;

/** One header row in the form. A list, not a record, so an empty key can be typed. */type HeaderPair = { key: string; value: string };

export default function McpScreen() {
  const t = useTheme();
  const servers = useMcp((s) => s.servers);
  const loaded = useMcp((s) => s.loaded);
  const busy = useMcp((s) => s.busy);
  const load = useMcp((s) => s.load);

  const [editing, setEditing] = useState<string | 'new' | null>(null);
  const [draft, setDraft] = useState<McpServerDraft>(BLANK);
  const [headers, setHeaders] = useState<HeaderPair[]>([]);
  const [token, setToken] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<string | null>(null);
  const [detailFor, setDetailFor] = useState<string | null>(null);
  const [menuFor, setMenuFor] = useState<McpServer | null>(null);
  /** Resource lists run to hundreds on a file server; the first 20 answer "is it working?". */
  const [allResources, setAllResources] = useState(false);
  const [browsing, setBrowsing] = useState(false);
  const [query, setQuery] = useState('');
  /** The catalogue entry a draft came from, so the editor can say what it will reach. */
  const [source, setSource] = useState<ConnectorEntry | null>(null);

  useFocusEffect(
    useCallback(() => {
      void load();
    }, [load]),
  );

  const detail = servers.find((server) => server.id === detailFor) ?? null;

  const openEditor = (server: McpServer | null): void => {
    setDraft(
      server
        ? { name: server.name, url: server.url, transport: server.transport, authKind: server.authKind, headers: server.headers }
        : BLANK,
    );
    setHeaders(server ? Object.entries(server.headers).map(([key, value]) => ({ key, value })) : []);
    setToken('');
    setProblem(null);
    setSource(null);
    setEditing(server ? server.id : 'new');
  };

  /**
   * A catalogue entry, opened as a new-server draft.
   *
   * Deliberately the same editor rather than a one-tap add: the entry is a dated guess
   * at somebody else's endpoint, and the user seeing the URL before it is saved is the
   * whole safeguard.
   */
  const openConnector = (entry: ConnectorEntry): void => {
    setDraft(draftFromEntry(entry));
    setHeaders([]);
    setToken('');
    setProblem(null);
    setSource(entry);
    setBrowsing(false);
    setEditing('new');
  };

  const submit = async (): Promise<void> => {
    if (editing === null) return;
    const collected: Record<string, string> = {};
    for (const pair of headers) if (pair.key.trim()) collected[pair.key.trim()] = pair.value;
    // A name nobody typed is derived from the host, which is nearly always what the
    // user would have typed anyway and is what the tool names read as.
    const name = draft.name.trim() || hostSlug(draft.url);
    const next: McpServerDraft = { ...draft, name, headers: collected };

    let id = editing;
    if (editing === 'new') {
      const created = await useMcp.getState().create(next);
      if (!created.ok) {
        setProblem(created.reason);
        return;
      }
      id = created.server.id;
    } else {
      const saved = await useMcp.getState().save(editing, next);
      if (!saved.ok) {
        setProblem(saved.reason);
        return;
      }
    }
    if (next.authKind === 'bearer' && token.trim()) await saveBearerToken(id, token.trim());
    setEditing(null);
    setToken('');
    setOutcome(`Saved “${name}”. Connect to see what it offers.`);
    if (next.authKind !== 'oauth') void connect(id);
  };

  const connect = async (id: string): Promise<void> => {
    const result = await useMcp.getState().discover(id);
    setOutcome(result.ok ? `Found ${result.tools} ${result.tools === 1 ? 'tool' : 'tools'}.` : result.reason);
  };

  const signIn = async (id: string): Promise<void> => {
    const result = await useMcp.getState().signIn(id);
    if (!result.ok) {
      setOutcome(result.reason);
      return;
    }
    await connect(id);
  };

  const remove = (server: McpServer): void => {
    Alert.alert(
      'Remove server',
      `Remove “${server.name}”? Its saved token is deleted too, and conversations using it stop seeing its tools.`,
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Remove',
          style: 'destructive',
          onPress: () => {
            haptics.warn();
            setDetailFor(null);
            void useMcp.getState().remove(server.id);
          },
        },
      ],
    );
  };

  const menuActions = (server: McpServer): SheetAction[] => [
    { label: 'Tools and permissions', onPress: () => { setDetailFor(server.id); setAllResources(false); setMenuFor(null); } },
    {
      label: 'Connect and rediscover',
      subtitle: 'Asks the server what it can do now',
      onPress: () => { void connect(server.id); setMenuFor(null); },
    },
    { label: 'Edit', onPress: () => { openEditor(server); setMenuFor(null); } },
    ...(server.authKind === 'oauth'
      ? [
          { label: server.oauth ? 'Sign in again' : 'Sign in', onPress: () => { void signIn(server.id); setMenuFor(null); } },
          ...(server.oauth
            ? [{ label: 'Sign out', onPress: () => { void useMcp.getState().signOut(server.id); setMenuFor(null); } }]
            : []),
        ]
      : []),
    { label: 'Remove', destructive: true, onPress: () => { remove(server); setMenuFor(null); } },
  ];

  if (editing !== null) {
    return (
      <Screen>
        <Section title={editing === 'new' ? (source ? `Add ${source.name}` : 'Add a server') : 'Edit server'}>
          <View style={{ padding: t.spacing.md, gap: t.spacing.md }}>
            {source ? (
              <Note tone="warning">
                What it can see: {source.reach} These details were published as of {CATALOG_AS_OF} and are filled in
                here, not verified — if connecting fails, check {source.docs} for the current endpoint.
              </Note>
            ) : null}
            <Field
              label="URL"
              value={draft.url}
              onChangeText={(url) => setDraft((d) => ({ ...d, url }))}
              placeholder="https://mcp.example.com/mcp"
              autoCapitalize="none"
              keyboardType="url"
              hint="https only, except localhost. Local stdio servers cannot be reached from a phone."
            />
            <Field
              label="Name"
              value={draft.name}
              onChangeText={(name) => setDraft((d) => ({ ...d, name }))}
              placeholder={hostSlug(draft.url) || 'github'}
              autoCapitalize="none"
              hint={`Used in the tool names the model sees, like ${qualifyToolName(draft.name || hostSlug(draft.url) || 'github', 'search')}.`}
            />
            <Segmented
              label="Transport"
              value={draft.transport}
              onChange={(transport) => setDraft((d) => ({ ...d, transport }))}
              options={[
                { value: 'http', label: 'Streamable HTTP' },
                { value: 'sse', label: 'SSE (legacy)' },
              ]}
            />
            <Segmented
              label="Authentication"
              value={draft.authKind}
              onChange={(authKind: McpAuthKind) => setDraft((d) => ({ ...d, authKind }))}
              options={[
                { value: 'none', label: 'None' },
                { value: 'bearer', label: 'Token' },
                { value: 'oauth', label: 'OAuth' },
              ]}
            />
            {draft.authKind === 'bearer' ? (
              <Field
                label="Bearer token"
                value={token}
                onChangeText={setToken}
                secureTextEntry
                autoCapitalize="none"
                placeholder={editing === 'new' ? '' : 'Leave blank to keep the saved one'}
                hint="Stored in the Android Keystore, never in the database, and redacted from the debug log and exports."
              />
            ) : null}
            {draft.authKind === 'oauth' ? (
              <Note tone="info">
                Signing in opens your browser and comes back to {redirectUri()}. The app registers itself with the
                server; there is no client secret to paste.
              </Note>
            ) : null}

            <Body tone="dim" size="sm">
              Custom headers
            </Body>
            {headers.map((pair, index) => (
              <Inline key={index} gap="sm">
                <View style={{ flex: 1 }}>
                  <Field
                    label="Header"
                    value={pair.key}
                    onChangeText={(key) => setHeaders((list) => list.map((p, i) => (i === index ? { ...p, key } : p)))}
                    autoCapitalize="none"
                    placeholder="X-Workspace"
                  />
                </View>
                <View style={{ flex: 1 }}>
                  <Field
                    label="Value"
                    value={pair.value}
                    onChangeText={(value) => setHeaders((list) => list.map((p, i) => (i === index ? { ...p, value } : p)))}
                    autoCapitalize="none"
                  />
                </View>
              </Inline>
            ))}
            <Inline gap="md">
              <Button
                label="Add header"
                size="sm"
                variant="ghost"
                onPress={() => setHeaders((list) => [...list, { key: '', value: '' }])}
              />
              {headers.length ? (
                <Button label="Remove last" size="sm" variant="ghost" onPress={() => setHeaders((list) => list.slice(0, -1))} />
              ) : null}
            </Inline>
            {problem ? <Note tone="danger">{problem}</Note> : null}
          </View>
        </Section>

        <Inline gap="md">
          <Button label="Save" onPress={() => void submit()} />
          <Button label="Cancel" variant="ghost" onPress={() => setEditing(null)} />
        </Inline>
      </Screen>
    );
  }

  if (detail) {
    return (
      <Screen>
        <Section
          title={`${detail.name} — tools (${detail.enabled.length}/${detail.tools.length})`}
          note={
            'Only switched-on tools are offered to the model, and each one costs its name, description and schema ' +
            'in every request of the conversation. Tap a tool to change when it asks first.'
          }
        >
          {detail.tools.length === 0 ? (
            <View style={{ padding: t.spacing.md }}>
              <Empty icon="tools" title="Nothing discovered yet" body="Connect to the server to list its tools." />
            </View>
          ) : (
            detail.tools.map((tool, index) => (
              <SwitchRow
                key={tool.name}
                first={index === 0}
                label={tool.name}
                subtitle={`${approvalLabel(detail.approvals[qualifyToolName(detail.name, tool.name)])} · ${tool.description || 'No description.'}`}
                value={detail.enabled.includes(tool.name)}
                onChange={() => void useMcp.getState().toggleTool(detail.id, tool.name)}
              />
            ))
          )}
        </Section>

        {detail.tools.length ? (
          <Section title="When to ask first" note="Applies to this server's tools in every conversation.">
            {detail.tools.map((tool, index) => (
              <Row
                key={tool.name}
                first={index === 0}
                label={tool.name}
                value={approvalLabel(detail.approvals[qualifyToolName(detail.name, tool.name)])}
                onPress={() => {
                  const wire = qualifyToolName(detail.name, tool.name);
                  const current = detail.approvals[wire];
                  const next: ApprovalMode | undefined =
                    current === undefined ? 'always' : current === 'always' ? 'deny' : undefined;
                  void useMcp.getState().setApproval(detail.id, wire, next);
                }}
                accessibilityHint="Cycles between ask every time, always allow and never allow"
              />
            ))}
          </Section>
        ) : null}

        {detail.resources.length ? (
          <Section title={`Resources (${detail.resources.length})`} note="Listed for reference; the model reads them through the server's own tools.">
            {(allResources ? detail.resources : detail.resources.slice(0, RESOURCE_PREVIEW)).map((resource, index) => (
              <Row key={resource.uri} first={index === 0} label={resource.name || resource.uri} subtitle={resource.uri} />
            ))}
            {!allResources && detail.resources.length > RESOURCE_PREVIEW ? (
              <Row
                label={`Show all ${detail.resources.length}`}
                onPress={() => setAllResources(true)}
                accessibilityHint="Lists every resource this server offers"
              />
            ) : null}
          </Section>
        ) : null}

        {detail.prompts.length ? (
          <Section title={`Prompts (${detail.prompts.length})`}>
            {detail.prompts.map((prompt, index) => (
              <Row key={prompt.name} first={index === 0} label={prompt.name} subtitle={prompt.description} />
            ))}
          </Section>
        ) : null}

        {outcome ? <Note tone="info">{outcome}</Note> : null}

        <Inline gap="md">
          <Button label="Back" variant="ghost" onPress={() => setDetailFor(null)} />
          <Button label="Rediscover" size="sm" variant="ghost" onPress={() => void connect(detail.id)} />
        </Inline>
      </Screen>
    );
  }

  if (browsing) {
    const found = searchConnectors(query);
    return (
      <Screen>
        <Section
          title="Connectors"
          note={`Servers other people run, with the endpoint each one published as of ${CATALOG_AS_OF}. Tapping one fills in the add form so you can check it before saving; it is not saved, and nothing here is a recommendation.`}
        >
          <View style={{ padding: t.spacing.md }}>
            <Field
              label="Search"
              value={query}
              onChangeText={setQuery}
              placeholder="issues, docs, payments…"
              autoCapitalize="none"
              hint="Matches the name, what it does, and the address."
            />
          </View>
          {found.length === 0 ? (
            <View style={{ padding: t.spacing.md }}>
              <Empty
                icon="search"
                title="Nothing matches"
                body="This is a short hand-written list, not a registry. Add the server by URL instead."
              />
            </View>
          ) : (
            found.map((entry, index) => {
              const added = connectorAdded(entry, servers);
              return (
                <Row
                  key={entry.id}
                  first={index === 0}
                  label={entry.name}
                  subtitle={`${authWord(entry.authKind)} · ${entry.blurb}`}
                  onPress={() => openConnector(entry)}
                  {...(added ? { right: <Badge tone="success" label="Added" /> } : { chevron: true })}
                  accessibilityHint={added ? 'Already added — opens the form again' : 'Fills in the add form'}
                />
              );
            })
          )}
        </Section>

        <Inline gap="md">
          <Button label="Back" variant="ghost" onPress={() => setBrowsing(false)} />
          <Button label="Add by URL" size="sm" variant="ghost" onPress={() => openEditor(null)} />
        </Inline>

        <Body tone="dim" size="sm">
          A server you add can see whatever you send its tools, and its results go into the model’s context. The line
          under each name says what that means for that one.
        </Body>
      </Screen>
    );
  }

  return (
    <Screen>
      <Section
        title={`MCP servers (${servers.length})`}
        note={
          'A Model Context Protocol server lends its tools to a conversation over the network. Conversations pick ' +
          'which servers they use, and a call can be set to ask you first, every time.'
        }
      >
        {!loaded ? (
          <View style={{ padding: t.spacing.md }}>
            <SkeletonRows count={3} label="Loading your servers" />
          </View>
        ) : servers.length === 0 ? (
          <View style={{ padding: t.spacing.md }}>
            <Empty
              icon="servers"
              title="No servers yet"
              body="Browse the connectors for one you already use, or add any server by URL. Streamable HTTP and SSE only."
            />
          </View>
        ) : (
          servers.map((server, index) => (
            <Row
              key={server.id}
              first={index === 0}
              label={server.name}
              subtitle={summarise(server)}
              onPress={() => setMenuFor(server)}
              right={busy.includes(server.id) ? <Spinner /> : server.lastError ? <Badge tone="danger" label="Error" /> : undefined}
              accessibilityHint="Opens tools, connect, edit and remove"
            />
          ))
        )}
      </Section>

      {outcome ? <Note tone="info">{outcome}</Note> : null}

      <Inline gap="md">
        <Button
          label="Browse connectors"
          size="sm"
          onPress={() => {
            setQuery('');
            setBrowsing(true);
          }}
        />
        <Button label="Add by URL" size="sm" variant="ghost" onPress={() => openEditor(null)} />
      </Inline>

      <Body tone="dim" size="sm">
        A server you add can see whatever you send its tools, and its results go into the model’s context. Add ones
        you would give the same information to by hand.
      </Body>

      <Sheet
        visible={menuFor !== null}
        title={menuFor?.name ?? ''}
        {...(menuFor ? { subtitle: menuFor.url } : {})}
        actions={menuFor ? menuActions(menuFor) : []}
        onClose={() => setMenuFor(null)}
      />
    </Screen>
  );
}

function summarise(server: McpServer): string {
  const parts = [server.url];
  if (server.lastError) parts.push(server.lastError);
  else if (server.tools.length) parts.push(`${server.enabled.length}/${server.tools.length} tools on`);
  else parts.push('not connected yet');
  return parts.join(' · ');
}

function approvalLabel(mode: ApprovalMode | undefined): string {
  if (mode === 'always') return 'Always allow';
  if (mode === 'deny') return 'Never allow';
  return 'Ask every time';
}

/** What adding a connector will cost the user before it works. The first thing they need. */
function authWord(kind: McpAuthKind): string {
  if (kind === 'oauth') return 'Sign in';
  if (kind === 'bearer') return 'Needs a token';
  return 'No sign-in';
}

/** The host, as a slug, or '' for something not yet a URL. */
function hostSlug(url: string): string {
  try {
    return slugFromHost(new URL(url).hostname);
  } catch {
    return '';
  }
}
