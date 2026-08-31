/**
 * The tool-call loop, end to end.
 *
 * The loop is the one part of the store that calls itself: a turn that ends in
 * `tool_use` stores the results, then runs another whole turn, and the only thing
 * stopping that from going on forever is a counter threaded through the recursion.
 * Every failure mode here is expensive in a way a unit test of a pure function
 * cannot reach — each extra round is a billed request carrying the whole history.
 *
 * So three things are pinned:
 *
 *  - **A round trip actually completes.** The skill body reaches the model as a
 *    `tool_result` and the second round's answer is what the user sees.
 *  - **The cap stops it, and still closes the call.** A `tool_use` left unanswered
 *    in the history makes every *later* request in that conversation invalid, so
 *    refusing to continue must not also refuse to write the result row.
 *  - **A tool that fails is a result, not a thrown turn.** An unknown tool name is
 *    the model's mistake to recover from inside the same turn.
 *
 * Everything below the store is a double: `@/db/conversations` is an in-memory
 * table and the transport is a scripted array of streams. That is the whole point
 * of the transport interface being injectable.
 */

import type { ContentBlock, StreamEvent } from '@/transports/types';

/* -------------------------------------------------------------------------- */
/* The database                                                                */
/* -------------------------------------------------------------------------- */

jest.mock('@/db/conversations', () => {
  type MockRow = Record<string, unknown> & {
    id: string;
    conversationId: string;
    seq: number;
    role: 'user' | 'assistant';
    content: unknown[];
    createdAt: number;
  };
  const mockRows: MockRow[] = [];
  const mockConversation = {
    id: 'c1',
    title: 'A conversation',
    createdAt: 1_000,
    updatedAt: 1_000,
    profileId: 'p1',
    model: 'claude-opus-5',
    config: { skills: ['pdf-processing'], contextStrategy: 'warn' as const },
    messageCount: 0,
    pinned: false,
    archived: false,
    tags: [],
  };
  let mockSeq = 0;

  return {
    DEFAULT_TITLE: 'New chat',
    async getConversation() {
      return mockConversation;
    },
    async listMessages(conversationId: string) {
      return mockRows.filter((row) => row.conversationId === conversationId);
    },
    async appendMessage(conversationId: string, input: Record<string, unknown>) {
      mockSeq += 1;
      const row: MockRow = {
        id: `m${mockSeq}`,
        conversationId,
        seq: mockSeq,
        createdAt: 1_000 + mockSeq,
        role: input.role as 'user' | 'assistant',
        content: input.content as unknown[],
        ...input,
      };
      mockRows.push(row);
      return row;
    },
    async recordUsage() {},
    async updateConversation() {},
    async updateMessage() {},
    async deleteMessagesFrom() {},
    deriveTitle: (text: string) => text.slice(0, 20),
    flattenContent: (content: { text?: string }[]) => content.map((block) => block.text ?? '').join(''),
    previewOf: () => '',
    isToolTurn: () => false,
    async createConversation() {
      return mockConversation;
    },
    async forkConversation() {
      return mockConversation;
    },
    async listConversationPage() {
      return { items: [], cursor: undefined };
    },
    async deleteMessage() {},
    async setPinned() {},
    async setTags() {},
    async setArchivedBulk() {},
    async tagConversations() {},
    async deleteConversation() {},
    async deleteConversations() {},
    __rows: mockRows,
  };
});

/* -------------------------------------------------------------------------- */
/* The transport                                                              */
/* -------------------------------------------------------------------------- */

/** One scripted stream per round, shifted as the loop asks for them. */
const mockScript: StreamEvent[][] = [];
/** Every request the loop made, so the second round can be inspected. */
const mockSent: { messages: { role: string; content: ContentBlock[] }[] }[] = [];

/**
 * The scripted stream, defined out here rather than inside the factory: an async
 * generator compiles to a Babel helper, and a `jest.mock` factory may not reach
 * one. `mock`-prefixed, which is what makes it visible to the factory at all.
 */
