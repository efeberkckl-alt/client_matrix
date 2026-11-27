import { createHash, randomUUID } from 'crypto';
import type { AccountStatus, MatrixAccount } from './types';
import type { ProfileIdentity } from './profileIdentity';

export type ProtectionKind = 'manual_disconnect' | 'binding_conflict' | 'banned' | 'billing_uncertain'
  | 'forbidden' | 'account_flag' | 'rate_limited' | 'login_wall' | 'captcha' | 'proxy_auth'
  | 'technical' | 'legacy_pause_recheck' | 'legacy_unknown' | 'cleanup_pending';
export type Protection = { kind: ProtectionKind; until?: number; source?: string };
export type AccountAuthority = {
  incarnation: string;
  epoch: string;
  revision: string;
  verified: boolean;
  forbiddenSubject?: string;
  constraints: Protection[];
  attempt?: { id: string; scanId?: string; kind: 'connect' | 'observe'; instance?: string; connection?: object };
  cleanup?: { id: string; priorMutations: string[]; profile?: ProfileIdentity };
  lastScanId?: string;
  createdProfile?: ProfileIdentity;
  browserOwner?: { instance: string; pid?: number; exited?: boolean; profile?: ProfileIdentity };
  mutations?: Record<string, { state: 'dispatched' | 'completed' | 'unknown'; instance: string; epoch: string; connection: string; profile?: ProfileIdentity }>;
};
export type DispatchSubject = {
  accountId: string; incarnation: string; epoch: string; subject: string; profile: string;
  instance?: string; connection?: string; generation?: number;
};
export type DispatchRecord = {
  id: string; accountId: string; incarnation: string; epoch: string; subject: string; action: string; platform: string;
  profile?: string; instance?: string; connection?: string; generation?: number; ledgerKey?: string;
  ledgerId?: string; subjects?: DispatchSubject[]; chargeCount?: number; charged?: number; balanceAfter?: number;
  operationId?: string;
  refId?: string; at: number; kind: 'billing' | 'comment';
  result?: 'confirmed' | 'charge_uncertain' | 'comment_pending' | 'rejected' | 'acknowledged';
};
export type MatrixPublishOutcome = {
  items: { accountId: string; state: 'success' | 'failed' | 'skipped'; reason?: string; publishedUrl?: string }[];
  subjects: DispatchSubject[];
  billingEligible?: boolean;
};
export type MatrixPublishPrincipal = Pick<DispatchSubject, 'accountId' | 'incarnation' | 'subject'>;
export type MatrixPublishOperation = {
  id: string; platform: string; taskId?: string; startedAt: number; billingRequested?: boolean;
  outcome?: MatrixPublishOutcome;
  requestHash?: string;
  principals?: MatrixPublishPrincipal[];
  phase?: 'prepared' | 'started';
};
export type StoreEnvelope = {
  formatVersion: 1; storeId: string; storeRevision: string; importReceipts: Record<string, { scope: string; canonical: string }>;
  publishRuns?: Record<string, MatrixPublishOperation>;
  accounts: MatrixAccount[]; archivedSubjects: Record<string, Protection[]>; dispatchRecords: Record<string, DispatchRecord>;
};

