const $ = id => document.getElementById(id);
const form = $('form');
let catalog = { selectedId: null, items: [] };
let editing = null;
let testing = false;

async function api(path, method = 'GET', data) {
  const response = await fetch(path, { method, headers: data === undefined ? {} : { 'Content-Type': 'application/json' }, body: data === undefined ? undefined : JSON.stringify(data) });
  const result = await response.json();
  if (!response.ok) throw new Error(response.status === 404 ? '本地测试接口不存在；请刷新页面，并确认打开的是当前启动的模型配置地址' : result.error || '请求失败');
  return result;
}
function feedback(message, error = false) { $('feedback').textContent = message; $('feedback').classList.toggle('error', error); }
function render() {
  const list = $('list');
  list.replaceChildren();
  if (!catalog.items.length) {
    const empty = document.createElement('div'); empty.className = 'empty'; empty.textContent = '暂无模型连接。点击 + 添加第一个模型。'; list.append(empty);
  }
  for (const item of catalog.items) {
    const button = document.createElement('button'); button.type = 'button'; button.className = `model-item${editing === item.id ? ' selected' : ''}`;
    const avatar = document.createElement('span'); avatar.className = 'model-avatar'; avatar.textContent = item.name.slice(0, 1).toUpperCase();
    const copy = document.createElement('span'); copy.className = 'model-copy';
    const name = document.createElement('span'); name.className = 'model-name'; name.textContent = item.name;
    const model = document.createElement('span'); model.className = 'model-id'; model.textContent = item.model;
    copy.append(name, model); button.append(avatar, copy);
    if (catalog.selectedId === item.id) { const dot = document.createElement('span'); dot.className = 'current-dot'; dot.title = '当前使用'; button.append(dot); }
    button.onclick = () => open(item.id); list.append(button);
  }
  const item = catalog.items.find(value => value.id === editing);
  $('heading').textContent = item ? '编辑连接' : '新增模型';
  $('active-badge').hidden = !item || catalog.selectedId !== editing;
  $('key-state').textContent = item?.hasKey ? '已配置，留空表示保留' : '';
  $('test').disabled = testing;
  $('remove').disabled = !item;
  $('select').disabled = !item || catalog.selectedId === editing;
}
function open(id) {
  editing = id;
  form.reset();
  const item = catalog.items.find(value => value.id === id);
  if (item) {
    form.elements.name.value = item.name; form.elements.model.value = item.model;
    form.elements.url.value = item.url; form.elements.fullUrl.checked = item.fullUrl;
    form.elements.streaming.checked = item.streaming !== false;
    form.elements.contextWindow.value = item.contextWindow ?? '';
    form.elements.outputReserve.value = item.outputReserve ?? '';
  }
  $('url-hint').textContent = form.elements.fullUrl.checked ? '请输入完整的 /chat/completions 请求地址' : '基础地址将自动拼接 /chat/completions';
  feedback(''); render();
}
async function action(callback) {
  try { await callback(); } catch (error) { feedback(error.message, true); }
}
async function reload() { catalog = await api('/api/models'); render(); }
function formData() {
  const data = { name: form.elements.name.value, model: form.elements.model.value, url: form.elements.url.value, fullUrl: form.elements.fullUrl.checked, streaming: form.elements.streaming.checked };
  if (form.elements.contextWindow.value) data.contextWindow = Number(form.elements.contextWindow.value);
  if (form.elements.outputReserve.value) data.outputReserve = Number(form.elements.outputReserve.value);
  if (form.elements.apiKey.value) data.apiKey = form.elements.apiKey.value;
  return data;
}
$('add').onclick = () => open(null);
form.elements.fullUrl.onchange = () => { $('url-hint').textContent = form.elements.fullUrl.checked ? '请输入完整的 /chat/completions 请求地址' : '基础地址将自动拼接 /chat/completions'; };
$('reveal').onclick = () => { const input = form.elements.apiKey; input.type = input.type === 'password' ? 'text' : 'password'; $('reveal').title = input.type === 'password' ? '显示密钥' : '隐藏密钥'; };
form.onsubmit = event => { event.preventDefault(); action(async () => {
  catalog = await api(editing ? `/api/models/${editing}` : '/api/models', editing ? 'PUT' : 'POST', formData());
  if (!editing) editing = catalog.items.at(-1).id;
  form.elements.apiKey.value = ''; render(); feedback('连接已保存');
}); };
$('select').onclick = () => action(async () => { catalog = await api(`/api/models/${editing}/select`, 'POST', {}); render(); feedback('已设为当前模型'); });
$('remove').onclick = () => action(async () => { if (!confirm('确定删除这个模型连接吗？')) return; catalog = await api(`/api/models/${editing}`, 'DELETE', {}); open(catalog.selectedId); feedback('连接已删除'); });
$('test').onclick = () => {
  if (testing) return;
  const data = { ...formData(), ...(editing ? { id: editing } : {}) };
  testing = true; render(); feedback('正在测试连接…');
  action(async () => {
    try {
      const result = await api('/api/models/test', 'POST', data);
      if (result.ok) feedback(`连接成功，耗时 ${result.elapsedMs} ms；测试未保存配置`);
      else feedback(`${result.message}（${result.code}）`, true);
    } finally { testing = false; render(); }
  });
};
reload().then(() => open(catalog.selectedId)).catch(error => feedback(error.message, true));
