import assert from 'node:assert/strict';
import fs from 'node:fs';
import net from 'node:net';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/accountManager.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('accountManager.ts', source, ts.ScriptTarget.Latest, true);
const names = ['setAccountStatus', 'markAccountChargeUncertain', 'resolveAccountChargeUncertain',
  'markAccountAlive', 'recordAccountEgress', 'normalizeEgressIp', 'sameProxyRoute', 'validExitObservationTime'];
const code = ts.transpileModule(ast.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text))
  .map(n => n.getText(ast).replace(/^export /, '')).join('\n'), { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
const permutations = values => values.length ? values.flatMap((value, index) => permutations(values.filter((_, i) => i !== index)).map(rest => [value, ...rest])) : [[]];

for (const order of permutations(['hard', 'billing', 'network'])) {
  test(`403 survives ${order.join(' -> ')}`, () => {
    const account = { id: 'a', status: 'idle' };
    const ctx = vm.createContext({ getAccount: () => account, net, URL, persist() {}, coworkLog() {}, setLocalEgressIp() {}, _accountSSEBroadcast: null, diagnosticAccountAlias });
    vm.runInContext(code, ctx);
    ctx.recordAccountEgress('a', '192.0.2.1', Date.now());
    const events = {
      hard: () => ctx.setAccountStatus('a', 'limited', 'HTTP 403:平台拒绝访问'),
      billing: () => ctx.markAccountChargeUncertain('a', { action: 'comment', platform: 'tiktok', at: Date.now() }),
      network: () => ctx.recordAccountEgress('a', '192.0.2.2', Date.now()),
    };
    for (const event of order) events[event]();
    ctx.resolveAccountChargeUncertain('a');
    ctx.markAccountAlive('a');
    assert.equal(account.status, 'limited');
    assert.match(account.statusReason, /403/);
    assert.equal(account.recovery, undefined);
  });
}

