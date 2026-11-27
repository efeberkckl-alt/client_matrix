/**
 * 账号池 —— 矩阵号本地账号库(不上云,见 feedback_matrix_isolation_boundary)。
 *
 * 一号 = 身份 + 持久 profile 目录 + 固定指纹种子 + 固定代理 + 健康态。数据落本地
 * JSON;profile 目录持久(登录态长期粘)。指纹种子/代理一旦分配即固定,不漂移。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import net from 'net';
import { randomUUID } from 'crypto';
import { coworkLog } from '../coworkLogger';
import { pruneAccountFromTasks } from './taskStore';
import { recoveryDelay } from './recovery';
import type { MatrixAccount, AccountStatus, Fingerprint, Proxy } from './types';
import { resolveFingerprintLocale, readTimezone, regionCode, validateFingerprintLocaleInput, validateFingerprintLocalePatch, type ExitLocale, type FingerprintLocaleInput, type FingerprintLocalePatch } from '../../../types/matrixFingerprintLocale';
import { diagnosticAccountAlias } from './kernelNavigation';
import { identifyProfile, type ProfileIdentity } from './profileIdentity';
import { availabilityOf, hasPendingCookieMutation, decodeProtectionReason, legacyAccountAuthority, legacyPausePlan, mergeProtection, nextRevision,
  openAccountEnvelope, sha256, type DispatchRecord, type DispatchSubject, type MatrixPublishOperation, type MatrixPublishOutcome, type Protection, type StoreEnvelope } from './accountProtection';

import { isUnboundLoginWait } from '../../../types/matrixAccountRecovery';
import { automationSafety, ForbiddenReviewChangedError, withSafetyLedgerWriter, type ForbiddenReviewEvidence } from './automationSafety';

export { validateFingerprintLocalePatch };

function baseDir(): string {
  // 可被 env 覆盖(测试/自定义);默认放用户目录下,与成片输出同根。
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}
export function matrixAccountStoreDirectory(): string { return baseDir(); }
function storeFile(): string { return path.join(baseDir(), 'accounts.json'); }
function safetyFile(): string { return path.join(baseDir(), 'automation-safety.json'); }
function profilesDir(): string { return path.join(baseDir(), 'profiles'); }
/** 所有账号 profile 的根目录(启动时全局孤儿清扫按它匹配内核进程命令行)。 */
export function matrixProfilesRoot(): string { return profilesDir(); }

let cache: MatrixAccount[] | null = null;
let accountStore: StoreEnvelope | undefined;
let durableAccounts: string | undefined;
let storageFault = false;

function replaceAccountFile(file: string, bytes: string): void {
  const temp = file + '.tmp';
  fs.writeFileSync(temp, bytes, { encoding: 'utf8', mode: 0o600 });
  fs.renameSync(temp, file);
}

function withAccountWriter<T>(write: () => T): T {
  ensureDirs();
  const lock = path.join(baseDir(),'accounts.writer');
  let fd: number;
  try { fd=fs.openSync(lock,'wx',0o600); }
  catch {
    const pid = Number(fs.readFileSync(lock,'utf8'));
    if (!Number.isSafeInteger(pid) || pid<=0) throw Error('storage_or_migration_hold');
    try { process.kill(pid,0); throw Error('storage_or_migration_hold'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code!=='ESRCH') throw Error('storage_or_migration_hold'); }
    const recoveryClaim = lock + '.recover';
    const claimFd = fs.openSync(recoveryClaim, 'wx', 0o600);
    try {
      if (Number(fs.readFileSync(lock,'utf8'))!==pid) throw Error('storage_or_migration_hold');
      fs.unlinkSync(lock);
      fd=fs.openSync(lock,'wx',0o600);
    } finally {
      fs.closeSync(claimFd);
      fs.unlinkSync(recoveryClaim);
    }
  }
  try { fs.writeFileSync(fd,String(process.pid)); return write(); }
  finally { fs.closeSync(fd); fs.unlinkSync(lock); }
}

function ensureDirs(): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.mkdirSync(profilesDir(), { recursive: true });
}

export function loadAccounts(): MatrixAccount[] {
  if (storageFault) throw new Error('storage_or_migration_hold');
  if (cache) return cache;
  const f = storeFile();
  try {
    return withAccountWriter(() => withSafetyLedgerWriter(safetyFile(), 'exclusive', writer => {
      const original=fs.existsSync(f)?fs.readFileSync(f,'utf8'):undefined;
      const ledger=writer.read();
      const safety=ledger.bytes ?? '{}';
      const evidence=path.join(baseDir(),'migration-evidence');
      if (original===undefined && fs.existsSync(path.join(evidence,'initialized'))) throw Error('storage_or_migration_hold');
      fs.mkdirSync(evidence,{recursive:true});
      for(const [label,data] of [['accounts',original],['safety',safety]]){
        if(data===undefined)continue;
        const snapshot=path.join(evidence,label+'-'+sha256(data)+'.snapshot');
        if(!fs.existsSync(snapshot))fs.writeFileSync(snapshot,data,{flag:'wx',encoding:'utf8',mode:0o600});
      }
      const parsed=original===undefined?[]:JSON.parse(original);
      const store=openAccountEnvelope(parsed);
      const plan=legacyPausePlan(store,safety);
      let changed=Array.isArray(parsed)||plan.changed;
      for(const account of store.accounts){
        changed=clearLegacyEgressHold(account)||changed;
        const authority=account.authority!;
        changed=pinForbiddenSubject(account)||changed;
        if (authority.attempt) {
          if (authority.attempt.scanId) authority.lastScanId = authority.attempt.scanId;
          delete authority.attempt;
          authority.epoch = nextRevision(authority.epoch);
          changed = true;
        }
        if(authority.mutations && Object.values(authority.mutations).some(m=>m.state!=='completed')){
          // Only an existing witness for the exact old instance can repair a predecessor receipt.
          for (const mutation of Object.values(authority.mutations)) {
            const proven = authority.browserOwner;
            if (!mutation.profile && proven?.instance === mutation.instance && proven.profile?.exists) mutation.profile = proven.profile;
          }
          const witnesses = Object.values(authority.mutations).flatMap(mutation => mutation.profile ? [mutation.profile] : []);
          authority.cleanup||={id:authority.incarnation+'-'+authority.epoch,priorMutations:Object.keys(authority.mutations),
            profile: witnesses[0]};
          mergeProtection(authority,{kind:'cleanup_pending'});changed=true;
        }
      }
      for (const account of store.accounts) {
        const previous = account.chargeUncertain;
        if (!previous || Object.values(store.dispatchRecords).some(r => r.kind === 'billing'
          && r.result === 'charge_uncertain' && recordSubjects(r).some(subject => belongsToSubject(account, subject)
            || subject.accountId === account.id && subject.incarnation === account.authority!.incarnation))) continue;
        const id = randomUUID();
        const authority = account.authority!;
        const record: DispatchRecord = { id, accountId: account.id, kind: 'billing', profile: account.userDataDir,
          incarnation: authority.incarnation, epoch: authority.epoch, subject: accountSubject(account),
          action: previous.action, platform: previous.platform || account.platform, refId: previous.refId,
          at: Number.isFinite(previous.at) ? previous.at : 0, result: 'charge_uncertain' };
        authority.constraints = authority.constraints.filter(c => c.kind !== 'billing_uncertain' || c.source !== previous.refId);
        store.dispatchRecords[id] = record;
        applyUncertainCharge(store, record);
        changed = true;
      }
      for (const record of Object.values(store.dispatchRecords)) {
        if (record.result || record.kind !== 'billing') continue;
        record.result = 'charge_uncertain';
        applyUncertainCharge(store, record);
        changed = true;
      }
      if(changed){store.storeRevision=nextRevision(store.storeRevision);replaceAccountFile(f,JSON.stringify(store,null,2));}
      if(plan.changed)writer.replace(ledger, JSON.stringify({formatVersion:1,pauses:plan.pauses,importAcks:plan.importAcks},null,2));
      if(!fs.existsSync(path.join(evidence,'initialized')))fs.writeFileSync(path.join(evidence,'initialized'),store.storeId,{flag:'wx'});
      durableAccounts=fs.readFileSync(f,'utf8');
      accountStore=store;
      cache=store.accounts;
      return cache;
    }));
  } catch {
    storageFault=true;
    coworkLog('ERROR','accountManager','matrix account store unavailable');
    throw Error('storage_or_migration_hold');
  }
}

/** Retire only the old exit-confirmation hold; unrelated restrictions survive upgrades. */
function clearLegacyEgressHold(a: MatrixAccount): boolean {
  const isExitHold = (reason?: string): boolean => !!reason && (reason.startsWith('network_changed:')
    || reason === 'network_error:未能确认当前出口，等待网络复查'
    || reason === '网络已确认，等待登录复查' || reason === '网络已人工确认');
  const wasExitHold = isExitHold(a.statusReason) || isExitHold(a.recovery?.reason);
  const holdReason = a.egress?.holdReason;
  let changed = false;
  if (a.egress && (a.egress.changedAt !== undefined || a.egress.holdReason !== undefined)) {
    delete a.egress.changedAt;
    delete a.egress.holdReason;
    changed = true;
  }
  if (a.chargeUncertain && isExitHold(a.chargeUncertain.holdReason)) {
    delete a.chargeUncertain.holdReason;
    changed = true;
  }
  if (holdReason && !isExitHold(holdReason) && a.chargeUncertain && !a.chargeUncertain.holdReason) {
    a.chargeUncertain.holdReason = holdReason;
    changed = true;
  }
  if (a.status === 'limited' && wasExitHold) {
    delete a.recovery;
    if (a.bindingConflict || a.manualDisconnect) {
      a.status = 'login_required';
      a.statusReason = a.bindingConflict ? '账号绑定冲突，请确认本人身份后重新关联' : '账号已主动断开，请重新连接后运行';
    } else if (a.chargeUncertain) {
      a.statusReason = '计费结果不明，请核对账单后恢复';
    } else if (holdReason && !isExitHold(holdReason)) {
      a.statusReason = holdReason;
    } else {
      a.status = 'idle';
      delete a.statusReason;
    }
    changed = true;
  }
  return changed;
}

// 指纹浏览器左上角角标(badge)文案,对齐旧客户端 group 标签:平台名 · 账号昵称 · 备注 [· #任务简写]。
// 昵称登录后才读到(空则省略那段);taskId 仅在有任务上下文时传(登录/取材点一般取不到 → 不显示)。
const PLATFORM_ZH: Record<string, string> = {
  douyin: '抖音', xhs: '小红书', kuaishou: '快手', bilibili: 'B站', shipinhao: '视频号',
  toutiao: '头条', x: 'X', binance: '币安广场', youtube: 'YouTube', tiktok: 'TikTok',
  instagram: 'Instagram', facebook: 'Facebook', reddit: 'Reddit',
  gate: 'Gate广场', bitget: 'Bitget Insight', bybit: 'Bybit Byx', okx: 'OKX星球',
};
export function accountBadgeLabel(acc: Pick<MatrixAccount, 'platform' | 'displayName' | 'nickname'>, taskId?: string): string {
  const parts: string[] = [PLATFORM_ZH[acc.platform] || acc.platform];
  if (acc.nickname) parts.push(acc.nickname);
  parts.push(acc.displayName);
  if (taskId) parts.push('#' + String(taskId).slice(0, 6));
  return parts.join(' · ');
}

// 浏览器标签分组(蓝色 pill)标题 —— 对齐旧客户端扩展 '🤖 ' + key 的约定:只放【🤖 + 平台 + 任务id缩写】。
// 账号信息(昵称/备注)交给窗口左上角绿色角标(label),pill 不再重复 → 多窗一眼看出「是哪个任务」。
// 任务id缩写取【唯一尾巴】(平台/类型前缀已被平台名覆盖):binance_engage_l8x2k_3a → l8x2k_3a;
//   无下划线分段(异常 id)则回退末 6 位。无 taskId(登录/保活无任务上下文)→ 只 🤖 + 平台。
export function matrixGroupTitle(platform: string, taskId?: string): string {
  const plat = PLATFORM_ZH[platform] || platform;
  if (!taskId) return `🤖 ${plat}`;
  const segs = String(taskId).split('_').filter(Boolean);
  const abbr = segs.length >= 2 ? segs.slice(-2).join('_') : String(taskId).slice(-6);
  return `🤖 ${plat} #${abbr}`;
}

