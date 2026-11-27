import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const src = new URL('../src/', import.meta.url);
const dir = 'main/libs/matrix/';
const transpile = s => ts.transpileModule(s, { compilerOptions: {
  target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true,
} }).outputText;
const read = name => fs.readFileSync(new URL(name, src), 'utf8');

function fixture(t, options = {}) {
  const root = fs.mkdtempSync(path.join(process.env.NOOBCLAW_MATRIX_DIR || os.tmpdir(), 'manual-recovery-'));
  const now = Date.now(), until = now + 3_600_000;
  const first = options.first === true;
  const row = (id, props) => ({ id, platform: 'tiktok', displayName: id, userDataDir: path.join(root, 'profiles', id),
    status: 'limited', authority: { incarnation: 'i-' + id, epoch: '0', revision: '0', verified: id !== 'a' || !first,
      constraints: [] }, ...props });
  const a = row('a', { boundUid: first ? undefined : 'self',
    recovery: first ? { attempts: 1, reason: 'login_unknown', nextCheckAt: until } : undefined });
  a.authority.constraints = [{ kind: first ? 'technical' : 'forbidden', ...(first ? { until } : {}) },
    ...(options.extra || []).map(kind => ({ kind, until: kind === 'rate_limited' ? until : undefined }))];
  a.statusReason = first ? 'Waiting: login_unknown' : 'forbidden';
  const other = row('b', { boundUid: options.duplicate ? 'self' : 'other', status: 'idle' });
  const safeties = {
    'account:a': { code: 'forbidden', reason: 'A current 403', until },
    'account:tiktok:self': { code: options.ratePause ? 'rate_limited' : 'forbidden', reason: 'A prior hold', until },
    'account:b': { code: 'forbidden', reason: 'B current 403', until },
    'group:unrelated': { reason: 'Unrelated group', until },
    ...(options.group ? { 'group:local:unknown': { reason: 'Current group', until } } : {}),
  };
  // For the coexistence case include a canonical imported rate receipt. This
  // preserves the actual 3.4.92 migration boundary without remigrating a fixture hold.
  const importReceipts = options.ratePause ? { 'existing-rate': { scope: 'account:tiktok:self',
    canonical: JSON.stringify({ code: 'rate_limited', reason: 'A prior hold', until }) } } : {};
  const archive = { 'tiktok:self': [{ kind: 'forbidden', source: 'old' }], 'tiktok:other': [{ kind: 'forbidden' }] };
  fs.writeFileSync(path.join(root, 'accounts.json'), JSON.stringify({ formatVersion: 1, storeId: 'fixture',
    storeRevision: '0', accounts: [a, other], archivedSubjects: first ? {} : archive, importReceipts, dispatchRecords: {} }));
  fs.writeFileSync(path.join(root, 'automation-safety.json'), JSON.stringify(first ? {} : safeties));
  const calls = [], events = [], imports = new Map();
  const accountFile=path.join(root,'accounts.json'), safetyFile=path.join(root,'automation-safety.json');
  const io = {};
  const fsView = {...fs, renameSync(from, to) {
    const which = to === accountFile ? 'account' : to === safetyFile ? 'safety' : undefined;
    if (which) io.beforeRename?.(which,to);
    fs.renameSync(from,to);
    if (which) io.afterRename?.(which,to);
  }};
  let generation = 10, epoch = 'conn-1', launchCount = 0;
  let restrictionReads = 0;
  const expected = 'https://www.tiktok.com/';
  const kernel = {
    getSession: () => undefined,
    acquireKernel: async () => { launchCount++; throw Error('fixture stops before launch'); },
    launchKernel: async () => { launchCount++; throw Error('fixture stops before launch'); },
    navigateForAccountReview: async (id, url) => {
      calls.push(['navigate', id, url]);
      if (options.navigationError && url === (options.failURL || expected)) throw Error('navigation:' + options.navigationError);
      const g = ++generation, e = epoch;
      return { url: options.redirect || url, generation: g, connectionEpoch: e, assertCurrent() {
        if (generation !== g || epoch !== e) throw Error('navigation:ownership_unconfirmed');
      }};
    },
    kernelEval: async (_id, expression) => {
      assert.equal(expression, load(dir + 'automationSafety.ts').AUTOMATION_RESTRICTION_EXPR);
      restrictionReads++;
      return options.restrictions ? options.restrictions[Math.min(restrictionReads - 1, options.restrictions.length - 1)] : '';
    },
    checkKernelLogin: async () => {
      if (options.fenceChange) load(dir + 'accountManager.ts').reserveAssociation('a', 'racing-qr');
      if (options.generationChange) generation++;
      if (options.connectionChange) epoch = 'conn-2';
      return Object.hasOwn(options, 'login') ? options.login : true;
    },
    kernelReadIdentity: async (_id, _platform, navigate) => {
      if (options.profileHop) await navigate('https://www.tiktok.com/@self');
      return { uid: options.noUid ? undefined : options.uid || 'self', nickname: 'Fixture',
        observed: options.noStamp ? undefined : { generation: generation + (options.wrongStamp ? 1 : 0), connectionEpoch: epoch } };
    },
  };
  const mocked = { './kernelPool': kernel, './taskStore': { pruneAccountFromTasks() {} },
    '../coworkLogger': { coworkLog() {} }, '../../sidecar-server': { broadcastSSE() {} } };
  const processView = Object.create(process, { env: { value: { ...process.env, NOOBCLAW_MATRIX_DIR: root } } });
  function load(file) {
    if (imports.has(file)) return imports.get(file);
    const module = { exports: {} };
    imports.set(file, module.exports);
    const localRequire = spec => {
      if (spec === 'fs') return fsView;
      if (Object.hasOwn(mocked, spec)) return mocked[spec];
      if (spec.startsWith('.')) return load(path.posix.normalize(path.posix.join(path.posix.dirname(file), spec + '.ts')));
      return require(spec);
    };
    new Function('require', 'module', 'exports', 'process', 'setTimeout', transpile(read(file)))(
      localRequire, module, module.exports, processView, (fn) => { queueMicrotask(fn); });
    return module.exports;
  }
  const manager = load(dir + 'accountManager.ts');
  manager.setAccountSSEBroadcast((...args) => events.push(args));
  const current = () => manager.getAccount('a');
  const saved = () => JSON.parse(fs.readFileSync(path.join(root, 'accounts.json'), 'utf8'));
  const pauses = () => JSON.parse(fs.readFileSync(path.join(root, 'automation-safety.json'), 'utf8')).pauses;
  const review = (mode = first ? 'first_binding' : 'forbidden') => {
    const liveManager = load(dir + 'accountManager.ts');
    return load(dir + 'manualAccountReview.ts').reviewMatrixAccount(liveManager.captureAssociation('a'), mode);
  };
  const keepAlive = load(dir + 'keepAlive.ts');
  return { manager, current, saved, pauses, review, calls, events, keepAlive, until, launches: () => launchCount,
    io, accountFile, safetyFile, safetyBytes: () => fs.readFileSync(safetyFile,'utf8'),
    safety: load(dir + 'automationSafety.ts').automationSafety,
    restart: () => { imports.clear(); return load(dir + 'accountManager.ts'); },
    directKeepAlive: async id => {
      const exposed = read(dir + 'keepAlive.ts').replace('async function keepAliveOne', 'export async function keepAliveOne');
      const module = { exports: {} };
      new Function('require', 'module', 'exports', transpile(exposed))(name => mocked[name] ??
        load(dir + name.slice(2) + '.ts'), module, module.exports);
      await module.exports.keepAliveOne(id);
    } };
}

