/**
 * Anthropic-compatible transport.
 *
 * Mirror of `openai.test.ts`, asserting the opposite side of every divergence:
 * system prompt as a top-level field, images as base64 source objects, tool
 * results merged into one user turn, named stream events, thinking as a
 * first-class block. Plus the two validation constraints the spec asks to catch
 * before the API does.
 */

import { GatewayError } from '../errors';
import { NO_RETRY_POLICY } from '../retry';
import {
  AnthropicTransport,
  buildAnthropicBody,
  createAnthropicStreamState,
  toAnthropicMessages,
  translateAnthropicEvent,
  translateAnthropicUsage,
  translateStopReason,
} from '../anthropic';
import type { ChatRequest, StreamEvent } from '../types';
import { createResultAccumulator } from '../types';
import { bufferedResponse, collect, createMockFetch, gatewayErrorResponse, jsonResponse, sseFrame, sseResponse } from './testFetch';

const BASE_URL = 'https://agentrouter.org';

function request(overrides: Partial<ChatRequest> = {}): ChatRequest {
  return {
    model: 'claude-opus-4-6',
    messages: [{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }],
    // Deliberately roomy: the thinking budget is clamped to leave the answer
    // headroom, so a small default here would silently clamp every budget
    // assertion below and hide what the effort ladder actually resolves to.
    params: { maxTokens: 16384 },
    ...overrides,
  };
}

function transport(
  responders: Parameters<typeof createMockFetch>[0],
  baseUrl = BASE_URL,
  options: { defaultModel?: string } = {},
) {
  const mock = createMockFetch(responders);
  const client = new AnthropicTransport({
    kind: 'anthropic',
    baseUrl,
    apiKey: 'sk-test-key',
    fetchImpl: mock.fetch,
    retryPolicy: NO_RETRY_POLICY,
    ...options,
  });
  return { client, mock };
}

async function accumulate(events: StreamEvent[]) {
  const accumulator = createResultAccumulator();
  for (const event of events) accumulator.handle(event);
  return accumulator.result();
}