function commitAccountsToDisk(): void {
  if (!accountStore || !cache) throw Error('storage_or_migration_hold');
  const f=storeFile();
  if(fs.readFileSync(f,'utf8')!==durableAccounts)throw Error('storage_or_migration_hold');
  const next=nextRevision(accountStore!.storeRevision);
  const previous=new Map(openAccountEnvelope(JSON.parse(durableAccounts!)).accounts.map(a=>[a.id,a]));
  for(const account of cache!){
    account.authority||=legacyAccountAuthority(account);
    pinForbiddenSubject(account);
    const authority=account.authority;
    if(JSON.stringify(account)!==JSON.stringify(previous.get(account.id)))authority.revision=next;
  }
  const draft={...accountStore!,accounts:cache!,storeRevision:next};
  const bytes=JSON.stringify(draft,null,2);
  replaceAccountFile(f,bytes);
  accountStore=draft; durableAccounts=bytes;
}

function persist(): void {
  if(storageFault||!accountStore||!cache)throw Error('storage_or_migration_hold');
  try {
    withAccountWriter(commitAccountsToDisk);
  } catch {
    failAccountStorage();
  }
}

function failAccountStorage(): never {
  storageFault=true;
  accountStore=durableAccounts?openAccountEnvelope(JSON.parse(durableAccounts)):undefined;
  cache=accountStore?.accounts||null;
  throw Error('storage_or_migration_hold');
}

function currentSafety(account: MatrixAccount, now: number) {
  const groups=[account.proxy ? `proxy:${account.proxy.protocol}:${account.proxy.host}:${account.proxy.port}` : `local:${getLocalEgressIp()||'unknown'}`];
  if (account.egress?.ip) groups.push('exit:'+account.egress.ip);
  const identities = [account.id];
  if (account.boundUid) identities.push(account.platform + ':' + account.boundUid);
  const frozen = account.authority?.forbiddenSubject;
  const prefix = platformKey(account) + ':';
  if (frozen?.startsWith(prefix)) identities.push(account.platform + ':' + frozen.slice(prefix.length));
  return automationSafety.accountAndGroupPauses([...new Set(identities)], groups, now);
}

function profileWitnesses(authority: MatrixAccount['authority']): ProfileIdentity[] {
  const values = [authority?.browserOwner?.profile, authority?.cleanup?.profile, authority?.createdProfile,
    ...Object.values(authority?.mutations || {}).map(mutation => mutation.profile)];
  return values.filter((profile): profile is ProfileIdentity => !!profile);
}

function profileRecords(account: MatrixAccount, identity: ProfileIdentity, accounts: readonly MatrixAccount[]): MatrixAccount[] {
  return accounts.filter(other => other.id === account.id || identifyProfile(other.userDataDir)?.key === identity.key ||
    profileWitnesses(other.authority).some(witness => witness.key === identity.key));
}

function profileDrifted(account: MatrixAccount, identity: ProfileIdentity | undefined): boolean {
  return !identity || profileWitnesses(account.authority).some(witness => witness.key !== identity.key);
}

function needsLegacyProfileReview(identity: ProfileIdentity | undefined, accounts: readonly MatrixAccount[]): boolean {
  // An old receipt without a witness can refer to an existing managed directory behind today's junction.
  if (!identity?.exists || accounts.some(row => row.authority?.createdProfile?.key === identity.key)) return false;
  return accounts.some(row => {
    const authority = row.authority;
    const mutations = Object.values(authority?.mutations || {}).filter(m => m.state !== 'completed');
    return mutations.some(m => !m.profile?.exists) ||
      (!!authority?.cleanup && !authority.cleanup.profile?.exists && !mutations.length && !authority.browserOwner?.profile?.exists);
  });
}

function profileBlocked(account: MatrixAccount, identity: ProfileIdentity | undefined, accounts: readonly MatrixAccount[]): boolean {
  return !identity || needsLegacyProfileReview(identity, accounts) || profileDrifted(account, identity) || profileRecords(account, identity, accounts).some(other =>
    other !== account && (profileDrifted(other, identifyProfile(other.userDataDir)) || other.authority?.cleanup || hasPendingCookieMutation(other.authority)));
}

/** Shared directory gate. Cookie cleanup has a private permit checked by the kernel before using this exception. */
export function assertProfileAccess(id: string, directory: string, expected?: string, cleanup = false): ProfileIdentity {
  const accounts = loadAccounts();
  const account = accounts.find(item => item.id === id);
  const identity = identifyProfile(directory);
  if (!account?.authority || !identity || identifyProfile(account.userDataDir)?.key !== identity.key ||
      (expected !== undefined && expected !== identity.key) || profileBlocked(account, identity, accounts) ||
      (!cleanup && (account.authority.cleanup || hasPendingCookieMutation(account.authority)))) {
    throw Error('profile_cleanup_unconfirmed');
  }
  return identity;
}

export function prepareProfileDirectory(id: string, directory: string, initial: ProfileIdentity, cleanup = false): ProfileIdentity {
  assertProfileAccess(id, directory, initial.key, cleanup);
  if (initial.exists) return initial;
  if (cleanup) throw Error('profile_cleanup_unconfirmed');
  // Exclusively create the final directory. An existing target cannot gain this proof.
  fs.mkdirSync(path.dirname(initial.directory), { recursive: true });
  if (identifyProfile(directory)?.key !== initial.key) throw Error('profile_cleanup_unconfirmed');
  fs.mkdirSync(initial.directory);
  const current = identifyProfile(directory);
  const account = getAccount(id);
  if (!current?.exists || current.directory !== initial.directory || !account?.authority ||
      identifyProfile(account.userDataDir)?.key !== current.key) throw Error('profile_cleanup_unconfirmed');
  account.authority.createdProfile = current;
  persist();
  return assertProfileAccess(id, directory, current.key);
}