async function* mockStream(request: {
  messages: { role: string; content: ContentBlock[] }[];
}): AsyncGenerator<StreamEvent, void, undefined> {
  mockSent.push({ messages: request.messages });
  const events = mockScript.shift();
  if (!events) throw new Error('the loop asked for more rounds than the test scripted');
  for (const event of events) yield event;
}

jest.mock('@/lib/gateway', () => ({
  invalidateTransports: jest.fn(),
  resolveTransport: async () => ({ baseUrl: 'https://gateway.test', transport: { stream: mockStream } }),
}));

/* -------------------------------------------------------------------------- */
/* The file system                                                            */
/* -------------------------------------------------------------------------- */

// `write_file` and `create_pdf` pull these in through `@/chat/files`. None of the
// tests below writes a file; the mocks exist only because these three packages ship
// ESM that this CommonJS suite cannot parse, and importing the store loads them.
jest.mock('expo-file-system', () => ({
  Paths: { document: { uri: 'file:///documents/' } },
  Directory: class {},
  File: class {},
}));
jest.mock('expo-print', () => ({ printToFileAsync: jest.fn() }));
jest.mock('expo-sharing', () => ({ isAvailableAsync: jest.fn(async () => false), shareAsync: jest.fn() }));

/* -------------------------------------------------------------------------- */
/* The stores around it                                                       */
/* -------------------------------------------------------------------------- */

/** Order MCP calls finished in, so "ran concurrently" is observable. */
const mockFinished: string[] = [];

/**
 * A fake MCP server. `slow_*` tools finish a tick after `fast_*` ones, so a loop that
 * awaited each call in turn and one that ran them together produce different
 * `mockFinished` orders.
 */
async function mockInvoke(name: string): Promise<{ content: string }> {
  if (name.includes('slow')) await new Promise((resolve) => setTimeout(resolve, 20));
  mockFinished.push(name);
  return { content: `${name} ran` };
}

const mockSkill = {
  id: 'skl_1',
  createdAt: 1,
  updatedAt: 1,
  name: 'pdf-processing',
  description: 'Extracts text from a PDF.',
  body: 'Open the file, then read the text layer.',
};

let mockMaxToolIterations = 4;

jest.mock('@/stores/settings', () => ({
  getSetting: (key: string) => {
    if (key === 'maxToolIterations') return mockMaxToolIterations;
    if (key === 'contextStrategy') return 'warn';
    if (key === 'promptCaching') return false;
    if (key === 'autoFailover') return false;
    return undefined;
  },
}));
jest.mock('@/stores/providers', () => {
  const mockProfile = { id: 'p1', name: 'Gateway', kind: 'anthropic', baseUrl: 'https://gateway.test', headers: {} };
  return {
    activeProfile: () => mockProfile,
    useProviders: { getState: () => ({ byId: () => mockProfile, setFailover: jest.fn() }) },
  };
});
jest.mock('@/stores/models', () => ({
  capabilitiesFor: () => ({ contextWindow: 200_000, tools: true, streaming: true }),
  wireHintsFor: () => ({}),
  useModels: { getState: () => ({ get: () => undefined }) },
}));
jest.mock('@/stores/calibration', () => ({
  useCalibration: { getState: () => ({ factorFor: () => undefined, toolFactorFor: () => undefined, record: jest.fn() }) },
}));
jest.mock('@/stores/memory', () => ({
  useMemory: {
    getState: () => ({
      promptBlock: () => ({ included: [], dropped: 0, chars: 0 }),
      noteUsed: jest.fn(),
      distil: jest.fn(async () => 0),
    }),
  },
}));
jest.mock('@/stores/skills', () => ({
  useSkills: { getState: () => ({ loaded: true, enabledFor: () => [mockSkill], load: jest.fn() }) },
}));
jest.mock('@/stores/mcp', () => ({
  useMcp: {
    getState: () => ({
      loaded: true,
      bridge: () => [],
      resources: () => [],
      load: jest.fn(),
      // Nothing here asks first: the approval sheet is a UI path, and the loop runs
      // pre-approved calls concurrently, which is what the ordering test is about.
      needsApproval: () => false,
      invoke: mockInvoke,
    }),
  },
}));
jest.mock('@/stores/reachability', () => ({
  useReachability: { getState: () => ({ markReachable: jest.fn(), markUnreachable: jest.fn() }) },
}));
jest.mock('@/stores/queue', () => ({
  useSendQueue: { getState: () => ({ drop: jest.fn(), queue: jest.fn() }) },
}));