/** A `message_start` / `message_delta` / `message_stop` envelope around `frames`. */
function conversation(frames: string[], stopReason = 'end_turn'): string[] {
  return [
    sseFrame({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-6', usage: { input_tokens: 11 } } }, 'message_start'),
    ...frames,
    sseFrame({ type: 'message_delta', delta: { stop_reason: stopReason }, usage: { output_tokens: 4 } }, 'message_delta'),
    sseFrame({ type: 'message_stop' }, 'message_stop'),
  ];
}

describe('buildAnthropicBody', () => {
  it('puts the system prompt in a top-level field, not a message', () => {
    const body = buildAnthropicBody(request({ system: 'Be terse.' }), false);
    expect(body.system).toBe('Be terse.');
    expect(body.messages).toEqual([{ role: 'user', content: [{ type: 'text', text: 'Hello' }] }]);
  });

  it('omits a blank system prompt rather than sending an empty string', () => {
    expect(buildAnthropicBody(request({ system: '   ' }), false).system).toBeUndefined();
  });

  it('always sends max_tokens, which this API requires', () => {
    expect(buildAnthropicBody(request(), false).max_tokens).toBe(16384);
  });

  it('maps sampling params and silently has no home for the OpenAI-only ones', () => {
    const body = buildAnthropicBody(
      request({
        params: {
          maxTokens: 4096,
          temperature: 0.4,
          topP: 0.9,
          topK: 40,
          stopSequences: ['STOP'],
          seed: 7,
          presencePenalty: 0.5,
          frequencyPenalty: 0.5,
        },
      }),
      false,
    );

    expect(body).toMatchObject({ temperature: 0.4, top_p: 0.9, top_k: 40, stop_sequences: ['STOP'] });
    // No Anthropic equivalent exists; the UI greys these out on this transport.
    expect(body.seed).toBeUndefined();
    expect(body.presence_penalty).toBeUndefined();
    expect(body.frequency_penalty).toBeUndefined();
  });

  it('sends thinking as a budget, because the wire API has no effort names', () => {
    const body = buildAnthropicBody(request({ reasoning: { enabled: true, effort: 'medium' } }), false);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 8192 });
  });

  it('lets an explicit budget override the effort ladder', () => {
    const body = buildAnthropicBody(request({ reasoning: { enabled: true, effort: 'low', budgetTokens: 2500 } }), false);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 2500 });
  });

  it('clamps the budget so the answer keeps its headroom', () => {
    // max effort wants 60000 but max_tokens is 16384 and the answer keeps 1024,
    // so the budget shrinks to what is actually left.
    const body = buildAnthropicBody(request({ reasoning: { enabled: true, effort: 'max' } }), false);
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 15360 });
  });

  it('sends thinking: disabled only when reasoning was explicitly turned off', () => {
    expect(buildAnthropicBody(request({ reasoning: { enabled: false } }), false).thinking).toEqual({ type: 'disabled' });
    // No reasoning config at all means say nothing about thinking.
    expect(buildAnthropicBody(request(), false).thinking).toBeUndefined();
  });

  it('omits temperature, top_p and top_k when thinking is on', () => {
    const body = buildAnthropicBody(
      request({
        params: { maxTokens: 8192, temperature: 0.4, topP: 0.9, topK: 40 },
        reasoning: { enabled: true, effort: 'low' },
      }),
      false,
    );
    // Extended thinking pins temperature to 1, so sending 0.4 is a rejection waiting
    // to happen. Omitted rather than overridden.
    expect(body.temperature).toBeUndefined();
    expect(body.top_p).toBeUndefined();
    expect(body.top_k).toBeUndefined();
    expect(body.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
  });

  it('rejects disabling thinking at xhigh or max before the API can 400', () => {
    for (const effort of ['xhigh', 'max'] as const) {
      expect(() => buildAnthropicBody(request({ reasoning: { enabled: false, effort } }), false)).toThrow(
        /Thinking cannot be disabled at effort/,
      );
    }
    // Allowed at high and below.
    expect(() => buildAnthropicBody(request({ reasoning: { enabled: false, effort: 'high' } }), false)).not.toThrow();
  });

  it('rejects a max_tokens too small to hold a thinking budget and an answer', () => {
    expect(() =>
      buildAnthropicBody(request({ params: { maxTokens: 512 }, reasoning: { enabled: true, effort: 'low' } }), false),
    ).toThrow(/Raise max_tokens to at least 2048/);
  });

  it('classifies a validation failure so the UI can tell it from a gateway rejection', () => {
    expect.assertions(2);
    try {
      buildAnthropicBody(request({ reasoning: { enabled: false, effort: 'max' } }), false);
    } catch (error) {
      expect(error).toBeInstanceOf(GatewayError);
      expect((error as GatewayError).kind).toBe('validation');
    }
  });

  it('uses input_schema, not parameters, for tools', () => {
    const body = buildAnthropicBody(
      request({ tools: [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }] }),
      false,
    );
    expect(body.tools).toEqual([{ name: 'lookup', description: 'Look up', input_schema: { type: 'object' } }]);
  });

  it('translates tool_choice into the object form', () => {
    const tools = [{ name: 'lookup', description: 'Look up', inputSchema: { type: 'object' } }];
    const choice = (toolChoice: ChatRequest['toolChoice']) => buildAnthropicBody(request({ tools, toolChoice }), false).tool_choice;

    expect(choice({ type: 'auto' })).toEqual({ type: 'auto' });
    expect(choice({ type: 'any' })).toEqual({ type: 'any' });
    expect(choice({ type: 'none' })).toEqual({ type: 'none' });
    expect(choice({ type: 'tool', name: 'lookup' })).toEqual({ type: 'tool', name: 'lookup' });
  });

  it('merges extraBody last', () => {
    expect(buildAnthropicBody(request({ extraBody: { max_tokens: 9 } }), false).max_tokens).toBe(9);
  });

  describe('cache_control', () => {
    const EPHEMERAL = { type: 'ephemeral' };

    it('sends an unmarked system prompt as a plain string', () => {
      expect(buildAnthropicBody(request({ system: 'Be brief.' }), false).system).toBe('Be brief.');
    });

    it('promotes a marked system prompt to block form, the only shape with room for a marker', () => {
      const body = buildAnthropicBody(request({ system: 'Be brief.', cache: { system: true } }), false);
      expect(body.system).toEqual([{ type: 'text', text: 'Be brief.', cache_control: EPHEMERAL }]);
    });

    it('marks only the last tool definition, since breakpoints cover everything before them', () => {
      const tools = [
        { name: 'a', description: 'A.', inputSchema: { type: 'object' } },
        { name: 'b', description: 'B.', inputSchema: { type: 'object' } },
      ];
      const body = buildAnthropicBody(request({ tools, cache: { tools: true } }), false);
      const sent = body.tools as Record<string, unknown>[];
      expect(sent[0]?.cache_control).toBeUndefined();
      expect(sent[1]?.cache_control).toEqual(EPHEMERAL);
    });

    it('leaves the manifest unmarked when caching was not planned', () => {
      const tools = [{ name: 'a', description: 'A.', inputSchema: { type: 'object' } }];
      const body = buildAnthropicBody(request({ tools }), false);
      expect((body.tools as Record<string, unknown>[])[0]?.cache_control).toBeUndefined();
    });

    it('marks nothing anywhere when the request carries no cache plan', () => {
      const body = buildAnthropicBody(request({ system: 'Be brief.' }), false);
      expect(JSON.stringify(body)).not.toContain('cache_control');
    });
  });
});

