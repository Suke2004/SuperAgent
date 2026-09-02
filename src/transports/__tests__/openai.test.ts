/**
 * OpenAI-compatible transport.
 *
 * The interesting assertions here are the ones about divergence: system prompt as
 * a message, images as data URLs, tool results as their own `role: "tool"`
 * entries, `delta` patches rather than named events. Getting any of those wrong
 * produces a request the gateway accepts and answers badly, which is much harder
 * to notice than a rejection.
 */

import { GatewayError } from '../errors';
import { NO_RETRY_POLICY } from '../retry';
import {
  OpenAiTransport,
  buildOpenAiBody,
  createStreamState,
  describeBaseUrlIssue,
  parseModelList,
  pickProbeModel,
  toOpenAiMessages,
  translateChunk,
  translateFinishReason,
  translateUsage,
} from '../openai';
import type { ChatRequest, StreamEvent } from '../types';
import { createResultAccumulator } from '../types';
import {
  bufferedResponse,
  collect,
  createMockFetch,
  gatewayErrorResponse,
  jsonResponse,
  sseFrame,
  sseResponse,
} from './testFetch';

const BASE_URL = 'https://agentrouter.org/v1';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    params: { maxTokens: 256 },
    ...overrides,
  };
}

function transport(
  responders: Parameters<typeof createMockFetch>[0],
  options: { defaultModel?: string } = {},
) {
  const mock = createMockFetch(responders);
  const client = new OpenAiTransport({
    kind: 'openai',
    baseUrl: BASE_URL,
    apiKey: 'sk-test-key',
    fetchImpl: mock.fetch,
    // Tests must not sleep. Retry behaviour is covered directly in retry.test.ts.
    retryPolicy: NO_RETRY_POLICY,
    ...options,
  });
  return { client, mock };
}

/** Fold a stream into a result the same way `complete` does. */
async function accumulate(events: StreamEvent[]) {
  const accumulator = createResultAccumulator();
  for (const event of events) accumulator.handle(event);
  return accumulator.result();
}

describe('buildOpenAiBody', () => {
  it('puts the system prompt in a system message, not a top-level field', () => {
    const body = buildOpenAiBody(request({ system: 'Be terse.' }), false);
    expect(body.system).toBeUndefined();
    expect(body.messages).toEqual([
      { role: 'system', content: 'Be terse.' },
      { role: 'user', content: 'Hello' },
    ]);
  });

  it('omits an empty or whitespace-only system prompt', () => {
    expect(toOpenAiMessages(request({ system: '   ' }))).toEqual([{ role: 'user', content: 'Hello' }]);
  });

  it('sends max_tokens by default and max_completion_tokens when hinted', () => {
    expect(buildOpenAiBody(request(), false).max_tokens).toBe(256);

    const hinted = buildOpenAiBody(request({ wireHints: { maxTokensField: 'max_completion_tokens' } }), false);
    expect(hinted.max_completion_tokens).toBe(256);
    expect(hinted.max_tokens).toBeUndefined();
  });

  it('maps sampling params to their OpenAI names', () => {
    const body = buildOpenAiBody(
      request({
        params: {
          maxTokens: 100,
          temperature: 0.4,
          topP: 0.9,
          topK: 40,
          stopSequences: ['STOP', 'HALT'],
          seed: 7,
          presencePenalty: 0.5,
          frequencyPenalty: -0.2,
        },
      }),
      false,
    );

    expect(body).toMatchObject({
      temperature: 0.4,
      top_p: 0.9,
      top_k: 40,
      stop: ['STOP', 'HALT'],
      seed: 7,
      presence_penalty: 0.5,
      frequency_penalty: -0.2,
    });
  });

  it('omits every optional param that was not set', () => {
    const body = buildOpenAiBody(request(), false);
    for (const key of ['temperature', 'top_p', 'top_k', 'stop', 'seed', 'presence_penalty', 'frequency_penalty']) {
      expect(body[key]).toBeUndefined();
    }
  });

  it('omits an empty stopSequences array rather than sending stop: []', () => {
    expect(buildOpenAiBody(request({ params: { maxTokens: 10, stopSequences: [] } }), false).stop).toBeUndefined();
  });

  it('sends reasoning_effort only when reasoning is enabled with an effort', () => {
    expect(buildOpenAiBody(request({ reasoning: { enabled: true, effort: 'high' } }), false).reasoning_effort).toBe(
      'high',
    );
    expect(
      buildOpenAiBody(request({ reasoning: { enabled: false, effort: 'high' } }), false).reasoning_effort,
    ).toBeUndefined();
    expect(buildOpenAiBody(request({ reasoning: { enabled: true } }), false).reasoning_effort).toBeUndefined();
  });

  it('asks for usage when streaming, so the token breakdown is the API’s and not an estimate', () => {
    expect(buildOpenAiBody(request(), true)).toMatchObject({ stream: true, stream_options: { include_usage: true } });
    expect(buildOpenAiBody(request(), false).stream_options).toBeUndefined();
  });

  it('wraps tools in the function envelope and translates tool_choice', () => {
    const tools = [{ name: 'lookup', description: 'Look something up', inputSchema: { type: 'object' } }];

    expect(buildOpenAiBody(request({ tools }), false).tools).toEqual([
      { type: 'function', function: { name: 'lookup', description: 'Look something up', parameters: { type: 'object' } } },
    ]);

    expect(buildOpenAiBody(request({ tools, toolChoice: { type: 'auto' } }), false).tool_choice).toBe('auto');
    expect(buildOpenAiBody(request({ tools, toolChoice: { type: 'none' } }), false).tool_choice).toBe('none');
    // `any` is spelled `required` on this path.
    expect(buildOpenAiBody(request({ tools, toolChoice: { type: 'any' } }), false).tool_choice).toBe('required');
    expect(buildOpenAiBody(request({ tools, toolChoice: { type: 'tool', name: 'lookup' } }), false).tool_choice).toEqual({
      type: 'function',
      function: { name: 'lookup' },
    });
  });

  it('drops tool_choice when there are no tools to choose from', () => {
    expect(buildOpenAiBody(request({ toolChoice: { type: 'auto' } }), false).tool_choice).toBeUndefined();
  });

  it('merges extraBody last, so a gateway-specific knob can override anything', () => {
    const body = buildOpenAiBody(request({ extraBody: { temperature: 1.5, custom_flag: true } }), false);
    expect(body.temperature).toBe(1.5);
    expect(body.custom_flag).toBe(true);
  });
});

