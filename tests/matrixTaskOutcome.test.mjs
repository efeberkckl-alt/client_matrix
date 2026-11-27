import assert from 'node:assert/strict';
import { virtualSafetyFs } from './helpers/virtualSafetyFs.mjs';
import { diagnosticAccountAlias, KernelNavigationError } from './helpers/kernelNavigationHarness.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = (name) => fs.readFileSync(new URL(name, import.meta.url), 'utf8');
const parse = (name) => ts.createSourceFile(name, read(name), ts.ScriptTarget.Latest, true);
const kernel = parse('../src/main/libs/matrix/kernelPool.ts');
const runner = parse('../src/main/libs/matrix/engageRunner.ts');
const accountsSource = parse('../src/main/libs/matrix/accountManager.ts');
const recoverySource = parse('../src/main/libs/matrix/recovery.ts');
const functions = (ast, names) => ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map((n) => n.getText(ast).replace(/^export /, '')).join('\n');
function evaluate(source, context) {
  const js = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
  return runInNewContext(js, context);
}

function harness() {
  const files = new Map(), logs = [], progress = [], launchSignals = [], chargeSignals = [], prepared = [];
  let billingResult = { ok: true, charged: 3, cost_usd: 0.1 };
  const memoryFs = virtualSafetyFs(files);
  const module = { exports: {} };
  evaluate(read('../src/main/libs/matrix/automationSafety.ts'), {
    module, exports: module.exports, require: (name) => ({ fs: memoryFs, path, os, crypto })[name],
    process: { pid: process.pid, kill: process.kill, env: {} }, AbortController, setTimeout, clearTimeout, URL,
  });
  const { AutomationSafety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR } = module.exports;
  const safety = new AutomationSafety('/virtual/safety.json');
  const controller = new AbortController();
  const account = { id: 'a', platform: 'tiktok', status: 'idle', keywords: ['test'] };
  let restriction = '', cookieFailure = false, loginResult = true;
  const prechecks = [];
  const session = {};
  let loginHook;
  let launchFailure;
  let leadScript = "ctx.stepLog(1, 'info', 'lead orchestrator entered'); return {status:'ok'};";
  const context = {
    fs: memoryFs, path, os, process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: '/virtual' } }, Buffer, AbortSignal,
    automationSafety: safety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR, KernelNavigationError, diagnosticAccountAlias,
    getAccount: () => account, getPage: async () => ({}),
    cookieMutation: async () => { if (cookieFailure) throw Error('CDP failed'); return {}; },
    kernelEval: async () => { if (restriction instanceof Error) throw restriction; return restriction; },
    getSession: () => session,
    kernelNavigate: async () => {}, checkKernelLogin: async () => { prechecks.push(['login', structuredClone(account)]); return loginHook ? loginHook() : loginResult; },
    launchKernel: async opts => {
      launchSignals.push(opts.signal); prechecks.push(['egress', structuredClone(account)]);
      if (launchFailure) throw launchFailure;
      safety.begin('a', 'tiktok:a', 'g', () => {});
    },
    closeKernel: () => safety.end('a'),
    setAccountStatus: (_id, status, reason) => { account.status = status; account.statusReason = reason; },
    coworkLog: (...args) => logs.push(args),
    persist() {}, _accountSSEBroadcast: null, accountBadgeLabel: () => 'a', matrixGroupTitle: () => 'task',
    platformKey: () => 'tiktok', effectiveKeywords: () => ['test'],
    engageHistoryFor: () => ({}), getNoobClawAuthToken: () => undefined,
    abortableSleep: async () => {}, randInt: (min) => min, inspectHoldMs: () => 0,
    prepareTikTokLeadCommentTask: () => undefined, makeAiCall: () => async () => ({}), commentLangHint: () => '',
    leadEngageConfig: (config) => config, installedKernelPath: () => 'offline',
    withTikTokCommentPrompts: (pack) => pack, patchTikTokLeadScript: (script) => script,
    fetchEngagePack: async (scenarioId) => { assert.equal(scenarioId, 'tiktok_lead_engage'); return { orchestrator: leadScript }; },
    normalizeCustomCommentPolicy: () => ({}),
    PLATFORM_HOME: { tiktok: 'https://www.tiktok.com/' }, NO_KERNEL_ERROR: 'NO_KERNEL',
    commentPostKey: post => JSON.stringify([post.url.split('/').at(-1), post.text]),
    chargeAction: async (_auth, _action, _platform, _ref, signal) => {
      chargeSignals.push(signal);
      return billingResult;
    },
    matrixCmd: async (_id, command) => {
      if (command === '403') { safety.halt('a', 'forbidden', 0, 'HTTP 403'); safety.assertAllowed('a'); }
      if (command === 'login') restriction = 'login_wall';
      if (command === 'cancel') controller.abort();
    },
  };
  const api = evaluate(`
    const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;
    ${functions(recoverySource, ['recoveryDelay', 'isRecoverableFailure'])}
    ${functions(accountsSource, ['setAccountStatus', 'markAccountRecovery', 'markAccountAlive', 'markAccountChargeUncertain'])}
    ${functions(kernel, ['isAutomationPaused', 'runAutomationScript', 'kernelClearCookies'])}
    ${functions(runner, ['runOne', 'runPool', 'runEngageTask'])}
    ({runOne, runEngageTask, kernelClearCookies});
  `, context);
  return {
    ...api, account, files, logs, progress, controller, prechecks, safety,
    login: (result) => { loginResult = result; },
    loginSequence: (hook) => { loginHook = hook; }, session,
    leadScript: (script) => { leadScript = script; },
    failLaunch: (failure) => { launchFailure = failure; },
    failCookies: () => { cookieFailure = true; },
    restrict: (reason) => { restriction = reason; },
    workbook: script => {
      billingResult = { ok: false, reason: 'insufficient_balance' };
      const fuse = new AbortController();
      const stopSignal = AbortSignal.any([controller.signal, fuse.signal]);
      let reason = '';
      const charge = { get reason() { return reason; }, set reason(value) { reason = value; fuse.abort(); } };
      const posts = ['one', 'two'].map(text => ({ url: 'https://www.tiktok.com/@fixture/video/1', text }));
      return api.runOne({ platform: 'tiktok', taskType: 'comment_like', commentMode: 'custom', signal: controller.signal },
        { orchestrator: script }, 'a', charge, { round: { attempted: 0, confirmed: 0, restedAt: 0 },
          batch: { pendingFor: () => [], prepare: (key) => prepared.push(key) }, posts, stopSignal,
        });
    },
    launchSignals, chargeSignals, prepared,
    run: (script) => api.runOne({
      platform: 'tiktok', taskType: 'comment_like', taskId: 'task-a', signal: controller.signal,
      onLog: (_id, message) => progress.push(message),
    }, { orchestrator: script }, 'a'),
  };
}

