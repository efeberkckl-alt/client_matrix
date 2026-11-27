import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { setImmediate as nextTurn } from 'node:timers/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { build, transformSync } from 'esbuild';

const root = process.env.QA_REWORK_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url));
const matrix = path.join(root, 'src/main/libs/matrix');
const require = createRequire(path.join(root, 'package.json'));
const read = name => fs.readFileSync(name, 'utf8');
const code = (await build({
  stdin: { contents: "export * from './accountManager'; export * from './customCommentBatch'; export * from './taskStore'; export * from './profileIdentity';", resolveDir: matrix },
  bundle: true, write: false, platform: 'node', format: 'cjs', packages: 'external',
  plugins: [{ name: 'isolated', setup(build) {
    build.onResolve({ filter: /coworkLogger|\/kernelPool$/ }, args => ({ path: args.path, namespace: 'isolated' }));
    build.onLoad({ filter: /.*/, namespace: 'isolated' }, () => ({
      contents: 'export const coworkLog=()=>{}; export const authenticProfileCleanupProof=()=>false;',
    }));
  } }],
})).outputFiles[0].text;

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-qa2-'));
  const accounts = path.join(dir, 'accounts.json');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const rows = ['a', 'b', 'c', 'd'].map(id => ({
    id, platform: 'tiktok', status: 'idle', boundUid: 'synthetic-' + id, userDataDir: path.join(dir, 'fixture-profile-' + id),
  }));
  fs.writeFileSync(accounts, JSON.stringify(rows));
  return { dir, accounts, rows, saved: () => JSON.parse(read(accounts)) };
}

function boot(fixture, { kill = () => assert.fail('no real process lookup'), failOnRename } = {}) {
  const module = { exports: {} };
  const fsAdapter = failOnRename ? { ...fs, renameSync(from, to) {
    if (failOnRename(to)) throw Error('test-write-failure');
    fs.renameSync(from, to);
  } } : fs;
  runInNewContext(code, {
    module, exports: module.exports, URL, Buffer, AbortSignal, AbortController, setTimeout, clearTimeout,
    require: name => name === 'fs' ? fsAdapter : require(name),
    process: { env: { NOOBCLAW_MATRIX_DIR: fixture.dir }, pid: process.pid, platform: process.platform, kill },
  });
  return module.exports;
}

