import assert from 'node:assert/strict';
import { readFileSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { setImmediate as tick } from 'node:timers/promises';
import { build, transformSync } from 'esbuild';
import { WebSocketServer } from 'ws';

const sourceDir = fileURLToPath(new URL('../src/main/libs/matrix/', import.meta.url));
const require = createRequire(import.meta.url);
const directory = mkdtempSync(path.join(os.tmpdir(), 'matrix-navigation-'));
process.env.NOOBCLAW_MATRIX_DIR = directory;
process.env.NOOBCLAW_NAV_DIAGNOSTICS = '1';
const secret = 'fixture-private-sentinel-4c187';
const login = `https://www.tiktok.com/login?email=${secret}`;
const video = `https://www.tiktok.com/@${secret}/video/170101?opaque=${secret}`;
const proxy = `http://${secret}.invalid:8899`;
const log = [];
const externals = {
  coworkLogger: 'export const coworkLog = (...args) => globalThis.__matrixNavTestLog.push(args);',
  kernelInstaller: 'export const installedKernelPath = () => null, ensureTabGroupExtension = () => null;',
  powerKeepAwake: 'export const acquireSystemKeepAwake = () => {}, releaseSystemKeepAwake = () => {};',
  child_process: 'export const execFileSync = () => ""; export const spawn = () => ({ exitCode: 1, on() {}, kill() {} });',
  accountManager: `export const getAccount = () => ({}), sameProxyRoute = () => true, getLocalEgressIp = () => '',
    proxyBadgeInfo = () => ({}), normalizeEgressIp = () => '', recordAccountEgress = () => '',
    setLocalEgressIp = () => {}, setAccountStatus = () => {}, markAccountRecovery = () => {}, markAccountCooldown = () => {};`,
};
globalThis.__matrixNavTestLog = log;
const entry = `export * from './kernelPool'; export * from './proxyBridge'; export * from './automationSafety'; export * from './kernelNavigation';`;
const compiled = await build({ stdin: { contents: entry, resolveDir: sourceDir }, bundle: true, write: false,
  platform: 'node', packages: 'external', format: 'cjs', plugins: [{ name: 'isolate-matrix', setup(builder) {
    builder.onResolve({ filter: /^(?:child_process)$|\/(?:coworkLogger|kernelInstaller|powerKeepAwake|accountManager)$/ }, args => ({
      path: path.basename(args.path), namespace: 'test-stub',
    }));
    builder.onLoad({ filter: /.*/, namespace: 'test-stub' }, args => ({ contents: externals[args.path] }));
    builder.onLoad({ filter: /(?:kernelPool|proxyBridge|automationSafety)\.ts$/ }, args => {
      const name = path.basename(args.path);
      const baseline = process.env.MATRIX_DIAG_BASELINE;
      const exposes = name === 'kernelPool.ts' ? '\nexport { sessions, failSession, buildKernelArgs, bindKernelSignal, safetyLog };'
        : name === 'proxyBridge.ts' ? '\nexport { probeHttpConnect };' : '';
      return { contents: readFileSync(baseline ? path.join(baseline, name) : args.path, 'utf8') + exposes,
        loader: 'ts', resolveDir: sourceDir };
    });
  } }] });
const runtime = { exports: {} };
new Function('require', 'module', 'exports', compiled.outputFiles[0].text)(require, runtime, runtime.exports);
const app = runtime.exports;
let accountNumber = 0;
test.after(() => {
  delete globalThis.__matrixNavTestLog;
  rmSync(directory, { recursive: true, force: true });
});

function listen(server) { return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server.address().port))); }