test('F1: HTTP 200 homepage and self-profile, positive login, unique matching UID clear only the 403 and notify SSE', async t => {
  const h = fixture(t, { profileHop: true });
  assert.equal(h.manager.selectAvailability('a').available, false);
  assert.deepEqual(await h.review(), { ok: true, loggedIn: true, available: true, status: 'idle',
    statusReason: undefined, nickname: undefined, displayId: undefined, avatar: undefined });
  assert.deepEqual(h.calls.map(call => call[2]), ['https://www.tiktok.com/', 'https://www.tiktok.com/@self']);
  assert.deepEqual(h.current().authority.constraints, []);
  assert.equal(h.pauses()['account:a'], undefined);
  assert.equal(h.pauses()['account:tiktok:self'], undefined);
  assert.equal(h.pauses()['account:b'].code, 'forbidden');
  assert.ok(h.pauses()['group:unrelated']);
  assert.equal(h.saved().archivedSubjects['tiktok:self'], undefined);
  assert.equal(h.saved().archivedSubjects['tiktok:other'][0].kind, 'forbidden');
  assert.equal(h.events.at(-1)[1].status, 'idle');
  const reloaded = h.restart();
  assert.equal(reloaded.selectAvailability('a').available, true);
  assert.equal(reloaded.commitIdentity(reloaded.captureAssociation('a'), { boundUid: 'self' }), true);
  assert.equal(reloaded.selectAvailability('a').available, true);
});

