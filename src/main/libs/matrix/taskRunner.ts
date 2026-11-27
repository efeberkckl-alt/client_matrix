import type { DispatchSubject, MatrixPublishPrincipal } from './accountProtection';
/**
 * 矩阵任务编排(管理层②)—— 一次锁 1 个平台,把一条内容铺到 N 个账号。
 *
 * 约束(用户拍板):一次只一个平台、多号多窗、不跨平台并发。
 * 流程:限并发 K 错峰起窗 → 每号:起指纹内核 → 发前登录检查 → 跑 driver → 关窗回收
 *      → 全部完成后按【成功号数】调 /api/matrix/charge 计费 → 出报告。
 *
 * 内容差异化:getInput(accountId, index) 可为每号返回不同的成片(封面/字幕/音色/
 * 切片各异),实现"每号发不一样的"防判重;返回同一份即"同条铺号"。
 */

import { coworkLog } from '../coworkLogger';
import type { VideoPlatform, PublishInput } from '../video/publishers/types';
import { kernelNavigate, checkKernelLogin, getSession, NO_KERNEL_ERROR, acquireKernel, releaseKernel } from './kernelPool';
import { inspectHoldMs } from './inspectHold';
import { installedKernelPath } from './kernelInstaller';
import { runMatrixDriver } from './driverCtx';
import {
  getAccount, setAccountStatus, markPosted, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey, selectAvailability, captureDispatchSubject, bindPublishRequest, beginMatrixPublishOperation, saveMatrixPublishOutcome, registerAggregateCharge, getAggregateChargeForRecovery, archiveDispatchedResult, captureAssociation, isCurrentAssociation,
} from './accountManager';
import { promptReloginForExpiredAccount } from './reloginPrompt';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
function randInt(min: number, max: number): number { return min + Math.floor(Math.random() * (max - min + 1)); }

export interface MatrixTaskOptions {
  platform: VideoPlatform;
  runOperationId?: string;
  onOperation?: (id: string) => void;
  recover?: boolean;
  principals?: ReadonlyMap<string, MatrixPublishPrincipal>;
  taskId?: string;             // 任务 id(标签分组 pill 显示 🤖 平台 #缩写;手动/无任务上下文可缺省)
  accountIds: string[];
  /** 每号的发布内容(支持差异化);返回同一份即同条铺号。 */
  getInput: (accountId: string, index: number) => PublishInput;
  concurrency?: number;        // 同时开几窗,默认 3
  jitterMinMs?: number;        // 每号启动前错峰下限,默认 3s
  jitterMaxMs?: number;        // 上限,默认 15s
  kernelPath?: string;         // 手动指定内核路径;缺省用已下载的指纹内核,没有则抛 NO_KERNEL
  headless?: boolean;
  signal?: AbortSignal;
  authToken?: string;          // 计费 Bearer token;缺省则跳过计费(只发不收)
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: MatrixTaskItemResult) => void;  // 每号完成回调(刷新 UI)
}

export type MatrixItemState = 'success' | 'failed' | 'skipped';

export interface MatrixTaskItemResult {
  accountId: string;
  state: MatrixItemState;
  reason?: string;
  publishedUrl?: string;
}

export interface MatrixTaskReport {
  platform: VideoPlatform;
  runOperationId: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  items: MatrixTaskItemResult[];
  charged?: { charged: number; balanceAfter?: number };
  billingStatus?: 'first_debit_requires_review' | 'confirmed' | 'rejected' | 'charge_uncertain' | 'acknowledged';
}

/** 发前登录检查:导航创作者中心 → 统一活体校验 checkKernelLogin(cookie 快筛 + 接口/跳转,见 kernelPool)。 */
async function checkLogin(accountId: string, platform: string, anchor: string): Promise<boolean | null> {
  // 导航失败(慢代理/内核繁忙)≠ 未登录 —— 继续在当前页做活体判定;判定本身抛异常同样不判过期
  // (铁律:只有明确证据才标 login_required;真没登录的话 driver 发布时还会撞登录墙,届时再标不迟)。
  // 之前 navigate 一抖就 return false → 好号被标过期 + 弹二维码窗,正是「好多号显示过期、点开却登录着」的来源之一。
  try {
    await kernelNavigate(accountId, anchor);
    await sleep(2000);
  } catch { /* ignore — 用当前页继续判定 */ }
  try {
    return await checkKernelLogin(accountId, platform);
  } catch {
    return null;
  }
}