async function fixture(t, options = {}) {
  log.length = 0;
  const commands = [], sockets = new Map();
  const tabs = options.tabs || [{ id: 'page-a', type: 'page', url: 'about:blank' }];
  const frame = { id: 'root-private-id', loaderId: 'old-private-loader', url: tabs[0].url };
  const server = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(req.url === '/json/list' ? tabs : req.url === '/api/matrix/command-executor' ? { source: 'void 0' } : {}));
  });
  const wss = new WebSocketServer({ server });
  const port = await listen(server);
  process.env.NOOBCLAW_API_BASE_URL = `http://127.0.0.1:${port}`;
  const id = `test-account-${++accountNumber}-${secret}`;
  const stop = new AbortController();
  const session = { accountId: id, diagnosticsId: `test-session-${accountNumber}`, automation: !!options.automation,
    debugPort: port, pageWs: null, pageTargetId: options.target || null, pageInit: null, startPagePending: !!options.fresh,
    pending: new Map(), msgId: 1, egressCheckedAt: Date.now(), slot: 1,
    ...(options.auth ? { proxyAuth: { origin: proxy, username: secret, password: `${secret}-pass` } } : {}) };
  app.sessions.set(id, session);
  if (options.automation) app.automationSafety.begin(id, id, id, message => app.safetyLog(id, message));
  app.bindKernelSignal(session, stop.signal);
  t.after(async () => {
    session.detachOperationSignal?.();
    app.failSession(session, 'fixture closed');
    app.sessions.delete(id);
    app.automationSafety.end(id);
    for (const socket of wss.clients) socket.terminate();
    await Promise.all([new Promise(resolve => wss.close(resolve)), new Promise(resolve => server.close(resolve))]);
  });
  let timestamp = 0;
  const api = { id, stop, session, frame, tabs, commands, auth: false, sockets,
    events() { return log.filter(line => line[1] === 'matrix-navigation').map(line => line[3]); },
    emit(method, params, target = session.pageTargetId) { sockets.get(target).send(JSON.stringify({ method, params })); },
    request(url, loader, requestId = `root-${secret}`, extras = {}) {
      api.emit('Network.requestWillBeSent', { frameId: frame.id, loaderId: loader, requestId, type: 'Document',
        timestamp: ++timestamp, request: { method: 'GET', url, headers: { Cookie: secret } }, ...extras });
    },
    response(url, loader, status, requestId = `root-${secret}`, extras = {}) {
      const { headers = {}, ...fields } = extras;
      api.emit('Network.responseReceived', { frameId: frame.id, loaderId: loader, requestId, type: 'Document',
        timestamp: ++timestamp, response: { url, status, headers: { 'set-cookie': secret, ...headers } }, ...fields });
    },
    commit(url, loader) {
      Object.assign(frame, { url, loaderId: loader });
      api.emit('Page.frameNavigated', { frame: { ...frame } });
      api.emit('Page.lifecycleEvent', { frameId: frame.id, loaderId: loader, name: 'DOMContentLoaded' });
    },
    challenge(source = 'Proxy', origin = proxy, requestId = `fetch-${secret}`) {
      api.emit('Fetch.authRequired', { frameId: frame.id, requestId, authChallenge: { source, origin, realm: secret } });
    },
  };
  wss.on('connection', (socket, req) => {
    const target = req.url.split('/').pop();
    sockets.set(target, socket);
    socket.on('message', raw => {
      const command = JSON.parse(raw);
      commands.push({ ...command, target });
      const reply = result => socket.send(JSON.stringify({ id: command.id, result }));
      const error = message => socket.send(JSON.stringify({ id: command.id, error: { message } }));
      if (command.method === 'Fetch.enable') api.auth = true;
      if (command.method === 'Fetch.disable') api.auth = false;
      if (options.command?.(command, api, reply, error)) return;
      if (command.method === 'Page.getFrameTree') reply({ frameTree: { frame } });
      else if (command.method === 'Runtime.evaluate') reply({ result: { value: '' } });
      else if (command.method === 'Page.navigate') {
        const loader = `new-${secret}`;
        api.request(command.params.url, loader);
        api.response(command.params.url, loader, 200);
        api.commit(command.params.url, loader);
        reply({ frameId: frame.id, loaderId: loader });
      } else reply({});
    });
  });
  return api;
}

test('loopback CONNECT handles full and split headers, 407, other refusals and parse limits', async t => {
  const outcomes = ['connected', 'connected', 'auth_required', 'rejected', 'invalid_response', 'timeout'];
  const replies = [['HTTP/1.1 200 OK\r\n\r\n'], ['HT', 'TP/1.1 2', '00 Connection established\r\nX: x\r\n', '\r\n'],
    ['HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'], ['HTTP/1.1 403 Forbidden\r\n\r\n'], ['X'.repeat(8200)], []];
  let index = 0;
  const seen = [];
  const server = net.createServer(socket => {
    socket.once('data', request => {
      seen.push(request.toString().startsWith('CONNECT fixture.invalid:443 HTTP/1.1\r\n'));
      const chunks = replies[index++];
      for (let i = 0; i < chunks.length; i++) setTimeout(() => { if (!socket.destroyed) socket.write(chunks[i]); }, 10 * i);
    });
  });
  const port = await listen(server);
  t.after(() => new Promise(resolve => server.close(resolve)));
  const actual = [];
  for (const outcome of outcomes) actual.push(await app.probeHttpConnect({ protocol: 'http', host: '127.0.0.1', port }, 'fixture.invalid', 443, outcome === 'timeout' ? 70 : 500));
  assert.deepEqual(actual, outcomes);
  assert.deepEqual(seen, outcomes.map(() => true));
});

