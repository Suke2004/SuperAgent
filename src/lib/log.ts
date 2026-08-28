/**
 * In-memory debug log.
 *
 * Phase 6 asks for a "request-level debug log I can open and copy from, with the
 * API key redacted". Everything written here passes through `redact()` at the
 * boundary, so the buffer itself never holds a secret — that way copying,
 * exporting, or screenshotting the log is safe by construction rather than by
 * remembering to scrub at the point of display.
 *
 * The buffer is in-memory only and never persisted. A ring buffer keeps memory
 * bounded during long streaming sessions.
 */

import { newId } from './id';
import { redact, redactString } from './redact';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export interface MessageEntry {
  kind: 'message';
  id: string;
  at: number;
  level: LogLevel;
  scope: string;
  message: string;
  data?: unknown;
}

export interface RequestEntry {
  kind: 'request';
  id: string;
  at: number;
  transport: string;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: unknown;
  /** Filled in when the response arrives. */
  status?: number;
  statusText?: string;
  durationMs?: number;
  responseHeaders?: Record<string, string>;
  responseBody?: unknown;
  /** Number of SSE events observed, for streaming requests. */
  streamEvents?: number;
  /** First bytes of the raw stream, useful when the parser misbehaves. */
  streamSample?: string;
  error?: string;
  gatewayRequestId?: string;
  retryOf?: string;
  droppedParam?: string;
}

export type DebugEntry = MessageEntry | RequestEntry;

type Listener = (entries: DebugEntry[]) => void;

const DEFAULT_CAPACITY = 300;
const MAX_BODY_CHARS = 20_000;
const MAX_STREAM_SAMPLE = 2_000;

let capacity = DEFAULT_CAPACITY;
let entries: DebugEntry[] = [];
let listeners: Listener[] = [];
let enabled = true;
/** Mirror to the JS console as well. Off by default to keep Metro output clean. */
let mirrorToConsole = false;

function notify(): void {
  const snapshot = entries;
  for (const listener of listeners) listener(snapshot);
}

function push(entry: DebugEntry): void {
  entries = entries.length >= capacity ? [...entries.slice(entries.length - capacity + 1), entry] : [...entries, entry];
  notify();
}

function replace(id: string, update: (entry: RequestEntry) => RequestEntry): void {
  let changed = false;
  entries = entries.map((entry) => {
    if (entry.kind !== 'request' || entry.id !== id) return entry;
    changed = true;
    return update(entry);
  });
  if (changed) notify();
}

function truncate(value: unknown): unknown {
  if (typeof value === 'string' && value.length > MAX_BODY_CHARS) {
    return `${value.slice(0, MAX_BODY_CHARS)}…[truncated ${value.length - MAX_BODY_CHARS} chars]`;
  }
  if (value && typeof value === 'object') {
    const serialised = safeStringify(value);
    if (serialised.length > MAX_BODY_CHARS) {
      return `${serialised.slice(0, MAX_BODY_CHARS)}…[truncated ${serialised.length - MAX_BODY_CHARS} chars]`;
    }
  }
  return value;
}

export function safeStringify(value: unknown, space = 0): string {
  try {
    return JSON.stringify(value, null, space) ?? String(value);
  } catch {
    return '[unserialisable]';
  }
}