describe('toAnthropicMessages', () => {
  it('encodes images as base64 source objects, not data URLs', () => {
    expect(
      toAnthropicMessages([{ role: 'user', content: [{ type: 'image', mediaType: 'image/png', data: 'AAAB' }] }]),
    ).toEqual([
      { role: 'user', content: [{ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } }] },
    ]);
  });

  it('sends PDFs as native document blocks', () => {
    expect(
      toAnthropicMessages([
        { role: 'user', content: [{ type: 'document', mediaType: 'application/pdf', data: 'JVBER', name: 'a.pdf' }] },
      ]),
    ).toEqual([
      {
        role: 'user',
        content: [
          {
            type: 'document',
            source: { type: 'base64', media_type: 'application/pdf', data: 'JVBER' },
            title: 'a.pdf',
          },
        ],
      },
    ]);
  });

  it('sends plain text files as text-source documents', () => {
    const [message] = toAnthropicMessages([
      { role: 'user', content: [{ type: 'document', mediaType: 'text/markdown', text: '# Hi', name: 'r.md' }] },
    ]);
    expect(message?.content).toEqual([
      { type: 'document', source: { type: 'text', media_type: 'text/plain', data: '# Hi' }, title: 'r.md' },
    ]);
  });

  it('falls back to headed text for a type with no native support', () => {
    const [message] = toAnthropicMessages([
      { role: 'user', content: [{ type: 'document', mediaType: 'application/json', text: '{}', name: 'd.json' }] },
    ]);
    expect(message?.content).toEqual([{ type: 'text', text: '--- d.json (application/json) ---\n{}' }]);
  });

  it('says so when an attachment could not be sent at all', () => {
    const [message] = toAnthropicMessages([
      { role: 'user', content: [{ type: 'document', mediaType: 'application/zip', name: 'z.zip' }] },
    ]);
    const text = (message?.content as { text: string }[])[0]?.text;
    expect(text).toContain('could not be sent');
    expect(text).toContain('z.zip');
  });

  it('merges consecutive same-role turns, which is how tool results batch', () => {
    const messages = toAnthropicMessages([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'one' }] },
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'b', content: 'two' }] },
      { role: 'user', content: [{ type: 'text', text: 'now what?' }] },
    ]);

    expect(messages).toEqual([
      {
        role: 'user',
        content: [
          { type: 'tool_result', tool_use_id: 'a', content: 'one' },
          { type: 'tool_result', tool_use_id: 'b', content: 'two' },
          { type: 'text', text: 'now what?' },
        ],
      },
    ]);
  });

  it('flags an errored tool result with is_error rather than a text prefix', () => {
    const [message] = toAnthropicMessages([
      { role: 'user', content: [{ type: 'tool_result', toolUseId: 'a', content: 'timed out', isError: true }] },
    ]);
    expect(message?.content).toEqual([{ type: 'tool_result', tool_use_id: 'a', content: 'timed out', is_error: true }]);
  });

  it('replays a signed thinking block and drops an unsigned one', () => {
    const [signed] = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'thinking', text: 'because', signature: 'sig' }] },
    ]);
    expect(signed?.content).toEqual([{ type: 'thinking', thinking: 'because', signature: 'sig' }]);

    // Replaying thinking without its signature is a hard rejection, so it is dropped
    // and the message vanishes rather than being sent hollow.
    expect(toAnthropicMessages([{ role: 'assistant', content: [{ type: 'thinking', text: 'because' }] }])).toEqual([]);
  });

  it('round-trips redacted thinking as its own block', () => {
    const [message] = toAnthropicMessages([
      { role: 'assistant', content: [{ type: 'thinking', text: '', redacted: 'ENCRYPTED' }] },
    ]);
    expect(message?.content).toEqual([{ type: 'redacted_thinking', data: 'ENCRYPTED' }]);
  });

  it('skips a message that translated to no blocks, which the API rejects', () => {
    expect(toAnthropicMessages([{ role: 'user', content: [{ type: 'text', text: '' }] }])).toEqual([]);
  });

  it('does not merge across a role change', () => {
    const messages = toAnthropicMessages([
      { role: 'user', content: [{ type: 'text', text: 'a' }] },
      { role: 'assistant', content: [{ type: 'text', text: 'b' }] },
      { role: 'user', content: [{ type: 'text', text: 'c' }] },
    ]);
    expect(messages.map((message) => message.role)).toEqual(['user', 'assistant', 'user']);
  });

  describe('cacheThrough', () => {
    const EPHEMERAL = { type: 'ephemeral' };

    const chat = (count: number) =>
      Array.from({ length: count }, (_, i) => ({
        role: (i % 2 === 0 ? 'user' : 'assistant') as 'user' | 'assistant',
        content: [{ type: 'text' as const, text: `m${i}` }],
      }));

    /** Indices of wire messages whose last block carries a marker. */
    const marked = (messages: Record<string, unknown>[]): number[] =>
      messages.flatMap((message, index) => {
        const content = message.content as Record<string, unknown>[];
        return content[content.length - 1]?.cache_control ? [index] : [];
      });

    it('marks nothing when no breakpoint was asked for', () => {
      expect(marked(toAnthropicMessages(chat(4)))).toEqual([]);
    });

    it('marks the last block of the requested message, and only that one', () => {
      const messages = toAnthropicMessages(chat(4), 1);
      expect(marked(messages)).toEqual([1]);
      expect((messages[1]?.content as Record<string, unknown>[])[0]?.cache_control).toEqual(EPHEMERAL);
    });

    it('steps back rather than over-covering when the requested message merged with the tail', () => {
      // Unified indices 1 and 2 are both user turns, so they become one wire
      // message ending at 2. Asking to cache through 1 must not mark it: that
      // would cache the message the user just typed, writing a fresh entry every
      // turn and reading one that is always an exchange short.
      const unified = [
        { role: 'assistant' as const, content: [{ type: 'text' as const, text: 'earlier' }] },
        { role: 'user' as const, content: [{ type: 'tool_result' as const, toolUseId: 'a', content: 'ok' }] },
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'and now?' }] },
      ];
      const messages = toAnthropicMessages(unified, 1);
      expect(messages).toHaveLength(2);
      expect(marked(messages)).toEqual([0]);
    });

    it('marks nothing when no wire message ends inside the requested prefix', () => {
      const unified = [
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'a' }] },
        { role: 'user' as const, content: [{ type: 'text' as const, text: 'b' }] },
      ];
      // The single merged wire message ends at index 1, past the request.
      expect(marked(toAnthropicMessages(unified, 0))).toEqual([]);
    });

    it('marks the last wire message when asked to cache through the end', () => {
      const messages = chat(4);
      expect(marked(toAnthropicMessages(messages, messages.length - 1))).toEqual([3]);
    });

    it('ignores an index past the end of the conversation', () => {
      expect(marked(toAnthropicMessages(chat(2), 99))).toEqual([1]);
    });

    it('reaches the marker through buildAnthropicBody', () => {
      const body = buildAnthropicBody(request({ messages: chat(4), cache: { historyThrough: 1 } }), false);
      expect(marked(body.messages as Record<string, unknown>[])).toEqual([1]);
    });
  });
});