test('Page.navigate result errorText reaches caller without foregrounding or leaking upstream text', async t => {
  const f = await fixture(t, { command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    reply({ frameId: a.frame.id, errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' });
    return true;
  } });
  await assert.rejects(app.kernelNavigate(f.id, login), { code: 'tunnel' });
  assert.equal(f.commands.some(c => c.method === 'Page.bringToFront'), false);
  assert.ok(f.events().some(e => e.event === 'navigate_error' && e.reason === 'tunnel'));
});

test('displays successful navigation only after its own document, tolerating early events and redirect reuse', async t => {
  let complete;
  const f = await fixture(t, { command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    a.request(video, 'new', 'reused');
    a.request(login, 'new', 'reused', { redirectResponse: { status: 302 } });
    a.response(video, 'old-private-loader', 403, 'reused');
    a.response(login, 'new', 200, 'reused');
    complete = () => a.commit(login, 'new');
    reply({ frameId: a.frame.id, loaderId: 'new' });
    return true;
  } });
  const result = app.kernelNavigate(f.id, video);
  while (!complete) await tick();
  assert.equal(f.commands.some(c => c.method === 'Page.bringToFront'), false);
  complete();
  await result;
  const events = f.events();
  assert.ok(events.some(e => e.event === 'redirect' && e.page === 'login' && e.status === 302 && e.hop === 2));
  assert.ok(events.some(e => e.event === 'response' && e.status === 200 && e.kind === 'document' && e.hop === 2));
  assert.equal(events.some(e => e.status === 403), false);
  assert.equal(JSON.stringify(events).includes(secret), false);
});

test('first protected window succeeds after a 407 challenge and credentials are scoped to the configured proxy', async t => {
  let answered = false;
  const f = await fixture(t, { auth: true, fresh: true, command(c, a, reply) {
    if (c.method === 'Page.navigate') {
      a.request(login, 'new');
      if (!a.auth) { a.response(login, 'new', 407); reply({ frameId: a.frame.id, loaderId: 'new', errorText: 'net::ERR_TUNNEL_CONNECTION_FAILED' }); }
      else {
        reply({ frameId: a.frame.id, loaderId: 'new' });
        a.challenge('Server', proxy, 'site-challenge');
        a.challenge('Proxy', 'http://unknown.invalid:8899', 'foreign-challenge');
        a.challenge(null, 'invalid', 'unknown-challenge');
        a.emit('Fetch.requestPaused', { requestId: `fetch-${secret}`, frameId: a.frame.id, networkId: `root-${secret}` });
        a.response(login, 'new', 407);
        a.challenge();
      }
      return true;
    }
    if (c.method === 'Fetch.continueWithAuth' && c.params.requestId.startsWith('fetch-')) {
      answered = c.params.authChallengeResponse.username === secret;
      reply({});
      if (answered) { a.response(login, 'new', 200); a.commit(login, 'new'); }
      return true;
    }
    return false;
  } });
  const args = app.buildKernelArgs({ accountId: f.id, fingerprint: {}, userDataDir: directory, startUrl: login }, 0);
  assert.equal(args.at(-1), 'about:blank');
  await app.kernelEnsureUrl(f.id, login);
  assert.equal(answered, true);
  assert.equal(f.auth, false);
  const authCommands = f.commands.filter(c => c.method === 'Fetch.continueWithAuth');
  assert.deepEqual(authCommands.map(c => c.params.authChallengeResponse.response), ['Default', 'CancelAuth', 'CancelAuth', 'ProvideCredentials']);
  assert.ok(authCommands.slice(0, 3).every(c => !('password' in c.params.authChallengeResponse)));
  assert.ok(f.events().some(e => e.event === 'proxy_outcome' && e.outcome === 'navigation_ready'));
  assert.equal(JSON.stringify(f.events()).includes(secret), false);
  const challenge = f.events().find(e => e.event === 'proxy_challenge' && e.provided);
  const response = f.events().find(e => e.event === 'response' && e.status === 200);
  assert.equal(challenge.requestRef, response.requestRef);
  assert.equal(challenge.frameRef, response.frameRef);
  assert.ok(f.events().some(e => e.event === 'response' && e.status === 407));
  if (process.env.MATRIX_DIAG_SAMPLE) writeFileSync(process.env.MATRIX_DIAG_SAMPLE, JSON.stringify(f.events(), null, 2));
});