export const debugLog = {
  subscribe(listener: Listener): () => void {
    listeners = [...listeners, listener];
    listener(entries);
    return () => {
      listeners = listeners.filter((l) => l !== listener);
    };
  },

  getEntries(): DebugEntry[] {
    return entries;
  },

  clear(): void {
    entries = [];
    notify();
  },

  setEnabled(next: boolean): void {
    enabled = next;
  },

  isEnabled(): boolean {
    return enabled;
  },

  setCapacity(next: number): void {
    capacity = Math.max(20, Math.min(2000, Math.floor(next)));
    if (entries.length > capacity) {
      entries = entries.slice(entries.length - capacity);
      notify();
    }
  },

  setMirrorToConsole(next: boolean): void {
    mirrorToConsole = next;
  },

  message(level: LogLevel, scope: string, message: string, data?: unknown): void {
    if (!enabled) return;
    const entry: MessageEntry = {
      kind: 'message',
      id: newId('log_'),
      at: Date.now(),
      level,
      scope,
      message: redactString(message),
      data: data === undefined ? undefined : redact(truncate(data)),
    };
    push(entry);
    if (mirrorToConsole) {
      const method = level === 'debug' ? 'log' : level;
      (console[method] as (...args: unknown[]) => void)(`[${scope}] ${entry.message}`, entry.data ?? '');
    }
  },

  /**
   * Open a request entry. Returns a handle whose methods fill in the response
   * side. Always call exactly one of `finish` / `fail`.
   */
  request(init: {
    transport: string;
    method: string;
    url: string;
    headers: Record<string, string>;
    body?: unknown;
    retryOf?: string;
    droppedParam?: string;
  }): RequestHandle {
    const id = newId('req_');
    if (enabled) {
      push({
        kind: 'request',
        id,
        at: Date.now(),
        transport: init.transport,
        method: init.method,
        url: redactString(init.url),
        headers: redact(init.headers),
        body: init.body === undefined ? undefined : redact(truncate(init.body)),
        retryOf: init.retryOf,
        droppedParam: init.droppedParam,
      });
    }
    const startedAt = Date.now();
    let streamEvents = 0;
    let streamSample = '';

    return {
      id,
      gotResponse(status, statusText, responseHeaders) {
        if (!enabled) return;
        replace(id, (entry) => ({
          ...entry,
          status,
          statusText,
          responseHeaders: responseHeaders ? redact(responseHeaders) : undefined,
          gatewayRequestId:
            responseHeaders?.['request-id'] ??
            responseHeaders?.['x-request-id'] ??
            responseHeaders?.['x-oneapi-request-id'],
        }));
      },
      streamChunk(raw) {
        if (!enabled) return;
        streamEvents += 1;
        if (streamSample.length < MAX_STREAM_SAMPLE) {
          streamSample += raw.slice(0, MAX_STREAM_SAMPLE - streamSample.length);
        }
      },
      finish(responseBody) {
        if (!enabled) return;
        replace(id, (entry) => ({
          ...entry,
          durationMs: Date.now() - startedAt,
          responseBody: responseBody === undefined ? entry.responseBody : redact(truncate(responseBody)),
          streamEvents: streamEvents || entry.streamEvents,
          streamSample: streamSample ? redactString(streamSample) : entry.streamSample,
        }));
      },
      fail(error) {
        if (!enabled) return;
        replace(id, (entry) => ({
          ...entry,
          durationMs: Date.now() - startedAt,
          error: redactString(error instanceof Error ? error.message : String(error)),
          streamEvents: streamEvents || entry.streamEvents,
          streamSample: streamSample ? redactString(streamSample) : entry.streamSample,
        }));
      },
    };
  },

  /** Human-readable dump for the "copy log" button. Already redacted. */
  toText(): string {
    return entries
      .map((entry) => {
        const time = new Date(entry.at).toISOString();
        if (entry.kind === 'message') {
          const data = entry.data === undefined ? '' : `\n    ${safeStringify(entry.data, 2).replace(/\n/g, '\n    ')}`;
          return `[${time}] ${entry.level.toUpperCase()} ${entry.scope}: ${entry.message}${data}`;
        }
        const lines = [
          `[${time}] ${entry.method} ${entry.url}  (${entry.transport})`,
          `    status: ${entry.status ?? '—'} ${entry.statusText ?? ''}`.trimEnd(),
          `    duration: ${entry.durationMs ?? '—'}ms`,
        ];
        if (entry.gatewayRequestId) lines.push(`    gateway request id: ${entry.gatewayRequestId}`);
        if (entry.retryOf) lines.push(`    retry of: ${entry.retryOf}`);
        if (entry.droppedParam) lines.push(`    dropped param: ${entry.droppedParam}`);
        if (entry.streamEvents !== undefined) lines.push(`    stream events: ${entry.streamEvents}`);
        lines.push(`    headers: ${safeStringify(entry.headers)}`);
        if (entry.body !== undefined) {
          lines.push(`    request body: ${safeStringify(entry.body, 2).replace(/\n/g, '\n    ')}`);
        }
        if (entry.responseBody !== undefined) {
          lines.push(`    response body: ${safeStringify(entry.responseBody, 2).replace(/\n/g, '\n    ')}`);
        }
        if (entry.streamSample) lines.push(`    stream sample: ${entry.streamSample}`);
        if (entry.error) lines.push(`    error: ${entry.error}`);
        return lines.join('\n');
      })
      .join('\n\n');
  },
};

export interface RequestHandle {
  id: string;
  gotResponse(status: number, statusText: string, responseHeaders?: Record<string, string>): void;
  streamChunk(raw: string): void;
  finish(responseBody?: unknown): void;
  fail(error: unknown): void;
}

/** Convenience wrappers. */
export const log = {
  debug: (scope: string, message: string, data?: unknown) => debugLog.message('debug', scope, message, data),
  info: (scope: string, message: string, data?: unknown) => debugLog.message('info', scope, message, data),
  warn: (scope: string, message: string, data?: unknown) => debugLog.message('warn', scope, message, data),
  error: (scope: string, message: string, data?: unknown) => debugLog.message('error', scope, message, data),
};