test('F1: wrapped storage clears a simultaneous runtime pause as well as the imported pause', async t => {
  const h = fixture(t);
  h.manager.loadAccounts();
  const originals = h.safetyBytes();
  const beforeOtherObservation = JSON.parse(originals);
  delete beforeOtherObservation.pauses['account:tiktok:self'];
  fs.writeFileSync(h.safetyFile, JSON.stringify(beforeOtherObservation));
  h.safety.begin('a', 'tiktok:self', 'fixture-group', () => {});
  // An independent observation can land while this already-registered task
  // is winding down. A subsequent halt must preserve both durable forms.
  fs.writeFileSync(h.safetyFile, originals);
  h.safety.halt('a', 'forbidden', 7200000);
  h.safety.end('a');
  assert.throws(() => h.safety.begin('a', 'tiktok:self', 'fixture-group', () => {}));
  assert.equal((await h.review()).available, true);
  assert.equal(h.pauses()['account:tiktok:self'], undefined);
  assert.doesNotThrow(() => h.safety.begin('a', 'tiktok:self', 'fixture-group', () => {}));
  h.safety.end('a');
});

for (const [name, config, reason] of [
  ...['http_403','http_429','http_407','http_5xx','timeout','dns'].map(code => [code, { navigationError: code }, new RegExp(code)]),
  ...['forbidden','captcha','login_wall','account_flag','rate_limited','page_error:fixture'].map(value => [value, { restrictions: [value] }, /./]),
  ['login page 200', { redirect: 'https://www.tiktok.com/login' }, /./],
  ['signed out', { login: false }, /./], ['unknown login', { login: null }, /./],
  ['no UID', { noUid: true }, /./], ['duplicate UID', { duplicate: true }, /./],
  ['wrong existing UID', { uid: 'different' }, /./], ['no identity evidence', { noStamp: true }, /./],
  ['stale identity evidence', { wrongStamp: true }, /./],
  ['stale association', { fenceChange: true }, /cancelled/],
  ['stale document generation', { generationChange: true }, /ownership_unconfirmed/],
  ['stale connection epoch', { connectionChange: true }, /ownership_unconfirmed/],
  ['last restriction check finds a challenge', { restrictions: ['', 'captcha'] }, /./],
  ['profile hop denied', { profileHop: true, failURL: 'https://www.tiktok.com/@self', navigationError: 'http_403' }, /http_403/],
]) {
  test('F1: refuses ' + name + ' without changing the forbidden hold', async t => {
    const h = fixture(t, config);
    await assert.rejects(h.review(), reason);
    assert.ok(h.current().authority.constraints.find(c => c.kind === 'forbidden'));
    assert.equal(h.pauses()['account:a'].code, 'forbidden');
    assert.equal(h.saved().archivedSubjects['tiktok:self'][0].kind, 'forbidden');
  });
}

