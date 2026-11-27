import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';
import ts from 'typescript';

const read = (file) => readFileSync(new URL(file, import.meta.url), 'utf8');
const parse = (file) => ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
const kernel = parse('../src/main/libs/matrix/kernelPool.ts');
const identityNames = new Set(['TIKTOK_SELF_PROFILE_URL', 'IDENTITY_EXPR', 'UID_COOKIE', 'IDENTITY_SELF_URL', 'IDENTITY_NAV_HINT']);
const identitySource = kernel.statements.filter((node) =>
  ts.isVariableStatement(node) && node.declarationList.declarations.some((d) => identityNames.has(d.name.getText(kernel)))
  || ts.isFunctionDeclaration(node) && node.name?.text === 'kernelReadIdentity',
).map((node) => node.getText(kernel)).join('\n');

function evaluate(source, context = {}) {
  const module = { exports: {} };
  const globals = { URL, module, exports: module.exports, diagnosticAccountAlias, ...context };
  const compiled = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2020, module: ts.ModuleKind.CommonJS } });
  runInNewContext(compiled.outputText, globals);
  return module.exports;
}

function identityPage({ href = 'https://www.tiktok.com/@self', nav = '/@self', subtitle = 'self', author = '/@another', navigateFails = false } = {}) {
  let location = new URL(href);
  const navigations = [];
  const link = (value) => ({ getAttribute: () => value, querySelector: () => null });
  const document = { querySelector: (selector) => ({
    '[data-e2e="nav-profile"]': nav ? link(nav) : null,
    'a[href^="/@"]': link(author),
    '[data-e2e="user-title"]': { textContent: 'Profile name' },
    '[data-e2e="user-subtitle"]': subtitle == null ? null : { textContent: subtitle },
    '[data-e2e="user-avatar"] img': { src: 'https://example.invalid/avatar.png' },
  })[selector] || null };
  const pageEval = (expr) => runInNewContext(expr, { document, location, URL });
  const api = evaluate(`${identitySource}\nmodule.exports = { kernelReadIdentity, expr: IDENTITY_EXPR.tiktok, hint: IDENTITY_NAV_HINT.tiktok };`, {
    getAccount: () => undefined,
    getPage: async () => ({}), kernelEval: async (_id, expr) => pageEval(expr),
    kernelNavigate: async (_id, url) => { navigations.push(url); if (navigateFails) throw Error('navigation failed'); location = new URL(url); },
    sleep: async () => {}, coworkLog: () => {},
  });
  return { ...api, pageEval, navigations };
}

test('TikTok identity requires the self navigation, matching URL and matching profile handle', async () => {
  const good = identityPage({ nav: 'https://www.tiktok.com/@self/?lang=en', subtitle: '@self' });
  assert.equal(good.pageEval(good.hint), 'https://www.tiktok.com/@self');
  assert.equal((await good.kernelReadIdentity('account', 'tiktok')).uid, 'self');
  for (const options of [
    { nav: null, href: 'https://www.tiktok.com/@another', subtitle: 'another' },
    { nav: 'https://example.invalid/@self' },
    { nav: 'http://www.tiktok.com/@self' },
    { nav: '/@self/video/123' },
    { subtitle: 'another' },
    { subtitle: null },
    { href: 'https://www.tiktok.com/@another', subtitle: 'another', navigateFails: true },
  ]) {
    const page = identityPage(options);
    assert.equal(JSON.stringify(await page.kernelReadIdentity('account', 'tiktok')), '{}', JSON.stringify(options));
    if (options.nav === null) assert.equal(page.navigations.length, 0, 'must not navigate to a feed author');
  }
  const other = identityPage({ href: 'https://www.tiktok.com/@another', subtitle: 'another' });
  assert.equal(other.pageEval(other.expr), '{}', 'another profile is never the signed-in user');
});

