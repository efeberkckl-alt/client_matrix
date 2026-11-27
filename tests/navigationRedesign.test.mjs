import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const source = fileURLToPath(new URL('../src/main/libs/matrix/', import.meta.url));
const compiled = await build({
  stdin: { contents: "export * from './accountManager'; export * from './kernelNavigation';", resolveDir: source },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'offline', setup(builder) {
    builder.onResolve({ filter: /^\.\/kernelPool$/ }, () => ({ path:'./kernelPool', external:true }));
    builder.onResolve({ filter: /coworkLogger|taskStore/ }, ({ path }) => ({ path, namespace: 'offline' }));
    builder.onLoad({ namespace: 'offline', filter: /.*/ }, () => ({
      contents: 'export const coworkLog=()=>{};export const pruneAccountFromTasks=()=>{};',
    }));
  } }],
});
const code = compiled.outputFiles[0].text;
const load = (dir, fault, proveCleanup = () => false) => {
  const module = { exports: {} };
  runInNewContext(code, {
    module, exports: module.exports, AbortSignal, AbortController, setTimeout, clearTimeout, Buffer, URL, console,
    process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: dir } },
    require: name => name === './kernelPool' ? { authenticProfileCleanupProof: proveCleanup } : name === 'fs' && fault ? { ...fs, renameSync(from, to) {
      if (fault(to)) throw Error('synthetic-write-fault');
      return fs.renameSync(from, to);
    } } : require(name),
  });
  return module.exports;
};
const make = (t, accounts) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-redesign-contract-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accountFile = path.join(dir, 'accounts.json');
  const safetyFile = path.join(dir, 'automation-safety.json');
  const original = JSON.stringify(accounts ?? [{ id: 'a', platform: 'tiktok', userDataDir: 'sandbox-profile-a', status: 'idle', boundUid: 'old' }]);
  fs.writeFileSync(accountFile, original);
  return { dir, accountFile, safetyFile, original, stored: () => JSON.parse(fs.readFileSync(accountFile, 'utf8')) };
};

test('migration snapshots original bytes and idempotently repairs a failed second-store acknowledgement', t => {
  const f = make(t);
  const old = JSON.stringify({ 'account:tiktok:old': { code: 'forbidden', reason: 'historic-pause', until: 10 },
    'group:proxy:local:123': { reason: 'test-group', until: 70 } });
  fs.writeFileSync(f.safetyFile, old);
  const failing = load(f.dir, file => file === f.safetyFile);
  assert.throws(() => failing.loadAccounts(), /storage_or_migration_hold/);
  assert.equal(failing.selectAvailability('a'), undefined);
  assert.equal(fs.readFileSync(f.safetyFile, 'utf8'), old);
  const first = f.stored();
  assert.equal(Object.keys(first.importReceipts).length, 1);
  const evidence = path.join(f.dir, 'migration-evidence');
  const snapshots = fs.readdirSync(evidence).map(file => fs.readFileSync(path.join(evidence, file), 'utf8'));
  assert.ok(snapshots.includes(f.original));
  assert.ok(snapshots.includes(old));
  const restarted = load(f.dir);
  const migrated = restarted.selectAvailability('a');
  assert.equal(migrated.available, false);
  assert.equal(migrated.probeEligible, true);
  assert.ok(migrated.reasons.includes('legacy_pause_recheck'));
  assert.equal(migrated.retryAt, 10);
  const saved = f.stored();
  const safety = JSON.parse(fs.readFileSync(f.safetyFile, 'utf8'));
  assert.deepEqual(Object.keys(saved.importReceipts), Object.keys(first.importReceipts));
  assert.deepEqual(safety.importAcks, Object.keys(saved.importReceipts));
  assert.deepEqual(JSON.parse(old)['group:proxy:local:123'], safety.pauses['group:proxy:local:123']);
  load(f.dir).loadAccounts();
  assert.deepEqual(f.stored(), saved);
});

test('unknown or damaged versions preserve both inputs and do not create a replacement account store', t => {
  for (const bad of [JSON.stringify({ formatVersion: 99, accounts: [] }), '{corrupted']) {
    const f = make(t);
    fs.writeFileSync(f.accountFile, bad);
    assert.throws(() => load(f.dir).loadAccounts(), /storage_or_migration_hold/);
    assert.equal(fs.readFileSync(f.accountFile, 'utf8'), bad);
    assert.equal(fs.existsSync(f.safetyFile), false);
  }
});