test('F1: ordinary status, alive mark, normal confirm and keepalive cannot release a 403 lock', async t => {
  const h = fixture(t);
  const a = h.current();
  h.manager.setAccountStatus('a', 'idle', '');
  h.manager.markAccountAlive('a');
  h.manager.confirmAvailability(h.manager.captureAssociation('a'), true);
  await h.keepAlive.runKeepAliveSweep();
  assert.equal(h.launches(), 0);
  assert.ok(a.authority.constraints.some(c => c.kind === 'forbidden'));
  assert.equal(a.status, 'limited');
});

for (const extra of ['billing_uncertain','banned','account_flag','proxy_auth','manual_disconnect','binding_conflict','rate_limited']) {
  test('F1: successful manual review leaves ' + extra + ' in force', async t => {
    const h = fixture(t, { extra: [extra], ...(extra === 'rate_limited' ? { ratePause: true, group: true } : {}) });
    assert.equal((await h.review()).available, false);
    assert.ok(h.current().authority.constraints.find(c => c.kind === extra));
    assert.ok(!h.current().authority.constraints.find(c => c.kind === 'forbidden'));
    if (extra === 'rate_limited') {
      assert.equal(h.pauses()['account:tiktok:self'].code, 'rate_limited');
      assert.equal(h.pauses()['group:local:unknown'].until, h.until);
    }
  });
}

test('F2: sweep and direct entrance both miss new accounts, but both still select previously logged-in accounts', async t => {
  const h = fixture(t, { first: true });
  const a = h.current(), b = h.manager.getAccount('b');
  a.status = 'login_required'; a.recovery = undefined; a.authority.constraints = [];
  b.status = 'login_required'; b.authority.verified = false;
  await h.keepAlive.runKeepAliveSweep();
  assert.equal(h.launches(), 2, 'only the existing binding attempts both browser modes');
  await h.directKeepAlive('a');
  assert.equal(h.launches(), 2, 'new account is independently guarded');
  b.status = 'login_required'; b.recovery = undefined; b.authority.constraints = [];
  await h.directKeepAlive('b');
  assert.equal(h.launches(), 4, 'prior binding can still be reprobed directly');
  delete b.boundUid;
  b.lastAliveAt = 1; b.status = 'login_required'; b.recovery = undefined; b.authority.constraints = [];
  await h.directKeepAlive('b');
  assert.equal(h.launches(), 6, 'last verified activity also qualifies');
  b.manualDisconnect = true;
  await h.directKeepAlive('b');
  assert.equal(h.launches(), 6, 'explicit disconnect is still excluded');
  a.status = 'limited'; a.recovery = { reason: 'login_unknown', nextCheckAt: 1 };
  await h.keepAlive.runKeepAliveSweep();
  assert.equal(h.launches(), 6, 'migrated pending first binding is not reprobed');
});

test('F2: QR admission and verified binding clear login_unknown before deadline; the same UI classifier rejects other holds', async t => {
  const h = fixture(t, { first: true });
  const a = h.current(), m = h.manager;
  const recovery = a.recovery;
  assert.ok(recovery.nextCheckAt > Date.now());
  assert.equal(m.isFirstBindingRecovery(a), true);
  assert.equal(m.isFirstBindingRecovery({ ...a, boundUid: 'already-bound' }), false);
  assert.equal(m.isFirstBindingRecovery({ ...a, recovery: { ...recovery, reason: 'rate_limited' } }), false);
  assert.equal(m.isFirstBindingRecovery({ ...a, authority: { ...a.authority, constraints: [{ kind: 'technical' }, { kind: 'forbidden' }] } }), false);
  const scan = m.bindAssociation(m.reserveAssociation('a','scan'), 'manual-instance');
  assert.equal(m.commitInteractiveFirstBinding(scan, {}), undefined);
});