test('repeated 407 stops authentication without auto-refresh and clears the interception', async t => {
  const f = await fixture(t, { auth: true, command(c, a, reply) {
    if (c.method === 'Page.navigate') {
      a.request(login, 'new');
      reply({ frameId: a.frame.id, loaderId: 'new' });
      a.challenge();
      return true;
    }
    if (c.method === 'Fetch.continueWithAuth') {
      reply({});
      if (c.params.authChallengeResponse.response === 'ProvideCredentials' && a.auth) a.challenge();
      else { a.response(login, 'new', 407); a.commit(login, 'new'); }
      return true;
    }
    return false;
  } });
  await assert.rejects(app.kernelNavigate(f.id, login), { code: 'http_407' });
  assert.deepEqual(f.commands.filter(c => c.method === 'Fetch.continueWithAuth').map(c => c.params.authChallengeResponse.response), ['ProvideCredentials', 'CancelAuth']);
  assert.equal(f.auth, false);
  assert.equal(f.session.pending.size, 0);
  await assert.rejects(app.kernelEnsureUrl(f.id, login), { code: 'http_407' });
  assert.equal(f.commands.filter(c => c.method === 'Page.navigate').length, 1);
});

test('ordinary 403 does not stop; root 403 and 429 retain typed protection and end waits', async t => {
  for (const number of [403, 429]) {
    await t.test(String(number), async st => {
      const f = await fixture(st, { automation: true, command(c, a, reply) {
        if (c.method !== 'Page.navigate') return false;
        a.request(video, 'new');
        reply({ frameId: a.frame.id, loaderId: 'new' });
        a.response(video, 'new', 403, 'resource', { type: 'Fetch' });
        a.response(video, 'new', number, `root-${secret}`, { headers: { 'Retry-After': '3600' } });
        return true;
      } });
      await assert.rejects(app.kernelNavigate(f.id, video), { code: number === 403 ? 'forbidden' : 'rate_limited' });
      const wait = app.automationSafety.signal(f.id);
      assert.equal(wait.aborted, true);
      assert.equal(wait.reason.code, number === 403 ? 'forbidden' : 'rate_limited');
      assert.ok(app.automationSafety.blocked(f.id).until >= Date.now() + 3_500_000);
      assert.ok(f.events().some(e => e.status === 403 && e.kind === 'resource'));
      assert.ok(f.events().some(e => e.status === number && e.kind === 'document'));
      assert.equal(f.commands.filter(c => c.method === 'Page.navigate').length, 1);
    });
  }
});

test('a dangling navigation is cancelled promptly and the same target can reconnect without seizing another tab', async t => {
  let requested;
  const f = await fixture(t, { auth: true, target: 'page-a', tabs: [{ id: 'page-b', type: 'page', url: video }, { id: 'page-a', type: 'page', url: 'about:blank' }],
    command(c, a, reply) {
      if (c.method !== 'Page.navigate') return false;
      requested = true;
      reply({ frameId: a.frame.id, loaderId: 'pending' });
      return true;
    } });
  const result = app.kernelNavigate(f.id, login);
  while (!requested) await tick();
  f.stop.abort(new Error('user-stopped-fixture'));
  await assert.rejects(result, /user-stopped-fixture/);
  assert.equal(f.session.pending.size, 0);
  assert.equal(f.session.navigation, undefined);
  assert.ok(f.events().some(e => e.event === 'navigate_end' && e.reason === 'cancelled'));
  app.bindKernelSignal(f.session, undefined);
  await app.kernelEnsureUrl(f.id, login);
  assert.deepEqual([...new Set(f.commands.map(c => c.target))], ['page-a']);
  assert.equal(f.commands.filter(c => c.method === 'Page.navigate').length, 1);
});

test('a root loadingFailed uses the matched request and a fixed error class rather than upstream text', async t => {
  const f = await fixture(t, { command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    a.request(video, 'new');
    a.emit('Network.loadingFailed', { requestId: `root-${secret}`, timestamp: 2, type: 'Document',
      errorText: `net::ERR_INTERNAL_${secret} ${video}` });
    reply({ frameId: a.frame.id, loaderId: 'new' });
    return true;
  } });
  await assert.rejects(app.kernelNavigate(f.id, video), { code: 'browser_error' });
  const events = f.events();
  assert.equal(events.find(e => e.event === 'loading_failed').requestRef, events.find(e => e.event === 'request_start').requestRef);
  assert.ok(events.every(e => !JSON.stringify(e).includes(secret)));
});

test('protection interrupts an in-flight login read and preserves the restriction instead of a timeout', async t => {
  let inLogin = false;
  const f = await fixture(t, { automation: true, command(c) {
    if (inLogin && c.method === 'Runtime.evaluate') return true; // Simulate an unanswered browser probe.
    return false;
  } });
  await app.kernelNavigate(f.id, video);
  inLogin = true;
  const probe = app.checkKernelLogin(f.id, 'tiktok');
  while (!f.session.loginChecks?.size) await tick();
  f.request(video, `site-denial-${secret}`, 'second-document');
  f.response(video, `site-denial-${secret}`, 403, 'second-document');
  assert.equal(await probe, null);
  assert.equal(f.session.loginRestriction, 'forbidden');
  assert.equal(f.session.loginChecks.size, 0);
  assert.ok(f.events().some(e => e.event === 'login_check' && e.result === 'unknown' && e.reason === 'platform_restricted'));
});

