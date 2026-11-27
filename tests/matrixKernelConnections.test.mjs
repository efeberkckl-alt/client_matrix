import { randomUUID } from 'node:crypto';
import assert from 'node:assert/strict';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';
import fs from 'node:fs';
import path from 'node:path';
import { EventEmitter, getEventListeners } from 'node:events';
import { AsyncLocalStorage } from 'node:async_hooks';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/kernelPool.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('kernelPool.ts', source, ts.ScriptTarget.Latest, true);
const names = ['kernelSignal', 'waitForKernel', 'bindKernelSignal', 'devFetchJson', 'devtoolsNewTab', 'getPage', 'doGetPage', 'openPageSocket', 'failSession', 'send', 'withAutomationOperation', 'kernelExec', 'kernelEval', 'injectExecutor', 'acquireLease', 'releaseLease', 'launchKernel', 'doLaunch', 'closeKernel'];
const code = ts.transpileModule(ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map((n) => n.getText(ast).replace(/^export /, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const flush = async () => { for (let i = 0; i < 30; i++) await Promise.resolve(); };

function harness() {
  const sessions = new Map(), sockets = [], timers = new Map(), requests = [];
  const controllers = new Map([['a', new AbortController()], ['b', new AbortController()]]);
  let seq = 0;
  const state = { fetch: async () => ({ ok: true, json: async () => [{ type: 'page', id: 'target' }] }), reply: true, pace: () => {} };
  class Socket extends EventEmitter {
    static OPEN = 1;
    constructor(url, options) { super(); this.url = url; this.options = options; this.readyState = 0; sockets.push(this); }
    open() { this.readyState = 1; this.emit('open'); }
    close() { this.readyState = 3; this.emit('close'); }
    terminate() { this.terminated = true; this.close(); }
    send(raw) {
      const request = JSON.parse(raw); requests.push(request);
      if (state.reply) queueMicrotask(() => {
        const session = [...sessions.values()].find((s) => s.pageWs === this);
        session?.pending.get(request.id)?.resolve({ result: { value: true } });
      });
    }
  }
  const context = vm.createContext({
    diagnosticAccountAlias,
    sessions, launching: new Map(), refCount: new Map(), closingProcs: new Map(), leaseTail: new Map(), leaseHeld: new Map(), emptyTicks: new Map(),
    WebSocket: Socket, AbortController, AbortSignal, URL, SyntaxError, Error, Promise, path,
    setTimeout: (fn, ms) => { timers.set(++seq, { fn, ms }); return seq; }, clearTimeout: (id) => timers.delete(id),
    randomUUID, fetch: (...args) => state.fetch(...args), onMessage: () => {}, getAccount: () => undefined, getLocalEgressIp: () => null,
    getExecutorSource: async () => null, enableAutomationNetwork: async () => {}, coworkLog: () => {},
    verifyKernelEgress: async () => {},
    automationSafety: { signal: (id) => controllers.get(id)?.signal, isActive: () => true, assertAllowed: () => {}, begin: () => {}, before: async () => {}, end: (id) => controllers.get(id)?.abort() },
    automationOperationContext: new AsyncLocalStorage(), automationOperationTail: Promise.resolve(),
    AutomationSafetyError: class extends Error {}, operationForCommand: () => 'interaction', operationForScript: () => null,
    paceOperation: async () => { state.pace(); return () => {}; },
    sleep: async () => {}, sendNoWait: () => {}, setAccountStatus: () => {}, safetyLog: () => {},
    proxyServerAddress: () => '', installedKernelPath: () => 'mock-chrome', ensureProxyBridge: async () => null,
    buildKernelArgs: () => [], reapProfileHolder: async () => {}, clearSingletonLocks: () => {}, ensureWindowGuards: () => {}, nextSlot: 0,
    fs: { existsSync: () => true, mkdirSync() {}, rmSync() {}, openSync: () => 1, closeSync() {}, readFileSync: () => '1234' },
    spawn: () => { const proc = new EventEmitter(); proc.exitCode = null; proc.kill = () => { proc.killed = true; proc.exitCode = 1; proc.emit('exit'); }; state.process = proc; return proc; },
    console,
  });
  vm.runInContext(code, context);
  const session = (id = 'a', automation = false) => {
    const s = { accountId: id, automation, debugPort: 1234, pageWs: null, pageInit: null, pageTargetId: null, pending: new Map(), msgId: 1, slot: 0, process: null };
    sessions.set(id, s); return s;
  };
  const tick = async (ms) => { for (const [id, timer] of [...timers]) if (timer.ms === ms) { timers.delete(id); timer.fn(); } await flush(); };
  return { context, session, sessions, sockets, timers, requests, controllers, state, tick };
}

test('DevTools HTTP header/body stalls time out, clear pageInit, and permit a later connection', async () => {
  for (const body of [false, true]) {
    const h = harness(), s = h.session(); let requestSignal;
    h.state.fetch = async (_url, options) => { requestSignal = options.signal; return body ? { ok: true, json: () => new Promise(() => {}) } : new Promise(() => {}); };
    const pending = h.context.getPage('a'); const failed = assert.rejects(pending, /HTTP timeout/);
    await flush(); await h.tick(1500); await failed;
    assert.equal(requestSignal.aborted, true);
    assert.equal(s.pageInit, null); assert.equal(h.timers.size, 0);
    h.state.fetch = async () => ({ ok: true, json: async () => [{ type: 'page', id: 'target' }] });
    const recovered = h.context.getPage('a'); await flush(); h.sockets[0].open(); await recovered;
    assert.equal(s.pageInit, null); assert.equal(h.timers.size, 0);
  }
});

test('silent handshake, close before open, cancellation and explicit close settle and release connecting sockets', async () => {
  for (const cause of ['timeout', 'close', 'abort', 'explicit-close']) {
    const h = harness(), s = h.session(), controller = new AbortController();
    h.context.bindKernelSignal(s, controller.signal);
    const pending = h.context.getPage('a'); const rejected = assert.rejects(pending);
    await flush(); const socket = h.sockets[0];
    assert.equal(socket.options.handshakeTimeout, 5000);
    if (cause === 'timeout') await h.tick(5000);
    if (cause === 'close') socket.close();
    if (cause === 'abort') controller.abort();
    if (cause === 'explicit-close') h.context.closeKernel('a');
    await rejected;
    assert.equal(socket.terminated, true); assert.equal(s.pageInit, null); assert.equal(s.connectingWs, undefined);
    assert.equal(h.timers.size, 1 * (cause === 'explicit-close')); // existing process-close timer
    h.context.closeKernel('a'); await h.tick(0);
    assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
    assert.equal(h.timers.size, 0);
  }
});

test('cancelled reconnect releases the actual kernelExec global slot so another account proceeds', async () => {
  const h = harness(), a = h.session('a', true), b = h.session('b', true);
  a.pageWs = { readyState: 1 }; h.context.bindKernelSignal(a, h.controllers.get('a').signal);
  h.state.pace = () => { a.pageWs = null; };
  const first = h.context.kernelExec('a', 'click', {}); const rejected = assert.rejects(first);
  await flush(); assert.equal(h.sockets.length, 1);
  let ran = false;
  const next = h.context.withAutomationOperation(b, 'interaction', async () => { ran = true; });
  await flush(); assert.equal(ran, false);
  h.controllers.get('a').abort(); await rejected; await next;
  assert.equal(ran, true); assert.equal(h.sockets[0].terminated, true);
  assert.equal(h.requests.length, 0, 'no click was sent or replayed'); assert.equal(h.timers.size, 0);
});

test('stopping an already sent command clears pending/timer and never replays it', async () => {
  const h = harness(), s = h.session('a', true);
  h.context.bindKernelSignal(s, h.controllers.get('a').signal);
  const opening = h.context.openPageSocket(s, 'target'); h.sockets[0].open(); await opening;
  h.state.reply = false;
  const sent = h.context.send(s, 'Input.dispatchKeyEvent', { key: 'Enter' }); const rejected = assert.rejects(sent);
  assert.equal(h.requests.length, 1); h.controllers.get('a').abort(); await rejected;
  assert.equal(h.requests.length, 1); assert.equal(s.pending.size, 0); assert.equal(h.timers.size, 0);
});

test('aborted lease waiter does not release another owner and leaves no stale queue', async () => {
  const h = harness(), controller = new AbortController();
  await h.context.acquireLease('a');
  const second = h.context.acquireLease('a', controller.signal); const rejected = assert.rejects(second);
  controller.abort(); await rejected;
  let acquired = false;
  const third = h.context.acquireLease('a').then(() => { acquired = true; });
  await flush(); assert.equal(acquired, false);
  h.context.releaseLease('a'); await third; assert.equal(acquired, true);
  h.context.releaseLease('a'); await flush(); assert.equal(h.context.leaseTail.size, 0);
  assert.equal(getEventListeners(controller.signal, 'abort').length, 0);
});

test('cancelled launch aborts pending HTTP, kills only its spawned process and releases lease/inflight state', async () => {
  const h = harness(), controller = new AbortController(); let requestSignal;
  h.state.fetch = async (_url, options) => { requestSignal = options.signal; return { ok: true, json: () => new Promise(() => {}) }; };
  const launch = h.context.launchKernel({ accountId: 'a', userDataDir: 'mock-profile', fingerprint: {}, signal: controller.signal });
  const rejected = assert.rejects(launch); await flush(); assert.ok(requestSignal);
  controller.abort(); await rejected; await flush();
  assert.equal(requestSignal.aborted, true); assert.equal(h.state.process.killed, true);
  assert.equal(h.context.launching.size, 0); assert.equal(h.context.leaseHeld.size, 0); assert.equal(h.context.leaseTail.size, 0);
  assert.equal(h.context.refCount.get('a') || 0, 0); assert.equal(h.timers.size, 0);
});

test('emergency stop waits for old launch cleanup before handing its lease to B; C cannot steal it', async () => {
  const h = harness(), controller = new AbortController();
  h.state.fetch = async () => ({ ok: true, json: () => new Promise(() => {}) });
  const launch = h.context.launchKernel({ accountId: 'a', userDataDir: 'mock-profile', fingerprint: {}, signal: controller.signal });
  const rejected = assert.rejects(launch); await flush();
  let bAcquired = false;
  const b = h.context.acquireLease('a').then((owner) => { bAcquired = true; return owner; });
  controller.abort(); h.context.closeKernel('a', { force: true, skipLease: true });
  assert.equal(bAcquired, false, 'stop must not hand off while A still unwinds');
  await rejected; const ownerB = await b;
  let cAcquired = false;
  const c = h.context.acquireLease('a').then(() => { cAcquired = true; });
  await flush(); assert.equal(cAcquired, false);
  h.context.releaseLease('a', () => {}); await flush(); assert.equal(cAcquired, false, 'stale owner token cannot release B');
  h.context.releaseLease('a', ownerB); await c; assert.equal(cAcquired, true);
  h.context.releaseLease('a'); await h.tick(0); assert.equal(h.context.leaseTail.size, 0);
});

test('pre-operation DOM failure cannot authorize sending a mutation', async () => {
  const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'paceOperation').getText(ast);
  for (const value of [undefined, null, false]) {
    const runtime = vm.createContext({
      automationSafety: { before: async () => () => {}, assertAllowed() {} },
      AUTOMATION_RESTRICTION_EXPR: 'probe', send: async () => ({ result: { value } }),
    });
    vm.runInContext(ts.transpileModule(fn, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, runtime);
    await assert.rejects(runtime.paceOperation({ accountId: 'a', automation: true }, 'interaction'), /network_error:页面检测失败/);
  }
});
