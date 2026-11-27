import fs from 'fs';
import path from 'path';
import os from 'os';
import { randomUUID } from 'crypto';

export type Operation = 'launch' | 'navigate' | 'scroll' | 'input' | 'interaction' | 'script';
export type SafetyReason = 'captcha' | 'rate_limited' | 'forbidden' | 'account_flag' | 'page_failures' | 'login_wall';

// Milliseconds. These are local request budgets, not platform-approved safe thresholds.
export const OPERATION_INTERVALS: Record<Operation, { account: number[]; shared: number[]; group: number[] }> = {
  launch: { account: [5000, 10000], shared: [5000, 10000], group: [5000, 10000] },
  navigate: { account: [10000, 20000], shared: [2000, 4000], group: [4000, 8000] },
  scroll: { account: [3000, 6000], shared: [1000, 2000], group: [1500, 3000] },
  input: { account: [4000, 8000], shared: [1000, 2000], group: [2000, 4000] },
  interaction: { account: [45000, 90000], shared: [8000, 12000], group: [12000, 20000] },
  script: { account: [3000, 6000], shared: [1000, 2000], group: [2000, 4000] },
};

export class AutomationSafetyError extends Error {
  constructor(public readonly reason: string, public readonly until = 0, public readonly code?: SafetyReason) {
    super(`自动操作已暂停：${reason}${until ? `，最早恢复时间 ${new Date(until).toLocaleString()}` : ''}`);
    this.name = 'AutomationSafetyError';
  }
}

type Pause = { until: number; reason: string; code?: SafetyReason; runtime?: true; eventId?: string };
type PauseEntry = Pause & { other?: Pause[] };
type PauseLedger = Record<string, PauseEntry>;
type SafetyEnvelope = { formatVersion: 1; pauses: PauseLedger; importAcks: string[] };
type SafetySnapshot = { bytes: string | undefined; pauses: PauseLedger; envelope?: SafetyEnvelope };
export type ForbiddenReviewEvidence = Readonly<{ ledgerBytes: string | undefined }>;

export class ForbiddenReviewChangedError extends AutomationSafetyError {
  constructor() { super('复核期间出现新的 403 或暂停记录已变更，请重新复核'); }
}

// Ignore unrelated keys, key order, and 429 companions in the page-evidence
// comparison. Include expired legacy records so a clock boundary alone does
// not change the stamp, and unbound reviews can later check the observed UID.
function forbiddenEvidenceStamp(snapshot: SafetySnapshot, keys: ReadonlySet<string>): string {
  return JSON.stringify([...keys].sort().map(key => [key,
    splitPauses(snapshot.pauses[key]).filter(p => p.code === 'forbidden').map(p =>
      [p.eventId ?? null, p.until, p.reason, p.runtime ?? null]).map(p => JSON.stringify(p)).sort()]));
}

// Keep the established commit fence for cooldown/group races. A foreign
// hard 403 alone is independent, including when it shares a key with a timer.
function reviewCommitStamp(snapshot: SafetySnapshot, keys: ReadonlySet<string>): string {
  const pauses = Object.keys(snapshot.pauses).sort().flatMap(key => {
    const original = snapshot.pauses[key];
    const value = keys.has(key) || !key.startsWith('account:') ? original
      : packPauses(splitPauses(original).filter(p => p.code !== 'forbidden'));
    return value ? [[key, value]] : [];
  });
  return JSON.stringify([snapshot.envelope?.formatVersion, snapshot.envelope?.importAcks, pauses]);
}

// Keep an independent deadline for each cause. A new 429 must remain even
// when an older 403 at the same identity is later cleared by review.
function splitPauses(entry?: PauseEntry): Pause[] {
  if (!entry) return [];
  const { other, ...first } = entry;
  return [first, ...(other || [])];
}
function pauseActive(pause: Pause, now: number): boolean {
  return pause.until > now || (pause.runtime === true && (pause.code === 'forbidden' || pause.code === 'account_flag'));
}
function priority(pause: Pause): number {
  return pause.code === 'forbidden' ? 3 : pause.code === 'account_flag' ? 2 : pause.code === 'rate_limited' ? 0 : 1;
}
function orderedPauses(pauses: Pause[]): Pause[] {
  return [...pauses].sort((a,b) => priority(b)-priority(a) || b.until-a.until);
}
function packPauses(pauses: Pause[]): PauseEntry | undefined {
  const [first, ...other] = orderedPauses(pauses);
  return first && (other.length ? { ...first, other } : first);
}
function mergeOrdinaryStop(entry: PauseEntry | undefined, stop: Pause): PauseEntry {
  const existing = splitPauses(entry);
  const previous = existing.find(pause => pause.code === stop.code);
  if (previous && previous.until >= stop.until && stop.code !== 'forbidden') return entry!;
  const next = previous ? { ...stop, until: Math.max(previous.until, stop.until) } : stop;
  return packPauses([...existing.filter(pause => pause.code !== stop.code),next])!;
}
type WriterKind = 'protect' | 'review' | 'exclusive';
type LedgerOwner = { pid: number; work: string; kind: WriterKind };