describe('toOpenAiMessages', () => {
  it('encodes images as data URLs, not base64 source objects', () => {
    const messages = toOpenAiMessages(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'What is this?' },
              { type: 'image', mediaType: 'image/png', data: 'AAAB' },
            ],
          },
        ],
      }),
    );

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'text', text: 'What is this?' },
          { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        ],
      },
    ]);
  });

  it('collapses a lone text part to a bare string', () => {
    const messages = toOpenAiMessages(request());
    expect(messages[0]?.content).toBe('Hello');
  });

  it('keeps the array form when there is more than one part', () => {
    const messages = toOpenAiMessages(
      request({
        messages: [
          {
            role: 'user',
            content: [
              { type: 'text', text: 'a' },
              { type: 'text', text: 'b' },
            ],
          },
        ],
      }),
    );
    expect(messages[0]?.content).toEqual([
      { type: 'text', text: 'a' },
      { type: 'text', text: 'b' },
    ]);
  });

  it('splits tool results into their own role:tool messages', () => {
    const messages = toOpenAiMessages(
      request({
        messages: [
          {
            role: 'assistant',
            content: [{ type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } }],
          },
          {
            role: 'user',
            content: [
              { type: 'tool_result', toolUseId: 'call_1', content: 'found it' },
              { type: 'text', text: 'thanks' },
            ],
          },
        ],
      }),
    );

    expect(messages).toEqual([
      {
        role: 'assistant',
        content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'lookup', arguments: '{"q":"x"}' } }],
      },
      { role: 'tool', tool_call_id: 'call_1', content: 'found it' },
      { role: 'user', content: 'thanks' },
    ]);
  });

  it('marks an errored tool result so the model can see it failed', () => {
    const messages = toOpenAiMessages(
      request({
        messages: [
          { role: 'user', content: [{ type: 'tool_result', toolUseId: 'c1', content: 'timed out', isError: true }] },
        ],
      }),
    );
    expect(messages).toEqual([{ role: 'tool', tool_call_id: 'c1', content: 'ERROR: timed out' }]);
  });

  it('sends extracted document text and says so when extraction produced nothing', () => {
    const [withText] = toOpenAiMessages(
      request({
        messages: [
          {
            role: 'user',
            content: [{ type: 'document', mediaType: 'text/plain', text: 'file body', name: 'notes.txt' }],
          },
        ],
      }),
    );
    expect(withText?.content).toBe('--- notes.txt (text/plain) ---\nfile body');

    const [withoutText] = toOpenAiMessages(
      request({
        messages: [{ role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', name: 'a.pdf' }] }],
      }),
    );
    expect(withoutText?.content).toContain('could not be converted to text on this device');
    expect(withoutText?.content).toContain('a.pdf');
  });

  it('does not replay thinking as visible text', () => {
    const messages = toOpenAiMessages(
      request({
        messages: [
          {
            role: 'assistant',
            content: [
              { type: 'thinking', text: 'internal reasoning', signature: 'sig' },
              { type: 'text', text: 'answer' },
            ],
          },
        ],
      }),
    );
    expect(messages).toEqual([{ role: 'assistant', content: 'answer' }]);
  });

  it('skips a user message that translated to nothing', () => {
    expect(
      toOpenAiMessages(request({ messages: [{ role: 'user', content: [{ type: 'text', text: '' }] }] })),
    ).toEqual([]);
  });
});