describe('translateAnthropicEvent', () => {
  it('reads the event name from the body, falling back to the SSE event line', () => {
    const state = createAnthropicStreamState();
    // No `type` in the payload: the `event:` line has to carry it.
    expect(
      translateAnthropicEvent({ event: 'content_block_delta', data: JSON.stringify({ delta: { type: 'text_delta', text: 'hi' } }) }, state),
    ).toEqual([{ type: 'text_delta', text: 'hi' }]);
  });

  it('turns message_start into start plus the input usage', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent(
        { data: JSON.stringify({ type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-6', usage: { input_tokens: 11 } } }) },
        state,
      ),
    ).toEqual([
      { type: 'start', id: 'msg_1', model: 'claude-opus-4-6' },
      { type: 'usage', usage: { input: 11 } },
    ]);
  });

  it('separates thinking deltas from text deltas', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'hmm' } }) }, state),
    ).toEqual([{ type: 'thinking_delta', text: 'hmm' }]);
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: 'so' } }) }, state),
    ).toEqual([{ type: 'text_delta', text: 'so' }]);
  });

  it('captures the thinking signature, which a replay needs verbatim', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }) }, state),
    ).toEqual([{ type: 'thinking_signature', signature: 'SIG' }]);
  });

  it('passes redacted thinking through from the block start', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'redacted_thinking', data: 'ENC' } }) }, state),
    ).toEqual([{ type: 'redacted_thinking', data: 'ENC' }]);
  });

  it('re-indexes tool calls densely, ignoring the wire block index', () => {
    const state = createAnthropicStreamState();
    // Text at wire index 0, first tool at wire index 1 — the tool is local index 0.
    translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) }, state);
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_a', name: 'lookup' } }) }, state),
    ).toEqual([{ type: 'tool_use_start', index: 0, id: 'toolu_a', name: 'lookup' }]);

    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":' } }) }, state),
    ).toEqual([{ type: 'tool_use_delta', index: 0, partialJson: '{"q":' }]);

    expect(translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_stop', index: 1 }) }, state)).toEqual([
      { type: 'tool_use_stop', index: 0 },
    ]);
  });

  it('ignores input_json_delta for a block that is not a tool call', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_delta', index: 3, delta: { type: 'input_json_delta', partial_json: '{}' } }) }, state),
    ).toEqual([]);
  });

  it('emits nothing extra for content_block_stop on a text block', () => {
    const state = createAnthropicStreamState();
    translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }) }, state);
    expect(translateAnthropicEvent({ data: JSON.stringify({ type: 'content_block_stop', index: 0 }) }, state)).toEqual([]);
  });

  it('takes output usage and the stop reason from message_delta', () => {
    const state = createAnthropicStreamState();
    expect(
      translateAnthropicEvent({ data: JSON.stringify({ type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { output_tokens: 7 } }) }, state),
    ).toEqual([
      { type: 'usage', usage: { output: 7 } },
      { type: 'stop', reason: 'end_turn' },
    ]);
    expect(state.sawStop).toBe(true);
  });

  it('does not double-count the stop on message_stop or react to ping', () => {
    const state = createAnthropicStreamState();
    expect(translateAnthropicEvent({ data: JSON.stringify({ type: 'message_stop' }) }, state)).toEqual([]);
    expect(translateAnthropicEvent({ data: JSON.stringify({ type: 'ping' }) }, state)).toEqual([]);
  });

  it('throws on an error frame inside a 200 stream, keeping the gateway text', () => {
    const state = createAnthropicStreamState();
    expect.assertions(3);
    try {
      translateAnthropicEvent({ data: JSON.stringify({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }) }, state);
    } catch (error) {
      expect((error as GatewayError).message).toBe('Overloaded');
      expect((error as GatewayError).gatewayType).toBe('overloaded_error');
      expect((error as GatewayError).kind).toBe('server');
    }
  });

  it('ignores unparseable data and unknown event types', () => {
    const state = createAnthropicStreamState();
    expect(translateAnthropicEvent({ data: 'not json' }, state)).toEqual([]);
    expect(translateAnthropicEvent({ data: JSON.stringify({ type: 'something_new' }) }, state)).toEqual([]);
  });
});