const lockError = () => new AutomationSafetyError('暂停记录暂不可更新，请稍后重新核对');
class SafetyLedgerChangedError extends AutomationSafetyError {}
const diskChanged = () => new SafetyLedgerChangedError('暂停记录已变化，请重新载入后核对');
const waitCell = new Int32Array(new SharedArrayBuffer(4));
const pauseForWriter = () => Atomics.wait(waitCell, 0, 0, 5);
const missing = (error: unknown) => (error as NodeJS.ErrnoException)?.code === 'ENOENT';
function processAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code !== 'ESRCH'; }
}
function removeOwnFile(file: string): void {
  try { fs.unlinkSync(file); } catch { /* Only temporary names owned by this operation. */ }
}
function removeOwnDir(dir: string): void {
  try { fs.rmdirSync(dir); } catch { /* Never recurse across another owner's directory. */ }
}

/** A tiny, crash-recoverable mutex protecting only publication and retirement of writer tokens. */
function withWriterGate<T>(file: string, fn: () => T): T {
  const gate = file + '.writer-gate';
  const ticket = fs.mkdtempSync(gate + '.ticket-');
  const marker = 'owner-' + process.pid + '-' + path.basename(ticket).slice(-6);
  const claimed = 'retiring-' + process.pid + '-' + path.basename(ticket).slice(-6);
  const retired = ticket + '.retired';
  const retire = (owned: string): boolean => {
    // Rename the exact generation's marker first. Another process can never
    // retire a successor merely because it observed a stale directory name.
    try { fs.renameSync(path.join(gate, owned), path.join(gate, claimed)); }
    catch (error) { if (missing(error)) return false; throw error; }
    fs.renameSync(gate, retired);
    removeOwnFile(path.join(retired, claimed));
    removeOwnDir(retired);
    return true;
  };
  try {
    fs.writeFileSync(path.join(ticket, marker), '', { flag: 'wx' });
    for (let attempt = 0; attempt < 150; attempt++) {
      try { fs.renameSync(ticket, gate); }
      catch (error) {
        let entries: string[];
        try { entries = fs.readdirSync(gate); }
        catch (readError) { if (missing(readError)) { pauseForWriter(); continue; } throw error; }
        const pid = /^(?:owner|retiring)-(\d+)-[a-zA-Z0-9]+$/.exec(entries[0] || '');
        if (entries.length !== 1 || !pid || Number(pid[1]) <= 0) throw lockError();
        if (!processAlive(Number(pid[1]))) retire(entries[0]);
        else pauseForWriter();
        continue;
      }
      try { return fn(); } finally { if (!retire(marker)) throw lockError(); }
    }
    throw lockError();
  } finally {
    removeOwnFile(path.join(ticket, marker));
    removeOwnDir(ticket);
  }
}

export function readSafetyLedgerBytes(file: string): string | undefined {
  try { return fs.readFileSync(file, 'utf8'); }
  catch (error) { if (missing(error)) return undefined; throw error; }
}

function parseSafetyLedger(bytes: string | undefined): SafetySnapshot {
  const corrupt = () => new AutomationSafetyError('暂停记录损坏，请检查本地记录');
  const data = bytes === undefined ? {} : JSON.parse(bytes);
  const record = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value);
  if (!record(data)) throw corrupt();
  const envelope: SafetyEnvelope | undefined = data.formatVersion === 1 ? data : undefined;
  if (envelope && (!record(envelope.pauses) || !Array.isArray(envelope.importAcks)
      || envelope.importAcks.some(value => typeof value !== 'string'))) throw corrupt();
  const pauses: PauseLedger = envelope?.pauses ?? data;
  const validPause = (p: Pause) => record(p) && Number.isFinite(p.until) && typeof p.reason === 'string'
    && (p.runtime === undefined || p.runtime === true)
    && (p.eventId === undefined || (p.code === 'forbidden' && typeof p.eventId === 'string' && p.eventId.length > 0));
  for (const [key, pause] of Object.entries(pauses)) {
    if (!validPause(pause) || (pause.other !== undefined && (!key.startsWith('account:') || !Array.isArray(pause.other)
      || !pause.other.every(p => validPause(p) && !Object.hasOwn(p,'other'))))) throw corrupt();
  }
  return { bytes, pauses, envelope };
}

