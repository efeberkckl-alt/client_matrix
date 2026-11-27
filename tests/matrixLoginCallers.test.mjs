import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { transformSync } from 'esbuild';

test('every task preflight stops on unknown, preserves credentials and only marks known logins alive', async () => {
  for (const file of ['binancePostRunner', 'binanceRepostRunner', 'engageRunner', 'folderPostRunner', 'imageTextRunner', 'tweetPostRunner', 'viralRewriteRunner']) {
    const source = fs.readFileSync(new URL(`../src/main/libs/matrix/${file}.ts`, import.meta.url), 'utf8');
    const starts = Array.from(source.matchAll(/let loggedIn: boolean \| null = null;/g));
    assert.ok(starts.length, file);
    for (const match of starts) {
      const end = source.indexOf('markAccountAlive(', match.index);
      assert.ok(end > match.index);
      const block = source.slice(match.index, source.indexOf(';', end) + 1);
      const code = transformSync(`async function run() { ${block}; return { verified: true }; }`, { loader: 'ts' }).code;
      for (const login of [null, true, false, 'throw']) {
        const status = [], alive = [], relogin = [];
        const runtime = vm.createContext({
          checkKernelLogin: async () => { if (login === 'throw') throw new Error('CDP disconnected'); return login; },
          getSession: () => ({}), kernelReceipt: {}, isKernelLeaseCurrent: () => true,
          kernelEval: async () => '', AUTOMATION_RESTRICTION_EXPR: 'read-only probe',
          setAccountStatus: (...args) => status.push(args), markAccountAlive: id => alive.push(id),
          promptReloginForExpiredAccount: async id => relogin.push(id), abortableSleep: async () => {},
          accountId: 'account', srcAccId: 'source', acc: { platform: 'tiktok' }, loginKey: 'tiktok',
          platformKey: () => 'tiktok', log() {}, opts: { platform: 'tiktok' }, workSignal: undefined,
          protection: undefined, loginSignal: undefined,
          finishRun: (state, reason) => ({ state, reason }),
          PLATFORM_LABEL: {}, platLabel: () => 'TikTok', ready: [], ledgerMark() {},
        });
        vm.runInContext(code, runtime);
        const result = await runtime.run();
        if (login === true) {
          assert.equal(result.verified, true, file);
          assert.equal(alive.length, 1, file);
        } else {
          assert.equal(alive.length, 0, file);
          if (status.length) assert.equal(status.at(-1)[1], login === false ? 'login_required' : 'limited', file);
          else assert.equal(file, 'engageRunner'); // Its finishRun owns recovery state; covered by matrixTaskOutcome.
          assert.equal(relogin.length, login === false ? 1 : 0, file);
          assert.match(result.reason, login === false ? /login_expired/ : /login_unknown/, file);
        }
      }
    }
  }
});
