/**
 * A directory of remote MCP servers.
 *
 * The add-a-server form only ever asked for a URL, which meant a connector was
 * reachable only if you already knew its address by heart. This is the list you would
 * otherwise have gone looking for: a name, what it can see, and an endpoint to try —
 * filled into that same form, so nothing is saved without being looked at first.
 *
 * Three deliberate limits, because a bundled list of other people's URLs is a liability
 * the moment it pretends to be authoritative:
 *
 *  - **It is a dated snapshot** ({@link CATALOG_AS_OF}), not a live registry. There is
 *    no fetch in here and no remote index to go stale against — a vendor that moves its
 *    endpoint moves it without telling this app, so every entry carries a `docs` page.
 *  - **It fills the form; it does not save.** {@link draftFromEntry} produces a draft.
 *    The user sees the URL, the transport and the auth kind and confirms them, so a
 *    wrong entry is visible before it becomes a server — and a failed connect already
 *    shows the server's own error on its row.
 *  - **It is not a recommendation.** Every entry states its `reach`, because
 *    "connected" means that server's tools receive whatever the model sends them.
 *
 * Pure data and pure functions, tested against the same `parseServerUrl` the form
 * validates with, so a malformed URL in here fails a gate rather than a save. The
 * screen is `app/settings/mcp.tsx`.
 */

import type { McpAuthKind, McpServerDraft } from '@/db/mcp';
import type { McpTransportKind } from '@/mcp/protocol';

export interface ConnectorEntry {
  /** Slug, and the default server name — so it must survive `qualifyToolName` intact. */
  id: string;
  /** The vendor's own name for it. */
  name: string;
  url: string;
  transport: McpTransportKind;
  authKind: McpAuthKind;
  /** One line: what it is for. Searched. */
  blurb: string;
  /** What it can see once connected. The half a catalogue usually leaves out. */
  reach: string;
  /** The vendor's page, for when the endpoint here has moved. */
  docs: string;
}

/**
 * When this list was written.
 *
 * Shown on the screen. It is the knowledge date rather than the build date, which is
 * the conservative one: the build could be minutes old and the endpoints still stale.
 */
export const CATALOG_AS_OF = 'May 2026';

/**
 * Ordered so the ones that need no account come first.
 *
 * Not alphabetical, on purpose. The first connector someone tries should be one that
 * works on the first tap, because "add a server" failing on an OAuth round trip is
 * indistinguishable from the feature being broken. Search covers looking for a name.
 */
