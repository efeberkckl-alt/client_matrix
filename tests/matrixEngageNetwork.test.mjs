import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import { getEventListeners } from 'node:events';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/engageRunner.ts', import.meta.url), 'utf8');
const ast = ts.createSourceFile('engageRunner.ts', source, ts.ScriptTarget.Latest, true);
const funcs = (names) => ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map((n) => n.getText(ast)).join('\n');
function evaluate(code, context) {
  return runInNewContext(ts.transpileModule(code, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText, context);
}
const tick = () => new Promise(setImmediate);
function network(fetch) {
  const timers = new Map();
  let id = 0;
  const context = {
    AbortController, fetch, baseUrl: () => 'https://offline.invalid', coworkLog() {},
    setTimeout: (fn, ms) => { const key = ++id; timers.set(key, { fn, ms }); return key; },
    clearTimeout: (key) => timers.delete(key),
    getMatrixCommentAIConfig: () => undefined, isLocalTikTokComment: () => false, isCommentAIRequest: () => false,
  };
  const api = evaluate(`${funcs(['abortableSleep', 'fetchEngageJson', 'chargeAction', 'fetchEngagePack', 'makeAiCall'])}
    ({fetchEngageJson, chargeAction, fetchEngagePack, makeAiCall});`, context);
  return { ...api, timers, fire(ms) {
    const entry = [...timers].find(([, value]) => value.ms === ms);
    assert.ok(entry, `missing ${ms}ms timer`); timers.delete(entry[0]); entry[1].fn();
  } };
}
const response = (status, data) => ({ status, ok: status >= 200 && status < 300, json: async () => data });
const nonJson = (status) => ({ status, ok: status >= 200 && status < 300, json: async () => { throw Error('HTML error page'); } });

test('non-JSON HTTP rejections retain status and never retry deterministic AI or debit failures', async () => {
  for (const status of [401, 402, 403]) {
    let calls = 0;
    const n = network(async () => { calls++; return nonJson(status); });
    await assert.rejects(n.makeAiCall({}, 'offline-token', () => {})('__raw__', 'system', 'message', { expectJson: false }),
      status === 402 ? /余额不足/ : new RegExp(`AI 请求失败 ${status}`));
    assert.equal(calls, 1);
    assert.equal((await n.chargeAction('offline-token', 'comment', 'tiktok')).reason,
      status === 402 ? 'insufficient_balance' : 'auth_required');
    assert.equal(calls, 2);
    assert.equal(n.timers.size, 0);
  }
  assert.equal((await network(async () => nonJson(200)).chargeAction('offline-token', 'comment', 'tiktok')).reason, 'charge_uncertain');
});

test('scenario failures distinguish temporary unavailability from missing or rejected scripts', async () => {
  for (const status of [404, 400, 401, 403, 429, 503, 'network']) {
    let calls = 0;
    const n = network(async () => { calls++; if (status === 'network') throw Error('offline'); return nonJson(status); });
    const pending = n.fetchEngagePack('fixture');
    await tick();
    const transient = status === 429 || status === 503 || status === 'network';
    if (transient) n.fire(3000);
    const result = await pending;
    assert.equal(calls, transient ? 2 : 1);
    if (status === 404) assert.equal(result, null);
    else if (status === 401 || status === 403) assert.equal(result.__denied, true);
    else assert.equal(result.__unavailable, transient ? 'network_error:scenario_unavailable' : 'scenario_rejected_http_400');
    assert.equal(n.timers.size, 0);
  }
});

test('one deadline bounds headers and response body; stop cancels both and removes listeners', async () => {
  for (const phase of ['headers', 'body']) for (const termination of ['timeout', 'stop']) {
    let requestSignal;
    const n = network(async (_url, init) => {
      requestSignal = init.signal;
      return phase === 'headers' ? new Promise(() => {}) : { json: () => new Promise(() => {}) };
    });
    const ctrl = new AbortController();
    const pending = n.fetchEngageJson('https://offline.invalid', {}, 30_000, ctrl.signal);
    const rejected = assert.rejects(pending, termination === 'timeout' ? /request_timeout/ : /user_stopped/);
    await tick();
    if (termination === 'timeout') n.fire(30_000); else ctrl.abort();
    await rejected;
    assert.equal(requestSignal.aborted, true);
    assert.equal(n.timers.size, 0);
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
  }
});

test('debit has one attempt and separates pre-dispatch cancellation, rejection and uncertain outcomes', async () => {
  const cases = [
    [() => response(200, { charged: 3, cost_usd: 0.1 }), undefined],
    [() => response(402, { error: 'insufficient' }), 'insufficient_balance'],
    [() => response(401, {}), 'auth_required'],
    [() => response(403, {}), 'auth_required'],
    [() => response(429, {}), 'charge_rejected_http_429'],
    [() => response(200, { ok: false, error: 'insufficient_balance' }), 'insufficient_balance'],
    [() => response(200, { ok: false, error: 'invalid_action' }), 'charge_rejected'],
    [() => response(500, {}), 'charge_uncertain'],
    [() => response(200, {}), 'charge_uncertain'],
    [() => response(200, { charged: -1 }), 'charge_uncertain'],
    [() => response(200, { charged: false }), 'charge_uncertain'],
    [() => response(200, { charged: '' }), 'charge_uncertain'],
    [() => { throw Error('network'); }, 'charge_uncertain'],
    [() => ({ status: 200, ok: true, json: async () => { throw Error('JSON'); } }), 'charge_uncertain'],
  ];
  for (const [reply, reason] of cases) {
    let calls = 0;
    const n = network(async () => { calls++; return reply(); });
    const result = await n.chargeAction('offline-token', 'comment', 'tiktok', 'fixed-ref');
    assert.equal(result.reason, reason);
    assert.equal(result.ok, !reason);
    assert.equal(calls, 1);
    assert.equal(n.timers.size, 0);
  }
  let calls = 0;
  const n = network(async () => { calls++; return new Promise(() => {}); });
  const stopped = new AbortController(); stopped.abort();
  assert.equal((await n.chargeAction('offline-token', 'comment', 'tiktok', undefined, stopped.signal)).reason, 'aborted');
  assert.equal(calls, 0);
  for (const terminate of ['stop', 'timeout']) {
    const ctrl = new AbortController();
    const pending = n.chargeAction('offline-token', 'comment', 'tiktok', undefined, ctrl.signal);
    await tick();
    if (terminate === 'stop') ctrl.abort(); else n.fire(30_000);
    assert.equal((await pending).reason, 'charge_uncertain');
  }
  assert.equal(calls, 2);
});

test('AI and scenario retries obey cancellation during backoff and bound their requests', async () => {
  for (const kind of ['ai', 'pack']) {
    let calls = 0;
    const n = network(async () => { calls++; throw Error('temporary offline'); });
    const ctrl = new AbortController();
    const pending = kind === 'pack' ? n.fetchEngagePack('fixture', undefined, ctrl.signal)
      : n.makeAiCall({}, 'offline-token', () => {}, undefined, ctrl.signal)('__raw__', 'system', 'message', { expectJson: false });
    const rejected = assert.rejects(pending, /user_stopped/);
    await tick();
    assert.ok([...n.timers.values()].some((t) => t.ms === (kind === 'pack' ? 3000 : 2000)));
    ctrl.abort();
    await rejected;
    assert.equal(calls, 1);
    assert.equal(n.timers.size, 0);
    assert.equal(getEventListeners(ctrl.signal, 'abort').length, 0);
  }
});

test('actual doCharge persists uncertainty even when stopped, and cannot resend a failed debit', async () => {
  let declaration;
  function find(n) { if (ts.isVariableDeclaration(n) && n.name.getText(ast) === 'doCharge') declaration = n; ts.forEachChild(n, find); }
  find(ast);
  for (const stopped of [false, true]) {
    const ctrl = new AbortController();
    const recorded = [], fatal = { reason: '' };
    let calls = 0;
    const api = evaluate(`let chargeFailure = '', chargedCredits = 0, chargedUsd = 0;
      const ${declaration.getText(ast)}; ({doCharge});`, {
      acc: {},
      opts: { signal: ctrl.signal }, authToken: 'offline-token', accountId: 'account',
      chargeFatal: fatal, chargeAction: async () => { calls++; if (stopped) ctrl.abort(); return { ok: false, reason: 'charge_uncertain' }; },
      markAccountChargeUncertain: (...args) => recorded.push(args), log() {}, coworkLog() {},
    });
    assert.equal((await api.doCharge('comment', 'tiktok', 'fixed-ref')).reason, 'charge_uncertain');
    await api.doCharge('comment', 'tiktok', 'fixed-ref');
    assert.equal(calls, 1);
    assert.equal(fatal.reason, 'charge_uncertain');
    assert.equal(recorded.length, 1);
    assert.equal(recorded[0][0], 'account');
    assert.equal(recorded[0][1].refId, 'fixed-ref');
  }
});
