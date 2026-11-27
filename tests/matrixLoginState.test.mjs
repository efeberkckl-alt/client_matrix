import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';

const parse = (file) => ts.createSourceFile(file, readFileSync(new URL(file, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true);
const kernel = parse('../src/main/libs/matrix/kernelPool.ts');
const select = (file, names) => file.statements.filter((node) =>
  ts.isFunctionDeclaration(node) && names.includes(node.name?.text)
  || ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => names.includes(d.name.getText(file))),
).map((node) => node.getText(file)).join('\n');
function evaluate(source, context) {
  const module = { exports: {} };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
  runInNewContext(compiled.outputText, { module, exports: module.exports, URL, diagnosticAccountAlias, ...context });
  return module.exports;
}
const restriction = evaluate(select(parse('../src/main/libs/matrix/automationSafety.ts'), ['AUTOMATION_RESTRICTION_EXPR']), {}).AUTOMATION_RESTRICTION_EXPR;
const loginSource = select(kernel, ['LOGIN_COOKIES', 'LOGIN_DOMAINS', 'COOKIE_FASTPATH_EXEMPT', 'STRICT_LOGIN_PLATFORMS', 'TIKTOK_SELF_PROFILE_URL', 'waitForKernel', 'failSession', 'checkKernelLogin', 'checkKernelLoginInner']) + '\nmodule.exports.failSession = failSession;';

function loginHarness(options = {}) {
  let persisted = 0;
  const logs = [];
  const statuses = [];
  const timers = new Map();
  let timerId = 0;
  const location = new URL(options.url || 'https://www.tiktok.com/');
  const node = (visible = true, extra = {}) => ({
    getClientRects: () => visible ? [{}] : [], getBoundingClientRect: () => ({ width: 200, height: 200 }),
    getAttribute: () => '/@self', querySelector: () => null, ...extra,
  });
  const nav = options.nav === false ? null : node(!options.hiddenNav);
  const file = options.file ? node(!options.hiddenFile, { disabled: !!options.disabledFile }) : null;
  const password = options.password ? node() : null;
  const document = {
    readyState: options.loading ? 'loading' : 'complete',
    body: { childElementCount: options.blank ? 0 : 1, innerText: options.text || '' },
    querySelector: (selector) => selector === '[data-e2e="nav-profile"]' ? nav
      : selector === 'select[class*="SelectFormContainer"]' && options.loginSelect ? node() : null,
    querySelectorAll: (selector) => selector === 'input[type="file"]' ? (file ? [file] : [])
      : selector.startsWith('input[type="password"]') ? (password ? [password] : []) : [],
  };
  const context = {
    AbortController, AbortSignal,
    Date: class extends Date { static now() { return options.now ?? super.now(); } },
    sessions: new Map(options.noSession ? [] : [['account', { operationSignal: options.signal, pending: new Map(), automation: options.automation, background: options.background }]]),
    kernelSignal: s => s.operationSignal,
    getAccount: () => ({ recovery: options.recovery }),
    setAccountStatus: (...args) => statuses.push(args),
    getPage: async () => { if (options.pageFailure) throw Error('CDP unavailable'); return {}; },
    send: async () => { if (options.cookieFailure) throw Error('Cookie read unavailable'); return { cookies: options.cookies ?? [{ name: 'sessionid', value: 'test', domain: '.tiktok.com', expires: Date.now() / 1000 + 3600 }] }; },
    kernelEval: async (_id, expr) => {
      options.beforeEval?.(expr, document);
      if (options.pendingEval) return options.pendingEval instanceof Promise ? options.pendingEval : new Promise(() => {});
      if (options.evalFailure || options.probeFailure && expr.includes('(function')) throw Error('Evaluation unavailable');
      if (Object.hasOwn(options, 'probeResult') && expr.includes('(function')) return options.probeResult;
      return runInNewContext(expr, { document, location, URL, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }), fetch: async () => {
        if (options.fetchFailure) throw Error('fetch failed');
        const status = options.apiStatus ?? 200;
        return { ok: status >= 200 && status < 300, status, json: async () => { if (options.jsonFailure) throw Error('invalid JSON'); return options.apiResult || {}; } };
      } });
    },
    persistKernelCookies: async () => { persisted++; }, coworkLog: (...args) => logs.push(args),
    AUTOMATION_RESTRICTION_EXPR: restriction,
    setTimeout: (fn, ms) => {
      const id = ++timerId;
      timers.set(id, { fn, ms });
      if (!options.manualTimers && ms === 2000) queueMicrotask(() => { if (timers.delete(id)) { options.onWait?.(document); fn(); } });
      return id;
    },
    clearTimeout: id => timers.delete(id), kernelNavigate: async () => {},
  };
  const api = evaluate(loginSource, context);
  return { ...api, persisted: () => persisted, logs, sessions: context.sessions, timers, document, statuses,
    fire(ms) { const entry = [...timers].find(([, t]) => t.ms === ms); assert.ok(entry); timers.delete(entry[0]); entry[1].fn(); },
    close() { api.failSession(context.sessions.get('account'), 'kernel closed'); context.sessions.clear(); },
  };
}

