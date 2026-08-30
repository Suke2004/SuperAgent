/**
 * The MCP store's gate and dispatch.
 *
 * Only `invoke` is worth a test, and only for the properties that are security
 * properties: nothing runs before the user has said yes, a "no" is a tool result
 * rather than an exception, and a server that fails does not take the turn with it.
 * Everything else in the store is a `set` next to a `db.runAsync`.
 */

const mockCallTool = jest.fn();
const mockSaveApprovals = jest.fn();

jest.mock('@/mcp/client', () => {
  class McpError extends Error {
    constructor(
      message: string,
      readonly needsAuth = false,
    ) {
      super(message);
    }
  }
  return {
    McpError,
    McpClient: class {
      callTool = mockCallTool;
    },
  };
});

jest.mock('@/mcp/oauth', () => ({
  loadAccessToken: jest.fn().mockResolvedValue(null),
  forgetTokens: jest.fn(),
  refresh: jest.fn().mockResolvedValue(null),
  authorize: jest.fn(),
  saveBearerToken: jest.fn(),
}));

jest.mock('@/db/mcp', () => ({
  listServers: jest.fn().mockResolvedValue([]),
  addServer: jest.fn(),
  updateServer: jest.fn(),
  deleteServer: jest.fn(),
  freeServerName: jest.fn(),
  saveDiscovery: jest.fn(),
  saveEnabled: jest.fn(),
  saveApprovals: (...args: unknown[]) => mockSaveApprovals(...args),
  saveOauth: jest.fn(),
  saveError: jest.fn(),
}));

jest.mock('@/transports/streamingFetch', () => ({ streamingFetch: jest.fn() }));

let mockConfirm = true;
jest.mock('@/stores/settings', () => ({ getSetting: () => mockConfirm }));

import { useMcp } from './mcp';
import type { McpServer } from '@/db/mcp';

const SERVER: McpServer = {
  id: 'mcp_1',
  createdAt: 1,
  updatedAt: 1,
  name: 'github',
  url: 'https://mcp.example.com/mcp',
  transport: 'http',
  authKind: 'none',
  headers: {},
  tools: [{ name: 'search', description: 'Searches.', inputSchema: { type: 'object' } }],
  resources: [],
  prompts: [],
  enabled: ['search'],
  approvals: {},
};

const WIRE = 'mcp_github_search';

function seed(server: Partial<McpServer> = {}): void {
  useMcp.setState({ servers: [{ ...SERVER, ...server }], loaded: true, pending: [], busy: [] });
}

beforeEach(() => {
  mockCallTool.mockReset();
  mockSaveApprovals.mockReset();
  mockConfirm = true;
  seed();
});

/**
 * The one write path that is a security boundary rather than a `set`.
 *
 * `create` is also what settings restore calls, so a hand-edited backup gets the
 * same refusal the form does — which is the only reason this is worth a test.
 */
describe('adding a server', () => {
  it('refuses a credential header, in either Authorization spelling', async () => {
    const draft = {
      name: 'other',
      url: 'https://mcp.example.com/mcp',
      transport: 'http' as const,
      authKind: 'none' as const,
      headers: {} as Record<string, string>,
    };
    for (const name of ['Authorization', 'authorization', 'Proxy-Authorization']) {
      const result = await useMcp.getState().create({ ...draft, headers: { [name]: 'Bearer tok-12345678' } });
      expect(result).toEqual({ ok: false, reason: expect.stringContaining('bearer-token field') });
    }
  });

  it('still allows the header form some servers actually need', async () => {
    const result = await useMcp.getState().create({
      name: 'other',
      url: 'https://mcp.example.com/mcp',
      transport: 'http',
      authKind: 'none',
      headers: { 'X-Api-Key': 'abc123' },
    });
    // Accepted — see the note at `mcp_servers.headers` for what that costs.
    expect(result.ok).toBe(true);
  });
});

describe('invoking a bridged tool', () => {
  it('offers only the enabled tools of the servers a conversation named', () => {
    seed({ enabled: [] });
    expect(useMcp.getState().bridge(['github'])).toEqual([]);
    seed();
    expect(useMcp.getState().bridge(['github']).map((tool) => tool.wireName)).toEqual([WIRE]);
    expect(useMcp.getState().bridge(['other'])).toEqual([]);
    expect(useMcp.getState().bridge(undefined)).toEqual([]);
  });

  it('answers an unknown tool without calling anything', async () => {
    const result = await useMcp.getState().invoke('mcp_github_missing', {}, ['github']);
    expect(result.isError).toBe(true);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('refuses a denied tool without asking or calling', async () => {
    seed({ approvals: { [WIRE]: 'deny' } });
    const result = await useMcp.getState().invoke(WIRE, { q: 'x' }, ['github']);
    expect(result.isError).toBe(true);
    expect(useMcp.getState().pending).toEqual([]);
    expect(mockCallTool).not.toHaveBeenCalled();
  });

  it('waits for the sheet, and does not call when the user says no', async () => {
    const pending = useMcp.getState().invoke(WIRE, { q: 'x' }, ['github']);
    await Promise.resolve();
    const question = useMcp.getState().pending[0];
    expect(question?.tool).toBe('search');
    expect(mockCallTool).not.toHaveBeenCalled();

    useMcp.getState().resolve(question?.id ?? '', 'deny');
    const result = await pending;
    expect(result.isError).toBe(true);
    expect(mockCallTool).not.toHaveBeenCalled();
    expect(useMcp.getState().pending).toEqual([]);
  });

  it('runs the call once allowed, and remembers an "always"', async () => {
    mockCallTool.mockResolvedValue({ content: 'two hits' });
    const pending = useMcp.getState().invoke(WIRE, { q: 'x' }, ['github']);
    await Promise.resolve();
    useMcp.getState().resolve(useMcp.getState().pending[0]?.id ?? '', 'always');

    expect(await pending).toEqual({ content: 'two hits' });
    expect(mockCallTool).toHaveBeenCalledWith('search', { q: 'x' });
    expect(mockSaveApprovals).toHaveBeenCalledWith('mcp_1', { [WIRE]: 'always' });
    expect(useMcp.getState().servers[0]?.approvals).toEqual({ [WIRE]: 'always' });
  });

  it('skips the question when the tool is already always-allowed', async () => {
    mockCallTool.mockResolvedValue({ content: 'ok' });
    seed({ approvals: { [WIRE]: 'always' } });
    expect(await useMcp.getState().invoke(WIRE, {}, ['github'])).toEqual({ content: 'ok' });
    expect(useMcp.getState().pending).toEqual([]);
  });

  it('skips the question when the user turned confirmation off', async () => {
    mockCallTool.mockResolvedValue({ content: 'ok' });
    mockConfirm = false;
    await useMcp.getState().invoke(WIRE, {}, ['github']);
    expect(mockCallTool).toHaveBeenCalled();
    expect(useMcp.getState().pending).toEqual([]);
  });

  it('turns a failing server into an error result rather than an exception', async () => {
    mockCallTool.mockRejectedValue(new Error('502 from the proxy'));
    seed({ approvals: { [WIRE]: 'always' } });
    const result = await useMcp.getState().invoke(WIRE, {}, ['github']);
    expect(result.isError).toBe(true);
    expect(result.content).toMatch(/502 from the proxy/);
  });
});