describe('translateStopReason', () => {
  it.each([
    ['end_turn', 'end_turn'],
    ['max_tokens', 'max_tokens'],
    ['stop_sequence', 'stop_sequence'],
    ['tool_use', 'tool_use'],
    // Kept distinct rather than flattened into end_turn: it means the model wants
    // the turn continued, which is a different UI affordance.
    ['pause_turn', 'pause_turn'],
    ['refusal', 'content_filter'],
    ['brand_new_reason', 'unknown'],
  ])('maps %s to %s', (wire, expected) => {
    expect(translateStopReason(wire)).toBe(expected);
  });

  it('maps null to unknown', () => {
    expect(translateStopReason(null)).toBe('unknown');
  });
});

describe('translateAnthropicUsage', () => {
  it('maps the cache fields and leaves thinking undefined', () => {
    expect(
      translateAnthropicUsage({
        input_tokens: 100,
        output_tokens: 50,
        cache_read_input_tokens: 80,
        cache_creation_input_tokens: 20,
      }),
    ).toEqual({ input: 100, output: 50, cacheRead: 80, cacheWrite: 20 });
  });

  it('does not invent a thinking count, because this API folds it into output', () => {
    // Anthropic reports thinking inside output_tokens and never breaks it out.
    // Estimating here would put a made-up number in the per-message breakdown.
    expect(translateAnthropicUsage({ input_tokens: 1, output_tokens: 2 }).thinking).toBeUndefined();
  });
});

describe('AnthropicTransport requests', () => {
  it('posts to <base>/v1/messages with the version header and Bearer auth', async () => {
    const { client, mock } = transport([sseResponse(conversation([]))]);
    await collect(client.stream(request()));

    const call = mock.calls[0];
    expect(call?.url).toBe('https://agentrouter.org/v1/messages');
    expect(call?.init.headers['anthropic-version']).toBe('2023-06-01');
    // The gateway issues Bearer tokens for both paths, even though upstream
    // Anthropic wants x-api-key.
    expect(call?.init.headers.Authorization).toBe('Bearer sk-test-key');
    expect(call?.init.headers['x-api-key']).toBeUndefined();
  });

  it('reads the model list from /v1/models under the bare origin', async () => {
    const { client, mock } = transport([jsonResponse({ data: [{ id: 'claude-opus-4-8' }] })]);
    const models = await client.listModels();
    expect(mock.calls[0]?.url).toBe('https://agentrouter.org/v1/models');
    expect(models).toEqual([{ id: 'claude-opus-4-8' }]);
  });

  it('sends anthropic-beta only when betas were hinted', async () => {
    const { client, mock } = transport([sseResponse(conversation([])), sseResponse(conversation([]))]);
    await collect(client.stream(request()));
    expect(mock.calls[0]?.init.headers['anthropic-beta']).toBeUndefined();

    await collect(client.stream(request({ wireHints: { betas: ['interleaved-thinking-2025-05-14'] } })));
    expect(mock.calls[1]?.init.headers['anthropic-beta']).toBe('interleaved-thinking-2025-05-14');
  });
});