describe('translateChunk', () => {
  it('turns delta patches into text deltas', () => {
    const state = createStreamState();
    const events = translateChunk(
      { data: JSON.stringify({ choices: [{ delta: { content: 'Hel' } }] }) },
      state,
    );
    expect(events).toEqual([{ type: 'text_delta', text: 'Hel' }]);
  });

  it('reads reasoning from either reasoning_content or reasoning', () => {
    const state = createStreamState();
    expect(translateChunk({ data: JSON.stringify({ choices: [{ delta: { reasoning_content: 'a' } }] }) }, state)).toEqual(
      [{ type: 'thinking_delta', text: 'a' }],
    );
    expect(translateChunk({ data: JSON.stringify({ choices: [{ delta: { reasoning: 'b' } }] }) }, state)).toEqual([
      { type: 'thinking_delta', text: 'b' },
    ]);
  });

  it('emits start from the first chunk carrying an id or model', () => {
    const state = createStreamState();
    const events = translateChunk({ data: JSON.stringify({ id: 'chatcmpl-1', model: 'gpt-x' }) }, state);
    expect(events).toEqual([{ type: 'start', id: 'chatcmpl-1', model: 'gpt-x' }]);
  });

  it('does not re-announce start on the later chunks that repeat the same id', () => {
    // Every chunk of an OpenAI stream carries the id and model, and `start` is an
    // event the store publishes immediately — one per chunk would re-render the
    // transcript per chunk and undo the commit throttle for this whole transport.
    const state = createStreamState();
    const chunk = { id: 'chatcmpl-1', model: 'gpt-x', choices: [{ delta: { content: 'hi' } }] };
    translateChunk({ data: JSON.stringify(chunk) }, state);
    expect(translateChunk({ data: JSON.stringify(chunk) }, state)).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('ignores [DONE] and malformed frames rather than killing the stream', () => {
    const state = createStreamState();
    expect(translateChunk({ data: '[DONE]' }, state)).toEqual([]);
    expect(translateChunk({ data: '{"choices":[{"delta"' }, state)).toEqual([]);
  });

  it('throws when an error arrives inside a 200 stream', () => {
    const state = createStreamState();
    expect(() =>
      translateChunk({ data: JSON.stringify({ error: { message: 'upstream exploded' } }) }, state),
    ).toThrow(/upstream exploded/);
  });

  it('closes open tool calls and reports the stop reason on finish_reason', () => {
    const state = createStreamState();
    translateChunk(
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'lookup' } }] } }],
        }),
      },
      state,
    );
    const events = translateChunk({ data: JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) }, state);
    expect(events).toEqual([
      { type: 'tool_use_stop', index: 0 },
      { type: 'stop', reason: 'tool_use' },
    ]);
  });

  it('assigns dense local indexes when the gateway omits index', () => {
    const state = createStreamState();
    const first = translateChunk(
      { data: JSON.stringify({ choices: [{ delta: { tool_calls: [{ id: 'a', function: { name: 'one' } }] } }] }) },
      state,
    );
    expect(first[0]).toEqual({ type: 'tool_use_start', index: 0, id: 'a', name: 'one' });

    // A second call at wire index 1 becomes local index 1.
    const second = translateChunk(
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 1, id: 'b', function: { name: 'two' } }] } }],
        }),
      },
      state,
    );
    expect(second[0]).toEqual({ type: 'tool_use_start', index: 1, id: 'b', name: 'two' });
  });

  /**
   * The regression that motivated `toolNames`. Several gateways repeat the call id
   * on every delta; re-announcing the tool each time resets accumulated arguments
   * downstream, so only the final fragment survives and the JSON is invalid.
   */
  it('does not re-announce a tool call when the gateway repeats id and name on every delta', async () => {
    const state = createStreamState();
    const fragments = ['{"qu', 'ery":', '"cats"}'];
    const events: StreamEvent[] = [];

    for (const fragment of fragments) {
      events.push(
        ...translateChunk(
          {
            data: JSON.stringify({
              choices: [
                { delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search', arguments: fragment } }] } },
              ],
            }),
          },
          state,
        ),
      );
    }
    events.push(...translateChunk({ data: JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) }, state));

    expect(events.filter((event) => event.type === 'tool_use_start')).toHaveLength(1);

    const result = await accumulate(events);
    expect(result.content).toEqual([{ type: 'tool_use', id: 'call_1', name: 'search', input: { query: 'cats' } }]);
  });

  it('announces the tool once when the name arrives on a later delta than the id', () => {
    const state = createStreamState();
    const withoutName = translateChunk(
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { arguments: '' } }] } }],
        }),
      },
      state,
    );
    expect(withoutName).toEqual([{ type: 'tool_use_start', index: 0, id: 'call_1', name: '' }]);

    const withName = translateChunk(
      {
        data: JSON.stringify({
          choices: [{ delta: { tool_calls: [{ index: 0, function: { name: 'search' } }] } }],
        }),
      },
      state,
    );
    expect(withName).toEqual([{ type: 'tool_use_start', index: 0, id: 'call_0', name: 'search' }]);

    // And not a third time.
    expect(
      translateChunk(
        {
          data: JSON.stringify({
            choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_1', function: { name: 'search' } }] } }],
          }),
        },
        state,
      ),
    ).toEqual([]);
  });

  it('handles two interleaved tool calls without crossing their arguments', async () => {
    const state = createStreamState();
    const events: StreamEvent[] = [];
    const push = (calls: unknown[]) => {
      events.push(...translateChunk({ data: JSON.stringify({ choices: [{ delta: { tool_calls: calls } }] }) }, state));
    };

    push([{ index: 0, id: 'a', function: { name: 'one', arguments: '{"x":' } }]);
    push([{ index: 1, id: 'b', function: { name: 'two', arguments: '{"y":' } }]);
    push([{ index: 0, function: { arguments: '1}' } }]);
    push([{ index: 1, function: { arguments: '2}' } }]);
    events.push(...translateChunk({ data: JSON.stringify({ choices: [{ finish_reason: 'tool_calls' }] }) }, state));

    const result = await accumulate(events);
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'a', name: 'one', input: { x: 1 } },
      { type: 'tool_use', id: 'b', name: 'two', input: { y: 2 } },
    ]);
  });
});

