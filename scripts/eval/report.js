import { summarize } from '../performance-kit.js';

export function aggregate(records) {
  const groups = new Map();
  for (const record of records.filter(item => !item.warmup)) {
    const key = `${record.suite}:${record.caseId}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(record);
  }
  return [...groups].map(([scenario, items]) => {
    const valid = items.filter(item => item.verdict !== 'skipped'); const passed = valid.filter(item => item.verdict === 'passed');
    return { scenario, total: items.length, evaluated: valid.length, skipped: items.length - valid.length,
      passed: passed.length, failed: valid.length - passed.length,
      successRate: valid.length ? passed.length / valid.length : null,
      allObservedLatencyMs: summarize(valid.map(item => item.elapsedMs)),
      passedLatencyMs: summarize(passed.map(item => item.elapsedMs)),
      passedFirstOutputMs: summarize(passed.map(item => item.firstDeliveredOutputMs)),
      toolDurationMs: summarize(valid.flatMap(item => item.toolTimes ?? []).filter(item => item.ok).map(item => item.durationMs)),
      modelAttempts: valid.reduce((sum, item) => sum + (item.modelAttempts?.length ?? 0), 0),
      reportedInputTokens: valid.reduce((sum, item) => sum + (item.usage?.reportedInput ?? 0), 0),
      reportedOutputTokens: valid.reduce((sum, item) => sum + (item.usage?.reportedOutput ?? 0), 0),
      usageCompleteCount: valid.filter(item => item.usage?.complete).length,
      estimatedTotalCost: valid.length && valid.every(item => Number.isFinite(item.usage?.estimatedCost)) ? valid.reduce((sum, item) => sum + item.usage.estimatedCost, 0) : null,
      statuses: Object.fromEntries([...new Set(items.map(item => item.status))].map(status => [status, items.filter(item => item.status === status).length])) };
  });
}

const fmt = value => Number.isFinite(value) ? value.toFixed(2) : '未采集';
export function markdown(report) {
  const rows = report.summary.map(item => `| ${item.scenario} | ${item.evaluated} | ${item.skipped} | ${item.passed}/${item.failed} | ${item.successRate === null ? '不适用' : (item.successRate * 100).toFixed(1) + '%'} | ${fmt(item.passedLatencyMs.p50)} / ${fmt(item.passedLatencyMs.p95)} | ${fmt(item.passedFirstOutputMs.p95)} |`);
  return `# 自动评测报告\n\n批次：${report.id}\n\n结果：${report.result}；模式：${report.mode}；开始：${report.startTime}；结束：${report.endTime}\n\n` +
    `## 实验口径\n\n${report.notes.map(note => '- ' + note).join('\n')}\n\n` +
    `## 结果\n\n| 场景 | 正式评估数 | 跳过数 | 通过/失败 | 验收通过率 | 通过样本 P50/P95 ms | 首段 P95 ms |\n| --- | --- | --- | --- | --- | --- | --- |\n${rows.join('\n')}\n\n` +
    `## 接口负载\n\n${report.api.map(item => `- 批次 ${item.batch ?? 1}，并发 ${item.concurrency}，正式 ${item.count} 次：成功 ${item.successCount}，失败 ${item.errorCount}，吞吐 ${fmt(item.throughput)} 请求/秒，P95 ${fmt(item.latency.p95)} ms。`).join('\n') || '未执行'}\n\n` +
    `## 稳定性\n\n${report.stability ? `${report.stability.scope}；实际 ${fmt(report.stability.elapsedMs / 1000)} 秒，${report.stability.samples.length} 次采样。逐分钟统计见 summary.json。` : '未启用稳定性测试，不宣称长期稳定。'}\n\n` +
    `## 模型与资源\n\n模型 HTTP 尝试数（含预热）：${report.modelAttempts}\n\n${report.summary.filter(item => item.modelAttempts).map(item => `- ${item.scenario}：已返回输入/输出 Token ${item.reportedInputTokens}/${item.reportedOutputTokens}；用量完整样本 ${item.usageCompleteCount}/${item.evaluated}；整个场景估算成本 ${fmt(item.estimatedTotalCost)}（配置币种，非实际账单）。`).join('\n')}\n\n资源测量：${report.resources.scope}；采样数 ${report.resources.samples.length}；RSS 峰值 ${report.resources.peakRssBytes ?? '未采集'} 字节。\n\n` +
    `## 限制与失败\n\n${report.fatalError ? `批次未完整执行：${report.fatalError}\n\n` : ''}${report.cleanupErrors?.length ? `资源关闭异常：${report.cleanupErrors.join(', ')}\n\n` : ''}${report.records.filter(item => item.verdict !== 'passed').map(item => `- ${item.warmup ? '预热 ' : ''}${item.caseId}：${item.verdict}；${item.reason}`).join('\n') || '没有已采集的失败样本；跳过和未执行不算通过。'}\n\n` +
    `原始样本见 samples.jsonl；环境、配置、摘要和资源采样见 summary.json。成本为配置单价估算，不是服务商账单；缺失用量或重试可能计费时保持未知。小样本不解释为可靠 P99 或生产容量。\n`;
}