import * as db from '@/db/conversations';
import { useChat } from '@/stores/chat';

const rows = (db as unknown as { __rows: { role: string; content: ContentBlock[]; meta?: Record<string, unknown> }[] })
  .__rows;

/** One round that asks for the skill, then stops. */
function asksForSkill(id: string): StreamEvent[] {
  return [
    { type: 'start', id: `msg_${id}` },
    { type: 'text_delta', text: 'Let me read that skill.' },
    { type: 'tool_use_start', index: 0, id, name: 'invoke_skill' },
    { type: 'tool_use_delta', index: 0, partialJson: '{"name":"pdf-processing"}' },
    { type: 'tool_use_stop', index: 0 },
    { type: 'usage', usage: { input: 120, output: 8 } },
    { type: 'stop', reason: 'tool_use' },
  ];
}

/** One round that just answers. */
function answers(text: string): StreamEvent[] {
  return [
    { type: 'start', id: 'msg_final' },
    { type: 'text_delta', text },
    { type: 'usage', usage: { input: 300, output: 12 } },
    { type: 'stop', reason: 'end_turn' },
  ];
}

function toolResults(): { role: string; content: ContentBlock[] }[] {
  return rows.filter((row) => row.content.some((block) => block.type === 'tool_result'));
}

beforeEach(() => {
  rows.length = 0;
  mockScript.length = 0;
  mockSent.length = 0;
  mockFinished.length = 0;
  mockMaxToolIterations = 4;
  useChat.setState({ streams: {}, messages: {}, drafts: {}, attachments: {}, contextNotes: {}, stalled: {} });
});

test('a skill invocation runs a second round, and the body reaches it as a tool result', async () => {
  mockScript.push(asksForSkill('tu_1'), answers('The text layer is on page one.'));

  await useChat.getState().send('c1', { text: 'What does this PDF say?' });

  // Two requests: the one that asked for the skill, and the one that answered.
  expect(mockSent).toHaveLength(2);
  const rounds = rows.filter((row) => row.role === 'assistant');
  expect(rounds).toHaveLength(2);
  expect(rounds[0]?.meta?.skillsInvoked).toEqual(['pdf-processing']);
  expect(rounds[0]?.meta?.toolRounds).toBe(1);

  // The body went in as a tool result, and the second request carried it.
  const results = toolResults();
  expect(results).toHaveLength(1);
  const block = results[0]?.content[0];
  expect(block?.type === 'tool_result' && block.content).toContain('Open the file, then read the text layer.');
  const second = mockSent[1]?.messages ?? [];
  expect(JSON.stringify(second)).toContain('read the text layer');

  // And the last thing in the transcript is the answer, not the tool traffic.
  expect(JSON.stringify(rounds[1]?.content)).toContain('The text layer is on page one.');
  expect(useChat.getState().contextNotes.c1).toBeUndefined();
});