function readAccountSnapshot(): StoreEnvelope | undefined {
  try { return openAccountEnvelope(JSON.parse(fs.readFileSync(storeFile(), 'utf8'))); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function previewCommentAccountIds(ids: string[]): string[] {
  if (storageFault) return [];
  const accounts = readAccountSnapshot()?.accounts || [];
  const wanted = new Set(ids);
  return accounts.filter(account => {
    if (!wanted.has(account.id) || account.platform !== 'tiktok') return false;
    const now = Date.now();
    const safety = currentSafety(account, now);
    return availabilityOf(account, now, safety.groupUntil, false,
      profileBlocked(account, identifyProfile(account.userDataDir), accounts), false, safety.accountPauses).available;
  }).map(account => account.id);
}

export function selectAvailability(id: string, _intent: 'business' | 'probe' = 'business') {
  try {
    const accounts = loadAccounts();
    const account = accounts.find(item => item.id === id);
    if (!account) return undefined;
    const now = Date.now();
    const safety = currentSafety(account, now);
    const profile = identifyProfile(account.userDataDir);
    return availabilityOf(account, now, safety.groupUntil, storageFault,
      profileBlocked(account, profile, accounts), needsLegacyProfileReview(profile, accounts), safety.accountPauses);
  } catch { return undefined; }
}

export type AssociationFence = Readonly<{
  accountId: string; storeId: string; incarnation: string; epoch: string;
  attemptId?: string; instance?: string;
}>;

export function accountStoreVersion() {
  loadAccounts();
  return accountStore && { storeId: accountStore.storeId, storeRevision: accountStore.storeRevision };
}

export function accountEventVersion(id: string) {
  const a = getAccount(id);
  if (!a?.authority || !accountStore) return undefined;
  return { storeId: accountStore.storeId, storeRevision: accountStore.storeRevision,
    stateRevision: a.authority.revision, incarnation: a.authority.incarnation,
    epoch: a.authority.epoch, attemptId: a.authority.attempt?.id,
    activeScanId: a.authority.attempt?.scanId, lastScanId: a.authority.lastScanId };
}

export function captureAssociation(id: string): AssociationFence | undefined {
  const version = accountEventVersion(id);
  const authority = getAccount(id)?.authority;
  if (!version || !authority) return undefined;
  const { storeId, incarnation, epoch, attemptId } = version;
  return Object.freeze({ accountId: id, storeId, incarnation, epoch, attemptId, instance: authority.attempt?.instance });
}

export function isCurrentAssociation(token: AssociationFence): boolean {
  if (storageFault) return false;
  const current = captureAssociation(token.accountId);
  return !!current && current.storeId === token.storeId && current.incarnation === token.incarnation &&
    current.epoch === token.epoch && current.attemptId === token.attemptId && current.instance === token.instance;
}

export function reserveAssociation(id: string, scanId?: string): AssociationFence {
  const a = getAccount(id);
  const authority = a?.authority;
  if (!authority) throw Error('storage_or_migration_hold');
  assertProfileAccess(id, a!.userDataDir);
  if (scanId && scanId === authority.attempt?.scanId) return captureAssociation(id)!;
  if (authority.attempt?.scanId) authority.lastScanId = authority.attempt.scanId;
  authority.epoch = nextRevision(authority.epoch);
  authority.attempt = { id: randomUUID(), scanId, kind: 'connect' };
  persist();
  return captureAssociation(id)!;
}

export function bindAssociation(token: AssociationFence, instance: string): AssociationFence {
  if (!isCurrentAssociation(token) || !token.attemptId || (token.instance && token.instance !== instance)) {
    throw Error('navigation:cancelled');
  }
  getAccount(token.accountId)!.authority!.attempt!.instance = instance;
  persist();
  return captureAssociation(token.accountId)!;
}

export function finishAssociation(token: AssociationFence): void {
  if (!isCurrentAssociation(token) || !token.attemptId) return;
  const authority = getAccount(token.accountId)!.authority!;
  if (authority.attempt?.scanId) authority.lastScanId = authority.attempt.scanId;
  delete authority.attempt;
  persist();
}

/** The identity decision and its durable write are ordered against other processes'
 * safety stops. Never acquire the account lock from inside a safety writer. */
function persistIdentityChange(change: () => boolean): boolean {
  if (storageFault || !accountStore || !cache) throw Error('storage_or_migration_hold');
  try {
    return withAccountWriter(() => withSafetyLedgerWriter(safetyFile(), 'exclusive', () => {
      if (!change()) return false;
      commitAccountsToDisk();
      return true;
    }));
  } catch { return failAccountStorage(); }
}

export function commitIdentity(token: AssociationFence, identity: Parameters<typeof setAccountIdentity>[1]): boolean {
  if (!isCurrentAssociation(token) || (token.attemptId && !token.instance)) return false;
  const a = getAccount(token.accountId)!;
  let duplicate = false;
  const committed = persistIdentityChange(() => {
    if (forbiddenIdentityMismatch(a, identity.boundUid)) return false;
    if (identity.boundUid && findAccountByUid(platformKey(a), String(identity.boundUid), a.id)) {
      duplicate = true;
      return false;
    }
    if ((a.manualDisconnect || a.bindingConflict) && (!identity.boundUid || !token.attemptId)) return false;
    commitIdentityArchives(a, identity);
    writeIdentityFields(a, identity);
    return true;
  });
  if (duplicate) markAccountBindingConflict(a.id);
  return committed;
}

function commitIdentityArchives(a: MatrixAccount, identity: Parameters<typeof setAccountIdentity>[1]): void {
  const nextSubject = identity.boundUid ? platformKey(a) + ':' + identity.boundUid : undefined;
  if (nextSubject && accountStore) {
    const authority = a.authority!;
    // Move only constraints with explicit original transaction provenance.
    authority.constraints = authority.constraints.filter(constraint => {
      if (constraint.kind !== 'billing_uncertain' || !constraint.source) return true;
      const record = accountStore!.dispatchRecords[constraint.source];
      if (!record) return true;
      const scope = recordSubjects(record).find(s => s.accountId === a.id || belongsToSubject(a, s));
      if (!scope || scope.subject.startsWith('unresolved:') || scope.subject === nextSubject) return true;
      const archived = (accountStore!.archivedSubjects[scope.subject] ||= []);
      if (!archived.some(p => p.kind === constraint.kind && p.source === constraint.source)) archived.push({ ...constraint });
      return false;
    });
    if (!authority.constraints.some(c => c.kind === 'billing_uncertain')) delete a.chargeUncertain;
    const archives = accountStore.archivedSubjects[nextSubject] || [];
    for (const constraint of archives) {
      if (constraint.kind === 'forbidden') authority.forbiddenSubject ||= nextSubject;
      mergeProtection(authority, constraint);
      if (constraint.kind === 'billing_uncertain' && constraint.source) {
        const record = accountStore.dispatchRecords[constraint.source];
        if (record && record.result === 'charge_uncertain') a.chargeUncertain ||= {
          action: record.action, platform: record.platform, refId: record.refId, at: record.at,
        };
      }
    }
  }
}

export function isFirstBindingRecovery(a: MatrixAccount): boolean {
  return !!a.authority && !a.authority.verified && isUnboundLoginWait({
    ...a, availability: { reasons: a.authority.constraints.map(c => c.kind) },
  });
}

/** Only after a user started QR/refresh and the current document proved login and UID. */
export function commitInteractiveFirstBinding(token: AssociationFence, identity: Parameters<typeof setAccountIdentity>[1]) {
  const a = getAccount(token.accountId);
  if (!a || !isCurrentAssociation(token) || !isFirstBindingRecovery(a) || !identity.boundUid?.trim()) return undefined;
  if (!commitIdentity(token, identity)) return undefined;
  const authority = a.authority!;
  if (authority.constraints.length === 1 && authority.constraints[0].kind === 'technical') {
    const current = selectAvailability(a.id);
    if (current?.reasons.every(kind => kind === 'technical' || kind === 'group_pause')) {
      authority.constraints = authority.constraints.filter(c => c.kind !== 'technical');
      authority.verified = true;
      delete a.recovery;
      const restored = selectAvailability(a.id);
      a.status = restored?.status || 'limited';
      if (restored?.reasons.includes('group_pause')) a.statusReason = '同一出口/代理入口的多个账号受限，暂停该组自动任务';
      else if (restored?.available) delete a.statusReason;
      persist();
    }
  }
  return { loggedIn: true, ...selectAvailability(a.id), version: accountEventVersion(a.id) };
}

/** Clear this specific 403 hold only. The caller must still own the observed page at commit. */
export function clearManuallyReviewedForbidden(token: AssociationFence, revision: string, uid: string,
  assertDocument: () => void, evidence: ForbiddenReviewEvidence) {
  if (!isCurrentAssociation(token) || token.attemptId) throw Error('navigation:cancelled');
  const a = getAccount(token.accountId);
  const authority = a?.authority;
  if (!a || !accountStore || !authority || authority.revision !== revision || authority.cleanup) throw Error('navigation:cancelled');
  const previousSubject = forbiddenIdentitySubject(a);
  if (!previousSubject) throw Error('当前账号没有可复核的 403 限制');
  const subject = platformKey(a) + ':' + uid;
  const neverIdentified = previousSubject === 'unresolved:' + authority.incarnation && !a.boundUid;
  if (!uid || (!neverIdentified && previousSubject !== subject) || (a.boundUid && a.boundUid !== uid)
      || (!a.boundUid && (a.bindingConflict || a.manualDisconnect))) {
    throw Error('请登录原先受 403 限制的账号，当前身份不匹配，限制已保留');
  }
  if (findAccountByUid(platformKey(a), uid, a.id)) throw Error('该身份已绑定其他窗口，已保留 403 限制');
  const archive = accountStore.archivedSubjects;
  const identities = [a.id];
  // Legacy safety uses raw platform keys; two KuaiShou scopes can share one UID.
  if (!listAccounts().some(row => row.id !== a.id && row.platform === a.platform && row.boundUid === uid)) {
    identities.push(a.platform + ':' + uid);
  }
  const belongsToReviewed403 = (c: Protection) => {
    if (c.kind === 'forbidden') return true;
    // A legacy projection of the exact same 403 pause must not re-block the verified account.
    const receipt = c.kind === 'legacy_pause_recheck' && c.source ? accountStore!.importReceipts[c.source] : undefined;
    return !!receipt && identities.some(id => receipt.scope === 'account:' + id) && JSON.parse(receipt.canonical).code === 'forbidden';
  };
  const validated = selectAvailability(a.id);
  if (!validated || validated.reasons.some(kind => ['storage_or_migration_hold', 'profile_cookie_in_flight', 'profile_history_review_required'].includes(kind))) {
    throw Error('账号资料待核验，已保留 403 限制');
  }
  assertDocument();
  try {
    withAccountWriter(() => {
      assertDocument();
      const commitBaseline = automationSafety.captureForbiddenReviewEvidence();
      // The original hold and archive remain durable through both files' writes.
      // If interrupted, restart still sees a hard 403 and requires a new manual proof.
      authority.forbiddenSubject ||= previousSubject;
      mergeProtection(authority, { kind: 'forbidden', source: 'manual_403_review_pending' });
      commitAccountsToDisk();
      const clearance = automationSafety.clearReviewedForbidden(a.id, identities, evidence,
        [a.id, a.platform + ':' + uid], commitBaseline);
      try {
        clearance.holdForAccountCommit(() => {
          for (const constraint of archive[subject] || []) {
            if (!belongsToReviewed403(constraint)) mergeProtection(authority, { ...constraint });
          }
          authority.constraints = authority.constraints.filter(c => !belongsToReviewed403(c));
          for (const key of new Set([subject, previousSubject, ...identities.map(id => 'account:' + id)])) {
            const archived = archive[key];
            if (!archived) continue;
            const remaining = archived.filter(c => !belongsToReviewed403(c));
            if (remaining.length) archive[key] = remaining;
            else delete archive[key];
          }
          if (decodeProtectionReason(a.chargeUncertain?.holdReason) === 'forbidden') delete a.chargeUncertain!.holdReason;
          a.boundUid = uid;
          delete authority.forbiddenSubject;
          if (!a.manualDisconnect && !a.bindingConflict) authority.verified = true;
          const view = selectAvailability(a.id);
          if (!view) throw Error('storage_or_migration_hold');
          a.status = view.status;
          if (view.available) { a.status = 'idle'; delete a.statusReason; }
          else if (view.reasons.includes('manual_disconnect')) a.statusReason = '账号已主动断开，请重新连接后运行';
          else if (view.reasons.includes('binding_conflict')) a.statusReason = '账号绑定冲突，请确认本人身份后重新关联';
          else if (view.reasons.includes('banned')) a.statusReason = '账号封禁，需人工核对';
          else if (view.reasons.includes('billing_uncertain')) a.statusReason = '计费结果不明，请核对账单后恢复';
          else if (view.reasons.includes('account_flag')) a.statusReason = '账号操作受到限制';
          else if (view.reasons.includes('proxy_auth')) a.statusReason = '代理要求认证（HTTP 407）';
          else if (view.reasons.includes('rate_limited')) a.statusReason = '平台限制操作频率，等待冷却后复查';
          else if (view.reasons.includes('group_pause')) a.statusReason = '同一出口/代理入口的多个账号受限，暂停该组自动任务';
          else a.statusReason = '403 复核通过，账号仍有其他限制';
          commitAccountsToDisk();
        });
      } catch (error) {
        try { clearance.rollback(); } catch { failAccountStorage(); /* The durable 403 guard stays in accounts.json. */ }
        throw error;
      }
    });
  } catch (error) {
    // The pending account guard is already on disk. A fresh review can read
    // new evidence in this process. Actual storage failures stay fail-closed.
    if (error instanceof ForbiddenReviewChangedError) throw error;
    failAccountStorage();
  }
  try { _accountSSEBroadcast?.('matrix:account', { id: a.id, status: a.status, statusReason: a.statusReason, ...accountEventVersion(a.id) }); }
  catch { /* A reload will read the committed state. */ }
  return { loggedIn: true, ...selectAvailability(a.id), version: accountEventVersion(a.id) };
}

export function confirmAvailability(token: AssociationFence, loggedIn: boolean | null) {
  if (!isCurrentAssociation(token)) return undefined;
  if (loggedIn === false) setAccountStatus(token.accountId, 'login_required');
  if (loggedIn === true) setAccountStatus(token.accountId, 'idle', '', undefined, token.attemptId ? 'connect' : undefined, token);
  return { loggedIn, ...selectAvailability(token.accountId), version: accountEventVersion(token.accountId) };
}

function ownerExited(owner: NonNullable<NonNullable<MatrixAccount['authority']>['browserOwner']>): boolean {
  if (owner.exited === true) return true;
  if (!owner.pid || !Number.isSafeInteger(owner.pid) || owner.pid <= 0) return false;
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException)?.code === 'ESRCH'; }
}

export function trackProfileProcess(id: string, profile: string, instance: string, pid?: number): void {
  const account = getAccount(id);
  const identity = assertProfileAccess(id, profile, undefined, true);
  const authority = account!.authority!;
  const previous = authority.browserOwner;
  if (previous?.instance === instance) {
    if (previous.exited || (previous.pid !== undefined && previous.pid !== pid)) throw Error('profile_cleanup_unconfirmed');
    if (previous.pid === pid) return;
    authority.browserOwner = { ...previous, pid };
  } else {
    const owners = profileRecords(account!, identity, loadAccounts()).map(row => row.authority?.browserOwner);
    if (owners.some(owner => owner && !ownerExited(owner))) throw Error('profile_cleanup_unconfirmed');
    authority.browserOwner = { instance, pid, profile: identity };
  }
  persist();
}

export function noteProfileProcessExit(id: string, instance: string): void {
  const owner = getAccount(id)?.authority?.browserOwner;
  if (!owner || owner.instance !== instance || owner.exited) return;
  owner.exited = true;
  persist();
}

/** A new Chromium process or an absent in-memory handle is never proof of prior exit. */
export function profilePriorOwnerExited(id: string, profile: string): boolean {
  try {
    const identity = assertProfileAccess(id, profile, undefined, true);
    const account = getAccount(id)!;
    const authority = account.authority!;
    if (Object.values(authority.mutations || {}).some(mutation => !mutation.profile) &&
        authority.browserOwner?.profile?.key !== identity.key) return false;
    const owners = profileRecords(account, identity, loadAccounts()).map(row => row.authority?.browserOwner)
      .filter((owner): owner is NonNullable<typeof owner> => !!owner);
    return owners.length > 0 && owners.every(ownerExited);
  } catch { return false; }
}

export function beginProfileDisconnect(id: string): void {
  const account = getAccount(id);
  const authority = account?.authority;
  if (!authority) throw Error('storage_or_migration_hold');
  authority.cleanup ||= { id: randomUUID(), priorMutations: Object.keys(authority.mutations || {}),
    profile: identifyProfile(account!.userDataDir) };
  mergeProtection(authority, { kind: 'cleanup_pending' });
  markManualDisconnect(id);
}

export type ProfileCleanupProof = Readonly<{
  fence: AssociationFence; profile: string; cleanupId: string;
  clearing: { instance: string; count: 0; exited: true };
  readback: { instance: string; count: 0; exited: true };
}>;