test('an uncertain identity preserves the existing account identity', () => {
  const file = parse('../src/main/libs/matrix/accountManager.ts');
  const fn = file.statements.filter((node) => ts.isFunctionDeclaration(node)
    && ['setAccountIdentity', 'writeIdentityFields', 'forbiddenIdentityMismatch', 'forbiddenIdentitySubject', 'accountSubject'].includes(node.name?.text))
    .map(node => node.getText(file)).join('\n');
  const account = { nickname: 'Original', displayId: '@original', boundUid: 'original', avatar: 'original.png' };
  const before = { ...account };
  const api = evaluate(fn, { getAccount: () => account, persist: () => {}, persistIdentityChange: (change) => change() });
  api.setAccountIdentity('account', {});
  assert.deepEqual(account, before);
});

function find(node, predicate) {
  if (predicate(node)) return node;
  return ts.forEachChild(node, (child) => find(child, predicate));
}

test('all duplicate-identity entry points reject binding without deleting browser cookies', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  const relogin = parse('../src/main/libs/matrix/reloginPrompt.ts');
  const branches = ['matrix:openLogin', 'matrix:importCookieLogin', 'matrix:refreshIdentity'].map((name) => {
    const entry = find(sidecar, (node) => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === name);
    assert.ok(entry, name);
    return [name, find(entry, (node) => ts.isIfStatement(node) && node.expression.getText(sidecar) === 'dup'), sidecar];
  });
  branches.push(['automatic relogin', find(relogin, (node) => ts.isIfStatement(node) && node.expression.getText(relogin) === 'dup'), relogin]);
  for (const [name, branch, file] of branches) {
    assert.ok(branch, name);
    const events = [];
    const context = {
      acc: { id: 'account' }, dup: { displayName: 'Existing account' }, res: {},
      scanId: 'fixture-scan', getAccount: () => ({ status: 'login_required' }),
      kernelClearCookies: async () => events.push('clear'),
      setAccountStatus: (_id, status) => events.push(status), setStat: (_id, status) => events.push(status),
      markAccountBindingConflict: () => events.push('login_required'),
      setAccountIdentity: () => events.push('bind'),
      broadcastSSE: (_event, data) => events.push(data.error), emitAccount: (data) => events.push(data.error),
      writeJSON: (_res, _status, value) => value,
    };
    context.emitScan = context.emit = context.emitAccount;
    context.require = () => context;
    const run = evaluate(`export async function run(){for(let once=0;once<1;once++){${branch.getText(file)}}}`, context).run;
    await run();
    assert.ok(events.includes('login_required'), name);
    assert.ok(events.some((event) => event.includes('Existing account')), name);
    assert.ok(!events.includes('clear'), `${name} must preserve cookies`);
    assert.ok(!events.includes('bind'), `${name} must reject duplicate binding`);
  }
});

