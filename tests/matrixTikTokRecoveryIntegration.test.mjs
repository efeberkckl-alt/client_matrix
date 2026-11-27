import assert from 'node:assert/strict';
import { virtualSafetyFs } from './helpers/virtualSafetyFs.mjs';
import { diagnosticAccountAlias, KernelNavigationError } from './helpers/kernelNavigationHarness.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as zod from 'zod';
import * as crypto from 'node:crypto';

const read = file => fs.readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
function select(file, names) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  const picked = ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)
    || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))));
  return picked.map(n => n.getText(ast).replace(/^export /, '')).join('\n');
}

// Use the actual saved-task entry, runner, shared login wrapper/DOM probe, account
// transitions and keepalive. Only disk, remote pack delivery and browser transport
// are replaced. The fixture orchestrator records entry without posting or charging.
function harness(mode = 'delayed') {
  let now = 1_000_000, nextTimer = 0, probeCount = 0, browserMode = 'visible', challengeSeen = false;
  let location = new URL('about:blank');
  const timers = new Map(), files = new Map(), logs = [], launches = [], urls = [], events = [];
  const sessions = new Map();
  const account = { id: '4', platform: 'tiktok', status: 'limited', lastAliveAt: 1, statusReason: 'login_unknown',
    recovery: { attempts: 4, nextCheckAt: now + 3_600_000, reason: 'login_unknown' } };
  class Clock extends Date { static now() { return now; } }
  const memoryFs = virtualSafetyFs(files);
  const base = { Date: Clock, URL, AbortController, AbortSignal, Buffer,
    process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: '/virtual' } },
    setTimeout: (fn, ms = 0) => { const id = ++nextTimer; timers.set(id, { fn, at: now + ms }); return id; },
    clearTimeout: id => timers.delete(id),
  };
  const modules = { fs: memoryFs, path, os, zod, crypto, './customCommentBatch': {}, '../../../types/matrixCommentPlan': {},
    '../coworkLogger': { coworkLog: (...args) => logs.push(args) },
    './commentLikeConfig': {}, './types': {}, './reportTaxonomy': {},
    './folderPost': { folderPostNextRunAt: () => now + 60_000, normSlots: v => v },
  };
  const load = file => {
    const module = { exports: {} };
    vm.runInNewContext(compile(read(file)), { ...base, module, exports: module.exports, require: name => {
      assert.ok(name in modules, `unexpected module ${name}`); return modules[name];
    } });
    return module.exports;
  };
  modules['../../../types/matrixCommentPolicy'] = load('../types/matrixCommentPolicy.ts');
  modules['../../../types/matrixCommentPosts'] = load('../types/matrixCommentPosts.ts');
  modules['./matrixSchedule'] = load('libs/matrix/matrixSchedule.ts');
  modules['./recovery'] = load('libs/matrix/recovery.ts');
  const store = load('libs/matrix/taskStore.ts'), runs = load('libs/matrix/runStore.ts');
  const { AutomationSafety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR } = load('libs/matrix/automationSafety.ts');
  const safety = new AutomationSafety('/virtual/safety.json');
  const node = { getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 200, height: 200 }),
    getAttribute: () => '/@fixture_self', querySelector: () => null };
  const document = {
    readyState: 'complete', body: { childElementCount: 1, innerText: '' },
    querySelector: selector => selector === '[data-e2e="nav-profile"]'
      && mode !== 'unknown' && !(mode === 'headless' && browserMode === 'headless')
      && !(mode === 'delayed' && probeCount < 3) ? node : null,
    querySelectorAll: selector => mode === 'challenge' && selector.startsWith('[id*="captcha"') ? [node] : [],
  };
  const ctx = vm.createContext({ ...base, fs: memoryFs, path, os, sessions,
    automationSafety: safety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR, KernelNavigationError, diagnosticAccountAlias,
    getAccount: () => account, listAccounts: () => [account], getSession: id => sessions.get(id),
    persist() {}, _accountSSEBroadcast: null, coworkLog: (...args) => logs.push(args),
    accountBadgeLabel: () => 'fixture 4', matrixGroupTitle: () => 'offline lead', platformKey: () => 'tiktok',
    launchKernel: async opts => {
      launches.push({ ...opts, before: structuredClone(account) }); browserMode = opts.headless ? 'headless' : 'visible';
      if (!opts.background) safety.begin(account.id, 'tiktok:4', 'offline-egress', () => {});
      sessions.set(account.id, { automation: !opts.background, background: opts.background, operationSignal: opts.signal });
    },
    closeKernel: () => { safety.end(account.id); sessions.delete(account.id); },
    getPage: async () => sessions.get(account.id),
    send: async () => ({ cookies: [{ name: 'sessionid', value: 'fixture-only', domain: '.tiktok.com' }] }),
    kernelNavigate: async (_id, url) => { urls.push(url); location = new URL(url); },
    kernelEval: async (_id, expression) => {
      if (expression.includes('(function')) probeCount++;
      // The challenge exists only during the shared checker and disappears on
      // its next page read. A caller cannot erase this evidence by rereading DOM.
      const transient = mode === 'transient' && expression === AUTOMATION_RESTRICTION_EXPR
        && sessions.get(account.id)?.loginChecks?.size && !challengeSeen;
      if (transient) document.body.innerText = 'Access Denied';
      const result = vm.runInNewContext(expression, { document, location, URL,
        getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) });
      if (transient) { challengeSeen = true; document.body.innerText = ''; }
      return result;
    },
    persistKernelCookies: async () => {}, sleep: async () => {}, emitAccount() {},
    abortableSleep: async () => {}, randInt: min => min, inspectHoldMs: () => 0,
    effectiveKeywords: () => [], engageHistoryFor: () => ({}), getNoobClawAuthToken: () => undefined,
    prepareTikTokLeadCommentTask: () => {}, makeAiCall: () => async () => { throw Error('AI forbidden in offline test'); },
    commentLangHint: () => '', leadEngageConfig: config => config, installedKernelPath: () => 'offline',
    withTikTokCommentPrompts: pack => pack, patchTikTokLeadScript: script => script,
    fetchEngagePack: async scenario => { assert.equal(scenario, 'tiktok_lead_engage'); return {
      orchestrator: "ctx.stepLog(1, 'info', 'OFFLINE_LEAD_ENTERED'); return {status:'ok'};",
    }; },
    PLATFORM_HOME: { tiktok: 'https://www.tiktok.com/' }, NO_KERNEL_ERROR: 'NO_KERNEL',
    chargeAction: async () => { throw Error('Billing forbidden in offline test'); },
    matrixCmd: async () => { throw Error('Browser mutation forbidden in offline test'); },
    MATRIX_MAX_CONCURRENT: 17, runningPlatforms: new Set(), runningTaskByPlatform: new Map(),
    runAccountsByPlatform: new Map(), abortByPlatform: new Map(), liveProgressByTask: new Map(), matrixScanWatching: new Set(),
    refreshMaxConcurrent: async () => {}, broadcastSSE: (...args) => events.push(args),
    require: name => {
      if (name.endsWith('/taskStore')) return store;
      if (name.endsWith('/runStore')) return runs;
      if (name.endsWith('/recovery')) return modules['./recovery'];
      if (name.endsWith('/accountManager')) return { getAccount: () => account, loadAccounts: () => [account] };
      if (name.endsWith('/kernelInstaller')) return { installedKernelPath: () => 'offline' };
      if (name.endsWith('/powerKeepAwake')) return { acquireSystemKeepAwake() {}, releaseSystemKeepAwake() {} };
      if (name.endsWith('/taskRunReporter')) return { scheduleMatrixRunReport() {} };
      if (name.endsWith('/engageRunner')) return { runEngageTask: opts => ctx.runEngageTask(opts) };
      if (name.endsWith('/proxyBridge')) return { probeAndSaveHealth: async () => {} };
      if (/Runner$/.test(name)) return {};
      throw Error(`Unexpected module ${name}`);
    },
  });
  const code = [
    'const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;',
    select('libs/matrix/recovery.ts', ['recoveryDelay', 'isRecoverableFailure']),
    select('libs/matrix/accountManager.ts', ['setAccountStatus', 'markAccountRecovery', 'markAccountAlive', 'markLoginRecheck']),
    select('libs/matrix/reloginPrompt.ts', ['LOGIN_URL', 'loginUrlFor']),
    select('libs/matrix/kernelPool.ts', ['kernelSignal', 'waitForKernel', 'LOGIN_COOKIES', 'LOGIN_DOMAINS', 'COOKIE_FASTPATH_EXEMPT',
      'STRICT_LOGIN_PLATFORMS', 'TIKTOK_SELF_PROFILE_URL', 'checkKernelLogin', 'checkKernelLoginInner', 'isAutomationPaused', 'runAutomationScript']),
    select('libs/matrix/keepAlive.ts', ['awaitingFirstLogin', 'keepAliveOne']),
    select('libs/matrix/engageRunner.ts', ['runOne', 'runPool', 'runEngageTask']),
    select('sidecar-server.ts', ['finishMatrixTaskRun', 'runMatrixTaskById']),
  ].join('\n');
  vm.runInContext(compile(code), ctx);
  const task = store.saveTask({ platform: 'tiktok', type: 'lead_engage', accountIds: ['4'], enabled: true, frequency: 'once',
    leadEngage: { mode: 'keywords', keywords: ['fixture'], doLike: false, doComment: false, doFollow: false } }).task;
  async function drain(work, until = () => false) {
    let done = false, result, error;
    work.then(value => { done = true; result = value; }, value => { done = true; error = value; });
    for (let i = 0; i < 500; i++) {
      await new Promise(setImmediate);
      if (done && !until()) { if (error) throw error; return result; }
      const next = [...timers.entries()].sort((a, b) => a[1].at - b[1].at)[0];
      if (next) { timers.delete(next[0]); now = next[1].at; next[1].fn(); }
    }
    throw Error('Offline integration did not settle');
  }
  return { ctx, account, logs, launches, urls, timers, sessions, task,
    entered: () => events.some(([, event]) => event.msg?.includes('OFFLINE_LEAD_ENTERED')),
    runSaved: manual => drain(ctx.runMatrixTaskById(task.id, undefined, manual), () => ctx.runningPlatforms.size > 0),
    keepAlive: () => drain(ctx.keepAliveOne(account.id)),
    result: () => ctx.liveProgressByTask.get(task.id),
  };
}

