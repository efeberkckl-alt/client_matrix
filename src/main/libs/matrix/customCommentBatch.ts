import { selectAvailability, canConfirmComment, commentDispatches, getDispatchedReceipt, archiveDispatchedResult, matrixAccountStoreDirectory } from './accountManager';
import fs from 'fs';
import path from 'path';
import { createHash, randomUUID } from 'crypto';
import { z } from 'zod';
import { commentPostKey, commentWorkbookContent, planCommentAssignments, type CommentAssignmentPreview, type SavedCommentAssignmentPlan } from '../../../types/matrixCommentPlan';
import { validatedCommentPosts, type CommentPost } from '../../../types/matrixCommentPosts';
import { isRecoverableFailure } from './recovery';
import type { DispatchRecord } from './accountProtection';
import type { MatrixAccount } from './types';

const ledgerSchema = z.record(z.string(), z.enum(['pending', 'confirmed']));
const snapshotSchema = z.object({ author: z.string().regex(/^[\w.-]+$/), count: z.number().int().nonnegative(), ids: z.array(z.string().min(1)) });
const evidenceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('legacy') }),
  z.object({ kind: z.literal('observed'), before: snapshotSchema }),
]);
const entryFields = {
  accountId: z.string().nullable(),
  updatedAt: z.string(),
  dispatchId: z.string().uuid().optional(),
  dispatchSubject: z.string().min(1).optional(),
  dispatchIncarnation: z.string().min(1).optional(),
  evidence: evidenceSchema.default({ kind: 'legacy' }),
};
const entrySchema = z.discriminatedUnion('status', [
  z.object({ ...entryFields, status: z.literal('pending') }),
  z.object({ ...entryFields, status: z.literal('confirmed'), verification: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('legacy') }),
    z.object({ kind: z.literal('observed'), after: snapshotSchema, source: z.enum(['same_page', 'reopened']) }),
  ]).default({ kind: 'legacy' }) }),
]);
const stateSchema = z.object({
  version: z.literal(1),
  content: z.string(),
  owners: z.record(z.string(), z.string()),
  entries: z.record(z.string(), entrySchema),
});
type BatchState = z.infer<typeof stateSchema>;
export interface CustomCommentSummary { total: number; confirmed: number; pending: number; remaining: number; roundLimitReached?: true; }

export function customCommentAccountUnavailable(account: MatrixAccount | undefined, manualRetry = false): string | undefined {
  if (!account || account.platform !== 'tiktok') return 'account_not_found';
  if (account.authority) {
    const view = selectAvailability(account.id);
    if (!view) return 'storage_or_migration_hold';
    if (view.available) return undefined;
    return view.reasons[0] || view.status;
  }
  if (account.manualDisconnect) return 'manual_disconnect';
  if (account.chargeUncertain) return 'charge_uncertain';
  if (account.bindingConflict) return 'binding_conflict';
  if (account.status === 'banned') return 'account_banned';
  if (account.status === 'login_required' && !manualRetry) return 'login_required';
  if (account.status === 'limited') {
    if (!account.recovery) return 'account_limited';
    const manualProbe = manualRetry && isRecoverableFailure(account.recovery.reason);
    if (account.recovery.nextCheckAt > Date.now() && !manualProbe) return 'recovery_pending';
  }
  return undefined;
}