function readOwner(file: string): LedgerOwner | undefined {
  const raw = readSafetyLedgerBytes(file + '.writer');
  if (raw === undefined) return;
  const owner: LedgerOwner = JSON.parse(raw);
  const prefix = path.basename(file) + '.write-';
  if (!owner || !Number.isSafeInteger(owner.pid) || owner.pid <= 0 || typeof owner.work !== 'string'
      || !owner.work.startsWith(prefix) || !/^[a-zA-Z0-9]+$/.test(owner.work.slice(prefix.length))
      || !['protect','review','exclusive'].includes(owner.kind)) throw lockError();
  return owner;
}

/**
 * Acquirers never run account callbacks while holding this lock. Account writers
 * take accounts.writer first. A protection writer may revoke a review iff it
 * atomically takes the review's already-prepared source file before publication.
 * The old writer then cannot rename it, even if suspended inside the OS call.
 */
export function withSafetyLedgerWriter<T>(file: string, kind: WriterKind, run: (writer: {
  read: () => SafetySnapshot; replace: (snapshot: SafetySnapshot, bytes: string) => SafetySnapshot;
}) => T): T {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const work = fs.mkdtempSync(file + '.write-');
  const owner = { pid: process.pid, work: path.basename(work), kind };
  const pointer = file + '.writer';
  const ownerFile = path.join(work, 'owner');
  const draft = path.join(work, 'draft'), ready = path.join(work, 'ready'), revoked = path.join(work, 'revoked');
  let own = false;
  let used = false;
  try {
    fs.writeFileSync(ownerFile, JSON.stringify(owner), { flag: 'wx' });
    for (let attempt = 0; attempt < 150 && !own; attempt++) {
      own = withWriterGate(file, () => {
        const current = readOwner(file);
        if (current) {
          const priorWork = path.join(path.dirname(file), current.work);
          const live = processAlive(current.pid);
          if (live) {
            if (kind !== 'protect' || current.kind !== 'review') return false;
            const priorRevoked = path.join(priorWork, 'revoked');
            if (!fs.existsSync(priorRevoked)) {
              try { fs.renameSync(path.join(priorWork, 'ready'), priorRevoked); }
              catch (error) { if (missing(error) || ['EPERM','EBUSY','EACCES'].includes((error as NodeJS.ErrnoException).code || '')) return false; throw error; }
            }
          }
          // The gate excludes release/reacquisition. A live review may only
          // lose this token after its one-shot input was atomically fenced.
          fs.unlinkSync(pointer);
          if (!live) {
            for (const part of ['owner','draft','ready','revoked']) removeOwnFile(path.join(priorWork,part));
            removeOwnDir(priorWork);
          }
        }
        fs.renameSync(ownerFile, pointer);
        return true;
      });
      if (!own) pauseForWriter();
    }
    if (!own) throw lockError();
    const read = () => parseSafetyLedger(readSafetyLedgerBytes(file));
    return run({ read, replace: (snapshot, bytes) => {
      if (used) throw lockError();
      used = true;
      fs.writeFileSync(draft, bytes, { flag: 'wx', encoding: 'utf8', mode: 0o600 });
      fs.renameSync(draft, ready); // Complete bytes before a contender can fence the source.
      if (readSafetyLedgerBytes(file) !== snapshot.bytes) throw diskChanged();
      try { fs.renameSync(ready, file); }
      catch (error) { if (fs.existsSync(revoked)) throw diskChanged(); throw error; }
      return parseSafetyLedger(bytes);
    }});
  } finally {
    try { if (own) withWriterGate(file, () => { if (readOwner(file)?.work === owner.work) fs.unlinkSync(pointer); }); }
    finally {
      for (const part of [ownerFile,draft,ready,revoked]) removeOwnFile(part);
      removeOwnDir(work);
    }
  }
}
type Active = { identity: string; group: string; managed: boolean; log: (text: string) => void; controller: AbortController; stopped?: Pause; ownStop?: Pause };

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const stopped = () => signal.reason instanceof AutomationSafetyError ? signal.reason : new AutomationSafetyError('任务已结束');
    if (signal.aborted) { reject(stopped()); return; }
    const done = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); resolve(); };
    const abort = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); reject(stopped()); };
    const timer = setTimeout(done, ms);
    signal.addEventListener('abort', abort, { once: true });
  });
}

/** One process-wide limiter: all platforms, runners and task batches share these clocks. */
export class AutomationSafety {
  private active = new Map<string, Active>();
  private next = new Map<string, number>();
  private incidents = new Map<string, Map<string, number>>();
  private pageFailures = new Map<string, Set<string>>();
  private loaded = false;
  private persistedBytes?: string;
  private storageFailed = false;
  // Runtime-only scopes can still contribute to a durable group pause.
  // Managed account stops live on disk before their account callbacks.
  private localPauses: PauseLedger = {};
  private diskPauses: PauseLedger = {};