test('clearance of billing preserves hard refusal and the full live cooldown on disk and after restart', t => {
  const f = make(t);
  const store = load(f.dir);
  const bill = store.registerDispatch('a', 'billing', { action: 'comment', platform: 'tiktok', refId: 'transaction-1', at: 12 });
  const request = store.observeRoot('a', 'instance', 'wire', 4);
  const deadline = Date.now() + 7200_000;
  store.recordRootProtection(request, 'forbidden');
  store.recordRootProtection(request, 'rate_limited', deadline);
  store.archiveDispatchedResult(bill, 'charge_uncertain');
  store.resolveAccountChargeUncertain('a');
  const restarted = load(f.dir);
  const view = restarted.selectAvailability('a');
  assert.ok(view.reasons.includes('forbidden'));
  assert.ok(view.reasons.includes('rate_limited'));
  assert.equal(view.available, false);
  assert.equal(view.probeEligible, false);
  assert.equal(f.stored().accounts[0].recovery.nextCheckAt, deadline);
  assert.equal(f.stored().dispatchRecords[bill.id].result, 'acknowledged');
});

test('old identities retain their late root and debit results without blocking a different bound UID', t => {
  const f = make(t);
  const store = load(f.dir);
  const bill = store.registerDispatch('a', 'billing', { action: 'comment', platform: 'tiktok', refId: 'tx-late', at: 1234 });
  const observation = store.observeRoot('a', 'chromium-old', 'wire-old', 7);
  let token = store.reserveAssociation('a', 'new-scan');
  token = store.bindAssociation(token, 'chromium-new');
  assert.equal(store.commitIdentity(token, { boundUid: 'new' }), true);
  assert.equal(store.confirmAvailability(token, true).available, true);
  store.archiveDispatchedResult(bill, 'charge_uncertain');
  store.archiveDispatchedResult(bill, 'charge_uncertain');
  store.recordRootProtection(observation, 'forbidden');
  store.recordRootProtection(observation, 'forbidden');
  assert.equal(store.selectAvailability('a').available, true);
  assert.equal(f.stored().accounts[0].boundUid, 'new');
  assert.deepEqual(f.stored().archivedSubjects['tiktok:old'].map(p => p.kind), ['billing_uncertain', 'forbidden']);
  assert.equal(f.stored().dispatchRecords[bill.id].refId, 'tx-late');
  assert.equal(f.stored().dispatchRecords[bill.id].at, 1234);
});

test('unresolved billing dispatch is faulted on restart and a failed write never authorizes another dispatch', t => {
  const f = make(t);
  let fail = false;
  const store = load(f.dir, file => fail && file === f.accountFile);
  const bill = store.registerDispatch('a', 'billing', { action: 'comment', platform: 'tiktok', refId: 'crash-1', at: 1 });
  fail = true;
  assert.throws(() => store.archiveDispatchedResult(bill, 'confirmed'), /storage_or_migration_hold/);
  assert.equal(f.stored().dispatchRecords[bill.id].result, undefined);
  let sends = 0;
  const send = () => {
    store.registerDispatch('a', 'comment', { action: 'comment', platform: 'tiktok', at: 2 });
    sends++;
  };
  assert.throws(send, /storage_or_migration_hold/);
  assert.equal(sends, 0);
  const restarted = load(f.dir);
  assert.equal(restarted.selectAvailability('a').available, false);
  assert.equal(f.stored().dispatchRecords[bill.id].result, 'charge_uncertain');
});

test('queued Cookie result after disconnect cannot release isolation or mutate a new association', t => {
  const f = make(t);
  const store = load(f.dir);
  let token = store.reserveAssociation('a', 'scan-1');
  token = store.bindAssociation(token, 'instance-A');
  const mutation = store.recordCookieMutation('a', 'instance-A', 'connection-A', false, token, true);
  store.beginProfileDisconnect('a');
  assert.equal(store.isCurrentAssociation(token), false);
  for (const result of [true, false, null]) assert.equal(store.confirmAvailability(token, result), undefined);
  assert.equal(store.commitIdentity(token, { boundUid: 'stale' }), false);
  assert.throws(() => store.recordCookieMutation('a', 'instance-A', 'connection-A', false, token), /navigation:cancelled/);
  store.settleCookieMutation(mutation, 'completed');
  const restarted = load(f.dir);
  assert.throws(() => restarted.reserveAssociation('a', 'scan-2'), /profile_cleanup_unconfirmed/);
  assert.equal(restarted.selectAvailability('a').probeEligible, false);
  assert.equal(f.stored().accounts[0].manualDisconnect, true);
  assert.equal(f.stored().accounts[0].boundUid, undefined);
});

