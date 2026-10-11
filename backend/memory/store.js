import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import { openSqlite, sqliteCapability } from '../../database/sqlite.js';
import { memoryRank, validateMemory } from '../contracts/memory.js';
import { noSecrets } from '../contracts/common.js';
import { cosineSimilarity, normalizeVector, vectorIdentity } from './semantic.js';

const secretPattern = /(api[_ -]?key|secret|password|passwd|token|cookie|authorization|bearer|private[_ -]?key|\.env)/i;
function projectId(root) { return createHash('sha256').update(path.resolve(root)).digest('hex').slice(0, 24); }
const normalize = content => content.trim().replace(/\s+/g, ' ').toLowerCase();
const provenanceTypes = new Set(['explicit_command', 'auto_suggestion', 'manual_edit', 'import', 'system']);
const versionActions = new Set(['created', 'reviewed', 'updated', 'superseded', 'deleted', 'restored']);
const bounded = (value, max) => typeof value === 'string' ? value.trim().slice(0, max) : null;
function normalizeProvenance(input, fallback = 'system') {
  const value = input && typeof input === 'object' ? input : {};
  const sourceType = value.sourceType ?? fallback;
  if (!provenanceTypes.has(sourceType)) throw Object.assign(new Error('Invalid memory provenance source type'), { code: 'MEMORY_PROVENANCE_INVALID' });
  const sourceText = bounded(value.sourceText, 1000);
  const reason = bounded(value.reason, 240);
  if (sourceText && !noSecrets({ sourceText })) throw Object.assign(new Error('Memory provenance contains secret-like content'), { code: 'MEMORY_PROVENANCE_SENSITIVE' });
  if (reason && !noSecrets({ reason })) throw Object.assign(new Error('Memory provenance contains secret-like content'), { code: 'MEMORY_PROVENANCE_SENSITIVE' });
  return { sourceType, sourceText, reason, sessionId: bounded(value.sessionId, 128), messageId: bounded(value.messageId, 128) };
}
function queryTerms(query) {
  const terms = new Set(query.toLowerCase().match(/[\p{L}\p{N}_-]+/gu) ?? []);
  for (const run of query.toLowerCase().match(/[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]{2,}/gu) ?? []) {
    for (let index = 0; index < run.length - 1; index++) terms.add(run.slice(index, index + 2));
  }
  return [...terms].filter(term => term.length > 1).slice(0, 32);
}

export class MemoryStore {
  constructor(root, { embedding = null, mode = 'keyword', maxSearchCandidates = 1000 } = {}) { this.root = path.resolve(root); this.file = path.join(this.root, '.agent-data', 'memory.sqlite'); this.dbPromise = null; this.projectId = projectId(this.root); this.embedding = embedding; this.mode = mode; this.maxSearchCandidates = Math.min(5000, Math.max(50, maxSearchCandidates)); this.embeddingError = null; }

  embeddingPrefix() { return `${this.embedding?.provider ?? 'custom'}:${this.embedding?.model ?? 'default'}:`; }
  async expectedEmbeddingIdentity(db = null) {
    if (!this.embedding) return null;
    db ??= await this.db();
    if (this.embedding.dimensions) return vectorIdentity({ provider: this.embedding.provider, model: this.embedding.model, dimensions: this.embedding.dimensions });
    const state = db.prepare("SELECT value FROM memory_embedding_meta WHERE key='current_identity'").get();
    if (state?.value?.startsWith(this.embeddingPrefix())) return state.value;
    const existing = db.prepare('SELECT identity FROM memory_embeddings WHERE identity LIKE ? LIMIT 1').get(`${this.embeddingPrefix()}%`);
    return existing?.identity ?? `${this.embeddingPrefix()}auto`;
  }
  configureEmbedding(embedding, mode = embedding ? 'hybrid' : 'keyword') { this.embedding = embedding; this.mode = mode; this.embeddingError = null; }