function readJson(file: string): unknown {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

type Entry = BatchState['entries'][string];
type Snapshot = z.infer<typeof snapshotSchema>;

const ledgerIdFor = (content: string) => createHash('sha256').update(content).digest('hex');
const ledgerName = /^[a-f0-9]{64}\.json$/;

function validLedgerIdentity(file: string, ledger: BatchState, key: string): boolean {
  if (path.basename(file) !== ledgerIdFor(ledger.content) + '.json') return false;
  try {
    const keys: unknown = JSON.parse(ledger.content);
    return Array.isArray(keys) && keys.every(x => typeof x === 'string') &&
      JSON.stringify([...new Set(keys)].sort()) === ledger.content && keys.includes(key);
  } catch { return false; }
}

function matchesDispatch(entry: Entry | undefined, receipt: DispatchRecord, file: string, ledger: BatchState, key: string): boolean {
  return !!entry && receipt.kind === 'comment' && receipt.ledgerKey === key &&
    receipt.ledgerId === path.basename(file, '.json') && validLedgerIdentity(file, ledger, key) &&
    entry.dispatchId === receipt.id && entry.accountId === receipt.accountId &&
    entry.dispatchSubject === receipt.subject && entry.dispatchIncarnation === receipt.incarnation;
}

function observedChange(before: Snapshot, after: Snapshot): boolean {
  return after.author === before.author &&
    (after.count > before.count || after.ids.some(id => !before.ids.includes(id)));
}

function confirmedDispatch(entry: Entry | undefined, receipt: DispatchRecord, file: string, ledger: BatchState, key: string): boolean {
  return entry?.status === 'confirmed' && entry.evidence.kind === 'observed' &&
    entry.verification.kind === 'observed' && matchesDispatch(entry, receipt, file, ledger, key) &&
    observedChange(entry.evidence.before, entry.verification.after);
}

function asPending(entry: Entry): Entry {
  const { accountId, dispatchId, dispatchSubject, dispatchIncarnation, updatedAt, evidence } = entry;
  return { status: 'pending', accountId, dispatchId, dispatchSubject, dispatchIncarnation, updatedAt, evidence };
}

function writeBatch(file: string, next: BatchState): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = file + '.' + randomUUID() + '.tmp';
  try {
    const fd = fs.openSync(temporary, 'wx');
    try { fs.writeFileSync(fd, JSON.stringify(next), 'utf8'); fs.fsyncSync(fd); }
    finally { fs.closeSync(fd); }
    fs.renameSync(temporary, file);
  } finally {
    if (fs.existsSync(temporary)) fs.unlinkSync(temporary);
  }
}

export class CustomCommentBatch {
  readonly posts: CommentPost[];
  readonly file: string;
  readonly ledgerId: string;
  private readonly reconcile: boolean;
  private state: BatchState;

  constructor(baseDir: string, input: unknown, { readOnly = false, reconcile = false } = {}) {
    this.posts = validatedCommentPosts(input);
    const content = commentWorkbookContent(this.posts);
    const id = ledgerIdFor(content);
    this.ledgerId = id;
    this.reconcile = reconcile && path.resolve(baseDir) === path.resolve(matrixAccountStoreDirectory());
    const root = path.join(baseDir, 'state', 'tiktok');
    const directory = path.join(root, 'comment-batches');
    this.file = path.join(directory, id + '.json');
    this.state = fs.existsSync(this.file) ? stateSchema.parse(readJson(this.file))
      : { version: 1, content, owners: {}, entries: {} };
    if (this.state.content !== content) throw new Error('表格评论批次内容不匹配，本次未发送');
    const keys = new Set(this.posts.map(commentPostKey));
    const merge = (entries: BatchState['entries']) => {
      for (const [key, entry] of Object.entries(entries)) {
        if (!keys.has(key)) continue;
        const current = this.state.entries[key];
        if (!current || current.status !== 'confirmed' && entry.status === 'confirmed'
          || current.status === entry.status && current.evidence.kind === 'legacy' && entry.evidence.kind === 'observed') this.state.entries[key] = entry;
      }
    };
    if (fs.existsSync(directory)) {
      for (const name of fs.readdirSync(directory)) {
        if (!ledgerName.test(name) || path.join(directory, name) === this.file) continue;
        merge(stateSchema.parse(readJson(path.join(directory, name))).entries);
      }
    }
    const legacyRoot = path.join(root, 'tasks');
    if (fs.existsSync(legacyRoot)) {
      for (const task of fs.readdirSync(legacyRoot, { withFileTypes: true })) {
        if (!task.isDirectory()) continue;
        const legacy = path.join(legacyRoot, task.name, 'custom_video_comments.json');
        if (!fs.existsSync(legacy)) continue;
        const ledger = ledgerSchema.parse(readJson(legacy));
        const entries: BatchState['entries'] = {};
        for (const [key, status] of Object.entries(ledger)) entries[key] = entrySchema.parse({ status, accountId: null, updatedAt: new Date().toISOString() });
        merge(entries);
      }
    }
    const results = this.reconcile ? this.reduceLedger(keys, readOnly) : [];
    if (!readOnly) {
      // The batch remains the source of proof. A failed batch write cannot advance the account receipt.
      this.persist();
      for (const [receipt, result] of results) archiveDispatchedResult(receipt, result);
    }
  }