test('startup terminal in the real engagement runner contains its category only', async () => {
  const h = harness();
  const error = new Error('kernel_start:process_exited');
  error.stack = 'D:/synthetic-private-profile/kernel.log';
  h.failLaunch(error);
  const result = await h.run('throw new Error("unexpected launch success")');
  assert.equal(result.state, 'failed');
  assert.match(result.reason, /kernel_start:process_exited/);
  assert.equal(JSON.stringify([h.logs, h.progress, result]).includes('synthetic-private-profile'), false);
  assert.equal(h.prechecks.some(([stage]) => stage === 'login'), false);
});

test('workbook runner never dispatches a debit even when the legacy callback is called', async () => {
  const h = harness();
  const result = await h.workbook(`
    ctx.prepareCustomComment('["1","one"]', {});
    const debit = await ctx.chargeAction('comment', 'tiktok');
    if (!debit.ok || debit.charged !== 0) throw Error('prewritten debit was not suppressed');
    if ((await ctx.charge('like', 'tiktok')).ok) throw Error('mixed action incorrectly enabled on the workbook path');
    ctx.prepareCustomComment('["1","two"]', {});
  `);
  assert.equal(result.state, 'success');
  assert.equal(result.chargedCredits, 0);
  assert.deepEqual(h.prepared, ['["1","one"]', '["1","two"]']);
  assert.equal(h.launchSignals[0].aborted, false);
  assert.deepEqual(h.chargeSignals, []);
  assert.equal(h.controller.signal.aborted, false);
  assert.equal(h.safety.isActive('a'), false);
});