  async embed(text, sensitive = false) {
    if (!this.embedding || sensitive) return null;
    try {
      const raw = await this.embedding.embed(text);
      const vector = normalizeVector(raw);
      if (!vector) throw Object.assign(new Error('Embedding provider returned an invalid vector'), { code: 'EMBEDDING_VECTOR_INVALID' });
      if (this.embedding.dimensions && vector.length !== this.embedding.dimensions) throw Object.assign(new Error('Embedding vector dimension changed'), { code: 'EMBEDDING_VECTOR_INVALID' });
      this.embeddingError = null;
      return { vector, identity: vectorIdentity({ provider: this.embedding.provider ?? 'custom', model: this.embedding.model ?? 'default', dimensions: vector.length }) };
    } catch (error) {
      this.embeddingError = error.code ?? 'EMBEDDING_UNAVAILABLE';
      throw error;
    }
  }

  async storeEmbedding(db, memoryId, text, sensitive = false) {
    const result = await this.embed(text, sensitive).catch(() => null);
    if (!result) return false;
    db.prepare('INSERT INTO memory_embeddings (memory_id, identity, dimensions, vector, updated_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(memory_id) DO UPDATE SET identity=excluded.identity, dimensions=excluded.dimensions, vector=excluded.vector, updated_at=excluded.updated_at')
      .run(memoryId, result.identity, result.vector.length, JSON.stringify(result.vector), Date.now());
    db.prepare("INSERT INTO memory_embedding_meta (key, value) VALUES ('current_identity', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(result.identity);
    return true;
  }

  async db() {
    if (!this.dbPromise) this.dbPromise = openSqlite(this.file).then(db => {
      db.exec(`CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY, kind TEXT NOT NULL, scope TEXT NOT NULL, project_id TEXT,
        session_id TEXT, task_id TEXT, content TEXT NOT NULL, normalized TEXT NOT NULL,
        status TEXT NOT NULL, source TEXT NOT NULL DEFAULT 'user', confidence REAL NOT NULL DEFAULT 1,
        importance REAL NOT NULL DEFAULT 0.5, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL,
        accessed_at INTEGER, expires_at INTEGER, conflict_group TEXT, sensitive INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS memory_scope ON memories(status, scope, project_id, session_id, task_id);
      CREATE VIRTUAL TABLE IF NOT EXISTS memory_fts USING fts5(id UNINDEXED, content);
      CREATE TABLE IF NOT EXISTS memory_embeddings (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        identity TEXT NOT NULL, dimensions INTEGER NOT NULL, vector TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS memory_embedding_identity ON memory_embeddings(identity);
      CREATE TABLE IF NOT EXISTS memory_embedding_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
      db.exec(`CREATE TABLE IF NOT EXISTS memory_provenance (
        memory_id TEXT PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
        source_type TEXT NOT NULL, source_text TEXT, reason TEXT,
        source_session_id TEXT, source_message_id TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS memory_versions (
        version_id TEXT PRIMARY KEY, memory_id TEXT NOT NULL REFERENCES memories(id) ON DELETE CASCADE,
        version_no INTEGER NOT NULL, action TEXT NOT NULL, kind TEXT NOT NULL, scope TEXT NOT NULL,
        project_id TEXT, session_id TEXT, task_id TEXT, content TEXT NOT NULL, status TEXT NOT NULL,
        confidence REAL NOT NULL, importance REAL NOT NULL, sensitive INTEGER NOT NULL,
        conflict_group TEXT, metadata TEXT, created_at INTEGER NOT NULL,
        UNIQUE(memory_id, version_no)
      );
      CREATE INDEX IF NOT EXISTS memory_versions_memory ON memory_versions(memory_id, version_no DESC);`);
      const columns = new Set(db.prepare('PRAGMA table_info(memories)').all().map(row => row.name));
      const migrations = [
        ['session_id', 'TEXT'], ['task_id', 'TEXT'], ['normalized', "TEXT NOT NULL DEFAULT ''"], ['source', "TEXT NOT NULL DEFAULT 'user'"],
        ['confidence', 'REAL NOT NULL DEFAULT 1'], ['importance', 'REAL NOT NULL DEFAULT 0.5'], ['accessed_at', 'INTEGER'], ['conflict_group', 'TEXT'], ['sensitive', 'INTEGER NOT NULL DEFAULT 0'],
      ];
      for (const [name, type] of migrations) if (!columns.has(name)) db.exec(`ALTER TABLE memories ADD COLUMN ${name} ${type}`);
      db.prepare("UPDATE memories SET normalized = lower(content) WHERE normalized = ''").run();
      return db;
    }).catch(error => { this.dbPromise = null; throw error; });
    return this.dbPromise;
  }

  async close() { if (!this.dbPromise) return; const db = await this.dbPromise.catch(() => null); this.dbPromise = null; db?.close(); }

  async insert(input, { defaultStatus = 'active', projectRoot = this.root } = {}) {
    const candidate = validateMemory({ ...input, status: input.status ?? defaultStatus, ...(input.scope === 'project' ? { projectId: projectId(projectRoot) } : {}) });
    const db = await this.db();
    const now = Date.now();
    const duplicate = db.prepare(`SELECT * FROM memories WHERE status IN (?, ?) AND normalized = ? AND scope = ?
      AND COALESCE(project_id, '') = ? AND COALESCE(session_id, '') = ? AND COALESCE(task_id, '') = ? LIMIT 1`)
      .get('active', 'candidate', normalize(candidate.content), candidate.scope, candidate.projectId ?? '', candidate.sessionId ?? '', candidate.taskId ?? '');
    if (duplicate) return { ...this.row(duplicate), duplicateOf: duplicate.id };
    const sameKind = db.prepare(`SELECT id FROM memories WHERE status = ? AND kind = ? AND scope = ?
      AND COALESCE(project_id, '') = ? AND COALESCE(session_id, '') = ? AND COALESCE(task_id, '') = ? AND content <> ?`)
      .all('active', candidate.kind, candidate.scope, candidate.projectId ?? '', candidate.sessionId ?? '', candidate.taskId ?? '', candidate.content);
    const conflictGroup = sameKind.length ? `${candidate.kind}:${candidate.scope}` : null;
    const id = randomUUID();
    db.prepare('INSERT INTO memories (id,kind,scope,project_id,session_id,task_id,content,normalized,status,source,confidence,importance,created_at,updated_at,accessed_at,expires_at,conflict_group,sensitive) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(
      id, candidate.kind, candidate.scope, candidate.projectId ?? null, candidate.sessionId ?? null, candidate.taskId ?? null,
      candidate.content, normalize(candidate.content), candidate.status, candidate.source, candidate.confidence, candidate.importance, now, now, null, candidate.expiresAt ?? null, conflictGroup, candidate.sensitive ? 1 : 0);
    db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, candidate.content);
    const provenance = normalizeProvenance(input.provenance, candidate.source === 'agent-suggestion' ? 'auto_suggestion' : candidate.source === 'import' ? 'import' : 'explicit_command');
    this.saveProvenance(db, id, provenance, now);
    this.saveVersion(db, id, 'created', { ...candidate, id, createdAt: now, updatedAt: now, conflictGroup }, { provenance: provenance.sourceType });
    if (this.embedding && this.mode !== 'keyword' && candidate.status === 'active') await this.storeEmbedding(db, id, candidate.content, candidate.sensitive);
    return { id, kind: candidate.kind, scope: candidate.scope, projectId: candidate.projectId ?? null, sessionId: candidate.sessionId ?? null, taskId: candidate.taskId ?? null,
      content: candidate.content, status: candidate.status, source: candidate.source, confidence: candidate.confidence, importance: candidate.importance, sensitive: candidate.sensitive, createdAt: now, updatedAt: now, conflictGroup };
  }

  async create(input, options) { return this.insert(input, { ...options, defaultStatus: 'active' }); }
  async suggest(input, options) { return this.insert({ ...input, source: input.source ?? 'agent-suggestion', status: 'candidate' }, { ...options, defaultStatus: 'candidate' }); }

  saveProvenance(db, memoryId, provenance, now = Date.now()) {
    db.prepare(`INSERT INTO memory_provenance(memory_id, source_type, source_text, reason, source_session_id, source_message_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(memory_id) DO UPDATE SET source_type=excluded.source_type, source_text=excluded.source_text, reason=excluded.reason,
      source_session_id=excluded.source_session_id, source_message_id=excluded.source_message_id, created_at=excluded.created_at`)
      .run(memoryId, provenance.sourceType, provenance.sourceText, provenance.reason, provenance.sessionId, provenance.messageId, now);
  }

  saveVersion(db, memoryId, action, item, metadata = {}) {
    if (!versionActions.has(action)) throw new Error('Invalid memory version action');
    const version = db.prepare('SELECT COALESCE(MAX(version_no), 0) AS value FROM memory_versions WHERE memory_id = ?').get(memoryId).value + 1;
    db.prepare(`INSERT INTO memory_versions(version_id, memory_id, version_no, action, kind, scope, project_id, session_id, task_id, content, status, confidence, importance, sensitive, conflict_group, metadata, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), memoryId, version, action, item.kind, item.scope, item.projectId ?? null, item.sessionId ?? null, item.taskId ?? null,
        item.content, item.status, item.confidence, item.importance, item.sensitive ? 1 : 0, item.conflictGroup ?? null, JSON.stringify(metadata).slice(0, 2000), Date.now());
  }

  async details(item) {
    if (!item) return item;
    const db = await this.db();
    const provenance = db.prepare('SELECT source_type, source_text, reason, source_session_id, source_message_id, created_at FROM memory_provenance WHERE memory_id = ?').get(item.id);
    return { ...item, ...(provenance ? { provenance: { sourceType: provenance.source_type, sourceText: provenance.source_text, reason: provenance.reason, sessionId: provenance.source_session_id, messageId: provenance.source_message_id, createdAt: provenance.created_at } } : {}) };
  }

  async history(id) {
    const db = await this.db();
    return db.prepare('SELECT version_id, memory_id, version_no, action, kind, scope, project_id AS projectId, session_id AS sessionId, task_id AS taskId, content, status, confidence, importance, sensitive, conflict_group AS conflictGroup, metadata, created_at AS createdAt FROM memory_versions WHERE memory_id = ? ORDER BY version_no DESC').all(id).map(item => {
      let metadata = {};
      try { metadata = item.metadata ? JSON.parse(item.metadata) : {}; } catch { metadata = { invalid: true }; }
      return { ...item, sensitive: item.sensitive === 1, metadata };
    });
  }

  async update(id, content, { provenance } = {}) {
    const db = await this.db(); const current = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(id);
    if (!current) throw Object.assign(new Error('Active memory not found'), { code: 'MEMORY_NOT_FOUND' });
    const validated = validateMemory({ kind: current.kind, content, scope: current.scope, status: 'active', confidence: current.confidence, importance: current.importance, sensitive: current.sensitive === 1, ...(current.project_id ? { projectId: current.project_id } : {}), ...(current.session_id ? { sessionId: current.session_id } : {}), ...(current.task_id ? { taskId: current.task_id } : {}) });
    const now = Date.now();
    db.prepare('UPDATE memories SET content = ?, normalized = ?, updated_at = ?, conflict_group = NULL WHERE id = ?').run(validated.content, normalize(validated.content), now, id);
    db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id); db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, validated.content);
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
    const next = { ...this.row({ ...current, content: validated.content, updated_at: now, conflict_group: null }), updatedAt: now, conflictGroup: null };
    const normalizedProvenance = normalizeProvenance(provenance, 'manual_edit'); this.saveProvenance(db, id, normalizedProvenance, now); this.saveVersion(db, id, 'updated', next, { provenance: normalizedProvenance.sourceType });
    if (this.embedding && this.mode !== 'keyword') await this.storeEmbedding(db, id, validated.content, current.sensitive === 1);
    return this.get(id);
  }

  async candidates(options = {}) {
    const db = await this.db();
    const clauses = ["status = 'candidate'"];
    const args = [];
    clauses.push('(scope <> \'project\' OR project_id = ?)'); args.push(options.projectRoot ? projectId(options.projectRoot) : this.projectId);
    clauses.push('(scope <> \'session\' OR session_id = ?)'); args.push(options.sessionId ?? '');
    clauses.push('(scope <> \'task\' OR task_id = ?)'); args.push(options.taskId ?? '');
    const items = db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id = m.id WHERE ${clauses.map(clause => clause.replaceAll('scope', 'm.scope').replaceAll('project_id', 'm.project_id').replaceAll('session_id', 'm.session_id').replaceAll('task_id', 'm.task_id')).join(' AND ')} ORDER BY m.updated_at DESC LIMIT 200`).all(...args).map(row => this.row(row));
    const terms = typeof options.query === 'string' ? queryTerms(options.query) : [];
    return terms.length ? items.filter(item => terms.some(term => item.content.toLowerCase().includes(term))) : items;
  }

  async restore(id, versionNo) {
    if (!Number.isSafeInteger(versionNo) || versionNo < 1) throw Object.assign(new Error('Invalid memory version'), { code: 'MEMORY_VERSION_INVALID' });
    const db = await this.db();
    const version = db.prepare('SELECT * FROM memory_versions WHERE memory_id = ? AND version_no = ?').get(id, versionNo);
    if (!version) throw Object.assign(new Error('Memory version not found'), { code: 'MEMORY_VERSION_NOT_FOUND' });
    const validated = validateMemory({ kind: version.kind, scope: version.scope, content: version.content, status: 'active', confidence: version.confidence, importance: version.importance, sensitive: version.sensitive === 1,
      ...(version.project_id ? { projectId: version.project_id } : {}), ...(version.session_id ? { sessionId: version.session_id } : {}), ...(version.task_id ? { taskId: version.task_id } : {}) });
    const now = Date.now();
    db.prepare('UPDATE memories SET kind = ?, scope = ?, project_id = ?, session_id = ?, task_id = ?, content = ?, normalized = ?, status = ?, confidence = ?, importance = ?, sensitive = ?, updated_at = ?, conflict_group = ? WHERE id = ?')
      .run(validated.kind, validated.scope, validated.projectId ?? null, validated.sessionId ?? null, validated.taskId ?? null, validated.content, normalize(validated.content), 'active', validated.confidence, validated.importance, validated.sensitive ? 1 : 0, now, version.conflict_group ?? null, id);
    db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id); db.prepare('INSERT INTO memory_fts(id,content) VALUES(?,?)').run(id, validated.content);
    db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id);
    const restored = this.row({ ...version, id, updated_at: now, status: 'active', project_id: validated.projectId ?? null, session_id: validated.sessionId ?? null, task_id: validated.taskId ?? null, sensitive: validated.sensitive ? 1 : 0 });
    const provenance = normalizeProvenance({ sourceType: 'manual_edit', reason: `从版本 ${versionNo} 恢复` }, 'manual_edit');
    this.saveProvenance(db, id, provenance, now); this.saveVersion(db, id, 'restored', restored, { fromVersion: versionNo });
    if (this.embedding && this.mode !== 'keyword') await this.storeEmbedding(db, id, validated.content, validated.sensitive);
    return this.get(id, { includeInactive: true });
  }

  row(row) {
    return { id: row.id, kind: row.kind, scope: row.scope, projectId: row.project_id, sessionId: row.session_id, taskId: row.task_id,
      content: row.content, status: row.status, source: row.source, confidence: row.confidence, importance: row.importance, sensitive: row.sensitive === 1 || row.sensitive === true,
      createdAt: row.created_at, updatedAt: row.updated_at, accessedAt: row.accessed_at, expiresAt: row.expires_at, conflictGroup: row.conflict_group,
      ...(row.provenance_source_type ? { provenance: { sourceType: row.provenance_source_type, sourceText: row.provenance_source_text, reason: row.provenance_reason, sessionId: row.provenance_session_id, messageId: row.provenance_message_id, createdAt: row.provenance_created_at } } : {}) };
  }

  visibleWhere({ scope, sessionId, taskId, projectRoot } = {}) {
    const clauses = ['status = ?', '(expires_at IS NULL OR expires_at > ?)']; const args = ['active', Date.now()];
    if (scope) { clauses.push('scope = ?'); args.push(scope); }
    else { clauses.push('(scope = ? OR (scope = ? AND project_id = ?) OR (scope = ? AND session_id = ?) OR (scope = ? AND task_id = ?))'); args.push('global', 'project', projectRoot ? projectId(projectRoot) : this.projectId, 'session', sessionId ?? '', 'task', taskId ?? ''); }
    return { sql: clauses.join(' AND '), args };
  }

  async search(query, limit = 5, options = {}) {
    if (typeof query !== 'string' || !query.trim()) return [];
    const db = await this.db(); const bound = Math.min(20, Math.max(1, limit)); const where = this.visibleWhere(options); let rows = [];
    try {
      rows = db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at, bm25(memory_fts) AS match_score, 'full-text' AS match_method FROM memory_fts f JOIN memories m ON m.id=f.id LEFT JOIN memory_provenance p ON p.memory_id=m.id WHERE memory_fts MATCH ? AND ${where.sql} ORDER BY match_score LIMIT ?`).all(query.trim().replace(/["']/g, ' '), ...where.args, Math.min(this.maxSearchCandidates, bound * 8));
    } catch { /* bounded LIKE fallback below */ }
    const terms = queryTerms(query);
    if (!rows.length && terms.length) {
      const candidates = db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id=m.id WHERE ${where.sql} AND (${terms.map(() => 'm.content LIKE ?').join(' OR ')}) ORDER BY m.updated_at DESC LIMIT ?`).all(...where.args, ...terms.map(term => `%${term.replace(/[%_]/g, '')}%`), this.maxSearchCandidates);
      rows = candidates.map(row => ({ ...row, match_score: -terms.filter(term => row.content.toLowerCase().includes(term)).length, match_method: 'substring' }));
    }
    const now = Date.now(); const keyword = rows.map(row => {
      db.prepare('UPDATE memories SET accessed_at = ? WHERE id = ?').run(now, row.id);
      const item = this.row(row);
      const lexical = Number.isFinite(row.match_score) ? 1 / (1 + Math.max(0, row.match_score - Math.min(...rows.map(candidate => candidate.match_score ?? 0)))) : 0.5;
      const termCoverage = terms.length ? terms.filter(term => item.content.toLowerCase().includes(term)).length / terms.length : 0;
      return { item, score: lexical * 0.65 + termCoverage * 0.25 + memoryRank(item) * 0.1, match: { method: row.match_method ?? 'full-text', score: Math.round((lexical * 0.65 + termCoverage * 0.25) * 1000) / 1000 } };
    }).sort((a, b) => b.score - a.score);
    if (!this.embedding || this.mode === 'keyword') return keyword.slice(0, bound).map(result => ({ ...result.item, match: result.match }));
    try {
      const queryResult = await this.embed(query, false); if (!queryResult) return keyword.slice(0, bound).map(result => ({ ...result.item, match: result.match }));
      const { vector: queryVector, identity } = queryResult;
      const expectedIdentity = await this.expectedEmbeddingIdentity(db);
      if (expectedIdentity && expectedIdentity !== identity && identity.startsWith(this.embeddingPrefix()))
        db.prepare("INSERT INTO memory_embedding_meta (key, value) VALUES ('current_identity', ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(identity);
      const candidates = db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at, e.vector FROM memory_embeddings e JOIN memories m ON m.id=e.memory_id LEFT JOIN memory_provenance p ON p.memory_id=m.id WHERE ${where.sql} AND e.identity = ? ORDER BY m.updated_at DESC LIMIT ?`).all(...where.args, identity, this.maxSearchCandidates);
      const semantic = candidates.map(row => ({ item: this.row(row), score: cosineSimilarity(queryVector, JSON.parse(row.vector)) ?? 0 })).filter(item => item.score > 0).sort((a, b) => b.score - a.score).slice(0, bound);
      if (this.mode === 'semantic') return semantic.length ? semantic.map(result => ({ ...result.item, match: { method: 'semantic', similarity: result.score } })) : keyword.slice(0, bound).map(result => ({ ...result.item, match: result.match }));
      const merged = new Map(keyword.map(result => [result.item.id, { item: result.item, score: result.score, methods: ['keyword'], match: result.match }]));
      for (const result of semantic) { const existing = merged.get(result.item.id); merged.set(result.item.id, { item: result.item, score: (existing?.score ?? 0) + result.score * 0.35, methods: existing ? ['keyword', 'semantic'] : ['semantic'], match: { method: existing ? 'hybrid' : 'semantic', similarity: result.score } }); }
      return [...merged.values()].sort((a, b) => b.score - a.score).slice(0, bound).map(result => ({ ...result.item, match: result.match }));
    } catch { return keyword.slice(0, bound).map(result => ({ ...result.item, match: result.match })); }
  }

  async list(options = {}) {
    const db = await this.db();
    const where = this.visibleWhere(options);
    if (options.includeCandidates) {
      const clauses = where.sql.replace('status = ?', "status IN ('active', 'candidate')");
      return db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id = m.id WHERE ${clauses} ORDER BY CASE m.status WHEN 'candidate' THEN 0 ELSE 1 END, m.updated_at DESC`).all(...where.args.slice(1)).map(row => this.row(row));
    }
    return db.prepare(`SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id = m.id WHERE ${where.sql} ORDER BY m.updated_at DESC`).all(...where.args).map(row => this.row(row));
  }
  async get(id, { includeInactive = false } = {}) {
    const db = await this.db(); const row = db.prepare(includeInactive ? 'SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id = m.id WHERE m.id = ?' : 'SELECT m.*, p.source_type AS provenance_source_type, p.source_text AS provenance_source_text, p.reason AS provenance_reason, p.source_session_id AS provenance_session_id, p.source_message_id AS provenance_message_id, p.created_at AS provenance_created_at FROM memories m LEFT JOIN memory_provenance p ON p.memory_id = m.id WHERE m.id = ? AND m.status = ?').get(...(includeInactive ? [id] : [id, 'active'])); return row ? this.row(row) : null;
  }
  async review(id, decision) {
    const supersedesId = typeof decision === 'object' ? decision.supersedesId : null;
    const status = typeof decision === 'object' ? decision.status : decision;
    if (!['active', 'superseded', 'deleted'].includes(status)) throw new Error('Invalid memory review decision');
    const db = await this.db(); const now = Date.now();
    const candidate = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'candidate'").get(id);
    if (!candidate) throw Object.assign(new Error('Candidate memory not found'), { code: 'MEMORY_NOT_FOUND' });
    if (supersedesId) {
      const previous = db.prepare("SELECT * FROM memories WHERE id = ? AND status = 'active'").get(supersedesId);
      if (!previous || !candidate || previous.scope !== candidate.scope || (previous.project_id ?? null) !== (candidate.project_id ?? null) || (previous.session_id ?? null) !== (candidate.session_id ?? null) || (previous.task_id ?? null) !== (candidate.task_id ?? null))
        throw Object.assign(new Error('Replacement memory must have the same scope as an active memory'), { code: 'MEMORY_SCOPE_MISMATCH' });
      db.prepare("UPDATE memories SET status = 'superseded', updated_at = ? WHERE id = ? AND status = 'active'").run(now, supersedesId);
      this.saveVersion(db, supersedesId, 'superseded', this.row({ ...previous, updated_at: now, status: 'superseded' }), { supersededBy: id });
    }
    db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ? AND status = ?').run(status, now, id, 'candidate');
    this.saveVersion(db, id, 'reviewed', this.row({ ...candidate, updated_at: now, status }), { supersedesId: supersedesId ?? null });
    if (status !== 'active') { db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id); db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id); }
    else if (this.embedding && this.mode !== 'keyword') { const row = db.prepare('SELECT content, sensitive FROM memories WHERE id = ?').get(id); await this.storeEmbedding(db, id, row.content, row.sensitive === 1); }
    return this.get(id, { includeInactive: true });
  }
  async remove(id) { const db = await this.db(); const current = db.prepare('SELECT * FROM memories WHERE id = ?').get(id); if (!current) return; const now = Date.now(); db.prepare('UPDATE memories SET status = ?, updated_at = ? WHERE id = ?').run('deleted', now, id); this.saveVersion(db, id, 'deleted', this.row({ ...current, status: 'deleted', updated_at: now }), {}); db.prepare('DELETE FROM memory_fts WHERE id = ?').run(id); db.prepare('DELETE FROM memory_embeddings WHERE memory_id = ?').run(id); }
  async clear(scope = 'project', options = {}) { const db = await this.db(); const activeProjectId = options.projectRoot ? projectId(options.projectRoot) : this.projectId; const rows = scope === 'project' ? db.prepare('SELECT id FROM memories WHERE scope = ? AND project_id = ?').all('project', activeProjectId) : db.prepare('SELECT id FROM memories WHERE scope = ?').all('global'); for (const row of rows) await this.remove(row.id); }
  async reembed({ limit = 100 } = {}) {
    const bound = Math.min(100, Math.max(1, Number.isSafeInteger(limit) ? limit : 100)); const db = await this.db();
    if (!this.embedding || this.mode === 'keyword') return { processed: 0, remaining: 0, code: 'EMBEDDING_NOT_CONFIGURED' };
    const targetIdentity = await this.expectedEmbeddingIdentity(db);
    const rows = targetIdentity.endsWith(':auto')
      ? db.prepare(`SELECT m.id, m.content, m.sensitive FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity NOT LIKE ?) ORDER BY m.updated_at DESC LIMIT ?`).all(`${this.embeddingPrefix()}%`, bound)
      : db.prepare(`SELECT m.id, m.content, m.sensitive FROM memories m LEFT JOIN memory_embeddings e ON e.memory_id=m.id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity <> ?) ORDER BY m.updated_at DESC LIMIT ?`).all(targetIdentity, bound);
    let processed = 0; let failed = 0;
    for (const row of rows) { if (await this.storeEmbedding(db, row.id, row.content, row.sensitive === 1)) processed++; else failed++; }
    const activeIdentity = await this.expectedEmbeddingIdentity(db);
    const remaining = activeIdentity.endsWith(':auto')
      ? db.prepare(`SELECT count(*) AS count FROM memories m LEFT JOIN memory_embeddings e ON m.id=e.memory_id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity NOT LIKE ?)`).get(`${this.embeddingPrefix()}%`).count
      : db.prepare(`SELECT count(*) AS count FROM memories m LEFT JOIN memory_embeddings e ON m.id=e.memory_id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity <> ?)`).get(activeIdentity).count;
    return { processed, failed, remaining, identity: activeIdentity };
  }

  async status() {
    const capability = await sqliteCapability();
    if (!capability.available) return { available: false, code: capability.code, count: 0, projectId: this.projectId, mode: this.mode, embeddingConfigured: Boolean(this.embedding), embeddingError: this.embeddingError };
    const db = await this.db(); const count = (await this.list()).length; const embedded = db.prepare('SELECT count(*) AS count FROM memory_embeddings').get().count;
    const identity = await this.expectedEmbeddingIdentity(db);
    const stale = this.embedding ? (identity.endsWith(':auto')
      ? db.prepare(`SELECT count(*) AS count FROM memories m LEFT JOIN memory_embeddings e ON m.id=e.memory_id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity NOT LIKE ?)`).get(`${this.embeddingPrefix()}%`).count
      : db.prepare(`SELECT count(*) AS count FROM memories m LEFT JOIN memory_embeddings e ON m.id=e.memory_id WHERE m.status='active' AND m.sensitive=0 AND (e.memory_id IS NULL OR e.identity <> ?)`).get(identity).count) : 0;
    return { available: true, count, projectId: this.projectId, mode: this.mode, embeddingConfigured: Boolean(this.embedding), embeddingIdentity: identity, embedded, stale, embeddingError: this.embeddingError, externalEmbedding: false, sensitiveEmbedding: false };
  }

  async exportMarkdown({ scope } = {}) {
    const entries = await this.list({ scope });
    return ['# Personal Agent Memory', '', ...entries.map(item => `## ${item.kind} | ${item.scope} | ${item.id}${item.sensitive ? ' | sensitive' : ''}\n\n${item.content}\n`)].join('\n');
  }

  async importMarkdown(markdown, { scope = 'global' } = {}) {
    if (typeof markdown !== 'string' || markdown.length > 512 * 1024) throw new Error('Invalid memory Markdown');
    const blocks = markdown.split(/\n(?=## )/).slice(1); const imported = [];
    for (const block of blocks) {
      const match = block.match(/^##\s+([^|]+)\|\s*([^|]+)\|\s*([^\n]+)\n+\n([\s\S]*?)\s*$/);
      if (!match || secretPattern.test(match[4])) continue;
      const item = await this.insert({ kind: match[1].trim(), scope: match[2].trim() || scope, content: match[4].trim(), sensitive: match[3].includes('sensitive'), source: 'import' });
      if (!item.duplicateOf) imported.push(item);
    }
    return imported;
  }
}

export { projectId };