test('F2: expired or missing evidence cannot recover, but valid QR binding clears the live backoff', t => {
  const h = fixture(t, { first: true });
  const a = h.current(), m = h.manager;
  const stale = m.captureAssociation('a');
  const scan = m.bindAssociation(m.reserveAssociation('a','scan'), 'manual-instance');
  assert.equal(m.commitInteractiveFirstBinding(stale, { boundUid: 'self' }), undefined);
  assert.equal(m.commitInteractiveFirstBinding(scan, {}), undefined);
  assert.equal(a.recovery.reason, 'login_unknown');
  assert.equal(m.commitInteractiveFirstBinding(scan, { boundUid: 'self' }).available, true);
  assert.equal(a.status, 'idle');
  assert.equal(a.boundUid, 'self');
  assert.equal(a.recovery, undefined);
});

test('F2: positive manual refresh is also sufficient without waiting for the timer', async t => {
  const h = fixture(t, { first: true, profileHop: true });
  assert.equal((await h.review()).available, true);
  assert.equal(h.current().status, 'idle');
  assert.equal(h.current().boundUid, 'self');
  assert.equal(h.current().recovery, undefined);
});

for (const extra of ['forbidden','banned','account_flag','billing_uncertain','rate_limited']) {
  test('F2: QR and first-binding refresh do not clear ' + extra, async t => {
    const h = fixture(t, { first: true, extra: [extra] });
    const m = h.manager;
    assert.equal(m.isFirstBindingRecovery(h.current()), false);
    const scan = m.bindAssociation(m.reserveAssociation('a', 'scan'), 'manual-instance');
    assert.equal(m.commitInteractiveFirstBinding(scan, { boundUid: 'self' }), undefined);
    m.finishAssociation(scan);
    await assert.rejects(h.review(), /cancelled/);
    assert.ok(h.current().authority.constraints.some(c => c.kind === extra));
    assert.equal(h.current().recovery.reason, 'login_unknown');
  });
}



function ipcCase(name, mocks, environment) {
  const sidecar = ts.createSourceFile('sidecar-server.ts', read('main/sidecar-server.ts'), ts.ScriptTarget.Latest, true);
  const visit = n => (ts.isCaseClause(n) && ts.isStringLiteral(n.expression) && n.expression.text === name)
    ? n : ts.forEachChild(n, visit);
  const entry = visit(sidecar);
  assert.ok(entry, name);
  const keys = Object.keys(environment), module = { exports: {} };
  new Function('require', 'module', 'exports', ...keys,
    transpile('export async function run() {\n' + entry.statements.map(s => s.getText(sidecar)).join('\n') + '\n}'))(
      spec => { assert.ok(Object.hasOwn(mocks, spec), spec); return mocks[spec]; },
      module, module.exports, ...keys.map(k => environment[k]));
  return module.exports.run();
}

test('F2: user QR IPC completes an unbound login_unknown window while the original deadline is still active', async t => {
  const h = fixture(t, { first: true });
  const a = h.current();
  let uidStage = 1, checkCount = 0;
  let finish;
  const done = new Promise(resolve => { finish = resolve; });
  const events = [];
  const session = { pageWs: {}, navigation: { url: 'https://www.tiktok.com/', snapshot: () =>
    ({ state: 'confirmed', generation: uidStage, connectionEpoch: 'current' }) } };
  const kernel = {
    isAccountBusy: () => false, getSession: () => session,
    acquireKernel: async () => ({ sessionInstanceId: 'fixture-instance' }), releaseKernel: () => {},
    kernelEnsureUrl: async () => {}, checkKernelLogin: async () => { checkCount++; return true; },
    persistKernelCookies: async () => {},
    kernelReadIdentity: async (_id, _platform, navigate) => {
      await navigate('https://www.tiktok.com/@self');
      return { uid: 'self', observed: { generation: uidStage, connectionEpoch: 'current' } };
    },
    navigateForAccountReview: async (_id, url) => { uidStage++; return {
      url, generation: uidStage, connectionEpoch: 'current', assertCurrent() {}
    }; },
    kernelEval: async () => '',
  };
  const response = await ipcCase('matrix:openLogin', {
    './libs/matrix/accountManager': h.manager, './libs/matrix/kernelPool': kernel,
    './libs/matrix/automationSafety': { AUTOMATION_RESTRICTION_EXPR: 'fixed' }, './libs/matrix/proxyBridge': {},
  }, { args: [{ accountId: a.id, scanId: 'fixture-scan', loginUrl: 'https://www.tiktok.com/login' }], res: {},
    matrixScanWatching: new Set(), matrixScanOwners: new Map(), writeJSON: (_res, _status, result) => result,
    broadcastSSE: (_event, payload) => { events.push(payload); if (payload.scanEnded) finish(); },
    setTimeout: fn => queueMicrotask(fn),
    coworkLog() { finish(); },
  });
  assert.equal(response.ok, true);
  await done;
  assert.equal(checkCount, 3);
  assert.ok(h.until > Date.now());
  assert.equal(a.status, 'idle');
  assert.equal(a.boundUid, 'self');
  assert.equal(a.recovery, undefined);
  assert.ok(events.some(event => event.scanId === 'fixture-scan' && event.available === true && event.status === 'idle'));
});