test('TikTok loading evidence is polled every two seconds within one bounded check', async () => {
  let waits = 0;
  const h = loginHarness({ loading: true, onWait: document => { if (++waits === 2) document.readyState = 'complete'; } });
  assert.equal(await h.checkKernelLogin('account', 'tiktok'), true);
  assert.equal(waits, 2);
  assert.equal(h.logs.at(-1)[3].attempts, 3);
  assert.equal(h.persisted(), 0, 'a login read cannot write cookies');
  assert.equal(h.timers.size, 0);
  assert.equal(h.sessions.get('account').loginChecks.size, 0);
});

test('the total TikTok budget bounds a stalled CDP read and ignores its late completion', async () => {
  let resolveRead, reads = 0;
  const pendingEval = new Promise(resolve => { resolveRead = resolve; });
  const h = loginHarness({ manualTimers: true, pendingEval, beforeEval: () => { reads++; } });
  const pending = h.checkKernelLogin('account', 'tiktok');
  await new Promise(setImmediate);
  h.fire(24_000);
  assert.equal(await pending, null);
  assert.equal(h.logs.at(-1)[3].reason, 'check_timeout');
  resolveRead('https://www.tiktok.com/');
  await new Promise(setImmediate);
  assert.equal(reads, 1);
  assert.equal(h.persisted(), 0);
  assert.equal(h.timers.size, 0);
});

test('stop or actual session cleanup interrupts both TikTok polling sleep and pending reads', async () => {
  for (const phase of ['sleep', 'read']) for (const end of ['stop', 'close']) {
    const ctrl = new AbortController();
    const h = loginHarness({ manualTimers: true, signal: ctrl.signal, loading: true, pendingEval: phase === 'read' });
    const pending = h.checkKernelLogin('account', 'tiktok');
    await new Promise(setImmediate);
    if (phase === 'sleep') assert.ok([...h.timers.values()].some(timer => timer.ms === 2000));
    if (end === 'stop') ctrl.abort(); else h.close();
    assert.equal(await pending, null);
    assert.equal(h.persisted(), 0);
    assert.equal(h.timers.size, 0);
  }
});

test('automated restrictions stay paused across calls; manual login may complete; existing cooldown survives', async () => {
  for (const [text, expected] of [['Access Denied', 'forbidden'], ['HTTP ERROR 429', 'rate_limited']]) {
    const h = loginHarness({ background: true, text });
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), null);
    assert.equal(h.sessions.get('account').loginRestriction, expected);
    assert.equal(h.statuses.length, 1);
    h.document.body.innerText = '';
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), null);
    assert.equal(h.persisted(), 0);
    assert.equal(h.logs.at(-1)[3].reason, 'platform_restricted');
    h.sessions.get('account').background = false; // The user explicitly reuses the window for login.
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), true);
    assert.equal(h.sessions.get('account').loginRestriction, undefined);
  }
  const manual = loginHarness({ text: 'Access Denied' });
  assert.equal(await manual.checkKernelLogin('account', 'tiktok'), null);
  manual.document.body.innerText = '';
  assert.equal(await manual.checkKernelLogin('account', 'tiktok'), true);
  assert.equal(manual.statuses.length, 0);
  for (const expires of [Date.now() + 60_000, Date.now() - 1]) {
    const h = loginHarness({ background: true, text: 'HTTP ERROR 429', recovery: { reason: 'rate_limited', nextCheckAt: expires } });
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), null);
    assert.equal(h.statuses.length, expires > Date.now() ? 0 : 1);
  }
  const concurrent = loginHarness({ background: true, beforeEval: expr => {
    if (expr.includes('var self=')) concurrent.sessions.get('account').loginRestriction = 'captcha';
  } });
  assert.equal(await concurrent.checkKernelLogin('account', 'tiktok'), null);
  assert.equal(concurrent.persisted(), 0);
});