  constructor(
    private readonly file: string,
    private readonly now = Date.now,
    private readonly sleep = wait,
    private readonly random = Math.random,
  ) {}

  private sync(snapshot: SafetySnapshot): void {
    this.persistedBytes = snapshot.bytes;
    this.diskPauses = snapshot.pauses;
    this.loaded = true;
  }

  private load(): void {
    const bytes = readSafetyLedgerBytes(this.file);
    if (!this.loaded || this.persistedBytes !== bytes) this.sync(parseSafetyLedger(bytes));
  }

  accountAndGroupPauses(identities: readonly string[], groups: readonly string[], now = this.now()) {
    this.load();
    const pauses = this.diskPauses;
    let groupUntil = 0;
    for (const group of groups) groupUntil = Math.max(groupUntil, pauses['group:' + group]?.until || 0);
    const accountPauses = identities.flatMap(identity => this.activeAccountPauses('account:' + identity, now));
    return { groupUntil, accountPauses, account: orderedPauses(accountPauses)[0] };
  }

  captureForbiddenReviewEvidence(): ForbiddenReviewEvidence {
    const snapshot = parseSafetyLedger(readSafetyLedgerBytes(this.file));
    return Object.freeze({ ledgerBytes: snapshot.bytes });
  }

  /** Only invoked by the explicit, proof-gated account review. Never changes group cooldowns. */
  clearReviewedForbidden(id: string, identities: readonly string[], expected: ForbiddenReviewEvidence | string | undefined,
    evidenceIdentities: readonly string[] = identities, commitBaseline?: ForbiddenReviewEvidence) {
    if (this.storageFailed || this.active.has(id)) throw lockError();
    const keys = new Set(identities.map(identity => 'account:' + identity));
    const now = this.now();
    const evidence = typeof expected === 'object' ? expected : undefined;
    const evidenceKeys = new Set(evidenceIdentities.map(identity => 'account:' + identity));
    const baseline = evidence && forbiddenEvidenceStamp(parseSafetyLedger(evidence.ledgerBytes), evidenceKeys);
    const commitStamp = commitBaseline && reviewCommitStamp(parseSafetyLedger(commitBaseline.ledgerBytes), evidenceKeys);
    const assertEvidence = (snapshot: SafetySnapshot, stamp: string | undefined) => {
      if (stamp !== undefined && forbiddenEvidenceStamp(snapshot, evidenceKeys) !== stamp) {
        throw new ForbiddenReviewChangedError();
      }
    };
    const removeForbidden = (from: PauseLedger) => {
      const next = { ...from };
      const removed: [string, PauseEntry][] = [];
      for (const key of keys) {
        const item = from[key];
        const all = splitPauses(item);
        const retained = all.filter(pause => pause.code !== 'forbidden' || !pauseActive(pause, now));
        if (all.length === retained.length) continue;
        removed.push([key, item]);
        const replacement = packPauses(retained);
        if (replacement) next[key] = replacement;
        else delete next[key];
      }
      return { next, removed };
    };
    const encode = (snapshot: SafetySnapshot, pauses: PauseLedger) =>
      JSON.stringify(snapshot.envelope ? { ...snapshot.envelope, pauses } : pauses, null, 2);
    const before = this.localPauses;
    const local = removeForbidden(before);
    const stage = (priorAttempt?: string) => withSafetyLedgerWriter(this.file, 'review', writer => {
      const original = writer.read();
      this.sync(original);
      assertEvidence(original, baseline);
      if (!evidence && original.bytes !== expected) throw diskChanged();
      const currentCommitStamp = (commitStamp !== undefined || priorAttempt !== undefined) && reviewCommitStamp(original, evidenceKeys);
      if ((commitStamp !== undefined && currentCommitStamp !== commitStamp)
        || (priorAttempt !== undefined && currentCommitStamp !== priorAttempt)) throw diskChanged();
      const { next, removed } = removeForbidden(original.pauses);
      try {
        const staged = removed.length ? writer.replace(original, encode(original,next)) : original;
        return { original, staged, removed };
      } catch (error) {
        // A protective writer may fence our uncommitted staging file. Retry
        // only when the fresh read will prove that no relevant entry changed.
        if (evidence && priorAttempt === undefined && error instanceof SafetyLedgerChangedError) {
          return { retry: reviewCommitStamp(original, evidenceKeys) };
        }
        throw error;
      }
    });
    const first = stage();
    const result = first.retry === undefined ? first : stage(first.retry);
    const { original, staged, removed } = result;
    if (!original || !staged || !removed) throw diskChanged();
    const stagedForbidden = evidence && forbiddenEvidenceStamp(staged, evidenceKeys);
    this.localPauses = local.next;
    this.sync(staged);
    return {
      holdForAccountCommit: <T>(run: () => T) => withSafetyLedgerWriter(this.file, 'exclusive', writer => {
        const actual = writer.read();
        this.sync(actual);
        assertEvidence(actual, stagedForbidden);
        if (actual.bytes !== staged.bytes && (!evidence || reviewCommitStamp(actual, evidenceKeys) !== reviewCommitStamp(staged, evidenceKeys))) {
          throw diskChanged();
        }
        return run();
      }),
      rollback: () => {
        // A later writer may have committed since our replacement. Restore
        // only our own deleted keys, never the whole earlier snapshot.
        this.localPauses = before;
        withSafetyLedgerWriter(this.file, 'exclusive', writer => {
          const latest = writer.read();
          const merged = { ...latest.pauses };
          let changed = false;
          for (const [key, pause] of removed) {
            // Do not touch a competing record at this key. If our retained
            // companion is unchanged, put back only what this review removed.
            if (JSON.stringify(merged[key]) !== JSON.stringify(staged.pauses[key])) continue;
            merged[key] = pause;
            changed = true;
          }
          const out = changed ? writer.replace(latest, latest.bytes === staged.bytes
            ? original.bytes! : encode(latest, merged)) : latest;
          this.sync(out);
        });
      },
    };
  }