export const CONNECTORS: readonly ConnectorEntry[] = [
  {
    id: 'deepwiki',
    name: 'DeepWiki',
    url: 'https://mcp.deepwiki.com/mcp',
    transport: 'http',
    authKind: 'none',
    blurb: 'Ask questions about any public GitHub repository.',
    reach: 'Public repositories only, and the questions you ask about them. No account, nothing of yours.',
    docs: 'https://docs.devin.ai/work-with-devin/deepwiki-mcp',
  },
  {
    id: 'context7',
    name: 'Context7',
    url: 'https://mcp.context7.com/mcp',
    transport: 'http',
    authKind: 'none',
    blurb: 'Current documentation for libraries and frameworks, by version.',
    reach: 'The library names and topics you look up. No account needed for the public tier.',
    docs: 'https://context7.com',
  },
  {
    id: 'cloudflare-docs',
    name: 'Cloudflare docs',
    url: 'https://docs.mcp.cloudflare.com/mcp',
    transport: 'http',
    authKind: 'none',
    blurb: 'Search Cloudflare’s developer documentation.',
    reach: 'Your search terms. Read-only, and it reaches no Cloudflare account of yours.',
    docs: 'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
  },
  {
    id: 'huggingface',
    name: 'Hugging Face',
    url: 'https://huggingface.co/mcp',
    transport: 'http',
    authKind: 'bearer',
    blurb: 'Search models, datasets and Spaces, and call Spaces as tools.',
    reach: 'Whatever your access token can reach, which includes private repositories if it is scoped to them.',
    docs: 'https://huggingface.co/settings/mcp',
  },
  {
    id: 'stripe',
    name: 'Stripe',
    url: 'https://mcp.stripe.com',
    transport: 'http',
    authKind: 'bearer',
    blurb: 'Customers, payments, subscriptions and the Stripe docs.',
    reach: 'Everything the API key allows — money included. Use a restricted key, and use test mode first.',
    docs: 'https://docs.stripe.com/mcp',
  },
  {
    id: 'github',
    name: 'GitHub',
    url: 'https://api.githubcopilot.com/mcp/',
    transport: 'http',
    authKind: 'oauth',
    blurb: 'Repositories, issues, pull requests, code search and Actions.',
    reach: 'The repositories you grant it, including private ones, and it can write — issues, comments, branches.',
    docs: 'https://github.com/github/github-mcp-server',
  },
  {
    id: 'sentry',
    name: 'Sentry',
    url: 'https://mcp.sentry.dev/mcp',
    transport: 'http',
    authKind: 'oauth',
    blurb: 'Issues, events and stack traces from your Sentry projects.',
    reach: 'Your organisation’s issues and their event payloads, which can carry user data from production.',
    docs: 'https://docs.sentry.io/product/sentry-mcp/',
  },
  {
    id: 'notion',
    name: 'Notion',
    url: 'https://mcp.notion.com/mcp',
    transport: 'http',
    authKind: 'oauth',
    blurb: 'Search, read and write pages and databases.',
    reach: 'The pages you share with the integration during sign-in, and it can edit them.',
    docs: 'https://developers.notion.com/docs/mcp',
  },
  {
    id: 'linear',
    name: 'Linear',
    url: 'https://mcp.linear.app/sse',
    transport: 'sse',
    authKind: 'oauth',
    blurb: 'Issues, projects, cycles and comments.',
    reach: 'Your workspace’s issues and projects, and it can create and update them.',
    docs: 'https://linear.app/docs/mcp',
  },
  {
    id: 'atlassian',
    name: 'Jira and Confluence',
    url: 'https://mcp.atlassian.com/v1/sse',
    transport: 'sse',
    authKind: 'oauth',
    blurb: 'Atlassian’s own server for Jira issues and Confluence pages.',
    reach: 'The sites and projects you pick during sign-in, with write access to issues and pages.',
    docs: 'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-mcp-server/',
  },
  {
    id: 'asana',
    name: 'Asana',
    url: 'https://mcp.asana.com/sse',
    transport: 'sse',
    authKind: 'oauth',
    blurb: 'Tasks, projects and portfolios.',
    reach: 'The workspaces your account can see, and it can create and complete tasks.',
    docs: 'https://developers.asana.com/docs/mcp-server',
  },
];

/**
 * Entries matching a query, in catalogue order.
 *
 * Matches the URL as well as the words, because someone who half-remembers a connector
 * usually half-remembers its domain. Empty query returns everything, so the caller can
 * render one list either way.
 */
export function searchConnectors(query: string): ConnectorEntry[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return [...CONNECTORS];
  return CONNECTORS.filter((entry) =>
    `${entry.name} ${entry.id} ${entry.blurb} ${entry.url}`.toLowerCase().includes(needle),
  );
}

/**
 * Whether one of these is already configured.
 *
 * By endpoint, not by name: the user is free to rename a server, and the question the
 * badge answers is "have I already added this thing", which is about the address. A
 * vendor's *other* endpoint reads as not-added, which is correct — it is a different
 * server with different tools.
 */
export function connectorAdded(entry: ConnectorEntry, servers: readonly { url: string }[]): boolean {
  const target = normaliseUrl(entry.url);
  return servers.some((server) => normaliseUrl(server.url) === target);
}

/** The add form's starting point. Everything in it is editable before it is saved. */
export function draftFromEntry(entry: ConnectorEntry): McpServerDraft {
  return { name: entry.id, url: entry.url, transport: entry.transport, authKind: entry.authKind, headers: {} };
}

/** Trailing slash and case only. Enough for "same endpoint", and it cannot false-negative. */
function normaliseUrl(url: string): string {
  return url.trim().toLowerCase().replace(/\/+$/, '');
}