export const sha256 = (bytes: string) => createHash('sha256').update(bytes).digest('hex');
export const nextRevision = (value: string) => {
  const next = BigInt(value) + 1n;
  if (next > 0xffff_ffff_ffff_ffffn) throw new Error('account_revision_exhausted');
  return String(next);
};
const revision = (value: unknown) => typeof value === 'string' && /^\d{1,20}$/.test(value) && BigInt(value) <= 0xffff_ffff_ffff_ffffn;
const dictionary = new Map<string, ProtectionKind>([
  ['页面要求登录或验证，需人工检查（不代表账号封禁或已登出）','login_wall'],
  ['页面需要人工检查：login_wall','login_wall'],
  ['检测到验证码，需人工处理','captcha'], ['页面需要人工检查：captcha','captcha'],
  ['页面需要人工检查：forbidden','forbidden'], ['平台拒绝访问','forbidden'], ['平台拒绝访问（HTTP 403）','forbidden'],
  ['HTTP 403','forbidden'], ['HTTP 403:平台拒绝访问','forbidden'], ['forbidden','forbidden'],
  ['账号操作受到限制','account_flag'], ['页面需要人工检查：account_flag','account_flag'],
  ['代理要求认证（HTTP 407）','proxy_auth'], ['proxy_auth_required','proxy_auth'],
]);
const groupReason = /^(?:同一出口\/代理入口的多个账号受限，暂停该组自动任务|🛑 同组多个账号受限，停止自动操作，请检查平台提示。|自动操作已暂停：同一出口\/代理入口的多个账号受限，暂停该组自动任务，最早恢复时间 [^；]+)$/;
const formerEgress = /^(?:network_changed:.*|network_error:未能确认当前出口，等待网络复查|网络已确认，等待登录复查|网络已人工确认)$/;
const knownKinds = new Set<ProtectionKind>([...dictionary.values(), 'manual_disconnect', 'binding_conflict', 'banned',
  'billing_uncertain', 'rate_limited', 'technical', 'legacy_pause_recheck', 'legacy_unknown', 'cleanup_pending']);
const object = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

export function mergeProtection(authority: AccountAuthority, next: Protection): void {
  const current = authority.constraints.find(item => item.kind === next.kind && item.source === next.source);
  if (!current) authority.constraints.push(next);
  else if (next.until !== undefined) current.until = Math.max(current.until || 0, next.until);
}

export function legacyAccountAuthority(account: MatrixAccount): AccountAuthority {
  const result: AccountAuthority = { incarnation: randomUUID(), epoch:'0', revision:'0',
    verified: !!account.boundUid && (account.status === 'idle' || account.status === 'running'), constraints:[] };
  if (account.manualDisconnect) mergeProtection(result,{kind:'manual_disconnect'});
  if (account.bindingConflict) mergeProtection(result,{kind:'binding_conflict'});
  if (account.chargeUncertain) mergeProtection(result,{kind:'billing_uncertain',source:account.chargeUncertain.refId});
  if (account.status === 'banned') mergeProtection(result,{kind:'banned'});
  if (account.recovery && !formerEgress.test(account.recovery.reason)) mergeProtection(result,{kind:account.recovery.reason==='rate_limited'?'rate_limited':'technical',until:account.recovery.nextCheckAt});
  for(const reason of [account.statusReason,account.egress?.holdReason,account.chargeUncertain?.holdReason]){
    if (!reason || formerEgress.test(reason)) continue;
    const kind=dictionary.get(reason);
    if(kind) mergeProtection(result,{kind,until:kind==='login_wall'||kind==='captcha'?account.recovery?.nextCheckAt:undefined});
    else if (groupReason.test(reason)) mergeProtection(result,{kind:'legacy_pause_recheck',source:'legacy_group_projection'});
    else if(account.status==='limited'&&!account.recovery&&!account.chargeUncertain) mergeProtection(result,{kind:'legacy_unknown'});
  }
  if (account.status==='limited' && !result.constraints.length && !formerEgress.test(account.statusReason||'')) {
    mergeProtection(result,{kind:'legacy_unknown'});
  }
  return result;
}