  private isManagedAccount(id: string, identity: string): boolean {
    // Read the already-published account store without acquiring its writer.
    // A standalone limiter may create temporary scopes that are not accounts.
    const bytes = readSafetyLedgerBytes(path.join(path.dirname(this.file),'accounts.json'));
    if (!bytes) return false;
    const store = JSON.parse(bytes);
    const rows = Array.isArray(store) ? store : store?.accounts;
    return Array.isArray(rows) && rows.some(row => row?.id === id &&
      (identity === id || (row.boundUid && identity === row.platform + ':' + row.boundUid)));
  }

  begin(id: string, identity: string, group: string, log: (text: string) => void, managed?: boolean): void {
    this.load();
    this.end(id);
    this.active.set(id, { identity, group, managed: managed ?? this.isManagedAccount(id,identity), log, controller: new AbortController() });
    try { this.assertAllowed(id); } catch (e) { this.end(id); throw e; }
  }

  end(id: string): void {
    this.active.get(id)?.controller.abort();
    this.active.delete(id);
    this.pageFailures.delete(id);
  }

  isActive(id: string): boolean { return this.active.has(id); }
  signal(id: string): AbortSignal | undefined { return this.active.get(id)?.controller.signal; }

  setGroup(id: string, group: string): void {
    const a = this.active.get(id);
    if (!a || a.group === group) return;
    const previous = this.next.get(`group:${a.group}:activity`) || 0;
    this.next.set(`group:${group}:activity`, Math.max(previous, this.next.get(`group:${group}:activity`) || 0));
    a.group = group;
    this.assertAllowed(id);
  }

  /** Stop this run without turning a transport failure into a persisted platform restriction. */
  stopRun(id: string, reason: string): never {
    const a = this.active.get(id);
    if (a && !a.stopped) { a.stopped = { until: 0, reason }; a.log(reason); }
    throw new AutomationSafetyError(a?.stopped?.reason || reason);
  }

  blocked(id: string): Pause | undefined {
    const a = this.active.get(id);
    if (!a) return undefined;
    if (a.stopped) return a.stopped;
    this.load();
    const now = this.now();
    const group = this.diskPauses['group:' + a.group];
    return orderedPauses([...this.activeAccountPauses('account:' + a.identity, now),
      ...(group && group.until > now ? [group] : [])])[0];
  }

  private activeAccountPauses(key: string, now = this.now()): Pause[] {
    return [...splitPauses(this.diskPauses[key]), ...splitPauses(this.localPauses[key])].filter(pause => pauseActive(pause, now));
  }

  accountPause(id: string): Pause | undefined {
    const active = this.active.get(id);
    if (!active) return undefined;
    const pauses = orderedPauses(this.activeAccountPauses('account:' + active.identity));
    const own = active.ownStop && pauses.find(pause => pause.code === active.ownStop!.code);
    return own && priority(own) >= priority(pauses[0]) ? own : pauses[0];
  }

  private recordActiveStop(a: Active, stop: Pause): Pause {
    const pauses = orderedPauses(this.activeAccountPauses('account:' + a.identity));
    const strongest = pauses[0];
    const matching = pauses.find(pause => pause.code === stop.code) || stop;
    const selected = strongest && priority(strongest) > priority(matching) ? strongest : matching;
    a.ownStop = a.stopped = selected;
    return selected;
  }

  assertAllowed(id: string): void {
    if (this.storageFailed && this.active.has(id)) throw new AutomationSafetyError('暂停记录未保存，请核对本地记录');
    const p = this.blocked(id);
    if (p) throw new AutomationSafetyError(p.reason, p.until, p.code);
  }