  private reduceLedger(keys: ReadonlySet<string>, readOnly: boolean): [DispatchRecord, 'confirmed' | 'comment_pending'][] {
    const receipts = commentDispatches(keys, readOnly);
    const results: [DispatchRecord, 'confirmed' | 'comment_pending'][] = [];
    const entries = this.state.entries;
    const origins = new Map<string, BatchState>();
    for (const receipt of receipts) {
      const key = receipt.ledgerKey!;
      const originFile = this.originPath(receipt);
      let origin = originFile && origins.get(originFile);
      if (!origin && originFile && fs.existsSync(originFile)) {
        origin = stateSchema.parse(readJson(originFile));
        origins.set(originFile, origin);
      }
      const original = origin?.entries[key];
      const verified = !!origin && !!originFile && confirmedDispatch(original, receipt, originFile, origin, key);
      if (verified && original) {
        results.push([receipt, 'confirmed']);
        entries[key] = original;
      } else {
        results.push([receipt, 'comment_pending']);
        const owned = origin && originFile && matchesDispatch(original, receipt, originFile, origin, key);
        const fallback = entrySchema.parse({ status: 'pending', accountId: receipt.accountId, dispatchId: receipt.id,
          updatedAt: new Date(receipt.at).toISOString() });
        // Only original evidence can make a pending entry eligible for a later confirmation.
        entries[key] = owned && original ? asPending(original) : fallback;
      }
    }
    const found = new Set(receipts.map(receipt => receipt.id));
    for (const [key, entry] of Object.entries(entries)) {
      if (keys.has(key) && entry.dispatchId && !found.has(entry.dispatchId)) entries[key] = asPending(entry);
    }
    return results;
  }

  private originPath(receipt: DispatchRecord): string | undefined {
    return receipt.ledgerId && /^[a-f0-9]{64}$/.test(receipt.ledgerId)
      ? path.join(path.dirname(this.file), receipt.ledgerId + '.json') : undefined;
  }

  private persist(next: BatchState = this.state): void {
    writeBatch(this.file, next);
    this.state = next;
  }

  readLedger(): z.infer<typeof ledgerSchema> {
    return Object.fromEntries(Object.entries(this.state.entries).map(([key, entry]) => [key, entry.status]));
  }

  assignmentLedger(): CommentAssignmentPreview['ledger'] {
    return Object.fromEntries(Object.entries(this.state.entries).map(([key, { status, accountId }]) => [key, { status, accountId }]));
  }

  prepare(key: string, accountId: string, input: unknown, dispatchId?: string): void {
    if (!this.posts.some(post => commentPostKey(post) === key)) throw new Error('评论不属于当前批次');
    if (this.state.entries[key]) throw new Error('评论已有发送记录，不允许重复发送');
    const before = snapshotSchema.parse(input);
    const receipt = dispatchId && this.reconcile ? getDispatchedReceipt(dispatchId) : undefined;
    if (dispatchId && this.reconcile && (!receipt || receipt.kind !== 'comment' || receipt.accountId !== accountId ||
        receipt.ledgerId !== this.ledgerId || receipt.ledgerKey !== key || !canConfirmComment(dispatchId, accountId))) {
      throw Error('comment_ledger_mismatch');
    }
    this.persist({ ...this.state, entries: { ...this.state.entries,
      [key]: { status: 'pending', accountId, dispatchId, dispatchSubject: receipt?.subject, dispatchIncarnation: receipt?.incarnation, updatedAt: new Date().toISOString(), evidence: { kind: 'observed', before } },
    } });
  }

  confirm(key: string, accountId: string, input: unknown, source: 'same_page' | 'reopened'): string | undefined {
    const after = snapshotSchema.parse(input);
    const current = this.state.entries[key];
    if (!current || current.status !== 'pending') throw new Error('评论尚未记录发送意图或已确认');
    if (this.reconcile && current.dispatchId && !canConfirmComment(current.dispatchId, accountId)) {
      throw Error('comment_dispatch_subject_changed');
    }
    if (current.accountId !== accountId || current.evidence.kind !== 'observed') throw new Error('缺少原执行账号或发送前证据，保持待核验');
    let origin: BatchState = this.state;
    let originFile = this.file;
    let before = current.evidence.before;
    if (this.reconcile && current.dispatchId) {
      const receipt = getDispatchedReceipt(current.dispatchId);
      const file = receipt && this.originPath(receipt);
      if (!receipt || !file || !fs.existsSync(file)) throw Error('comment_ledger_mismatch');
      originFile = file;
      origin = stateSchema.parse(readJson(file));
      const original = origin.entries[key];
      if (!matchesDispatch(original, receipt, file, origin, key) || original?.status !== 'pending' ||
          original.evidence.kind !== 'observed') throw Error('comment_ledger_mismatch');
      before = original.evidence.before;
    }
    if (!observedChange(before, after)) throw new Error('没有原执行账号的新评论证据，保持待核验');
    const confirmed: Entry = { ...current, evidence: { kind: 'observed', before }, status: 'confirmed', updatedAt: new Date().toISOString(),
      verification: { kind: 'observed', after, source } };
    if (originFile !== this.file) writeBatch(originFile, { ...origin, entries: { ...origin.entries, [key]: confirmed } });
    this.persist({ ...this.state, entries: { ...this.state.entries, [key]: confirmed } });
    return current.dispatchId;
  }