test('refresh IPC selects the explicit review flow instead of trusting a supplied login URL', async t => {
  for (const first of [false, true]) {
    const h = fixture(t, { first, profileHop: true });
    const events = [];
    const session = { diagnosticsId: 'fixture-release-session' };
    const outcome = await ipcCase('matrix:refreshIdentity', {
      './libs/matrix/accountManager': h.manager,
      './libs/matrix/kernelPool': { isAccountBusy: () => false, acquireKernel: async () => ({ sessionInstanceId: session.diagnosticsId }),
        releaseKernel: () => events.push('release'), getSession: () => session,
        kernelNavigate() { assert.fail('untrusted homeUrl was used'); } },
      './libs/matrix/manualAccountReview': { reviewMatrixAccount: async (fence, mode) => {
        assert.equal(fence.accountId, 'a');
        assert.equal(mode, first ? 'first_binding' : 'forbidden');
        return h.review(mode);
      }},
    }, { args: [{ accountId: 'a', homeUrl: 'https://www.tiktok.com/login' }], res: {},
      writeJSON: (_res, _status, data) => data, broadcastSSE: (_event, data) => events.push(data) });
    assert.equal(outcome.available, true);
    assert.equal(h.current().status, 'idle');
    assert.equal(h.calls[0][2], 'https://www.tiktok.com/');
    assert.ok(events.some(event => event?.available === true));
    assert.equal(events.at(-1), 'release');
  }
});


test('F1-01: QR mismatch cannot rebind a restricted window, including after disconnect or restart', async t => {
  const h = fixture(t, { uid: 'different' });
  const a = h.current(), m = h.manager;
  const old = a.boundUid;
  const scan = m.bindAssociation(m.reserveAssociation('a', 'fixture-qr'), 'fixture-browser');
  assert.equal(m.commitIdentity(scan, { boundUid: 'different' }), false);
  m.finishAssociation(scan);
  await assert.rejects(h.review(), /403/);
  assert.equal(h.saved().accounts[0].boundUid, old);
  assert.equal(h.saved().accounts[0].authority.forbiddenSubject, 'tiktok:' + old);
  assert.equal(h.pauses()['account:a'].code, 'forbidden');
  m.markManualDisconnect('a');
  assert.equal(h.saved().accounts[0].boundUid, undefined);
  const reload = h.restart();
  assert.equal(reload.getAccount('a').authority.forbiddenSubject, 'tiktok:' + old);
  const next = reload.bindAssociation(reload.reserveAssociation('a', 'fixture-second'), 'fixture-browser');
  assert.equal(reload.commitIdentity(next, { boundUid: 'different' }), false);
  assert.equal(reload.commitIdentity(next, { boundUid: old }), true);
  assert.ok(reload.selectAvailability('a').reasons.includes('forbidden'));
  assert.equal(reload.selectAvailability('a').available, false);
});

