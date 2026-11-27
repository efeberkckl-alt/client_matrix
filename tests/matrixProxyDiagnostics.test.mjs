import assert from 'node:assert/strict';
import { virtualSafetyFs } from './helpers/virtualSafetyFs.mjs';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import { diagnosticAccountAlias } from './helpers/kernelNavigationHarness.mjs';

const compile = async (name) => (await transform(fs.readFileSync(new URL(`../src/main/libs/matrix/${name}.ts`, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })).code;
const accountCode = await compile('accountManager');
const localeCode = (await transform(fs.readFileSync(new URL('../src/types/matrixFingerprintLocale.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })).code;
const firstBindingCode = (await transform(fs.readFileSync(new URL('../src/types/matrixAccountRecovery.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })).code;
const safetyCode = await compile('automationSafety');
const proxyCode = await compile('proxyBridge');
const protectionCode = await compile('accountProtection');
const profileCode = await compile('profileIdentity');
const recoveryCode = await compile('recovery');
const proxy = { protocol: 'http', host: 'gateway.test', port: 8080, username: 'test', password: 'test' };

function harness() {
  let now = 1000;
  const files = new Map([[path.join('/virtual', 'accounts.json'), JSON.stringify([
    { id: 'a', platform: 'tiktok', proxy: { ...proxy } },
    { id: 'b', platform: 'tiktok', proxy: { ...proxy, username: 'other' } },
    { id: 'c', platform: 'tiktok', proxy: { ...proxy, host: 'other.test' } },
  ])]]);
  const memoryFs = virtualSafetyFs(files);
  const clock = class extends Date { static now() { return now; } };
  const load = (code, dependencies, extra = {}) => {
    const module = { exports: {} };
    runInNewContext(code, { module, exports: module.exports, Date: clock, URL, Buffer,
      require: (id) => { assert.ok(id in dependencies, `unexpected dependency ${id}`); return dependencies[id]; },
      setTimeout: (fn, ms) => setTimeout(fn, ms).unref(), clearTimeout, ...extra });
    return module.exports;
  };
  const accounts = load(accountCode, { fs: memoryFs, path, os: { homedir: () => '/unused' }, net,
    '../coworkLogger': { coworkLog() {} }, './taskStore': { pruneAccountFromTasks() {} },
    './accountProtection': load(protectionCode, { crypto }), './profileIdentity': load(profileCode, { fs: memoryFs, path }), crypto,
    './recovery': load(recoveryCode, {}), '../../../types/matrixFingerprintLocale': load(localeCode, {}), './kernelNavigation': { diagnosticAccountAlias },
    '../../../types/matrixAccountRecovery': load(firstBindingCode, {}),
    './automationSafety': load(safetyCode, { fs: memoryFs, path, crypto, os: { homedir: () => '/unused' } },
      { process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: '/virtual' } } }),
  }, { process: { pid: process.pid, kill: process.kill, env: { NOOBCLAW_MATRIX_DIR: '/virtual' } } });
  const calls = [];
  const state = { status: 200, ip: '203.0.113.7', beforeResponse: undefined };
  const connect = (encrypted, options) => {
    const socket = new EventEmitter();
    let secure = false;
    socket.destroy = () => {};
    socket.write = (request) => {
      if (encrypted) assert.ok(secure, 'HTTPS credentials must wait for the TLS handshake');
      calls.push({ encrypted, options, request });
      queueMicrotask(() => {
        state.beforeResponse?.();
        socket.emit('data', Buffer.from(request.startsWith('CONNECT')
          ? `HTTP/1.1 ${state.status} Test\r\n\r\n`
          : `HTTP/1.1 200 OK\r\n\r\n${JSON.stringify({ status: 'success', query: state.ip, countryCode: 'ZZ' })}`));
        if (!request.startsWith('CONNECT')) socket.emit('end');
      });
    };
    queueMicrotask(() => { socket.emit('connect'); if (encrypted) { secure = true; socket.emit('secureConnect'); } });
    return socket;
  };
  const api = load(proxyCode, {
    net: { isIP: net.isIP, connect: (port, host) => connect(false, { port, host }) },
    tls: { connect: (options) => connect(true, options) },
    dns: { promises: { lookup: async () => { throw new Error('DNS not permitted'); } } },
    http: { get: () => assert.fail('no live HTTP fallback') },
    socks: { SocksClient: { createConnection: async () => { throw new Error('SOCKS rejected'); } } },
    '../coworkLogger': { coworkLog() {} }, './accountManager': accounts,
  }, { process: { pid: process.pid, kill: process.kill, env: {} }, AbortController,
    fetch: async () => ({ json: async () => ({ ok: true, ip: '192.0.2.99', countryCode: 'ZZ' }) }),
  });
  return { accounts, api, calls, files, state, advance: () => { now += 1000; } };
}

test('health timestamps and observed exits persist; gateway names never prove a shared exit', async () => {
  const h = harness();
  assert.equal(h.accounts.proxyBadgeInfo('b').duplicate, false);
  assert.match(h.accounts.proxyBadgeInfo('b').text, /代理入口/);
  assert.equal(await h.api.probeAndSaveHealth(h.accounts.getAccount('a')), 'ok');
  const observed = h.accounts.getAccount('a').proxy;
  assert.equal(observed.healthCheckedAt, 1000);
  assert.equal(observed.exitIp, '203.0.113.7');
  assert.equal(observed.exitIpObservedAt, 1000);
  assert.equal(h.accounts.proxyBadgeInfo('b').duplicate, false);
  h.accounts.setProxyHealth('c', 'ok', { ip: observed.exitIp, observedAt: 1000 });
  assert.equal(h.accounts.proxyBadgeInfo('c').duplicate, true, 'different gateways can share an observed exit');
  assert.match(h.accounts.proxyBadgeInfo('c').text, /最近观测出口/);
  h.advance();
  h.accounts.setProxyHealth('a', 'ok');
  assert.equal(observed.healthCheckedAt, 2000, 'unchanged health still refreshes its timestamp');
  const saved = JSON.parse(h.files.get(path.join('/virtual', 'accounts.json'))).accounts;
  assert.equal(saved[0].proxy.exitIpObservedAt, 1000);
  assert.equal(saved[0].proxy.healthCheckedAt, 2000);
  h.accounts.setAccountProxy('a', { ...observed, username: 'new-session' });
  assert.equal(h.accounts.getAccount('a').proxy.exitIp, undefined);
  assert.equal(h.accounts.getAccount('a').proxy.healthCheckedAt, undefined);
  assert.match(h.accounts.proxyBadgeInfo('a').text, /代理入口/);
  h.accounts.setProxyHealth('b', 'ok', { ip: 'gateway.test', observedAt: 2000 });
  assert.equal(h.accounts.getAccount('b').proxy.exitIp, undefined);
  h.accounts.setProxyHealth('a', 'ok', { ip: '2001:db8::1', observedAt: 2000 });
  h.accounts.setProxyHealth('b', 'ok', { ip: '2001:0db8:0:0:0:0:0:1', observedAt: 2000 });
  assert.equal(h.accounts.proxyBadgeInfo('b').duplicate, true, 'equivalent IPv6 spellings match');
  h.accounts.setProxyHealth('b', 'ok', { ip: 'fe80::1%eth0', observedAt: 2000 });
  assert.equal(h.accounts.getAccount('b').proxy.exitIp, '2001:db8::1', 'invalid scoped addresses never replace the last real observation');
});

test('HTTPS probes and geo requests use verified TLS; HTTP stays plain; host geo is never an exit observation', async () => {
  const h = harness();
  const secure = { ...proxy, protocol: 'https' };
  assert.equal(await h.api.probeProxy(secure), true);
  const geo = await h.api.fetchProxyExitGeo(secure);
  assert.equal(geo.ip, '203.0.113.7');
  assert.equal(geo.observedAt, 1000);
  assert.equal(h.calls.length, 2);
  for (const call of h.calls) {
    assert.equal(call.encrypted, true);
    assert.equal(call.options.servername, 'gateway.test');
    assert.notEqual(call.options.rejectUnauthorized, false);
  }
  assert.equal(await h.api.probeProxy(proxy), true);
  assert.equal(h.calls.at(-1).encrypted, false);
  const result = await h.api.probeProxyDetailed(secure);
  assert.equal(result.healthCheckedAt, 1000);
  assert.equal(result.geo.observedAt, 1000);
  h.state.status = 407;
  const failed = await h.api.probeProxyDetailed(secure);
  assert.equal(failed.ok, false);
  assert.equal(failed.geo, undefined);
  assert.equal(failed.hostGeo.ip, '192.0.2.99');
  assert.equal(failed.hostGeo.observedAt, undefined);
  assert.equal(await h.api.probeAndSaveHealth(h.accounts.getAccount('b')), 'dead');
  assert.equal(h.accounts.getAccount('b').proxy.exitIp, undefined);
});

test('a probe finishing after credentials change cannot overwrite the replacement proxy', async () => {
  const h = harness();
  const account = h.accounts.getAccount('a');
  h.state.beforeResponse = () => {
    h.state.beforeResponse = undefined;
    h.accounts.setAccountProxy('a', { ...proxy, password: 'replacement' });
  };
  await h.api.probeAndSaveHealth(account);
  assert.equal(account.proxy.healthCheckedAt, undefined);
  assert.equal(account.proxy.exitIp, undefined);
});