test('failed Fetch cleanup detaches the client and the next explicit navigation may reopen its own target', async t => {
  let first = true;
  const f = await fixture(t, { auth: true, command(c, _a, _reply, error) {
    if (c.method !== 'Fetch.disable' || !first) return false;
    first = false;
    error(`private proxy diagnostics ${secret}`);
    return true;
  } });
  await assert.rejects(app.kernelNavigate(f.id, login), { code: 'protocol' });
  assert.equal(f.session.pageWs, null);
  assert.equal(f.session.pending.size, 0);
  await app.kernelNavigate(f.id, video);
  assert.equal(f.auth, false);
  assert.equal(f.commands.filter(c => c.method === 'Page.navigate').length, 2);
  assert.ok(f.events().some(e => e.event === 'proxy_control_failed' && e.operation === 'disable'));
  assert.equal(JSON.stringify(f.events()).includes(secret), false);
});

test('site-initiated root navigation still protects before frame commit', async t => {
  const f = await fixture(t, { automation: true });
  await app.kernelNavigate(f.id, login);
  f.request(video, 'site-navigation', 'other-request');
  f.response(login, `new-${secret}`, 403, 'delayed-old-request');
  f.response(video, 'site-navigation', 403, 'other-request');
  const signal = app.automationSafety.signal(f.id);
  if (!signal.aborted) await new Promise(resolve => signal.addEventListener('abort', resolve, { once: true }));
  assert.equal(signal.reason.code, 'forbidden');
  const denied = f.events().filter(e => e.event === 'response' && e.status === 403);
  assert.equal(denied.length, 1);
  assert.equal(denied[0].page, 'video');
});

test('turning off diagnostics leaves the navigation outcome and platform protection unchanged', async t => {
  const f = await fixture(t, { command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    a.request(video, 'silent');
    a.response(video, 'silent', 403);
    reply({ frameId: a.frame.id, loaderId: 'silent' });
    return true;
  }, automation: true });
  process.env.NOOBCLAW_NAV_DIAGNOSTICS = '0';
  try {
    await assert.rejects(app.kernelNavigate(f.id, video), { code: 'forbidden' });
    assert.deepEqual(f.events(), []);
  } finally { process.env.NOOBCLAW_NAV_DIAGNOSTICS = '1'; }
});

test('a burst beyond the resource quota cannot crowd out the current root Retry-After', async t => {
  const f = await fixture(t, { automation: true, command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    for (let i = 0; i < 128; i++) {
      a.response(video, 'old-private-loader', 403, `resource-${i}`, { type: i % 2 === 0 ? 'Image' : 'Fetch' });
    }
    a.response(video, 'old-private-loader', 403, 'old-root');
    a.response(video, 'child-loader', 403, 'child-request', { frameId: 'child' });
    a.request(video, 'new-limited');
    a.response(video, 'new-limited', 429, `root-${secret}`, { headers: { 'Retry-After': '3600' } });
    reply({ frameId: a.frame.id, loaderId: 'new-limited' });
    return true;
  } });
  const before = Date.now();
  await assert.rejects(app.kernelNavigate(f.id, video), { code: 'rate_limited' });
  assert.ok(app.automationSafety.accountPause(f.id).until >= before + 3600_000);
  assert.equal(f.events().filter(e => e.kind === 'document' && e.status === 403).length, 0);
  assert.equal(f.events().filter(e => e.kind === 'document' && e.status === 429).length, 1);
  const sent = f.commands.length;
  await assert.rejects(app.kernelEval(f.id, 'document.title'), { code: 'rate_limited' });
  assert.equal(f.commands.length, sent);
});

test('cancelled authentication cleanup has one cancelled terminal and all reachable navigation logs use the same alias', async t => {
  const f = await fixture(t, { automation: true, auth: true, command(c, a) {
    if (c.method !== 'Fetch.disable') return false;
    a.stop.abort(new Error('explicit local cancel'));
    return true;
  } });
  await assert.rejects(app.kernelNavigate(f.id, video), /explicit local cancel/);
  assert.deepEqual(f.events().filter(e => e.event === 'navigate_end').map(e => e.reason), ['cancelled']);
  assert.equal(f.session.pending.size, 0);
  assert.equal(f.session.pageWs, null);
  await app.checkKernelLogin(f.id, 'tiktok');
  const account = f.events().find(e => e.event === 'navigate_start').account;
  assert.ok(log.some(([, tag, message]) => tag === 'matrix-login' && message.includes(account)));
  assert.equal(JSON.stringify(log).includes(secret), false);
  assert.equal(JSON.stringify(log).includes(f.id), false);
});