export function commitProfileCleanup(proof: ProfileCleanupProof): boolean {
  if (!isCurrentAssociation(proof.fence)) return false;
  const account = getAccount(proof.fence.accountId);
  const authority = account?.authority;
  if (!authority || !authority.cleanup || account!.userDataDir !== proof.profile
      || authority.cleanup.id !== proof.cleanupId || proof.clearing.instance === proof.readback.instance
      || proof.clearing.count !== 0 || proof.readback.count !== 0 || !proof.clearing.exited || !proof.readback.exited) return false;
  const { authenticProfileCleanupProof } = require('./kernelPool') as typeof import('./kernelPool');
  if (!authenticProfileCleanupProof(proof)) return false;
  delete authority.cleanup;
  delete authority.mutations;
  authority.constraints = authority.constraints.filter(item => item.kind !== 'cleanup_pending');
  persist();
  return true;
}

export function recordCookieMutation(id: string, instance: string, connection: string, cleanup = false, fence?: AssociationFence, requiresConnect = false) {
  const authority = getAccount(id)?.authority;
  if (!authority) return undefined;
  if (!fence || !isCurrentAssociation(fence)) throw Error('navigation:cancelled');
  const profile = assertProfileAccess(id, getAccount(id)!.userDataDir, undefined, cleanup);
  if (cleanup !== !!authority.cleanup || (!cleanup && authority.attempt && authority.attempt.instance !== instance)
      || (requiresConnect && (!authority.attempt || authority.attempt.kind !== 'connect'))) {
    throw Error('profile_cleanup_unconfirmed');
  }
  const mutationId = randomUUID();
  (authority.mutations ||= {})[mutationId] = { state: 'dispatched', instance, epoch: authority.epoch, connection, profile };
  persist();
  return Object.freeze({ mutationId, accountId: id, incarnation: authority.incarnation });
}

export function settleCookieMutation(receipt: NonNullable<ReturnType<typeof recordCookieMutation>>, state: 'completed'|'unknown'): void {
  const authority = getAccount(receipt.accountId)?.authority;
  const mutation = authority?.mutations?.[receipt.mutationId];
  if (!authority || authority.incarnation !== receipt.incarnation || !mutation) return;
  if (state === 'completed' && mutation.profile &&
      identifyProfile(getAccount(receipt.accountId)!.userDataDir)?.key === mutation.profile.key) {
    delete authority.mutations![receipt.mutationId];
  }
  else {
    mutation.state = 'unknown';
    authority.cleanup ||= { id: randomUUID(), priorMutations: Object.keys(authority.mutations || {}), profile: mutation.profile };
    mergeProtection(authority, { kind: 'cleanup_pending' });
  }
  persist();
}

export type ObservationReceipt = Readonly<{
  id: string; accountId: string; incarnation: string; subject: string; epoch: string;
  profile: string; instance: string; connection: string; generation: number;
}>;

function accountSubject(a: MatrixAccount): string {
  return a.boundUid ? platformKey(a) + ':' + a.boundUid : 'unresolved:' + a.authority!.incarnation;
}

function pinForbiddenSubject(a: MatrixAccount): boolean {
  if (!a.authority || a.authority.forbiddenSubject || !a.authority.constraints.some(c => c.kind === 'forbidden')) return false;
  a.authority.forbiddenSubject = accountSubject(a);
  return true;
}

/** A peer may have committed a hard 403 and exited before writing accounts.json. */
export function forbiddenIdentitySubject(a: MatrixAccount): string | undefined {
  if (!a.authority) return undefined;
  if (a.authority.constraints.some(c => c.kind === 'forbidden')
      || currentSafety(a, Date.now()).accountPauses.some(pause => pause.code === 'forbidden')) {
    return a.authority.forbiddenSubject || accountSubject(a);
  }
  return undefined;
}

export function forbiddenIdentityMismatch(a: MatrixAccount, uid?: string): boolean {
  if (!uid) return false;
  const subject = forbiddenIdentitySubject(a);
  return !!subject && subject !== platformKey(a) + ':' + uid;
}

export function observeRoot(id: string, instance: string, connection: string, generation: number): ObservationReceipt | undefined {
  const a = getAccount(id);
  if (!a?.authority) return undefined;
  return Object.freeze({ id: randomUUID(), accountId: id, incarnation: a.authority.incarnation,
    subject: accountSubject(a), epoch: a.authority.epoch, profile: a.userDataDir, instance, connection, generation });
}

export function recordRootProtection(observation: ObservationReceipt, code: 'forbidden' | 'rate_limited', until?: number): void {
  if (!accountStore || storageFault) throw Error('storage_or_migration_hold');
  const a = getAccount(observation.accountId);
  const constraint: Protection = { kind: code, until };
  if (a?.authority?.incarnation === observation.incarnation && a.userDataDir === observation.profile &&
      (accountSubject(a) === observation.subject || observation.subject.startsWith('unresolved:'))) {
    mergeProtection(a.authority, constraint);
    const now = Date.now();
    const safety = currentSafety(a, now);
    const view = availabilityOf(a, now, safety.groupUntil, false, false, false, safety.accountPauses);
    a.status = view.status;
    if (code === 'rate_limited' && until !== undefined &&
        (a.recovery?.reason !== 'rate_limited' || a.recovery.nextCheckAt < until)) {
      a.recovery = { attempts: 0, nextCheckAt: until, reason: 'rate_limited' };
    }
    if (!a.manualDisconnect && !a.bindingConflict && a.status !== 'banned' && !a.chargeUncertain) {
      if (code === 'forbidden') a.statusReason = '平台拒绝访问（HTTP 403）';
      else if (!a.authority.constraints.some(item => item.kind === 'forbidden')) a.statusReason = '平台限制操作频率，等待冷却后复查';
    }
  } else {
    const archive = (accountStore.archivedSubjects[observation.subject] ||= []);
    if (!archive.some(item => item.source === observation.id)) archive.push({ ...constraint, source: observation.id });
  }
  persist();
}

export function registerDispatch(id: string, kind: DispatchRecord['kind'], detail: Pick<DispatchRecord,'action'|'platform'|'refId'|'at'|'instance'|'connection'|'generation'|'ledgerKey'|'ledgerId'>): DispatchRecord {
  const a=getAccount(id);
  if(!a?.authority||!selectAvailability(id)?.available||!accountStore)throw Error('storage_or_migration_hold');
  const receipt: DispatchRecord={...detail,kind,id:randomUUID(),accountId:id,incarnation:a.authority.incarnation,epoch:a.authority.epoch,
    subject:accountSubject(a), profile:a.userDataDir};
  accountStore.dispatchRecords[receipt.id]=receipt;
  persist();
  return Object.freeze({...receipt});
}

export function getDispatchedReceipt(id: string): DispatchRecord | undefined {
  loadAccounts();
  const record = accountStore?.dispatchRecords[id];
  return record && Object.freeze({ ...record });
}

export function captureDispatchSubject(id: string, observed?: Pick<DispatchSubject, 'instance' | 'connection' | 'generation'>): DispatchSubject | undefined {
  const account = getAccount(id);
  const authority = account?.authority;
  if (!account || !authority) return undefined;
  return Object.freeze({ ...observed, accountId: id, incarnation: authority.incarnation,
    epoch: authority.epoch, subject: accountSubject(account), profile: account.userDataDir });
}

type PublishRequest = {
  platform: string; taskId?: string; billingRequested: boolean; requestHash: string; inputs: ReadonlyMap<string, unknown>;
  execution: Readonly<{kernelPath?: string; headless: boolean; concurrency: number; jitterMinMs: number; jitterMaxMs: number}>;
};

type PublishExecutionOptions = {
  kernelPath?: string; headless?: boolean; concurrency?: number; jitterMinMs?: number; jitterMaxMs?: number;
};

export function bindPublishRequest(platform: string, taskId: string | undefined, ids: string[], billingRequested: boolean,
  getInput: (id: string, index: number) => unknown, execution?: PublishExecutionOptions): PublishRequest {
  if (typeof platform !== 'string' || !/^[a-z0-9_]{1,32}$/.test(platform) ||
      (taskId !== undefined && (typeof taskId !== 'string' || taskId.length > 256)) ||
      !Array.isArray(ids) || !ids.length || ids.length > 100 ||
      ids.some(id => typeof id !== 'string' || !id || id.length > 256) || new Set(ids).size !== ids.length) {
    throw Error('matrix_publish_request_invalid');
  }
  let nodes = 0;
  const normalize = (value: unknown, depth = 0): unknown => {
    if (++nodes > 20000 || depth > 16) throw Error('matrix_publish_request_invalid');
    if (value === null || typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value))) return value;
    if (typeof value === 'string' && value.length <= 256000) return value;
    if (Array.isArray(value)) return value.map(item => normalize(item, depth + 1));
    if (!value || Object.prototype.toString.call(value) !== '[object Object]') throw Error('matrix_publish_request_invalid');
    return Object.fromEntries(Object.keys(value).sort().map(key => [
      key, normalize((value as Record<string, unknown>)[key], depth + 1),
    ]));
  };
  const inputs = new Map(ids.map((id, index) => [id, normalize(getInput(id, index) ?? null)]));
  const { kernelPath, headless, concurrency, jitterMinMs, jitterMaxMs } = execution ?? {};
  const validInteger = (value: unknown) => value === undefined ||
    (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0);
  if ((kernelPath !== undefined && (typeof kernelPath !== 'string' || !kernelPath.trim() || kernelPath.length > 32767 || kernelPath.includes('\0'))) ||
      (headless !== undefined && typeof headless !== 'boolean') ||
      ![concurrency, jitterMinMs, jitterMaxMs].every(validInteger) ||
      (jitterMinMs ?? 3000) > (jitterMaxMs ?? 15000) || (jitterMaxMs ?? 15000) > 2_147_483_647) {
    throw Error('matrix_publish_execution_invalid');
  }
  const launch = Object.freeze({ kernelPath, headless: headless ?? false,
    concurrency: Math.max(1, Math.min(concurrency ?? 3, 10)), jitterMinMs: jitterMinMs ?? 3000, jitterMaxMs: jitterMaxMs ?? 15000 });
  // Preserve the v1 digest for valid requests and drive execution with these same values.
  const canonical = JSON.stringify([platform, taskId ?? null, billingRequested, [...inputs],
    [launch.kernelPath ?? null, launch.headless, launch.concurrency, launch.jitterMinMs, launch.jitterMaxMs]]);
  if (canonical.length > 2000000) throw Error('matrix_publish_request_invalid');
  return { platform, taskId, billingRequested, inputs, requestHash: sha256(canonical), execution: launch };
}

export function beginMatrixPublishOperation(request: PublishRequest, requested: string | undefined,
  mode: 'prepare' | 'start' | 'recover', beforeStart?: () => void) {
  if (requested === undefined && mode !== 'prepare') throw Error('matrix_operation_id_required');
  if (requested !== undefined && !/^[0-9a-z-]{8,80}$/i.test(requested)) throw Error('matrix_operation_invalid');
  const id = requested ?? randomUUID();
  loadAccounts();
  return withAccountWriter(() => {
    const bytes = fs.readFileSync(storeFile(), 'utf8');
    if (bytes !== durableAccounts) {
      accountStore = openAccountEnvelope(JSON.parse(bytes));
      cache = accountStore.accounts;
      durableAccounts = bytes;
    }
    const store = accountStore!;
    const runs = (store.publishRuns ||= {});
    const existing = Object.hasOwn(runs, id) ? runs[id] : undefined;
    if (existing && !existing.requestHash) throw Error('matrix_legacy_operation_unverifiable');
    if (existing && (existing.requestHash !== request.requestHash || existing.platform !== request.platform ||
        existing.taskId !== request.taskId)) throw Error('matrix_operation_mismatch');
    if (!existing && mode === 'recover') throw Error('matrix_operation_not_found');

    const principals = [...request.inputs.keys()].map(accountId => {
      const row = store.accounts.find(account => account.id === accountId);
      if (!row?.authority || row.platform !== request.platform) throw Error(existing ? 'matrix_operation_subject_changed' : 'matrix_publish_account_invalid');
      return { accountId, incarnation: row.authority.incarnation, subject: accountSubject(row) };
    });
    if (existing && JSON.stringify(existing.principals) !== JSON.stringify(principals)) {
      throw Error('matrix_operation_subject_changed');
    }
    if (existing && (mode === 'prepare' || existing.phase === 'started')) return { operation: existing, started: false };
    if (mode !== 'prepare') beforeStart?.();
    const operation: MatrixPublishOperation = {
      id, platform: request.platform, taskId: request.taskId, startedAt: Date.now(),
      billingRequested: request.billingRequested, requestHash: request.requestHash, principals,
      phase: mode === 'prepare' ? 'prepared' : 'started',
    };
    runs[id] = operation;
    try { commitAccountsToDisk(); }
    catch {
      storageFault = true;
      accountStore = openAccountEnvelope(JSON.parse(bytes));
      cache = accountStore.accounts;
      throw Error('storage_or_migration_hold');
    }
    return { operation, started: mode !== 'prepare' };
  });
}