const publishedSubjects = new WeakMap<MatrixTaskItemResult, DispatchSubject>();

async function runOne(
  opts: MatrixTaskOptions,
  accountId: string,
  index: number,
): Promise<MatrixTaskItemResult> {
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  const acc = getAccount(accountId);
  if (!acc) return { accountId, state: 'skipped', reason: 'account_not_found' };
  const principal = opts.principals?.get(accountId);
  const captured = principal && captureDispatchSubject(accountId);
  if (principal && (captured?.incarnation !== principal.incarnation || captured.subject !== principal.subject)) {
    return { accountId, state: 'skipped', reason: 'matrix_operation_subject_changed' };
  }
  if (acc.authority) {
    const view = selectAvailability(accountId);
    if (!view?.available) return { accountId, state: 'skipped', reason: view?.reasons[0] || view?.status || 'storage_or_migration_hold' };
  }
  if (acc.platform !== opts.platform) return { accountId, state: 'skipped', reason: 'platform_mismatch' };
  if (acc.status === 'banned' || acc.status === 'limited') {
    return { accountId, state: 'skipped', reason: 'account_' + acc.status };
  }

  const fence = captureAssociation(accountId);
  // 错峰:每号启动前随机停一下,避免齐刷刷一起开窗(行为关联信号)。
  await sleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000));

  let closeReason: string | undefined;   // 收口给 finally 判是否撞墙(此函数走 driver,无 finished 闭包)
  // launch 失败时 kernelPool 已回退本次的引用计数/使用锁,finally 不能再 closeKernel ——
  // 否则会错放【别的流程】正持有的锁 / 把它刚开的窗关掉(对齐 keepAliveOne 的 launched 守卫)。
  const current = () => !!fence && isCurrentAssociation(fence) && (!kernelReceipt || getSession(accountId)?.diagnosticsId === kernelReceipt.sessionInstanceId);
  let kernelReceipt: Awaited<ReturnType<typeof acquireKernel>> | undefined;
  try {
    if (opts.signal?.aborted || !current()) return { accountId, state: 'skipped', reason: 'aborted' };
    setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    const launchOptions = {
      accountId,
      signal: opts.signal,
      kernelPath: opts.kernelPath,
      kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir,
      fingerprint: acc.fingerprint,
      proxy: acc.proxy,
      headless: opts.headless,
      // 窗口左上角常驻角标(账号名 + 代理/本机 IP):所有任务执行都显示,便于核对在哪个号、走哪个 IP(撞 IP 会红)。
      label: accountBadgeLabel(acc),                       // 绿色角标:账号信息(平台·昵称·备注)
      groupTitle: matrixGroupTitle(opts.platform, opts.taskId), // 蓝色 pill:🤖 平台 #任务缩写(不重复账号信息)
    };
    kernelReceipt = await acquireKernel(launchOptions);
    if (!current()) return { accountId, state: 'skipped', reason: 'aborted' };

    // 发前登录检查(用 PUBLISHER_ANCHOR_URL,driver 内部也会再导航一次)。
    const anchorMod = await import('../video/publishers/publisherUtils');
    const anchor = anchorMod.PUBLISHER_ANCHOR_URL[opts.platform];
    if (anchor) {
      const ok = await checkLogin(accountId, platformKey(acc), anchor);
      if (!current() || opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
      if (ok === null) {
        setAccountStatus(accountId, 'limited', '登录状态未确认，请检查网络或页面后重试');
        return { accountId, state: 'skipped', reason: 'login_unknown' };
      }
      if (!ok) {
        setAccountStatus(accountId, 'login_required');
        // 命中失效 → 弹该号扫码窗(置顶 + 红角标 + 后台轮询扫码成功翻 idle),跟「刷新信息」口径对齐。
        // skipLease 自带 refCount+1 → 下面 finally 的 closeKernel 只 -1、不会关掉扫码窗。
        try { await promptReloginForExpiredAccount(accountId); } catch { /* 弹窗失败不影响跳过 */ }
        return { accountId, state: 'skipped', reason: 'login_required' };
      }
      markAccountAlive(accountId); // 确认登录有效 → 更新活跃时间,常跑的号不进主动保活名单。
    }

    const input = await opts.getInput(accountId, index);
    if (!current() || opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
    // 无内容(差异化产片失败 / inputs 映射缺该号)→ 跳过,不计失败、不计费。
    if (!input || !input.videoPath) {
      setAccountStatus(accountId, 'idle');
      return { accountId, state: 'skipped', reason: 'no_content' };
    }
    const subject = captureDispatchSubject(accountId, { instance: kernelReceipt.sessionInstanceId,
      connection: getSession(accountId)?.navigation?.snapshot().connectionEpoch,
      generation: getSession(accountId)?.navigation?.snapshot().generation });
    if (!subject) return { accountId, state: 'failed', reason: 'storage_or_migration_hold' };
    if (principal && (subject.incarnation !== principal.incarnation || subject.subject !== principal.subject)) {
      return { accountId, state: 'skipped', reason: 'matrix_operation_subject_changed' };
    }
    const r = await runMatrixDriver(accountId, opts.platform, input, log, kernelReceipt);

    if (r.ok) {
      const result: MatrixTaskItemResult = { accountId, state: 'success', publishedUrl: r.publishedUrl };
      publishedSubjects.set(result, subject);
      if (current()) {
        markPosted(accountId);
        setAccountStatus(accountId, 'idle');
      }
      return result;
    }
    // 限流类失败可在此识别 reason 关键字升级为 limited(MVP 先一律 idle)。
    if (current()) setAccountStatus(accountId, 'idle');
    closeReason = r.reason;
    return { accountId, state: 'failed', reason: r.reason };
  } catch (e: any) {
    if (current()) setAccountStatus(accountId, 'idle');
    if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' };
    return { accountId, state: 'failed', reason: 'runner_threw' };
  } finally {
    // 完成后留时间让用户检查浏览器里的结果再关窗(有 signal 时点「停止」立即关、不等)。
    // 普通 20s;撞到登录墙/验证墙留 60s,好让用户当场手动登录/过验证(2026-07-06 用户要求)。
    const _sig = opts.signal;
    if (kernelReceipt) {
      const holdMs = inspectHoldMs(closeReason);
      if (!_sig?.aborted) {
        await new Promise<void>((resolve) => {
          const t = setTimeout(resolve, holdMs);
          try { _sig?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true }); } catch { /* ignore */ }
        });
      }
      try { releaseKernel(kernelReceipt); } catch { /* ignore */ }
    }
  }
}

