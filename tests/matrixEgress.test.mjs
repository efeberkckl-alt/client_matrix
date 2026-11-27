import assert from 'node:assert/strict';
import { virtualSafetyFs } from './helpers/virtualSafetyFs.mjs';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';
import fs from 'node:fs';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';
import ts from 'typescript';

const read = (name) => fs.readFileSync(new URL(`../src/main/libs/matrix/${name}.ts`, import.meta.url), 'utf8');
const compile = (source) => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS, esModuleInterop: true } }).outputText;
const functions = (file, names) => {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map((n) => n.getText(ast).replace(/^export /, '')).join('\n');
};
const accountCode = functions('accountManager', ['sameProxyRoute', 'normalizeEgressIp', 'clearProxyExitObservation', 'validExitObservationTime', 'applyProxyExitObservation', 'recordAccountEgress', 'setAccountProxy']);
const kernelCode = functions('kernelPool', ['readKernelEgress', 'readKernelEgressOnce', 'verifyKernelEgress']);

function harness() {
  let now = 1_000_000, persisted = '';
  class Clock extends Date { static now() { return now; } }
  const accounts = new Map(), sessions = new Map(), logs = [], calls = [], controls = [], files = new Map();
  const fakeFs = virtualSafetyFs(files);
  const module = { exports: {} };
  vm.runInNewContext(compile(read('automationSafety')), {
    module, exports: module.exports, require: (id) => ({ fs: fakeFs, path, crypto, os: { homedir: () => '/virtual' } })[id],
    process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: '/virtual' } }, AbortController, setTimeout, clearTimeout, URL,
  });
  const { AutomationSafety, AutomationSafetyError } = module.exports;
  const safety = new AutomationSafety('/virtual/safety.json', () => now, async (ms) => { now += ms; }, () => 0);
  const response = { ip: '203.0.113.1', afterRead: null };
  const context = vm.createContext({
    diagnosticAccountAlias,
    coworkLog() {}, net, URL, Date: Clock, sessions, automationSafety: safety, AutomationSafetyError, AbortController, AbortSignal, WebSocket: { OPEN: 1 },
    getAccount: (id) => accounts.get(id), persist: () => { persisted = JSON.stringify([...accounts.values()]); }, setLocalEgressIp: () => {},
    setAccountStatus: (id, status, reason) => Object.assign(accounts.get(id), { status, statusReason: reason }),
    markAccountRecovery: (id, reason) => Object.assign(accounts.get(id), { recovery: { reason } }),
    kernelSignal: () => undefined, getPage: async (id) => sessions.get(id),
    devFetchJson: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/browser-id' }),
    createEgressTarget: async () => { controls.push({ method: 'Target.createTarget', params: { url: 'about:blank', background: true } }); response.afterCreate?.(); return 'egress-probe'; },
    openPageSocket: async (probe, targetId) => { if (targetId) response.probeSession = probe; if (targetId && response.openFailure) throw new Error('mock handshake failed'); probe.pageWs = { readyState: 1 }; },
    failSession: (probe) => { probe.pageWs = null; },
    sendNoWait: (_s, method, params) => controls.push({ method, params }),
    send: async (_s, method, params, timeout) => {
      if (method === 'Target.createTarget') { controls.push({ method, params }); response.afterCreate?.(); return { targetId: 'egress-probe' }; }
      if (method === 'Fetch.enable') { controls.push({ method, params }); return {}; }
      calls.push({ method, params, timeout }); response.afterRead?.();
      if (response.readFailure) throw new Error('mock evaluation failed');
      if (response.readPromise) return response.readPromise;
      return { result: { value: response.ip } };
    },
  });
  context.sendLocalControl = context.send;
  vm.runInContext(compile(accountCode + '\n' + kernelCode), context);
  const add = (id, host) => {
    const proxy = host ? { protocol: 'http', host, port: 8080, username: id, password: 'test' } : undefined;
    const account = { id, platform: 'tiktok', status: 'running', proxy };
    accounts.set(id, account);
    const s = { accountId: id, automation: true, pageWs: { readyState: 1 }, boundProxy: proxy ? { ...proxy } : undefined };
    sessions.set(id, s); safety.begin(id, id, host ? `proxy:${host}` : 'local:unknown', (text) => logs.push(text));
    return s;
  };
  return { api: context, add, accounts, sessions, calls, controls, logs, safety, response, now: () => now, advance: (ms) => { now += ms; }, saved: () => JSON.parse(persisted) };
}