test('explicit manual lead run rechecks technical backoff without clearing account state before verification', async () => {
  for (const manualRetry of [undefined, false, true]) {
    const h = harness();
    Object.assign(h.account, { status: 'limited', statusReason: 'login_unknown', recovery: { attempts: 5, nextCheckAt: Date.now() + 3600000, reason: 'login_unknown' } });
    const before = structuredClone(h.account);
    const result = await h.runEngageTask({ platform: 'tiktok', taskType: 'lead_engage', taskId: 'lead-task', accountIds: ['a'], manualRetry,
      leadEngage: { mode: 'keywords', keywords: ['test'], doLike: false, doComment: false, doFollow: false },
      onLog: (_id, message) => h.progress.push(message),
    });
    if (!manualRetry) {
      assert.equal(result.items[0].reason, 'recovery_pending');
      assert.deepEqual(h.account, before); assert.equal(h.prechecks.length, 0);
    } else {
      assert.equal(result.success, 1);
      assert.deepEqual(h.prechecks.map(([kind]) => kind), ['egress', 'login']);
      for (const [, snapshot] of h.prechecks) assert.deepEqual(snapshot, before, 'preflight must not reset the soft hold');
      assert.ok(h.progress.some((message) => message.includes('lead orchestrator entered')));
      assert.equal(h.account.status, 'idle'); assert.equal(h.account.recovery, undefined);
    }
  }
});

test('manual lead retry retains unknown login and cannot enter orchestration through hard holds or cooldown', async () => {
  for (const mode of ['unknown', 'forbidden', 'captcha', 'billing', 'disconnect', 'cooldown', 'safety']) {
    const h = harness();
    Object.assign(h.account, { status: 'limited', statusReason: 'login_unknown', recovery: { attempts: 5, nextCheckAt: Date.now() + 3600000, reason: 'login_unknown' } });
    if (mode === 'unknown') h.login(null);
    if (mode === 'forbidden' || mode === 'captcha') { delete h.account.recovery; h.account.statusReason = mode; }
    if (mode === 'billing') h.account.chargeUncertain = { action: 'comment', at: Date.now() };
    if (mode === 'disconnect') h.account.manualDisconnect = true;
    if (mode === 'cooldown') { h.account.recovery.reason = 'rate_limited'; h.account.statusReason = '平台明确限制操作频率'; }
    if (mode === 'safety') { h.safety.begin('a', 'tiktok:a', 'g', () => {}); h.safety.halt('a', 'forbidden'); h.safety.end('a'); }
    const before = structuredClone(h.account);
    h.leadScript("throw Error('must not enter lead orchestrator');");
    const result = await h.runEngageTask({ platform: 'tiktok', taskType: 'lead_engage', accountIds: ['a'], manualRetry: true });
    assert.equal(result.success, 0, mode);
    assert.doesNotMatch(result.items[0].reason, /must not enter/);
    if (mode === 'unknown') {
      assert.equal(result.items[0].reason, 'login_unknown'); assert.equal(h.account.status, 'limited');
      assert.ok(h.account.recovery.nextCheckAt > Date.now());
    } else if (mode !== 'safety') {
      assert.deepEqual(h.account, before, mode); assert.equal(h.prechecks.length, 0, mode);
    }
  }
});

