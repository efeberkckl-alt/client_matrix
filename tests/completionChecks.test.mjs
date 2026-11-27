import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import test from 'node:test';
import { build } from 'esbuild';

const require = createRequire(import.meta.url);
const root = process.env.COMPLETION_FIXTURE_ROOT || fileURLToPath(new URL('..', import.meta.url));
const src = path.join(root, 'src/main/libs/matrix');
const read = file => fs.readFileSync(file, 'utf8');
const buildStore = async () => (await build({
  stdin: { contents: "export * from './accountManager'; export * from './customCommentBatch'; export * from './kernelNavigation';", resolveDir: src },
  bundle: true, platform: 'node', format: 'cjs', nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))], write: false,
  plugins: [{ name: 'mock-local-logger', setup(b) {
    b.onResolve({ filter: /coworkLogger|taskStore/ }, ({ path }) => ({ path, namespace: 'mock' }));
    b.onLoad({ filter: /.*/, namespace: 'mock' }, () => ({ contents: 'export const coworkLog=()=>{}; export const pruneAccountFromTasks=()=>{};' }));
  } }],
})).outputFiles[0].text;
const compiled = await buildStore();
const boot = (dir, fault) => {
  const module = { exports: {} };
  runInNewContext(compiled, {
    module, exports: module.exports, URL, setTimeout, clearTimeout, Buffer, AbortSignal, AbortController,
    process: { env: { NOOBCLAW_MATRIX_DIR: dir }, pid: process.pid, platform: process.platform, kill: process.kill },
    require: name => name === 'fs' && fault ? { ...fs, renameSync(from, to) {
      if (fault(to)) throw Error('fixture storage fault');
      fs.renameSync(from, to);
    } } : require(name),
  });
  return module.exports;
};
const fixture = t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-completion-lab-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const accountsFile = path.join(dir, 'accounts.json');
  fs.writeFileSync(accountsFile, JSON.stringify(['a','b'].map(id => ({ id, boundUid: id, status: 'idle',
    userDataDir: 'synthetic-profile-' + id, platform: 'tiktok' }))));
  return { dir, accountsFile, saved: () => JSON.parse(read(accountsFile)) };
};
const extract = (file, functions, context) => {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.ES2022, true);
  const declarations = ast.statements.filter(node => ts.isFunctionDeclaration(node) && functions.includes(node.name?.text));
  assert.equal(declarations.length, functions.length);
  const js = ts.transpileModule(declarations.map(node => node.getText(ast).replace(/^export /, '')).join('\n') +
    '\n({ ' + functions.join(', ') + ' })', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  return runInNewContext(js, context);
};

test('aggregate billing sends one loopback request, carries all original subjects, and archives definitive or uncertain results', async t => {
  for (const mode of ['confirmed','rejected','charge_uncertain']) {
    const f = fixture(t), store = boot(f.dir);
    assert.equal(typeof store.captureDispatchSubject, 'function');
    const subjects = ['a','b'].map(id => store.captureDispatchSubject(id, { instance: 'old-' + id, connection: 'fixture-wire', generation: 1 }));
    let finish, start;
    const requestStarted = new Promise(resolve => { start = resolve; });
    const requests = [];
    const server = http.createServer(async (req, res) => {
      let body = '';
      for await (const part of req) body += part;
      requests.push(JSON.parse(body));
      finish = () => {
        if (mode === 'charge_uncertain') req.socket.destroy();
        else {
          res.statusCode = mode === 'rejected' ? 402 : 200;
          res.setHeader('Content-Type', 'application/json');
          res.end(mode === 'confirmed' ? '{"ok":true,"charged":7,"balance_after":31}' : '{"ok":false,"reason":"insufficient_balance"}');
        }
      };
      start();
    });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeAllConnections(); server.close(); });
    const { chargeSuccess } = extract(path.join(src, 'taskRunner.ts'), ['chargeSuccess'], {
      ...store, fetch, AbortSignal, baseUrl: () => 'http://127.0.0.1:' + server.address().port, coworkLog() {},
    });
    const pending = chargeSuccess('tiktok', subjects, 'synthetic-only');
    await requestStarted;
    const [written] = Object.values(f.saved().dispatchRecords);
    assert.equal(written.chargeCount, 2);
    assert.deepEqual(written.subjects.map(s => s.subject), ['tiktok:a', 'tiktok:b']);
    assert.equal(written.result, undefined);
    let token = store.reserveAssociation('a', 'second');
    token = store.bindAssociation(token, 'new-browser');
    assert.equal(store.commitIdentity(token, { boundUid: 'second-uid' }), true);
    assert.equal(store.confirmAvailability(token, true).available, true);
    finish();
    assert.equal((await pending)?.charged, mode === 'confirmed' ? 7 : undefined);
    assert.deepEqual(requests, [{ platform: 'tiktok', count: 2 }]);
    const result = f.saved().dispatchRecords[written.id];
    assert.equal(result.result, mode);
    assert.equal(store.selectAvailability('a').available, true, mode);
    if (mode === 'charge_uncertain') {
      assert.equal(store.selectAvailability('b').available, false);
      assert.equal(store.acknowledgeBillingTransaction('unrelated-id', 'a'), false);
      assert.equal(store.acknowledgeBillingTransaction(written.id, 'a'), true);
      assert.equal(store.acknowledgeBillingTransaction(written.id, 'a'), true);
      assert.equal(f.saved().dispatchRecords[written.id].result, 'acknowledged');
      assert.equal(f.saved().archivedSubjects['tiktok:a'].length, 0);
    }
  }
});