export function openAccountEnvelope(value: unknown): StoreEnvelope {
  if (Array.isArray(value)) {
    if (value.some(a=>!object(a)||typeof a.id!=='string') || new Set(value.map(a=>a.id)).size!==value.length) throw Error('storage_or_migration_hold');
    const accounts=value as MatrixAccount[];
    for(const account of accounts) account.authority=legacyAccountAuthority(account);
    return {formatVersion:1,storeId:randomUUID(),storeRevision:'0',accounts,importReceipts:{},archivedSubjects:{},dispatchRecords:{}};
  }
  if (!object(value) || value.formatVersion!==1 || typeof value.storeId!=='string' || !revision(value.storeRevision)
    || !Array.isArray(value.accounts) || !object(value.importReceipts) || !object(value.archivedSubjects) || !object(value.dispatchRecords)
    || value.accounts.some(a=>!a || typeof a.id!=='string' || !a.authority || typeof a.authority.incarnation!=='string'
      || typeof a.authority.verified!=='boolean' || !revision(a.authority.epoch) || !revision(a.authority.revision)
      || (a.authority.forbiddenSubject !== undefined && (typeof a.authority.forbiddenSubject !== 'string' || !a.authority.forbiddenSubject))
      || !Array.isArray(a.authority.constraints) || a.authority.constraints.some((c: Protection)=>!c||!knownKinds.has(c.kind)
        ||(c.until!==undefined&&!Number.isFinite(c.until))))) throw Error('storage_or_migration_hold');
  const validProtection = (entry: unknown): boolean => object(entry) && knownKinds.has(entry.kind as ProtectionKind)
    && (entry.until === undefined || (typeof entry.until === 'number' && Number.isFinite(entry.until)));
  if (new Set(value.accounts.map(account => account.id)).size !== value.accounts.length
    || (value.publishRuns !== undefined && (!object(value.publishRuns) ||
      Object.entries(value.publishRuns).some(([id, run]) => !object(run) || run.id !== id ||
        typeof run.platform !== 'string' || !Number.isFinite(run.startedAt) ||
        (run.requestHash !== undefined && (typeof run.requestHash !== 'string' || !/^[a-f0-9]{64}$/.test(run.requestHash) ||
          !['prepared', 'started'].includes(String(run.phase)) || !Array.isArray(run.principals) ||
          run.principals.some(principal => !object(principal) || typeof principal.accountId !== 'string' ||
            typeof principal.incarnation !== 'string' || typeof principal.subject !== 'string'))) ||
        (run.outcome !== undefined && (!object(run.outcome) || !Array.isArray(run.outcome.items) || !Array.isArray(run.outcome.subjects))))))
    || Object.values(value.importReceipts).some(row => !object(row) || typeof row.scope !== 'string' || typeof row.canonical !== 'string')
    || Object.values(value.archivedSubjects).some(rows => !Array.isArray(rows) || !rows.every(validProtection))
    || Object.entries(value.dispatchRecords).some(([id, record]) => !object(record) || record.id !== id
      || typeof record.accountId !== 'string' || typeof record.incarnation !== 'string' || !revision(record.epoch)
      || typeof record.subject !== 'string' || typeof record.at !== 'number' || !Number.isFinite(record.at)
      || !['billing', 'comment'].includes(String(record.kind))
      || (record.result !== undefined && !['confirmed', 'charge_uncertain', 'comment_pending', 'rejected', 'acknowledged'].includes(String(record.result))))) {
    throw Error('storage_or_migration_hold');
  }
  return value as StoreEnvelope;
}