test('cookie persistence cannot issue a delayed write after the login-check signal is cancelled', async () => {
  const ctrl = new AbortController();
  let resolveRead;
  const calls = [], session = {};
  const api = evaluate(select(kernel, ['waitForKernel', 'persistKernelCookies']), {
    sessions: new Map([['account', session]]), getAccount: () => ({}),
    send: async (_session, method) => { calls.push(method); return new Promise(resolve => { resolveRead = resolve; }); },
  });
  const pending = api.persistKernelCookies('account', ctrl.signal);
  ctrl.abort();
  assert.equal(await pending, 0);
  resolveRead({ cookies: [{ name: 'sessionid', value: 'offline', domain: '.tiktok.com', session: true }] });
  await new Promise(setImmediate);
  assert.deepEqual(calls, ['Network.getAllCookies']);
});

test('login diagnostics record changed verdicts/reasons, suppress polling and contain no credentials or page data', async () => {
  const options = { now: 1000, url: 'https://www.tiktok.com/?token=secret-url', cookies: [{ name: 'sessionid', value: 'secret-cookie', domain: '.tiktok.com' }] };
  const h = loginHarness(options);
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 1);
  assert.deepEqual(JSON.parse(JSON.stringify(h.logs[0][3])), { platform: 'tiktok', result: true, reason: 'confirmed', attempts: 1, elapsedMs: 0 });
  options.now += 3000;
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 1);
  options.now = 301000;
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 2);
  options.evalFailure = true;
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.at(-1)[3].reason, 'page_unavailable');
  assert.equal(h.logs.at(-1)[3].result, 'unknown');
  options.evalFailure = false;
  options.cookieFailure = true;
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 4); // Same unknown verdict but a different cause is useful.
  assert.equal(h.logs.at(-1)[3].reason, 'cookies_unreadable_or_empty');
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 4);
  options.cookieFailure = false;
  options.cookies = [{ name: 'visitor', value: 'secret-visitor', domain: '.tiktok.com' }];
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.at(-1)[3].result, false);
  assert.equal(h.logs.at(-1)[3].reason, 'auth_cookie_missing');
  assert.doesNotMatch(JSON.stringify(h.logs), /secret-|https:|sessionid|Evaluation unavailable|Cookie read unavailable/);
  h.sessions.clear();
  assert.equal(await h.checkKernelLogin('account', 'tiktok'), null);
  assert.equal(h.logs.length, 5); // No global cache or polling logs for closed sessions.
  h.sessions.set('account', {});
  await h.checkKernelLogin('account', 'tiktok');
  assert.equal(h.logs.length, 6); // A new session starts a fresh diagnostic lifecycle.
});

test('TikTok accepts only loaded, supported positive evidence with a valid first-party login cookie', async () => {
  for (const options of [{}, { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true }]) {
    const h = loginHarness(options);
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), true);
    assert.equal(h.persisted(), 0, 'the read-only path has no cookie write');
  }
  for (const options of [
    { url: 'https://www.tiktok.com/login' }, { nav: false }, { hiddenNav: true },
    { nav: false, file: true }, { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true, hiddenFile: true },
    { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true, disabledFile: true },
    { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true, loginSelect: true },
    { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true, password: true },
    { url: 'https://www.tiktok.com/tiktokstudio/upload', nav: false, file: true, text: 'Access Denied' },
    { url: 'https://other.invalid/tiktokstudio/upload', file: true },
    { cookies: [{ name: 'sessionid', value: 'other', domain: '.instagram.com' }] },
    { cookies: [{ name: 'sessionid', value: '', domain: '.tiktok.com' }] },
    { cookies: [{ name: 'sessionid', value: 'expired', domain: '.tiktok.com', expires: 1 }] },
  ]) {
    const h = loginHarness(options);
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), null, JSON.stringify(options));
    assert.equal(h.persisted(), 0);
  }
});