test('a challenge observed by the shared login check cannot disappear across runner retries', async () => {
  for (const restriction of ['captcha', 'forbidden', 'account_flag', 'login_wall', 'rate_limited']) {
    const h = harness();
    Object.assign(h.account, { status: 'limited', statusReason: 'login_unknown', recovery: { attempts: 4, nextCheckAt: Date.now() + 3600000, reason: 'login_unknown' } });
    let checks = 0;
    h.loginSequence(() => {
      if (++checks > 1) return true;
      h.session.loginRestriction = restriction;
      if (restriction === 'rate_limited') {
        h.account.statusReason = '平台明确限制操作频率';
        h.account.recovery = { attempts: 1, nextCheckAt: Date.now() + 3600000, reason: 'rate_limited' };
      } else { h.account.statusReason = restriction; delete h.account.recovery; }
      return null;
    });
    h.leadScript("throw Error('must not enter lead orchestrator');");
    const result = await h.runEngageTask({ platform: 'tiktok', taskType: 'lead_engage', accountIds: ['a'], manualRetry: true });
    assert.equal(result.items[0].reason, restriction); assert.equal(result.failed, 1);
    assert.equal(checks, 1, 'a later valid login must not wash away an observed challenge');
    assert.equal(h.account.status, 'limited');
    if (restriction === 'rate_limited') assert.equal(h.account.recovery.reason, 'rate_limited');
    else assert.equal(h.account.recovery, undefined);
  }
});

const reports = `
  ctx.addActionCount('comment', 2);
  await ctx.chargeAction('comment', 'tiktok');
  ctx.stepLog(1, 'warn', 'diagnostic warning');
  ctx.stepLog(1, 'error', 'diagnostic error');
  await ctx.writeReport('run.md', 'partial report');
  await ctx.writeReport('customers.txt', 'shared ledger', {scope:'account'});
  await ctx.writeReport('data.json', '{"valid":true}');
`;

test('technical failure waits for a bounded probe then recovers; platform and billing holds do not', async () => {
  const h = harness();
  const failure = await h.run("throw Error('ECONNRESET');");
  assert.equal(failure.state, 'failed');
  assert.equal(h.account.recovery.attempts, 1);
  assert.equal((await h.run("return {status:'ok'}")).reason, 'recovery_pending');
  h.account.recovery.nextCheckAt = Date.now() - 1;
  await h.run("throw Error('ECONNRESET');");
  assert.equal(h.account.recovery.attempts, 2);
  assert.ok(h.account.recovery.nextCheckAt - Date.now() > 290000);
  h.account.recovery.nextCheckAt = Date.now() - 1;
  assert.equal((await h.run("ctx.finish('done'); return {status:'ok'}")).state, 'success');
  assert.equal(h.account.status, 'idle');
  assert.equal(h.account.recovery, undefined);
  await h.run("await ctx.browser('403');");
  assert.equal(h.account.recovery, undefined);
  assert.equal((await h.run("return {status:'ok'}")).reason, 'account_limited');
  h.account.chargeUncertain = { action: 'comment', platform: 'tiktok', at: Date.now() };
  assert.equal((await h.run("return {status:'ok'}")).reason, 'charge_uncertain');
});

test('a manually disconnected account is never launched or changed by automatic work', async () => {
  const h = harness();
  h.account.status = 'login_required'; h.account.manualDisconnect = true;
  assert.equal((await h.run("throw Error('must never execute')")).reason, 'manual_disconnect');
  assert.equal(h.account.status, 'login_required');
  assert.equal(h.account.recovery, undefined);
});

test('real runner preserves partial counts and cost while 403/late login modal cannot become success', async () => {
  for (const command of ['403', 'login']) {
    const h = harness();
    const result = await h.run(`${reports}
      try { await ctx.browser('${command}'); } catch {}
      ctx.finish('done'); return {status:'ok'};
    `);
    assert.equal(result.state, 'failed', command);
    assert.equal(result.counts.comment, 2, result.reason);
    assert.equal(result.chargedCredits, 3);
    assert.equal(h.account.status, 'limited');
    assert.match(h.account.statusReason, command === '403' ? /拒绝访问/ : /页面要求登录或验证/);
    assert.ok(h.logs.some(([level, tag, message]) => level === 'WARN' && tag === 'engage-step' && message.includes('[a] task=task-a')));
    assert.ok(h.logs.some(([level, tag]) => level === 'ERROR' && tag === 'engage-step'));
    assert.ok(h.logs.some(([, tag, , data]) => tag === 'matrix-task' && data.state === 'failed' && data.counts.comment === 2));
    const entries = [...h.files];
    assert.match(entries.find(([file]) => file.endsWith('run.md'))[1], /任务终态：失败\/待检查/);
    assert.equal(entries.find(([file]) => file.endsWith('customers.txt'))[1], 'shared ledger');
    assert.equal(entries.find(([file]) => file.endsWith('data.json'))[1], '{"valid":true}');
  }
});