test('changing and reverting observed exits never pauses a configured account', async () => {
  const h = harness(), s = h.add('a', 'gateway.test');
  for (const ip of ['203.0.113.1', '203.0.113.2', '203.0.113.1']) {
    h.response.ip = ip;
    await h.api.verifyKernelEgress(s, true);
    assert.equal(h.saved()[0].egress.ip, ip);
    assert.equal(h.accounts.get('a').status, 'running');
    assert.equal(h.accounts.get('a').egress.changedAt, undefined);
    assert.doesNotThrow(() => h.safety.assertAllowed('a'));
  }
});

test('unavailable or invalid exit services do not block tasks or retry on every action', async () => {
  for (const mode of ['unknown', 'invalid', 'failure']) {
    const h = harness(), s = h.add('a', 'gateway.test');
    if (mode === 'unknown') h.response.ip = undefined;
    if (mode === 'invalid') h.response.ip = 'gateway.test';
    if (mode === 'failure') h.response.readFailure = true;
    const configuredProxy = JSON.stringify(h.accounts.get('a').proxy);
    await h.api.verifyKernelEgress(s, true);
    await h.api.verifyKernelEgress(s);
    assert.equal(h.accounts.get('a').egress, undefined);
    assert.equal(h.accounts.get('a').recovery, undefined);
    assert.equal(h.accounts.get('a').status, 'running');
    assert.equal(JSON.stringify(h.accounts.get('a').proxy), configuredProxy);
    assert.doesNotThrow(() => h.safety.assertAllowed('a'));
    assert.equal(h.calls.length, 1);
  }
});

test('changing proxy configuration still rejects a browser bound to the old route', async () => {
  for (const timing of ['before', 'during']) {
    const h = harness(), s = h.add('a', 'gateway.test');
    const change = () => h.api.setAccountProxy('a', { ...s.boundProxy, username: 'changed' });
    if (timing === 'before') change(); else h.response.afterRead = change;
    await assert.rejects(h.api.verifyKernelEgress(s, true), /代理配置已修改/);
    assert.equal(h.accounts.get('a').egress, undefined);
    assert.throws(() => h.safety.assertAllowed('a'), /代理配置已修改/);
  }
});

test('IPv6 observations are normalized without making exit drift a restriction', async () => {
  const h = harness(), s = h.add('a');
  for (const ip of ['2001:0db8:0:0:0:0:0:1', '2001:db8::2']) {
    h.response.ip = ip;
    await h.api.verifyKernelEgress(s, true);
    assert.equal(h.accounts.get('a').egress.changedAt, undefined);
  }
  assert.equal(h.accounts.get('a').egress.ip, '2001:db8::2');
});

test('different proxy gateways sharing observed exit share budgets and incidents; unknown/group holds cannot become 429 cooldowns', async () => {
  const h = harness();
  for (const [id, host] of [['a', 'gateway1.test'], ['b', 'gateway2.test'], ['c', 'gateway3.test']]) {
    const s = h.add(id, host); h.response.ip = id === 'c' ? '203.0.113.99' : '203.0.113.1'; await h.api.verifyKernelEgress(s, true);
  }
  const first = await h.safety.before('a', 'interaction'); first(); const at = h.now();
  await h.safety.before('b', 'interaction'); assert.ok(h.now() - at >= 12000, 'shared actual egress budget applies across distinct gateways');
  h.safety.halt('a', 'forbidden'); h.safety.halt('b', 'forbidden');
  assert.equal(h.safety.blocked('a').code, undefined, 'multi-account group hold stays manual');
  h.safety.halt('a', 'rate_limited'); assert.equal(h.safety.blocked('a').code, undefined);
  assert.equal(h.safety.blocked('c'), undefined);
  h.safety.halt('c', 'rate_limited'); assert.equal(h.safety.blocked('c').code, 'rate_limited');
  h.safety.halt('c', 'captcha'); assert.equal(h.safety.blocked('c').code, 'captcha', 'stronger restriction wins even at same deadline');
  h.safety.halt('c', 'rate_limited', 60 * 60_000); assert.equal(h.safety.blocked('c').code, 'captcha');
  h.add('d', 'gateway4.test'); h.safety.halt('d', 'rate_limited'); h.safety.end('d');
  assert.throws(() => h.safety.begin('d', 'd', 'proxy:gateway4.test', () => {}), (error) => error.code === 'rate_limited' && error.until > h.now());
});