const makePost = (id, text) => ({ url: 'https://www.tiktok.com/@fixture/video/' + id, text });
const keyOf = post => JSON.stringify([post.url.split('/').at(-1), post.text]);

test('comment reconciliation recovers each durable cut without promoting missing or mismatched evidence', t => {
  for (const cut of ['intent-only','pending','confirmed-before-archive']) {
    const f = fixture(t); let fail = false, store = boot(f.dir, file => fail && file === f.accountsFile);
    assert.equal(typeof store.reconcileStoredCommentTransactions, 'function');
    const post = makePost('7462100000000000061','fixture comment');
    const key = keyOf(post);
    const batch = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
    const receipt = store.registerDispatch('a', 'comment', { action: 'comment', platform: 'tiktok', ledgerKey: key,
      ledgerId: batch.ledgerId, at: Date.now() });
    const before = { author: 'fixture-user', count: 0, ids: [] };
    if (cut !== 'intent-only') batch.prepare(key, 'a', before, receipt.id);
    if (cut === 'confirmed-before-archive') {
      assert.equal(batch.confirm(key, 'a', { ...before, count: 1, ids: ['fixture-row'] }, 'same_page'), receipt.id);
      fail = true;
      assert.throws(() => store.archiveDispatchedResult(receipt, 'confirmed'), /storage_or_migration_hold/);
    }
    store = boot(f.dir);
    assert.equal(store.reconcileStoredCommentTransactions(f.dir), 0);
    const reopened = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
    assert.equal(reopened.readLedger()[key], cut === 'confirmed-before-archive' ? 'confirmed' : 'pending');
    assert.equal(store.getDispatchedReceipt(receipt.id).result, cut === 'confirmed-before-archive' ? 'confirmed' : 'comment_pending');
    assert.throws(() => reopened.prepare(key, 'a', before), /重复发送/);
    assert.equal(store.reconcileStoredCommentTransactions(f.dir), 0);
    assert.equal(store.selectAvailability('b').available, true);
  }
});

test('original account comment evidence is not transferable to a different bound UID', t => {
  const f = fixture(t), store = boot(f.dir);
  const post = makePost('7462100000000000062', 'fixture other comment');
  const key = keyOf(post);
  const batch = new store.CustomCommentBatch(f.dir, [post], { reconcile: true });
  const receipt = store.registerDispatch('a','comment',{ action:'comment',platform:'tiktok', ledgerKey:key, ledgerId:batch.ledgerId,at:Date.now() });
  batch.prepare(key,'a',{ author:'fixture-a',count:0,ids:[] },receipt.id);
  let epoch = store.reserveAssociation('a');
  epoch = store.bindAssociation(epoch,'new-browser');
  assert.equal(store.commitIdentity(epoch,{ boundUid:'different' }),true);
  assert.throws(() => batch.confirm(key,'a',{ author:'fixture-a',count:1,ids:['fixture-row'] },'reopened'),/comment_dispatch_subject_changed/);
  assert.equal(batch.pendingFor('a').length, 0);
  assert.equal(batch.readLedger()[key], 'pending');
});