describe('AnthropicTransport.stream', () => {
  it('streams text incrementally and reports usage from both ends', async () => {
    const { client } = transport([
      sseResponse(
        conversation([
          sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'text' } }),
          sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hel' } }),
          sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'lo' } }),
          sseFrame({ type: 'content_block_stop', index: 0 }),
        ]),
      ),
    ]);

    const events = await collect(client.stream(request()));

    expect(events).toEqual([
      { type: 'start', model: 'claude-opus-4-6' },
      { type: 'start', id: 'msg_1', model: 'claude-opus-4-6' },
      { type: 'usage', usage: { input: 11 } },
      { type: 'text_delta', text: 'Hel' },
      { type: 'text_delta', text: 'lo' },
      { type: 'usage', usage: { output: 4 } },
      { type: 'stop', reason: 'end_turn' },
    ]);
  });

  it('emits start before the request goes out, like the other transport', async () => {
    const { client } = transport([sseResponse(conversation([]))]);
    const first = await client.stream(request()).next();
    expect(first.value).toEqual({ type: 'start', model: 'claude-opus-4-6' });
  });

  it('merges the two starts into one turn rather than two', async () => {
    const { client } = transport([
      sseResponse(conversation([sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })])),
    ]);
    const result = await accumulate(await collect(client.stream(request())));
    expect(result.id).toBe('msg_1');
    expect(result.model).toBe('claude-opus-4-6');
    expect(result.content).toEqual([{ type: 'text', text: 'hi' }]);
  });

  it('reassembles frames split one byte at a time', async () => {
    const whole = conversation([
      sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ab' } }),
      sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'cd' } }),
    ]).join('');
    const { client } = transport([sseResponse(whole.split(''))]);

    const events = await collect(client.stream(request()));
    expect(events.filter((event) => event.type === 'text_delta')).toEqual([
      { type: 'text_delta', text: 'ab' },
      { type: 'text_delta', text: 'cd' },
    ]);
  });

  it('accumulates a streamed tool call into parsed arguments', async () => {
    const { client } = transport([
      sseResponse(
        conversation(
          [
            sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_a', name: 'search' } }),
            sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q"' } }),
            sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: ':"cats"}' } }),
            sseFrame({ type: 'content_block_stop', index: 0 }),
          ],
          'tool_use',
        ),
      ),
    ]);

    const result = await accumulate(await collect(client.stream(request())));
    expect(result.stopReason).toBe('tool_use');
    expect(result.content).toEqual([{ type: 'tool_use', id: 'toolu_a', name: 'search', input: { q: 'cats' } }]);
  });

  it('keeps thinking, its signature and the answer in separate blocks', async () => {
    const { client } = transport([
      sseResponse(
        conversation([
          sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'thinking' } }),
          sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'thinking_delta', thinking: 'Let me think.' } }),
          sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'signature_delta', signature: 'SIG' } }),
          sseFrame({ type: 'content_block_stop', index: 0 }),
          sseFrame({ type: 'content_block_start', index: 1, content_block: { type: 'text' } }),
          sseFrame({ type: 'content_block_delta', index: 1, delta: { type: 'text_delta', text: '42' } }),
          sseFrame({ type: 'content_block_stop', index: 1 }),
        ]),
      ),
    ]);

    const result = await accumulate(await collect(client.stream(request())));
    expect(result.content).toEqual([
      { type: 'thinking', text: 'Let me think.', signature: 'SIG' },
      { type: 'text', text: '42' },
    ]);
  });

  it('reports a stop reason even when the gateway never sends message_delta', async () => {
    const { client } = transport([
      sseResponse([sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } })]),
    ]);
    const events = await collect(client.stream(request()));
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'unknown' });
  });

  it('infers tool_use when a tool streamed but the stop reason went missing', async () => {
    const { client } = transport([
      sseResponse([sseFrame({ type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'a', name: 'go' } })]),
    ]);
    const events = await collect(client.stream(request()));
    expect(events[events.length - 1]).toEqual({ type: 'stop', reason: 'tool_use' });
  });

  it('parses a buffered body when the injected fetch cannot stream', async () => {
    const { client } = transport([bufferedResponse(conversation([sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'buffered' } })]).join(''))]);
    const events = await collect(client.stream(request()));
    expect(events).toContainEqual({ type: 'text_delta', text: 'buffered' });
  });

  it('surfaces a mid-stream error without retrying over rendered text', async () => {
    const { client, mock } = transport([
      sseResponse([
        sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
        sseFrame({ type: 'error', error: { type: 'overloaded_error', message: 'Overloaded' } }),
      ]),
    ]);

    const events: StreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of client.stream(request())) events.push(event);
      })(),
    ).rejects.toThrow('Overloaded');

    expect(events).toContainEqual({ type: 'text_delta', text: 'partial' });
    expect(mock.calls).toHaveLength(1);
  });

  it('drops one unsupported param, retries, and reports which one went', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse("Unsupported parameter: 'top_k' is not supported.", 400),
      sseResponse(conversation([])),
    ]);

    const events = await collect(client.stream(request({ params: { maxTokens: 4096, topK: 40, temperature: 0.5 } })));

    expect(mock.bodies()[0]).toMatchObject({ top_k: 40, temperature: 0.5 });
    expect(mock.bodies()[1]?.top_k).toBeUndefined();
    expect(mock.bodies()[1]).toMatchObject({ temperature: 0.5 });
    expect(events).toContainEqual({
      type: 'param_dropped',
      param: 'top_k',
      message: "Unsupported parameter: 'top_k' is not supported.",
    });
  });

  it('drops thinking when the gateway does not proxy extended thinking', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse("Unsupported parameter: 'thinking'", 400),
      sseResponse(conversation([])),
    ]);

    const events = await collect(client.stream(request({ reasoning: { enabled: true, effort: 'low' } })));

    expect(mock.bodies()[0]?.thinking).toEqual({ type: 'enabled', budget_tokens: 4096 });
    expect(mock.bodies()[1]?.thinking).toBeUndefined();
    expect(events).toContainEqual({ type: 'param_dropped', param: 'thinking', message: "Unsupported parameter: 'thinking'" });
  });

  it('does not retry a 403 out of credits', async () => {
    const { client, mock } = transport([gatewayErrorResponse('当前分组上游负载已饱和', 403)]);
    await expect(collect(client.stream(request()))).rejects.toThrow('当前分组上游负载已饱和');
    expect(mock.calls).toHaveLength(1);
  });

  it('cancels the reader when the consumer stops early', async () => {
    const response = sseResponse(conversation([sseFrame({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'one' } })]));
    const { client } = transport([response]);

    const stream = client.stream(request());
    await stream.next();
    await stream.next();
    await stream.return(undefined);

    expect(response.cancelled()).toBe('consumer stopped');
  });
});