test('isolated observation deduplicates concurrent probes and closes only its own target/socket on success, failure or stop', async () => {
  for (const mode of ['success', 'handshake', 'evaluation', 'stop']) {
    const h = harness(), s = h.add('a', 'gateway.test');
    const mainSocket = s.pageWs, mainPending = new Map(); s.pending = mainPending;
    s.proxyAuth = { username: 'test', password: 'test', origin: 'http://gateway.test:8080' };
    if (mode === 'handshake') h.response.openFailure = true;
    if (mode === 'evaluation') h.response.readFailure = true;
    if (mode === 'stop') h.response.afterCreate = () => s.egressAbort.abort();
    const p = h.api.readKernelEgress(s), q = h.api.readKernelEgress(s);
    if (mode === 'success') { assert.equal(await p, '203.0.113.1'); await q; }
    else await Promise.all([assert.rejects(p), assert.rejects(q)]);
    assert.equal(h.controls.filter((c) => c.method === 'Target.createTarget').length, 1);
    assert.equal(h.controls.filter((c) => c.method === 'Target.closeTarget').length, 1);
    assert.equal(s.pageWs, mainSocket); assert.equal(s.pending, mainPending);
    assert.equal(s.egressProbe, undefined); assert.equal(s.egressAbort, undefined);
    if (h.response.probeSession) {
      assert.notEqual(h.response.probeSession.pending, mainPending);
      assert.equal(h.response.probeSession.pageWs, null);
      assert.equal(h.response.probeSession.proxyAuth.origin, s.proxyAuth.origin);
    }
    if (mode === 'success') assert.ok(h.controls.some((c) => c.method === 'Fetch.enable' && c.params.handleAuthRequests));
  }
});

test('browser-level control cleans late creation acknowledgements after parent stop or timeout, with bounded fallback cleanup', async () => {
  const code = compile(functions('kernelPool', ['readKernelEgress', 'readKernelEgressOnce', 'createEgressTarget', 'onMessage', 'sendNoWait', 'failSession']));
  for (const mode of ['abort', 'timeout-late', 'timeout-late-error', 'timeout-missing']) {
    const timers = new Map(), sockets = [], requests = [], logs = [];
    let sequence = 0;
    const parent = new AbortController(), main = { accountId: 'a', debugPort: 1234, pageWs: { readyState: 1 }, pending: new Map() };
    let runtime;
    runtime = vm.createContext({
      AbortController, AbortSignal, URL, diagnosticAccountAlias, WebSocket: { OPEN: 1 },
      kernelSignal: () => parent.signal, getPage: async () => main,
      devFetchJson: async () => ({ webSocketDebuggerUrl: 'ws://127.0.0.1:1234/devtools/browser/browser-id' }),
      setTimeout: (fn, ms) => { timers.set(++sequence, { fn, ms }); return sequence; }, clearTimeout: (id) => timers.delete(id),
      coworkLog: (...args) => logs.push(args), normalizeEgressIp: (ip) => ip,
      openPageSocket: async (session, targetId, _signal, socketUrl) => {
        assert.match(socketUrl, /\/devtools\/browser\//, 'creation control must survive business-tab closure');
        const socket = { readyState: 1, close() { this.closed = true; }, send(raw) { requests.push(JSON.parse(raw)); } };
        session.pageWs = socket; sockets.push({ session, socket, targetId });
      },
      send: async () => assert.fail('an aborted/timed-out probe must never evaluate or mutate a page'),
    });
    vm.runInContext(code, runtime);
    const pending = runtime.readKernelEgress(main); const rejected = assert.rejects(pending);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    assert.equal(requests.length, 1); assert.equal(requests[0].method, 'Target.createTarget');
    const control = sockets[0]; main.pageWs = null; // Closing the business tab must not lose the creation ack.
    if (mode === 'abort') parent.abort();
    else {
      for (const [id, timer] of [...timers]) if (timer.ms === 5000) { timers.delete(id); timer.fn(); }
      await rejected;
      assert.equal(control.socket.closed, undefined, 'late ID listener survives the creation timeout');
    }
    if (mode === 'timeout-late-error') {
      runtime.onMessage(control.session, JSON.stringify({ id: requests[0].id, error: { code: -32000, message: 'mock create failed' } }));
      assert.equal(requests.filter((r) => r.method === 'Target.closeTarget').length, 0);
    } else if (mode !== 'timeout-missing') {
      runtime.onMessage(control.session, JSON.stringify({ id: requests[0].id, result: { targetId: 'owned-egress-target' } }));
      await rejected;
      assert.equal(requests.filter((r) => r.method === 'Target.closeTarget').length, 1);
      assert.equal(requests.at(-1).params.targetId, 'owned-egress-target');
    } else {
      for (const [id, timer] of [...timers]) if (timer.ms === 30000) { timers.delete(id); timer.fn(); }
      assert.equal(logs.length, 1, 'unknown ID after deadline is diagnosed rather than silently claimed clean');
    }
    assert.equal(control.socket.closed, true); assert.equal(control.session.pending.size, 0); assert.equal(timers.size, 0);
    assert.equal(main.egressProbe, undefined);
  }
});
