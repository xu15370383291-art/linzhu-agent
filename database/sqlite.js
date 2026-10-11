import { mkdir } from 'node:fs/promises';
import path from 'node:path';

let capability;

export async function sqliteCapability() {
  if (!capability) capability = import('node:sqlite').then(() => ({ available: true })).catch(error => ({ available: false, code: 'SQLITE_UNAVAILABLE', error }));
  return capability;
}

export async function openSqlite(file) {
  const status = await sqliteCapability();
  if (!status.available) throw Object.assign(new Error('SQLite runtime is unavailable; this capability is disabled'), { code: status.code, cause: status.error });
  const sqlite = await import('node:sqlite');
  await mkdir(path.dirname(file), { recursive: true });
  const db = new sqlite.DatabaseSync(file);
  db.exec('PRAGMA busy_timeout = 2000; PRAGMA foreign_keys = ON;');
  return db;
}