/** 限并发执行池(barrier:等全部完成)。 */
async function runPool(
  ids: string[],
  k: number,
  worker: (id: string, i: number) => Promise<MatrixTaskItemResult>,
  onItem?: (item: MatrixTaskItemResult) => void,
): Promise<MatrixTaskItemResult[]> {
  const results: MatrixTaskItemResult[] = new Array(ids.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const res = await worker(ids[i], i);
      results[i] = res;
      try { onItem?.(res); } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  return results;
}

/** 成功号数 → /api/matrix/charge(写公用钱包账本)。失败不阻塞主流程。 */
export async function chargeSuccess(
  platform: VideoPlatform, subjects: readonly DispatchSubject[], authToken?: string, runOperationId?: string,
): Promise<{ charged: number; balanceAfter?: number } | undefined> {
  if (!subjects.length || !authToken) return undefined;
  const { receipt, dispatch } = registerAggregateCharge(platform, subjects, runOperationId);
  if (!dispatch) return receipt.result === 'confirmed' && typeof receipt.charged === 'number'
    ? { charged: receipt.charged, balanceAfter: receipt.balanceAfter } : undefined;
  let result: 'confirmed' | 'rejected' | 'charge_uncertain' = 'charge_uncertain';
  let charged: { charged: number; balanceAfter?: number } | undefined;
  try {
    const res = await fetch(`${baseUrl()}/api/matrix/charge`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ platform, count: subjects.length }),
      signal: AbortSignal.timeout(20_000),
    });
    if (res.status === 402 || res.status === 401 || res.status === 403) result = 'rejected';
    else if (res.ok) {
      const data = await res.json();
      if (data?.ok === true && typeof data.charged === 'number' && Number.isFinite(data.charged)) {
        result = 'confirmed';
        charged = { charged: data.charged, balanceAfter: typeof data.balance_after === 'number' ? data.balance_after : undefined };
      } else if (data?.ok === false && ['insufficient_balance', 'invalid_platform'].includes(data.reason || data.error)) {
        result = 'rejected';
      }
    }
  } catch { /* A dispatched debit without a response is uncertain. */ }
  archiveDispatchedResult(receipt, result, charged);
  if (result !== 'confirmed') coworkLog('WARN', 'matrixTask', 'aggregate charge unresolved or rejected', { result });
  return charged;
}

