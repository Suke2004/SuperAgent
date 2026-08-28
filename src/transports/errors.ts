/**
 * Gateway error parsing and classification.
 *
 * The gateway returns errors shaped like:
 *
 *   {"error":{"message":"…","type":"new_api_error"}}
 *
 * and, for auth failures, a variant with the type hoisted to the top level
 * (verified live against agentrouter.org):
 *
 *   {"error":{"message":"unauthorized client detected, contact support …"},
 *    "message":"UNAUTHENTICATED","success":false,"type":"unauthorized_client_error"}
 *
 * Both are handled. The gateway's own `message` is always preserved verbatim and
 * surfaced in the UI — a bare "Request failed" is never produced, because that
 * string is useless for debugging a proxy you don't control.
 */

export type GatewayErrorKind =
  /** 401 with `unauthorized_client_error`: the gateway rejected the *client*. */
  | 'client_rejected'
  /** 401 otherwise: the gateway rejected the *key*. */
  | 'key_rejected'
  /** 403. */
  | 'forbidden'
  /** 400 where the gateway blocked the content — typically an unsupported language. */
  | 'content_blocked'
  /** 400 naming a request parameter the upstream model or gateway won't accept. */
  | 'unsupported_param'
  /** 404 — often the two-base-URL mistake rather than a missing model. */
  | 'not_found'
  /** Out of credits / quota exhausted. */
  | 'insufficient_credits'
  /** 429. */
  | 'rate_limited'
  /** 5xx. */
  | 'server'
  /** Any other 4xx. */
  | 'bad_request'
  /**
   * This app refused to send the request. Distinct from `bad_request`, which is
   * the gateway refusing it: nothing left the device, so there is no gateway
   * message to show and no debug-log entry to point at. The UI's job here is to
   * put the user back on the control that needs changing.
   */
  | 'validation'
  /** Transport-level failure: DNS, TLS, connection reset, timeout. */
  | 'network'
  /** The user pressed stop, or a timeout aborted the request. */
  | 'aborted'
  /** The response body wasn't the shape we expected. */
  | 'parse'
  | 'unknown';

export interface GatewayErrorInit {
  kind: GatewayErrorKind;
  /** The gateway's own message, verbatim. Never synthesised. */
  message: string;
  status?: number;
  statusText?: string;
  /** `type` from the error payload, e.g. `new_api_error`, `unauthorized_client_error`. */
  gatewayType?: string;
  /** `code` from the error payload, when present. */
  code?: string;
  /** The offending parameter, for `unsupported_param`. */
  param?: string;
  /** Gateway request id, from the body or the `Request-Id` header. */
  requestId?: string;
  /** Parsed from `Retry-After`, or derived from backoff policy. */
  retryAfterMs?: number;
  /** Actionable guidance derived from the classification. */
  hint?: string;
  /** Raw body text, truncated. Redacted before it reaches the log. */
  raw?: string;
  /** The URL that produced this, for the two-base-URL diagnostic. */
  url?: string;
  cause?: unknown;
}

export class GatewayError extends Error {
  readonly kind: GatewayErrorKind;
  readonly status?: number;
  readonly statusText?: string;
  readonly gatewayType?: string;
  readonly code?: string;
  readonly param?: string;
  readonly requestId?: string;
  readonly retryAfterMs?: number;
  readonly hint?: string;
  readonly raw?: string;
  readonly url?: string;

  constructor(init: GatewayErrorInit) {
    super(init.message);
    this.name = 'GatewayError';
    this.kind = init.kind;
    this.status = init.status;
    this.statusText = init.statusText;
    this.gatewayType = init.gatewayType;
    this.code = init.code;
    this.param = init.param;
    this.requestId = init.requestId;
    this.retryAfterMs = init.retryAfterMs;
    this.hint = init.hint;
    this.raw = init.raw;
    this.url = init.url;
    if (init.cause !== undefined) {
      (this as { cause?: unknown }).cause = init.cause;
    }
  }

  /** True when a retry could plausibly succeed: 429 and 5xx only. */
  get retryable(): boolean {
    return isRetryableKind(this.kind);
  }

  /** One-line summary for a toast; the full message plus hint goes in the sheet. */
  get summary(): string {
    const label = KIND_LABELS[this.kind];
    return this.status ? `${label} (${this.status})` : label;
  }