test('scan setup preserves an occupied unrelated tab and rejects it as a login entry', async t => {
  const f = await fixture(t, { tabs: [{ id: 'page-a', type: 'page', url: `https://occupied.invalid/?val=${secret}` }] });
  assert.equal(await app.kernelEnsureUrl(f.id, login), 'preserved');
  await assert.rejects(app.kernelEnsureUrl(f.id, login, true), { code: 'different_page' });
  assert.equal(f.commands.some(c => c.method === 'Page.navigate'), false);
});

test('root replacement across reply, first commit, and authentication cleanup follows the admitted document', async t => {
  for (const [stage, status] of [['before_reply', 200], ['before_commit', 429], ['cleanup', 200]]) {
    await t.test(stage, async st => {
      let finishReplacement;
      const f = await fixture(st, { automation: status === 429, auth: stage === 'cleanup', command(c, a, reply) {
        const original = 'first-root', replacement = 'replacement-root';
        const successor = () => {
          a.request(login, replacement, 'successor');
          a.response(login, replacement, status, 'successor', { headers: { 'Retry-After': '3600' } });
          a.response(video, original, 403, 'original');
          a.emit('Page.lifecycleEvent', { frameId: a.frame.id, loaderId: original, name: 'DOMContentLoaded' });
          a.response(video, 'child-loader', 403, 'child', { frameId: 'embedded-frame' });
        };
        if (c.method === 'Page.navigate') {
          if (stage === 'before_reply') {
            // This candidate has no proved predecessor from the acknowledged command.
            a.request(video, 'foreign-root', 'foreign-request');
            a.response(video, 'foreign-root', 403, 'foreign-request');
          }
          if (stage === 'before_commit') reply({ frameId: a.frame.id, loaderId: original });
          a.request(video, original, 'original');
          a.response(video, original, 200, 'original');
          if (stage === 'cleanup') a.commit(video, original);
          else successor();
          if (stage === 'before_reply') a.commit(login, replacement);
          if (stage !== 'before_commit') reply({ frameId: a.frame.id, loaderId: original });
          return true;
        }
        if (c.method === 'Fetch.disable' && stage === 'cleanup') {
          successor();
          finishReplacement = () => a.commit(login, replacement);
          reply({});
          return true;
        }
        return false;
      } });
      const before = Date.now();
      let settled = false;
      const result = app.kernelNavigate(f.id, video).finally(() => { settled = true; });
      if (stage === 'cleanup') {
        while (!finishReplacement && !settled) await tick();
        await tick();
        assert.equal(settled, false, 'the initial DOM event cannot complete the replacement');
        finishReplacement();
      }
      if (status === 429) {
        await assert.rejects(result, { code: 'rate_limited' });
        assert.ok(app.automationSafety.accountPause(f.id).until >= before + 3600_000);
      } else await result;
      const events = f.events();
      assert.equal(events.filter(e => e.event === 'document_replaced').length, 1);
      assert.equal(events.filter(e => e.event === 'navigate_end').length, 1);
      assert.equal(events.some(e => e.kind === 'document' && e.status === 403), false);
      assert.equal(f.session.pending.size, 0);
    });
  }
});

test('occupied same-site login entry is preserved; a video requires positive login evidence', async t => {
  for (const [url, verified, result] of [[login, false, 'preserved'], [video, false, 'different_page'], [video, true, 'preserved']]) {
    await t.test(result, async st => {
      const f = await fixture(st, { tabs: [{ id: 'page-a', type: 'page', url }], command(c, _a, reply) {
        if (!verified) return false;
        if (c.method === 'Network.getAllCookies') {
          reply({ cookies: [{ domain: '.tiktok.com', name: 'sessionid', value: secret }] });
          return true;
        }
        if (c.method !== 'Runtime.evaluate') return false;
        const expression = c.params.expression;
        reply({ result: { value: expression === 'location.href' ? url : expression.includes('document.readyState') ? true
          : expression === app.AUTOMATION_RESTRICTION_EXPR ? '' : '1' } });
        return true;
      } });
      const outcome = await app.kernelEnsureUrl(f.id, login, true).catch(error => error.code);
      assert.equal(outcome, result);
      assert.equal(f.commands.some(c => c.method === 'Page.navigate'), false);
    });
  }
});

