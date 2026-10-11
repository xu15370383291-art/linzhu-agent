import { cases as legacyCases } from '../performance-kit.js';

export function buildCases(origin = 'https://fixture.invalid') {
  const file = 'eval-data/project.md';
  const json = '仅返回一个 JSON 对象，不使用 Markdown，不增加解释。';
  return [
    { id: 'qa', prompt: '不调用工具，计算 17 加 25，只返回 JSON 对象，字段 answer 的值为数字。', expected: { answer: 42 }, tools: [] },
    { id: 'read', prompt: `${legacyCases.read.replaceAll('test/fixtures/performance', 'eval-data')} ${json} 字段为 name、version、owner、order、refund（数字）。`,
      expected: { name: '星桥资料助手', version: '2.3.1', owner: '林远', order: 'ORDER-7319', refund: 128 },
      tools: ['file_info', 'read_file'], path: file, evidenceTool: 'read_file' },
    { id: 'range', prompt: `${legacyCases.range.replaceAll('test/fixtures/performance', 'eval-data')} ${json} 字段 lines 是数组，每项包含 line（数字）和 text。必须用 startLine=10、lineCount=6。`,
      expected: { lines: [
        { line: 10, text: '版本号：2.3.1' }, { line: 11, text: '上线日期：2026-09-15' },
        { line: 12, text: '订单编号：ORDER-7319' }, { line: 13, text: '退款金额：128 元' },
        { line: 14, text: '问题标记：BENCH_MARKER_7319' }, { line: 15, text: '问题状态：已解决' },
      ] }, tools: ['file_info', 'read_file'], path: file, evidenceTool: 'read_file', range: true },
    { id: 'search', prompt: `在工作区文件中搜索 eval-data 目录内的 BENCH_MARKER_7319。${json} 字段 matches 是数组，每项包含 path 和 line。`,
      expected: { matches: [{ path: file, line: 14 }] }, tools: ['search_text'], path: 'eval-data', evidenceTool: 'search_text' },
    { id: 'missing', prompt: `${legacyCases.missing.replaceAll('test/fixtures/performance', 'eval-data')} ${json} 字段 status；不存在时值为 not_found。`, expected: { status: 'not_found' },
      tools: ['read_file'], path: 'eval-data/does-not-exist.txt', evidenceTool: 'read_file', missing: true },
    { id: 'meeting', prompt: `${legacyCases.meeting.replaceAll('test/fixtures/performance', 'eval-data')} ${json} 字段 actions 为数组，按林远、陈宁、周禾顺序，每项包含 owner 和 deadline（YYYY-MM-DD）；excluded 为不做的功能。`,
      expected: { actions: [{ owner: '林远', deadline: '2026-09-12' }, { owner: '陈宁', deadline: '2026-09-13' }, { owner: '周禾', deadline: '2026-09-14' }], excluded: '登录功能' },
      tools: ['file_info', 'read_file'], path: 'eval-data/meeting.md', evidenceTool: 'read_file' },
    { id: 'browser', prompt: `必须用 browser_open 打开 ${origin}/dynamic.html，读取 JavaScript 渲染后的内容。${json} 字段 marker 和 source。`,
      expected: { marker: 'JS_READY_7319', source: `${origin}/dynamic.html` }, tools: ['browser_open'], url: `${origin}/dynamic.html`, evidenceTool: 'browser_open', browser: true },
    { id: 'follow', prompt: `必须用 browser_open 从 ${origin}/dynamic.html 跟随页面实际存在的同源链接 ${origin}/detail.html。${json} 字段 marker、stock（数字）、source。`,
      expected: { marker: 'DETAIL_OK_7319', stock: 37, source: `${origin}/detail.html` }, tools: ['browser_open'],
      url: `${origin}/dynamic.html`, targetUrl: `${origin}/detail.html`, evidenceTool: 'browser_open', browser: true },
    { id: 'deny', prompt: `必须用 browser_open 打开 ${origin}/dynamic.html，读取网页内容。`, tools: ['browser_open'], url: `${origin}/dynamic.html`, evidenceTool: 'browser_open', browser: true, deny: true },
  ];
}

function exact(expected, actual) {
  if (expected === null || typeof expected !== 'object') return Object.is(expected, actual);
  if (!actual || typeof actual !== 'object' || Array.isArray(expected) !== Array.isArray(actual)) return false;
  const keys = Object.keys(expected);
  return keys.length === Object.keys(actual).length && keys.every(key => Object.hasOwn(actual, key) && exact(expected[key], actual[key]));
}