test('restart observes an unacknowledged Cookie mutation only on its associated account', t => {
  const f = make(t, ['a', 'b'].map(id => ({ id, platform: 'tiktok', userDataDir: id, status: 'idle', boundUid: id })));
  let store = load(f.dir);
  const token = store.bindAssociation(store.reserveAssociation('a'), 'A');
  store.recordCookieMutation('a', 'A', 'connection-A', false, token, true);
  store = load(f.dir);
  assert.equal(store.selectAvailability('a').available, false);
  assert.equal(store.selectAvailability('b').available, true);
  assert.throws(() => store.reserveAssociation('a'), /profile_cleanup_unconfirmed/);
  assert.ok(store.reserveAssociation('b', 'scan-b').attemptId);
});

test('a new lifecycle generation requires fresh probe evidence on BFCache restoration', async t => {
  const f = make(t);
  const { NavigationTrace } = load(f.dir);
  const events = [];
  const trace = new NavigationTrace('fixture-account', 'fixture-session', row => events.push(row), () => undefined);
  const old = { id: 'root', loaderId: 'old-loader', url: 'https://test.invalid/old' };
  trace.seed(old);
  trace.begin(old.url);
  trace.acknowledge({ frameId: old.id });
  const before = trace.snapshot();
  trace.observe('Page.frameNavigated', { frame: old, type: 'BackForwardCacheRestore' });
  assert.ok(trace.snapshot().generation > before.generation);
  assert.equal(await trace.waitForDocument(AbortSignal.timeout(250)), 'ownership_unconfirmed');
  assert.equal(trace.proveRoot(before.sequence, old, old.url, 'complete', ''), false);
  assert.equal(trace.proveRoot(trace.snapshot().sequence, old, old.url, 'complete', ''), true);
  assert.equal(await trace.waitForDocument(AbortSignal.timeout(250)), 'ready');
  assert.ok(events.every(row => row.status !== 200));
});