test('missing/failed CDP evidence is unknown; explicit platform results and other-platform valid-cookie fallback survive', async () => {
  for (const options of [{ noSession: true }, { pageFailure: true }, { cookieFailure: true }, { cookies: [] }, { evalFailure: true }, { probeFailure: true }, { blank: true }, { loading: true }, { url: 'about:blank' }]) {
    const h = loginHarness(options);
    assert.equal(await h.checkKernelLogin('account', 'tiktok'), null, JSON.stringify(options));
    assert.equal(h.persisted(), 0);
  }
  const visitor = loginHarness({ cookies: [{ name: 'visitor', value: 'yes', domain: '.tiktok.com' }], nav: false });
  assert.equal(await visitor.checkKernelLogin('account', 'tiktok'), false);
  for (const loggedIn of [true, false]) {
    const h = loginHarness({ url: 'https://www.bilibili.com/', cookies: [{ name: 'SESSDATA', value: 'test', domain: '.bilibili.com' }], apiResult: { data: { isLogin: loggedIn } } });
    assert.equal(await h.checkKernelLogin('account', 'bilibili'), loggedIn);
  }
  const instagram = loginHarness({ url: 'https://www.instagram.com/', cookies: [{ name: 'sessionid', value: 'test', domain: '.instagram.com' }], nav: false });
  assert.equal(await instagram.checkKernelLogin('account', 'instagram'), true);
  const unrelated = loginHarness({ url: 'https://www.instagram.com/', cookies: [{ name: 'sessionid', value: 'test', domain: '.tiktok.com' }], nav: false });
  assert.equal(await unrelated.checkKernelLogin('account', 'instagram'), null);
  assert.equal(await loginHarness().checkKernelLogin('account', 'unknown-platform'), null);
});

test('keepalive schedules recovery after inconclusive checks without marking login success or expiry', async () => {
  const file = parse('../src/main/libs/matrix/keepAlive.ts');
  const source = `${select(file, ['awaitingFirstLogin', 'keepAliveOne'])}\nmodule.exports = { keepAliveOne };`;
  for (const options of [{ results: [null] }, { results: [false], failLaunch: 2 }, { results: [true], failNavigate: true }, { results: [false, null] }, { results: [true] }, { results: [false, false] }]) {
    const events = [];
    let launches = 0;
    const results = [...options.results];
    const context = {
      getAccount: () => ({ id: 'account', platform: 'tiktok', status: 'login_required', lastAliveAt: 1 }),
      markLoginRecheck: () => {}, platformKey: () => 'tiktok', loginUrlFor: () => 'https://www.tiktok.com/', accountBadgeLabel: () => '',
      launchKernel: async () => { if (++launches === options.failLaunch) throw Error('launch failed'); },
      kernelNavigate: async () => { if (options.failNavigate) throw Error('navigation failed'); },
      checkKernelLogin: async () => results.shift() ?? null, closeKernel: () => {}, sleep: async () => {},
      markAccountAlive: () => events.push('alive'), setAccountStatus: (_id, status) => events.push(status), emitAccount: () => {},
      markAccountRecovery: () => events.push('recovery'),
      coworkLog() {}, kernelEval: async () => '', AUTOMATION_RESTRICTION_EXPR: 'read-only',
      require: () => ({ probeAndSaveHealth: async () => {} }),
    };
    await evaluate(source, context).keepAliveOne('account');
    const expected = options.results.length === 1 && options.results[0] === true && !options.failNavigate ? ['alive']
      : options.results.length === 2 && options.results[1] === false ? ['login_required'] : ['recovery'];
    assert.deepEqual(events, expected, JSON.stringify(options));
  }
});

test('authentication API failures cannot fall back to residual cookies or report logout', async () => {
  for (const [platform, host, name, value] of [
    ['bilibili', 'www.bilibili.com', 'SESSDATA', 'test'],
    ['xhs', 'www.xiaohongshu.com', 'web_session', 'test'],
    ['toutiao', 'mp.toutiao.com', 'sessionid', 'test'],
    ['reddit', 'www.reddit.com', 'reddit_session', 'test'],
    ['bybit', 'www.bybit.com', 'isLogin', '1'],
    ['bitget', 'www.bitget.com', 'visitor', 'test'],
  ]) {
    for (const failure of [{ fetchFailure: true }, { apiStatus: 403 }, { apiStatus: 429 }, { jsonFailure: true }]) {
      const h = loginHarness({ url: `https://${host}/`, cookies: [{ name, value, domain: host }], apiResult: { data: { isLogin: false } }, ...failure });
      assert.equal(await h.checkKernelLogin('account', platform), null, `${platform}: ${JSON.stringify(failure)}`);
      assert.equal(h.persisted(), 0);
    }
  }
});

