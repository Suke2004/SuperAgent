/**
 * What may be written to `messages.usage` and `usage_events`.
 *
 * One rule, and it is a correctness rule rather than a style one: **only numbers
 * the gateway reported.** Everything else in this app that talks about tokens is
 * an estimate from a character ratio, and an estimate stored next to a reply is
 * indistinguishable from a measurement a week later — including in the cost
 * column, where a number is a claim about money.
 *
 * This used to default `input` and `output` to 0, which made "this gateway does
 * not report prompt usage" read as "this turn was free". Absent stays absent.
 */

import type { TokenUsage } from '@/transports/types';

/**
 * Copies across only the fields that were actually reported.
 *
 * Deliberately field-by-field rather than a spread: a spread would carry anything
 * a caller happened to put on the object, which is exactly how an estimate would
 * get in.
 */
export function reportedUsage(partial: Partial<TokenUsage>): Partial<TokenUsage> {
  const usage: Partial<TokenUsage> = {};
  if (partial.input !== undefined) usage.input = partial.input;
  if (partial.output !== undefined) usage.output = partial.output;
  if (partial.thinking !== undefined) usage.thinking = partial.thinking;
  if (partial.cacheRead !== undefined) usage.cacheRead = partial.cacheRead;
  if (partial.cacheWrite !== undefined) usage.cacheWrite = partial.cacheWrite;
  return usage;
}

/** True when the gateway reported nothing at all, so there is no measurement to store. */
export function isUnreported(usage: Partial<TokenUsage>): boolean {
  return Object.keys(reportedUsage(usage)).length === 0;
}