test('F1-01: a matching QR login preserves the old hold until explicit review passes', async t => {
  const h = fixture(t);
  const a = h.current(), m = h.manager;
  const scan = m.bindAssociation(m.reserveAssociation('a','fixture-same'), 'fixture-browser');
  assert.equal(m.commitIdentity(scan, { boundUid: a.boundUid }), true);
  m.finishAssociation(scan);
  assert.equal(m.selectAvailability('a').available, false);
  assert.equal((await h.review()).available, true);
  assert.equal(h.restart().selectAvailability('a').available, true);
});

for (const mode of ['account-first', 'safety', 'account-final', 'safety-competing-write', 'account-competing-write', 'rollback-fails']) {
  test('F1-02: ' + mode + ' remains protected after reopening both ledgers', async t => {
    const h = fixture(t);
    h.current();
    const before = h.safetyBytes();
    const fail = () => { throw Object.assign(new Error('synthetic EACCES'), { code: 'EACCES' }); };
    let accountWrites = 0, safetyWrites = 0;
    h.io.beforeRename = (which, target) => {
      if (which === 'account') {
        accountWrites++;
        if (mode === 'account-first' || ((mode === 'account-final' || mode === 'rollback-fails') && accountWrites === 2)) fail();
      } else if (which === 'safety') {
        safetyWrites++;
        if (mode === 'safety' || (mode === 'rollback-fails' && safetyWrites === 2)) fail();
        if (mode === 'account-competing-write' && safetyWrites === 1) {
          const prev = h.saved();
          prev.accounts[1].displayName = 'unrelated concurrent edit';
          fs.writeFileSync(h.accountFile, JSON.stringify(prev));
        }
      }
    };
    h.io.afterRename = which => {
      if (mode === 'safety-competing-write' && which === 'account' && accountWrites === 1) {
        const next = JSON.parse(h.safetyBytes());
        next.pauses['group:other-writer'] = { until: h.until, reason: 'concurrent group' };
        fs.writeFileSync(h.safetyFile, JSON.stringify(next));
      }
    };
    await assert.rejects(h.review(), /storage_or_migration_hold/);
    assert.equal(h.manager.selectAvailability('a'), undefined);
    h.io.beforeRename = undefined;
    h.io.afterRename = undefined;
    const durable = h.saved();
    assert.ok(durable.accounts[0].authority.constraints.some(c => c.kind === 'forbidden'));
    assert.ok(durable.archivedSubjects['tiktok:self'].some(c => c.kind === 'forbidden'));
    if (mode !== 'account-first') {
      assert.ok(durable.accounts[0].authority.constraints.some(c => c.source === 'manual_403_review_pending'));
    }
    if (mode === 'safety-competing-write') {
      assert.equal(h.pauses()['account:a'].code, 'forbidden');
      assert.equal(h.pauses()['group:other-writer'].reason, 'concurrent group');
    } else if (mode === 'rollback-fails') {
      assert.equal(h.pauses()['account:a'], undefined);
    } else {
      assert.equal(h.safetyBytes(), before, 'successful rollback preserves exact original ledger bytes');
    }
    const restarted = h.restart();
    assert.equal(restarted.selectAvailability('a').available, false);
    assert.ok(restarted.selectAvailability('a').reasons.includes('forbidden'));
    assert.equal(h.pauses()['account:b'].code, 'forbidden');
    if (mode === 'account-competing-write') assert.equal(restarted.getAccount('b').displayName, 'unrelated concurrent edit');
    if (mode === 'rollback-fails') {
      assert.equal((await h.review()).available, true, 'a fresh manual proof can finish after restart');
      assert.equal(h.restart().selectAvailability('a').available, true);
    }
  });
}

