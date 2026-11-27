import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { diagnosticAccountAlias, KernelNavigationError } from './helpers/kernelNavigationHarness.mjs';

function extract(file, names) {
  const source = fs.readFileSync(new URL(`../src/main/libs/matrix/${file}.ts`, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  return ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)
    || ts.isVariableStatement(n) && n.declarationList.declarations.some(d => names.includes(d.name.getText(ast))))
    .map(n => n.getText(ast).replace(/^export /, '')).join('\n');
}

// Real recovery + account transitions + login predicate; only browser transport and disk are replaced.
function harness({ headlessUnknown = false, allUnknown = false, challenge = false, headlessLaunchFails = false, navigationError, failOn = 1 } = {}) {
  const account = { id: 'a', platform: 'tiktok', status: 'limited', lastAliveAt: 1, recovery: { attempts: 4, nextCheckAt: 1, reason: 'login_unknown' } };
  const launches = [], urls = [], logs = [], verdicts = [];
  let mode = 'headless', closed = 0;
  const sessions = new Map();
  let location = new URL('about:blank');
  const node = { getClientRects: () => [{}], getBoundingClientRect: () => ({ width: 200, height: 200 }), getAttribute: () => '/@fixture_self', querySelector: () => null };
  const document = {
    readyState: 'complete', body: { childElementCount: 1, innerText: '' },
    querySelector: selector => selector === '[data-e2e="nav-profile"]' && !allUnknown && !(headlessUnknown && mode === 'headless') ? node : null,
    querySelectorAll: selector => challenge && mode === 'visible' && selector.startsWith('[id*="captcha"') ? [node] : [],
  };
  const ctx = vm.createContext({ URL, Date, sessions, getAccount: () => account, persist() {}, _accountSSEBroadcast: null, diagnosticAccountAlias,
    coworkLog: (...args) => logs.push(args), markLoginRecheck() {}, platformKey: () => 'tiktok', accountBadgeLabel: () => 'fixture',
    sleep: async () => {}, emitAccount() {}, require: () => ({ probeAndSaveHealth: async () => {} }),
    launchKernel: async options => {
      launches.push(options); mode = options.headless ? 'headless' : 'visible';
      if (headlessLaunchFails && options.headless) throw Error('headless unavailable');
      sessions.set('a', { background: options.background });
    },
    closeKernel: () => { closed++; sessions.delete('a'); },
    kernelNavigate: async (_id, url) => { urls.push(url); if (navigationError && urls.length === failOn) throw navigationError; location = new URL(url); },
    getPage: async () => sessions.get('a'),
    send: async () => ({ cookies: [{ name: 'sessionid', value: 'fixture-only', domain: '.tiktok.com' }] }),
    kernelEval: async (_id, expression) => vm.runInNewContext(expression, { document, location, URL, getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) }),
  });
  const code = [extract('automationSafety', ['AUTOMATION_RESTRICTION_EXPR']), extract('recovery', ['recoveryDelay']),
    extract('accountManager', ['setAccountStatus', 'markAccountAlive', 'markAccountRecovery', 'markAccountCooldown']),
    extract('reloginPrompt', ['LOGIN_URL', 'loginUrlFor']),
    extract('kernelPool', ['LOGIN_COOKIES', 'LOGIN_DOMAINS', 'COOKIE_FASTPATH_EXEMPT', 'STRICT_LOGIN_PLATFORMS', 'TIKTOK_SELF_PROFILE_URL', 'checkKernelLoginInner', 'waitForKernel']),
    extract('keepAlive', ['awaitingFirstLogin', 'keepAliveOne'])].join('\n');
  vm.runInContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText, ctx);
  ctx.checkKernelLogin = async (id, platform) => {
    const diagnostic = {};
    const value = await ctx.checkKernelLoginInner(id, platform, diagnostic);
    verdicts.push({ value, reason: diagnostic.reason });
    return value;
  };
  return { ctx, account, launches, urls, logs, verdicts, closed: () => closed };
}

test('real TikTok recovery probes the home page instead of the manual login URL and releases a confirmed account', async () => {
  const h = harness();
  assert.equal(h.ctx.loginUrlFor('tiktok'), 'https://www.tiktok.com/login');
  await h.ctx.keepAliveOne('a');
  assert.deepEqual(h.urls, ['https://www.tiktok.com/']);
  assert.equal(h.account.status, 'idle'); assert.equal(h.account.recovery, undefined);
  assert.deepEqual(h.verdicts, [{ value: true, reason: 'confirmed' }]);
  assert.equal(h.closed(), 1);
});

test('unknown headless login gets one normal-window check with actual positive evidence; permanent unknown stays paused', async () => {
  for (const allUnknown of [false, true]) {
    const h = harness({ headlessUnknown: true, allUnknown });
    await h.ctx.keepAliveOne('a');
    assert.equal(h.launches.length, 2); assert.equal(h.launches[0].headless, true); assert.equal(h.launches[1].headless, undefined);
    assert.ok(h.launches.every(options => options.background)); assert.equal(h.closed(), 2);
    assert.equal(h.verdicts[0].reason, 'positive_marker_missing');
    assert.equal(h.account.status, allUnknown ? 'limited' : 'idle');
    assert.equal(!!h.account.recovery, allUnknown);
    assert.ok(h.logs.some(([, tag, message]) => tag === 'matrix-keepalive' && message.includes('visible background')));
  }
});

test('second-window challenge remains a hard pause; failed headless launch does not duplicate a normal-window check', async () => {
  const challenged = harness({ headlessUnknown: true, challenge: true });
  await challenged.ctx.keepAliveOne('a');
  assert.equal(challenged.verdicts.length, 1);
  assert.equal(challenged.account.status, 'limited'); assert.match(challenged.account.statusReason, /captcha/);
  assert.equal(challenged.account.recovery, undefined); assert.equal(challenged.closed(), 2);
  const visibleOnly = harness({ headlessLaunchFails: true, allUnknown: true });
  await visibleOnly.ctx.keepAliveOne('a');
  assert.equal(visibleOnly.launches.length, 2); assert.equal(visibleOnly.verdicts.length, 1); assert.equal(visibleOnly.closed(), 1);
  assert.equal(visibleOnly.account.status, 'limited'); assert.ok(visibleOnly.account.recovery);
});

test('keep-alive preserves 403/407 and 429 from either browser and only schedules recovery for a technical failure', async () => {
  const until = Date.now() + 3600_000;
  for (const failOn of [1, 2]) {
    for (const code of ['http_403', 'http_407', 'http_429', 'tunnel']) {
      const h = harness({ headlessUnknown: true, navigationError: new KernelNavigationError(code, until), failOn });
      await h.ctx.keepAliveOne('a');
      assert.equal(h.verdicts.length, failOn - 1);
      assert.equal(h.urls.length, failOn);
      assert.equal(h.closed(), failOn);
      assert.equal(h.account.status, 'limited');
      if (code === 'http_429') {
        assert.equal(h.account.recovery?.reason, 'rate_limited');
        assert.equal(h.account.recovery?.nextCheckAt, until);
      } else if (code === 'tunnel') {
        assert.equal(h.account.recovery?.reason, 'network_error:navigation:tunnel');
      } else {
        assert.equal(h.account.recovery, undefined);
        assert.match(h.account.statusReason, new RegExp(code.slice(-3)));
      }
    }
  }
});