/** Durable receipts let a returning caller reconcile the preparation without guessing an operation ID. */
export function listPublishRuns() {
  if (storageFault) throw Error('storage_or_migration_hold');
  const snapshot = readAccountSnapshot();
  if (!snapshot) return [];
  const bills = new Map(Object.values(snapshot.dispatchRecords).map(record => [record.operationId, record]));
  return Object.values(snapshot.publishRuns || {}).sort((a, b) => b.startedAt - a.startedAt).map(run => ({
    runOperationId: run.id, platform: run.platform, taskId: run.taskId, startedAt: run.startedAt,
    status: !run.requestHash ? 'legacy_unverifiable' : run.outcome ? 'finished' : run.phase,
    billingResult: bills.get('run:' + run.id)?.result ??
      (!bills.has('run:' + run.id) && run.outcome?.billingEligible && run.outcome.subjects.length ? 'first_debit_requires_review' : undefined),
  }));
}

export function saveMatrixPublishOutcome(operationId: string, outcome: MatrixPublishOutcome): void {
  loadAccounts();
  const run = accountStore?.publishRuns?.[operationId];
  if (run?.phase !== 'started' || (run.outcome && JSON.stringify(run.outcome) !== JSON.stringify(outcome))) throw Error('matrix_operation_mismatch');
  if (run.outcome) return;
  run.outcome = JSON.parse(JSON.stringify(outcome));
  persist();
}

export function getAggregateChargeForRecovery(runId: string, platform: string): DispatchRecord | undefined {
  const row = Object.values(readAccountSnapshot()?.dispatchRecords || {}).find(record =>
    record.kind === 'billing' && record.operationId === 'run:' + runId && record.platform === platform);
  return row && Object.freeze({ ...row });
}

export function registerAggregateCharge(platform: string, subjects: readonly DispatchSubject[], runId?: string):
  { receipt: DispatchRecord; dispatch: boolean } {
  loadAccounts();
  if (!accountStore || !subjects.length || storageFault || subjects.some(s => !s.subject || !s.incarnation)) {
    throw Error('storage_or_migration_hold');
  }
  const signature = (rows: readonly DispatchSubject[]) => rows.map(row => JSON.stringify([
    row.accountId, row.incarnation, row.epoch, row.subject, row.profile, row.instance, row.connection, row.generation,
  ])).sort().join('\n');
  const original = signature(subjects);
  const operationId = runId ? 'run:' + runId : 'legacy:' + sha256(platform + '\n' + original);
  return withAccountWriter(() => {
    const current = fs.readFileSync(storeFile(), 'utf8');
    if (current !== durableAccounts) {
      accountStore = openAccountEnvelope(JSON.parse(current));
      cache = accountStore.accounts;
      durableAccounts = current;
    }
    const store = accountStore!;
    if (runId) {
      const run = Object.prototype.hasOwnProperty.call(store.publishRuns || {}, runId) ? store.publishRuns![runId] : undefined;
      if (!run?.outcome || run.platform !== platform || signature(run.outcome.subjects) !== original) {
        throw Error('matrix_operation_mismatch');
      }
    }
    const prior = Object.values(store.dispatchRecords).find(row => row.kind === 'billing' && row.operationId === operationId);
    if (prior) {
      if (prior.platform !== platform || signature(prior.subjects || []) !== original) throw Error('matrix_operation_mismatch');
      return { receipt: Object.freeze({ ...prior }), dispatch: false };
    }
    const record: DispatchRecord = { ...subjects[0], id: randomUUID(), kind: 'billing', action: 'publish_aggregate',
      operationId, platform, at: Date.now(), chargeCount: subjects.length, subjects: subjects.map(subject => ({...subject})) };
    record.refId = record.id;
    store.dispatchRecords[record.id] = record;
    try { commitAccountsToDisk(); }
    catch {
      delete store.dispatchRecords[record.id];
      storageFault = true;
      throw Error('storage_or_migration_hold');
    }
    return { receipt: Object.freeze({ ...record }), dispatch: true };
  });
}

function recordSubjects(record: DispatchRecord): readonly (DispatchSubject | DispatchRecord)[] {
  return record.subjects || [record];
}

function belongsToSubject(account: MatrixAccount, subject: DispatchSubject | DispatchRecord): boolean {
  if (!account.authority) return false;
  if (subject.subject.startsWith('unresolved:')) {
    return account.authority.incarnation === subject.incarnation && account.userDataDir === subject.profile;
  }
  return accountSubject(account) === subject.subject;
}

function applyUncertainCharge(store: StoreEnvelope, record: DispatchRecord): void {
  const protection: Protection = { kind: 'billing_uncertain', source: record.id };
  for (const subject of recordSubjects(record)) {
    const account = store.accounts.find(item => belongsToSubject(item, subject));
    if (!account?.authority) {
      const archived = (store.archivedSubjects[subject.subject] ||= []);
      if (!archived.some(c => c.kind === protection.kind && c.source === protection.source)) archived.push({ ...protection });
      continue;
    }
    mergeProtection(account.authority, { ...protection });
    account.chargeUncertain ||= { action: record.action, platform: record.platform, refId: record.refId, at: record.at };
    if (!account.manualDisconnect && !account.bindingConflict && account.status !== 'banned') {
      account.status = 'limited';
      account.statusReason ||= '计费结果不明，请核对账单后恢复';
    }
  }
}

export function archiveDispatchedResult(receipt: DispatchRecord, result: NonNullable<DispatchRecord['result']>,
  charged?: { charged: number; balanceAfter?: number }): void {
  if (!accountStore) loadAccounts();
  const record = accountStore?.dispatchRecords[receipt.id];
  if (!record || record.incarnation !== receipt.incarnation || record.subject !== receipt.subject) throw Error('storage_or_migration_hold');
  if (record.result === result || (record.kind === 'comment' && record.result === 'confirmed' && result === 'comment_pending')) return;
  if (record.result && !(record.kind === 'comment' && record.result === 'comment_pending' && result === 'confirmed')) {
    throw Error('dispatch_result_conflict');
  }
  record.result = result;
  if (result === 'confirmed' && charged) {
    record.charged = charged.charged;
    record.balanceAfter = charged.balanceAfter;
  }
  if (result === 'charge_uncertain') applyUncertainCharge(accountStore!, record);
  persist();
  try { _accountSSEBroadcast?.('matrix:dispatch', { dispatchId: record.id, kind: record.kind, result }); } catch { /* reload can recover it */ }
}

export function commentDispatches(ledgerKeys: ReadonlySet<string>, readOnly = false): DispatchRecord[] {
  let records: StoreEnvelope['dispatchRecords'] | undefined;
  if (readOnly) {
    records = readAccountSnapshot()?.dispatchRecords;
  } else {
    loadAccounts();
    records = accountStore?.dispatchRecords;
  }
  return Object.values(records || {}).filter(r => r.kind === 'comment' && !!r.ledgerKey && ledgerKeys.has(r.ledgerKey));
}

export function canConfirmComment(dispatchId: string, id: string): boolean {
  const record = getDispatchedReceipt(dispatchId);
  const current = getAccount(id);
  return !!record && record.kind === 'comment' && !!current && belongsToSubject(current, record);
}

export function billingTransactions(accountId: string) {
  const account = getAccount(accountId);
  if (!account) return [];
  return Object.values(accountStore?.dispatchRecords || {}).filter(r => r.kind === 'billing' && r.result === 'charge_uncertain'
    && recordSubjects(r).some(s => s.accountId === accountId || belongsToSubject(account, s)))
    .map(r => ({ dispatchId: r.id, action: r.action, platform: r.platform, at: r.at, count: r.chargeCount }));
}

export function acknowledgeBillingTransaction(dispatchId: string, accountId: string): boolean {
  const account = getAccount(accountId);
  const record = accountStore?.dispatchRecords[dispatchId];
  if (!account || !record || record.kind !== 'billing' ||
      !recordSubjects(record).some(s => s.accountId === accountId || belongsToSubject(account, s))) return false;
  if (record.result === 'acknowledged') return true;
  if (record.result !== 'charge_uncertain') return false;
  record.result = 'acknowledged';
  for (const archived of Object.values(accountStore!.archivedSubjects)) {
    for (let i = archived.length - 1; i >= 0; i--) {
      if (archived[i].kind === 'billing_uncertain' && archived[i].source === dispatchId) archived.splice(i, 1);
    }
  }
  for (const row of accountStore!.accounts) {
    const authority = row.authority!;
    if (!authority.constraints.some(c => c.kind === 'billing_uncertain' && c.source === dispatchId)) continue;
    authority.constraints = authority.constraints.filter(c => c.kind !== 'billing_uncertain' || c.source !== dispatchId);
    const remaining = authority.constraints.find(c => c.kind === 'billing_uncertain');
    if (remaining) {
      const next = remaining.source && accountStore!.dispatchRecords[remaining.source];
      if (next) row.chargeUncertain = { action: next.action, platform: next.platform, refId: next.refId, at: next.at };
      continue;
    }
    const oldReason = decodeProtectionReason(row.chargeUncertain?.holdReason);
    if (oldReason) mergeProtection(authority, { kind: oldReason });
    delete row.chargeUncertain;
    if (!row.manualDisconnect && !authority.constraints.some(c => c.kind === 'forbidden' || c.kind === 'banned')) {
      const now = Date.now();
      mergeProtection(authority, { kind: 'technical', until: now });
      if (!row.recovery || row.recovery.reason !== 'rate_limited') {
        row.recovery = { attempts: 0, nextCheckAt: now, reason: '计费已人工核对，等待登录复查' };
      }
    }
  }
  persist();
  return true;
}

export function listAccounts(): MatrixAccount[] {
  return [...loadAccounts()];
}
export function getAccount(id: string): MatrixAccount | undefined {
  return loadAccounts().find((a) => a.id === id);
}
export function accountsByPlatform(platform: string): MatrixAccount[] {
  return loadAccounts().filter((a) => a.platform === platform);
}
/** 登录态/身份读取用的平台 key:快手创作端账号用 'kuaishou_creator'(独立登录态 + cp 接口读身份),
 *  其它(含快手主站)就是 platform 本身。用于 LOGIN_COOKIES / IDENTITY_EXPR 等按场景查表。 */
export function platformKey(acc: Pick<MatrixAccount, 'platform' | 'loginScope'>): string {
  return acc.platform === 'kuaishou' && acc.loginScope === 'creator' ? 'kuaishou_creator' : acc.platform;
}
export function accountsByGroup(group: string): MatrixAccount[] {
  return loadAccounts().filter((a) => a.group === group);
}