describe('translateFinishReason', () => {
  it.each([
    ['stop', 'end_turn'],
    ['length', 'max_tokens'],
    ['tool_calls', 'tool_use'],
    ['function_call', 'tool_use'],
    ['content_filter', 'content_filter'],
    ['something_new', 'unknown'],
  ])('maps %s to %s', (wire, expected) => {
    expect(translateFinishReason(wire)).toBe(expected);
  });

  it('maps a missing reason to unknown rather than guessing end_turn', () => {
    expect(translateFinishReason(null)).toBe('unknown');
    expect(translateFinishReason(undefined)).toBe('unknown');
  });
});

describe('translateUsage', () => {
  it('reads the full breakdown from the response', () => {
    expect(
      translateUsage({
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 30 },
        prompt_tokens_details: { cached_tokens: 80 },
        cache_creation_input_tokens: 20,
      }),
    ).toEqual({ input: 100, output: 50, thinking: 30, cacheRead: 80, cacheWrite: 20 });
  });

  it('leaves absent fields undefined rather than defaulting them to zero', () => {
    expect(translateUsage({ prompt_tokens: 5 })).toEqual({ input: 5 });
  });
});

describe('parseModelList', () => {
  it('accepts the data-wrapped shape and sorts case-insensitively', () => {
    const models = parseModelList({ data: [{ id: 'zeta' }, { id: 'Alpha' }, { id: 'beta' }] }, 'u');
    expect(models.map((model) => model.id)).toEqual(['Alpha', 'beta', 'zeta']);
  });

  it('accepts a bare array and plain strings', () => {
    expect(parseModelList(['b', 'a'], 'u')).toEqual([{ id: 'a' }, { id: 'b' }]);
  });

  it('keeps unknown fields under extra for the model detail screen', () => {
    const [model] = parseModelList({ data: [{ id: 'm', owned_by: 'anthropic', created: 1, object: 'model', ctx: 200 }] }, 'u');
    expect(model).toEqual({ id: 'm', ownedBy: 'anthropic', created: 1, extra: { ctx: 200 } });
  });

  it('skips rows with no usable id', () => {
    expect(parseModelList({ data: [{ id: 'good' }, {}, null, 42] }, 'u')).toEqual([{ id: 'good' }]);
  });

  it('throws a parse error pointing at the debug log when there is no data array', () => {
    expect.assertions(3);
    try {
      parseModelList({ oops: true }, 'https://agentrouter.org/v1/models');
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).kind).toBe('parse');
      expect((error as GatewayError).hint).toMatch(/debug log/);
    }
  });
});

