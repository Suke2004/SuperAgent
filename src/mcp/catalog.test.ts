/**
 * The connector directory, tested as data rather than as code.
 *
 * There is barely any logic in `catalog.ts` — the risk is in the entries. A URL that
 * `parseServerUrl` rejects would ship as a row that fails the moment it is saved, and
 * an id that `qualifyToolName` mangles would ship as tool names that do not match the
 * server name shown on screen. Both are invisible to a reviewer reading a table of
 * strings, so they are asserted here against the same functions the app uses.
 *
 * What is deliberately *not* tested: whether the endpoints are still live. That needs
 * the network, and a suite that fails when a vendor has an outage is a suite people
 * learn to ignore.
 */

import { CATALOG_AS_OF, CONNECTORS, connectorAdded, draftFromEntry, searchConnectors } from '@/mcp/catalog';
import { parseServerUrl, qualifyToolName } from '@/mcp/protocol';

describe('the connector catalogue', () => {
  it('has entries the add form would accept', () => {
    for (const entry of CONNECTORS) {
      const parsed = parseServerUrl(entry.url);
      expect(parsed.ok ? '' : `${entry.id}: ${parsed.reason}`).toBe('');
      expect(parsed.ok && parsed.url.startsWith('https://')).toBe(true);
    }
  });

  it('has ids that survive tool-name qualification unchanged', () => {
    // Otherwise the name on the row and the prefix the model sees would differ, and
    // "which server ran that" becomes a guess.
    for (const entry of CONNECTORS) {
      expect(qualifyToolName(entry.id, 'search')).toBe(`mcp_${entry.id}_search`);
    }
  });

  it('has unique ids and urls', () => {
    expect(new Set(CONNECTORS.map((entry) => entry.id)).size).toBe(CONNECTORS.length);
    expect(new Set(CONNECTORS.map((entry) => entry.url)).size).toBe(CONNECTORS.length);
  });

  it('says what every entry can see, and where to check it', () => {
    for (const entry of CONNECTORS) {
      expect(entry.reach.length).toBeGreaterThan(20);
      expect(entry.docs.startsWith('https://')).toBe(true);
    }
  });

  it('leads with the connectors that need no account', () => {
    // The list is hand-ordered; this is the tripwire for someone alphabetising it.
    const firstAuthed = CONNECTORS.findIndex((entry) => entry.authKind !== 'none');
    const lastOpen = CONNECTORS.map((entry) => entry.authKind).lastIndexOf('none');
    expect(lastOpen).toBeLessThan(firstAuthed);
  });

  it('is dated', () => {
    expect(CATALOG_AS_OF).toMatch(/\d{4}/);
  });
});

describe('searchConnectors', () => {
  it('returns everything for an empty query', () => {
    expect(searchConnectors('  ')).toHaveLength(CONNECTORS.length);
  });

  it('matches the name, ignoring case', () => {
    expect(searchConnectors('GITHUB').map((entry) => entry.id)).toContain('github');
  });

  it('matches the blurb, so a connector is findable by what it does', () => {
    expect(searchConnectors('pull requests').map((entry) => entry.id)).toContain('github');
  });

  it('matches the domain, for someone who half-remembers the address', () => {
    expect(searchConnectors('linear.app').map((entry) => entry.id)).toContain('linear');
  });

  it('returns nothing rather than everything for a miss', () => {
    expect(searchConnectors('zzzz')).toEqual([]);
  });

  it('keeps catalogue order', () => {
    const found = searchConnectors('');
    expect(found.map((entry) => entry.id)).toEqual(CONNECTORS.map((entry) => entry.id));
  });
});

describe('connectorAdded', () => {
  const entry = CONNECTORS[0]!;

  it('is false with nothing configured', () => {
    expect(connectorAdded(entry, [])).toBe(false);
  });

  it('ignores a trailing slash and case', () => {
    expect(connectorAdded(entry, [{ url: `${entry.url.toUpperCase()}/` }])).toBe(true);
  });

  it('does not match a different endpoint on the same host', () => {
    expect(connectorAdded(entry, [{ url: `${entry.url}/other` }])).toBe(false);
  });

  it('recognises what draftFromEntry would have saved', () => {
    expect(connectorAdded(entry, [draftFromEntry(entry)])).toBe(true);
  });
});

describe('draftFromEntry', () => {
  it('carries the endpoint, transport and auth kind, and no headers', () => {
    const entry = CONNECTORS.find((candidate) => candidate.authKind === 'oauth')!;
    expect(draftFromEntry(entry)).toEqual({
      name: entry.id,
      url: entry.url,
      transport: entry.transport,
      authKind: entry.authKind,
      headers: {},
    });
  });
});