/** 新建一个号:生成固定指纹种子 + 持久 profile 目录。代理后续单独绑定。 */
export function createAccount(args: {
  platform: string;
  displayName: string;
  group?: string;
  fingerprint?: Partial<Fingerprint>;
  fingerprintLocale?: FingerprintLocaleInput | FingerprintLocalePatch;
  exitObservation?: ProxyExitObservation;
  proxy?: Proxy;
  keywords?: string[];
  track?: string;
  persona?: string;
  contentLang?: 'zh' | 'en';          // 内容语言(赛道/人设/关键词的语言),默认由客户端按界面语言给
  kernelVersion?: string;
  loginScope?: 'main' | 'creator';   // 仅快手:主站 / 创作者中心
}): MatrixAccount {
  const defaults = validateFingerprintLocaleInput({ lang: args.fingerprint?.lang, timezone: args.fingerprint?.timezone });
  const input = args.fingerprintLocale;
  const requested = input && typeof input === 'object' && Object.prototype.hasOwnProperty.call(input, 'mode')
    ? validateFingerprintLocalePatch(input)
    : validateFingerprintLocaleInput(input);
  const proxy = args.proxy ? { ...args.proxy } : undefined;
  if (proxy) {
    clearProxyExitObservation(proxy);
    if (args.exitObservation) applyProxyExitObservation(proxy, args.exitObservation);
  }
  const locale = resolveFingerprintLocale({
    region: requested?.region, lang: requested?.lang ?? defaults?.lang, timezone: requested?.timezone ?? defaults?.timezone,
  }, proxyExitLocale(proxy), args.contentLang);
  ensureDirs();
  const accounts = loadAccounts();
  const id = `${args.platform}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
  const seed = args.fingerprint?.seed ?? Math.floor(Math.random() * 0xffffffff);
  const account: MatrixAccount = {
    id,
    platform: args.platform,
    displayName: args.displayName,
    group: args.group,
    persona: args.persona,
    status: 'login_required',           // 新号默认需扫码登录
    userDataDir: path.join(profilesDir(), id),
    fingerprint: {
      seed,
      platformOs: args.fingerprint?.platformOs ?? 'windows',
      brand: args.fingerprint?.brand ?? 'Chrome',
      hardwareConcurrency: args.fingerprint?.hardwareConcurrency ?? 8,
      ...locale,
    },
    proxy,
    keywords: Array.isArray(args.keywords) ? args.keywords.filter(Boolean) : [],
    track: args.track || `${args.platform}_default`,
    contentLang: args.contentLang === 'en' ? 'en' : 'zh',
    kernelVersion: args.kernelVersion || undefined,
    loginScope: args.platform === 'kuaishou' ? (args.loginScope || 'main') : undefined,
  };
  accounts.push(account);
  cache = accounts;
  persist();
  return account;
}

export function upsertAccount(account: MatrixAccount): void {
  const accounts = loadAccounts();
  const i = accounts.findIndex((a) => a.id === account.id);
  if (i >= 0) accounts[i] = account; else accounts.push(account);
  cache = accounts;
  persist();
}

// SSE 广播注入(sidecar 启动时 setAccountSSEBroadcast(broadcastSSE),动态 import 避免循环依赖)。
// setAccountStatus 变更后广播 'matrix:account' → 渲染层 onAccount 触发 reload,「我的矩阵账号」卡片实时刷新。
// 之前只 persist() 落盘:任务里标 login_required 后,开着的账号页看不到、须重开页才刷新(用户实测币安发帖过期卡片不变红)。
let _accountSSEBroadcast: ((event: string, data: unknown) => void) | null = null;
export function setAccountSSEBroadcast(fn: (event: string, data: unknown) => void): void {
  _accountSSEBroadcast = fn;
}

export function setAccountStatus(id: string, status: AccountStatus, reason?: string, recovery?: MatrixAccount['recovery'], intent?: 'connect', proof?: AssociationFence): void {
  const a = getAccount(id);
  if (!a) return;
  const availability = status === 'idle' || status === 'running';
  const activeCooldown = a.recovery?.reason === 'rate_limited' && a.recovery.nextCheckAt > Date.now();
  const hardRefusal = a.authority?.constraints.some(c=>c.kind==='forbidden'||c.kind==='banned'||c.kind==='account_flag') ||
    ((a.status === 'limited' || a.manualDisconnect)
    && ['HTTP 403','HTTP 403:平台拒绝访问','平台拒绝访问（HTTP 403）','平台拒绝访问','forbidden','页面需要人工检查：forbidden','账号封禁，需人工核对']
      .includes(a.statusReason || ''));
  if (a.authority && status === 'limited' && reason === '同一出口/代理入口的多个账号受限，暂停该组自动任务') return;
  if (a.manualDisconnect && (status === 'limited' || availability) && !(status === 'idle' && intent === 'connect')) return;
  if ((availability || status === 'login_required') && !a.bindingConflict && (a.status === 'banned' || hardRefusal)) return;
  if (hardRefusal && status === 'limited' && reason === '同一出口/代理入口的多个账号受限，暂停该组自动任务') return;
  if ((availability || status === 'login_required') && activeCooldown && !a.bindingConflict && !a.chargeUncertain) return;
  if (a.manualDisconnect && status === 'login_required' && !a.bindingConflict) return;
  if (a.authority) {
    const authority=a.authority;
    const classified=decodeProtectionReason(reason);
    if(status==='banned')mergeProtection(authority,{kind:'banned'});
    if(classified)mergeProtection(authority,{kind:classified,until:recovery?.nextCheckAt});
    if(recovery)mergeProtection(authority,{kind:recovery.reason==='rate_limited'?'rate_limited':'technical',until:recovery.nextCheckAt});
    if(status==='login_required')authority.verified=false;
    if(status==='idle' && reason==='' && proof && isCurrentAssociation(proof)){
      authority.verified=!!a.boundUid;
      const clearable=['rate_limited','legacy_pause_recheck','technical','login_wall','captcha'];
      authority.constraints=authority.constraints.filter(c=>!(clearable.includes(c.kind)&&(c.until||0)<=Date.now())
        &&!(c.kind==='manual_disconnect'&&intent==='connect'&&a.boundUid)
        &&!(c.kind==='binding_conflict'&&!a.bindingConflict&&intent==='connect'&&a.boundUid));
      if(authority.constraints.some(c=>c.kind==='manual_disconnect'))return;
    }
    if (status === 'idle' || status === 'running') {
      if (authority.constraints.length) status = a.manualDisconnect || a.bindingConflict ? 'login_required' : 'limited';
      else if (!authority.verified) status = 'login_required';
    }
  }
  // Runner cleanup is not a new login confirmation. Explicit verification may clear a pause with reason=''.
  if (a.status === 'limited' && status === 'idle' && reason === undefined) return;
  if (a.chargeUncertain && (status === 'idle' || status === 'running')) {
    status = 'limited'; reason = '计费结果不明，请核对账单后恢复';
  }
  if (a.bindingConflict && (status === 'idle' || status === 'running')) status = 'login_required';
  if (a.bindingConflict) reason = '账号绑定冲突，请确认本人身份后重新关联';
  if (a.chargeUncertain && status === 'limited' && reason && reason !== '计费结果不明，请核对账单后恢复') {
    if (!reason.startsWith('network_changed:') || !a.chargeUncertain.holdReason) a.chargeUncertain.holdReason = reason;
  }
  const previous = a.status;
  const changed = a.status !== status || a.statusReason !== reason;
  a.status = status;
  if (status === 'limited' && recovery) a.recovery = recovery;
  else if (status !== 'running' && !(activeCooldown && (a.bindingConflict || a.chargeUncertain))) delete a.recovery;
  if (reason) a.statusReason = reason; else delete a.statusReason;
  // 重新连上(翻 idle)即清「主动断开」标记 —— 所有连接成功路径(扫码/导入/刷新/保活自愈)都经这里,单点收口。
  if (status === 'idle' && intent === 'connect' && a.manualDisconnect && (!a.authority || (proof && isCurrentAssociation(proof)))) delete a.manualDisconnect;
  persist();
  // 状态真变了才广播(避免 running→running 之类空转刷屏);payload 带 id/status,渲染层收到即整表 reload。
  if (changed) {
    coworkLog('INFO', 'matrix-account', `[${diagnosticAccountAlias(id)}] ${previous} -> ${status}`, { hasReason: !!reason });
    try { _accountSSEBroadcast?.('matrix:account', { id, status, statusReason: reason, ...accountEventVersion(id) }); } catch { /* 广播失败不影响落盘 */ }
  }
}

/** Technical failures get a bounded probe schedule. Never replace an existing manual safety hold. */
export function markAccountRecovery(id: string, reason: string): void {
  const a = getAccount(id);
  if (!a || a.bindingConflict || a.manualDisconnect || a.chargeUncertain || a.status === 'banned'
    || (a.status === 'limited' && !a.recovery)
    || (a.recovery?.reason === 'rate_limited' && a.recovery.nextCheckAt > Date.now())) return;
  const attempts = Math.min(4, (a.recovery?.attempts || 0) + 1);
  const recovery = { attempts, nextCheckAt: Date.now() + recoveryDelay(attempts), reason };
  setAccountStatus(id, 'limited', `等待自动复查：${reason}`, recovery);
  try { _accountSSEBroadcast?.('matrix:account', { id, recovery }); } catch { /* non-fatal */ }
}

/** Rate-limit expiry permits a read-only recheck, not an automatic retry of the rejected action. */
export function markAccountCooldown(id: string, until: number): void {
  const a = getAccount(id);
  if (a?.authority && Number.isFinite(until)) {
    const nextCheckAt = Math.max(a.recovery?.reason === 'rate_limited' ? a.recovery.nextCheckAt : 0, until, Date.now() + 60_000);
    mergeProtection(a.authority, { kind: 'rate_limited', until: nextCheckAt });
    a.recovery = { attempts: 0, nextCheckAt, reason: 'rate_limited' };
    a.status = availabilityOf(a, Date.now()).status;
    if (!a.manualDisconnect && !a.bindingConflict && !a.chargeUncertain &&
        !a.authority.constraints.some(c => ['forbidden', 'banned', 'account_flag'].includes(c.kind))) {
      a.statusReason = '平台限制操作频率，等待冷却后复查';
    }
    persist();
    try { _accountSSEBroadcast?.('matrix:account', { id, status: a.status, recovery: a.recovery, ...accountEventVersion(id) }); } catch { /* non-fatal */ }
    return;
  }
  const groupOnly = /^(?:同一出口\/代理入口的多个账号受限，暂停该组自动任务|🛑 同组多个账号受限，停止自动操作，请检查平台提示。|自动操作已暂停：同一出口\/代理入口的多个账号受限，暂停该组自动任务，最早恢复时间 [^；]+)$/.test(a?.statusReason || '');
  if (!a || !Number.isFinite(until) || a.bindingConflict || a.manualDisconnect || a.chargeUncertain
    || a.status === 'banned' || (a.status === 'limited' && !a.recovery && !groupOnly)) return;
  const previousUntil = a.recovery?.reason === 'rate_limited' ? a.recovery.nextCheckAt : 0;
  const nextCheckAt = Math.max(previousUntil, until, Date.now() + 60_000);
  if (a.status === 'limited' && nextCheckAt === previousUntil) return;
  setAccountStatus(id, 'limited', '平台限制操作频率，等待冷却后复查', { attempts: 0, nextCheckAt, reason: 'rate_limited' });
  try { _accountSSEBroadcast?.('matrix:account', { id, recovery: a.recovery }); } catch { /* non-fatal */ }
}

export function markAccountChargeUncertain(id: string, detail: NonNullable<MatrixAccount['chargeUncertain']>): void {
  const a = getAccount(id);
  if (!a) return;
  // Preserve the first unresolved transaction, including across restart or manual login.
  if (!a.chargeUncertain) a.chargeUncertain = { ...detail,
    holdReason: a.status === 'limited' && !a.recovery ? (a.statusReason || '请人工检查账号状态') : undefined };
  if(a.authority)mergeProtection(a.authority,{kind:'billing_uncertain',source:detail.refId});
  // A late charge result must survive an explicit disconnect without changing its visible status.
  if (a.manualDisconnect) { persist(); return; }
  setAccountStatus(id, 'limited', '计费结果不明，请核对账单后恢复');
}

/** Called only by an explicit user acknowledgement after checking the bill; never resends a charge. */
export function resolveAccountChargeUncertain(id: string): void {
  const a = getAccount(id);
  if (!a?.chargeUncertain) return;
  const holdReason = a.chargeUncertain.holdReason;
  if(a.authority){
    const matching=Object.values(accountStore?.dispatchRecords||{}).filter(row=>row.accountId===id&&row.incarnation===a.authority?.incarnation
      &&row.result==='charge_uncertain'&&row.refId===a.chargeUncertain?.refId);
    if(matching.length>1)throw Error('billing_receipt_required');
    if(matching[0])matching[0].result='acknowledged';
    a.authority.constraints=a.authority.constraints.filter(c=>c.kind!=='billing_uncertain'||(c.source!==a.chargeUncertain?.refId&&c.source!==matching[0]?.id));
  }
  delete a.chargeUncertain;
  if(holdReason && ['平台拒绝访问（HTTP 403）','平台拒绝访问','HTTP 403','HTTP 403:平台拒绝访问','页面需要人工检查：forbidden'].includes(holdReason)) a.statusReason=holdReason;
  coworkLog('INFO', 'matrix-account', `[${diagnosticAccountAlias(id)}] user acknowledged uncertain billing`);
  if (a.manualDisconnect) { persist(); return; }
  if (holdReason) { setAccountStatus(id, 'limited', holdReason); return; }
  if (a.recovery?.reason === 'rate_limited' && a.recovery.nextCheckAt > Date.now()) {
    setAccountStatus(id, 'limited', '平台限制操作频率，等待冷却后复查', a.recovery);
    return;
  }
  // Still require a fresh login/page check before future actions.
  a.recovery = { attempts: 0, nextCheckAt: Date.now(), reason: '计费已人工核对，等待登录复查' };
  if (a.authority) {
    a.authority.verified = false;
    mergeProtection(a.authority, { kind: 'technical', until: a.recovery.nextCheckAt });
  }
  persist();
  try { _accountSSEBroadcast?.('matrix:account', { id, recovery: a.recovery }); } catch { /* non-fatal */ }
}

/** 记「keepAlive 对该 login_required 号做过一次复验」的时间:24h 内不重复复验(降噪,防每 12h 白开窗)。 */
export function markLoginRecheck(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.lastLoginRecheckAt = Date.now();
  persist();
}

/** 标记「刚确认该号登录态有效」(任务/发布/保活成功时调)。主动保活据 lastAliveAt 筛「超 N 天没活跃」的号。 */
export function markAccountAlive(id: string): void {
  const a = getAccount(id);
  if (!a || a.bindingConflict || a.manualDisconnect || a.chargeUncertain) return;
  if (a.recovery?.reason === 'rate_limited' && a.recovery.nextCheckAt > Date.now()) return;
  a.lastAliveAt = Date.now();
  if(a.authority && a.boundUid){
    a.authority.verified=true;
    a.authority.constraints=a.authority.constraints.filter(c=>!['rate_limited','legacy_pause_recheck','technical','login_wall','captcha'].includes(c.kind)||(c.until||0)>Date.now());
  }
  persist();
  // 明确确认登录有效后清除过期/待检查提示；普通任务清理不能清除这些状态。
  // 不改 running/banned，也不解除 automationSafety 中仍有效的暂停。
  if (a.status === 'login_required' || (a.status === 'limited' && a.recovery)) setAccountStatus(id, 'idle', '');
}

// ── 本机出口 IP(无代理号的真实公网出口)──
// 内核里 fetch ip 服务读到的出口 IP(反映是否走 VPN);主进程 undici 不一定走 VPN,所以必须由内核侧探测后写进来
// (见 kernelPool 起内核后的探测)。所有【无代理】号同机同路由共用一个出口,故全局存一个值即可,落小文件跨重启保留。
let localEgressIp: string | null | undefined;  // undefined=未从盘加载, null=未知, string=已知
function localIpFile(): string { return path.join(baseDir(), 'local_ip.json'); }
export function getLocalEgressIp(): string | null {
  if (localEgressIp === undefined) {
    try { const j = JSON.parse(fs.readFileSync(localIpFile(), 'utf8')); localEgressIp = (j && typeof j.ip === 'string') ? j.ip : null; } catch { localEgressIp = null; }
  }
  return localEgressIp || null;
}
export function setLocalEgressIp(ip: string | null): void {
  const v = (ip || '').trim() || null;
  if (v === getLocalEgressIp()) return;  // 没变化不写盘
  localEgressIp = v;
  try { ensureDirs(); fs.writeFileSync(localIpFile(), JSON.stringify({ ip: v, at: Date.now() }), 'utf8'); } catch { /* ignore */ }
}

/**
 * 角标用:该号代理 IP 展示文案 + 是否与别的号【撞 IP】+ 有无代理。
 * 只比较同平台最近实际观测到的出口；入口 host 相同不代表出口相同。
 * 未观测出口时明确显示未知。观测是历史快照，不保证当前出口仍相同。
 */
export function proxyBadgeInfo(id: string): { text: string; duplicate: boolean; hasProxy: boolean } {
  const accts = loadAccounts();
  const a = accts.find((x) => x.id === id);
  if (!a) return { text: '本机默认', duplicate: false, hasProxy: false };
  const pk = platformKey(a);
  const ipIdOf = (x: MatrixAccount): string => {
    const ip = x.proxy ? (x.proxy.exitIpObservedAt ? x.proxy.exitIp : '') : getLocalEgressIp();
    if (!ip || !net.isIP(ip) || ip.includes('%')) return '';
    return net.isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname : ip;
  };
  const ipId = ipIdOf(a);
  // 同平台 + 最近观测同出口的号,按列表顺序:第一个免提示,第 2 个起提示。
  const sameBucket = ipId ? accts.filter((x) => platformKey(x) === pk && ipIdOf(x) === ipId) : [];
  const isFirst = sameBucket.length > 0 && sameBucket[0].id === a.id;
  // 无代理号:显示【真实本机出口 IP】(探到才有),没探到回落「本机默认」。
  const localText = getLocalEgressIp() ? `本机 ${getLocalEgressIp()}` : '本机默认';
  return {
    text: a.proxy ? (ipId ? `最近观测出口 ${a.proxy.exitIp}` : `代理入口 ${a.proxy.host}`) : localText,
    duplicate: sameBucket.length > 1 && !isFirst,
    hasProxy: !!a.proxy,
  };
}

export type ProxyExitObservation = ExitLocale & { ip: string; observedAt: number };

export const FINGERPRINT_EXIT_FRESHNESS_MS = 15 * 60_000;
function validExitObservationTime(observedAt: unknown, now: number): observedAt is number {
  return typeof observedAt === 'number' && Number.isFinite(observedAt) && observedAt > 0 && observedAt <= now;
}
function recentExitObservation(observedAt?: number, now = Date.now()): boolean {
  return validExitObservationTime(observedAt, now) && now - observedAt <= FINGERPRINT_EXIT_FRESHNESS_MS;
}
function proxyExitLocale(proxy?: Proxy): ExitLocale | undefined {
  return proxy && recentExitObservation(proxy.exitIpObservedAt) && recentExitObservation(proxy.exitLocaleObservedAt)
    && regionCode(proxy.exitCountryCode) && normalizeEgressIp(proxy.exitIp || '')
    ? { countryCode: proxy.exitCountryCode, timezone: proxy.exitTimezone } : undefined;
}

function clearProxyExitObservation(proxy: Proxy): void {
  delete proxy.exitCountryCode;
  delete proxy.exitTimezone;
  delete proxy.exitLocaleObservedAt;
  delete proxy.exitIp;
  delete proxy.exitIpObservedAt;
}

function applyProxyExitObservation(proxy: Proxy, observation: ProxyExitObservation, now = Date.now()): void {
  const ip = normalizeEgressIp(observation.ip);
  const at = observation.observedAt;
  if (!ip || !validExitObservationTime(at, now)) return;
  const ipAt = proxy.exitIpObservedAt;
  const olderIp = validExitObservationTime(ipAt, now) && at < ipAt;
  const sameIp = proxy.exitIp === ip;
  // A late observation for a different exit cannot replace the active IP or its geography.
  if (!sameIp && olderIp) return;
  if (!sameIp) clearProxyExitObservation(proxy);
  if (!olderIp) {
    proxy.exitIp = ip;
    proxy.exitIpObservedAt = at;
  }
  // With a matching IP, advance geography independently. Invalid future values are not watermarks.
  const geoAt = proxy.exitLocaleObservedAt;
  if (observation.countryCode !== undefined && !(validExitObservationTime(geoAt, now) && at < geoAt)) {
    proxy.exitCountryCode = regionCode(observation.countryCode);
    proxy.exitTimezone = readTimezone(observation.timezone);
    proxy.exitLocaleObservedAt = proxy.exitCountryCode ? at : undefined;
  }
}

export function setAccountProxy(id: string, proxy: Proxy | null | undefined, observation?: ProxyExitObservation): void {
  const a = getAccount(id);
  if (!a) return;
  // 传空 = 清除代理,该账号改用本机 IP(用户 2026-09-11:配过就删不掉)。下次启动内核生效。
  if (!proxy || !proxy.host) {
    if (a.proxy && a.egress) { delete a.egress.ip; delete a.egress.observedAt; }
    delete a.proxy; persist(); return;
  }
  const changed = !a.proxy || (['protocol', 'host', 'port', 'username', 'password'] as const).some((key) => a.proxy?.[key] !== proxy[key]);
  const previous = a.proxy;
  a.proxy = { ...proxy };
  // Renderer-supplied display/host geo is not proof of an observed exit.
  clearProxyExitObservation(a.proxy);
  if (!changed && previous?.exitIp && previous.exitIpObservedAt) {
    a.proxy.exitIp = previous.exitIp;
    a.proxy.exitIpObservedAt = previous.exitIpObservedAt;
    a.proxy.exitCountryCode = previous.exitCountryCode;
    a.proxy.exitTimezone = previous.exitTimezone;
    a.proxy.exitLocaleObservedAt = previous.exitLocaleObservedAt;
  }
  if (changed) {
    if (a.egress) { delete a.egress.ip; delete a.egress.observedAt; }
    delete a.proxy.health;
    delete a.proxy.healthCheckedAt;
  }
  if (observation) applyProxyExitObservation(a.proxy, observation);
  persist();
}

export function sameProxyRoute(a?: Proxy, b?: Proxy): boolean {
  if (!a || !b) return !a && !b;
  return (['protocol', 'host', 'port', 'username', 'password'] as const).every((key) => a[key] === b[key]);
}

export function normalizeEgressIp(value: string): string {
  const ip = String(value || '').trim();
  if (!net.isIP(ip) || ip.includes('%')) return '';
  return net.isIP(ip) === 6 ? new URL(`http://[${ip}]`).hostname.slice(1, -1) : ip;
}