  /**
   * Copy with extra guidance appended to `hint`.
   *
   * The gateway's own `message` is never touched — that is the text needed for
   * debugging. Retry counts and similar context go in the hint.
   */
  withHint(note: string): GatewayError {
    const init: GatewayErrorInit = {
      kind: this.kind,
      message: this.message,
      hint: this.hint ? `${this.hint} ${note}` : note,
    };
    if (this.status !== undefined) init.status = this.status;
    if (this.statusText !== undefined) init.statusText = this.statusText;
    if (this.gatewayType !== undefined) init.gatewayType = this.gatewayType;
    if (this.code !== undefined) init.code = this.code;
    if (this.param !== undefined) init.param = this.param;
    if (this.requestId !== undefined) init.requestId = this.requestId;
    if (this.retryAfterMs !== undefined) init.retryAfterMs = this.retryAfterMs;
    if (this.raw !== undefined) init.raw = this.raw;
    if (this.url !== undefined) init.url = this.url;
    if ((this as { cause?: unknown }).cause !== undefined) init.cause = (this as { cause?: unknown }).cause;
    return new GatewayError(init);
  }

  /** Coerce an unknown thrown value into a GatewayError. */
  static wrap(error: unknown, ctx?: { url?: string; transport?: string }): GatewayError {
    return classifyThrown(error, ctx);
  }

  toJSON(): Record<string, unknown> {
    return {
      name: this.name,
      kind: this.kind,
      message: this.message,
      status: this.status,
      gatewayType: this.gatewayType,
      code: this.code,
      param: this.param,
      requestId: this.requestId,
      hint: this.hint,
      url: this.url,
    };
  }
}

export const KIND_LABELS: Record<GatewayErrorKind, string> = {
  client_rejected: 'Client rejected by gateway',
  key_rejected: 'API key rejected',
  forbidden: 'Forbidden',
  content_blocked: 'Content blocked',
  unsupported_param: 'Unsupported parameter',
  not_found: 'Not found',
  insufficient_credits: 'Out of credits',
  rate_limited: 'Rate limited',
  server: 'Gateway error',
  bad_request: 'Bad request',
  validation: 'Invalid settings',
  network: 'Network unreachable',
  aborted: 'Stopped',
  parse: 'Unreadable response',
  unknown: 'Unknown error',
};

export function isRetryableKind(kind: GatewayErrorKind): boolean {
  return kind === 'rate_limited' || kind === 'server' || kind === 'network';
}

/* -------------------------------------------------------------------------- */
/* Payload parsing                                                             */
/* -------------------------------------------------------------------------- */

interface ParsedPayload {
  message?: string;
  type?: string;
  code?: string;
  param?: string;
}

function asString(value: unknown): string | undefined {
  if (typeof value === 'string' && value.trim()) return value.trim();
  if (typeof value === 'number') return String(value);
  return undefined;
}

/**
 * Pull message/type/code/param out of any of the shapes the gateway or an
 * upstream provider might return. Tolerant by design: a proxy in front of
 * several providers passes through several error dialects.
 */
export function parseErrorPayload(body: unknown): ParsedPayload {
  if (body === null || body === undefined) return {};

  if (typeof body === 'string') {
    const trimmed = body.trim();
    if (!trimmed) return {};
    if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
      try {
        return parseErrorPayload(JSON.parse(trimmed));
      } catch {
        return { message: trimmed };
      }
    }
    return { message: trimmed };
  }

  if (typeof body !== 'object') return { message: String(body) };

  const root = body as Record<string, unknown>;
  const errorField = root.error;

  // `error` may be an object, a string, or absent.
  let inner: Record<string, unknown> = {};
  let innerMessage: string | undefined;
  if (typeof errorField === 'string') {
    innerMessage = asString(errorField);
  } else if (errorField && typeof errorField === 'object') {
    inner = errorField as Record<string, unknown>;
    innerMessage = asString(inner.message);
  }

  // Anthropic nests the same way; some gateways use `detail` or `msg`.
  const message =
    innerMessage ??
    asString(root.message) ??
    asString(root.detail) ??
    asString(root.msg) ??
    asString(root.error_description);

  // The auth-failure shape puts `type` at the root; the documented shape nests
  // it under `error`. Prefer the more specific nested value.
  const type = asString(inner.type) ?? asString(root.type) ?? asString(root.error_type);

  const code = asString(inner.code) ?? asString(root.code);
  const param = asString(inner.param) ?? asString(root.param);

  const result: ParsedPayload = {};
  if (message !== undefined) result.message = message;
  if (type !== undefined) result.type = type;
  if (code !== undefined) result.code = code;
  if (param !== undefined) result.param = param;
  return result;
}