describe('AnthropicTransport.complete', () => {
  it('folds a message response into a result in block order', async () => {
    const { client, mock } = transport([
      jsonResponse({
        id: 'msg_9',
        model: 'claude-opus-4-6',
        content: [
          { type: 'thinking', thinking: 'Because.', signature: 'SIG' },
          { type: 'text', text: 'Answer.' },
        ],
        stop_reason: 'end_turn',
        usage: { input_tokens: 12, output_tokens: 4, cache_read_input_tokens: 10 },
      }),
    ]);

    const result = await client.complete(request());

    expect(mock.bodies()[0]).toMatchObject({ stream: false });
    expect(result.id).toBe('msg_9');
    expect(result.stopReason).toBe('end_turn');
    expect(result.usage).toEqual({ input: 12, output: 4, cacheRead: 10 });
    expect(result.content).toEqual([
      { type: 'thinking', text: 'Because.', signature: 'SIG' },
      { type: 'text', text: 'Answer.' },
    ]);
  });

  it('collects tool calls with dense indexes', async () => {
    const { client } = transport([
      jsonResponse({
        content: [
          { type: 'text', text: 'Looking.' },
          { type: 'tool_use', id: 'toolu_a', name: 'one', input: { x: 1 } },
          { type: 'tool_use', id: 'toolu_b', name: 'two', input: {} },
        ],
        stop_reason: 'tool_use',
      }),
    ]);

    const result = await client.complete(request());
    expect(result.content).toEqual([
      { type: 'text', text: 'Looking.' },
      { type: 'tool_use', id: 'toolu_a', name: 'one', input: { x: 1 } },
      { type: 'tool_use', id: 'toolu_b', name: 'two', input: {} },
    ]);
  });

  it('preserves a redacted thinking blob for the replay', async () => {
    const { client } = transport([
      jsonResponse({ content: [{ type: 'redacted_thinking', data: 'ENC' }, { type: 'text', text: 'ok' }], stop_reason: 'end_turn' }),
    ]);
    const result = await client.complete(request());
    expect(result.content).toContainEqual({ type: 'thinking', text: '', redacted: 'ENC' });
  });
});

describe('AnthropicTransport.countTokens', () => {
  it('posts a stripped body to count_tokens and returns the count', async () => {
    const { client, mock } = transport([jsonResponse({ input_tokens: 37 })]);

    const count = await client.countTokens(request({ params: { maxTokens: 4096, temperature: 0.5, topK: 5, stopSequences: ['X'] } }));

    expect(count).toBe(37);
    expect(mock.calls[0]?.url).toBe('https://agentrouter.org/v1/messages/count_tokens');
    const body = mock.bodies()[0];
    // Sampling controls are meaningless for a count and some gateways reject them.
    for (const key of ['max_tokens', 'stream', 'temperature', 'top_p', 'top_k', 'stop_sequences']) {
      expect(body?.[key]).toBeUndefined();
    }
    expect(body).toMatchObject({ model: 'claude-opus-4-6' });
  });

  it('reports a malformed answer as a parse error, so callers fall back cleanly', async () => {
    const { client } = transport([jsonResponse({ nope: true })]);
    await expect(client.countTokens(request())).rejects.toThrow(/input_tokens/);
  });

  it('lets a 404 through, which is the expected answer from most deployments', async () => {
    const { client } = transport([gatewayErrorResponse('404 page not found', 404)]);
    await expect(client.countTokens(request())).rejects.toThrow('404 page not found');
  });
});