  pendingFor(accountId: string) {
    return this.posts.flatMap(post => {
      const entry = this.state.entries[commentPostKey(post)];
      return entry?.status === 'pending' && entry.accountId === accountId && entry.evidence.kind === 'observed'
        && (!this.reconcile || !entry.dispatchId || canConfirmComment(entry.dispatchId, accountId))
        ? [{ ...post, before: entry.evidence.before }] : [];
    });
  }

  plan(accountIds: readonly string[], previous?: SavedCommentAssignmentPlan, retainedAccountIds?: readonly string[], random?: () => number) {
    // Version 1 batch owners were per-video. Carry forward send records, then distribute only never-sent comments.
    const plan = planCommentAssignments({
      posts: this.posts, accountIds, retainedAccountIds, random,
      previousOwners: new Map(Object.entries(previous?.owners ?? {}).flatMap(([key, owner]) => owner ? [[key, owner] as const] : [])),
      recordedOwners: new Map(Object.entries(this.state.entries).map(([key, entry]) => [key, entry.accountId])),
    });
    const savedPlan: SavedCommentAssignmentPlan = { version: 2, owners: Object.fromEntries(plan.owners) };
    return { ...plan, savedPlan };
  }

  summary(): CustomCommentSummary {
    let confirmed = 0, pending = 0;
    for (const post of this.posts) {
      const status = this.state.entries[commentPostKey(post)]?.status;
      if (status === 'confirmed') confirmed++;
      else if (status === 'pending') pending++;
    }
    return { total: this.posts.length, confirmed, pending, remaining: this.posts.length - confirmed - pending };
  }
}

/** Import matching durable results before the scheduler can admit a workbook run. */
export function reconcileStoredCommentTransactions(baseDir: string): number {
  if (path.resolve(baseDir) !== path.resolve(matrixAccountStoreDirectory())) return 0;
  const directory = path.join(baseDir, 'state', 'tiktok', 'comment-batches');
  if (!fs.existsSync(directory)) return 0;
  let faults = 0;
  for (const name of fs.readdirSync(directory)) {
    if (!ledgerName.test(name)) continue;
    try {
      const file = path.join(directory, name);
      const batch = stateSchema.parse(readJson(file));
      const keys = new Set(Object.entries(batch.entries).filter(([, entry]) => !!entry.dispatchId).map(([key]) => key));
      for (const receipt of commentDispatches(keys)) {
        const key = receipt.ledgerKey!;
        const entry = batch.entries[key];
        if (entry?.dispatchId !== receipt.id || entry.accountId !== receipt.accountId) continue;
        archiveDispatchedResult(receipt, confirmedDispatch(entry, receipt, file, batch, key) ? 'confirmed' : 'comment_pending');
      }
    } catch { faults++; } // The affected file remains intact and its workbook will fail closed on open.
  }
  return faults;
}

// Electron and Tauri enforce one application instance. Serialize workbook runs in its sidecar.
const runningDirectories = new Set<string>();
export async function withCustomCommentBatch<T>(baseDir: string, posts: unknown, run: (batch: CustomCommentBatch) => Promise<T>): Promise<T> {
  const resolved = path.resolve(baseDir);
  const key = process.platform === 'win32' ? resolved.toLowerCase() : resolved;
  if (runningDirectories.has(key)) throw new Error('已有表格评论任务运行，请等待完成后重试');
  runningDirectories.add(key);
  try { return await run(new CustomCommentBatch(baseDir, posts, { reconcile: true })); }
  finally { runningDirectories.delete(key); }
}