  async before(id: string, operation: Operation): Promise<(succeeded?: boolean) => void> {
    const a = this.active.get(id);
    if (!a) return () => {}; // Manual login / user-owned windows are not automated tasks.
    const rule = OPERATION_INTERVALS[operation];
    // All interactions share a clock, so changing like -> comment cannot reset its budget.
    const category = operation === 'script' ? 'input' : operation;
    const keys = [`account:${a.identity}:${category}`, 'shared:activity', `group:${a.group}:activity`];
    let announced = false;
    while (true) {
      this.assertAllowed(id);
      if (a.controller.signal.aborted) throw new AutomationSafetyError('任务已结束');
      const now = this.now();
      const remaining = Math.max(0, ...keys.map((key) => (this.next.get(key) || 0) - now));
      if (remaining <= 0) {
        // No await between checking and reserving: concurrent accounts cannot take one slot.
        const intervals = [rule.account, rule.shared, rule.group].map((range) => range[0] + Math.floor(this.random() * (range[1] - range[0] + 1)));
        keys.forEach((key, i) => this.next.set(key, now + intervals[i]));
        // Slow page probes or uploads must not consume the gap before the actual operation finishes.
        return (succeeded = true) => {
          keys.forEach((key, i) => this.next.set(key, Math.max(this.next.get(key) || 0, this.now() + intervals[i])));
          if (succeeded && operation === 'interaction') this.pageFailures.delete(id);
        };
      }
      if (!announced) {
        const label = { launch: '启动浏览器', navigate: '打开页面', scroll: '滚动加载', input: '点击/输入', interaction: '互动/发布', script: '页面操作' }[operation];
        a.log(`⏳ 操作限速：${label}，至少等待 ${Math.ceil(remaining / 1000)} 秒（点击停止可中断等待）`);
        announced = true;
      }
      // Recheck shared cooldowns while waiting, without reserving future slots for cancelled work.
      await this.sleep(Math.min(remaining, 1000), a.controller.signal);
    }
  }

  pageFailed(id: string, url: string): void {
    if (!this.active.has(id)) return;
    const failures = this.pageFailures.get(id) || new Set<string>();
    failures.add(url.split('?')[0]);
    this.pageFailures.set(id, failures);
    if (failures.size >= 3) this.halt(id, 'page_failures', 0, '连续加载失败');
  }

