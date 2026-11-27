import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import * as zod from 'zod';
import * as crypto from 'node:crypto';

const read = (file) => fs.readFileSync(new URL(`../src/main/${file}`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const sidecar = ts.createSourceFile('sidecar.ts', read('sidecar-server.ts'), ts.ScriptTarget.Latest, true);
const functions = ['finishMatrixTaskRun', 'runMatrixTaskById', 'startMatrixScheduler'].map((name) => sidecar.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(sidecar)).join('\n');

test('saved lead tasks forward explicit manual intent and scheduled runs keep recovery timing', async () => {
  for (const manual of [false, true]) {
    const h = harness();
    h.store.saveTask({ ...h.task, type: 'lead_engage', leadEngage: { mode: 'keywords', keywords: ['test'] } });
    let forwarded;
    h.runWith(async (opts) => { forwarded = opts; return { items: [{ accountId: 'a', state: 'success' }] }; });
    assert.equal((await h.runMatrixTaskById(h.task.id, undefined, manual)).ok, true);
    await h.settle();
    assert.equal(forwarded.taskType, 'lead_engage'); assert.equal(forwarded.manualRetry, manual);
    assert.equal(forwarded.leadEngage.mode, 'keywords');
  }
});

function harness(frequency = '30min') {
  let now = 1_000_000;
  class Clock extends Date { static now() { return now; } }
  const files = new Map(), logs = [], events = [], timers = [], power = [];
  const memoryFs = {
    existsSync: (file) => files.has(file), mkdirSync() {},
    readFileSync: (file) => { if (!files.has(file)) throw Error('missing'); return files.get(file); },
    writeFileSync: (file, value) => files.set(file, value),
    renameSync: (from, to) => { files.set(to, files.get(from)); files.delete(from); },
    copyFileSync: (from, to) => files.set(to, files.get(from)),
  };
  const base = { Date: Clock, Math: Object.assign(Object.create(Math), { random: () => 0 }), process: { env: { NOOBCLAW_MATRIX_DIR: '/virtual' } } };
  const modules = {
    fs: memoryFs, path, os: { homedir: () => '/virtual' }, zod, crypto, './customCommentBatch': {},
    '../coworkLogger': { coworkLog: (...args) => logs.push(args) },
    './commentLikeConfig': {}, './types': {}, './reportTaxonomy': {},
    './folderPost': { folderPostNextRunAt: () => now + 60_000, normSlots: (v) => v },
  };
  const load = (file) => {
    const module = { exports: {} };
    vm.runInNewContext(compile(read(file)), { ...base, module, exports: module.exports, require: (name) => {
      assert.ok(name in modules, name); return modules[name];
    } });
    return module.exports;
  };
  modules['./matrixSchedule'] = load('libs/matrix/matrixSchedule.ts');
  modules['./recovery'] = load('libs/matrix/recovery.ts');
  modules['../../../types/matrixCommentPolicy'] = load('../types/matrixCommentPolicy.ts');
  modules['../../../types/matrixCommentPosts'] = load('../types/matrixCommentPosts.ts');
  modules['../../../types/matrixCommentPlan'] = {};
  let store = load('libs/matrix/taskStore.ts');
  const runs = load('libs/matrix/runStore.ts');
  const task = store.saveTask({ platform: 'tiktok', type: 'engage', accountIds: ['a'], enabled: true, frequency }).task;
  const accounts = new Map([['a', { id: 'a', platform: 'tiktok', displayName: 'test' }]]);
  let run = async () => ({ items: [{ accountId: 'a', state: 'success', counts: { comment: 2 }, chargedCredits: 3 }] });
  let startupFailure = false;
  const globals = {
    ...base, AbortController, MATRIX_MAX_CONCURRENT: 17,
    runningPlatforms: new Set(), runningTaskByPlatform: new Map(), runAccountsByPlatform: new Map(), abortByPlatform: new Map(), liveProgressByTask: new Map(), matrixScanWatching: new Set(),
    refreshMaxConcurrent: async () => {}, coworkLog: (...args) => logs.push(args),
    broadcastSSE: (...args) => events.push(args),
    setInterval: (fn) => { timers.push(fn); },
    require: (name) => {
      if (name.endsWith('/taskStore')) return store;
      if (name.endsWith('/runStore')) return runs;
      if (name.endsWith('/recovery')) return modules['./recovery'];
      if (name.endsWith('/accountManager')) return { getAccount: (id) => accounts.get(id), loadAccounts: () => [...accounts.values()] };
      if (name.endsWith('/kernelInstaller')) return { installedKernelPath: () => 'offline' };
      if (name.endsWith('/powerKeepAwake')) return { acquireSystemKeepAwake: (owner) => power.push(['acquire', owner]), releaseSystemKeepAwake: (owner) => power.push(['release', owner]) };
      if (name.endsWith('/taskRunReporter')) return { scheduleMatrixRunReport() {} };
      if (name.endsWith('/engageRunner')) { if (startupFailure) throw Error('startup script invalid'); return { runEngageTask: (opts) => run(opts) }; }
      if (/Runner$/.test(name)) return {};
      throw Error(`Unexpected module ${name}`);
    },
  };
  const api = vm.runInNewContext(compile(functions + '\n({finishMatrixTaskRun,runMatrixTaskById,startMatrixScheduler});'), globals);
  const settle = async () => { for (let i = 0; i < 30; i++) await new Promise(setImmediate); };
  return {
    ...api, task, files, logs, events, globals, accounts, runs, power, timers, settle,
    get store() { return store; }, now: () => now, advance: (ms) => { now += ms; },
    runWith: (fn) => { run = fn; }, failStartup: () => { startupFailure = true; },
    reload: () => { store = load('libs/matrix/taskStore.ts'); return store.getTask(task.id); },
  };
}

test('technical retries persist 1/5/15/60 minute backoff across reload; once remains manual', () => {
  const h = harness();
  for (const minutes of [1, 5, 15, 60, 60]) {
    h.store.finishTaskRun(h.task.id, h.now(), { state: 'failed', reason: 'fetch failed' });
    const task = h.reload();
    assert.equal(task.nextPlannedRunAt, h.now() + minutes * 60_000);
    assert.equal(task.lastError, 'fetch failed');
    assert.equal(h.store.dueTasks(h.now()).length, 0);
    h.advance(minutes * 60_000);
    assert.equal(h.store.dueTasks(h.now()).length, 1);
  }
  assert.equal(h.store.getTask(h.task.id).retryCount, 5);
  const once = harness('once');
  once.store.finishTaskRun(once.task.id, once.now(), { state: 'failed', reason: 'fetch failed' });
  assert.equal(once.reload().frequency, 'once');
  assert.equal(once.store.getTask(once.task.id).nextPlannedRunAt, undefined);
  assert.equal(once.store.dueTasks(Number.MAX_SAFE_INTEGER).length, 0);
});

test('unknown errors pause until edit or explicit retry; stop uses normal period', () => {
  const h = harness();
  h.store.finishTaskRun(h.task.id, h.now(), { state: 'failed', reason: '服务器剧本不兼容' });
  assert.equal(h.reload().recoveryPaused, true);
  assert.equal(h.store.dueTasks(Number.MAX_SAFE_INTEGER).length, 0);
  h.store.clearTaskRecovery(h.task.id);
  assert.equal(h.reload().recoveryPaused, undefined);
  h.store.finishTaskRun(h.task.id, h.now(), { state: 'stopped', reason: 'aborted' });
  assert.equal(h.reload().nextPlannedRunAt, h.now() + 31 * 60_000);
  assert.equal(h.store.getTask(h.task.id).retryCount, undefined);
  h.store.finishTaskRun(h.task.id, h.now(), { state: 'failed', reason: 'bad script' });
  const edited = h.store.saveTask({ ...h.store.getTask(h.task.id), name: 'edited' });
  assert.equal(edited.ok, true);
  assert.equal(h.reload().recoveryPaused, undefined);
  assert.equal(h.store.getTask(h.task.id).lastError, undefined);
});

test('actual sidecar records success, rejected run and synchronous startup failure exactly once', async () => {
  for (const mode of ['success', 'reject', 'startup']) {
    const h = harness();
    if (mode === 'reject') h.runWith(async (opts) => { opts.onItem({ accountId: 'a', state: 'success', counts: { comment: 2 }, chargedCredits: 3 }); throw Error('fetch failed'); });
    if (mode === 'startup') h.failStartup();
    await h.runMatrixTaskById(h.task.id, undefined, true);
    await h.settle();
    const records = h.runs.listRuns();
    assert.equal(records.length, 1, `${mode}: ${JSON.stringify(h.logs)}`);
    assert.equal(records[0].state, mode === 'success' ? 'success' : 'failed');
    assert.equal(h.globals.runningPlatforms.size, 0);
    if (mode !== 'startup') { assert.equal(records[0].totals.comment, 2); assert.equal(records[0].cost.credits, 3); }
    if (mode === 'reject') { assert.equal(records[0].success, 0); assert.equal(h.store.getTask(h.task.id).nextPlannedRunAt, h.now() + 60_000); }
    if (mode === 'startup') assert.equal(h.store.getTask(h.task.id).recoveryPaused, true);
  }
});

test('resolved all-failed, partial success, account pauses and cancellation have distinct scheduling', async () => {
  const cases = [
    { items: [{ accountId: 'a', state: 'failed', reason: 'fetch failed' }], state: 'failed', gap: 60_000 },
    { items: [{ accountId: 'a', state: 'skipped', reason: 'network_error:scenario_unavailable' }], state: 'failed', gap: 60_000 },
    { items: [{ accountId: 'a', state: 'skipped', reason: 'no_scenario(后端未部署)' }], state: 'failed', paused: true },
    { items: [{ accountId: 'a', state: 'success' }, { accountId: 'b', state: 'failed', reason: 'fetch failed' }], state: 'success', gap: 31 * 60_000 },
    { items: [{ accountId: 'a', state: 'skipped', reason: 'account_limited' }], state: 'skipped', gap: 31 * 60_000 },
    { items: [{ accountId: 'a', state: 'failed', reason: 'fetch failed' }, { accountId: 'b', state: 'failed', reason: 'bad script' }], state: 'failed', paused: true },
    { items: [{ accountId: 'a', state: 'skipped', reason: 'aborted' }], state: 'stopped', stop: true, gap: 31 * 60_000 },
  ];
  for (const scenario of cases) {
    const h = harness();
    h.runWith(async () => { if (scenario.stop) h.globals.abortByPlatform.get('tiktok').abort(); return { items: scenario.items }; });
    await h.runMatrixTaskById(h.task.id);
    await h.settle();
    assert.equal(h.runs.listRuns()[0]?.state, scenario.state, JSON.stringify(h.logs));
    assert.equal(h.store.getTask(h.task.id).recoveryPaused, scenario.paused);
    if (scenario.gap) assert.equal(h.store.getTask(h.task.id).nextPlannedRunAt, h.now() + scenario.gap);
  }
  const waiting = harness();
  waiting.accounts.get('a').recovery = { nextCheckAt: waiting.now() + 300_000 };
  await waiting.finishMatrixTaskRun(waiting.task, waiting.now(), new Map(), { items: [{ accountId: 'a', state: 'skipped', reason: 'recovery_pending' }] });
  assert.equal(waiting.store.getTask(waiting.task.id).nextPlannedRunAt, waiting.now() + 300_000);
});

test('workbook completion requires every comment confirmed even when an account succeeded', async () => {
  for (const [summary, expected] of [
    [{ total: 3, confirmed: 1, pending: 1, remaining: 1 }, 'failed'],
    [{ total: 3, confirmed: 2, pending: 0, remaining: 1 }, 'failed'],
    [{ total: 3, confirmed: 3, pending: 0, remaining: 0 }, 'success'],
  ]) {
    const h = harness('once');
    const task = { ...h.task, type: 'comment_like', commentMode: 'custom' };
    await h.finishMatrixTaskRun(task, h.now(), new Map(), {
      items: [{ accountId: 'a', state: 'success', counts: { comment: 1 } }], customComments: summary,
    });
    const record = h.runs.listRuns()[0];
    assert.equal(record.state, expected);
    if (expected === 'failed') assert.match(record.reason, /表格评论未完成/);
    assert.equal(record.totals.comment, 1);
  }
});

test('scheduler retains power during periodic waits, releases on pause/disable, and never starts once', async () => {
  const h = harness();
  let calls = 0;
  h.runWith(async () => { calls++; return { items: [] }; });
  h.startMatrixScheduler(); await h.settle();
  assert.deepEqual(h.power.at(-1), ['acquire', 'scheduler']);
  assert.equal(calls, 0);
  h.store.finishTaskRun(h.task.id, h.now(), { state: 'failed', reason: 'bad script' });
  h.timers[0](); await h.settle();
  assert.deepEqual(h.power.at(-1), ['release', 'scheduler']);
  h.store.setTaskEnabled(h.task.id, false);
  h.timers[0](); await h.settle();
  assert.equal(calls, 0);
  const once = harness('once');
  once.startMatrixScheduler(); await once.settle();
  assert.deepEqual(once.power.at(-1), ['release', 'scheduler']);
  assert.equal(once.runs.listRuns().length, 0);
});
