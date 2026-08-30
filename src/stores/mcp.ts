/**
 * The MCP store: servers, discovery, the approval gate, and the call itself.
 *
 * The gate is the only unusual thing in here. An approval has to happen *mid-turn* —
 * the model has asked for a tool, the turn is blocked on the answer, and the user is
 * looking at a transcript. So {@link McpState.invoke} parks a promise in `pending`
 * and the sheet resolves it. Three consequences worth knowing:
 *
 *  - A denial is a tool *result*, not an exception. The model is told the user said
 *    no, which is information it can act on; an unanswered `tool_use` would make
 *    every later request in the conversation invalid.
 *  - "Always allow" is per tool and is persisted, so it survives the app dying.
 *  - Leaving the screen does not resolve anything. The sheet is rendered by the chat
 *    screen from this store, so coming back shows the same question.
 *
 * Tokens never enter this store. They are read from `expo-secure-store` at call
 * time, exactly like the API key, because everything here would otherwise be one
 * `persist()` away from plaintext storage.
 */

import { create } from 'zustand';

import { McpClient, McpError } from '@/mcp/client';
import { bridgeTools, decideApproval, failedCall, parseServerUrl } from '@/mcp/protocol';
import type { ApprovalMode, BridgedTool, McpCallResult } from '@/mcp/protocol';
import { authorize, forgetTokens, loadAccessToken, refresh } from '@/mcp/oauth';
import {
  addServer,
  deleteServer,
  freeServerName,
  listServers,
  saveApprovals,
  saveDiscovery,
  saveEnabled,
  saveError,
  saveOauth,
  updateServer,
} from '@/db/mcp';
import type { McpServer, McpServerDraft } from '@/db/mcp';
import { log } from '@/lib/log';
import { getSetting } from '@/stores/settings';
import { streamingFetch } from '@/transports/streamingFetch';

export interface PendingApproval {
  /** Unique per question, so two calls in one turn cannot resolve each other. */
  id: string;
  serverName: string;
  /** The wire name the model used, which is what an "always" decision keys on. */
  wireName: string;
  /** The server's own tool name, for the sheet's title. */
  tool: string;
  input: unknown;
}

export type ApprovalDecision = 'once' | 'always' | 'deny' | 'never';

export interface McpState {
  servers: McpServer[];
  loaded: boolean;
  /** Ids currently being discovered or signed in, for the spinner. */
  busy: string[];
  pending: PendingApproval[];

  load(): Promise<void>;
  create(draft: McpServerDraft): Promise<{ ok: true; server: McpServer } | { ok: false; reason: string }>;
  save(id: string, draft: McpServerDraft): Promise<{ ok: true } | { ok: false; reason: string }>;
  remove(id: string): Promise<void>;
  /** Connects, lists everything, and stores what it found. */
  discover(id: string): Promise<{ ok: true; tools: number } | { ok: false; reason: string }>;
  /** Runs the OAuth flow, then discovers. */
  signIn(id: string): Promise<{ ok: true } | { ok: false; reason: string }>;
  signOut(id: string): Promise<void>;
  toggleTool(id: string, tool: string): Promise<void>;
  setApproval(id: string, tool: string, mode: ApprovalMode | undefined): Promise<void>;

  /** The tool definitions a conversation's chosen servers contribute. */
  bridge(names: readonly string[] | undefined): BridgedTool[];
  /** Runs one bridged call: gate, then server, then a result either way. */
  invoke(wireName: string, input: unknown, names: readonly string[] | undefined): Promise<McpCallResult>;
  /** Answers a pending question. */
  resolve(id: string, decision: ApprovalDecision): void;
}

/** Resolvers for the questions in `pending`, kept out of state — they are not data. */
const waiting = new Map<string, (decision: ApprovalDecision) => void>();