test('the iteration cap stops a model that only calls tools, and still answers the last call', async () => {
  mockMaxToolIterations = 2;
  mockScript.push(asksForSkill('tu_1'), asksForSkill('tu_2'), asksForSkill('tu_3'));

  await useChat.getState().send('c1', { text: 'Go on then.' });

  // Two rounds, not three: the cap is the number of rounds, not of retries.
  expect(mockSent).toHaveLength(2);
  expect(mockScript).toHaveLength(1); // The third script was never asked for.

  // Both calls were closed. An unanswered `tool_use` would invalidate every later
  // request in this conversation, so the cap must not skip the result row.
  expect(toolResults()).toHaveLength(2);

  const note = useChat.getState().contextNotes.c1 ?? '';
  expect(note).toContain('called tools 2 times');
  // Continuing is a button now, not an instruction to type something the user did
  // not want to say.
  expect(note).not.toContain('Send again');
  expect(useChat.getState().stalled.c1).toBe(true);

  // And that button starts a fresh turn from the same history, without a new message.
  mockScript.length = 0; // Drop the round the cap refused; this time the model answers.
  mockScript.push(answers('Here is what I found.'));
  await useChat.getState().continueTurn('c1');
  expect(mockSent).toHaveLength(3);
  expect(rows[rows.length - 1]?.role).toBe('assistant');
  expect(useChat.getState().stalled.c1).toBeUndefined();
});

test('the calls in one round run concurrently, but their results keep the model’s order', async () => {
  mockScript.push(
    [
      { type: 'start', id: 'msg_1' },
      { type: 'tool_use_start', index: 0, id: 'tu_slow', name: 'mcp_files_slow_read' },
      { type: 'tool_use_delta', index: 0, partialJson: '{}' },
      { type: 'tool_use_stop', index: 0 },
      { type: 'tool_use_start', index: 1, id: 'tu_fast', name: 'mcp_files_fast_read' },
      { type: 'tool_use_delta', index: 1, partialJson: '{}' },
      { type: 'tool_use_stop', index: 1 },
      { type: 'stop', reason: 'tool_use' },
    ],
    answers('Both files say the same thing.'),
  );

  await useChat.getState().send('c1', { text: 'Read both files.' });

  // Concurrent: the second call finished first despite being asked for second.
  expect(mockFinished).toEqual(['mcp_files_fast_read', 'mcp_files_slow_read']);

  // Ordered: a `tool_result` has to line up with the `tool_use` it answers, so the
  // stored blocks are back in the model's own order, not completion order.
  const content = toolResults()[0]?.content ?? [];
  expect(content.map((block) => (block.type === 'tool_result' ? block.toolUseId : ''))).toEqual(['tu_slow', 'tu_fast']);
});

test('arguments cut off mid-stream are refused, not forwarded to the server', async () => {
  mockScript.push(
    [
      { type: 'start', id: 'msg_1' },
      { type: 'tool_use_start', index: 0, id: 'tu_cut', name: 'mcp_files_read' },
      // Half a JSON object: the stream ended before the closing brace.
      { type: 'tool_use_delta', index: 0, partialJson: '{"path":"/et' },
      { type: 'tool_use_stop', index: 0 },
      { type: 'stop', reason: 'tool_use' },
    ],
    answers('Trying that again.'),
  );

  await useChat.getState().send('c1', { text: 'Read it.' });

  expect(mockFinished).toEqual([]); // The server was never called.
  const block = toolResults()[0]?.content[0];
  expect(block?.type === 'tool_result' && block.isError).toBe(true);
  expect(block?.type === 'tool_result' && block.content).toContain('arrived incomplete');
});

test('a tool the app does not have is a tool result, not a failed turn', async () => {
  mockScript.push(
    [
      { type: 'start', id: 'msg_1' },
      { type: 'tool_use_start', index: 0, id: 'tu_x', name: 'read_my_email' },
      { type: 'tool_use_delta', index: 0, partialJson: '{}' },
      { type: 'tool_use_stop', index: 0 },
      { type: 'stop', reason: 'tool_use' },
    ],
    answers('I cannot read your email, but here is what I can do.'),
  );

  await useChat.getState().send('c1', { text: 'Read my email.' });

  const results = toolResults();
  const block = results[0]?.content[0];
  expect(block?.type === 'tool_result' && block.isError).toBe(true);
  expect(block?.type === 'tool_result' && block.content).toContain('no tool called "read_my_email"');
  // The turn recovered inside itself: the second round answered, and nothing was
  // stored as an errored message.
  expect(rows.some((row) => 'error' in row && row.error)).toBe(false);
  expect(useChat.getState().streams.c1).toBeUndefined();
});
