import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { parseDocument as parseYamlDocument, stringify as stringifyYaml } from 'yaml';

const SCHEMA_VERSION = 1;
const MAX_ITEMS = 200;
const MAX_BODY = 128 * 1024;
const safeId = value => typeof value === 'string' && /^[a-z0-9][a-z0-9._-]{0,63}$/.test(value);
const text = (value, max, field, required = false) => {
  if (typeof value !== 'string' || value.length > max || (required && !value.trim())) throw Object.assign(new Error(`无效的${field}`), { status: 400 });
  return value.trim();
};
const now = () => new Date().toISOString();

export const demoCatalog = [
  { id: 'demo-calendar', type: 'plugin', name: '日程整理', description: '将日程信息整理为清晰的时间安排', icon: '日', category: '效率', source: 'public', version: '1.0.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-notes', type: 'plugin', name: '会议记录', description: '管理会议纪要与行动项', icon: '记', category: '效率', source: 'public', version: '1.2.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-research', type: 'plugin', name: '资料归档', description: '按主题归纳和整理参考资料', icon: '档', category: '研究', source: 'public', version: '0.9.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-sheets', type: 'plugin', name: '表格助手', description: '协助检查表格结构与字段含义', icon: '表', category: '数据', source: 'public', version: '1.0.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-writing', type: 'skill', name: '清晰写作', description: '把复杂信息整理成结构清楚的文本', icon: '文', category: '写作', source: 'public', version: '1.0.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-review', type: 'skill', name: '代码审阅清单', description: '按风险、正确性和测试覆盖检查变更', icon: '审', category: '开发', source: 'public', version: '1.1.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-summary', type: 'skill', name: '会议摘要', description: '提炼讨论结论、待办事项与负责人', icon: '摘', category: '效率', source: 'public', version: '1.0.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
  { id: 'demo-research-skill', type: 'skill', name: '研究资料梳理', description: '整理问题、证据来源和待验证假设', icon: '研', category: '研究', source: 'public', version: '0.8.0', createdAt: '2026-09-01T00:00:00.000Z', updatedAt: '2026-09-01T00:00:00.000Z', demo: true },
];

function emptyState() { return { schemaVersion: SCHEMA_VERSION, catalog: [], installations: {}, personalItems: [], contents: {}, preferences: { sort: 'name' }, updatedAt: now() }; }
function validateState(value) {
  if (!value || value.schemaVersion !== SCHEMA_VERSION || !Array.isArray(value.catalog) || !value.installations || typeof value.installations !== 'object' || !Array.isArray(value.personalItems) || !value.contents || typeof value.contents !== 'object' || !value.preferences || typeof value.preferences !== 'object') throw new Error('扩展管理数据格式无效或版本不兼容');
  if (value.catalog.length > MAX_ITEMS || value.personalItems.length > MAX_ITEMS) throw new Error('扩展管理条目过多');
  return value;
}

export class ExtensionsStore {
  constructor(root, { skills } = {}) { this.root = path.resolve(root); this.file = path.join(this.root, '.agent-data', 'extensions-manager.json'); this.state = null; this.queue = Promise.resolve(); this.skills = skills; }
  async load() {
    if (this.state) return this.state;
    try { this.state = validateState(JSON.parse(await readFile(this.file, 'utf8'))); }
    catch (error) { if (error.code !== 'ENOENT') throw error; this.state = emptyState(); }
    return this.state;
  }
  async save() {
    const state = await this.load(); state.updatedAt = now();
    await mkdir(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
    await rename(temp, this.file);
  }
  async mutate(callback) {
    const operation = this.queue.then(async () => { await this.load(); const result = await callback(this.state); await this.save(); return result; });
    this.queue = operation.catch(() => {});
    return operation;
  }
  async list(type) {
    const state = await this.load();
    const publicItems = demoCatalog.filter(item => item.type === type);
    if (type === 'skill' && this.skills) {
      const runtimeItems = await this.skills.list({ includeInvalid: true });
      const managed = runtimeItems.filter(item => item.source && path.resolve(item.source) === path.resolve(this.skills.projectManagedRoot));
      const personalItems = managed.map(item => ({ id: item.id, type: 'skill', name: item.name, description: item.description, icon: '技', category: item.category, source: 'personal', version: item.version, createdAt: item.createdAt ?? item.updatedAt ?? now(), updatedAt: item.updatedAt ?? now(), installed: item.installed === true, enabled: item.enabled === true, valid: !item.invalid, validationError: item.error ?? null, state: item.state }));
      return { items: [...publicItems.map(item => ({ ...item, installed: false, enabled: false, executable: false })), ...personalItems], installations: {}, personalItems, preferences: state.preferences };
    }
    const personalItems = state.personalItems.filter(item => item.type === type);
    const installations = state.installations;
    return { items: [...publicItems, ...personalItems].map(item => ({ ...item, installed: Boolean(installations[item.id]), enabled: installations[item.id]?.enabled ?? false })), installations, personalItems, preferences: state.preferences };
  }
  async get(id) {
    const state = await this.load();
    if (this.skills) {
      const runtimeItem = (await this.skills.list({ includeInvalid: true })).find(entry => entry.id === id && entry.source && path.resolve(entry.source) === path.resolve(this.skills.projectManagedRoot));
      if (runtimeItem) {
        const item = runtimeItem.invalid ? runtimeItem : await this.skills.inspect(id);
        return { id: item.id, type: 'skill', name: item.frontmatter?.title ?? item.name, description: item.description, icon: '技', category: item.category, source: 'personal', version: item.version, createdAt: item.createdAt ?? now(), updatedAt: item.updatedAt ?? now(), installed: item.installed === true, enabled: item.enabled === true, valid: !item.invalid, validationError: item.error ?? null, content: item.content, body: item.body, frontmatter: item.frontmatter };
      }
    }
    const item = [...demoCatalog, ...state.personalItems].find(entry => entry.id === id);
    if (!item) throw Object.assign(new Error('未找到该条目'), { status: 404 });
    return { ...item, installed: Boolean(state.installations[id]), enabled: state.installations[id]?.enabled ?? false, content: state.contents[id] ?? '' };
  }
  async install(id) {
    if (this.skills && (await this.skills.list()).some(item => item.id === id)) {
      const item = await this.skills.setInstalled(id, true);
      return { id, installed: true, enabled: item.enabled };
    }
    return this.mutate(state => {
      const item = [...demoCatalog, ...state.personalItems].find(entry => entry.id === id);
      if (!item) throw Object.assign(new Error('未找到该条目'), { status: 404 });
      if (state.installations[id]) throw Object.assign(new Error('该条目已安装'), { status: 409 });
      state.installations[id] = { itemId: id, installedVersion: item.version, installedAt: now(), enabled: true, configuration: {} };
      return { ...item, installed: true, enabled: true };
    });
  }
  async uninstall(id) { if (this.skills && (await this.skills.list()).some(item => item.id === id)) { const item = await this.skills.setInstalled(id, false); return { id, installed: false, enabled: item.enabled }; } return this.mutate(state => { if (!state.installations[id]) throw Object.assign(new Error('该条目尚未安装'), { status: 404 }); delete state.installations[id]; return { id, installed: false }; }); }
  async setEnabled(id, enabled) { if (this.skills && (await this.skills.list()).some(item => item.id === id)) { const item = enabled ? await this.skills.setEnabled(id, true) : await this.skills.setEnabled(id, false); return { id, enabled: item.enabled }; } return this.mutate(state => { const record = state.installations[id]; if (!record) throw Object.assign(new Error('该条目尚未安装'), { status: 404 }); record.enabled = enabled; return { id, enabled }; }); }
  async saveItem(input) {
    if (input.type === 'skill' && this.skills) {
      try {
        const id = input.skillId ?? input.id ?? input.name;
        if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw Object.assign(new Error('技能标识只能使用小写英文、数字和连字符'), { status: 400 });
        const prior = input.id ? await this.skills.inspect(input.id).catch(() => null) : null;
        if (input.id && !prior) throw Object.assign(new Error('个人技能不存在'), { status: 404 });
        if (input.skillId && input.id && input.skillId !== input.id) throw Object.assign(new Error('已保存技能不能直接修改稳定标识，请复制为新技能'), { status: 400 });
        const saved = await this.skills.saveFields({ id, name: input.name, description: input.description, body: input.content ?? prior?.body ?? '', category: input.category, icon: input.icon, version: input.version });
        if (!saved.installed) await this.skills.setInstalled(id, true);
        return this.get(id);
      } catch (error) { if (!error.status) error.status = 400; throw error; }
    }
    return this.mutate(state => {
      const editing = input.id ? state.personalItems.find(item => item.id === input.id) : null;
      if (input.id && !editing) throw Object.assign(new Error('个人条目不存在'), { status: 404 });
      const type = input.type ?? editing?.type;
      if (!['plugin', 'skill'].includes(type)) throw Object.assign(new Error('条目类型无效'), { status: 400 });
      const id = editing?.id ?? input.id ?? `personal-${randomUUID().slice(0, 12)}`;
      if (!safeId(id) || (!editing && ([...demoCatalog, ...state.personalItems].some(item => item.id === id)))) throw Object.assign(new Error('条目 ID 无效或已存在'), { status: 400 });
      const timestamp = now();
      const item = { id, type, name: text(input.name, 120, '名称', true), description: text(input.description, 500, '描述', true), icon: text(input.icon ?? (type === 'skill' ? '技' : '插'), 8, '图标'), category: text(input.category ?? (type === 'skill' ? '个人技能' : '个人插件'), 60, '分类', true), source: 'personal', version: text(input.version ?? '1.0.0', 40, '版本', true), createdAt: editing?.createdAt ?? timestamp, updatedAt: timestamp };
      const body = input.content === undefined ? state.contents[id] ?? '' : input.content;
      if (typeof body !== 'string' || body.length > MAX_BODY) throw Object.assign(new Error('技能正文无效或过长'), { status: 400 });
      if (type === 'plugin' && body) throw Object.assign(new Error('插件管理原型不保存可执行内容'), { status: 400 });
      if (!editing && state.personalItems.length >= MAX_ITEMS) throw Object.assign(new Error('个人条目已达上限'), { status: 400 });
      if (editing) state.personalItems = state.personalItems.map(existing => existing.id === id ? item : existing);
      else state.personalItems.push(item);
      if (type === 'skill') state.contents[id] = body;
      return { ...item, installed: Boolean(state.installations[id]), enabled: state.installations[id]?.enabled ?? false, content: state.contents[id] ?? '' };
    });
  }
  async deletePersonal(id) { if (this.skills && (await this.skills.list({ includeInvalid: true })).some(item => item.id === id && item.source && path.resolve(item.source) === path.resolve(this.skills.projectManagedRoot))) return this.skills.delete(id); return this.mutate(state => { if (!state.personalItems.some(item => item.id === id)) throw Object.assign(new Error('个人条目不存在'), { status: 404 }); state.personalItems = state.personalItems.filter(item => item.id !== id); delete state.contents[id]; delete state.installations[id]; return { id, deleted: true }; }); }
  async savePreferences(input) { return this.mutate(state => { state.preferences = { ...state.preferences, ...(input.sort === 'name' || input.sort === 'updated' ? { sort: input.sort } : {}) }; return state.preferences; }); }
  async exportData(id = null) {
    const state = await this.load();
    if (this.skills && id) {
      const item = await this.get(id);
      if (item.type !== 'skill' || item.source !== 'personal') throw Object.assign(new Error('仅支持导出个人技能'), { status: 404 });
      return { format: 'lingzhu-skill-export', schemaVersion: 1, exportedAt: now(), items: [{ id: item.id, name: item.name, description: item.description, content: item.content }] };
    }
    const personalItems = state.personalItems.filter(item => !id || item.id === id);
    if (id && !personalItems.length) throw Object.assign(new Error('仅支持导出个人条目'), { status: 404 });
    return { format: 'lingzhu-extension-export', schemaVersion: SCHEMA_VERSION, exportedAt: now(), items: personalItems.map(item => ({ ...item, content: state.contents[item.id] ?? '' })) };
  }
  async importData(input) {
    if (input?.format === 'lingzhu-skill-export' && input.schemaVersion === 1 && Array.isArray(input.items) && this.skills) {
      if (input.items.length < 1 || input.items.length > 50) throw Object.assign(new Error('导入文件中的技能数量无效'), { status: 400 });
      const saved = [];
      for (const item of input.items) {
        if (!item || typeof item.content !== 'string') throw Object.assign(new Error('导入内容缺少 SKILL.md 文本'), { status: 400 });
        const match = item.content.match(/^---\s*\r?\n([\s\S]*?)\r?\n---/);
        if (!match) throw Object.assign(new Error('SKILL.md 缺少 YAML frontmatter'), { status: 400 });
        const document = parseYamlDocument(match[1], { uniqueKeys: true });
        if (document.errors.length) throw Object.assign(new Error(`导入 YAML 格式错误：${document.errors[0].message}`), { status: 400 });
        const metadata = document.toJS(); const baseId = metadata?.name;
        if (typeof baseId !== 'string' || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(baseId)) throw Object.assign(new Error('导入技能标识无效'), { status: 400 });
        const existing = new Set((await this.skills.list({ includeInvalid: true })).map(value => value.id));
        let id = baseId;
        if (existing.has(id)) {
          const suffix = randomUUID().replaceAll('-', '').slice(0, 8);
          id = `${baseId.slice(0, 55)}-${suffix}`;
          metadata.name = id;
        }
        const body = item.content.slice(match[0].length);
        const content = `---\n${stringifyYaml(metadata)}---${body}`;
        await this.skills.save({ id, content }); await this.skills.setInstalled(id, true); saved.push(await this.get(id));
      }
      return saved;
    }
    if (input?.format !== 'lingzhu-extension-export' || input.schemaVersion !== SCHEMA_VERSION || !Array.isArray(input.items) || input.items.length < 1 || input.items.length > 50) throw Object.assign(new Error('导入文件格式不受支持'), { status: 400 });
    for (const value of input.items) {
      if (!value || value.type !== 'skill' || typeof value.content !== 'string' || value.content.length > MAX_BODY) throw Object.assign(new Error('导入文件仅支持有效的个人技能条目'), { status: 400 });
      text(value.name, 120, '名称', true); text(value.description, 500, '描述', true); text(value.category, 60, '分类', true); text(value.icon ?? '技', 8, '图标'); text(value.version ?? '1.0.0', 40, '版本', true);
    }
    return this.mutate(state => {
      if (state.personalItems.length + input.items.length > MAX_ITEMS) throw Object.assign(new Error('个人条目已达上限'), { status: 400 });
      const saved = [];
      for (const value of input.items) {
        const timestamp = now(); const id = `personal-${randomUUID().slice(0, 12)}`;
        const item = { id, type: 'skill', name: text(value.name, 120, '名称', true), description: text(value.description, 500, '描述', true), icon: text(value.icon ?? '技', 8, '图标'), category: text(value.category, 60, '分类', true), source: 'personal', version: text(value.version ?? '1.0.0', 40, '版本', true), createdAt: timestamp, updatedAt: timestamp };
        state.personalItems.push(item); state.contents[id] = value.content;
        saved.push({ ...item, installed: false, enabled: false, content: value.content });
      }
      return saved;
    });
  }
}
