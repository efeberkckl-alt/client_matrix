import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { build } from 'esbuild';
import { customCommentHarness, fixtureBrowserScenario, withTikTokCustomComments } from './helpers/customCommentHarness.mjs';

async function compileModule(file) {
  const built = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
  return built.outputFiles[0].text;
}
const requireModule = createRequire(import.meta.url);
function load(code, env = {}) {
  const module = { exports: {} };
  new Function('require', 'module', 'exports', 'process', code)(requireModule, module, module.exports, { platform: process.platform, env });
  return module.exports;
}
const [batchCode, postCode, planCode, storeCode, runStoreCode, policyCode] = await Promise.all([
  '../src/main/libs/matrix/customCommentBatch.ts', '../src/types/matrixCommentPosts.ts',
  '../src/types/matrixCommentPlan.ts', '../src/main/libs/matrix/taskStore.ts',
  '../src/main/libs/matrix/runStore.ts', '../src/types/matrixCommentPolicy.ts',
].map(compileModule));
const { CustomCommentBatch, customCommentAccountUnavailable, withCustomCommentBatch } = load(batchCode);
const { normalizeCustomCommentPolicy } = load(policyCode);
const { validatedCommentPosts } = load(postCode);
const { commentAssignmentRandom, commentPostKey, planCommentAssignments } = load(planCode);
function functions(file, names) {
  const source = fs.readFileSync(new URL(file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return names.map(name => {
    const node = ast.statements.find(n => ts.isFunctionDeclaration(n) && n.name?.text === name);
    assert.ok(node, name);
    return node.getText(ast).replace(/^export /, '');
  }).join('\n');
}
const compiled = ts.transpileModule([
  functions('../src/main/libs/matrix/engageRunner.ts', ['abortableSleep', 'randInt', 'runEngageTask']),
  functions('../src/main/sidecar-server.ts', ['finishMatrixTaskRun', 'runMatrixTaskById']),
].join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const post = (id, text) => ({ url: `https://www.tiktok.com/@source/video/${id}`, text });
const postKey = p => JSON.stringify([p.url.split('/').at(-1), p.text]);

function harness(t, states = {}, real) {
  const directory = real?.directory || fs.mkdtempSync(path.join(os.tmpdir(), 'custom-runner-'));
  if (!real?.directory) t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const env = { NOOBCLAW_MATRIX_DIR: directory };
  const store = load(storeCode, env);
  const runStore = load(runStoreCode, env);
  const disk = path.join(directory, 'tasks.json');
  const readTask = () => JSON.parse(fs.readFileSync(disk, 'utf8'))[0];
  const accounts = new Map(['a', 'b', 'c', 'd', 'e', 'f'].map(id => [id, { id, platform: 'tiktok', status: states[id] || 'idle' }]));
  const startup = [], longRests = [], statuses = [];
  const sent = [], runs = [], progress = [], items = [], targets = [], plans = [];
  const actual = new Map(), transport = { model: 0, action: 0 };
  const failures = new Map(), limits = new Map(), actors = new Map(), timers = new Map(), events = [], liveCounts = [];
  const overlaps = new Set();
  let uncertainAccount, afterRun, beforeRun, onPrepared, chargeComment, writeFailure, randomIndex = 0, nextTimer = 0, now = real ? Date.now() : 0, peak = 0, savedTask = real?.taskId;
  const samples = [0, 0.999999, 0.5, 0.1, 0.9];
  class Clock extends Date { static now() { return now; } }
  const schedule = (fn, delay = 0) => {
    const id = ++nextTimer;
    timers.set(id, { fn, at: now + delay });
    return id;
  };
  const drain = async (work, busy = () => false) => {
    let settled = false, value, failure;
    work.then(result => { value = result; settled = true; }, error => { failure = error; settled = true; });
    for (let steps = 0; steps < 100; steps++) {
      await new Promise(setImmediate);
      if (settled && !busy()) {
        if (failure) throw failure;
        return value;
      }
      const next = [...timers].sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) continue;
      const [id, timer] = next;
      timers.delete(id);
      now = timer.at;
      timer.fn();
    }
    throw Error('virtual clock did not settle');
  };
  let assertion;
  const ctx = vm.createContext({
    process: { env }, fs, os, path, Buffer, Set, Map, AbortController, AbortSignal, Date: Clock, performance: { now: () => now },
    Math: Object.assign(Object.create(Math), { random: () => samples[randomIndex++ % samples.length] }),
    setTimeout: schedule, clearTimeout: id => timers.delete(id),
    normalizeCustomCommentPolicy, validatedCommentPosts, withCustomCommentBatch, customCommentAccountUnavailable, commentPostKey, commentAssignmentRandom,
    installedKernelPath: () => 'offline-kernel', getAccount: id => accounts.get(id),
    fetchEngagePack: async () => ({ orchestrator: real ? fixtureBrowserScenario : 'simulated browser boundary', prompts: {} }),
    withTikTokCommentPrompts: p => p, withTikTokCustomComments: real ? withTikTokCustomComments : s => s,
    coworkLog() {}, isRecoverableFailure: () => false,
    automationSafety: { signal: () => undefined }, AutomationSafetyError: class extends Error {},
    KernelNavigationError: class extends Error {}, diagnosticAccountAlias: () => 'synthetic',
    setAccountStatus: (id, status) => { accounts.get(id).status = status; statuses.push(status); },
    engageHistoryFor: () => ({}), getNoobClawAuthToken: () => 'test-token', effectiveKeywords: () => [],
    accountBadgeLabel: () => 'fixture', matrixGroupTitle: () => 'fixture', getSession: () => undefined,
    launchKernel: async () => {}, closeKernel() {}, kernelNavigate: async (id, url) => { startup.push({ id, url }); }, kernelEval: async () => '',
    checkKernelLogin: async () => true, platformKey: () => 'tiktok', markAccountAlive() {},
    commentLangHint: () => '', prepareTikTokLeadCommentTask() {}, PLATFORM_HOME: { tiktok: 'https://www.tiktok.com/' },
    CUSTOM_COMMENT_LEDGER: 'custom_video_comments', NO_KERNEL_ERROR: 'offline-missing-kernel', inspectHoldMs: () => 0,
    makeAiCall: () => async () => { transport.model++; return { simulated: true }; },
    chargeAction: async () => { transport.action++; return {ok:true,charged:42,cost_usd:0.1}; },
    runAutomationScript: async (id, fn, ctx) => {
      const h = actual.get(id) || customCommentHarness({ ...real?.browser?.[id],
        readPending: key => ctx.readState('custom_video_comments')?.[key] });
      actual.set(id, h);
      if (real?.legacyCallback) {
        const response = await ctx.chargeAction('comment', 'tiktok');
        assert.equal(response.charged, 0);
      }
      return fn({ ...ctx, ...h.browser,
        manifest: real?.daily?.[id] ? { ...ctx.manifest, risk_caps: { max_comments_per_day: real.daily[id] } } : ctx.manifest,
        aborted: () => ctx.aborted() || h.browser.aborted(),
        sleep: async (min, max) => {
          if (min < 60000) return h.browser.sleep(min, max);
          const at = now;
          if (real?.stopDuringRest) schedule(() => ctx.aborted() || fixtureContext.abortByPlatform.get('tiktok').abort(), 1);
          await ctx.sleep(min, max);
          longRests.push({ requested: min, elapsed: now - at, aborted: ctx.aborted() });
        },
      });
    },
    MATRIX_MAX_CONCURRENT: 17, runningPlatforms: new Set(), runningTaskByPlatform: new Map(),
    runAccountsByPlatform: new Map(), abortByPlatform: new Map(), liveProgressByTask: new Map(), matrixScanWatching: new Set(),
    refreshMaxConcurrent: async () => {},
    broadcastSSE: (_channel, event) => {
      events.push(structuredClone(event));
      if (event.type !== 'item') return;
      const live = ctx.liveProgressByTask.get(event.taskId);
      liveCounts.push([live.done.comment, live.cost.credits]);
    },
    require: name => {
      if (name.endsWith('/taskStore')) return store;
      if (name.endsWith('/runStore')) return runStore;
      if (name.endsWith('/recovery')) return { isRecoverableFailure: () => false };
      if (name.endsWith('/accountManager')) return { getAccount: id => accounts.get(id), loadAccounts: () => [...accounts.values()] };
      if (name.endsWith('/engageRunner')) return { runEngageTask: ctx.runEngageTask };
      if (/Runner$/.test(name)) return {};
      throw Error('Unexpected module ' + name);
    },
    runOne: async (_opts, _pack, accountId, _charge, custom) => {
      try {
        if (actors.has(accountId)) {
          overlaps.add(accountId);
          throw Error('same account reentered');
        }
        actors.set(accountId, now);
        peak = Math.max(peak, actors.size);
        const run = { accountId, at: now, posts: structuredClone(custom.posts), pending: custom.batch.pendingFor(accountId).map(postKey) };
        runs.push(run);
        if (savedTask === _opts.taskId) {
          const owners = readTask().commentAssignmentPlan.owners;
          for (const post of run.posts) assert.equal(owners[postKey(post)], accountId, 'recipient started before ownership persisted');
        }
        if (beforeRun) await beforeRun({ _opts, _charge, custom, run });
        if (real) return await ctx.exactRunOne(_opts, _pack, accountId, _charge, custom);
        return await simulate(_opts, accountId, _charge, custom);
      } catch (error) {
        if (error.code === 'ERR_ASSERTION') assertion = error;
        throw error;
      } finally {
        actors.delete(accountId);
      }
    },
  });
  const fixtureContext = ctx;
  vm.runInContext(compiled, ctx);
  if (real) {
    for (const account of accounts.values()) account.displayId = 'runner';
    const code = functions('../src/main/libs/matrix/engageRunner.ts', ['runOne']).replace(/^async function runOne/, 'async function exactRunOne');
    vm.runInContext(ts.transpileModule(`const AsyncFunction = Object.getPrototypeOf(async function(){}).constructor;\n${code}`,
      { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  }
  async function simulate(_opts, accountId, _charge, custom) {
    const finish = result => { afterRun?.(accountId, _charge); return result; };
    if (custom.stopSignal.aborted) return finish({ accountId, state: 'skipped', reason: 'aborted' });
    if (failures.has(accountId)) return finish({ accountId, state: 'skipped', reason: failures.get(accountId) });
    let count = 0, debits = 0;
    const progress = () => ({ accountId, counts: { like: 0, follow: 0, comment: count }, chargedCredits: debits * 2, chargedUsd: debits * 0.1 });
    _opts.onTargets?.(accountId, { comment: 999 }); // Remote quotas must not overwrite workbook assignment totals.
    for (const p of custom.posts) {
      if (custom.stopSignal.aborted || count >= (limits.get(accountId) ?? Infinity)) break;
      const rename = fs.renameSync;
      if (writeFailure === accountId) fs.renameSync = () => { throw Error('simulated atomic ledger replacement failure'); };
      try {
        custom.batch.prepare(postKey(p), accountId, { author: accountId, count: 0, ids: [] });
      } finally {
        fs.renameSync = rename;
      }
      sent.push({ accountId, ...p });
      if (onPrepared) await onPrepared(accountId, p);
      if (accountId !== uncertainAccount) {
        custom.batch.confirm(postKey(p), accountId, { author: accountId, count: 1, ids: ['12345'] }, 'same_page');
        count++;
        const why = chargeComment?.(p);
        if (why) {
          _charge.reason = why;
          if (_opts.signal?.aborted) return finish({ ...progress(), state: 'skipped', reason: 'aborted' });
          return finish({ ...progress(), state: 'failed', reason: 'charge_failed:' + why });
        }
        debits++;
      }
      _opts.onItem?.({ ...progress(), state: 'success' });
    }
    const incomplete = count < custom.posts.length;
    const reason = incomplete ? limits.has(accountId) ? 'custom_comment_daily_limit' : 'custom_comments_incomplete' : undefined;
    return finish({ ...progress(), state: incomplete ? 'failed' : 'success', reason });
  }
  return {
    startup, statuses, longRests, sent, runs, progress, items, targets, plans, events, liveCounts, readTask, accounts, overlaps, actual, transport, directory,
    get history() { return JSON.parse(fs.readFileSync(path.join(directory, 'runs.json'), 'utf8')).reverse(); },
    now: () => now, peak: () => peak,
    pause: ms => new Promise(resolve => schedule(resolve, ms)),
    stop: () => ctx.abortByPlatform.get('tiktok').abort(),
    batch: posts => new CustomCommentBatch(directory, posts, { readOnly: true }),
    before: fn => { beforeRun = fn; },
    onPrepared: fn => { onPrepared = fn; },
    onCharge: fn => { chargeComment = fn; },
    failWriteFor: id => { writeFailure = id; },
    save: (posts, accountIds, availableIds = accountIds, customCommentPolicy) => {
      const input = { platform: 'tiktok', type: 'comment_like', commentMode: 'custom', accountIds, commentPosts: posts, concurrency: 1, customCommentPolicy };
      const preview = store.previewCustomCommentAssignments(input, availableIds);
      const result = store.saveTask({ ...input, commentAssignmentPreview: preview }, availableIds);
      assert.equal(result.ok, true, result.error);
      savedTask = result.task.id;
      return preview.plan;
    },
    runSaved: async (manual = true) => {
      const started = await drain(ctx.runMatrixTaskById(savedTask, undefined, manual), () => ctx.runningPlatforms.size > 0);
      assert.deepEqual(structuredClone(started), { ok: true });
      if (assertion) throw assertion;
      return events.findLast(event => event.type === 'done' || event.type === 'error');
    },
    fail: (id, reason = 'login_expired') => failures.set(id, reason), recover: id => failures.delete(id),
    uncertain: id => { uncertainAccount = id; },
    limit: (id, count) => limits.set(id, count), after: fn => { afterRun = fn; },
    run: async (posts, extra = {}) => {
      const report = await drain(ctx.runEngageTask({ platform: 'tiktok', taskType: 'comment_like', taskId: 'first', commentMode: 'custom',
      accountIds: ['a', 'b'], commentPostAccountIds: ['a', 'b'], commentPosts: posts, onLog: (_id, msg) => progress.push(msg),
      commentAssignmentPlan: { version: 2, owners: Object.fromEntries(posts.map((item, index) => [postKey(item), index % 2 === 0 ? 'a' : 'b'])) },
      onCommentAssignmentPlan: plan => plans.push(structuredClone(plan)),
        onItem: item => items.push(structuredClone(item)), onTargets: (id, value) => targets.push({ id, ...value }), ...extra }));
      if (assertion) throw assertion;
      return report;
    },
  };
}

test('real task orchestration uses the saved preview comment by comment and rebuilt tasks send nothing twice', async t => {
  const h = harness(t), posts = ['a', 'b', 'c', 'd', 'e'].map(text => post(1, text));
  const expected = planCommentAssignments({ posts, accountIds: ['a', 'b'], random: commentAssignmentRandom('preview') });
  const commentAssignmentPlan = { version: 2, owners: Object.fromEntries(expected.owners) };
  const first = await h.run(posts, { commentAssignmentPlan });
  assert.deepEqual(h.runs.map(r => [r.accountId, r.posts.map(postKey)]), [...expected.assignments].map(([id, items]) => [id, items.map(postKey)]));
  assert.equal(h.plans.length, 0, 'unchanged saved plans are not rewritten');
  assert.equal(first.customComments.confirmed, 5);
  const resumed = await h.run(posts.toReversed(), { taskId: 'rebuilt', commentAssignmentPlan });
  assert.equal(h.sent.length, 5);
  assert.equal(resumed.customComments.confirmed, 5);
  assert.equal(h.runs.length, 2);
});

test('unavailable accounts do not receive work and a pre-send login failure passes remaining work to the next account', async t => {
  for (const unavailable of ['banned', 'failed-login']) {
    const h = harness(t, unavailable === 'banned' ? { a: 'banned' } : {});
    if (unavailable === 'failed-login') h.fail('a');
    const report = await h.run([post(1, 'a'), post(2, 'b')]);
    assert.equal(report.customComments.confirmed, 2);
    assert.deepEqual(h.sent.map(s => s.accountId), ['b', 'b']);
  }
});

test('uncertain sends remain pending and never become a different account publication on restart', async t => {
  const h = harness(t);
  h.uncertain('a');
  const posts = [post(1, 'a'), post(2, 'b')];
  const first = await h.run(posts);
  assert.equal(first.customComments.pending, 1);
  assert.equal(first.customComments.confirmed, 1);
  const resumed = await h.run(posts, { taskId: 'rebuilt', accountIds: ['c'], commentPostAccountIds: ['c'] });
  assert.equal(resumed.customComments.pending, 1);
  assert.equal(h.sent.length, 2);
  const original = await h.run(posts, { accountIds: ['a', 'c'], commentPostAccountIds: ['a', 'c'] });
  assert.equal(original.customComments.pending, 1);
  assert.deepEqual(h.runs.at(-1).pending, [postKey(posts[0])]);
  assert.equal(h.runs.at(-1).accountId, 'a');
  assert.equal(h.sent.length, 2);
});

test('pause or page-incomplete results keep the existing plan and resume only remaining work on the planned account', async t => {
  for (const mode of ['pause', 'composer']) {
    const h = harness(t), abort = new AbortController();
    const posts = [post(1, 'a'), post(1, 'b')];
    if (mode === 'pause') h.after(id => { if (id === 'a') abort.abort(); });
    else h.fail('a', 'custom_comments_incomplete');
    const interrupted = await h.run(posts, { signal: abort.signal });
    assert.equal(interrupted.customComments.remaining, 1);
    assert.equal(h.plans.length, 0);
    assert.deepEqual(h.sent.map(item => item.accountId), [mode === 'pause' ? 'a' : 'b']);
    h.after(undefined);
    h.recover('a');
    const resumed = await h.run(posts);
    assert.equal(resumed.customComments.confirmed, 2);
    assert.equal(h.sent.at(-1).accountId, mode === 'pause' ? 'b' : 'a');
  }
});

test('when an account fails, transfer is persisted before the recipient runs and keeps every existing healthy share', async t => {
  const h = harness(t);
  h.fail('b');
  const posts = ['a', 'b', 'c', 'd', 'e', 'f'].map(text => post(1, text));
  const commentAssignmentPlan = { version: 2, owners: Object.fromEntries(posts.map((item, i) => [postKey(item), ['a','b','c'][i % 3]])) };
  h.after(id => {
    if (id === 'c') assert.equal(h.plans.length, 1);
  });
  await h.run(posts, { accountIds: ['a', 'b', 'c'], commentPostAccountIds: ['a', 'b', 'c'], commentAssignmentPlan });
  assert.equal(h.sent.length, posts.length);
  for (const item of h.sent) {
    const key = postKey(item);
    assert.equal(item.accountId, h.plans[0].owners[key]);
    if (commentAssignmentPlan.owners[key] !== 'b') assert.equal(item.accountId, commentAssignmentPlan.owners[key]);
  }
});

test('failure to persist a changed plan prevents send attempts', async t => {
  const h = harness(t, { a: 'banned' });
  await assert.rejects(h.run([post(1, 'a'), post(1, 'b')], { onCommentAssignmentPlan: () => { throw Error('disk failure'); } }), /disk failure/);
  assert.equal(h.sent.length, 0);
});

test('a legacy task run directly persists a balanced plan before its first attempt', async t => {
  const h = harness(t);
  const posts = ['a', 'b', 'c', 'd', 'e'].map(text => post(1, text));
  const expected = planCommentAssignments({ posts, accountIds: ['a', 'b'], random: commentAssignmentRandom('legacy') });
  h.after(() => assert.equal(h.plans.length, 1));
  const report = await h.run(posts, { taskId: 'legacy', commentAssignmentPlan: undefined });
  assert.equal(report.customComments.confirmed, 5);
  assert.deepEqual(h.plans[0].owners, Object.fromEntries(expected.owners));
});

test('an earlier healthy account takes over the last failed share in the same run with cumulative progress and cost', async t => {
  const h = harness(t);
  h.fail('b');
  const report = await h.run([post(1, 'a'), post(2, 'b')]);
  assert.deepEqual(h.runs.map(r => r.accountId), ['a', 'b', 'a']);
  assert.deepEqual(h.sent.map(s => s.accountId), ['a', 'a']);
  assert.equal(report.total, 2);
  assert.equal(report.customComments.confirmed, 2);
  assert.equal(report.items.find(i => i.accountId === 'a').counts.comment, 2);
  assert.equal(report.items.find(i => i.accountId === 'a').chargedCredits, 4);
  assert.equal(report.items.find(i => i.accountId === 'a').chargedUsd, 0.2);
  assert.deepEqual(h.items.filter(i => i.accountId === 'a').map(i => i.counts.comment), [1, 1, 2, 2]);
  assert.equal(h.targets.some(t => t.comment === 999), false);
  assert.equal(h.targets.findLast(t => t.id === 'a').comment, 2);
  assert.equal(h.targets.findLast(t => t.id === 'b').comment, 0);
});

test('limited and failed actors are not retried and global stop signals prevent takeover', async t => {
  for (const mode of ['daily-limit', 'all-failed', 'abort', 'charge']) {
    const h = harness(t), abort = new AbortController();
    h.fail('b');
    if (mode === 'daily-limit') h.limit('a', 1);
    if (mode === 'all-failed') h.fail('a');
    h.after((id, charge) => {
      if (id === 'b' && mode === 'abort') abort.abort();
      if (id === 'b' && mode === 'charge') charge.reason = 'test-insufficient';
    });
    const report = await h.run([post(1, 'a'), post(1, 'b'), post(2, 'c'), post(2, 'd')], { signal: abort.signal });
    assert.deepEqual(h.runs.map(r => r.accountId), ['a', 'b'], mode);
    assert.ok(report.customComments.remaining > 0, mode);
  }
});

test('saved task starts five accounts at staggered intervals, interleaves one ledger and aggregates progress', async t => {
  const h = harness(t, { a: 'banned' });
  const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
  const posts = ids.slice(1).map((id, index) => post(1, 'fixture-' + index));
  const preview = h.save(posts, ids, ids.slice(1));
  assert.deepEqual(h.readTask().commentAssignmentPlan, preview);
  h.onPrepared(async id => {
    // Later accounts confirm first; the earliest pending write must survive those other writes.
    if (id === 'b') await h.pause(22_000);
    else await h.pause(15_000);
  });
  const first = await h.runSaved();
  assert.equal(first.type, 'done');
  assert.equal(first.report.state, 'success');
  assert.equal(first.report.reason, undefined);
  assert.equal(h.history[0].state, 'success');
  assert.equal(h.readTask().lastError, undefined);
  assert.deepEqual(h.runs.map(({ accountId, at }) => [accountId, at]),
    [['b', 0], ['c', 3000], ['d', 8000], ['e', 12000], ['f', 15200]]);
  assert.equal(h.peak(), 5);
  assert.equal(h.overlaps.size, 0);
  assert.deepEqual(h.readTask().commentAssignmentPlan, preview);
  assert.equal(new Set(h.sent.map(postKey)).size, posts.length);
  const ledger = h.batch(posts);
  const { entries } = JSON.parse(fs.readFileSync(ledger.file, 'utf8'));
  assert.equal(Object.keys(entries).length, posts.length);
  for (const [key, entry] of Object.entries(entries)) {
    assert.equal(entry.status, 'confirmed');
    assert.equal(entry.accountId, preview.owners[key]);
    assert.equal(entry.verification.kind, 'observed');
  }
  assert.equal(h.history[0].totals.comment, 5);
  assert.equal(h.history[0].cost.credits, 10);
  assert.deepEqual([...new Set(h.liveCounts.map(([comments, credits]) => `${comments}/${credits}`))],
    ['1/2', '2/4', '3/6', '4/8', '5/10']);
  assert.deepEqual(h.events.filter(event => event.type === 'item' && event.counts?.comment === 1)
    .map(event => event.accountId).filter((id, i, list) => list.indexOf(id) === i), ['c', 'b', 'd', 'e', 'f']);
  const restarted = await h.runSaved();
  assert.equal(restarted.report.customComments.confirmed, 5);
  assert.equal(h.sent.length, 5);
  const reimport = [{ ...posts[0], url: 'https://www.tiktok.com/@other/video/1?source=again', text: ' ' + posts[0].text + ' ' }, post(2, posts[0].text)];
  const rebuilt = await h.run(reimport, { taskId: 'another', accountIds: ['a', 'c'], commentPostAccountIds: ['a', 'c'], commentAssignmentPlan: undefined });
  assert.equal(rebuilt.customComments.confirmed, 2);
  assert.equal(h.sent.length, 6);
  assert.equal(h.sent.at(-1).url, post(2, posts[0].text).url);
  t.diagnostic('virtual starts 0/3000/8000/12000/15200 ms; peak=5; five durable confirmations; repeat=0 sends');
});

test('confirmed unavailable actor releases only unattempted work, with the same cadence and no active share transfer', async t => {
  const h = harness(t);
  const posts = Array.from({ length: 12 }, (_, i) => post(1, 'fixture-' + i));
  const preview = h.save(posts, ['a', 'b', 'c', 'd']);
  const pending = posts.find(p => preview.owners[postKey(p)] === 'b');
  const ownedByA = Object.keys(preview.owners).filter(key => preview.owners[key] === 'a');
  h.fail('b');
  h.before(async ({ custom, run }) => {
    if (run.accountId === 'a') {
      h.accounts.get('a').status = 'banned'; // Eligibility changes during the simulated account lease.
      await h.pause(25_000);
      for (const key of ownedByA) assert.equal(h.readTask().commentAssignmentPlan.owners[key], 'a');
      h.accounts.get('a').status = 'idle';
    }
    if (run.accountId === 'b') {
      custom.batch.prepare(postKey(pending), 'b', { author: 'b', count: 0, ids: [] });
      await h.pause(8000);
    }
    if (run.accountId === 'c' || run.accountId === 'd') await h.pause(1000);
  });
  const result = await h.runSaved();
  assert.equal(result.type, 'done');
  assert.deepEqual(result.report.customComments, { total: 12, confirmed: 11, pending: 1, remaining: 0 });
  const saved = h.readTask().commentAssignmentPlan.owners;
  for (const [key, owner] of Object.entries(preview.owners)) {
    if (owner === 'b' && key !== postKey(pending)) assert.ok(['c', 'd'].includes(saved[key]));
    else assert.equal(saved[key], owner);
  }
  assert.deepEqual(h.runs.map(({ accountId, at }) => [accountId, at]),
    [['a', 0], ['b', 3000], ['c', 8000], ['d', 12000], ['c', 15200]]);
  assert.equal(h.overlaps.size, 0);
  assert.equal(h.batch(posts).assignmentLedger()[postKey(pending)].accountId, 'b');
  assert.equal(h.sent.some(p => postKey(p) === postKey(pending)), false);
  assert.equal(h.history[0].totals.comment, 11);
  assert.equal(h.history[0].cost.credits, 22);
  t.diagnostic('C took over at 15200 ms with A still active until 25000 ms; B retained the pending record');
});

test('multiple idle recipients take over in separate starts without waiting for the previous recipient', async t => {
  const h = harness(t);
  const posts = Array.from({ length: 12 }, (_, i) => post(1, 'fixture-' + i));
  h.save(posts, ['a', 'b', 'c']);
  h.limit('c', 0);
  h.before(async ({ run }) => {
    if (run.accountId === 'a' && run.at > 0) await h.pause(10_000);
  });
  const result = await h.runSaved();
  assert.equal(result.report.state, 'success');
  assert.equal(result.report.reason, undefined);
  assert.equal(h.history[0].state, 'success');
  assert.equal(h.history[0].items.find(item => item.accountId === 'c').state, 'failed');
  assert.equal(h.readTask().lastError, undefined);
  assert.deepEqual(h.runs.map(({ accountId, at }) => [accountId, at]),
    [['a', 0], ['b', 3000], ['c', 8000], ['a', 12000], ['b', 15200]]);
  assert.equal(h.overlaps.size, 0);
  assert.equal(h.peak(), 2);
  assert.deepEqual(result.report.customComments, { total: 12, confirmed: 12, pending: 0, remaining: 0 });
  assert.equal(h.history[0].cost.credits, 24);
  t.diagnostic('takeovers started at 12000 and 15200 ms while the first takeover was active');
});

test('stop and billing fuse wake a pending start and preserve the saved plan during active cleanup', async t => {
  for (const mode of ['cancel', 'billing']) {
    const h = harness(t);
    const posts = [post(1, 'one'), post(1, 'two'), post(1, 'three')];
    const preview = h.save(posts, ['a', 'b', 'c']);
    let knownStoppedAt;
    h.before(async ({ custom, _charge }) => {
      custom.stopSignal.addEventListener('abort', () => { knownStoppedAt = h.now(); }, { once: true });
      await h.pause(1000);
      if (mode === 'cancel') h.stop();
      else _charge.reason = 'insufficient_balance';
      await h.pause(100); // Existing worker returns after cleanup.
    });
    const result = await h.runSaved();
    assert.equal(knownStoppedAt, 1000);
    assert.equal(h.now(), 1100);
    assert.equal(result.report.state, mode === 'cancel' ? 'stopped' : 'failed');
    assert.equal(result.report.reason, mode === 'cancel' ? 'aborted' : 'charge_failed:insufficient_balance');
    assert.equal(h.runs.length, 1);
    assert.equal(h.sent.length, 0);
    assert.equal(result.report.customComments.remaining, 3);
    assert.deepEqual(h.readTask().commentAssignmentPlan, preview);
    assert.equal(h.history[0].finishedAt, 1100);
  }
  t.diagnostic('cancel and billing fuse signaled at 1000 ms, final state at 1100 ms, second start would be at 3000 ms');
});

for (const { failure, cancelled } of [
  { failure: 'insufficient_balance', cancelled: false },
  { failure: 'charge_uncertain', cancelled: false },
  { failure: 'charge_uncertain', cancelled: true },
]) {
  test(`saved workbook final debit ${failure}${cancelled ? ' during cancellation' : ''} preserves the durable terminal and prior costs`, async t => {
    const h = harness(t);
    const posts = [post(1, 'paid-first'), post(1, 'last')];
    h.save(posts, ['a']);
    const attemptedDebits = [];
    h.onCharge(p => {
      attemptedDebits.push(postKey(p));
      if (p.text !== 'last') return undefined;
      if (cancelled) h.stop();
      return failure;
    });
    const result = await h.runSaved();
    const expectedState = cancelled ? 'stopped' : 'failed';
    const expectedReason = cancelled ? 'aborted' : 'charge_failed:' + failure;
    assert.equal(result.report.state, expectedState);
    assert.equal(result.report.reason, expectedReason);
    assert.equal(result.report.chargeFailureReason, failure);
    assert.deepEqual(result.report.customComments, { total: 2, confirmed: 2, pending: 0, remaining: 0 });
    assert.equal(result.report.items[0].counts.comment, 2);
    assert.equal(result.report.items[0].chargedCredits, 2);
    assert.deepEqual(h.liveCounts.at(-1), [2, 2]);
    assert.equal(h.readTask().lastError, expectedReason);
    assert.equal(h.readTask().recoveryPaused, cancelled ? undefined : true);
    const originalHistory = h.history[0];
    assert.equal(originalHistory.state, expectedState);
    assert.equal(originalHistory.reason, expectedReason);
    assert.deepEqual(originalHistory.cost, { credits: 2, usd: 0.1 });
    const ledger = h.batch(posts);
    const recordedEvidence = JSON.parse(fs.readFileSync(ledger.file, 'utf8')).entries;
    assert.deepEqual(Object.values(recordedEvidence).map(entry => entry.status), ['confirmed', 'confirmed']);

    await h.runSaved();
    assert.deepEqual(h.sent.map(postKey), posts.map(postKey));
    assert.deepEqual(attemptedDebits, posts.map(postKey));
    assert.deepEqual(JSON.parse(fs.readFileSync(ledger.file, 'utf8')).entries, recordedEvidence);
    assert.deepEqual(h.history[0], originalHistory);
    assert.deepEqual(h.history[1].cost, { credits: 0, usd: 0 });
    t.diagnostic(`${expectedState} / ${expectedReason}; 2 confirmations and first debit retained; rerun 0 sends and 0 debits`);
  });
}

test('ledger replacement failure prevents dispatch and does not block other staggered accounts', async t => {
  const h = harness(t);
  const posts = ['one', 'two', 'three', 'four'].map(text => post(1, text));
  const preview = h.save(posts, ['a', 'b', 'c', 'd']);
  h.failWriteFor('a');
  h.before(async ({ run }) => { if (run.accountId === 'a') await h.pause(10_000); });
  const result = await h.runSaved();
  assert.equal(result.report.state, 'failed');
  assert.match(result.report.items.find(item => item.accountId === 'a').reason, /ledger replacement failure/);
  assert.deepEqual(h.runs.map(({ at }) => at), [0, 3000, 8000, 12000]);
  assert.deepEqual(h.sent.map(({ accountId }) => accountId), ['b', 'c', 'd']);
  const ledger = h.batch(posts).assignmentLedger();
  const aKey = Object.keys(preview.owners).find(key => preview.owners[key] === 'a');
  assert.equal(ledger[aKey], undefined);
  assert.deepEqual(result.report.customComments, { total: 4, confirmed: 3, pending: 0, remaining: 1 });
  assert.deepEqual(h.readTask().commentAssignmentPlan, preview);
});

test('actual saved runner: scheduled and manual prewritten publication succeed with zero debit and zero model requests', async t => {
  for (const manual of [true, false]) {
    const h = harness(t, {}, {legacyCallback:true});
    h.save([post(913, 'first synthetic workbook entry'), post(914, 'second synthetic workbook entry')], ['a']);
    const savedId = h.readTask().id;
    const called = await h.runSaved(manual);
    assert.equal(called.type,'done');
    assert.equal(called.report.state,'success',JSON.stringify(called.report));
    assert.equal(called.report.customComments.confirmed,2);
    assert.equal(h.actual.get('a').attempts.length,2);
    assert.deepEqual(h.transport,{model:0,action:0});
    assert.deepEqual(h.history.at(-1).cost,{credits:0,usd:0});
    const restored = harness(t, {}, {directory:h.directory,taskId:savedId,legacyCallback:true});
    const retry = await restored.runSaved();
    assert.equal(retry.report.state,'success',JSON.stringify(retry.report));
    assert.equal(restored.actual.size,0,'confirmed work is never sent on a durable same-ID retry');
    assert.deepEqual(restored.transport,{model:0,action:0});
    assert.equal(restored.history.length,2);
    assert.deepEqual(restored.history[0].cost,{credits:0,usd:0});
    assert.deepEqual(restored.history[1].cost,{credits:0,usd:0});
  }
});

test('actual saved runner retains an uncertain send across a fresh load without charging or sending it twice', async t => {
  const posts=[post(915,'first synthetic workbook entry'),post(916,'second synthetic workbook entry')];
  const h=harness(t,{}, {browser:{a:{hideFirst:true}}});
  h.save(posts,['a']);
  const r=await h.runSaved();
  assert.equal(r.report.state,'failed');
  assert.deepEqual(structuredClone(r.report.customComments),{total:2,confirmed:1,pending:1,remaining:0});
  assert.equal(h.actual.get('a').attempts.length,2);
  assert.deepEqual(h.transport,{model:0,action:0});
  const after=harness(t,{}, {directory:h.directory,taskId:h.readTask().id});
  const replay=await after.runSaved();
  assert.deepEqual(structuredClone(replay.report.customComments),{total:2,confirmed:1,pending:1,remaining:0});
  assert.equal(after.actual.get('a').attempts.length,0);
  assert.deepEqual(after.transport,{model:0,action:0});
  assert.ok(after.history.every(row=>row.cost.credits===0));
});

test('actual saved runner cancellation before a send leaves new costs and publication at zero', async t => {
  const h = harness(t,{}, {legacyCallback:true});
  h.save([post(918,'cancelled synthetic run')], ['a']);
  h.before(() => h.stop());
  const r=await h.runSaved();
  assert.equal(r.report.state,'stopped');
  assert.equal(h.actual.size,0);
  assert.deepEqual(h.transport,{model:0,action:0});
  assert.deepEqual(h.history.at(-1).cost,{credits:0,usd:0});
});


test('default 20 cap and 2–4 minute rests keep uncertain rows on original account and resume without repeats', async t => {
  const posts = Array.from({length: 24}, (_, i) => post(1100 + i, 'synthetic comment ' + i));
  const h = harness(t, {}, { browser: { a: { hideFirst: true } }, legacyCallback: true });
  const plan = h.save(posts, ['a']);
  assert.deepEqual(h.readTask().customCommentPolicy, normalizeCustomCommentPolicy());
  const first = await h.runSaved();
  assert.equal(first.report.state, 'success');
  assert.deepEqual(structuredClone(first.report.customComments), { total: 24, confirmed: 19, pending: 1, remaining: 4, roundLimitReached: true });
  assert.equal(h.actual.get('a').attempts.length, 20);
  assert.equal(first.report.items[0].reason, 'custom_comment_round_limit');
  assert.equal(h.accounts.get('a').status, 'idle');
  assert.ok(!h.statuses.includes('limited'));
  assert.match(h.history[0].reason, /剩余待发 4 条，待核验 1 条/);
  assert.equal(h.startup.filter(x => x.url === 'https://www.tiktok.com/').length, 1);
  assert.ok(!h.actual.get('a').navigations.includes('https://www.tiktok.com/'));
  assert.equal(h.longRests.length, 3);
  for (const x of h.longRests) assert.ok(!x.aborted && x.elapsed === x.requested && x.requested >= 120000 && x.requested <= 240000);
  const pending = h.batch(posts).pendingFor('a');
  assert.equal(pending.length, 1);
  assert.equal(h.batch(posts).pendingFor('b').length, 0);
  const restored = harness(t, {}, { directory: h.directory, taskId: h.readTask().id, legacyCallback: true });
  const next = await restored.runSaved(false);
  assert.deepEqual(structuredClone(next.report.customComments), { total: 24, confirmed: 23, pending: 1, remaining: 0 });
  assert.deepEqual(restored.readTask().commentAssignmentPlan, plan);
  const firstKeys = new Set(h.actual.get('a').attempts.map(postKey));
  assert.equal(restored.actual.get('a').attempts.length, 4);
  assert.equal(restored.actual.get('a').attempts.some(x => firstKeys.has(postKey(x))), false);
  assert.deepEqual(restored.batch(posts).pendingFor('a'), pending);
  for (const fixture of [h, restored]) {
    assert.deepEqual(fixture.transport, { action: 0, model: 0 });
    assert.ok(fixture.history.every(row => row.cost.credits === 0));
  }
  console.log('round fixture', JSON.stringify({ first: first.report.customComments, next: next.report.customComments,
    rests: h.longRests, accountStatuses: h.statuses, repeated: 0, transport: h.transport, cost: h.history[0].cost }));
});

test('stop signal interrupts an injected one-minute stage rest before a third dispatch', async t => {
  const posts = Array.from({length: 4}, (_, i) => post(1500 + i, 'cancel fixture ' + i));
  const h = harness(t, {}, { stopDuringRest: true });
  h.save(posts, ['a'], ['a'], { homeWarmup: 'per_video', accountLimit: 3, restEvery: 2, restMinMinutes: 1, restMaxMinutes: 1 });
  const r = await h.runSaved();
  assert.equal(r.report.state, 'stopped');
  assert.equal(h.actual.get('a').attempts.length, 2);
  assert.deepEqual(h.longRests, [{ requested: 60000, elapsed: 1, aborted: true }]);
  assert.equal(h.batch(posts).summary().remaining, 2);
  assert.ok(!h.statuses.includes('limited'));
  console.log('cancel fixture', JSON.stringify({ state: r.report.state, rests: h.longRests, remaining: h.batch(posts).summary().remaining }));
});


test('saved preflight failure plus exact cap stays failed, makes no reassignment and preserves the next run', async t => {
  const posts=[post(3201,'preflight fails'),post(3201,'confirmed')];
  const h=harness(t,{}, {browser:{a:{neverReadyFirst:true}}});
  const plan=h.save(posts,['a'],['a'],{accountLimit:1});
  const first=await h.runSaved();
  const paused=!!h.readTask().recoveryPaused;
  assert.equal(first.report.state,'failed');
  assert.equal(h.history.at(-1).state,'failed');
  assert.equal(paused,true);
  assert.equal(first.report.items[0].reason,'custom_comments_incomplete');
  assert.deepEqual(structuredClone(first.report.customComments),{total:2,confirmed:1,pending:0,remaining:1});
  assert.deepEqual(h.readTask().commentAssignmentPlan,plan);
  assert.deepEqual(h.actual.get('a').attempts,[posts[1]]);
  assert.equal(h.accounts.get('a').status,'idle');

  const restored=harness(t,{}, {directory:h.directory,taskId:h.readTask().id});
  const next=await restored.runSaved();
  assert.equal(next.report.state,'success');
  assert.deepEqual(restored.actual.get('a').attempts,[posts[0]]);
  assert.deepEqual(h.transport,{model:0,action:0});
  console.log('mixed cap fixture', JSON.stringify({state:first.report.state, paused, retained:1, rerunReplays:0}));
});

test('actual daily-limit overlap keeps the capped share, but an earlier daily limit still releases it', async t => {
  const posts=Array.from({length:4},(_,i)=>post(3301+i,'dual limits '+i));
  const owners=Object.fromEntries(posts.map((p,i)=>[postKey(p),i===3?'b':'a']));
  for(const daily of [2,1]) {
    const h=harness(t,{}, {daily:{a:daily}});
    const result=await h.run(posts,{customCommentPolicy:{accountLimit:2},commentAssignmentPlan:{version:2,owners}});
    assert.equal(result.items.find(x=>x.accountId==='a').reason,'custom_comment_daily_limit');
    assert.deepEqual(h.actual.get('a').attempts,posts.slice(0,daily));
    const transferred=h.actual.get('b').attempts.filter(x=>x.url!==posts[3].url).length;
    if (daily===2) assert.equal(transferred,0);
    else assert.ok(transferred>0,'an earlier daily limit must release unsent work');
    assert.equal(h.actual.get('b').attempts.length,daily===2?1:2);
    assert.equal(result.customComments.remaining,1);
    if(daily===2) assert.ok(h.plans.every(plan=>plan.owners[postKey(posts[2])]==='a'));
    console.log('dual cap fixture', JSON.stringify({daily,round:2,transferred,remaining:1}));
  }
});

