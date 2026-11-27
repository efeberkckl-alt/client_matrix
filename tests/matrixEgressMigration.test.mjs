import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import test from 'node:test';

const { build } = await import('esbuild');
const { createRequire } = await import('node:module');
const require = createRequire(import.meta.url);
const { fileURLToPath } = await import('node:url');
const sourceDir = fileURLToPath(new URL('../src/main/libs/matrix/', import.meta.url));
const code = (await build({ stdin: { contents: "export * from './accountManager';", resolveDir: sourceDir },
  bundle: true, platform: 'node', format: 'cjs', write: false,
  plugins: [{ name: 'isolate', setup(b) {
    b.onResolve({ filter: /coworkLogger|taskStore/ }, ({ path }) => ({ path, namespace: 'offline' }));
    b.onLoad({ filter: /.*/, namespace: 'offline' }, () => ({ contents: 'export const coworkLog=()=>{}; export const pruneAccountFromTasks=()=>{};' }));
  } }],
})).outputFiles[0].text;

test('upgrade removes persisted exit-only holds once and preserves proxy, login, billing and platform restrictions', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-egress-migration-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'accounts.json');
  const networkReason = 'network_changed:出口变化，请确认网络后恢复';
  const legacy = (id, extra = {}) => ({ id, status: 'limited', statusReason: networkReason,
    proxy: { host: 'proxy.invalid', protocol: 'socks5', port: 1080, username: 'fixture', password: 'fixture' },
    userDataDir: 'unchanged-profile', egress: { baselineIp: '192.0.2.1', baselineAt: 1, ip: '192.0.2.2', changedAt: 2 }, ...extra });
  const input = [
    legacy('exit'),
    legacy('probe', { statusReason: '等待自动复查', recovery: { reason: 'network_error:未能确认当前出口，等待网络复查' } }),
    legacy('billing', { chargeUncertain: { action: 'comment', holdReason: networkReason } }),
    legacy('captcha', { egress: { changedAt: 2, holdReason: 'captcha' } }),
    legacy('conflict', { bindingConflict: true }),
    legacy('disconnected', { manualDisconnect: true }),
    legacy('banned', { status: 'banned', statusReason: 'forbidden' }),
    legacy('other-network', { statusReason: 'proxy_connection_failed' }),
    legacy('layered', { chargeUncertain: { action: 'comment', holdReason: networkReason }, egress: { changedAt: 2, holdReason: 'HTTP 403' } }),
  ];
  fs.writeFileSync(file, JSON.stringify(input));
  const load = () => {
    const module = { exports: {} };
    const env = { NOOBCLAW_MATRIX_DIR: dir };
    vm.runInNewContext(code, { require, module, exports: module.exports,
      process: { env, pid: process.pid, kill: process.kill }, Buffer, URL, console });
    return module.exports.loadAccounts();
  };
  load();
  const result = JSON.parse(fs.readFileSync(file, 'utf8')).accounts;
  assert.equal(result[0].status, 'idle');
  assert.equal(result[1].status, 'idle');
  assert.equal(result[1].recovery, undefined);
  assert.equal(result[2].status, 'limited');
  assert.ok(result[2].chargeUncertain);
  assert.equal(result[2].chargeUncertain.holdReason, undefined);
  assert.equal(result[3].statusReason, 'captcha');
  assert.equal(result[3].status, 'limited');
  assert.equal(result[4].status, 'login_required');
  assert.equal(result[5].status, 'login_required');
  assert.equal(result[5].manualDisconnect, true);
  assert.equal(result[6].status, 'banned');
  assert.equal(result[6].statusReason, 'forbidden');
  assert.equal(result[7].statusReason, 'proxy_connection_failed');
  assert.equal(result[8].chargeUncertain.holdReason, 'HTTP 403');
  for (let i = 0; i < result.length; i++) {
    assert.deepEqual(result[i].proxy, input[i].proxy);
    assert.equal(result[i].userDataDir, input[i].userDataDir);
    assert.equal(result[i].egress.changedAt, undefined);
  }
  const beforeReload = fs.readFileSync(file, 'utf8');
  load();
  assert.equal(fs.readFileSync(file, 'utf8'), beforeReload);
});
