import { SseParser, parseEventData, SSE_DONE } from '../sse';

/** Feed a whole payload through the parser in fixed-size slices. */
function pushInChunks(parser: SseParser, payload: string, size: number) {
  const events = [];
  for (let i = 0; i < payload.length; i += size) {
    events.push(...parser.push(payload.slice(i, i + size)));
  }
  return events;
}

describe('SseParser', () => {
  it('parses a simple event with event name and data', () => {
    const parser = new SseParser();
    const events = parser.push('event: content_block_delta\ndata: {"a":1}\n\n');
    expect(events).toEqual([{ event: 'content_block_delta', data: '{"a":1}' }]);
  });

  it('parses data-only events (OpenAI style)', () => {
    const parser = new SseParser();
    const events = parser.push('data: {"choices":[]}\n\n');
    expect(events).toEqual([{ data: '{"choices":[]}' }]);
  });

  it('strips exactly one leading space after the colon', () => {
    const parser = new SseParser();
    const [one] = parser.push('data:  two-spaces\n\n');
    expect(one?.data).toBe(' two-spaces');

    const parser2 = new SseParser();
    const [none] = parser2.push('data:no-space\n\n');
    expect(none?.data).toBe('no-space');
  });

  it('joins multiple data lines with newlines', () => {
    const parser = new SseParser();
    const [event] = parser.push('data: line one\ndata: line two\ndata: line three\n\n');
    expect(event?.data).toBe('line one\nline two\nline three');
  });

  it('ignores comment and heartbeat lines without dispatching', () => {
    const parser = new SseParser();
    expect(parser.push(': ping\n')).toEqual([]);
    expect(parser.push(':\n')).toEqual([]);
    const events = parser.push('data: real\n\n');
    expect(events).toEqual([{ data: 'real' }]);
  });

  it('does not dispatch on consecutive blank lines', () => {
    const parser = new SseParser();
    expect(parser.push('\n\n\n')).toEqual([]);
  });

  it('handles CRLF line endings', () => {
    const parser = new SseParser();
    const events = parser.push('event: message_start\r\ndata: {"x":1}\r\n\r\n');
    expect(events).toEqual([{ event: 'message_start', data: '{"x":1}' }]);
  });

  it('handles bare CR line endings', () => {
    const parser = new SseParser();
    // A CR at the very end of the buffer is held back: it may yet turn out to be
    // the first half of a CRLF. So the event lands once more input arrives...
    expect(parser.push('event: ping\rdata: {}\r\r')).toEqual([]);
    expect(parser.push('event: next\r\r')).toEqual([{ event: 'ping', data: '{}' }]);
    // ...or on flush at end of stream.
    expect(parser.flush()).toEqual([{ event: 'next', data: '' }]);
  });

  it('dispatches bare-CR events mid-stream when more bytes follow', () => {
    const parser = new SseParser();
    const events = parser.push('event: a\rdata: 1\r\revent: b\rdata: 2\r\rx');
    expect(events).toEqual([
      { event: 'a', data: '1' },
      { event: 'b', data: '2' },
    ]);
  });

  it('holds back a trailing CR that may be the first half of CRLF', () => {
    const parser = new SseParser();
    // The \r arrives at the end of one chunk; its \n starts the next.
    expect(parser.push('data: split')).toEqual([]);
    expect(parser.push('\r')).toEqual([]);
    expect(parser.push('\ndata: second\r\n\r\n')).toEqual([{ data: 'split\nsecond' }]);
  });

  it('reassembles an event split across many chunk boundaries', () => {
    const payload =
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":"Hello"}}\n\n' +
      'event: content_block_delta\ndata: {"type":"content_block_delta","delta":{"text":" world"}}\n\n';

    // Every chunk size from 1 byte upward must produce identical results.
    for (const size of [1, 2, 3, 5, 7, 13, 29, 64, 1024]) {
      const parser = new SseParser();
      const events = pushInChunks(parser, payload, size);
      expect(events).toHaveLength(2);
      expect(events[0]?.data).toContain('Hello');
      expect(events[1]?.data).toContain(' world');
    }
  });

  it('survives a split in the middle of a field name', () => {
    const parser = new SseParser();
    expect(parser.push('ev')).toEqual([]);
    expect(parser.push('ent: del')).toEqual([]);
    expect(parser.push('ta\nda')).toEqual([]);
    expect(parser.push('ta: {"v":1}\n\n')).toEqual([{ event: 'delta', data: '{"v":1}' }]);
  });

  it('tracks id and retry fields', () => {
    const parser = new SseParser();
    const [event] = parser.push('id: 42\nretry: 3000\ndata: x\n\n');
    expect(event).toEqual({ id: '42', retry: 3000, data: 'x' });
    expect(parser.lastEventId).toBe('42');
  });

  it('ignores a non-numeric retry value', () => {
    const parser = new SseParser();
    const [event] = parser.push('retry: soon\ndata: x\n\n');
    expect(event?.retry).toBeUndefined();
  });

  it('treats a colon-less line as a field with an empty value', () => {
    const parser = new SseParser();
    // `data` alone means an empty data line, which still dispatches.
    const [event] = parser.push('data\n\n');
    expect(event?.data).toBe('');
  });

  it('ignores unknown fields', () => {
    const parser = new SseParser();
    const [event] = parser.push('bogus: whatever\ndata: kept\n\n');
    expect(event).toEqual({ data: 'kept' });
  });

  it('strips a leading BOM', () => {
    const parser = new SseParser();
    const [event] = parser.push('﻿data: first\n\n');
    expect(event?.data).toBe('first');
  });

  it('returns a truncated trailing event on flush', () => {
    const parser = new SseParser();
    expect(parser.push('data: {"partial":true}')).toEqual([]);
    expect(parser.flush()).toEqual([{ data: '{"partial":true}' }]);
  });

  it('flush is empty when the stream ended cleanly', () => {
    const parser = new SseParser();
    parser.push('data: done\n\n');
    expect(parser.flush()).toEqual([]);
  });

  it('resets all accumulated state', () => {
    const parser = new SseParser();
    parser.push('event: partial\ndata: half');
    parser.reset();
    expect(parser.flush()).toEqual([]);
    expect(parser.push('data: fresh\n\n')).toEqual([{ data: 'fresh' }]);
  });

  it('keeps parsing after a malformed event', () => {
    const parser = new SseParser();
    const events = parser.push('data: {not json\n\ndata: {"ok":true}\n\n');
    expect(events).toHaveLength(2);

    const first = parseEventData(events[0]!);
    expect(first.ok).toBe(false);

    const second = parseEventData<{ ok: boolean }>(events[1]!);
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.value.ok).toBe(true);
  });
});

describe('parseEventData', () => {
  it('parses valid JSON', () => {
    const result = parseEventData<{ n: number }>({ data: '{"n":7}' });
    expect(result).toEqual({ ok: true, value: { n: 7 } });
  });

  it('flags the OpenAI [DONE] sentinel as done rather than an error', () => {
    const result = parseEventData({ data: SSE_DONE });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.done).toBe(true);
  });

  it('reports empty data without marking the stream done', () => {
    const result = parseEventData({ data: '   ' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.done).toBe(false);
      expect(result.error).toBe('empty data');
    }
  });

  it('reports malformed JSON without throwing', () => {
    const result = parseEventData({ data: '{"unterminated":' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.done).toBe(false);
      expect(result.raw).toBe('{"unterminated":');
    }
  });

  it('does not treat a JSON payload containing [DONE] as the sentinel', () => {
    const result = parseEventData<{ text: string }>({ data: '{"text":"[DONE]"}' });
    expect(result.ok).toBe(true);
  });
});