  halt(id: string, reason: SafetyReason, retryAfterMs = 0, detail = ''): void {
    const a = this.active.get(id);
    if (!a) return;
    const stopped = new Map<Active, Pause>();
    const messages: { member: Active; text: string }[] = [];
    const accountKey = 'account:' + a.identity;
    // A new observation is an event even if the cooldown remains unchanged.
    const eventId = reason === 'forbidden' ? randomUUID() : undefined;
    const labels = { captcha: '检测到验证码，需人工处理', rate_limited: '平台明确限制操作频率', forbidden: '平台拒绝访问', account_flag: '账号操作受到限制', page_failures: '连续多个页面加载失败，请检查网络或平台提示', login_wall: '页面要求登录或验证，需人工检查（不代表账号封禁或已登出）' };
    const protectivePause = (previous: Pause | undefined, now: number, runtime: boolean): Pause => {
      const until = Math.max(previous?.until || now + 30 * 60000,
        now + (Number.isFinite(retryAfterMs) ? Math.max(0, retryAfterMs) : 0));
      return { until, reason: labels[reason], code: reason, ...(runtime && { runtime: true as const }),
        ...(eventId && { eventId }) };
    };
    try {
      const writeStop = () => withSafetyLedgerWriter(this.file, 'protect', writer => {
        const latest = writer.read();
        this.sync(latest);
        const now = this.now();
        const previous = this.activeAccountPauses(accountKey, now);
        // Preserve the earlier plain-ledger pacing convention. In v1 the
        // runtime entries each carry precisely their own code and deadline.
        const prior = latest.envelope ? previous.find(p => p.code === reason) : orderedPauses(previous)[0];
        const durable = !latest.envelope || a.managed;
        const stop = protectivePause(prior, now, !!latest.envelope && durable);
        const next = { ...latest.pauses };
        if (durable) next[accountKey] = mergeOrdinaryStop(next[accountKey], stop);
        const recent = reason !== 'captcha' && reason !== 'login_wall'
          ? new Map(this.incidents.get(a.group)) : undefined;
        let groupPause: Pause | undefined;
        if (recent) {
          for (const [key, ts] of recent) if (now - ts > 10 * 60000) recent.delete(key);
          recent.set(a.identity, now);
          if (recent.size >= 2) {
            const groupKey = 'group:' + a.group;
            const groupUntil = Math.max(stop.until, next[groupKey]?.until || 0,
              ...Array.from(recent.keys(), key => Math.max(0,
                ...splitPauses(next['account:' + key]).map(p => p.until),
                ...splitPauses(this.localPauses['account:' + key]).map(p => p.until))));
            groupPause = { ...next[groupKey], until: groupUntil, reason: '同一出口/代理入口的多个账号受限，暂停该组自动任务' };
            next[groupKey] = groupPause;
          }
        }
        if (next[accountKey] !== latest.pauses[accountKey] || groupPause) {
          const bytes = JSON.stringify(latest.envelope ? { ...latest.envelope, pauses: next } : next, null, 2);
          this.sync(writer.replace(latest, bytes));
        }
        if (!durable) this.localPauses[accountKey] = mergeOrdinaryStop(this.localPauses[accountKey], stop);
        if (recent) this.incidents.set(a.group, recent);
        return { stop, groupPause };
      });
      let result: ReturnType<typeof writeStop>;
      try { result = writeStop(); }
      catch (error) {
        // Retry transient filesystem failure once from a new locked snapshot.
        if (!['EACCES','EPERM','EBUSY','EIO'].includes((error as NodeJS.ErrnoException)?.code || '')) throw error;
        result = writeStop();
      }
      const { stop, groupPause } = result;
      const pause = this.recordActiveStop(a,stop);
      stopped.set(a, pause);
      if (groupPause) {
        for (const member of this.active.values()) {
          if (member.group !== a.group) continue;
          member.stopped = groupPause;
          if (member !== a) stopped.set(member,groupPause);
          messages.push({ member, text: '🛑 同组多个账号受限，停止自动操作，请检查平台提示。' });
        }
      }
      messages.push({ member: a, text: `🛑 ${pause.reason}${detail ? `；触发原因：${detail}` : ''}；本轮停止，冷却至 ${new Date(pause.until).toLocaleString()}。不会自动绕过验证或重试发布。` });
    } catch (error) {
      this.storageFailed = true;
      const stop = protectivePause(this.activeAccountPauses(accountKey).find(p => p.code === reason), this.now(), true);
      this.localPauses[accountKey] = mergeOrdinaryStop(this.localPauses[accountKey], stop);
      const pause = this.recordActiveStop(a,stop);
      stopped.set(a,pause);
      messages.push({ member: a, text: '🛑 ' + pause.reason + '；暂停账本暂不可更新，本轮已停止。' });
      throw error;
    } finally {
      try {
        // Logs and abort listeners may update accounts.json. Never invoke
        // either while the safety writer is held (account -> safety only).
        for (const { member, text } of messages) member.log(text);
      } finally {
        for (const [member, pause] of stopped) {
          member.controller.abort(new AutomationSafetyError(pause.reason, pause.until, pause.code));
        }
      }
    }
  }
}