test('status versions reject retired stores, stale epochs, lower revisions, and duplicate scan terminal events', async () => {
  const source = path.join(root, 'src/renderer/components/matrix/matrixAccountVersions.ts');
  assert.ok(fs.existsSync(source), 'version reducer must be installed');
  const js = ts.transpileModule(read(source), { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
  const module = { exports: {} };
  runInNewContext(js, { module, exports: module.exports });
  const versions = new module.exports.MatrixAccountVersions();
  const stamp = { storeId:'first', storeRevision:'10' };
  const a = { ...stamp, id:'a', incarnation:'inc-a', epoch:'3', stateRevision:'10' };
  assert.equal(versions.installSnapshot(stamp,[a],true),'accepted');
  assert.equal(versions.inspect({...a,storeRevision:'11',stateRevision:'11',scanId:'first-attempt',loginVerified:true}),'apply');
  assert.equal(versions.inspect({...a,storeRevision:'11',stateRevision:'11',scanId:'first-attempt',scanEnded:true}),'ignore');
  assert.equal(versions.inspect({...a,storeRevision:'12',epoch:'2',stateRevision:'12',scanId:'older',loginVerified:true}),'ignore');
  const replacement = { storeId:'second', storeRevision:'1' };
  assert.equal(versions.installSnapshot(replacement,[{ ...a, ...replacement, stateRevision:'1', incarnation:'inc-B' }],true),'replaced');
  assert.equal(versions.inspect({...a,storeRevision:'13',stateRevision:'13'}),'ignore');
  assert.equal(versions.installSnapshot({...stamp,storeRevision:'13'},[a],true),'ignored');
});

test('actual send accepts bounded control, denies opaque scripts and browser writes on unconfirmed roots, then resumes confirmed legacy commands', async () => {
  const f = { WebSocket:{OPEN:1}, runCount:0 };
  const sent = [];
  const s = { accountId:'a',msgId:1,pending:new Map(), pageWs:{ readyState:1,send(wire) {
    const cmd = JSON.parse(wire); sent.push(cmd);
    queueMicrotask(() => s.pending.get(cmd.id)?.resolve({ ok:true }));
  } } };
  let granted = false;
  let held;
  const receipt = { accountId: 'a', sessionInstanceId: 'fixture-a' };
  s.diagnosticsId = receipt.sessionInstanceId;
  s.navigation = { snapshot: () => ({ state:granted?'confirmed':'unknown',generation:4,connectionEpoch:'wire' }),
    assertBusinessReady() { if (!granted) throw Error('ownership_unconfirmed'); } };
  const { send } = extract(path.join(src,'kernelPool.ts'), ['send'], {
    WebSocket:f.WebSocket, setTimeout, clearTimeout, getAccount:()=>({ authority:{} }),
    kernelSignal:()=>undefined, accountAuthority:{ selectAvailability:()=>({available:true}) },
    automationOperationContext:{ getStore:()=>undefined }, kernelLeaseScope:{ getStore:()=>held }, isKernelLeaseCurrent: value => value === receipt, KernelNavigationError: Error,
    AUTOMATION_RESTRICTION_EXPR:'void 0', ROOT_PROOF_EXPRESSION:'document.readyState',
    localControlPermits:new WeakMap(), loginReadCapabilities:new WeakMap(), activeCookieWrites:new WeakMap(),
  });
  for(const [method, params] of [['Runtime.evaluate',{expression:'document.body.textContent="F"'}],
    ['Input.dispatchMouseEvent',{type:'mouseWheel'}],['Input.insertText',{text:'fixture'}],
    ['DOM.setFileInputFiles',{}],['Page.addScriptToEvaluateOnNewDocument',{source:'void 0'}]]) {
    assert.throws(() => send(s, method, params), /ownership_unconfirmed|protocol/);
  }
  assert.throws(() => send(s,'Runtime.evaluate',{expression:'document.body.click()'},100,undefined,undefined,undefined,{}),/protocol/);
  assert.equal(sent.length, 0);
  await send(s,'Page.getFrameTree');
  await send(s,'Page.navigate',{url:'https://fixture.invalid/'});
  await send(s,'Runtime.evaluate',{expression:'document.readyState'});
  const scope = { attempts:new Set(),networkIds:new Map() };
  s.proxyChallenge = scope;
  await send(s,'Fetch.disable',{},500,scope);
  assert.equal(sent.length,4);
  granted = true;
  assert.throws(() => send(s, 'Runtime.evaluate', {expression:'void 0 + 1'}), /ownership_unconfirmed/);
  held = receipt;
  await send(s,'Runtime.evaluate',{expression:'void (1+1)'});
  await send(s,'Input.dispatchMouseEvent',{type:'mouseWheel'});
  assert.equal(sent.length,6);
  assert.equal(s.pending.size,0);
});
