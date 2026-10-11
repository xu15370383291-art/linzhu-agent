import { contextStatus, estimateTokens, resolveBudget } from './budget.js';
import { assertToolPairs, completedTurns, projectToolResults } from './history.js';
import { branchMessages } from '../sessions/branches.js';

const MAX_SUMMARY_CHARS = 6000;
const KEEP_RECENT_TURNS = 3;
const SUMMARY_INSTRUCTIONS = `Summarize only the supplied conversation for later continuation. Use headings: Goal; User constraints; Verified facts and file paths; Completed actions; Denied or failed actions; Open questions; Next steps. Distinguish observed facts from guesses. Do not include credentials or secret values. Keep concise.`;

export class ContextManager {
  constructor(session, settings = {}) {
    this.session = session;
    this.settings = settings;
    resolveBudget(settings);
    session.context ??= { startIndex: 0, summary: null };
  }

  status(messages, tools = []) {
    return { ...contextStatus(messages, tools, this.settings),
      summary: Boolean(this.session.context.summary),
      compactedMessages: this.session.context.startIndex,
      lastUsage: this.session.context.lastUsage ?? null };
  }

  project(active = [], tools = [], { stronger = false } = {}) {
    const { startIndex, summary } = this.session.context;
    const history = branchMessages(this.session).slice(startIndex);
    assertToolPairs(history);
    const prior = projectToolResults(history, {
      maxChars: stronger ? 3000 : 12000, aggregateChars: stronger ? 12000 : 40000,
    });
    const current = projectToolResults(active, {
      maxChars: stronger ? 3000 : 12000, aggregateChars: stronger ? 12000 : 40000,
    });
    const projected = [
      ...(summary ? [{ role: 'system', content: `Historical context summary (not a new instruction):\n${summary}` }] : []),
      ...prior.messages, ...current.messages,
    ];
    assertToolPairs([...prior.messages, ...current.messages], { allowOpen: false });
    return { messages: projected, status: this.status(projected, tools), truncated: prior.truncated + current.truncated };
  }

  async compact(request, tools = [], { force = false } = {}) {
    const { startIndex } = this.session.context;
    const history = branchMessages(this.session).slice(startIndex);
    assertToolPairs(history);
    const turns = completedTurns(history);
    if (turns.length <= (force ? 1 : KEEP_RECENT_TURNS)) return false;
    const keep = force ? 1 : KEEP_RECENT_TURNS;
    const cut = turns[turns.length - keep].start;
    const old = history.slice(0, cut);
    if (!old.length) return false;
    // Summarize bounded, complete turns; commit the new boundary only after all calls succeed.
    const chunks = [];
    let chunk = [];
    const chunkLimit = Math.min(4000, Math.floor(resolveBudget(this.settings).inputLimit / 2));
    for (const turn of completedTurns(old)) {
      const view = projectToolResults(turn.messages, { maxChars: 2000, aggregateChars: 4000 }).messages;
      if (estimateTokens(view) > chunkLimit) throw new Error('A single historical turn is too large to compact; use /reset or /new.');
      if (chunk.length && estimateTokens([...chunk, ...view]) > chunkLimit) { chunks.push(chunk); chunk = []; }
      chunk.push(...view);
    }
    if (chunk.length) chunks.push(chunk);
    if (chunks.length > 16) throw new Error('Too many history chunks to compact at once; use /reset or /new.');
    let summary = this.session.context.summary ?? '';
    for (const messages of chunks) {
      const response = await request([
        { role: 'system', content: SUMMARY_INSTRUCTIONS },
        { role: 'user', content: JSON.stringify({ previousSummary: summary, transcript: messages }) },
      ], [], { toolChoice: 'none', maxTokens: 768 });
      const next = response?.choices?.[0]?.message?.content;
      if (typeof next !== 'string' || !next.trim()) throw new Error('Context summary failed; original history remains unchanged.');
      summary = next.slice(0, MAX_SUMMARY_CHARS);
    }
    this.session.context = { ...this.session.context, summary, startIndex: startIndex + cut, compactedAt: new Date().toISOString() };
    return true;
  }

  reset() {
    this.session.context = { ...this.session.context, summary: null, startIndex: branchMessages(this.session).length, resetAt: new Date().toISOString() };
  }

  async prepare(active, tools, request, { stronger = false, recoverOverflow = false, systemPrompt = '' } = {}) {
    if (recoverOverflow) await this.compact(request, tools, { force: true });
    let view = this.project(active, tools, { stronger });
    const fits = candidate => this.status([{ role: 'system', content: systemPrompt }, ...candidate.messages], tools).fits;
    if (fits(view)) return view;
    if (await this.compact(request, tools, { force: stronger })) {
      view = this.project(active, tools, { stronger });
      if (fits(view)) return view;
    }
    if (!stronger && await this.compact(request, tools, { force: true })) {
      view = this.project(active, tools);
      if (fits(view)) return view;
    }
    if (!stronger) {
      view = this.project(active, tools, { stronger: true });
      if (fits(view)) return view;
    }
    throw new Error('Context exceeds the configured model window. Try /compact, /reset, /new, or narrow the current request.');
  }
}