export const useMcp = create<McpState>()((set, get) => ({
  servers: [],
  loaded: false,
  busy: [],
  pending: [],

  async load() {
    try {
      set({ servers: await listServers(), loaded: true });
    } catch (error) {
      log.error('mcp', 'Could not load MCP servers', error);
      set({ loaded: true });
    }
  },

  async create(draft) {
    const problem = validate(draft, get().servers, null);
    if (problem) return { ok: false, reason: problem };
    const name = await freeServerName(draft.name);
    const server = await addServer({ ...draft, name });
    set((state) => ({ servers: [...state.servers, server].sort(byName) }));
    return { ok: true, server };
  },

  async save(id, draft) {
    const problem = validate(draft, get().servers, id);
    if (problem) return { ok: false, reason: problem };
    await updateServer(id, draft);
    set((state) => ({
      servers: state.servers.map((server) => (server.id === id ? { ...server, ...draft } : server)).sort(byName),
    }));
    return { ok: true };
  },

  async remove(id) {
    await forgetTokens(id);
    await deleteServer(id);
    set((state) => ({ servers: state.servers.filter((server) => server.id !== id) }));
  },

  async discover(id) {
    const server = get().servers.find((candidate) => candidate.id === id);
    if (!server) return { ok: false, reason: 'That server is no longer in the list.' };

    set((state) => ({ busy: [...state.busy, id] }));
    try {
      const client = await clientFor(server);
      const discovery = await client.discover();
      // Everything discovered is switched on the first time, and a re-discovery keeps
      // what the user chose: silently re-enabling a tool somebody turned off would
      // undo a deliberate decision, and starting with nothing enabled makes a freshly
      // added server look broken.
      const enabled = server.tools.length
        ? discovery.tools.filter((tool) => server.enabled.includes(tool.name)).map((tool) => tool.name)
        : discovery.tools.map((tool) => tool.name);
      await saveDiscovery(id, discovery, enabled);
      set((state) => ({
        servers: state.servers.map((candidate) =>
          candidate.id === id
            ? {
                ...candidate,
                tools: discovery.tools,
                resources: discovery.resources,
                prompts: discovery.prompts,
                enabled,
                lastSeenAt: Date.now(),
                lastError: undefined,
              }
            : candidate,
        ),
      }));
      return { ok: true, tools: discovery.tools.length };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await saveError(id, reason);
      set((state) => ({
        servers: state.servers.map((candidate) => (candidate.id === id ? { ...candidate, lastError: reason } : candidate)),
      }));
      return { ok: false, reason };
    } finally {
      set((state) => ({ busy: state.busy.filter((busyId) => busyId !== id) }));
    }
  },

  async signIn(id) {
    const server = get().servers.find((candidate) => candidate.id === id);
    if (!server) return { ok: false, reason: 'That server is no longer in the list.' };
    set((state) => ({ busy: [...state.busy, id] }));
    try {
      const auth = await authorize({
        serverId: id,
        serverUrl: server.url,
        ...(server.oauth?.clientId ? { clientId: server.oauth.clientId } : {}),
        ...(server.oauth?.endpoints ? { endpoints: server.oauth.endpoints } : {}),
      });
      await saveOauth(id, auth);
      set((state) => ({
        servers: state.servers.map((candidate) =>
          candidate.id === id ? { ...candidate, oauth: auth, lastError: undefined } : candidate,
        ),
      }));
      return { ok: true };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      await saveError(id, reason);
      set((state) => ({
        servers: state.servers.map((candidate) => (candidate.id === id ? { ...candidate, lastError: reason } : candidate)),
      }));
      return { ok: false, reason };
    } finally {
      set((state) => ({ busy: state.busy.filter((busyId) => busyId !== id) }));
    }
  },

  async signOut(id) {
    await forgetTokens(id);
    await saveOauth(id, null);
    set((state) => ({
      servers: state.servers.map((server) => {
        if (server.id !== id) return server;
        const next = { ...server };
        delete next.oauth;
        return next;
      }),
    }));
  },

  async toggleTool(id, tool) {
    const server = get().servers.find((candidate) => candidate.id === id);
    if (!server) return;
    const enabled = server.enabled.includes(tool)
      ? server.enabled.filter((name) => name !== tool)
      : [...server.enabled, tool];
    await saveEnabled(id, enabled);
    set((state) => ({
      servers: state.servers.map((candidate) => (candidate.id === id ? { ...candidate, enabled } : candidate)),
    }));
  },

  async setApproval(id, tool, mode) {
    const server = get().servers.find((candidate) => candidate.id === id);
    if (!server) return;
    const approvals = { ...server.approvals };
    if (mode) approvals[tool] = mode;
    else delete approvals[tool];
    await saveApprovals(id, approvals);
    set((state) => ({
      servers: state.servers.map((candidate) => (candidate.id === id ? { ...candidate, approvals } : candidate)),
    }));
  },

  bridge(names) {
    return bridgeTools(sourcesFor(get().servers, names));
  },

  async invoke(wireName, input, names) {
    const bridged = get().bridge(names).find((tool) => tool.wireName === wireName);
    if (!bridged) {
      return failedCall(
        `The tool "${wireName}" is not available in this conversation. It may have been switched off since it was offered.`,
      );
    }
    const server = get().servers.find((candidate) => candidate.id === bridged.serverId);
    if (!server) return failedCall(`The server that offered "${wireName}" is no longer configured.`);

    const outcome = decideApproval(server.approvals, wireName, getSetting('confirmToolCalls'));
    if (outcome === 'deny') {
      return failedCall(`The user has denied "${bridged.tool}" on ${server.name}. Do not ask for it again this turn.`);
    }
    if (outcome === 'ask') {
      const decision = await ask(set, {
        id: `${wireName}:${Date.now()}:${Math.random().toString(36).slice(2, 8)}`,
        serverName: server.name,
        wireName,
        tool: bridged.tool,
        input,
      });
      if (decision === 'always') await get().setApproval(server.id, wireName, 'always');
      if (decision === 'never') await get().setApproval(server.id, wireName, 'deny');
      if (decision === 'deny' || decision === 'never') {
        return failedCall(`The user declined to run "${bridged.tool}" on ${server.name}.`);
      }
    }

    return runCall(get, server, bridged.tool, input);
  },

  resolve(id, decision) {
    waiting.get(id)?.(decision);
    waiting.delete(id);
    set((state) => ({ pending: state.pending.filter((question) => question.id !== id) }));
  },
}));

