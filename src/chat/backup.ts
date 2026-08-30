/**
 * Settings backup: everything except the conversations and the credentials.
 *
 * Pure, like `export.ts`, and for the same reason — the property that matters is
 * testable only if the artefact is a return value: **a backup contains no API key,
 * no bearer token and no OAuth token.** Those live in the Keystore and are not
 * readable from here at all, which is the structural half of the guarantee; the
 * `redactString` pass over the finished text is the net under it.
 *
 * What is in a backup is the configuration a user would otherwise re-enter by hand:
 * preferences, provider profiles minus their keys, per-model capability and price
 * edits, skills, prompt templates and MCP servers. What is deliberately not in it:
 *
 *  - Conversations and messages. A settings backup that silently carried every chat
 *    would be a very different file from the one the button offers.
 *  - Memories. They are distilled from private conversation and have their own
 *    screen with its own delete.
 *  - Anything from `expo-secure-store`. A restored profile has no key and says so.
 *
 * Restore **merges and never overwrites**: a name that already exists is skipped and
 * counted. Import is the one operation here a user cannot undo by tapping again, so
 * it does the timid thing.
 */

import { redactString } from '@/lib/redact';

/** Bump when the shape changes incompatibly. A new optional field is not that. */
export const BACKUP_SCHEMA_VERSION = 1;

export interface BackupProfile {
  name: string;
  kind: string;
  baseUrl: string;
  fallbackBaseUrl?: string;
  defaultModel: string;
  headers: Record<string, string>;
}

export interface BackupModel {
  /**
   * The *name* of the profile that discovered it, not the id.
   *
   * A model override is keyed by `profileId:modelId` in the store, and the profile
   * id is generated per device — carrying it would produce a file whose overrides
   * match nothing on restore. The name is what a user recognises and what restore
   * can resolve back to an id.
   */
  profile: string;
  id: string;
  capabilities: Record<string, unknown>;
  wireHints: Record<string, unknown>;
  pricing?: { inputPerMTok: number; outputPerMTok: number };
  hidden: boolean;
}

export interface BackupSkill {
  name: string;
  description: string;
  body: string;
}

export interface BackupPrompt {
  title: string;
  body: string;
}

export interface BackupServer {
  name: string;
  url: string;
  transport: string;
  authKind: string;
  headers: Record<string, string>;
}

export interface Backup {
  app: string;
  schema: number;
  exportedAt: string;
  settings: Record<string, unknown>;
  profiles: BackupProfile[];
  models: BackupModel[];
  skills: BackupSkill[];
  prompts: BackupPrompt[];
  servers: BackupServer[];
}

export interface BackupResult {
  filename: string;
  mimeType: 'application/json';
  text: string;
  bytes: number;
}

/**
 * Assemble the file.
 *
 * Every section is rebuilt field by field rather than spread from the live object:
 * a spread carries whatever gets added to a store later, and "whatever gets added
 * later" is how a fingerprint or a token ends up in a backup.
 */
export function buildBackup(
  input: {
    settings: Record<string, unknown>;
    profiles: readonly BackupProfile[];
    models: readonly BackupModel[];
    skills: readonly BackupSkill[];
    prompts: readonly BackupPrompt[];
    servers: readonly BackupServer[];
  },
  now = Date.now(),
): BackupResult {
  const backup: Backup = {
    app: 'AgentRouter Mobile',
    schema: BACKUP_SCHEMA_VERSION,
    exportedAt: new Date(now).toISOString(),
    settings: input.settings,
    profiles: input.profiles.map((profile) => ({
      name: profile.name,
      kind: profile.kind,
      baseUrl: profile.baseUrl,
      ...(profile.fallbackBaseUrl ? { fallbackBaseUrl: profile.fallbackBaseUrl } : {}),
      defaultModel: profile.defaultModel,
      headers: profile.headers,
    })),
    models: input.models.map((model) => ({
      profile: model.profile,
      id: model.id,
      capabilities: model.capabilities,
      wireHints: model.wireHints,
      ...(model.pricing ? { pricing: model.pricing } : {}),
      hidden: model.hidden,
    })),
    skills: input.skills.map((skill) => ({ name: skill.name, description: skill.description, body: skill.body })),
    prompts: input.prompts.map((prompt) => ({ title: prompt.title, body: prompt.body })),
    servers: input.servers.map((server) => ({
      name: server.name,
      url: server.url,
      transport: server.transport,
      authKind: server.authKind,
      headers: server.headers,
    })),
  };

  // The second pass, over the assembled text, for the reason `export.ts` documents:
  // a field added to a store later has to fail safely rather than compile.
  const text = redactString(JSON.stringify(backup, null, 2));
  const stamp = new Date(now).toISOString().slice(0, 10);
  return {
    filename: `agentrouter-settings-${stamp}.json`,
    mimeType: 'application/json',
    text,
    bytes: new TextEncoder().encode(text).length,
  };
}

/** What a restore found in the file, or why it refused it. */
export type ParsedBackup = { ok: true; backup: Backup } | { ok: false; reason: string };

/**
 * Read a file the user picked.
 *
 * Every section is filtered rather than trusted: a backup is a file from storage,
 * possibly hand-edited, and a malformed entry should cost that entry rather than the
 * whole restore.
 */
export function parseBackup(text: string): ParsedBackup {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { ok: false, reason: 'That file is not JSON.' };
  }
  if (typeof value !== 'object' || value === null) return { ok: false, reason: 'That file is not a backup.' };
  const record = value as Record<string, unknown>;
  if (typeof record.schema !== 'number') return { ok: false, reason: 'That file is not an AgentRouter backup.' };
  if (record.schema > BACKUP_SCHEMA_VERSION) {
    return { ok: false, reason: `That backup was written by a newer version (schema ${record.schema}).` };
  }

  return {
    ok: true,
    backup: {
      app: typeof record.app === 'string' ? record.app : 'AgentRouter Mobile',
      schema: record.schema,
      exportedAt: typeof record.exportedAt === 'string' ? record.exportedAt : '',
      settings: isRecord(record.settings) ? record.settings : {},
      profiles: list(record.profiles).filter(isProfile),
      models: list(record.models).filter(isModel),
      skills: list(record.skills).filter(isSkill),
      prompts: list(record.prompts).filter(isPrompt),
      servers: list(record.servers).filter(isServer),
    },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function list(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

function strings(value: unknown): Record<string, string> {
  if (!isRecord(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function isProfile(value: Record<string, unknown>): value is BackupProfile & Record<string, unknown> {
  return typeof value.name === 'string' && typeof value.baseUrl === 'string' && typeof value.kind === 'string';
}

function isModel(value: Record<string, unknown>): value is BackupModel & Record<string, unknown> {
  return typeof value.profile === 'string' && typeof value.id === 'string';
}

function isSkill(value: Record<string, unknown>): value is BackupSkill & Record<string, unknown> {
  return typeof value.name === 'string' && typeof value.body === 'string';
}

function isPrompt(value: Record<string, unknown>): value is BackupPrompt & Record<string, unknown> {
  return typeof value.title === 'string' && typeof value.body === 'string';
}

function isServer(value: Record<string, unknown>): value is BackupServer & Record<string, unknown> {
  return typeof value.name === 'string' && typeof value.url === 'string';
}

/** Normalises the loose header maps a hand-edited file might carry. */
export function headersOf(value: { headers?: unknown }): Record<string, string> {
  return strings(value.headers);
}