type PublishExecutionOptions = Pick<MatrixTaskOptions, 'kernelPath' | 'headless' | 'concurrency' | 'jitterMinMs' | 'jitterMaxMs'>;
export function prepareMatrixPublishTask(opts: Pick<MatrixTaskOptions, 'platform' | 'taskId' | 'runOperationId' | 'authToken' | 'accountIds' | 'getInput'> & PublishExecutionOptions) {
  const request = bindPublishRequest(opts.platform, opts.taskId, opts.accountIds, !!opts.authToken, opts.getInput, opts);
  const { operation } = beginMatrixPublishOperation(request, opts.runOperationId, 'prepare');
  return { runOperationId: operation.id, status: operation.outcome ? 'finished' : operation.phase };
}

export async function runMatrixTask(opts: MatrixTaskOptions): Promise<MatrixTaskReport> {
  if (opts.runOperationId === undefined) throw Error('matrix_operation_id_required');
  opts.signal?.throwIfAborted();
  const request = bindPublishRequest(opts.platform, opts.taskId, opts.accountIds, !!opts.authToken, opts.getInput, opts);
  const { operation, started } = beginMatrixPublishOperation(
    request, opts.runOperationId, opts.recover ? 'recover' : 'start',
    () => {
      if (!request.execution.kernelPath && !installedKernelPath()) {
        throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
      }
    },
  );
  if (!started && !operation.outcome) throw Error('matrix_publish_recovery_required');
  opts.onOperation?.(operation.id);
  if (operation.outcome) return completeMatrixPublish(opts.platform, operation.id, operation.outcome, opts.authToken, true);
  const k = request.execution.concurrency; // 夹紧上限,防一次开几十个内核打爆内存
  coworkLog('INFO', 'matrixTask', `start ${opts.platform} x${opts.accountIds.length} (concurrency ${k})`);

  const runOptions = { ...opts, ...request.execution,
    getInput: (id: string) => request.inputs.get(id) as PublishInput,
    principals: new Map(operation.principals!.map(principal => [principal.accountId, principal])),
  };
  const items = await runPool([...request.inputs.keys()], k, (id, i) => runOne(runOptions, id, i), opts.onItem);

  const subjects = items.flatMap(item => {
    const subject = publishedSubjects.get(item);
    return subject ? [subject] : [];
  });
  const outcome = { items, subjects, billingEligible: !!operation.billingRequested && !opts.signal?.aborted };
  saveMatrixPublishOutcome(operation.id, outcome);
  return completeMatrixPublish(opts.platform, operation.id, outcome, opts.authToken);
}

async function completeMatrixPublish(platform: VideoPlatform, runOperationId: string,
  outcome: { items: MatrixTaskItemResult[]; subjects: DispatchSubject[]; billingEligible?: boolean },
  authToken?: string, recovery = false): Promise<MatrixTaskReport> {
  const { items, subjects } = outcome;
  const success = items.filter(x => x.state === 'success').length;
  const failed = items.filter(x => x.state === 'failed').length;
  const skipped = items.filter(x => x.state === 'skipped').length;
  const billingToken = outcome.billingEligible === false ? undefined : authToken;
  if (billingToken && subjects.length !== success) throw Error('storage_or_migration_hold');
  const report = { platform, runOperationId, total: items.length, success, failed, skipped, items };
  if (recovery && billingToken && subjects.length) {
    // The saved outcome does not prove who would fund an undispatched debit on this invocation.
    const prior = getAggregateChargeForRecovery(runOperationId, platform);
    const billingStatus = prior?.result === 'comment_pending' ? 'charge_uncertain'
      : prior ? prior.result ?? 'charge_uncertain' : 'first_debit_requires_review';
    const charged = prior?.result === 'confirmed' && typeof prior.charged === 'number'
      ? { charged: prior.charged, balanceAfter: prior.balanceAfter } : undefined;
    return { ...report, billingStatus, charged };
  }
  const charged = await chargeSuccess(platform, subjects, billingToken, runOperationId);
  return { ...report, charged };
}