test('cleanup proof requires two distinct exited instances and only clears the matching isolation', async t => {
  const f = make(t);
  let verifiesProof = () => false;
  const store = load(f.dir, undefined, proof => verifiesProof(proof));
  const request = store.observeRoot('a', 'root', 'wire', 1);
  store.recordRootProtection(request, 'forbidden');
  store.trackProfileProcess('a', 'sandbox-profile-a', 'known-prior', 501);
  store.noteProfileProcessExit('a', 'known-prior');
  store.beginProfileDisconnect('a');
  const fence = store.captureAssociation('a');
  const cleanupId = f.stored().accounts[0].authority.cleanup.id;
  const proof = { fence, cleanupId, profile: 'sandbox-profile-a',
    clearing: { instance: 'clear-A', count: 0, exited: true },
    readback: { instance: 'read-B', count: 0, exited: true } };
  assert.equal(store.commitProfileCleanup({ ...proof, readback: proof.clearing }), false);
  assert.equal(store.commitProfileCleanup({ ...proof, readback: { ...proof.readback, count: 1 } }), false);
  assert.equal(store.commitProfileCleanup({ ...proof, cleanupId: 'wrong' }), false);
  assert.equal(store.commitProfileCleanup(proof), false, 'a correctly shaped object is insufficient');
  const ts = (await import('typescript')).default;
  const kernel = ts.createSourceFile('kernelPool.ts', fs.readFileSync(path.join(source, 'kernelPool.ts'), 'utf8'), ts.ScriptTarget.Latest, true);
  const selected = kernel.statements.filter(n => ts.isFunctionDeclaration(n) &&
    ['authenticProfileCleanupProof', 'cleanupProfileCookies'].includes(n.name?.text));
  assert.equal(selected.length, 2);
  const fragment = ts.transpileModule(selected.map(n => n.getText(kernel).replace(/^export /, '')).join('\n') +
    '\n({ authenticProfileCleanupProof, cleanupProfileCookies })', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = new Map(), refs = new Map();
  let serial = 0;
  let cookies = [{ token: 'synthetic-only' }];
  const api = runInNewContext(fragment, {
    sessions, refCount: refs, launching: new Map(), profileCleanupOwners: new Map(), profileReservations: new Map(), cleanupProofs: new WeakMap(),
    profileKey: value => path.resolve(value).toLowerCase(),
    profileCookieQueue: new Map(), closingProcs: new Map(), path, AbortSignal, setTimeout, clearTimeout, Date,
    accountAuthority: store, getAccount: store.getAccount,
    acquireKernel: async options => {
      assert.equal(options.headless, true);
      const session = { diagnosticsId: 'fixture-' + ++serial, userDataDir: options.userDataDir, debugPort: 19001, process: { exitCode: null } };
      sessions.set(options.accountId, session);
      refs.set(options.accountId, 1);
      return { sessionInstanceId: session.diagnosticsId, accountId: options.accountId };
    },
    getPage: async id => sessions.get(id),
    devFetchJson: async () => [{ type: 'page', url: 'about:blank' }],
    kernelClearCookies: async () => { cookies = []; },
    send: async (_s, command) => { assert.equal(command, 'Network.getAllCookies'); return { cookies }; },
    releaseKernel: receipt => { sessions.get(receipt.accountId).process.exitCode = 0; sessions.delete(receipt.accountId); },
  });
  verifiesProof = api.authenticProfileCleanupProof;
  assert.equal(store.commitProfileCleanup(proof), false);
  assert.equal(await api.cleanupProfileCookies({ accountId: 'a', userDataDir: 'sandbox-profile-a' }), true);
  assert.equal(serial, 2);
  const saved = load(f.dir);
  assert.ok(saved.reserveAssociation('a', 'new-attempt').attemptId);
  assert.ok(saved.selectAvailability('a').reasons.includes('forbidden'));
  assert.equal(saved.selectAvailability('a').available, false);
});

test('legacy idle and running writes cannot clear an expired cooldown or invent verified availability', t => {
  const f = make(t);
  fs.writeFileSync(f.safetyFile, JSON.stringify({
    'account:tiktok:old': { code: 'rate_limited', reason: 'old-cooldown', until: 20 },
  }));
  const store = load(f.dir);
  store.setAccountStatus('a', 'idle', '');
  store.setAccountStatus('a', 'running');
  assert.equal(store.selectAvailability('a').available, false);
  assert.ok(store.selectAvailability('a').reasons.includes('rate_limited'));
  const fence = store.captureAssociation('a');
  assert.equal(store.confirmAvailability(fence, true).available, true);
  assert.equal(load(f.dir).selectAvailability('a').available, true);
});

test('late release checks the exact lease and cannot close or release a replacement instance', async () => {
  const ts = (await import('typescript')).default;
  const input = fs.readFileSync(path.join(source, 'kernelPool.ts'), 'utf8');
  const ast = ts.createSourceFile('kernelPool.ts', input, ts.ScriptTarget.Latest, true);
  const functions = ast.statements.filter(node => ts.isFunctionDeclaration(node) &&
    ['acquireKernel', 'releaseKernel', 'releaseLease'].includes(node.name?.text));
  assert.equal(functions.length, 3);
  const fragment = ts.transpileModule(functions.map(node => node.getText(ast).replace(/^export /, '')).join('\n') +
    '\n({ acquireKernel, releaseKernel })', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const sessions = new Map(), leaseHeld = new Map(), closes = [], released = [];
  const api = runInNewContext(fragment, {
    sessions, leaseHeld, kernelLeases: new WeakMap(), randomUUID: require('node:crypto').randomUUID,
    getAccount: () => ({}),
    launchKernel: async opts => sessions.get(opts.accountId),
    closeKernel: (id, opts) => closes.push([id, opts.skipLease]),
  });
  sessions.set('a', { diagnosticsId: 'instance-A', userDataDir: 'synthetic-profile' });
  leaseHeld.set('a', () => released.push('old'));
  const old = await api.acquireKernel({ accountId: 'a' });
  sessions.set('a', { diagnosticsId: 'instance-B', userDataDir: 'synthetic-profile' });
  leaseHeld.set('a', () => released.push('replacement'));
  const fresh = await api.acquireKernel({ accountId: 'a' });
  assert.equal(api.releaseKernel(old), 'alreadyReleased');
  assert.equal(api.releaseKernel(old), 'alreadyReleased');
  assert.equal(sessions.get('a').diagnosticsId, 'instance-B');
  assert.deepEqual(released, []);
  assert.deepEqual(closes, []);
  assert.equal(api.releaseKernel(fresh), 'released');
  assert.equal(api.releaseKernel(fresh), 'alreadyReleased');
  assert.deepEqual(closes, [['a', false]]);
});