test('missing CDP probe values remain unknown on TikTok and cookie-fallback platforms', async () => {
  for (const [platform, host] of [['tiktok', 'www.tiktok.com'], ['instagram', 'www.instagram.com']]) {
    for (const probeResult of [undefined, null]) {
      const h = loginHarness({ url: `https://${host}/`, cookies: [{ name: 'sessionid', value: 'test', domain: host }], probeResult });
      assert.equal(await h.checkKernelLogin('account', platform), null);
      assert.equal(h.logs.at(-1)[3].reason, 'probe_error');
      assert.equal(h.persisted(), 0);
    }
  }
});

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

test('import and refresh return unknown without replacing account state or identity', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  for (const name of ['matrix:importCookieLogin', 'matrix:refreshIdentity']) {
    const entry = find(sidecar, (node) => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === name);
    const events = [];
    const context = {
      args: [{ accountId: 'account', navUrl: 'https://www.tiktok.com/', homeUrl: 'https://www.tiktok.com/', cookies: [{ name: 'sessionid', value: 'test' }] }], res: {},
      getAccount: () => ({ id: 'account', platform: 'tiktok', status: 'idle', boundUid: 'original' }),
      isFirstBindingRecovery: () => false, forbiddenIdentitySubject: () => undefined,
      isAccountBusy: () => false, accountBadgeLabel: () => '', platformKey: () => 'tiktok',
      launchKernel: async () => {}, closeKernel: () => {}, kernelNavigate: async () => {}, kernelSetCookies: async () => ({ set: 1, failed: 0 }),
      checkKernelLogin: async () => null, kernelReadIdentity: async () => events.push('read identity'),
      setAccountStatus: () => events.push('status'), setAccountIdentity: () => events.push('identity'), broadcastSSE: () => events.push('broadcast'),
      writeJSON: (_res, _status, result) => result, setTimeout: (fn) => fn(),
    };
    context.require = () => context;
    const run = evaluate(`export async function run(){${entry.statements.map((s) => s.getText(sidecar)).join('\n')}}`, context).run;
    const result = await run();
    assert.equal(result.ok, false, name);
    assert.equal(result.loggedIn, null, name);
    assert.match(result.error, /检测未完成/);
    assert.deepEqual(events, [], name);
  }
});

test('manual login and automatic relogin keep polling unknown results without declaring success', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  const entry = find(sidecar, (node) => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'matrix:openLogin');
  const manual = `export async function run(){${entry.statements.map((s) => s.getText(sidecar)).join('\n')}}`;
  const relogin = readFileSync(new URL('../src/main/libs/matrix/reloginPrompt.ts', import.meta.url), 'utf8');
  for (const [source, fn] of [[manual, 'run'], [relogin, 'promptReloginForExpiredAccount']]) {
    let checks = 0, sleeps = 0, closed = false, close;
    const finished = new Promise((resolve) => { close = resolve; });
    const events = [];
    const session = {};
    const context = {
      args: [{ accountId: 'account', loginUrl: 'https://www.tiktok.com/login' }], res: {}, matrixScanWatching: new Set(),
      getAccount: () => ({ id: 'account', platform: 'tiktok' }), isAccountBusy: () => false,
      getSession: () => closed ? null : session, platformKey: () => 'tiktok', accountBadgeLabel: () => '', matrixGroupTitle: () => '',
      launchKernel: async () => {}, kernelNavigate: async () => {}, kernelEnsureUrl: async () => {}, kernelBringToFront: async () => {}, kernelShowExpiredBadge: async () => {},
      closeKernel: () => close(), checkKernelLogin: async () => { checks++; return null; },
      persistKernelCookies: async () => events.push('persist'), kernelReadIdentity: async () => events.push('identity'),
      setAccountStatus: () => events.push('status'), setAccountIdentity: () => events.push('bind'),
      writeJSON: (_res, _status, result) => result, setTimeout: (callback) => { if (++sleeps === 3) closed = true; callback(); },
      broadcastSSE(_event, data) { if (data.scanEnded) close(); },
    };
    context.require = () => context;
    await evaluate(source, context)[fn]('account');
    await finished;
    assert.equal(checks, 2, fn);
    assert.deepEqual(events, [], fn);
  }
});