function extract(file, names, context) {
  const source = ts.createSourceFile(file, read(path.join(matrix, file)), ts.ScriptTarget.ES2022, true);
  const declarations = names.map(name => {
    const result = source.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
    assert.ok(result, name);
    return result.getText(source).replace(/^export /, '');
  });
  return runInNewContext(ts.transpileModule(declarations.join('\n') + '\n({ ' + names.join(', ') + ' })',
    { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, context);
}

const post = { url: 'https://www.tiktok.com/@fixture/video/7462100000000000188', text: 'test-only evidence' };
const another = { url: 'https://www.tiktok.com/@fixture/video/7462100000000000189', text: 'different fixture' };
const key = JSON.stringify(['7462100000000000188', post.text]);
const preSend = { author: 'fixture', count: 1, ids: ['old'] };
const observed = { ...preSend, count: 2, ids: ['old', 'new'] };
const draft = { commentPosts: [post], accountIds: ['a'] };

test('Q1 preview and execution use original evidence across missing, copied, valid, wrong-subject and legacy rows', t => {
  for (const variant of ['absent', 'copy', 'valid', 'wrong-subject', 'legacy']) {
    const f = fixture(t);
    let store = boot(f);
    let opened = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
    if (variant === 'legacy') {
      opened.prepare(key, 'a', preSend);
      opened.confirm(key, 'a', observed, 'same_page');
    } else {
      const receipt = store.registerDispatch('a', 'comment', {
        platform: 'tiktok', action: 'comment', at: Date.now(), ledgerKey: key, ledgerId: opened.ledgerId,
      });
      opened.prepare(key, 'a', preSend, receipt.id);
      opened.confirm(key, 'a', observed, 'same_page');
      if (variant === 'absent') fs.unlinkSync(opened.file);
      if (variant === 'copy') {
        const clone = new store.CustomCommentBatch(f.dir, [post, another], { reconcile: true });
        fs.unlinkSync(opened.file);
        assert.equal(JSON.parse(read(clone.file)).entries[key].status, 'confirmed');
      }
      if (variant === 'wrong-subject') {
        const corrupt = JSON.parse(read(opened.file));
        corrupt.entries[key].dispatchSubject = 'tiktok:unrelated';
        fs.writeFileSync(opened.file, JSON.stringify(corrupt));
      }
    }
    store = boot(f);
    const inventory = () => fs.readdirSync(f.dir, { recursive: true, withFileTypes: true })
      .filter(file => file.isFile()).map(file => [file.name, read(path.join(file.parentPath, file.name))]).sort();
    const beforePreview = inventory();
    const expected = ['valid', 'legacy'].includes(variant) ? 'confirmed' : 'pending';
    const preview = store.previewCustomCommentAssignments(draft, ['a']);
    assert.equal(preview.ledger[key].status, expected, variant);
    assert.deepEqual(inventory(), beforePreview, 'preview performs no writes, including on a cold account module');
    opened = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
    assert.equal(opened.readLedger()[key], expected, variant);
    assert.throws(() => opened.prepare(key, 'a', preSend), /\u5df2\u6709\u53d1\u9001\u8bb0\u5f55/);
  }
});

test('Q1 a failed original confirmation write does not change preview, execution or dispatch status', t => {
  const f = fixture(t);
  let store = boot(f);
  const initial = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
  const receipt = store.registerDispatch('a', 'comment', {
    platform: 'tiktok', action: 'comment', at: Date.now(), ledgerKey: key, ledgerId: initial.ledgerId,
  });
  initial.prepare(key, 'a', preSend, receipt.id);
  let fail = false;
  store = boot(f, { failOnRename: file => fail && file === initial.file });
  const batch = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
  fail = true;
  assert.throws(() => batch.confirm(key, 'a', observed, 'same_page'), /test-write-failure/);
  store = boot(f);
  assert.equal(store.previewCustomCommentAssignments(draft, ['a']).ledger[key].status, 'pending');
  const retry = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
  assert.equal(retry.pendingFor('a').length, 1);
  assert.equal(retry.pendingFor('b').length, 0);
  assert.equal(store.getDispatchedReceipt(receipt.id).result, 'comment_pending');
});

test('Q2 junctions share the durable identity, and moving their target cannot release either affected instance', t => {
  const f = fixture(t);
  const [a, b, c, d] = f.rows;
  for (const row of [b, c, d]) fs.mkdirSync(row.userDataDir);
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  fs.symlinkSync(b.userDataDir, a.userDataDir, linkType);
  let store = boot(f);
  const original = store.identifyProfile(a.userDataDir);
  assert.equal(original.key, store.identifyProfile(b.userDataDir).key);
  const opening = store.bindAssociation(store.reserveAssociation('a', 'scan-one'), 'instance-one');
  const receipt = store.recordCookieMutation('a', 'instance-one', 'wire-one', false, opening, true);
  assert.equal(store.selectAvailability('b').available, false);
  assert.equal(store.selectAvailability('c').available, true);
  fs.renameSync(a.userDataDir, path.join(f.dir, 'previous-alias'));
  fs.symlinkSync(d.userDataDir, a.userDataDir, linkType);
  store.settleCookieMutation(receipt, 'completed');
  store = boot(f);
  for (const id of ['a', 'b', 'd']) {
    assert.equal(store.selectAvailability(id).available, false, id);
    assert.throws(() => store.reserveAssociation(id, 'scan-two'), /profile_cleanup_unconfirmed/);
  }
  assert.equal(store.selectAvailability('c').available, true);
  assert.equal(store.profilePriorOwnerExited('a', a.userDataDir), false);
  assert.equal(Object.values(f.saved().accounts[0].authority.mutations)[0].profile.key, original.key);
});

test('Q3 manual skips and retained navigation enforce persisted profile isolation, while another directory works', async t => {
  const f = fixture(t);
  const [a, b, c] = f.rows;
  fs.mkdirSync(a.userDataDir);
  fs.mkdirSync(c.userDataDir);
  fs.symlinkSync(a.userDataDir, b.userDataDir, process.platform === 'win32' ? 'junction' : 'dir');
  let store = boot(f);
  const fence = store.bindAssociation(store.reserveAssociation('a','connect-one'), 'first-instance');
  store.recordCookieMutation('a','first-instance','wire',false,fence,true);
  store = boot(f);
  const sessions = new Map();
  const loads = [];
  const env = {
    accountAuthority: store, getAccount: store.getAccount, sessions, launching: new Map(), refCount: new Map(),
    closingProcs: new Map(), profileCleanupOwners: new Map(), profileReservations: new Map(),
    profileKey: dir => store.identifyProfile(dir).directory, AutomationSafetyError: class extends Error {},
    KernelNavigationError: class extends Error {}, bindKernelSignal() {}, automationSafety: { signal() {}, end() {} },
    doLaunch: async opts => { loads.push(opts.accountId); return {}; },
    kernelLeaseScope: { getStore() {} }, kernelSignal() {}, WebSocket: { OPEN: 1 },
  };
  const { launchKernel, getPage } = extract('kernelPool.ts', ['launchKernel', 'getPage'], env);
  const open = (row, fields = {}) => launchKernel({ accountId: row.id, userDataDir: row.userDataDir, skipLease: true, ...fields });
  await assert.rejects(open(b), /ownership_unconfirmed/);
  await assert.rejects(open(a, { cleanupOwner: {} }), /ownership_unconfirmed/);
  await open(c);
  assert.deepEqual(loads, ['c']);
  const current = row => ({ accountId: row.id, userDataDir: row.userDataDir, authoritativeAccount: true,
    profileIdentityKey: store.identifyProfile(row.userDataDir).key, pageWs: { readyState: 1 } });
  sessions.set('b', current(b));
  sessions.set('c', current(c));
  await assert.rejects(getPage('b'), /ownership_unconfirmed/);
  assert.equal(await getPage('c'), sessions.get('c'));
  const cleanupOwner = {};
  sessions.set('c', { ...sessions.get('c'), cleanupMode: true, cleanupOwner });
  await assert.rejects(getPage('c'), /ownership_unconfirmed/);
  await assert.rejects(getPage('c', {}), /ownership_unconfirmed/);
  assert.equal(await getPage('c', cleanupOwner), sessions.get('c'));
});

test('Q4 only the prior instance exit unlocks transfer, and interrupted owner writes recover conservatively', t => {
  const f = fixture(t);
  fs.mkdirSync(f.rows[0].userDataDir);
  const directory = f.rows[0].userDataDir;
  let alive = true;
  const kill = (pid, signal) => {
    assert.equal(pid, 41001);
    assert.equal(signal, 0);
    if (!alive) throw Object.assign(Error('gone in fixture'), { code: 'ESRCH' });
  };
  let store = boot(f, { kill });
  store.trackProfileProcess('a', directory, 'old', 41001);
  store = boot(f, { kill });
  assert.throws(() => store.trackProfileProcess('a', directory, 'new'), /profile_cleanup_unconfirmed/);
  store.noteProfileProcessExit('a', 'new');
  assert.equal(store.profilePriorOwnerExited('a', directory), false);
  assert.equal(f.saved().accounts[0].authority.browserOwner.instance, 'old');
  alive = false;
  let interrupted = false;
  store = boot(f, { kill, failOnRename: file => interrupted && file === f.accounts });
  assert.equal(store.profilePriorOwnerExited('a', directory), true);
  interrupted = true;
  assert.throws(() => store.trackProfileProcess('a', directory, 'new'), /storage_or_migration_hold/);
  store = boot(f, { kill });
  assert.equal(f.saved().accounts[0].authority.browserOwner.instance, 'old');
  store.trackProfileProcess('a', directory, 'new');
  store = boot(f, { kill });
  assert.equal(store.profilePriorOwnerExited('a', directory), false, 'pre-spawn reservation with no PID survives a crash as unknown');
  assert.throws(() => store.trackProfileProcess('a', directory, 'replacement'), /profile_cleanup_unconfirmed/);
  store.noteProfileProcessExit('a', 'new');
  assert.equal(store.profilePriorOwnerExited('a', directory), true);
});

test('Q4 actual launch spawn failure can settle only its own unstarted reservation', async t => {
  const f = fixture(t);
  const directory = f.rows[0].userDataDir;
  let store = boot(f);
  const { doLaunch } = extract('kernelPool.ts', ['doLaunch'], {
    accountAuthority: store, getAccount: store.getAccount, fs, path, randomUUID, installedKernelPath: () => 'fake-kernel',
    sessions: new Map(), closingProcs: new Map(), buildKernelArgs: () => [], coworkLog() {}, diagnosticAccountAlias: () => 'fixture',
    spawn() { throw Error('fixture refuses to spawn'); }, KernelNavigationError: Error,
  });
  await assert.rejects(doLaunch({ accountId: 'a', userDataDir: directory }), /kernel_start:spawn_failed/);
  store = boot(f);
  assert.equal(store.profilePriorOwnerExited('a', directory), true);
  assert.equal(f.saved().accounts[0].authority.browserOwner.exited, true);
});

async function chargeServer(t, behavior = () => 'confirm') {
  const requests = [];
  const server = http.createServer(async (req, res) => {
    let body = '';
    for await (const piece of req) body += piece;
    requests.push(JSON.parse(body));
    if (await behavior(requests.length) === 'lost') return req.socket.destroy();
    res.setHeader('Content-Type', 'application/json');
    res.end('{"ok":true,"charged":1,"balance_after":60}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => { server.closeAllConnections(); server.close(); });
  return { requests, baseUrl: () => 'http://127.0.0.1:' + server.address().port };
}

function publishRuntime(store, baseUrl, posts, beforePublish = async () => {}) {
  const publishedSubjects = new WeakMap();
  const accountManager = store;
  const taskRunner = extract('taskRunner.ts', ['prepareMatrixPublishTask', 'runMatrixTask', 'completeMatrixPublish', 'chargeSuccess'], {
    ...store, publishedSubjects, fetch, AbortSignal, baseUrl, coworkLog() {},
    installedKernelPath: () => 'synthetic-kernel',
    async runPool(ids, _limit, item) { return Promise.all(ids.map(item)); },
    async runOne(opts, id) {
      await beforePublish();
      if (opts.signal?.aborted) return { accountId: id, state: 'skipped', reason: 'aborted' };
      const input = opts.getInput(id);
      posts.push({ id, title: input.title });
      const result = { accountId:id, state:'success', publishedUrl:'https://fixture.invalid/' + input.title };
      publishedSubjects.set(result, store.captureDispatchSubject(id, { instance:'synthetic', connection:'loopback', generation:1 }));
      return result;
    },
  });
  const source = read(path.join(root, 'src/main/sidecar-server.ts'));
  const start = source.indexOf("case 'matrix:listPublishRuns':");
  const stop = source.indexOf("case 'matrix:runEngage':", start);
  assert.ok(start >= 0 && stop > start);
  const ipcBody = transformSync('return async (channel,args) => { switch (channel) {\n' +
    source.slice(start, stop)
      .replaceAll("await import('./libs/matrix/taskRunner')", 'taskRunner')
      .replaceAll("await import('./libs/matrix/accountManager')", 'accountManager') + '\n}};', { loader: 'ts' }).code;
  const waiting = [];
  const abortByPlatform = new Map();
  const invoke = new Function('accountManager', 'taskRunner', 'runningPlatforms', 'MATRIX_MAX_CONCURRENT',
    'abortByPlatform', 'runningTaskByPlatform', 'AbortController', 'writeJSON', 'res', 'broadcastSSE', ipcBody)(
    accountManager, taskRunner, new Set(), 5, abortByPlatform, new Map(), AbortController, (_res, _code, body) => body, {},
    (_event, value) => { if (value.type === 'done' || value.type === 'error') waiting.shift()?.(value); },
  );
  const shim = read(path.join(root, 'src/renderer/tauriShim.ts'));
  const slice = shim.slice(shim.indexOf('      listPublishRuns: '), shim.indexOf('      runTaskById: '));
  const bridge = runInNewContext(transformSync('({' + slice + '})', { loader:'ts' }).code, {
    ipcInvoke: (channel, arg) => invoke(channel, [arg]),
  });
  return { bridge, abortByPlatform, terminal: () => new Promise(resolve => waiting.push(resolve)) };
}

const command = { platform:'tiktok', taskId:'fixture-task', accountIds:['a'], authToken:'offline', input:{
  videoPath:'local-synthetic.mp4', title:'alpha', tags:['one','two'], extra:{ z:2, a:1 },
} };
function assertPost(r, n) {
  assert.equal(r.requests.length,n);
  assert.deepEqual(r.requests, Array.from({ length:n }, () => ({ platform:'tiktok', count:1 })));
}

for (const lost of [false, true]) {
  test(`Q5/Q6 real prepare and resume bridge preserves one publish and one charge after ${lost?'wallet':'IPC'} reply loss`, async t => {
    const f = fixture(t), posts = [];
    const r = await chargeServer(t, n => lost && n===1 ? 'lost' : 'confirm');
    const active = publishRuntime(boot(f), r.baseUrl, posts);
    const snapshot = read(f.accounts);
    assert.equal((await active.bridge.runTask(command)).error, 'matrix_operation_id_required');
    assert.equal(read(f.accounts), snapshot, 'legacy request cannot prepare or execute');
    const prepared = await active.bridge.preparePublishRun(command);
    assert.equal(prepared.ok,true);
    assert.equal(f.saved().publishRuns[prepared.runOperationId].phase,'prepared');
    assert.equal(posts.length,0);
    assertPost(r,0);
    const request = { ...command, runOperationId: prepared.runOperationId };
    const done = active.terminal();
    void active.bridge.runTask(request); // Deliberately discard the first IPC reply.
    const event = await done;
    assert.equal(event.type,'done');
    assert.equal(event.report.items[0].publishedUrl,'https://fixture.invalid/alpha');
    assert.equal(posts.length,1);
    assertPost(r,1);
    const restarted = publishRuntime(boot(f), r.baseUrl, posts);
    const listed = (await restarted.bridge.listPublishRuns()).runs.find(run => run.runOperationId === request.runOperationId);
    assert.equal(listed.status,'finished');
    assert.equal(listed.billingResult,lost?'charge_uncertain':'confirmed');
    const recovered = restarted.terminal();
    assert.equal((await restarted.bridge.resumePublishRun(request)).runOperationId,request.runOperationId);
    const prior = await recovered;
    assert.equal(prior.report.charged?.charged,lost?undefined:1);
    assert.equal(posts.length,1);
    assertPost(r,1);
    assert.equal((await restarted.bridge.runTask({ ...command, input:{ ...command.input, title:'different' } })).error,'matrix_operation_id_required');
    assert.equal(posts.length,1);
    assertPost(r,1);
    if (!lost) {
      const another = await restarted.bridge.preparePublishRun({ ...command, input:{ ...command.input, title:'beta' } });
      assert.notEqual(another.runOperationId,request.runOperationId);
      const anotherDone = restarted.terminal();
      const result = await restarted.bridge.runTask({ ...command, input:{ ...command.input, title:'beta' }, runOperationId:another.runOperationId });
      assert.equal(result.ok,true);
      assert.equal((await anotherDone).report.items[0].state,'success');
      assert.equal(posts.length,2);
      assertPost(r,2);
    }
  });
}

test('Q7 normalized request identity rejects a changed account, input or rebound subject before publishing', async t => {
  const f=fixture(t), posts=[];
  const r=await chargeServer(t);
  const store=boot(f);
  const active=publishRuntime(store,r.baseUrl,posts);
  const request={...command,runOperationId:'stable-command'};
  const prepared=await active.bridge.preparePublishRun(request);
  assert.equal(prepared.ok,true);
  const mismatches=[
    {...request,accountIds:['b']},
    {...request,input:{...command.input,title:'changed'}},
    {...request,input:{...command.input,tags:['two','one']}},
    {...request,authToken:undefined},
  ];
  for(const changed of mismatches) assert.equal((await active.bridge.resumePublishRun(changed)).error,'matrix_operation_mismatch');
  assert.equal(posts.length,0);
  assertPost(r,0);
  const terminal=active.terminal();
  const reordered={...request,input:{ extra:{a:1,z:2}, tags:['one','two'], title:'alpha', videoPath:'local-synthetic.mp4' }};
  assert.equal((await active.bridge.runTask(reordered)).ok,true);
  assert.equal((await terminal).report.items[0].state,'success');
  assertPost(r,1);
  assert.equal((await active.bridge.runTask({...request,accountIds:['b']})).error,'matrix_operation_mismatch');
  const fence=store.bindAssociation(store.reserveAssociation('a','replacement-scan'),'new-instance');
  assert.equal(store.commitIdentity(fence,{boundUid:'replacement-subject'}),true);
  store.finishAssociation(fence);
  const restarted=publishRuntime(boot(f),r.baseUrl,posts);
  assert.equal((await restarted.bridge.resumePublishRun(request)).error,'matrix_operation_subject_changed');
  assert.equal(posts.length,1);
  assertPost(r,1);
  const receipt=Object.values(f.saved().dispatchRecords)[0];
  assert.equal(receipt.subjects[0].subject,'tiktok:synthetic-a');
});

test('Q5–Q7 concurrent resume, cancellation and a started run with no outcome cannot repeat publish', async t => {
  const f=fixture(t), posts=[];
  const r=await chargeServer(t);
  let arrived, release;
  const reached=new Promise(resolve=>{arrived=resolve;});
  const blocked=new Promise(resolve=>{release=resolve;});
  const runtime=publishRuntime(boot(f),r.baseUrl,posts,async()=>{arrived();await blocked;});
  const prepared=await runtime.bridge.preparePublishRun(command);
  const request={...command,runOperationId:prepared.runOperationId};
  const terminal=runtime.terminal();
  assert.equal((await runtime.bridge.runTask(request)).ok,true);
  await reached;
  assert.equal((await runtime.bridge.resumePublishRun(request)).error,'another_task_running');
  const restarted=publishRuntime(boot(f),r.baseUrl,posts);
  assert.equal((await restarted.bridge.resumePublishRun(request)).error,'matrix_publish_recovery_required');
  runtime.abortByPlatform.get('tiktok').abort();
  release();
  assert.equal((await terminal).report.items[0].reason,'aborted');
  const afterward=publishRuntime(boot(f),r.baseUrl,posts);
  const recovered=afterward.terminal();
  assert.equal((await afterward.bridge.resumePublishRun(request)).ok,true);
  assert.equal((await recovered).report.items[0].reason,'aborted');
  assert.equal(posts.length,0);
  assertPost(r,0);
});

test('Q7 legacy runs remain queryable but none can authorize publishing or debit without proven identity', async t => {
  const f=fixture(t), posts=[];
  const store=boot(f);
  store.loadAccounts();
  const legacy={id:'legacy-operation',platform:'tiktok',taskId:command.taskId,startedAt:1,billingRequested:true,
    outcome:{items:[{accountId:'a',state:'success'}],subjects:[]}};
  const saved=f.saved();
  saved.publishRuns={[legacy.id]:legacy};
  fs.writeFileSync(f.accounts,JSON.stringify(saved));
  const r=await chargeServer(t);
  const active=publishRuntime(boot(f),r.baseUrl,posts);
  assert.equal((await active.bridge.listPublishRuns()).runs[0].status,'legacy_unverifiable');
  assert.equal((await active.bridge.resumePublishRun({...command,runOperationId:legacy.id})).error,'matrix_legacy_operation_unverifiable');
  assert.equal((await active.bridge.resumePublishRun({...command,runOperationId:'never-prepared'})).error,'matrix_operation_not_found');
  assert.equal(posts.length,0);
  assertPost(r,0);
  assert.deepEqual(f.saved().publishRuns[legacy.id],legacy);
});