export function validateCall(testCase, name, args) {
  if (!args || typeof args !== 'object' || Array.isArray(args)) return false;
  if (!testCase.tools.includes(name)) return false;
  if (testCase.path && args.path !== testCase.path) return false;
  if (testCase.range && name === 'read_file' && (args.startLine !== 10 || args.lineCount !== 6)) return false;
  if (name === 'search_text' && args.query !== 'BENCH_MARKER_7319') return false;
  if (testCase.url && (args.url !== testCase.url || args.targetUrl !== testCase.targetUrl)) return false;
  return true;
}

export function grade(testCase, record) {
  if (record.status === 'skipped') return { verdict: 'skipped', reason: record.reason };
  if (testCase.deny) return { verdict: record.status === 'denied' && record.approvals?.some(item => item.decision === 'denied') && record.evidence.length === 0 ? 'passed' : 'failed', reason: '必须经审批拒绝，且没有成功页面读取证据' };
  if (record.status !== 'completed') return { verdict: 'failed', reason: `技术终态为 ${record.status}` };
  if (!testCase.missing && record.failures.some(item => item.errorCode !== 'APPROVAL_REQUIRED')) return { verdict: 'failed', reason: '存在非预期工具失败，不能只凭最终答案通过' };
  let actual;
  try { actual = JSON.parse(String(record.answer).trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')); }
  catch { return { verdict: 'failed', reason: '未按约定返回 JSON，不能自动可靠验收' }; }
  if (!exact(testCase.expected, actual)) return { verdict: 'failed', reason: '结构化答案与固定标准不一致' };
  if (record.calls.some(call => !validateCall(testCase, call.tool, call.args))) return { verdict: 'failed', reason: '工具或参数不符合题目范围' };
  if (!testCase.evidenceTool) return { verdict: record.calls.length === 0 ? 'passed' : 'failed', reason: '普通数字题不得调用工具' };
  if (testCase.missing) return { verdict: record.failures.some(item => item.tool === 'read_file') && record.errorEvidence?.some(item => item.tool === 'read_file' && /^ENOENT\b/.test(item.message) && validateCall(testCase, item.tool, item.args)) && record.evidence.length === 0 ? 'passed' : 'failed', reason: '不存在文件必须有 ENOENT 读取错误原文，不能只凭回答或通用失败码' };
  const evidence = record.evidence.filter(item => item.tool === testCase.evidenceTool && validateCall(testCase, item.tool, item.args));
  if (!evidence.length) return { verdict: 'failed', reason: '缺少指定工具的成功结果证据' };
  const evidenceText = item => typeof item.result === 'string' ? item.result : (item.result.lines ?? []).map(line => line.text).join('\n');
  if (testCase.id === 'read' && !evidence.some(item => ['星桥资料助手', '2.3.1', '林远', 'ORDER-7319', '128 元'].every(value => evidenceText(item).includes(value)))) return { verdict: 'failed', reason: '读取结果没有覆盖答案所需字段' };
  if (testCase.id === 'meeting' && !evidence.some(item => ['林远：9 月 12 日', '陈宁：9 月 13 日', '周禾：9 月 14 日', '不增加登录功能'].every(value => evidenceText(item).includes(value)))) return { verdict: 'failed', reason: '会议读取结果没有覆盖行动项和排除功能' };
  if (testCase.range && !evidence.some(item => exact(testCase.expected.lines, item.result.lines))) return { verdict: 'failed', reason: '工具分段读取结果不一致' };
  if (testCase.id === 'search' && !evidence.some(item => item.result.matches?.some(match => match.path === testCase.path + '/project.md' && match.line === 14))) return { verdict: 'failed', reason: '工具搜索结果不包含预期路径与行号' };
  if (testCase.browser && !evidence.some(item => item.result.source === testCase.expected.source && item.result.text?.includes(testCase.expected.marker) &&
    (!testCase.targetUrl || item.result.action?.url === testCase.targetUrl && item.result.text.includes('库存 37 件')))) return { verdict: 'failed', reason: '页面来源、动态正文、库存或跟随操作证据不一致' };
  return { verdict: 'passed', reason: '固定答案与工具证据均通过' };
}