describe('describeBaseUrlIssue', () => {
  it('tells the OpenAI transport it needs /v1, with the corrected URL', () => {
    const issue = describeBaseUrlIssue('openai', 'https://agentrouter.org');
    expect(issue).toContain('https://agentrouter.org/v1');
    expect(issue).toContain('must end in /v1');
  });

  it('tells the Anthropic transport to drop /v1, with the corrected URL', () => {
    const issue = describeBaseUrlIssue('anthropic', 'https://agentrouter.org/v1');
    expect(issue).toContain('"https://agentrouter.org"');
    expect(issue).toContain('bare origin');
  });

  it('accepts each transport’s correct shape', () => {
    expect(describeBaseUrlIssue('openai', 'https://agentrouter.org/v1')).toBeNull();
    expect(describeBaseUrlIssue('anthropic', 'https://agentrouter.org')).toBeNull();
    expect(describeBaseUrlIssue('openai', 'https://agentrouter.org/v1/')).toBeNull();
  });

  it('rejects an empty or scheme-less URL', () => {
    expect(describeBaseUrlIssue('openai', '  ')).toBe('The base URL is empty.');
    expect(describeBaseUrlIssue('openai', 'agentrouter.org/v1')).toMatch(/http:\/\/ or https:\/\//);
  });
});

describe('pickProbeModel', () => {
  it('prefers the configured model whenever the gateway lists it', () => {
    // The whole point: a working gateway that serves `claude-opus-5` must not be
    // probed with something else and reported as 403.
    expect(pickProbeModel([{ id: 'gpt-4' }, { id: 'claude-opus-5' }], 'claude-opus-5')).toBe('claude-opus-5');
    expect(pickProbeModel([{ id: 'claude-opus-4-6' }, { id: 'gpt-4' }], 'gpt-4')).toBe('gpt-4');
    expect(pickProbeModel([{ id: 'gpt-4' }, { id: 'claude-opus-5' }], '  claude-opus-5  ')).toBe('claude-opus-5');
  });

  it('falls back to any Claude, then the first model, when the configured one is absent', () => {
    expect(pickProbeModel([{ id: 'gpt-4' }, { id: 'claude-opus-4-6' }], 'claude-opus-5')).toBe('claude-opus-4-6');
    expect(pickProbeModel([{ id: 'gpt-4' }], 'claude-opus-5')).toBe('gpt-4');
    expect(pickProbeModel([{ id: 'gpt-4' }, { id: 'claude-opus-4-8' }])).toBe('claude-opus-4-8');
    expect(pickProbeModel([{ id: 'gpt-4' }])).toBe('gpt-4');
  });

  it('explains an empty list rather than throwing something opaque', () => {
    expect(() => pickProbeModel([])).toThrow(/empty model list/);
    expect(() => pickProbeModel([], 'claude-opus-5')).toThrow(/empty model list/);
  });
});

describe('OpenAiTransport.listModels', () => {
  it('GETs <base>/models with Bearer auth and the honest User-Agent', async () => {
    const { client, mock } = transport([jsonResponse({ data: [{ id: 'claude-opus-4-6' }] })]);
    await client.listModels();

    const call = mock.calls[0];
    expect(call?.url).toBe('https://agentrouter.org/v1/models');
    expect(call?.init.method).toBe('GET');
    expect(call?.init.headers.Authorization).toBe('Bearer sk-test-key');
    expect(call?.init.headers['User-Agent']).toBe('AgentRouterMobile/1.0 (Android)');
  });

  it('surfaces the gateway’s own message verbatim', async () => {
    const { client } = transport([
      gatewayErrorResponse('令牌额度已用尽 (request id: abc)', 403, 'new_api_error'),
    ]);
    await expect(client.listModels()).rejects.toThrow('令牌额度已用尽 (request id: abc)');
  });
});

describe('OpenAiTransport.stream', () => {
  it('POSTs to <base>/chat/completions and streams text incrementally', async () => {
    const { client, mock } = transport([
      sseResponse([
        sseFrame({ id: 'chatcmpl-1', model: 'claude-opus-4-6', choices: [{ delta: { role: 'assistant' } }] }),
        sseFrame({ choices: [{ delta: { content: 'Hello' } }] }),
        sseFrame({ choices: [{ delta: { content: ' world' } }] }),
        sseFrame({ choices: [{ finish_reason: 'stop' }] }),
        sseFrame({ usage: { prompt_tokens: 9, completion_tokens: 2 } }),
        'data: [DONE]\n\n',
      ]),
    ]);

    const events = await collect(client.stream(request()));

    expect(mock.calls[0]?.url).toBe('https://agentrouter.org/v1/chat/completions');
    expect(mock.calls[0]?.init.headers.Accept).toBe('text/event-stream');
    expect(events).toEqual([
      { type: 'start', model: 'claude-opus-4-6' },
      { type: 'start', id: 'chatcmpl-1', model: 'claude-opus-4-6' },
      { type: 'text_delta', text: 'Hello' },
      { type: 'text_delta', text: ' world' },
      { type: 'stop', reason: 'end_turn' },
      { type: 'usage', usage: { input: 9, output: 2 } },
    ]);
  });

  it('emits start before the request goes out, so the UI can open the turn', async () => {
    const { client } = transport([sseResponse([sseFrame({ choices: [{ finish_reason: 'stop' }] })])]);
    const first = await client.stream(request()).next();
    expect(first.value).toEqual({ type: 'start', model: 'claude-opus-4-6' });
  });

  it('reassembles events split across arbitrary chunk boundaries', async () => {
    const whole =
      sseFrame({ choices: [{ delta: { content: 'ab' } }] }) +
      sseFrame({ choices: [{ delta: { content: 'cd' } }] }) +
      sseFrame({ choices: [{ finish_reason: 'stop' }] });
    // One byte at a time: the worst case a real network can produce.
    const { client } = transport([sseResponse(whole.split(''))]);

    const events = await collect(client.stream(request()));
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ab' },
      { type: 'text_delta', text: 'cd' },
    ]);
  });

  it('reports a stop reason even when the gateway closes without one', async () => {
    const { client } = transport([sseResponse([sseFrame({ choices: [{ delta: { content: 'hi' } }] })])]);
    const events = await collect(client.stream(request()));
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'unknown' });
  });

  it('infers tool_use when a tool call streamed but no finish_reason arrived', async () => {
    const { client } = transport([
      sseResponse([
        sseFrame({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', function: { name: 'go' } }] } }] }),
      ]),
    ]);
    const events = await collect(client.stream(request()));
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('still parses when the injected fetch cannot stream, which is the silent failure mode', async () => {
    const { client } = transport([
      bufferedResponse(
        sseFrame({ choices: [{ delta: { content: 'buffered' } }] }) +
          sseFrame({ choices: [{ finish_reason: 'stop' }] }),
      ),
    ]);
    const events = await collect(client.stream(request()));
    expect(events).toContainEqual({ type: 'text_delta', text: 'buffered' });
  });

  it('renames max_tokens to max_completion_tokens and says which param changed', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse("Unsupported parameter: 'max_tokens' is not supported with this model.", 400),
      sseResponse([sseFrame({ choices: [{ delta: { content: 'ok' } }] }), sseFrame({ choices: [{ finish_reason: 'stop' }] })]),
    ]);

    const events = await collect(client.stream(request()));

    expect(mock.bodies()[0]).toMatchObject({ max_tokens: 256 });
    // A rename, not a drop: the output cap must survive, or a reasoning model can
    // burn the whole budget.
    expect(mock.bodies()[1]).toMatchObject({ max_completion_tokens: 256 });
    expect(mock.bodies()[1]?.max_tokens).toBeUndefined();

    const dropped = events.find((event) => event.type === 'param_dropped');
    expect(dropped).toMatchObject({ param: 'max_tokens' });
    expect((dropped as { message: string }).message).toContain('max_completion_tokens');
    expect(events).toContainEqual({ type: 'text_delta', text: 'ok' });
  });

  it('drops one unsupported optional param, retries, and reports the gateway’s text', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse("Unsupported value: 'temperature' does not support 0.4 with this model.", 400),
      sseResponse([sseFrame({ choices: [{ finish_reason: 'stop' }] })]),
    ]);

    const events = await collect(client.stream(request({ params: { maxTokens: 32, temperature: 0.4, topP: 0.9 } })));

    expect(mock.calls).toHaveLength(2);
    expect(mock.bodies()[0]).toMatchObject({ temperature: 0.4, top_p: 0.9 });
    expect(mock.bodies()[1]?.temperature).toBeUndefined();
    // Only the offending param goes; the rest of the request is untouched.
    expect(mock.bodies()[1]).toMatchObject({ top_p: 0.9 });

    expect(events).toContainEqual({
      type: 'param_dropped',
      param: 'temperature',
      message: "Unsupported value: 'temperature' does not support 0.4 with this model.",
    });
  });

  it('gives up after one drop rather than peeling params off one at a time', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse("Unsupported parameter: 'temperature'", 400),
      gatewayErrorResponse("Unsupported parameter: 'top_p'", 400),
    ]);

    await expect(collect(client.stream(request({ params: { maxTokens: 32, temperature: 0.4, topP: 0.9 } })))).rejects.toThrow(
      "Unsupported parameter: 'top_p'",
    );
    expect(mock.calls).toHaveLength(2);
  });

  it('calls onParamDropped so the composer can show the note without reading the stream', async () => {
    const { client } = transport([
      gatewayErrorResponse("Unsupported parameter: 'seed'", 400),
      sseResponse([sseFrame({ choices: [{ finish_reason: 'stop' }] })]),
    ]);

    const dropped: [string, string][] = [];
    await collect(
      client.stream(request({ params: { maxTokens: 32, seed: 1 } }), {
        onParamDropped: (param, message) => dropped.push([param, message]),
      }),
    );

    expect(dropped).toEqual([['seed', "Unsupported parameter: 'seed'"]]);
  });

  it('throws mid-stream errors rather than retrying over text already rendered', async () => {
    const { client, mock } = transport([
      sseResponse([
        sseFrame({ choices: [{ delta: { content: 'partial' } }] }),
        sseFrame({ error: { message: 'upstream connection reset' } }),
      ]),
    ]);

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of client.stream(request())) events.push(event);
      })(),
    ).rejects.toThrow('upstream connection reset');

    expect(events).toContainEqual({ type: 'text_delta', text: 'partial' });
    expect(mock.calls).toHaveLength(1);
  });

  it('does not retry a 400', async () => {
    const { client, mock } = transport([gatewayErrorResponse('content blocked', 400, 'content_blocked')]);
    await expect(collect(client.stream(request()))).rejects.toThrow('content blocked');
    expect(mock.calls).toHaveLength(1);
  });

  it('cancels the reader when the consumer stops early', async () => {
    const response = sseResponse([
      sseFrame({ choices: [{ delta: { content: 'one' } }] }),
      sseFrame({ choices: [{ delta: { content: 'two' } }] }),
      sseFrame({ choices: [{ finish_reason: 'stop' }] }),
    ]);
    const { client } = transport([response]);

    const stream = client.stream(request());
    await stream.next(); // synthetic start
    await stream.next(); // first text delta
    await stream.return(undefined);

    expect(response.cancelled()).toBe('consumer stopped');
  });

  it('aborts promptly when the signal fires', async () => {
    const controller = new AbortController();
    const { client } = transport([
      () => {
        controller.abort();
        const error = new Error('Aborted');
        error.name = 'AbortError';
        return error;
      },
    ]);

    await expect(collect(client.stream(request(), { signal: controller.signal }))).rejects.toThrow('Request stopped.');
  });
});

