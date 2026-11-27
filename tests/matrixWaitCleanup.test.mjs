import assert from 'node:assert/strict';
import { getEventListeners } from 'node:events';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/engageRunner.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('engageRunner.ts', source, ts.ScriptTarget.Latest, true);
const helpers = ast.statements.filter((n) => ts.isFunctionDeclaration(n) && ['abortableSleep', 'randInt'].includes(n.name?.text));
const runOne = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'runOne');
const properties = new Map();
function visit(node) {
  if (ts.isPropertyAssignment(node) && ['sleep', 'downloadVideoToDisk'].includes(node.name.getText(ast))) {
    properties.set(node.name.getText(ast), node.initializer.getText(ast));
  }
  ts.forEachChild(node, visit);
}
visit(runOne);
const finalizer = runOne.body.statements.find((n) => ts.isTryStatement(n) && n.finallyBlock)?.finallyBlock;
assert.equal(properties.size, 2);
assert.ok(finalizer);
const code = ts.transpileModule(`
  ${helpers.map((n) => n.getText(ast)).join('\n')}
  ({ sleep: ${properties.get('sleep')}, download: ${properties.get('downloadVideoToDisk')},
     finalize: async () => ${finalizer.getText(ast)} });
`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;

function harness(signal, fetchImpl = async () => { throw new Error('unexpected fetch'); }) {
  const timers = new Map(), writes = [];
  let timerId = 0, closed = 0;
  const runtime = runInNewContext(code, {
    opts: { signal, platform: 'tiktok' }, custom: undefined, workSignal: signal, acc: { platform: 'tiktok' }, accountId: 'offline-test',
    process: { env: {} }, os, path, Buffer, AbortController,
    fs: { mkdirSync() {}, writeFileSync: (...args) => writes.push(args) },
    DOWNLOAD_REFERER: {}, PLATFORM_HOME: {}, coworkLog() {},
    fetch: fetchImpl,
    setTimeout: (fn) => { timers.set(++timerId, fn); return timerId; },
    clearTimeout: (id) => timers.delete(id),
    inspectHoldMs: () => 20000, finished: null, kernelLaunched: true, kernelReceipt: undefined,
    closeKernel: () => { closed++; },
  });
  return {
    ...runtime, timers, writes, closed: () => closed,
    tick() { for (const [id, fn] of [...timers]) { timers.delete(id); fn(); } },
    assertClean() {
      assert.equal(timers.size, 0, 'timer must be released');
      if (signal) assert.equal(getEventListeners(signal, 'abort').length, 0, 'parent abort listener must be released');
    },
  };
}

test('real context sleeps and final waits release timers/listeners on timeout, prior abort and in-flight abort', async () => {
  for (const operation of ['sleep', 'finalize']) {
    const controller = new AbortController();
    const h = harness(controller.signal);
    for (let i = 0; i < 30; i++) {
      const pending = h[operation](1, 2);
      assert.equal(getEventListeners(controller.signal, 'abort').length, 1);
      h.tick();
      await pending;
      h.assertClean();
    }
    const pending = h[operation](10000);
    controller.abort();
    await pending;
    h.assertClean();
    await h[operation](10000);
    h.assertClean();
    if (operation === 'finalize') assert.equal(h.closed(), 32);
    const noSignal = harness();
    const normal = noSignal[operation](1);
    noSignal.tick();
    await normal;
    noSignal.assertClean();
  }
});

test('real download cleanup covers success, HTTP/body/network errors, timeout and task abort', async () => {
  for (const mode of ['success', 'http', 'empty', 'body', 'network', 'timeout', 'abort', 'already-aborted']) {
    const controller = new AbortController();
    if (mode === 'already-aborted') controller.abort();
    let downloadSignal;
    const h = harness(controller.signal, async (_url, { signal }) => {
      downloadSignal = signal;
      if (signal.aborted) throw new Error('aborted');
      if (mode === 'network') throw new Error('network failed');
      if (mode === 'abort' || mode === 'timeout') {
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')), { once: true }));
      }
      return {
        ok: mode !== 'http', status: 403,
        arrayBuffer: async () => {
          if (mode === 'body') throw new Error('body failed');
          return mode === 'empty' ? new ArrayBuffer(0) : new Uint8Array([1, 2, 3]).buffer;
        },
      };
    });
    const pending = h.download('https://example.invalid/offline.mp4');
    if (mode === 'abort') controller.abort();
    if (mode === 'timeout') h.tick();
    const result = await pending;
    assert.equal(result.ok, mode === 'success', mode);
    assert.equal(h.writes.length, mode === 'success' ? 1 : 0, mode);
    h.assertClean();
    if (['abort', 'already-aborted', 'timeout'].includes(mode)) assert.equal(downloadSignal.aborted, true);
    else {
      controller.abort();
      assert.equal(downloadSignal.aborted, false, 'finished download must detach from parent cancellation');
    }
    h.assertClean();
  }
});
