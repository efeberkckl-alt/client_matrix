import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';

const require = createRequire(import.meta.url);
const read = (file) => fs.readFileSync(new URL(file, import.meta.url), 'utf8');
const frontend = await transform(read('../src/renderer/hooks/useKernelStatus.ts'), { loader: 'ts', format: 'cjs' });
const backend = await transform(read('../src/main/libs/matrix/kernelInstaller.ts'), { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(frontend.code, { module, exports: module.exports, require, setTimeout: (fn) => setTimeout(fn, 0), clearTimeout });
const { loadKernelStatus, mergeKernelStatus } = module.exports;
const local = { ok: true, local: true, installed: true, installedVersion: '142', installedVersions: ['142'], selectedVersion: '142' };
const full = { ...local, local: false, available: [{ version: '143', installed: false, label: 'Chrome v143' }] };

test('a cold backend recovers automatically; local v142 is usable before the catalog finishes', { timeout: 2000 }, async () => {
  let localCalls = 0, fullCalls = 0;
  const updates = [];
  const controller = new AbortController();
  let release;
  const pending = loadKernelStatus({
    kernelLocalStatus: async () => ++localCalls === 1 ? { ok: false, installed: false } : local,
    kernelStatus: async () => {
      if (++fullCalls === 1) return { ok: false, installed: false };
      return new Promise((resolve) => { release = resolve; });
    },
  }, (state) => {
    updates.push(state);
    if (state.kernel?.local) queueMicrotask(() => release?.(full));
  }, controller.signal);
  // Wait until the second attempt starts its catalog request.
  while (!release) await new Promise(setImmediate);
  const readyBeforeCatalog = updates.find((state) => state.kernel?.local && state.kernel.installed);
  assert.ok(readyBeforeCatalog);
  assert.ok(mergeKernelStatus({}, readyBeforeCatalog.kernel).available.some((entry) => entry.version === '142' && entry.installed));
  release(full);
  await pending;
  assert.equal(localCalls, 2);
  assert.equal(fullCalls, 2);
  assert.equal(updates.at(-1).loading, false);
  assert.equal(updates.at(-1).error, '');
});

test('failed and never-resolving requests stop loading after three attempts; explicit refresh recovers and abort stops pending work', async () => {
  let calls = 0;
  const updates = [];
  await loadKernelStatus({ kernelLocalStatus: () => new Promise(() => {}), kernelStatus: () => { calls++; return new Promise(() => {}); } }, (state) => updates.push(state), new AbortController().signal);
  assert.equal(calls, 3);
  assert.equal(updates.at(-1).loading, false);
  assert.match(updates.at(-1).error, /超时/);
  await loadKernelStatus({ kernelLocalStatus: async () => local, kernelStatus: async () => full }, (state) => updates.push(state), new AbortController().signal);
  assert.equal(updates.at(-1).error, '');
  const abort = new AbortController();
  let remoteCalled = false;
  const cancelled = loadKernelStatus({ kernelLocalStatus: () => new Promise(() => {}), kernelStatus: () => { remoteCalled = true; } }, () => {}, abort.signal);
  abort.abort();
  await cancelled;
  assert.equal(remoteCalled, false);
});

test('catalog failure keeps local installations; late local snapshots preserve download choices and refresh installed flags', async () => {
  let state = mergeKernelStatus({}, full);
  state = mergeKernelStatus(state, local);
  assert.ok(state.available.some((entry) => entry.version === '143'));
  assert.ok(state.available.some((entry) => entry.version === '142' && entry.installed));
  const updates = [];
  await loadKernelStatus({ kernelLocalStatus: async () => local, kernelStatus: async () => ({ ...local, local: false, available: [], listError: '获取版本列表失败 (HTTP 503)' }) }, (update) => {
    updates.push(update);
    if (update.kernel) state = mergeKernelStatus(state, update.kernel);
  }, new AbortController().signal);
  assert.equal(state.installed, true);
  assert.deepEqual(Array.from(state.available.map((entry) => entry.version)), ['142']);
  assert.equal(updates.at(-1).loading, false);
  assert.match(updates.at(-1).error, /503/);
});

test('real backend distinguishes missing catalogs from server failures and keeps installed v142 in either case', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kernel-status-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('kernel-status-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const runtime = path.join(dir, 'runtimes', 'fingerprint-chromium-win-142');
  fs.mkdirSync(runtime, { recursive: true });
  fs.writeFileSync(path.join(runtime, 'chrome.exe'), 'test placeholder; never executed');
  fs.writeFileSync(path.join(dir, 'runtimes', 'selected-version'), '142');
  let reply = () => Response.json({}, { status: 503 });
  const module = { exports: {} };
  runInNewContext(backend.code, { module, exports: module.exports, fs, path,
    require: (id) => ({ fs, path, child_process: { spawnSync: () => assert.fail('no browser or installer runs') }, '../platformAdapter': { getUserDataPath: () => dir }, '../coworkLogger': { coworkLog() {} } })[id],
    process: { platform: 'win32', env: {}, arch: 'x64' }, fetch: async () => reply(), AbortSignal, setTimeout, clearTimeout, Buffer, URL,
  });
  const api = module.exports;
  let info = await api.kernelInfo();
  assert.equal(info.installed, true);
  assert.equal(info.selectedVersion, '142');
  assert.match(info.listError, /HTTP 503/);
  assert.ok(api.localKernelInfo().installedVersions.includes('142'));
  let error = '';
  assert.equal(await api.ensureKernel('142', (_, message) => { error = message; }), null);
  assert.match(error, /503/);
  reply = () => Response.json({ kernels: [] });
  info = await api.kernelInfo();
  assert.equal(info.listError, '');
  assert.equal(info.installed, true);
  reply = () => Response.json({ unexpected: [] });
  assert.match((await api.kernelInfo()).listError, /格式异常/);
});

test('the actual shared hook refreshes when a late backend connects and removes the listener on unmount', async () => {
  let requests = 0;
  const effects = [];
  const window = new EventTarget();
  window.electron = { matrix: {
    kernelLocalStatus: async () => { requests++; return local; },
    kernelStatus: async () => { requests++; return full; },
  } };
  const react = {
    useState: (initial) => { let value = initial; return [value, (next) => { value = typeof next === 'function' ? next(value) : next; }]; },
    useRef: (current) => ({ current }), useCallback: (fn) => fn, useEffect: (fn) => effects.push(fn()),
  };
  const module = { exports: {} };
  runInNewContext(frontend.code, { module, exports: module.exports, require: () => react, window, AbortController, setTimeout, clearTimeout });
  module.exports.useKernelStatus();
  await new Promise(setImmediate);
  assert.equal(requests, 2);
  window.dispatchEvent(new Event('noobclaw:backend-ready'));
  await new Promise(setImmediate);
  assert.equal(requests, 4);
  effects.forEach((cleanup) => cleanup?.());
  window.dispatchEvent(new Event('noobclaw:backend-ready'));
  await new Promise(setImmediate);
  assert.equal(requests, 4);
});