test('F2-01: expiry of an unrelated technical delay never makes a brand-new window eligible', async t => {
  const h = fixture(t, { first: true });
  const a = h.current();
  a.recovery = { attempts: 1, nextCheckAt: Date.now()-1000, reason: 'network_error' };
  a.authority.constraints[0].until = Date.now()-1000;
  h.manager.getAccount('b').manualDisconnect = true;
  assert.equal(h.manager.selectAvailability('a').probeEligible, true, 'deadline alone would permit probing');
  await h.keepAlive.runKeepAliveSweep();
  await h.directKeepAlive('a');
  assert.equal(h.launches(), 0);
});

test('F2-02: legacy explicit technical wait with no recovery object can reconnect before its deadline', async t => {
  const h = fixture(t, { first: true, profileHop: true });
  const a = h.current();
  delete a.recovery;
  a.statusReason = '等待自动复查：login_unknown';
  assert.equal(h.manager.isFirstBindingRecovery(a), true);
  assert.equal(h.manager.isFirstBindingRecovery({ ...a, statusReason: a.statusReason + ':network_error' }), false);
  assert.equal(h.manager.isFirstBindingRecovery({ ...a, authority: { ...a.authority, verified: true } }), false);
  for (const kind of ['rate_limited','forbidden','banned','account_flag','billing_uncertain','proxy_auth','manual_disconnect','binding_conflict']) {
    assert.equal(h.manager.isFirstBindingRecovery({ ...a, authority: { ...a.authority, constraints: [...a.authority.constraints, { kind }] } }), false, kind);
  }
  assert.ok(h.until > Date.now());
  assert.equal((await h.review()).available, true);
  assert.equal(h.restart().selectAvailability('a').available, true);
});

test('F1 403 card retains open-window menu and review, and an existing denied page opens without touching the hold', async t => {
  const view=read('renderer/components/matrix/MatrixView.tsx');
  const menu=view.slice(view.indexOf('{winMenuId === a.id && ('),view.indexOf('{/* 窗口里:账号信息 */}'));
  assert.match(menu, /needs403Review[\s\S]*?openWindow\(a\)[\s\S]*?Open window/);
  for (const method of ['refreshIdentity', 'acknowledgeBilling', 'deleteAccount', 'disconnectAccount']) assert.ok(menu.includes(method + '(a)'));
  assert.match(view, /needs403Review[\s\S]*?refreshIdentity\(a\)[\s\S]*?Review access/);
  const h=fixture(t);
  h.current();
  const durable = h.saved(), pauses=h.safetyBytes();
  const actions=[];
  const session={manualWindowError:'navigation:http_403'};
  const outcome=await ipcCase('matrix:openWindow', {
    './libs/matrix/accountManager': h.manager,
    './libs/matrix/kernelPool': {
      isAccountBusy: () => false, isKernelQuitting: () => false, getSession: () => session,
      kernelBringToFront: async () => actions.push('show'), markUserOwned: () => actions.push('retain'),
    },
  }, { args: [{ accountId: 'a' }], res: {}, matrixOpenWindowPending: new Set(),
    writeJSON: (_res,_status,data) => data });
  assert.deepEqual(outcome,{ok:true,already:true,page:'preserved'});
  assert.deepEqual(actions,['show','retain']);
  assert.deepEqual(h.saved(),durable);
  assert.equal(h.safetyBytes(),pauses);
});


test('F1-02B a persisted live rate pause alone is visible before and after a successful 403 review', async t => {
  const h=fixture(t);
  h.current();
  const ledger=JSON.parse(h.safetyBytes());
  const rate={ code:'rate_limited', reason:'separate live rate pause', until:h.until };
  ledger.pauses['account:tiktok:self']=rate;
  fs.writeFileSync(h.safetyFile,JSON.stringify(ledger));
  assert.equal(h.manager.selectAvailability('a').available,false);
  const result=await h.review();
  assert.equal(result.ok,true);
  assert.equal(result.available,false);
  assert.equal(result.status,'limited');
  assert.deepEqual(h.pauses()['account:tiktok:self'],rate);
  assert.equal(h.pauses()['account:a'],undefined);
  assert.equal(h.restart().selectAvailability('a').available,false);
});