/* -------------------------------------------------------------------------- */
/* Detection helpers                                                           */
/* -------------------------------------------------------------------------- */

/**
 * The gateway only accepts prompts in Chinese, English, French, German or
 * Russian; anything else comes back as a 400 "content blocked". Matching on the
 * message means an unrelated 400 still reports its own text.
 */
const CONTENT_BLOCKED_RE =
  /content[\s_-]?blocked|blocked[\s_-]?content|unsupported[\s_-]?language|language[\s_-]?not[\s_-]?(?:supported|allowed)|违规|敏感/i;

const CREDIT_RE =
  /insufficient|quota|out of credit|no credit|balance|额度|余额|欠费|exceeded your current quota|billing/i;

const UNSUPPORTED_PARAM_RE =
  /unrecognized request argument(?:s)? supplied:\s*([A-Za-z0-9_.[\]]+)|unsupported[\s_-]?(?:parameter|param|field|argument)s?[:\s'"]*([A-Za-z0-9_.[\]]+)|unknown (?:parameter|field|argument)[:\s'"]*([A-Za-z0-9_.[\]]+)|(?:parameter|property|field)\s+'?"?([A-Za-z0-9_.[\]]+)'?"?\s+is (?:not supported|unsupported|invalid|unknown)|invalid[\s_-]?(?:parameter|argument)[:\s'"]*([A-Za-z0-9_.[\]]+)|does not support\s+'?"?([A-Za-z0-9_.[\]]+)'?"?/i;

const CLIENT_REJECTED_RE = /unauthorized[\s_-]?client|client[\s_-]?not[\s_-]?(?:allowed|authorized)|unapproved[\s_-]?client/i;

/** Does this 400 look like the gateway blocking the content? */
export function looksContentBlocked(message: string | undefined, type?: string): boolean {
  return CONTENT_BLOCKED_RE.test(`${message ?? ''} ${type ?? ''}`);
}

/** Does this look like an exhausted free-tier balance? */
export function looksInsufficientCredits(message: string | undefined, type?: string, code?: string): boolean {
  return CREDIT_RE.test(`${message ?? ''} ${type ?? ''} ${code ?? ''}`);
}

/**
 * Identify the parameter a 400 is complaining about.
 *
 * Prefers an explicit `param` field, then a named capture from the message, then
 * — as a last resort — the first parameter we actually sent whose name appears
 * in the message. That last step is what makes "retry once without it" reliable
 * across providers that phrase the complaint differently.
 */
export function extractOffendingParam(
  message: string | undefined,
  sentParams: readonly string[] = [],
  explicitParam?: string,
): string | undefined {
  if (explicitParam && explicitParam !== 'null') {
    const normalised = explicitParam.split('.').pop();
    if (normalised) return normalised;
  }
  if (!message) return undefined;

  const match = UNSUPPORTED_PARAM_RE.exec(message);
  if (match) {
    const captured = match.slice(1).find((group) => typeof group === 'string' && group.length > 0);
    if (captured) {
      const candidate = captured.replace(/^['"]|['"]$/g, '').split('.').pop();
      // Only trust the capture if it's a parameter we actually sent, otherwise
      // we'd "drop" something that isn't in the request and retry identically.
      if (candidate && (sentParams.length === 0 || sentParams.includes(candidate))) return candidate;
    }
  }

  // Fall back to scanning for any sent parameter mentioned by name.
  const lower = message.toLowerCase();
  for (const param of sentParams) {
    const re = new RegExp(`\\b${param.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i');
    if (re.test(lower)) return param;
  }
  return undefined;
}

function parseRetryAfter(headerValue: string | undefined | null): number | undefined {
  if (!headerValue) return undefined;
  const trimmed = headerValue.trim();
  const seconds = Number(trimmed);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.round(seconds * 1000);
  const date = Date.parse(trimmed);
  if (Number.isFinite(date)) {
    const delta = date - Date.now();
    return delta > 0 ? delta : 0;
  }
  return undefined;
}

/* -------------------------------------------------------------------------- */
/* Hints                                                                       */
/* -------------------------------------------------------------------------- */

const LANGUAGE_HINT =
  'The gateway only accepts requests in Chinese, English, French, German or Russian. ' +
  'Rewrite the prompt (and any attached document text) in one of those languages, or switch to a provider without that restriction.';

function buildHint(kind: GatewayErrorKind, ctx: { url?: string; param?: string; transport?: string }): string | undefined {
  switch (kind) {
    case 'client_rejected':
      return (
        'The gateway accepted the request shape but rejected this client — it enforces an allowlist of approved clients, ' +
        'so this is about identity, not your key. Verify the token is still active in the gateway console, then contact ' +
        'gateway support to get this app approved. This app sends an honest, static User-Agent and will not impersonate ' +
        'another client, because circumventing the allowlist is a bannable offence.'
      );
    case 'key_rejected':
      return (
        'The gateway rejected the credential itself. Open the gateway console, confirm the token exists, is enabled, and ' +
        'has quota, then re-paste it in Settings → Providers. If the console shows the key as healthy, this is more likely ' +
        'a client-allowlist rejection — check the error type below.'
      );
    case 'content_blocked':
      return LANGUAGE_HINT;
    case 'unsupported_param':
      return ctx.param
        ? `The gateway or upstream model rejected \`${ctx.param}\`. It has been retried once without that parameter. ` +
          `Clear it for this model, or untick its capability flag in Settings → Models so it is never sent again.`
        : 'The gateway rejected one of the optional sampling parameters. Try clearing them one at a time.';
    case 'not_found': {
      const doubled = ctx.url && /\/v1\/v1\//.test(ctx.url);
      if (doubled) {
        return (
          'The URL contains `/v1/v1/`, which means a `/v1` suffix was included in the base URL as well as the path. ' +
          'The Anthropic transport wants the bare origin (https://agentrouter.org) because it appends `/v1/messages` itself; ' +
          'only the OpenAI transport takes a base URL ending in `/v1`.'
        );
      }
      if (ctx.transport === 'anthropic') {
        return (
          'Check the base URL for this profile. The Anthropic transport posts to `<base>/v1/messages`, so the base URL must ' +
          'be the bare origin with no `/v1` suffix. A 404 here usually means the wrong one of the two base URLs.'
        );
      }
      return (
        'Either the model id does not exist on this gateway, or the base URL is wrong. The OpenAI transport posts to ' +
        '`<base>/chat/completions`, so its base URL must end in `/v1`. Re-run model discovery in Settings → Models.'
      );
    }
    case 'insufficient_credits':
      return 'The account is out of credits or quota. Check the balance in the gateway console; free-tier credits are finite.';
    case 'rate_limited':
      return 'Rate limited. The app backs off exponentially with jitter and retries automatically; if it keeps happening, slow down or reduce max_tokens.';
    case 'server':
      return 'The gateway or the upstream provider failed. Retried automatically with backoff. If it persists, try the backup domain from Settings → Providers.';
    case 'network':
      return 'Could not reach the gateway. Check connectivity, then try the backup domain (https://ps.air-outer.com) — it serves the same API.';
    case 'forbidden':
      return 'The gateway understood the request but refused it. This key may not be permitted to use this model.';
    case 'parse':
      return 'The response was not valid JSON or SSE. Open the debug log to see the raw bytes the gateway sent.';
    default:
      return undefined;
  }
}

/* -------------------------------------------------------------------------- */
/* Classification                                                              */
/* -------------------------------------------------------------------------- */

export interface ClassifyContext {
  status: number;
  statusText?: string;
  /** Parsed JSON body, or the raw text if it wasn't JSON. */
  body: unknown;
  /** Lower-cased response headers. */
  headers?: Record<string, string>;
  /** Names of optional parameters present in the request that just failed. */
  sentParams?: readonly string[];
  url?: string;
  transport?: string;
}

/**
 * Turn an HTTP error response into a {@link GatewayError}.
 *
 * The gateway's message always wins as `message`; classification only decides
 * which `kind` and `hint` to attach.
 */
export function classifyHttpError(ctx: ClassifyContext): GatewayError {
  const parsed = parseErrorPayload(ctx.body);
  const rawText = typeof ctx.body === 'string' ? ctx.body : JSON.stringify(ctx.body ?? null);
  const requestId =
    ctx.headers?.['request-id'] ?? ctx.headers?.['x-request-id'] ?? ctx.headers?.['x-oneapi-request-id'];
  const retryAfterMs = parseRetryAfter(ctx.headers?.['retry-after']);

  const message =
    parsed.message ??
    (ctx.statusText ? `${ctx.status} ${ctx.statusText}` : `HTTP ${ctx.status} with an empty body`);

  let kind: GatewayErrorKind;
  let param: string | undefined;

  if (ctx.status === 401) {
    // Verified live: no-key requests return `unauthorized_client_error`, which is
    // the client allowlist rather than the credential. Distinguishing these two
    // is the difference between "re-paste your key" and "get the app approved".
    kind = CLIENT_REJECTED_RE.test(`${parsed.type ?? ''} ${message}`) ? 'client_rejected' : 'key_rejected';
  } else if (ctx.status === 403) {
    kind = looksInsufficientCredits(message, parsed.type, parsed.code) ? 'insufficient_credits' : 'forbidden';
  } else if (ctx.status === 404) {
    kind = 'not_found';
  } else if (ctx.status === 429) {
    kind = looksInsufficientCredits(message, parsed.type, parsed.code) ? 'insufficient_credits' : 'rate_limited';
  } else if (ctx.status === 402) {
    kind = 'insufficient_credits';
  } else if (ctx.status >= 500) {
    kind = 'server';
  } else if (ctx.status >= 400) {
    if (looksContentBlocked(message, parsed.type)) {
      kind = 'content_blocked';
    } else if (looksInsufficientCredits(message, parsed.type, parsed.code)) {
      kind = 'insufficient_credits';
    } else {
      param = extractOffendingParam(message, ctx.sentParams ?? [], parsed.param);
      kind = param ? 'unsupported_param' : 'bad_request';
    }
  } else {
    kind = 'unknown';
  }

  const init: GatewayErrorInit = {
    kind,
    message,
    status: ctx.status,
    hint: buildHint(kind, { url: ctx.url, param, transport: ctx.transport }),
    raw: rawText?.slice(0, 4000),
  };
  if (ctx.statusText !== undefined) init.statusText = ctx.statusText;
  if (parsed.type !== undefined) init.gatewayType = parsed.type;
  if (parsed.code !== undefined) init.code = parsed.code;
  if (param !== undefined) init.param = param;
  if (requestId !== undefined) init.requestId = requestId;
  if (retryAfterMs !== undefined) init.retryAfterMs = retryAfterMs;
  if (ctx.url !== undefined) init.url = ctx.url;

  return new GatewayError(init);
}

/** Wrap a thrown transport-level failure (DNS, TLS, reset, abort). */
export function classifyThrown(error: unknown, ctx: { url?: string; transport?: string } = {}): GatewayError {
  if (error instanceof GatewayError) return error;

  const name = (error as { name?: string } | null)?.name;
  const rawMessage = error instanceof Error ? error.message : String(error);

  if (name === 'AbortError' || /abort/i.test(rawMessage)) {
    const aborted: GatewayErrorInit = { kind: 'aborted', message: 'Request stopped.', cause: error };
    if (ctx.url !== undefined) aborted.url = ctx.url;
    return new GatewayError(aborted);
  }

  const init: GatewayErrorInit = {
    kind: 'network',
    message: rawMessage || 'The network request failed before a response arrived.',
    hint: buildHint('network', ctx),
    cause: error,
  };
  if (ctx.url !== undefined) init.url = ctx.url;
  return new GatewayError(init);
}

/**
 * An error raised by our own validation, before anything hits the network.
 *
 * Deliberately not `bad_request`: that kind means the gateway said no, and the
 * param-drop retry path keys off it. A locally-refused request must not trigger a
 * retry-without-the-parameter, because the parameter is not the gateway's problem.
 */
export function validationError(message: string, hint?: string): GatewayError {
  const init: GatewayErrorInit = { kind: 'validation', message };
  if (hint !== undefined) init.hint = hint;
  return new GatewayError(init);
}