export function legacyPausePlan(store: StoreEnvelope, raw: string): { pauses: Record<string, unknown>; importAcks: string[]; changed: boolean } {
  const input=JSON.parse(raw);
  const wrapped=object(input)&&input.formatVersion===1;
  const pauses=wrapped?input.pauses:input;
  if(!object(pauses)||(wrapped&&!Array.isArray(input.importAcks)))throw Error('storage_or_migration_hold');
  const existingAcks = wrapped && Array.isArray(input.importAcks) ? input.importAcks : [];
  if (existingAcks.some(id => typeof id !== 'string')) throw Error('storage_or_migration_hold');
  const acks=new Set<string>(existingAcks);
  const seen=new Map(Object.entries(store.importReceipts).map(([id,r])=>[r.scope+'\0'+r.canonical,id]));
  let changed=false;
  for(const [scope, record] of Object.entries(pauses)){
    if(!object(record)||typeof record.reason!=='string'||typeof record.until!=='number'||!Number.isFinite(record.until))throw Error('storage_or_migration_hold');
    if(!scope.startsWith('account:'))continue;
    // Runtime deadlines are read directly from the safety ledger. Importing
    // them as legacy account constraints would turn expired holds into manual
    // reviews. Only runtime hard restrictions are mirrored/pinned at startup.
    const { other, ...primary } = record;
    for (const pause of [primary, ...(Array.isArray(other) ? other : [])]) {
      if (pause.runtime === true && pause.code !== 'forbidden' && pause.code !== 'account_flag') continue;
      const canonical=JSON.stringify(Object.fromEntries(Object.entries(pause).sort(([a],[b])=>a.localeCompare(b))));
      let id=seen.get(scope+'\0'+canonical);
      if(!id){
        id=sha256(store.storeId+sha256(raw)+scope+canonical);
        store.importReceipts[id]={scope,canonical}; changed=true;
        const target=store.accounts.find(a=>scope==='account:'+a.id||scope==='account:'+a.platform+':'+a.boundUid);
        const kind: ProtectionKind=pause.runtime === true && (pause.code==='forbidden'||pause.code==='account_flag') ? pause.code :
          pause.code==='rate_limited'?'rate_limited':
          pause.code==='forbidden'||pause.code===undefined||pause.until<=Date.now()?'legacy_pause_recheck':'legacy_unknown';
        const next: Protection={kind,until:pause.until,source:id};
        if(target?.authority)mergeProtection(target.authority,next);
        else (store.archivedSubjects[scope]||=[]).push(next);
      }
      acks.add(id);
    }
  }
  return {pauses,importAcks:[...acks],changed:changed||!wrapped || acks.size!==existingAcks.length};
}

export function hasPendingCookieMutation(authority: AccountAuthority | undefined): boolean {
  return !!authority?.mutations && Object.values(authority.mutations).some(mutation => mutation.state !== 'completed');
}

export function availabilityOf(account: MatrixAccount, now: number, groupUntil = 0, storageFault = false, profileBlocked = false, legacyProfileReview = false, safetyPauses: readonly { until: number; code?: string; runtime?: true }[] = []) {
  const authority=account.authority;
  const reasons: string[] = authority?.constraints.map(c=>c.kind)||[];
  for (const pause of safetyPauses) {
    const reason = pause.code || 'safety_pause';
    if ((pause.until > now || (pause.runtime && (reason === 'forbidden' || reason === 'account_flag'))) && !reasons.includes(reason)) {
      reasons.push(reason);
    }
  }
  if ((profileBlocked || hasPendingCookieMutation(authority)) && !reasons.includes('cleanup_pending')) reasons.push('profile_cookie_in_flight');
  if (legacyProfileReview) reasons.push('profile_history_review_required');
  const hard=reasons.some(kind=>['manual_disconnect','binding_conflict','banned','billing_uncertain','forbidden',
    'account_flag','proxy_auth','legacy_unknown','cleanup_pending','profile_cookie_in_flight','profile_history_review_required'].includes(kind));
  const deadlines=authority?.constraints.flatMap(item=>item.until===undefined?[]:[item.until])||[];
  const until=Math.max(groupUntil,...safetyPauses.map(p=>p.until),...deadlines,0);
  const status: AccountStatus=reasons.includes('manual_disconnect')||reasons.includes('binding_conflict')?'login_required'
    :reasons.includes('banned')?'banned':storageFault||reasons.length||groupUntil>now?'limited'
      :authority?.verified?(account.status==='running'?'running':'idle'):'login_required';
  const enabled=(account as MatrixAccount & {enabled?:boolean}).enabled!==false;
  return { status, available:enabled&&!storageFault&&!!authority?.verified&&!reasons.length&&groupUntil<=now,
    probeEligible:enabled&&!storageFault&&!hard&&until<=now, retryAt:hard||storageFault?null:until||null,
    reasons:storageFault?[...reasons,'storage_or_migration_hold']:groupUntil>now?[...reasons,'group_pause']:reasons, revision:authority?.revision };
}

export function decodeProtectionReason(reason: string | undefined): ProtectionKind | undefined {
  return reason ? dictionary.get(reason) : undefined;
}