test('manual open IPC preserves a safe startup category from a simulated process exit', async () => {
  log.length = 0;
  const source = readFileSync(new URL('../src/main/sidecar-server.ts', import.meta.url), 'utf8');
  const start = source.indexOf("case 'matrix:openWindow':");
  const end = source.indexOf("case 'matrix:resolveChargeUncertain':", start);
  const body = source.slice(start, end).replace(/await import\('\.\/libs\/matrix\/(\w+)'\)/g, (_, name) => name);
  const { code } = transformSync("return async args => { switch ('matrix:openWindow') {" + body + '} };', { loader: 'ts' });
  const account = { id: secret, userDataDir: path.join(directory, secret), fingerprint: {} };
  const dispatcher = new Function('accountManager', 'kernelPool', 'matrixOpenWindowPending', 'writeJSON', 'res', code)(
    { getAccount: () => account, accountBadgeLabel: () => '' }, app, new Set(), (_res, _status, payload) => payload, {});
  const outcome = await dispatcher([{ accountId: account.id, kernelPath: `fixture-kernel-${secret}`, url: login }]);
  assert.deepEqual(outcome, { ok: false, error: 'kernel_start:process_exited' });
  assert.equal(JSON.stringify([outcome, log]).includes(secret), false);
  assert.equal(app.getSession(account.id), undefined);
});

test('HTTP denial metadata is scoped to root/write, bounded, and never includes fixture credentials', async t => {
  const f = await fixture(t, { automation: true, command(c, a, reply) {
    if (c.method !== 'Page.navigate') return false;
    const loader = 'fixture-header-loader';
    a.request(video, loader);
    reply({ frameId: a.frame.id, loaderId: loader });
    const headers = {
      SeRvEr: 'edge' + String.fromCharCode(13, 10) + ' proxy ' + 'x'.repeat(250),
      vIA: '1.1 edge.example', 'Cf-RaY': '1234567890abcdef-LAX', 'X-Tt-LoGiD': '20261124000001ABCD',
      'CoNtEnT-TyPe': 'text/html; charset=utf-8', Authorization: secret, COOKIE: secret,
      'proxy-authorization': secret, 'x-access-token': secret, 'Set-Cookie': secret,
    };
    a.response(video, loader, 403, 'normal-resource', { type: 'Fetch', headers });
    a.response(video, loader, 403, undefined, { headers });
    return true;
  } });
  f.session.observedEgressIp = '203.0.113.44';
  await assert.rejects(app.kernelNavigate(f.id, video), { code: 'forbidden' });
  const row = f.events().find(e => e.event === 'response' && e.kind === 'document');
  assert.equal(row.status, 403);
  assert.equal(row.server.length, 96);
  assert.equal(row.server.includes(String.fromCharCode(13)), false);
  assert.equal(row.via, '1.1 edge.example');
  assert.equal(row['cf-ray'], '1234567890abcdef-LAX');
  assert.equal(row['x-tt-logid'], '20261124000001ABCD');
  assert.equal(row['content-type'], 'text/html');
  assert.equal(row.exitIp, '203.0.113.44');
  assert.equal(f.events().find(e => e.kind === 'resource' && e.event === 'response').server, undefined);
  assert.equal(JSON.stringify(log).includes(secret), false);
  assert.equal(f.commands.filter(c => c.method === 'Page.navigate').length, 1);
  assert.ok(app.automationSafety.blocked(f.id));
  console.log('root denial fixture', JSON.stringify({ status: row.status, allowedKeys: ['server','via','cf-ray','x-tt-logid','content-type'], headerSize: row.server.length, exitIp: row.exitIp, retries: 0, cooldown: true }));
});

test('critical write 429 logs safe fields and keeps Retry-After protection without leaking a disguised proxy password', async t => {
  const f = await fixture(t, { automation: true });
  await app.kernelNavigate(f.id, video);
  f.session.boundProxy = { username: 'fixture-user-ABCDE', password: 'fixture-pass-ABCDE' };
  f.session.observedEgressIp = 'not-an-ip';
  const url = 'https://www.tiktok.com/api/comment/publish/';
  f.request(url, f.frame.loaderId, 'fixture-write', { type: 'XHR', request: { method: 'POST', url } });
  f.response(url, f.frame.loaderId, 429, 'fixture-write', { type: 'XHR', headers: { Server: 'fixture-pass-ABCDE', Via: 'http://u:p@proxy.invalid/', 'Retry-After': '3600', 'Content-Type': 'application/json', 'x-token': secret } });
  await tick();
  const row = f.events().find(e => e.event === 'response' && e.kind === 'write');
  assert.equal(row.status, 429);
  assert.equal(row['content-type'], 'application/json');
  for (const key of ['server', 'via', 'exitIp', 'retry-after']) assert.equal(row[key], undefined);
  assert.equal(JSON.stringify(log).includes('fixture-pass-ABCDE'), false);
  assert.equal(JSON.stringify(log).includes(secret), false);
  assert.equal(app.automationSafety.signal(f.id).reason.code, 'rate_limited');
  assert.ok(app.automationSafety.blocked(f.id).until >= Date.now() + 3500000);
  console.log('write denial fixture', JSON.stringify({ status: row.status, sanitized: true, invalidIpOmitted: true, protection: 'rate_limited' }));
});