export const automationSafety = new AutomationSafety(path.join(process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'), 'automation-safety.json'));

/** A selector/label is a conservative hint; unknown button clicks still receive input pacing. */
export function operationForCommand(command: string, hint = ''): Operation | undefined {
  if (/^(navigate|open_url|goto)$/.test(command)) return 'navigate';
  if (/scroll|wheel|swipe/.test(command)) return 'scroll';
  if (/^(get_|query_|wait_|is_|read_|screenshot|hover)/.test(command)) return undefined;
  if (/^(like|follow|comment|reply|post|publish|send|submit)(_|$)/.test(command)) return 'interaction';
  if (/click|tap|press|type|fill|insert|upload|select|editor/.test(command)) {
    if (/like|follow|publish|submit|comment[-_]post|\bpost\b|tweet|send|reply|点赞|关注|发布|发送|提交|回复|评论|转发|分享/i.test(hint + ' ' + command)) return 'interaction';
    return 'input';
  }
  return 'script';
}

export function operationForScript(source: string): Operation | undefined {
  if (!/\.click\s*\(|dispatchEvent\s*\(|execCommand\s*\(|\.scroll(?:Top|Left)\s*[+\-]?=(?!=)|\.scroll(?:By|To)\s*\(|\.(?:value|textContent|innerText)\s*=(?!=)|fetch\s*\(/.test(source)) return undefined;
  // Opaque page scripts are rate-limited as a whole; nested page-side loops are not individually observable.
  return /\.click\s*\(|dispatchEvent\s*\(/.test(source) ? 'interaction' : 'script';
}

/** Keep the diagnostic endpoint without leaking credentials or signed URL parameters. */
export function safetyUrlForLog(value: string): string {
  try {
    const url = new URL(value);
    url.username = ''; url.password = ''; url.hash = '';
    for (const key of Array.from(url.searchParams.keys())) {
      if (/token|auth|key|sign|credential|password|secret|cookie|session|code/i.test(key)) url.searchParams.set(key, '[REDACTED]');
    }
    return url.toString().slice(0, 2000);
  } catch { return '(网址不可解析)'; }
}

export function restrictedResponse(params: any, now = Date.now(), mainFrameId?: string, criticalWrite = false): { reason: SafetyReason; retryAfterMs: number; pause: boolean } | undefined {
  const r = params?.response;
  if (!r || !['Document', 'XHR', 'Fetch'].includes(params.type)) return undefined;
  if (r.status !== 429 && r.status !== 403) return undefined;
  const value = Object.entries(r.headers || {}).find(([key]) => key.toLowerCase() === 'retry-after')?.[1];
  const seconds = Number(value);
  const retryAfterMs = value == null ? 0 : Number.isFinite(seconds) ? Math.max(0, seconds * 1000) : Math.max(0, Date.parse(String(value)) - now) || 0;
  // A single API/iframe 403 is not evidence that the whole account is blocked.
  // Explicit page restrictions are still detected before the next operation.
  const mainDocument = params.type === 'Document' && !!mainFrameId && params.frameId === mainFrameId;
  return { reason: r.status === 429 ? 'rate_limited' : 'forbidden', retryAfterMs, pause: r.status === 429 || mainDocument || criticalWrite };
}

// Only visible verification containers, explicit alerts/toasts and small access-denied pages count.
// Ordinary post/comment text containing these words must not pause someone else's account.
export const AUTOMATION_RESTRICTION_EXPR = `(function(){
  function visible(e){if(!e||!e.getClientRects().length)return false;var s=getComputedStyle(e);return s.display!=='none'&&s.visibility!=='hidden';}
  if(/^https:\\/\\/(?:www\\.)?tiktok\\.com(?:\\/|$)/i.test(location.href)){
    var inputs=document.querySelectorAll('input[type="password"],input[autocomplete="one-time-code"]');
    for(var p=0;p<inputs.length;p++)if(visible(inputs[p]))return 'login_wall';
    var dialogs=document.querySelectorAll('[role="dialog"],dialog,[class*="LoginModal"],[data-e2e="login-modal"],form');
    for(var d=0;d<dialogs.length;d++){
      if(!visible(dialogs[d]))continue;
      var heading=dialogs[d].querySelector('h1,h2,h3,[role="heading"],[data-e2e="login-title"],[data-e2e="signup-title"]');
      if(visible(heading)&&/^(?:log\\s?in(?: to TikTok)?|sign\\s?in(?: to TikTok)?|sign\\s?up(?: for TikTok)?|登录(?:\\s*TikTok)?|登入(?:\\s*TikTok)?|登錄(?:\\s*TikTok)?|注册(?:\\s*TikTok)?)$/i.test((heading.innerText||'').trim()))return 'login_wall';
    }
  }
  var cs=document.querySelectorAll('[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],[class*="geetest" i]');
  for(var i=0;i<cs.length;i++){var r=cs[i].getBoundingClientRect();if(visible(cs[i])&&r.width>=150&&r.height>=150)return 'captcha';}
  var text=(document.body&&document.body.innerText||'').trim();
  if(text.length<1500&&/HTTP ERROR (403|429)|Access Denied|Access to .+ was denied|请求被拒绝/i.test(text))return /429/.test(text)?'rate_limited':'forbidden';
  if(/something went wrong|加载失败|載入失敗|加载出错|出了点问题/i.test(text)){
    var bs=document.querySelectorAll('button,[role="button"]');
    for(var k=0;k<bs.length;k++)if(visible(bs[k])&&/^(Refresh|Retry|Reload|刷新|重新整理|重试|重試)$/i.test((bs[k].innerText||'').trim()))return 'page_error:'+location.href;}
  var alerts=document.querySelectorAll('[role="alert"],[role="dialog"],[class*="toast" i],[data-e2e*="toast" i]');
  for(var j=0;j<alerts.length;j++){if(!visible(alerts[j]))continue;var t=(alerts[j].innerText||'').trim();
    if(/verify (?:that )?you are human|complete (?:the )?(?:captcha|security verification)|请完成安全验证|拖动滑块|滑动完成验证/i.test(t))return 'captcha';
    if(/too many (?:requests|attempts)|(?:tapping|following|commenting|posting) too fast|doing that too much|rate limit exceeded|over the daily limit|操作(?:过于|太)?频繁|请求过于频繁|访问过于频繁|操作太快/i.test(t))return 'rate_limited';
    if(/temporarily (?:blocked|restricted)|account (?:is )?(?:suspended|restricted)|we restrict certain activity|暂时无法(?:评论|关注|点赞)|账号已被限制/i.test(t))return 'account_flag';}
  return '';
})()`;