test('window preparation, ready navigation and occupied-window reuse have distinct IPC outcomes', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  const entry = find(sidecar, node => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'matrix:openWindow');
  const source = `export async function run(){${entry.statements.map(node => node.getText(sidecar)).join('\n')}}`;
  let session, release, starting;
  const setupStarted = new Promise(resolve => { starting = resolve; });
  const setupResult = new Promise(resolve => { release = resolve; });
  let launches = 0, navigations = 0;
  const context = { args: [{ accountId: 'account', url: 'https://www.tiktok.com/login' }], res: {}, matrixOpenWindowPending: new Set(),
    getAccount: () => ({ id: 'account' }), accountBadgeLabel: () => '', getSession: () => session,
    isAccountBusy: () => false, isKernelQuitting: () => false, markUserOwned() {}, kernelBringToFront: async () => {},
    launchKernel: async () => { launches++; session = {}; },
    kernelEnsureUrl: async () => { navigations++; starting(); return setupResult; },
    writeJSON: (_res, _status, result) => result,
  };
  context.require = () => context;
  const { run } = evaluate(source, context);
  const first = run();
  await setupStarted;
  const pending = await run();
  assert.equal(pending.ok, false);
  assert.equal(pending.pending, true);
  release('ready');
  assert.equal((await first).page, 'ready');
  const reused = await run();
  assert.equal(reused.already, true);
  assert.equal(reused.page, 'preserved');
  assert.deepEqual([launches, navigations, context.matrixOpenWindowPending.size], [1, 1, 0]);
});

test('renderer only celebrates the available account from the matching scan', () => {
  const source = readFileSync(new URL('../src/renderer/components/matrix/MatrixView.tsx', import.meta.url), 'utf8');
  const start = source.indexOf('onAccount?.((p: any) => {') + 'onAccount?.('.length;
  const end = source.indexOf('\n    });', start);
  const notices = [], popups = [];
  const scanningRef = { current: new Map([['a', { id: 'current', platform: 'tiktok', displayName: 'fixture' }]]) };
  const { onEvent } = evaluate('export const onEvent = ' + source.slice(start, end) + '};', {
    reload: () => {}, scanningRef, setNotice: message => notices.push(message), setConnectedPopup: item => popups.push(item),
  });
  onEvent({ id: 'a', status: 'idle' });
  onEvent({ id: 'a', scanId: 'older', loginVerified: true, available: true, status: 'idle' });
  assert.equal(popups.length, 0);
  onEvent({ id: 'a', scanId: 'current', loginVerified: true, available: false, status: 'limited', statusReason: 'cooldown' });
  assert.equal(scanningRef.current.has('a'), false);
  assert.equal(notices.at(-1), 'cooldown');
  scanningRef.current.set('a', { id: 'after-expiry', platform: 'tiktok', displayName: 'fixture' });
  onEvent({ id: 'a', scanId: 'after-expiry', loginVerified: true, available: true, status: 'idle' });
  assert.equal(popups.length, 1);
});

test('cookie import reports verified login and the persisted unavailable state separately', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  const entry = find(sidecar, node => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'matrix:importCookieLogin');
  const source = `export async function run(){${entry.statements.map(node => node.getText(sidecar)).join('\n')}}`;
  const events = [];
  const account = { id: 'account', status: 'limited', statusReason: 'cooldown' };
  const context = {
    args: [{ accountId: account.id, cookies: [{ name: 'fixture' }] }], res: {}, getAccount: () => account,
    accountBadgeLabel: () => '', platformKey: () => 'tiktok', isAccountBusy: () => false,
    launchKernel: async () => {}, kernelNavigate: async () => {}, kernelSetCookies: async () => ({ set: 1, failed: 0 }),
    checkKernelLogin: async () => true, kernelReadIdentity: async () => ({ uid: 'confirmed' }),
    findAccountByUid: () => undefined, setAccountIdentity: () => {}, setAccountStatus: () => {}, closeKernel: () => {},
    writeJSON: (_res, _status, result) => result, setTimeout: callback => queueMicrotask(callback),
    broadcastSSE: (_event, value) => events.push(value),
  };
  context.require = () => context;
  const result = await evaluate(source, context).run();
  assert.deepEqual([result.ok, result.loggedIn, result.available, result.account.status], [true, true, false, 'limited']);
  assert.deepEqual([events.at(-1).status, events.at(-1).loginVerified, events.at(-1).available], ['limited', true, false]);
});