describe('OpenAiTransport.complete', () => {
  it('folds a non-streaming reply into a result, reading usage from the response', async () => {
    const { client, mock } = transport([
      jsonResponse({
        id: 'chatcmpl-9',
        model: 'claude-opus-4-6',
        choices: [
          {
            message: { role: 'assistant', content: 'Answer.', reasoning_content: 'Because.' },
            finish_reason: 'stop',
          },
        ],
        usage: {
          prompt_tokens: 12,
          completion_tokens: 4,
          completion_tokens_details: { reasoning_tokens: 3 },
          prompt_tokens_details: { cached_tokens: 10 },
        },
      }),
    ]);

    const result = await client.complete(request());

    expect(mock.bodies()[0]).toMatchObject({ stream: false });
    expect(result.id).toBe('chatcmpl-9');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ input: 12, output: 4, thinking: 3, cacheRead: 10 });
    expect(result.content).toEqual([
      { type: 'thinking', text: 'Because.' },
      { type: 'text', text: 'Answer.' },
    ]);
  });

  it('collects tool calls from a non-streaming reply', async () => {
    const { client } = transport([
      jsonResponse({
        choices: [
          {
            message: {
              tool_calls: [
                { id: 'call_1', function: { name: 'lookup', arguments: '{"q":"x"}' } },
                { id: 'call_2', function: { name: 'other', arguments: '{}' } },
              ],
            },
            finish_reason: 'tool_calls',
          },
        ],
      }),
    ]);

    const result = await client.complete(request());
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([
      { type: 'tool_use', id: 'call_1', name: 'lookup', input: { q: 'x' } },
      { type: 'tool_use', id: 'call_2', name: 'other', input: {} },
    ]);
  });

  it('records the rename in droppedParams so the UI can show what changed', async () => {
    const { client } = transport([
      gatewayErrorResponse("Unsupported parameter: 'max_tokens'", 400),
      jsonResponse({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }),
    ]);

    const result = await client.complete(request());
    expect(result.droppedParams).toEqual(['max_tokens']);
  });

  it('reports an empty success body as a parse error rather than an empty answer', async () => {
    const { client } = transport([jsonResponse('')]);
    await expect(client.complete(request())).rejects.toThrow(/empty body/);
  });
});

