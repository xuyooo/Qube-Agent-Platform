import { readFile } from 'node:fs/promises'
import { PGlite } from '@electric-sql/pglite'
import { expect, it, vi } from 'vitest'
import { advanceReflectCheckpoint } from './memory'

const { query } = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock('./pool', () => ({ pool: { query }, generateId: vi.fn() }))

it('advances a bound checkpoint once and only while the workspace owns the sole writer', async () => {
  const pg = new PGlite()
  query.mockImplementation((sql, args) => pg.query(sql, args))
  try {
    await pg.exec(`
      CREATE TABLE schedules (id uuid PRIMARY KEY, origin text);
      CREATE TABLE workspaces (id text PRIMARY KEY, user_id text);
      CREATE TABLE sessions (id text PRIMARY KEY, workspace_id text);
      CREATE TABLE session_tokens (token text, workspace_id text, session_id text);
      CREATE TABLE memory_stores (
        id text PRIMARY KEY, origin_workspace_id text, owner_user_id text,
        created_at timestamptz, archived_at timestamptz
      );
      CREATE TABLE workspace_memory_attachments (store_id text, workspace_id text, access text);
    `)
    await pg.exec(
      await readFile(
        new URL('../../../migrations/159_memory_reflect.sql', import.meta.url),
        'utf8',
      ),
    )
    await pg.exec(`
      INSERT INTO workspaces VALUES ('w', 'owner'), ('other', 'owner');
      INSERT INTO sessions VALUES ('s','w');
      INSERT INTO memory_stores (id,origin_workspace_id,owner_user_id,created_at)
        VALUES ('m','w','owner','2026-11-01 00:00:00.000123+00');
      INSERT INTO workspace_memory_attachments VALUES ('m','w','read_write'), ('m','other','read_write');
      INSERT INTO session_tokens VALUES ('t','w','s','m','2026-11-01T00:00:00Z','2026-11-08T00:00:00Z');
    `)
    const checkpoint = async () =>
      (
        await pg.query<{ value: string | null }>(
          "SELECT to_char(last_reflected_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS value FROM memory_stores",
        )
      ).rows[0]?.value
    await advanceReflectCheckpoint('m', 'w', 's', 't')
    expect(await checkpoint()).toBeNull()
    await pg.exec("DELETE FROM workspace_memory_attachments WHERE workspace_id = 'other'")
    await advanceReflectCheckpoint('m', 'w', 'other-session', 't')
    expect(await checkpoint()).toBeNull()
    await advanceReflectCheckpoint('m', 'w', 's', 't')
    expect(await checkpoint()).toBe('2026-11-08')
    await pg.exec("UPDATE memory_stores SET last_reflected_at = '2026-11-09T00:00:00Z'")
    await advanceReflectCheckpoint('m', 'w', 's', 't')
    expect(await checkpoint()).toBe('2026-11-09')
  } finally {
    await pg.close()
  }
})
