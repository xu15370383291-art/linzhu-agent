import { randomUUID } from 'node:crypto';

export function ensureBranches(session) {
  session.schemaVersion ??= 2;
  const hadBranches = Array.isArray(session.branches) && session.branches.length > 0;
  const activeId = session.activeBranchId ?? 'main';
  const active = session.branches?.find(value => value.id === activeId);
  const hasPersistedIds = (session.messages ?? []).some(message => message.messageId);
  let activeParent = active?.headMessageId ?? null;
  let previous = null;
  for (const message of session.messages ?? []) {
    const fresh = !message.messageId;
    message.messageId ??= randomUUID();
    message.createdAt ??= new Date().toISOString();
    message.branchId ??= hadBranches && hasPersistedIds ? activeId : 'main';
    if (fresh) message.parentMessageId = message.branchId === activeId && (hadBranches && hasPersistedIds)
      ? activeParent : previous?.branchId === message.branchId ? previous.messageId : null;
    previous = message;
    if (fresh && message.branchId === activeId && active) { activeParent = message.messageId; active.headMessageId = message.messageId; }
  }
  session.branches ??= [{ id: 'main', name: 'main', headMessageId: session.messages?.at(-1)?.messageId ?? null, forkedFrom: null, createdAt: session.createdAt ?? new Date().toISOString() }];
  session.activeBranchId ??= 'main';
  const currentBranch = session.branches.find(value => value.id === session.activeBranchId);
  if (currentBranch && !currentBranch.headMessageId) currentBranch.headMessageId = session.messages.filter(message => message.branchId === currentBranch.id).at(-1)?.messageId ?? null;
  return session;
}

export function branchMessages(session, branchId = session.activeBranchId ?? 'main') {
  if (!session.branches || session.messages?.some(message => !message.messageId)) return session.messages ?? [];
  ensureBranches(session);
  const branch = session.branches.find(value => value.id === branchId);
  if (!branch) throw new Error('Branch not found');
  const head = branch.headMessageId;
  if (!head) return session.messages.filter(message => message.branchId === branchId);
  const byId = new Map(session.messages.map(message => [message.messageId, message]));
  const selected = []; const visited = new Set(); let current = head;
  while (current) {
    if (visited.has(current)) throw new Error('Invalid branch: message parent cycle');
    visited.add(current);
    const message = byId.get(current); if (!message) break; selected.push(message); current = message.parentMessageId ?? null;
  }
  return selected.reverse();
}

export function forkBranch(session, name = 'branch') {
  ensureBranches(session);
  const source = session.branches.find(value => value.id === session.activeBranchId);
  const id = randomUUID();
  session.branches.push({ id, name: String(name).trim().slice(0, 80) || 'branch', headMessageId: source?.headMessageId ?? null,
    forkedFrom: source?.headMessageId ?? null, createdAt: new Date().toISOString() });
  session.activeBranchId = id;
  return session.branches.at(-1);
}

export function rewindBranch(session, messageId) {
  ensureBranches(session);
  const message = session.messages.find(value => value.messageId === messageId);
  if (!message) throw new Error('Message not found');
  const branch = session.branches.find(value => value.id === session.activeBranchId);
  branch.headMessageId = messageId;
  return branch;
}

export function switchBranch(session, branchId) {
  ensureBranches(session);
  if (!session.branches.some(value => value.id === branchId)) throw new Error('Branch not found');
  session.activeBranchId = branchId;
  session.context = { ...(session.context ?? { startIndex: 0, summary: null }), startIndex: 0, summary: null, branchSwitchedAt: new Date().toISOString() };
  return session.branches.find(value => value.id === branchId);
}