/** The observed exit is informational; it never pauses the account. */
export function recordAccountEgress(id: string, value: string, observedAt: number, boundProxy?: Proxy): 'ok' | 'stale_route' {
  const a = getAccount(id);
  const ip = normalizeEgressIp(value);
  if (!a || !sameProxyRoute(a.proxy, boundProxy)) return 'stale_route';
  const now = Date.now();
  if (!ip || !validExitObservationTime(observedAt, now)) throw new Error('network_error:出口观测无效');
  if (!a.egress) a.egress = { baselineIp: ip, baselineAt: observedAt };
  const previous = a.egress.observedAt;
  if (!validExitObservationTime(previous, now) || observedAt >= previous) {
    a.egress.ip = ip; a.egress.observedAt = observedAt;
    if (!a.proxy) setLocalEgressIp(ip);
  }
  if (a.proxy) applyProxyExitObservation(a.proxy, { ip, observedAt }, now);
  persist();
  return 'ok';
}

/** 仅记录通用连通性及最近一次真实出口观测，不据此断言目标平台/账号状态。 */
export function setProxyHealth(id: string, health: 'ok' | 'leaking' | 'banned' | 'dead', observation?: ProxyExitObservation): void {
  const a = getAccount(id);
  if (!a || !a.proxy) return;
  a.proxy.health = health;
  a.proxy.healthCheckedAt = Date.now();
  if (observation) applyProxyExitObservation(a.proxy, observation);
  persist();
}