test('duplicate binding survives keepalive and blocks automatic launches until a unique identity is confirmed', async () => {
  const manager = parse('../src/main/libs/matrix/accountManager.ts');
  const keepalive = parse('../src/main/libs/matrix/keepAlive.ts');
  const functions = (file, names) => file.statements.filter((node) => ts.isFunctionDeclaration(node) && names.includes(node.name?.text)).map((node) => node.getText(file)).join('\n');
  const account = { id: 'account', platform: 'tiktok', status: 'idle', boundUid: 'old', lastAliveAt: 1 };
  let starts = 0;
  const context = {
    getAccount: () => account, persist: () => {}, persistIdentityChange: (change) => change(), platformKey: (a) => a.platform,
    findAccountByUid: (_platform, uid) => uid === 'duplicate' ? { id: 'other' } : undefined,
    _accountSSEBroadcast: null, coworkLog: () => {},
    loginUrlFor: () => 'https://www.tiktok.com/', markLoginRecheck: () => {}, accountBadgeLabel: () => '',
    sleep: async () => {}, emitAccount: () => {}, closeKernel: () => {},
    sessions: new Map(), refCount: new Map(), launching: new Map(),
    acquireLease: async () => {}, releaseLease: () => {}, getLocalEgressIp: () => null,
    automationSafety: { begin: () => {}, before: async () => {}, end: () => {}, signal: () => undefined },
    AbortSignal,
    AutomationSafetyError: class extends Error {},
    safetyLog: () => {}, enableAutomationNetwork: async () => {},
    doLaunch: async () => { starts++; return {}; },
    verifyKernelEgress: async () => {},
  };
  const source = [
    functions(manager, ['setAccountStatus', 'setAccountIdentity', 'writeIdentityFields', 'forbiddenIdentityMismatch', 'forbiddenIdentitySubject', 'accountSubject', 'markAccountBindingConflict', 'markAccountAlive']),
    functions(kernel, ['launchKernel', 'kernelSignal', 'waitForKernel', 'bindKernelSignal']), functions(keepalive, ['awaitingFirstLogin', 'keepAliveOne']),
    'module.exports = { setAccountIdentity, markAccountBindingConflict, markAccountAlive, keepAliveOne, launchKernel };',
  ].join('\n');
  const api = evaluate(source, context);
  api.markAccountBindingConflict('account');
  api.markAccountAlive('account');
  await api.keepAliveOne('account');
  assert.equal(account.bindingConflict, true);
  assert.equal(account.status, 'login_required');
  assert.equal(account.lastAliveAt, 1);
  assert.equal(starts, 0);
  await assert.rejects(api.launchKernel({ accountId: 'account' }), /身份重复/);
  await api.launchKernel({ accountId: 'account', manual: true });
  assert.equal(starts, 1, 'manual refresh remains available');
  api.setAccountIdentity('account', {});
  assert.equal(account.bindingConflict, true);
  api.setAccountIdentity('account', { boundUid: 'duplicate' });
  assert.equal(account.bindingConflict, true);
  api.setAccountIdentity('account', { boundUid: 'unique' });
  assert.equal(account.bindingConflict, undefined);
  await api.launchKernel({ accountId: 'account' });
  assert.equal(starts, 2, 'automation resumes only after a unique identity is confirmed');
});

test('explicit disconnect still clears browser cookies and account identity', async () => {
  const sidecar = parse('../src/main/sidecar-server.ts');
  const manager = parse('../src/main/libs/matrix/accountManager.ts');
  const entry = find(sidecar, (node) => ts.isCaseClause(node) && ts.isStringLiteral(node.expression) && node.expression.text === 'matrix:disconnectAccount');
  const account = { id: 'account', status: 'idle', boundUid: 'identity', nickname: 'fixture' };
  const events = [], emitted = [];
  const context = {
    args: [{ accountId: 'account' }], res: {}, getAccount: () => account,
    isAccountBusy: () => false, accountBadgeLabel: () => 'Account', launchKernel: async () => {}, closeKernel: () => {},
    kernelClearCookies: async () => events.push('clear cookies'),
    persistIdentityChange(change) { if (change()) events.push(structuredClone(account)); },
    broadcastSSE: (_name, detail) => emitted.push(detail), writeJSON: (_res, _status, value) => value,
  };
  const accountFunctions = manager.statements.filter(node => ts.isFunctionDeclaration(node) && ['markManualDisconnect', 'clearAccountIdentity', 'forbiddenIdentitySubject', 'accountSubject'].includes(node.name?.text));
  Object.assign(context, evaluate(accountFunctions.map(node => node.getText(manager)).join('\n'), context));
  context.require = () => context;
  const run = evaluate(`export async function run(){${entry.statements.map((s) => s.getText(sidecar)).join('\n')}}`, context).run;
  assert.equal((await run()).ok, true);
  assert.equal(events[0], 'clear cookies');
  const saved = events[1];
  assert.equal(saved.status, 'login_required');
  assert.equal(saved.manualDisconnect, true);
  assert.equal(saved.boundUid, undefined);
  assert.equal(saved.nickname, undefined);
  assert.equal(emitted.at(-1).status, saved.status);
});