describe('OpenAiTransport.testConnection', () => {
  it('checks the base URL shape before sending anything', async () => {
    const mock = createMockFetch([]);
    const client = new OpenAiTransport({
      kind: 'openai',
      baseUrl: 'https://agentrouter.org',
      apiKey: 'sk-test-key',
      fetchImpl: mock.fetch,
      retryPolicy: NO_RETRY_POLICY,
    });

    const result = await client.testConnection();

    expect(result.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(result.steps[0]).toMatchObject({ label: 'Base URL shape', status: 'failed' });
    expect(result.steps[0]?.detail).toContain('/v1');
  });

  it('reports all four steps on success', async () => {
    const { client } = transport([
      jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
      jsonResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }], usage: { prompt_tokens: 8, completion_tokens: 1 } }),
      gatewayErrorResponse('prompt is required', 400),
    ]);

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'ok', 'ok', 'ok']);
    expect(result.summary).toContain('1 models available');
    expect(result.steps[2]?.detail).toContain('8 input / 1 output');
    // A 400 on an empty body is the route answering, so image generation is there.
    expect(result.steps[3]?.detail).toContain('available');
  });

  it('says image generation is absent on a 404, without failing the test', async () => {
    const { client, mock } = transport([
      jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
      jsonResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] }),
      gatewayErrorResponse('no such endpoint', 404),
    ]);

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.steps[3]).toMatchObject({ status: 'skipped' });
    expect(result.steps[3]?.detail).toContain('does not serve image generation');
    // Nothing was asked for, so the probe cannot have generated a billable image.
    expect(mock.bodies()[2]).toEqual({});
  });

  it('reports one ambiguous conclusion on a 401, naming both causes', async () => {
    const { client } = transport([
      jsonResponse(
        {
          error: { message: 'unauthorized client detected, contact support for assistance' },
          type: 'unauthorized_client_error',
        },
        401,
      ),
    ]);

    const result = await client.testConnection();

    expect(result.ok).toBe(false);
    // Credential first, allowlist second — a no-key request returns this same type,
    // so the type cannot tell the two apart and the summary must not pretend it can.
    expect(result.summary).toContain('re-paste');
    expect(result.summary).toContain('allowlisting');
    expect(result.steps[1]?.error?.kind).toBe('unauthorized');
    // The gateway's own text, verbatim, never a bare "Request failed".
    expect(result.steps[1]?.detail).toContain('unauthorized client detected');
    expect(result.steps[2]).toMatchObject({ status: 'skipped' });
  });

  it('treats a plain 401 the same way and says where to check', async () => {
    const { client } = transport([gatewayErrorResponse('invalid token', 401)]);
    const result = await client.testConnection();
    expect(result.steps[1]?.error?.kind).toBe('unauthorized');
    expect(result.summary).toContain('gateway console');
  });

  it('says model discovery worked but the chat path did not', async () => {
    const { client } = transport([
      jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
      gatewayErrorResponse('content blocked', 400),
    ]);

    const result = await client.testConnection();
    expect(result.ok).toBe(false);
    expect(result.summary).toContain('Model discovery worked');
    expect(result.summary).toContain('content blocked');
  });

  it('probes the profile’s configured model, not a built-in guess', async () => {
    const { client, mock } = transport(
      [
        jsonResponse({ data: [{ id: 'claude-opus-4-6' }, { id: 'claude-opus-5' }] }),
        jsonResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] }),
      ],
      { defaultModel: 'claude-opus-5' },
    );

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.probedModel).toBe('claude-opus-5');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-5' });
    // Nothing to warn about: the configured model is the one that was proved.
    expect(result.steps.map((step) => step.label)).not.toContain('Configured model');
  });

  it('names the mismatch when the gateway does not serve the configured model', async () => {
    const { client, mock } = transport(
      [
        jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
        jsonResponse({ choices: [{ message: { content: 'Hi' }, finish_reason: 'stop' }] }),
      ],
      { defaultModel: 'claude-opus-5' },
    );

    const result = await client.testConnection();

    expect(result.probedModel).toBe('claude-opus-4-6');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-4-6' });
    const step = result.steps.find((s) => s.label === 'Configured model');
    expect(step).toMatchObject({ status: 'failed' });
    expect(step?.detail).toContain('claude-opus-5');
    expect(step?.detail).toContain('claude-opus-4-6');
  });
});
