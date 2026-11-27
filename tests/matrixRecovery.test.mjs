import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const read = name => fs.readFileSync(new URL(`../src/main/libs/matrix/${name}.ts`, import.meta.url), 'utf8');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function functions(file, names) {
  const ast = ts.createSourceFile(file, read(file), ts.ScriptTarget.Latest, true);
  return ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(ast).replace(/^export /, '')).join('\n');
}

test('recovery budgets are bounded and platform/billing restrictions never become transport retries', () => {
  const ctx = vm.createContext({});
  vm.runInContext(compile(functions('recovery', ['recoveryDelay', 'isRecoverableFailure'])), ctx);
  assert.deepEqual([1, 2, 3, 4, 50].map(ctx.recoveryDelay), [60000, 300000, 900000, 3600000, 3600000]);
  for (const reason of ['login_unknown', 'ECONNRESET', 'network_error:scenario_unavailable', 'CDP timeout']) assert.equal(ctx.isRecoverableFailure(reason), true);
  for (const reason of ['HTTP403 timeout', 'HTTP429', 'captcha', 'charge_uncertain', 'account_flag', 'unknown_script_error']) assert.equal(ctx.isRecoverableFailure(reason), false);
});

test('recovery sweep only visits due technical holds; allows exit changes but never visits billing or platform holds', async () => {
  const now = Date.now(), visited = [];
  const accounts = [
    { id: 'due', lastAliveAt: 1, status: 'limited', recovery: { nextCheckAt: now - 1000 } },
    { id: 'future', lastAliveAt: 1, status: 'limited', recovery: { nextCheckAt: now + 100000 } },
    { id: 'platform', lastAliveAt: 1, status: 'limited' },
    { id: 'billing', lastAliveAt: 1, status: 'limited', recovery: { nextCheckAt: 1 }, chargeUncertain: {} },
    { id: 'egress', lastAliveAt: 1, status: 'limited', recovery: { nextCheckAt: 1 }, egress: { changedAt: 1 } },
    { id: 'manual', lastAliveAt: 1, status: 'limited', recovery: { nextCheckAt: 1 }, manualDisconnect: true },
  ];
  const ctx = vm.createContext({ Date, listAccounts: () => accounts, getAccount: id => accounts.find(a => a.id === id),
    getSession: () => undefined, keepAliveOne: async id => visited.push(id), sleep: async () => {},
    ALIVE_THRESHOLD_MS: 86400000, RECHECK_MIN_INTERVAL_MS: 86400000 });
  vm.runInContext(compile(`let sweeping = false; ${functions('keepAlive', ['awaitingFirstLogin', 'runKeepAliveSweep'])}`), ctx);
  await ctx.runKeepAliveSweep();
  assert.deepEqual(visited, ['due', 'egress']);
});

test('read-only recovery checks restrictions before accepting a surviving login cookie', async () => {
  for (const restriction of ['captcha', 'login_wall', 'forbidden', 'rate_limited', 'account_flag', '']) {
    const account = { id: 'a', lastAliveAt: 1, platform: 'tiktok', status: 'limited', recovery: { nextCheckAt: 1 } };
    const changes = [];
    let loginChecks = 0, closed = 0;
    const ctx = vm.createContext({ coworkLog() {}, getAccount: () => account, platformKey: () => 'tiktok', loginUrlFor: () => 'https://www.tiktok.com/',
      accountBadgeLabel: () => 'a', markLoginRecheck() {}, launchKernel: async () => {}, kernelNavigate: async () => {},
      kernelEval: async () => restriction, AUTOMATION_RESTRICTION_EXPR: 'read-only', sleep: async () => {},
      checkKernelLogin: async () => { loginChecks++; return true; }, closeKernel: () => { closed++; },
      setAccountStatus: (_id, state, reason) => changes.push([state, reason]), markAccountRecovery: () => changes.push(['recovery']),
      markAccountAlive: () => changes.push(['alive']), emitAccount() {}, require: () => ({ probeAndSaveHealth: async () => {} }) });
    vm.runInContext(compile(functions('keepAlive', ['awaitingFirstLogin', 'keepAliveOne'])), ctx);
    await ctx.keepAliveOne('a');
    assert.equal(closed, 1);
    assert.equal(loginChecks, restriction ? 0 : 1);
    assert.equal(changes[0][0], restriction ? 'limited' : 'alive');
  }
});

test('recovery rechecks the new visible page after a headless retry', async () => {
  for (const second of ['captcha', 'page_error:ERR_CONNECTION_RESET']) {
    let reads = 0, checks = 0, alive = 0, launches = 0;
    const changes = [];
    const account = { id: 'a', lastAliveAt: 1, platform: 'instagram', status: 'limited', recovery: { nextCheckAt: 1 } };
    const ctx = vm.createContext({ coworkLog() {}, getAccount: () => account, platformKey: () => 'instagram', loginUrlFor: () => 'https://www.instagram.com/',
      accountBadgeLabel: () => 'a', launchKernel: async () => { launches++; }, kernelNavigate: async () => {}, sleep: async () => {}, closeKernel() {},
      kernelEval: async () => { reads++; return launches === 1 ? '' : second; }, AUTOMATION_RESTRICTION_EXPR: 'read-only',
      checkKernelLogin: async () => ++checks === 1 ? false : true,
      setAccountStatus: (_id, status) => changes.push(status), markAccountRecovery: () => changes.push('recovery'),
      markAccountAlive: () => { alive++; }, emitAccount() {} });
    vm.runInContext(compile(functions('keepAlive', ['awaitingFirstLogin', 'keepAliveOne'])), ctx);
    await ctx.keepAliveOne('a');
    assert.equal(checks, 1); assert.equal(reads, 3); assert.equal(alive, 0);
    assert.deepEqual(changes, [second === 'captcha' ? 'limited' : 'recovery']);
  }
});