test('account 4 explicit saved-task retry waits for real TikTok evidence then enters lead orchestration', async () => {
  const h = harness();
  const before = structuredClone(h.account);
  await h.runSaved(false);
  assert.equal(h.entered(), false); assert.equal(h.launches.length, 0);
  assert.deepEqual(h.account, before);
  await h.runSaved(true);
  assert.equal(h.entered(), true, JSON.stringify(h.logs));
  assert.equal(h.account.status, 'idle'); assert.equal(h.account.recovery, undefined);
  assert.deepEqual(h.launches[0].before, before, 'manual retry cannot clear hold before verification');
  const login = h.logs.find(([, tag]) => tag === 'matrix-login');
  assert.equal(login[3].result, true); assert.ok(login[3].attempts >= 2);
  assert.equal(h.sessions.size, 0); assert.equal(h.timers.size, 0);
});

test('real shared login and keepalive recover headless unknown once, then the saved lead run succeeds', async () => {
  const h = harness('headless');
  await h.keepAlive();
  assert.equal(h.launches.length, 2); assert.equal(h.launches[0].headless, true);
  assert.equal(h.launches[1].headless, undefined); assert.equal(h.account.status, 'idle');
  assert.ok(h.urls.every(url => url === 'https://www.tiktok.com/'));
  await h.runSaved(false);
  assert.equal(h.entered(), true); assert.equal(h.sessions.size, 0); assert.equal(h.timers.size, 0);
});

