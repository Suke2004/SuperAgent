/**
 * Migration 5, against real SQLite.
 *
 * The migration is the part worth testing rather than the CRUD: a user upgrading
 * into this build runs step 5 against a database that already holds their
 * conversations, skills and memories, and two things in the step are load-bearing —
 * the unique index on `mcp_servers.name` (because `ConversationConfig.servers`
 * stores names) and the absence of any token column (because this table is what a
 * settings backup reads).
 */

import { DatabaseSync } from 'node:sqlite';

import { MIGRATIONS, SCHEMA_VERSION } from '@/db/ddl';

/** The version whose step creates the MCP and prompt tables. */
const MCP_VERSION = 5;

function migrated(upTo: number = MIGRATIONS.length): DatabaseSync {
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  for (const migration of MIGRATIONS.slice(0, upTo)) db.exec(migration);
  return db;
}

function insertServer(db: DatabaseSync, id: string, name: string): void {
  db.prepare(
    'INSERT INTO mcp_servers (id, created_at, updated_at, name, url) VALUES (?, 1, 1, ?, ?)',
  ).run(id, name, 'https://example.com/mcp');
}

describe('the MCP migration', () => {
  it('is a step in the chain, and the chain matches the recorded version', () => {
    expect(MIGRATIONS).toHaveLength(SCHEMA_VERSION);
    expect(SCHEMA_VERSION).toBeGreaterThanOrEqual(MCP_VERSION);
  });

  it('adds the tables to a database that already holds conversations and skills', () => {
    const db = migrated(MCP_VERSION - 1);
    db.exec(
      `INSERT INTO conversations (id, title, created_at, updated_at, profile_id, model)
       VALUES ('c1', 'Existing work', 100, 100, 'p1', 'claude-opus-5')`,
    );
    db.exec(
      `INSERT INTO skills (id, created_at, updated_at, name, description, body)
       VALUES ('skl_1', 1, 1, 'review', 'Reviews.', 'Steps.')`,
    );
    expect(() => db.exec(MIGRATIONS[MCP_VERSION - 1] as string)).not.toThrow();

    insertServer(db, 'mcp_1', 'github');
    db.prepare('INSERT INTO prompts (id, created_at, updated_at, title, body) VALUES (?, 1, 1, ?, ?)').run(
      'prm_1',
      'Review',
      'Review {{diff}}',
    );
    expect(db.prepare('SELECT COUNT(*) AS n FROM conversations').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM skills').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM mcp_servers').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM prompts').get()).toEqual({ n: 1 });
    db.close();
  });

  it('is idempotent, so a half-applied upgrade can be retried', () => {
    const db = migrated();
    expect(() => db.exec(MIGRATIONS[MCP_VERSION - 1] as string)).not.toThrow();
    db.close();
  });

  it('refuses a second server under the same name', () => {
    const db = migrated();
    insertServer(db, 'mcp_1', 'github');
    expect(() => insertServer(db, 'mcp_2', 'github')).toThrow();
    db.close();
  });

  it('has nowhere to put a token, which is the point', () => {
    // A column here would be a credential in a file the backup feature reads.
    const db = migrated();
    const columns = (db.prepare('PRAGMA table_info(mcp_servers)').all() as unknown as { name: string }[]).map(
      (row) => row.name,
    );
    expect(columns).not.toContain('token');
    expect(columns).not.toContain('access_token');
    expect(columns).toContain('auth_kind');
    db.close();
  });

  it('defaults a new server to no tools, nothing enabled and no standing approvals', () => {
    const db = migrated();
    insertServer(db, 'mcp_1', 'github');
    expect(db.prepare('SELECT transport, tools, enabled, approvals FROM mcp_servers').get()).toEqual({
      transport: 'http',
      tools: '[]',
      enabled: '[]',
      approvals: '{}',
    });
    db.close();
  });
});