export function setAccountKeywords(id: string, keywords: string[], track?: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.keywords = (keywords || []).filter(Boolean);
  if (track !== undefined) a.track = track;
  persist();
}

/** AI 衍生关键词池上限(到顶且仍耗尽 → 整批换)。 */
export const DERIVED_KEYWORDS_CAP = 30;

/**
 * 把 AI 衍生的新词追加进【衍生池】(account.derivedKeywords),【绝不动原始 keywords】。
 *  · 衍生词若与原始词重复则丢弃(避免冗余)。
 *  · 池未满(<30):去重追加,封顶 30。
 *  · 池已满(>=30)还在衍生(=旧池关键词也搜尽)→ 整批换:丢掉旧衍生池,换成这批新词(封顶 30)。
 * 各任务 runner 的 ctx.appendKeywords 统一走这里 → 原始词永留、衍生池受控可换。
 */
export function appendDerivedKeywords(id: string, newWords: string[]): void {
  const a = getAccount(id);
  if (!a) return;
  const orig = new Set((a.keywords || []).map((k) => String(k || '').trim()).filter(Boolean));
  const fresh: string[] = [];
  const seen = new Set<string>();
  for (const w of (newWords || [])) {
    const k = String(w || '').trim();
    if (!k || orig.has(k) || seen.has(k)) continue;
    seen.add(k); fresh.push(k);
  }
  if (!fresh.length) return;
  const cur = (a.derivedKeywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  let next: string[];
  if (cur.length >= DERIVED_KEYWORDS_CAP) {
    next = fresh.slice(0, DERIVED_KEYWORDS_CAP);                 // 整批换
  } else {
    next = Array.from(new Set([...cur, ...fresh])).slice(0, DERIVED_KEYWORDS_CAP); // 追加
  }
  a.derivedKeywords = next;
  persist();
}

/** 搜索用的有效关键词 = 原始词 + 衍生词(去重)。 */
export function effectiveKeywords(acc: { keywords?: string[]; derivedKeywords?: string[] } | null | undefined): string[] {
  if (!acc) return [];
  const orig = (acc.keywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  const der = (acc.derivedKeywords || []).map((k) => String(k || '').trim()).filter(Boolean);
  return Array.from(new Set([...orig, ...der]));
}

/** 编辑账号元信息(备注名/赛道分组/人设/关键词)。只更新传入的字段。 */
export function observedFingerprintExit(account: MatrixAccount): string {
  return normalizeEgressIp(account.proxy
    ? recentExitObservation(account.proxy.exitIpObservedAt) ? account.proxy.exitIp || '' : ''
    : recentExitObservation(account.egress?.observedAt) ? account.egress?.ip || '' : '');
}

export function observedFingerprintLocale(account: MatrixAccount): ExitLocale | undefined {
  return proxyExitLocale(account.proxy);
}

export function updateAccountMeta(id: string, patch: { displayName?: string; group?: string; persona?: string; keywords?: string[]; track?: string; contentLang?: 'zh' | 'en'; fingerprintLocale?: FingerprintLocalePatch },
  lookup?: { ip: string; locale: ExitLocale }): boolean {
  const localePatch = validateFingerprintLocalePatch(patch.fingerprintLocale);
  const a = getAccount(id);
  if (!a) return false;
  const contentLang = patch.contentLang ?? a.contentLang;
  let locale: Pick<Fingerprint, 'lang' | 'timezone'> | undefined;
  if (localePatch?.mode === 'manual') {
    const resolved = resolveFingerprintLocale(localePatch, undefined, contentLang);
    locale = { lang: localePatch.lang ? resolved.lang : a.fingerprint.lang ?? resolved.lang,
      timezone: localePatch.timezone ? resolved.timezone : a.fingerprint.timezone ?? resolved.timezone };
  } else if (localePatch?.mode === 'align') {
    const currentIp = observedFingerprintExit(a);
    const fromLookup = currentIp && lookup?.ip === currentIp && regionCode(lookup.locale.countryCode) ? lookup.locale : undefined;
    const observed = observedFingerprintLocale(a) ?? fromLookup;
    // Refuse atomically: do not overwrite either the manual locale or other metadata.
    if (!localePatch.region && !observed) return false;
    locale = resolveFingerprintLocale({ region: localePatch.region }, observed, contentLang);
  }
  if (locale) a.fingerprint = { ...a.fingerprint, ...locale };
  if (patch.displayName !== undefined) a.displayName = patch.displayName;
  if (patch.group !== undefined) a.group = patch.group;
  if (patch.persona !== undefined) a.persona = patch.persona;
  // 用户在账号编辑框保存关键词时,输入框里【已经包含了 AI 衍生词】(编辑时合并回填,
  //   见 MatrixView.openEdit)。所以这份列表就是用户认可的全集 —— 必须同时清空衍生池,
  //   否则用户删掉的衍生词会在下次 effectiveKeywords 合并时原样回来,删了等于没删
  //   (用户 2026-08-21 反馈「填 9 个却跑 19 个」正是这个池子造成的)。
  //   之后任务再衍生新词会重新往空池里追加,行为不变。
  if (patch.keywords !== undefined) {
    a.keywords = (patch.keywords || []).filter(Boolean);
    a.derivedKeywords = [];
  }
  if (patch.track !== undefined) a.track = patch.track;
  if (patch.contentLang !== undefined) a.contentLang = patch.contentLang === 'en' ? 'en' : 'zh';
  persist();
  return true;
}

/** 登录后写入真实身份(昵称/平台号/头像展示 + uid 绑定);只更新传入的非空字段。 */
export function setAccountIdentity(id: string, ident: { nickname?: string; displayId?: string; avatar?: string; boundUid?: string }): void {
  const a = getAccount(id);
  if (!a) return;
  let duplicate = false;
  persistIdentityChange(() => {
    if (forbiddenIdentityMismatch(a, ident.boundUid)) return false;
    if (ident.boundUid && findAccountByUid(platformKey(a), ident.boundUid, id)) {
      duplicate = true;
      return false;
    }
    if (a.bindingConflict && !ident.boundUid) return false;
    writeIdentityFields(a, ident);
    return true;
  });
  if (duplicate) markAccountBindingConflict(id);
}

function writeIdentityFields(a: MatrixAccount, ident: Parameters<typeof setAccountIdentity>[1]): void {
  if (ident.nickname) a.nickname = ident.nickname;
  if (ident.displayId) a.displayId = ident.displayId;
  if (ident.avatar) a.avatar = ident.avatar;
  if (ident.boundUid) { a.boundUid = ident.boundUid; delete a.bindingConflict; }
}

/** Reject duplicate binding without destroying the browser's login session. */
export function markAccountBindingConflict(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.bindingConflict = true;
  if(a.authority){a.authority.verified=false;mergeProtection(a.authority,{kind:'binding_conflict'});}
  setAccountStatus(id, 'login_required');
}

/** 断开关联:清掉读到的身份(昵称/平台号/头像/uid),保留账号配置。 */
export function clearAccountIdentity(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  persistIdentityChange(() => {
    const subject = forbiddenIdentitySubject(a);
    if (subject && a.authority) {
      mergeProtection(a.authority, { kind: 'forbidden' });
      a.authority.forbiddenSubject ||= subject;
    }
    delete a.nickname; delete a.displayId; delete a.avatar; delete a.boundUid;
    delete a.bindingConflict;
    return true;
  });
}

/** 用户主动「断开连接」:标记之,让 keepAlive 不再把它当「疑似误标过期」每轮开窗复验(见 MatrixAccount.manualDisconnect)。 */
export function markManualDisconnect(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  if (!a.manualDisconnect) {
    if (a.status === 'banned') a.statusReason = '账号封禁，需人工核对';
    else if(a.chargeUncertain?.holdReason && ['平台拒绝访问（HTTP 403）','平台拒绝访问','HTTP 403','HTTP 403:平台拒绝访问','页面需要人工检查：forbidden'].includes(a.chargeUncertain.holdReason)) a.statusReason=a.chargeUncertain.holdReason;
    else if (a.status !== 'limited' || !a.statusReason || a.recovery) a.statusReason = '账号已主动断开，请重新连接后运行';
  }
  if (a.recovery?.reason !== 'rate_limited' || a.recovery.nextCheckAt <= Date.now()) delete a.recovery;
  a.manualDisconnect = true;
  a.status = 'login_required';
  if(a.authority){
    if (a.authority.attempt?.scanId) a.authority.lastScanId = a.authority.attempt.scanId;
    a.authority.verified=false; a.authority.epoch=nextRevision(a.authority.epoch); delete a.authority.attempt;
    mergeProtection(a.authority,{kind:'manual_disconnect'});
  }
  clearAccountIdentity(id);
}

export function markPosted(id: string): void {
  const a = getAccount(id);
  if (!a) return;
  a.lastPostAt = Date.now();
  persist();
}

/** 启动时清理「残留运行中」:上次任务跑到一半 app 被关 → status 卡在 'running' 写进了库,
 *  重启后先进入只读登录复查；不直接宣告已连接，也不补发结果不明的操作。 */
export function resetRunningToIdle(): void {
  const accts = loadAccounts();
  let changed = false;
  for (const a of accts) { if (a.status === 'running') {
    const activeCooldown = a.recovery?.reason === 'rate_limited' && a.recovery.nextCheckAt > Date.now();
    a.status = a.bindingConflict || a.manualDisconnect ? 'login_required' : 'limited';
    if (a.bindingConflict) a.statusReason = '账号绑定冲突，请确认本人身份后重新关联';
    else if (a.manualDisconnect) a.statusReason ||= '账号已主动断开，请重新连接后运行';
    else if (a.chargeUncertain) a.statusReason = '计费结果不明，请核对账单后恢复';
    else if (activeCooldown) a.statusReason = '平台限制操作频率，等待冷却后复查';
    else {
      a.recovery = { attempts: 1, nextCheckAt: Date.now() + recoveryDelay(1), reason: '上次任务中断，等待登录复查' };
      a.statusReason = '上次任务中断，等待自动复查（不重发结果待确认的评论）';
    }
    changed = true;
  } }
  if (changed) { cache = accts; persist(); }
}

/** 按平台 + 真实 uid 找【已被别的矩阵号关联】的账号(去重用:同一个真实平台账号不许关联到两个矩阵号)。 */
// platform 传 platformKey(快手区分主站/创作端):同一真实快手号【允许】各绑一个主站号+一个创作端号,
// 只在【同场景】内查重(传 'kuaishou_creator' 只撞创作端、传 'kuaishou' 只撞主站)。
export function findAccountByUid(platform: string, boundUid: string, excludeId: string): MatrixAccount | undefined {
  if (!boundUid) return undefined;
  return loadAccounts().find((a) => a.id !== excludeId && platformKey(a) === platform && a.boundUid === boundUid);
}

export function removeAccount(id: string): void {
  const accounts = loadAccounts();
  const account = accounts.find(row => row.id === id);
  if (account?.authority) {
    assertProfileAccess(id, account.userDataDir);
    if (account.authority.browserOwner && !ownerExited(account.authority.browserOwner)) throw Error('profile_cleanup_unconfirmed');
  }
  cache = accounts.filter((a) => a.id !== id);
  persist();
  // 联动清理任务引用:否则 tasks.json 仍带着已删账号 id → 运行时变幽灵号被误判「超额暂停」。
  // (taskStore 不 import accountManager,无循环依赖。)
  pruneAccountFromTasks(id);
}