test('manual retry with genuinely unknown login never enters lead and schedules recovery', async () => {
  const h = harness('unknown');
  await h.runSaved(true);
  assert.equal(h.entered(), false); assert.equal(h.account.status, 'limited');
  assert.equal(h.account.recovery.reason, 'login_unknown');
  assert.equal(h.sessions.size, 0); assert.equal(h.timers.size, 0);
});

test('hard holds survive explicit saved-task retry with no browser launch or billing', async () => {
  for (const hold of ['forbidden', 'captcha', 'billing', 'disconnect', 'binding', 'cooldown']) {
    const h = harness();
    if (hold === 'forbidden' || hold === 'captcha') { delete h.account.recovery; h.account.statusReason = hold; }
    if (hold === 'billing') h.account.chargeUncertain = { action: 'comment', at: 1 };
    if (hold === 'disconnect') h.account.manualDisconnect = true;
    if (hold === 'binding') h.account.bindingConflict = true;
    if (hold === 'cooldown') h.account.recovery.reason = 'rate_limited';
    const before = structuredClone(h.account);
    await h.runSaved(true);
    assert.equal(h.entered(), false, hold); assert.equal(h.launches.length, 0, hold);
    assert.deepEqual(h.account, before, hold);
  }
});

test('a transient restriction observed inside shared login cannot disappear into retry success', async () => {
  for (const entry of ['keepalive', 'saved task']) {
    const h = harness('transient');
    if (entry === 'keepalive') await h.keepAlive(); else await h.runSaved(true);
    assert.equal(h.entered(), false, entry); assert.equal(h.launches.length, 1, entry);
    assert.equal(h.account.status, 'limited'); assert.equal(h.account.recovery, undefined);
    assert.match(h.account.statusReason, /forbidden/);
    assert.equal(h.logs.filter(([, tag]) => tag === 'matrix-login').length, 1);
    assert.equal(h.sessions.size, 0); assert.equal(h.timers.size, 0);
  }
});