test('terminal restrictions, failed page and unavailable CDP cannot be reported as success', async () => {
  for (const reason of ['captcha', 'rate_limited', 'forbidden', 'account_flag', 'page_error:ERR_PROXY_CONNECTION_FAILED', new Error('CDP failed'), undefined, null]) {
    const h = harness();
    h.restrict(reason);
    const result = await h.run(`${reports} ctx.finish('done'); return {status:'ok'};`);
    assert.equal(result.state, 'failed', String(reason));
    assert.equal(h.account.status, 'limited');
    assert.ok(h.account.statusReason);
    assert.equal(result.counts.comment, 2);
    assert.equal(result.chargedCredits, 3);
    assert.match([...h.files].find(([file]) => file.endsWith('run.md'))[1], /任务终态：失败\/待检查/);
    if (typeof reason !== 'string' || reason.startsWith('page_error:')) assert.match(result.reason, /请检查/);
  }
});

test('user cancellation is skipped with retained counts; remote error cannot be overwritten by done', async () => {
  const cancelled = harness();
  const result = await cancelled.run(`${reports} await ctx.browser('cancel'); ctx.finish('done'); return {status:'ok'};`);
  assert.equal(result.state, 'skipped', result.reason);
  assert.equal(result.reason, 'aborted');
  assert.equal(result.counts.comment, 2);
  assert.equal(result.chargedCredits, 3);
  assert.equal(cancelled.account.status, 'idle');
  assert.match([...cancelled.files].find(([file]) => file.endsWith('run.md'))[1], /已跳过\/停止；原因：aborted/);
  for (const script of [
    `ctx.finish('error','remote_failure'); ctx.finish('done'); return {status:'ok'};`,
    `ctx.finish('failed','remote_failure'); ctx.finish('done'); return {status:'ok'};`,
    `return {status:'failed',reason:'remote_failure'};`,
  ]) {
    const h = harness();
    const result = await h.run(script);
    assert.equal(result.state, 'failed');
    assert.equal(result.reason, 'remote_failure');
    assert.equal(h.account.status, 'limited');
  }
  const success = harness();
  assert.equal((await success.run(`ctx.finish('done'); return {status:'ok'};`)).state, 'success');
  assert.equal(success.account.status, 'idle');
});

test('cookie clearing audits both outcomes and propagates failure to explicit disconnect', async () => {
  const h = harness();
  await h.kernelClearCookies('a');
  h.failCookies();
  await assert.rejects(h.kernelClearCookies('a'), /CDP failed/);
  assert.ok(h.logs.some(([level, tag]) => level === 'INFO' && tag === 'matrix-cookies'));
  assert.ok(h.logs.some(([level, tag]) => level === 'ERROR' && tag === 'matrix-cookies'));
  const ast = parse('../src/main/sidecar-server.ts');
  let entry;
  function find(n) {
    if (ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === 'matrix:disconnectAccount') entry = n;
    ts.forEachChild(n, find);
  }
  find(ast);
  const account = { id: 'a' }, calls = [];
  const deps = {
    getAccount: () => account, isAccountBusy: () => false, accountBadgeLabel: () => 'a',
    launchKernel: async () => {}, closeKernel: () => calls.push('close'),
    kernelClearCookies: async () => { throw Error('CDP failed'); },
    setAccountStatus: () => calls.push('status'), clearAccountIdentity: () => calls.push('identity'),
    markManualDisconnect: () => calls.push('disconnect'),
  };
  const api = evaluate(`async function run(){${entry.statements.map((s) => s.getText(ast)).join('\n')}};run;`, {
    require: () => deps, args: [{accountId:'a'}], res: {},
    writeJSON: (_res, _status, value) => value, broadcastSSE: () => calls.push('broadcast'),
  });
  assert.equal((await api()).ok, false);
  assert.deepEqual(calls, ['close']);
});