/* -------------------------------------------------------------------------- */
/* Helpers                                                                     */
/* -------------------------------------------------------------------------- */

type Setter = (partial: Partial<McpState> | ((state: McpState) => Partial<McpState>)) => void;

/** Parks a question and waits for the sheet. Never rejects. */
function ask(set: Setter, question: PendingApproval): Promise<ApprovalDecision> {
  return new Promise<ApprovalDecision>((resolve) => {
    waiting.set(question.id, resolve);
    set((state) => ({ pending: [...state.pending, question] }));
  });
}

/**
 * The call, with one re-authentication attempt.
 *
 * An expired OAuth token is the common failure and the one the user cannot diagnose:
 * the refresh is silent, and only a refresh that also fails becomes a visible "sign
 * in again". Everything else is a tool result, because the model is waiting.
 */
async function runCall(
  get: () => McpState,
  server: McpServer,
  tool: string,
  input: unknown,
): Promise<McpCallResult> {
  try {
    const client = await clientFor(server);
    return await client.callTool(tool, input);
  } catch (error) {
    if (error instanceof McpError && error.needsAuth && server.oauth) {
      const renewed = await refresh({ serverId: server.id, serverUrl: server.url, auth: server.oauth });
      if (renewed) {
        await saveOauth(server.id, renewed);
        try {
          const client = await clientFor({ ...server, oauth: renewed });
          return await client.callTool(tool, input);
        } catch (retryError) {
          return failedCall(describe(retryError, server.name));
        }
      }
      await saveError(server.id, 'The saved authorisation expired.');
      // Reflected in the list so Settings shows why, without a second request.
      void get().load();
      return failedCall(
        `${server.name} needs to be signed in to again (Settings → MCP servers). The call was not made.`,
      );
    }
    return failedCall(describe(error, server.name));
  }
}

function describe(error: unknown, serverName: string): string {
  const message = error instanceof Error ? error.message : String(error);
  return `${serverName} could not run the tool: ${message}`;
}

async function clientFor(server: McpServer): Promise<McpClient> {
  const token = server.authKind === 'none' ? null : await loadAccessToken(server.id);
  return new McpClient({
    url: server.url,
    transport: server.transport,
    fetchImpl: streamingFetch,
    ...(token ? { token } : {}),
    ...(Object.keys(server.headers).length ? { headers: server.headers } : {}),
  });
}

/** The enabled servers a conversation named, in list order so the manifest is stable. */
function sourcesFor(servers: readonly McpServer[], names: readonly string[] | undefined) {
  if (!names?.length) return [];
  const wanted = new Set(names);
  return servers
    .filter((server) => wanted.has(server.name))
    .map((server) => ({ serverId: server.id, slug: server.name, tools: server.tools, enabled: server.enabled }));
}

function validate(draft: McpServerDraft, servers: readonly McpServer[], id: string | null): string | null {
  if (!draft.name.trim()) return 'Give the server a short name.';
  const parsed = parseServerUrl(draft.url);
  if (!parsed.ok) return parsed.reason;
  if (servers.some((server) => server.name === draft.name && server.id !== id)) {
    return `There is already a server called “${draft.name}”.`;
  }
  for (const [header, value] of Object.entries(draft.headers)) {
    if (!header.trim() || !value.trim()) return 'A header needs both a name and a value.';
    // Both Authorization forms, not just the plain one. The client sets `Authorization`
    // from the Keystore after merging these, so a header by that name is either
    // overwritten or — for the proxy variant, which nothing overwrites — a credential
    // written to `mcp_servers.headers`, which is a plaintext column. This is also the
    // only screen on the way in from settings restore, so a hand-edited backup gets
    // the same refusal the form does.
    //
    // `X-Api-Key` and friends stay allowed on purpose: some servers take their
    // credential that way and there is no other field that can carry it. What that
    // costs is documented at `mcp_servers.headers` in `db/ddl.ts`.
    if (/^(?:proxy-)?authorization$/i.test(header.trim())) {
      return 'Use the bearer-token field for Authorization — a header here would be stored in the database.';
    }
  }
  return null;
}

function byName(a: McpServer, b: McpServer): number {
  return a.name.localeCompare(b.name);
}

/** Saves a bearer token to the Keystore. Re-exported so the form need not know the slot. */
export { saveBearerToken } from '@/mcp/oauth';