describe('AnthropicTransport.testConnection', () => {
  it('refuses a base URL carrying /v1 before sending anything', async () => {
    const mock = createMockFetch([]);
    const client = new AnthropicTransport({
      kind: 'anthropic',
      baseUrl: 'https://agentrouter.org/v1',
      apiKey: 'sk-test-key',
      fetchImpl: mock.fetch,
      retryPolicy: NO_RETRY_POLICY,
    });

    const result = await client.testConnection();

    expect(result.ok).toBe(false);
    expect(mock.calls).toHaveLength(0);
    expect(result.steps[0]?.detail).toContain('bare origin');
  });

  it('reports both steps on success', async () => {
    const { client } = transport([
      jsonResponse({ data: [{ id: 'claude-opus-4-6' }, { id: 'gpt-5' }] }),
      jsonResponse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 1 } }),
    ]);

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.label)).toEqual(['Base URL shape', 'GET /v1/models', 'POST /v1/messages']);
    expect(result.summary).toContain('2 models available');
  });

  it('falls back to the built-in default when model discovery fails, rather than giving up', async () => {
    const { client, mock } = transport([
      gatewayErrorResponse('404 page not found', 404),
      jsonResponse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn', usage: { input_tokens: 8, output_tokens: 1 } }),
    ]);

    const result = await client.testConnection();

    // /v1/messages is the transport; the model list is a convenience. A gateway that
    // hides the list can still chat.
    expect(result.ok).toBe(true);
    expect(result.steps.map((step) => step.status)).toEqual(['ok', 'failed', 'ok', 'ok']);
    expect(result.steps[2]?.detail).toContain('claude-opus-4-6');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-4-6' });
    expect(result.summary).toContain('model list could not be read');
  });

  it('reports one ambiguous conclusion on a 401, naming both causes', async () => {
    const unauthorized = {
      error: { message: 'unauthorized client detected, contact support for assistance' },
      type: 'unauthorized_client_error',
    };
    const { client } = transport([jsonResponse(unauthorized, 401), jsonResponse(unauthorized, 401)]);

    const result = await client.testConnection();

    expect(result.ok).toBe(false);
    expect(result.summary).toContain('re-paste');
    expect(result.summary).toContain('allowlisting');
    expect(result.steps[3]?.error?.kind).toBe('unauthorized');
  });

  it('explains a blocked-language 400 rather than showing a bare 400', async () => {
    const { client } = transport([
      jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
      gatewayErrorResponse('content blocked: unsupported language detected', 400),
    ]);

    const result = await client.testConnection();
    expect(result.steps[2]?.error?.kind).toBe('content_blocked');
    expect(result.summary).toContain('Chinese, English, French, German or Russian');
  });

  it('probes the profile’s configured model when the gateway lists it', async () => {
    const { client, mock } = transport(
      [
        jsonResponse({ data: [{ id: 'claude-opus-4-6' }, { id: 'claude-opus-5' }] }),
        jsonResponse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }),
      ],
      BASE_URL,
      { defaultModel: 'claude-opus-5' },
    );

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.probedModel).toBe('claude-opus-5');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-5' });
    expect(result.steps.map((step) => step.label)).not.toContain('Configured model');
  });

  it('prefers the configured model over the built-in one when discovery fails', async () => {
    // Discovery is a convenience; the configured model is what every real message
    // will use, so that is what a probe has to prove.
    const { client, mock } = transport(
      [
        gatewayErrorResponse('404 page not found', 404),
        jsonResponse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }),
      ],
      BASE_URL,
      { defaultModel: 'claude-opus-5' },
    );

    const result = await client.testConnection();

    expect(result.ok).toBe(true);
    expect(result.probedModel).toBe('claude-opus-5');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-5' });
  });

  it('names the mismatch when the gateway does not serve the configured model', async () => {
    const { client, mock } = transport(
      [
        jsonResponse({ data: [{ id: 'claude-opus-4-6' }] }),
        jsonResponse({ content: [{ type: 'text', text: 'Hi' }], stop_reason: 'end_turn' }),
      ],
      BASE_URL,
      { defaultModel: 'claude-opus-5' },
    );

    const result = await client.testConnection();

    expect(result.probedModel).toBe('claude-opus-4-6');
    expect(mock.bodies()[1]).toMatchObject({ model: 'claude-opus-4-6' });
    const step = result.steps.find((s) => s.label === 'Configured model');
    expect(step).toMatchObject({ status: 'failed' });
    expect(step?.detail).toContain('claude-opus-5');
  });
});