test('synthetic auth schemes and known credential spellings never appear in allowed response fields', () => {
  const user='fixture-A+A!', pass='fixture-B:b-xy';
  const values=new Set(['Basic YWJjZA', 'Bearer ABCDEF', 'Digest peer', 'Negotiate token-nope', 'NTLM ABCDEF', 'BASIC://path']);
  for (const raw of [user,pass,user+':'+pass]) {
    for(const text of [raw,encodeURIComponent(raw)]) {
      const encoded=Buffer.from(text).toString('base64');
      for(const value of [text,encoded,encoded.replace(/=+$/,''),encodeURIComponent(encoded)]) values.add(value);
    }
  }
  for (const value of values) {
    const rows=[], responses=[];
    const trace=new app.NavigationTrace('fixture','redaction',row=>rows.push(row),(...args)=>responses.push(args),undefined,()=>({secrets:[user,pass]}));
    const frame={id:'root',loaderId:'root-loader',url:'https://www.tiktok.com/'};
    trace.seed(frame);
    const base={frameId:frame.id,loaderId:frame.loaderId,type:'Document',requestId:'fixture-request'};
    trace.observe('Network.requestWillBeSent',{...base,timestamp:1,request:{url:frame.url,method:'GET'}});
    trace.observe('Network.responseReceived',{...base,timestamp:2,response:{url:frame.url,status:403,
      headers:{SeRvEr:'edge '+value, Via:'1.1 '+value, 'Content-Type':'text/html; charset=utf-8', 'CF-Ray':'1234abcd-LAX'}}});
    const record=rows.find(row=>row.event==='response');
    assert.equal(record.status,403);
    assert.ok(!('server' in record)&&!('via' in record),'fixture credential spelling logged');
    assert.equal(record['content-type'],'text/html');
    assert.equal(record['cf-ray'],'1234abcd-LAX');
    assert.equal(responses.length,1);
  }
  console.log('credential fixture', JSON.stringify({rejectedSpellings:values.size,normalHeadersPreserved:true,responseObserverUnchanged:true}));
});



test('F1 navigation proof requires a fresh 2xx response on the same live document, rejects recovered 407', async t => {
  const home = 'https://www.tiktok.com/';
  for (const status of [200, 304, 407, 'memory-cache', 'disk-cache', 'service-worker']) {
    await t.test(String(status), async sub => {
      const f = await fixture(sub, { command(c, a, reply) {
        if (c.method !== 'Page.navigate') return false;
        a.request(home, 'manual-proof');
        if (status === 'memory-cache') a.emit('Network.requestServedFromCache', { requestId: 'root-' + secret });
        if (typeof status === 'number') a.response(home, 'manual-proof', status);
        else a.emit('Network.responseReceived', { frameId: a.frame.id, loaderId: 'manual-proof', requestId: 'root-' + secret,
          type: 'Document', response: { url: home, status: 200, fromDiskCache: status === 'disk-cache', fromServiceWorker: status === 'service-worker' } });
        if (status === 407) a.response(home, 'manual-proof', 200);
        a.commit(home, 'manual-proof');
        reply({ frameId: a.frame.id, loaderId: 'manual-proof' });
        return true;
      } });
      if (status !== 200) {
        await assert.rejects(app.navigateForAccountReview(f.id, home), { code: status === 407 ? 'http_407' : 'ownership_unconfirmed' });
        return;
      }
      const proof = await app.navigateForAccountReview(f.id, home);
      assert.equal(proof.url, home);
      assert.equal(typeof proof.generation, 'number');
      assert.equal(typeof proof.connectionEpoch, 'string');
      proof.assertCurrent();
      f.emit('Page.navigatedWithinDocument', { frameId: f.frame.id, url: home + '#superseded' });
      for (let i = 0; i < 30 && f.session.navigation.snapshot().generation === proof.generation; i++) {
        await new Promise(resolve => setTimeout(resolve, 5));
      }
      assert.throws(proof.assertCurrent, { code: 'ownership_unconfirmed' });
    });
  }
});
