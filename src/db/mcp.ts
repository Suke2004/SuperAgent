/**
 * MCP server persistence.
 *
 * Rows only. The protocol is in `@/mcp/protocol`, the socket in `@/mcp/client`, the
 * decisions in `@/stores/mcp`.
 *
 * The one thing worth knowing about this table: **no credential is in it.** A bearer
 * token or an OAuth access token lives in `expo-secure-store` under `mcp.<id>`,
 * beside the API key, for the same reason — a database file gets backed up, synced
 * and copied, and this app's own backup/restore reads it. What is here is where the
 * server is, what it said it can do, and what the user decided about it.
 */

import { database } from '@/db/schema';
import { newId } from '@/lib/id';
import { log } from '@/lib/log';

import type { ApprovalMode, McpPrompt, McpResource, McpTool, McpTransportKind } from '@/mcp/protocol';
import type { StoredAuth } from '@/mcp/oauth';

export type McpAuthKind = 'none' | 'bearer' | 'oauth';

export interface McpServer {
  id: string;
  createdAt: number;
  updatedAt: number;
  /** The slug used in bridged tool names, and what `config.servers` stores. */
  name: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  headers: Record<string, string>;
  oauth?: StoredAuth;
  tools: McpTool[];
  resources: McpResource[];
  prompts: McpPrompt[];
  /** Tool names switched on. Empty means the server contributes nothing. */
  enabled: string[];
  approvals: Record<string, ApprovalMode>;
  lastError?: string;
  lastSeenAt?: number;
}

/** What the add/edit form produces. Discovery fills in the rest. */
export interface McpServerDraft {
  name: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  headers: Record<string, string>;
}

interface ServerRow {
  id: string;
  created_at: number;
  updated_at: number;
  name: string;
  url: string;
  transport: string;
  auth_kind: string;
  headers: string;
  oauth: string | null;
  tools: string;
  catalogue: string;
  enabled: string;
  approvals: string;
  last_error: string | null;
  last_seen_at: number | null;
}

/**
 * Every JSON column is parsed defensively.
 *
 * A row written by a newer build, or hand-edited, must not take the settings screen
 * down with it: a server whose catalogue will not parse is a server with no tools,
 * which is visible and fixable by rediscovering.
 */
function parse<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    const value: unknown = JSON.parse(text);
    return value === null ? fallback : (value as T);
  } catch (error) {
    log.warn('mcp', 'A stored MCP column would not parse; treating it as empty.', error);
    return fallback;
  }
}

function toServer(row: ServerRow): McpServer {
  const catalogue = parse<{ resources?: McpResource[]; prompts?: McpPrompt[] }>(row.catalogue, {});
  const oauth = row.oauth ? parse<StoredAuth | null>(row.oauth, null) : null;
  return {
    id: row.id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    name: row.name,
    url: row.url,
    transport: row.transport === 'sse' ? 'sse' : 'http',
    authKind: row.auth_kind === 'bearer' || row.auth_kind === 'oauth' ? row.auth_kind : 'none',
    headers: parse<Record<string, string>>(row.headers, {}),
    ...(oauth ? { oauth } : {}),
    tools: parse<McpTool[]>(row.tools, []),
    resources: catalogue.resources ?? [],
    prompts: catalogue.prompts ?? [],
    enabled: parse<string[]>(row.enabled, []),
    approvals: parse<Record<string, ApprovalMode>>(row.approvals, {}),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    ...(row.last_seen_at !== null ? { lastSeenAt: row.last_seen_at } : {}),
  };
}

export async function listServers(): Promise<McpServer[]> {
  const { db } = await database();
  const rows = await db.getAllAsync<ServerRow>('SELECT * FROM mcp_servers ORDER BY name');
  return rows.map(toServer);
}

/** Throws on a duplicate name — the caller says so next to the field. */
export async function addServer(draft: McpServerDraft): Promise<McpServer> {
  const { db } = await database();
  const at = Date.now();
  const id = newId('mcp_');
  await db.runAsync(
    `INSERT INTO mcp_servers (id, created_at, updated_at, name, url, transport, auth_kind, headers)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [id, at, at, draft.name, draft.url, draft.transport, draft.authKind, JSON.stringify(draft.headers)],
  );
  return {
    id,
    createdAt: at,
    updatedAt: at,
    ...draft,
    tools: [],
    resources: [],
    prompts: [],
    enabled: [],
    approvals: {},
  };
}

export async function updateServer(id: string, draft: McpServerDraft): Promise<void> {
  const { db } = await database();
  await db.runAsync(
    `UPDATE mcp_servers SET name = ?, url = ?, transport = ?, auth_kind = ?, headers = ?, updated_at = ? WHERE id = ?`,
    [draft.name, draft.url, draft.transport, draft.authKind, JSON.stringify(draft.headers), Date.now(), id],
  );
}

/** What discovery learned. Clears `last_error`, because the connection worked. */
export async function saveDiscovery(
  id: string,
  discovery: { tools: McpTool[]; resources: McpResource[]; prompts: McpPrompt[] },
  enabled: readonly string[],
): Promise<void> {
  const { db } = await database();
  await db.runAsync(
    `UPDATE mcp_servers
        SET tools = ?, catalogue = ?, enabled = ?, last_error = NULL, last_seen_at = ?, updated_at = ?
      WHERE id = ?`,
    [
      JSON.stringify(discovery.tools),
      JSON.stringify({ resources: discovery.resources, prompts: discovery.prompts }),
      JSON.stringify([...enabled]),
      Date.now(),
      Date.now(),
      id,
    ],
  );
}

export async function saveEnabled(id: string, enabled: readonly string[]): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE mcp_servers SET enabled = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify([...enabled]),
    Date.now(),
    id,
  ]);
}

export async function saveApprovals(id: string, approvals: Record<string, ApprovalMode>): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE mcp_servers SET approvals = ?, updated_at = ? WHERE id = ?', [
    JSON.stringify(approvals),
    Date.now(),
    id,
  ]);
}

export async function saveOauth(id: string, oauth: StoredAuth | null): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE mcp_servers SET oauth = ?, updated_at = ? WHERE id = ?', [
    oauth ? JSON.stringify(oauth) : null,
    Date.now(),
    id,
  ]);
}

export async function saveError(id: string, message: string | null): Promise<void> {
  const { db } = await database();
  await db.runAsync('UPDATE mcp_servers SET last_error = ?, updated_at = ? WHERE id = ?', [message, Date.now(), id]);
}

export async function deleteServer(id: string): Promise<void> {
  const { db } = await database();
  await db.runAsync('DELETE FROM mcp_servers WHERE id = ?', [id]);
}

/** `github`, then `github-2`. Same probe as skills, and for the same reason. */
export async function freeServerName(name: string): Promise<string> {
  const { db } = await database();
  const rows = await db.getAllAsync<{ name: string }>('SELECT name FROM mcp_servers');
  const taken = new Set(rows.map((row) => row.name));
  if (!taken.has(name)) return name;
  for (let n = 2; ; n += 1) {
    const candidate = `${name}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}
