import assert from 'node:assert/strict';
import fs from 'node:fs';
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { AsyncLocalStorage } from 'node:async_hooks';
import { transform } from 'esbuild';
import ts from 'typescript';
import { diagnosticAccountAlias, KernelNavigationError, NavigationTrace, navigationPage } from './helpers/kernelNavigationHarness.mjs';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/automationSafety.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'cjs' });
const module = { exports: {} };
runInNewContext(compiled.code, { module, exports: module.exports, require: (id) => ({ fs, path, os, crypto })[id], process: { pid: process.pid, kill: process.kill, env: {} }, AbortController, setTimeout, clearTimeout, URL });
const { AutomationSafety, AutomationSafetyError, OPERATION_INTERVALS, operationForCommand, operationForScript, restrictedResponse, safetyUrlForLog, AUTOMATION_RESTRICTION_EXPR } = module.exports;

function harness(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-safety-test-'));
  t.after(() => {
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(path.basename(dir).startsWith('matrix-safety-test-'));
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const file = path.join(dir, 'state.json');
  let now = 1000000;
  const clock = () => now;
  const sleep = async (ms) => { now += ms; };
  const safety = new AutomationSafety(file, clock, sleep, () => 0);
  return { safety, file, clock, sleep, advance: (ms) => { now += ms; } };
}

test('account, process and shared proxy clocks really delay operations across platforms and task batches', async (t) => {
  const h = harness(t);
  const { safety, clock } = h;
  safety.begin('a', 'tiktok:realA', 'proxyA', () => {});
  safety.begin('b', 'douyin:realB', 'proxyB', () => {});
  safety.begin('c', 'xhs:realC', 'proxyA', () => {});
  const start = clock();
  await safety.before('a', 'interaction');
  await safety.before('b', 'interaction');
  assert.ok(clock() - start >= OPERATION_INTERVALS.interaction.shared[0]);
  await safety.before('c', 'interaction');
  assert.ok(clock() - start >= OPERATION_INTERVALS.interaction.group[0]);
  await safety.before('a', 'interaction');
  assert.ok(clock() - start >= OPERATION_INTERVALS.interaction.account[0]);
  safety.end('a');
  safety.begin('a', 'tiktok:realA', 'proxyA', () => {});
  const previous = clock();
  await safety.before('a', 'interaction');
  assert.ok(clock() - previous >= OPERATION_INTERVALS.interaction.account[0]);
  for (const kind of ['navigate', 'scroll', 'input', 'launch']) {
    await safety.before('a', kind);
    const first = clock();
    await safety.before('a', kind);
    assert.ok(clock() - first >= OPERATION_INTERVALS[kind].account[0]);
  }
});

test('a paused account cannot continue in another batch, another task, or after restart; group failures stop peers', async (t) => {
  const { safety, file, clock, sleep, advance } = harness(t);
  safety.begin('a', 'tiktok:uid', 'sameProxy', () => {});
  safety.halt('a', 'rate_limited', 7200000);
  const firstDeadline = safety.blocked('a').until;
  advance(1000);
  safety.halt('a', 'forbidden');
  assert.equal(safety.blocked('a').until, firstDeadline);
  assert.throws(() => safety.assertAllowed('a'), AutomationSafetyError);
  await assert.rejects(safety.before('a', 'interaction'), AutomationSafetyError);
  safety.end('a');
  const restarted = new AutomationSafety(file, clock, sleep, () => 0);
  assert.throws(() => restarted.begin('new-matrix-id', 'tiktok:uid', 'differentProxy', () => {}), AutomationSafetyError);
  safety.begin('b', 'tiktok:uid2', 'sameProxy', () => {});
  safety.begin('c', 'tiktok:uid3', 'sameProxy', () => {});
  safety.halt('b', 'forbidden');
  assert.throws(() => safety.assertAllowed('c'), AutomationSafetyError);
  assert.ok(safety.blocked('c').until > clock());
});

test('concurrent workers cannot reserve the same shared slot and later responses cannot shorten a cooldown', async (t) => {
  const { file, clock, sleep } = harness(t);
  const times = [];
  let randomCalls = 0;
  const safety = new AutomationSafety(file, clock, sleep, () => { if (randomCalls++ % 3 === 0) times.push(clock()); return 0; });
  for (const id of ['a', 'b', 'c', 'd']) safety.begin(id, id, 'sameProxy', () => {});
  await Promise.all(['a', 'b', 'c', 'd'].map((id) => safety.before(id, 'interaction')));
  times.sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= OPERATION_INTERVALS.interaction.group[0]);
  safety.halt('a', 'captcha');
  safety.halt('a', 'rate_limited', 7200000);
  const until = safety.blocked('a').until;
  safety.halt('b', 'forbidden');
  assert.ok(safety.blocked('d').until >= until);
});

test('stop interrupts a queued wait immediately and damaged cooldown data does not silently reset', async (t) => {
  const h = harness(t);
  const realWait = new AutomationSafety(h.file, Date.now);
  realWait.begin('a', 'a', 'g', () => {});
  await realWait.before('a', 'interaction');
  const queued = realWait.before('a', 'interaction');
  realWait.end('a');
  await assert.rejects(queued, AutomationSafetyError);
  fs.writeFileSync(h.file, '{bad json');
  assert.throws(() => new AutomationSafety(h.file).begin('a', 'a', 'g', () => {}));
});

test('distinct page failures accumulate across batches, not on every poll, and successful interaction resets them', async (t) => {
  const { safety } = harness(t);
  safety.begin('a', 'a', 'g', () => {});
  for (let i = 0; i < 8; i++) safety.pageFailed('a', 'https://example.invalid/user/1');
  assert.equal(safety.blocked('a'), undefined);
  safety.pageFailed('a', 'https://example.invalid/user/2');
  const completed = await safety.before('a', 'interaction');
  completed(true);
  safety.pageFailed('a', 'https://example.invalid/user/3');
  safety.pageFailed('a', 'https://example.invalid/user/4');
  assert.equal(safety.blocked('a'), undefined);
  safety.pageFailed('a', 'https://example.invalid/user/5');
  assert.ok(safety.blocked('a'));
  await assert.rejects(safety.before('a', 'navigate'), AutomationSafetyError);
});

test('classification keeps read-only probes fast, budgets page mutations, and honors Retry-After', () => {
  assert.equal(operationForScript('return e.value === "hello";'), undefined);
  assert.equal(operationForScript('return e.textContent == "hello";'), undefined);
  assert.equal(operationForScript('e.value = "hello";'), 'script');
  assert.equal(operationForScript('e.click();'), 'interaction');
  assert.equal(operationForCommand('query_selector', '[data-e2e="like-icon"]'), undefined);
  assert.equal(operationForCommand('main_world_click', '[data-nc-like]'), 'interaction');
  assert.equal(operationForCommand('follow'), 'interaction');
  assert.equal(operationForCommand('click', 'Post'), 'interaction');
  assert.equal(operationForCommand('set_value'), 'script');
  assert.equal(operationForCommand('cdp_wheel'), 'scroll');
  assert.equal(restrictedResponse({ type: 'Image', response: { status: 403 } }), undefined);
  assert.equal(restrictedResponse({ type: 'XHR', response: { status: 429, headers: { 'Retry-After': '120' } } }).retryAfterMs, 120000);
  assert.equal(restrictedResponse({ type: 'Document', response: { status: 403 } }).reason, 'forbidden');
  assert.equal(restrictedResponse({ type: 'XHR', response: { status: 403 } }).pause, false);
  assert.equal(restrictedResponse({ type: 'Fetch', response: { status: 403 } }).pause, false);
  assert.equal(restrictedResponse({ type: 'Document', frameId: 'child', response: { status: 403 } }, 0, 'root').pause, false);
  assert.equal(restrictedResponse({ type: 'Document', frameId: 'root', response: { status: 403 } }, 0, 'root').pause, true);
  assert.equal(restrictedResponse({ type: 'Document', response: { status: 403 } }).pause, false, 'unknown frame is not assumed to be the main page');
  assert.equal(restrictedResponse({ type: 'XHR', response: { status: 429 } }).pause, true);
  assert.equal(restrictedResponse({ type: 'Fetch', response: { status: 429, headers: { 'retry-after': new Date(120000).toUTCString() } } }, 0).retryAfterMs, 120000);
  const diagnosticUrl = safetyUrlForLog('https://user:pass@www.tiktok.com/api/aux?msToken=secret&signature=secret2&q=skincare#private');
  assert.equal(diagnosticUrl.includes('secret'), false);
  assert.equal(diagnosticUrl.includes('user:pass'), false);
  assert.ok(diagnosticUrl.includes('/api/aux') && diagnosticUrl.includes('q=skincare'));
});

test('visible platform alerts are detected; ordinary comment text and hidden captcha nodes are not', () => {
  const visible = (text, size = 200) => ({ innerText: text, getClientRects: () => [1], getBoundingClientRect: () => ({ width: size, height: size }) });
  function detect(body, alerts = [], captchas = []) {
    return runInNewContext(AUTOMATION_RESTRICTION_EXPR, {
      document: { body: { innerText: body }, querySelectorAll: (s) => s.includes('[id*=') ? captchas : alerts },
      location: { href: 'https://example.invalid/profile' },
      getComputedStyle: (e) => ({ display: e.hidden ? 'none' : 'block', visibility: 'visible' }),
    });
  }
  assert.equal(detect('A comment says: you are tapping too fast'), '');
  assert.equal(detect('video', [visible('You are commenting too fast. Take a break.')]), 'rate_limited');
  assert.equal(detect('video', [visible('操作过于频繁，请稍后再试')]), 'rate_limited');
  assert.equal(detect('video', [visible("You're doing that too much. Try again in 6 minutes.")]), 'rate_limited');
  assert.equal(detect('video', [], [visible('captcha')]), 'captcha');
  assert.equal(detect('video', [], [{ ...visible('captcha'), hidden: true }]), '');
  assert.equal(detect('Something went wrong', [visible('Refresh')]), 'page_error:https://example.invalid/profile');
  assert.equal(detect('This video mentions something went wrong'), '');
});

test('visible TikTok login UI pauses the account; comments, hidden modals and other sites do not', async (t) => {
  const node = (text = '', hidden = false) => ({ innerText: text, hidden, getClientRects: () => hidden ? [] : [1] });
  const dialog = (title, hidden = false) => ({ ...node('A comment says Log in to TikTok', hidden), querySelector: () => node(title) });
  function detect(dialogs = [], inputs = [], href = 'https://www.tiktok.com/@test/video/1') {
    return runInNewContext(AUTOMATION_RESTRICTION_EXPR, {
      location: { href }, getComputedStyle: (e) => ({ display: e.hidden ? 'none' : 'block', visibility: 'visible' }),
      document: { body: { innerText: 'A comment says Log in to TikTok' }, querySelectorAll: (selector) =>
        selector.startsWith('input[') ? inputs : selector.includes('LoginModal') ? dialogs : [] },
    });
  }
  assert.equal(detect(), '');
  assert.equal(detect([dialog('Comments')]), '');
  assert.equal(detect([dialog('Log in to TikTok', true)]), '');
  assert.equal(detect([], [node('', true)]), '');
  assert.equal(detect([dialog('Log in to TikTok')]), 'login_wall');
  assert.equal(detect([dialog('登录 TikTok')]), 'login_wall');
  assert.equal(detect([], [node()]), 'login_wall');
  assert.equal(detect([dialog('Log in to TikTok')], [], 'https://example.invalid'), '');
  const { safety } = harness(t);
  safety.begin('a', 'a', 'g', () => {});
  safety.begin('b', 'b', 'g', () => {});
  safety.begin('c', 'c', 'g', () => {});
  const file = fs.readFileSync(new URL('../src/main/libs/matrix/kernelPool.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('kernelPool.ts', file, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === 'paceOperation');
  const code = ts.transpileModule(fn.getText(ast) + '\npaceOperation;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const pace = runInNewContext(code, {
    automationSafety: safety, AUTOMATION_RESTRICTION_EXPR, AutomationSafetyError, navigationPage,
    send: async () => ({ result: { value: detect([dialog('Log in to TikTok')]) } }),
  });
  await assert.rejects(pace({ accountId: 'a', automation: true }, 'interaction'), AutomationSafetyError);
  assert.match(safety.blocked('a').reason, /页面要求登录或验证/);
  safety.halt('b', 'login_wall');
  assert.equal(safety.blocked('c'), undefined, 'login prompts alone must not accuse a shared proxy or stop peer accounts');
});

test('production browser routes enforce pacing and response pauses even if a remote script swallows errors', async (t) => {
  const { safety, clock, advance } = harness(t);
  const logs = [];
  const statuses = [];
  safety.begin('a', 'a', 'g', (m) => runtime.safetyLog('a', m));
  const file = fs.readFileSync(new URL('../src/main/libs/matrix/kernelPool.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('kernelPool.ts', file, ts.ScriptTarget.Latest, true);
  const names = ['kernelSignal', 'waitForKernel', 'send', 'onMessage', 'protectNetworkResponse', 'enableAutomationNetwork', 'safetyLog', 'paceOperation', 'withAutomationOperation', 'isAutomationPaused', 'runAutomationScript', 'pageForNavigation', 'kernelNavigate', 'navigatePage', 'kernelEval', 'kernelExec', 'kernelKeypress', 'kernelClick', 'kernelInsertText', 'kernelWheel', 'assertInputTarget'];
  const functions = ast.statements.filter((n) => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map((n) => n.getText(ast).replace(/^export /, '')).join('\n');
  const js = ts.transpileModule(`${functions}\n({${names.join(',')}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const requests = [];
  const session = { accountId: 'a', automation: true, diagnosticsId: 'fixture', pending: new Map(), msgId: 1 };
  const response = (type, status, url, frameId = 'root') => runtime.onMessage(session, JSON.stringify({ method: 'Network.responseReceived', params: { requestId: 'request', type, frameId, loaderId: 'current', response: { status, url, headers: { 'Retry-After': '1800' } } } }));
  const runtime = runInNewContext(js, {
    automationSafety: safety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR, operationForCommand, operationForScript, restrictedResponse,
    diagnosticAccountAlias, KernelNavigationError, NavigationTrace, navigationPage, process,
    automationLogSink: (_id, msg) => logs.push(msg), setAccountStatus: (...args) => statuses.push(args), getAccount: () => ({}),
    markAccountCooldown: (id, until) => statuses.push([id, 'cooldown', until]),
    automationOperationContext: new AsyncLocalStorage(), automationOperationTail: Promise.resolve(),
    ROOT_PROOF_EXPRESSION: 'fixture-probe', observedRootWrites: new Set(),
    getPage: async () => session, verifyKernelEgress: async () => {}, WebSocket: { OPEN: 1 }, coworkLog() {}, sleep: async () => {}, setTimeout, clearTimeout, URL, AbortController, AbortSignal,
  });
  let clickTarget = { url: 'https://www.tiktok.com/', kind: 'like-icon', tag: 'BUTTON' };
  let inputTargetValid = true, sendTargetValid = true;
  session.pageWs = { readyState: 1, send(raw) {
    const request = JSON.parse(raw); requests.push({ method: request.method, at: clock() });
    if (request.method === 'Page.getFrameTree') {
      runtime.onMessage(session, JSON.stringify({ id: request.id, result: { frameTree: { frame: { id: 'root', loaderId: 'current', url: 'https://www.tiktok.com/' } } } }));
      return;
    }
    if (request.method === 'Page.navigate') {
      runtime.onMessage(session, JSON.stringify({ id: request.id, result: { frameId: 'root' } }));
      return;
    }
    let value = '';
    if (request.params?.expression?.includes('document.elementFromPoint')) value = clickTarget;
    if (request.params?.expression === "typeof window.__nbExec==='function'") value = true;
    if (request.params?.expression?.includes('location.href!==')) value = inputTargetValid;
    if (request.params?.expression?.includes('hit===e||e.contains(hit)')) value = sendTargetValid;
    runtime.onMessage(session, JSON.stringify({ id: request.id, result: { result: { value } } }));
  } };
  await runtime.enableAutomationNetwork(session);
  assert.equal(session.navigation.frame, 'root', 'new/reused sessions know the main frame before listening to HTTP responses');
  await runtime.kernelClick('a', 1, 1);
  await runtime.kernelClick('a', 1, 1);
  const clicks = requests.filter((r) => r.method === 'Input.dispatchMouseEvent');
  assert.ok(clicks[2].at - clicks[0].at >= OPERATION_INTERVALS.interaction.account[0]);
  clickTarget = { url: 'https://www.tiktok.com/', kind: 'comment-text', tag: 'DIV', editable: true, text: '添加评论...' };
  await runtime.kernelClick('a', 1, 1);
  const firstInputClick = clock();
  await runtime.kernelClick('a', 1, 1);
  assert.ok(clock() - firstInputClick >= OPERATION_INTERVALS.input.account[0]);
  assert.ok(clock() - firstInputClick < OPERATION_INTERVALS.interaction.account[0], 'focusing a comment editor is not publication');
  clickTarget = { url: 'https://www.tiktok.com/', kind: 'like-icon', tag: 'BUTTON' };
  await runtime.kernelNavigate('a', 'https://www.tiktok.com/@test');
  await runtime.kernelWheel('a', 1, 1, 0, 300);
  await runtime.kernelInsertText('a', 'offline test');
  const target = { selector: '[data-nc-custom-editor="active"]', url: 'https://www.tiktok.com/', text: '' };
  await runtime.kernelInsertText('a', 'targeted input', target);
  const insertedBefore = requests.filter(r => r.method === 'Input.insertText').length;
  inputTargetValid = false;
  await assert.rejects(runtime.kernelInsertText('a', 'must not type', target), /本次未输入/);
  assert.equal(requests.filter(r => r.method === 'Input.insertText').length, insertedBefore);
  const keysBefore = requests.filter(r => r.method === 'Input.dispatchKeyEvent').length;
  await assert.rejects(runtime.kernelKeypress('a', 'Backspace', { ...target, text: 'program draft' }), /本次未输入/);
  assert.equal(requests.filter(r => r.method === 'Input.dispatchKeyEvent').length, keysBefore);
  const mouseBefore = requests.filter(r => r.method === 'Input.dispatchMouseEvent').length;
  const sendTarget = { ...target, clickSelector: '[data-nc-custom-send="active"]', text: 'program draft' };
  await assert.rejects(runtime.kernelClick('a', 1, 1, sendTarget), /本次未输入/);
  inputTargetValid = true;
  sendTargetValid = false;
  await assert.rejects(runtime.kernelClick('a', 1, 1, sendTarget), /本次未点击/);
  assert.equal(requests.filter(r => r.method === 'Input.dispatchMouseEvent').length, mouseBefore);
  sendTargetValid = true;
  await runtime.kernelClick('a', 1, 1, sendTarget);
  assert.equal(requests.filter(r => r.method === 'Input.dispatchMouseEvent').length, mouseBefore + 2);
  await runtime.kernelKeypress('a', 'Enter');
  await runtime.kernelExec('a', 'main_world_click', { selector: '[data-nc-like]' });
  const sentAt = [];
  await Promise.all([
    runtime.withAutomationOperation(session, 'interaction', async () => { advance(30000); sentAt.push(clock()); }),
    runtime.withAutomationOperation(session, 'interaction', async () => { sentAt.push(clock()); }),
  ]);
  assert.ok(sentAt[1] - sentAt[0] >= OPERATION_INTERVALS.interaction.account[0], 'slow checks do not consume the actual operation gap');
  response('XHR', 403, 'https://www.tiktok.com/api/aux?msToken=secret');
  runtime.onMessage(session, JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'request', frameId: 'root', loaderId: 'current', type: 'Fetch', timestamp: 1, request: { method: 'POST', url: 'https://www.tiktok.com/api/telemetry' } } }));
  response('Fetch', 403, 'https://www.tiktok.com/api/telemetry');
  response('Document', 403, 'https://www.tiktok.com/embedded', 'child');
  assert.equal(safety.blocked('a'), undefined);
  assert.equal(session.navigation.url, 'https://www.tiktok.com/@test', 'iframe response cannot replace the main page URL');
  assert.ok(logs.some((m) => m.includes('HTTP 403') && m.includes('普通资源') && m.includes('仅记录告警')));
  assert.equal(logs.some((m) => m.includes('secret')), false);
  await runtime.kernelWheel('a', 1, 1, 0, 300);
  response('XHR', 429, 'https://www.tiktok.com/api/comment');
  assert.ok(statuses.some(([id, status, until]) => id === 'a' && status === 'cooldown' && until >= clock() + 1800_000));
  const count = requests.length;
  await assert.rejects(runtime.kernelClick('a', 1, 1), AutomationSafetyError);
  await assert.rejects(runtime.kernelEval('a', 'document.querySelector("button").click()'), AutomationSafetyError);
  let entered = false;
  await assert.rejects(runtime.runAutomationScript('a', async () => { entered = true; }, {}), AutomationSafetyError);
  assert.equal(entered, false, 'already paused scripts must not enter collection or completion steps');
  assert.ok(logs.some((m) => m.includes('触发原因') && m.includes('HTTP 429') && m.includes('普通资源')));
  assert.equal(requests.length, count, 'nothing else is sent after the restriction');
  safety.end('a');
  safety.begin('a', 'fresh', 'newGroup', (m) => logs.push(m));
  const progress = [], saved = [];
  const ctx = {
    aborted: () => false,
    stepLog: (...args) => progress.push(args), report: (...args) => progress.push(args),
    stepStart: (...args) => progress.push(args), stepDone: (...args) => progress.push(args),
    setActionTargets: (...args) => progress.push(args), finish: (...args) => progress.push(args),
    writeReport: (value) => saved.push(value),
  };
  const originalLog = ctx.stepLog;
  await assert.rejects(runtime.runAutomationScript('a', async (ctx) => {
    ctx.stepStart(1);
    response('Document', 403, 'https://www.tiktok.com/search?q=skincare');
    try { await runtime.kernelWheel('a', 1, 1, 0, 300); } catch { /* Remote scripts swallow browser errors. */ }
    assert.equal(ctx.aborted(), true);
    ctx.stepLog(1, 'done', '采集完成'); ctx.stepStart(2); ctx.report('触达完成');
    ctx.stepDone(2); ctx.setActionTargets({ comment: 0 }); ctx.finish('done');
    await ctx.writeReport('partial data');
    return 'done';
  }, ctx), AutomationSafetyError);
  assert.equal(progress.length, 1, 'no completion, next step, quota or success events after pause');
  assert.deepEqual(saved, ['partial data'], 'partial output remains saveable');
  assert.equal(ctx.stepLog, originalLog, 'shared/nested contexts are restored');
  assert.ok(logs.some((m) => m.includes('HTTP 403') && m.includes('主页面') && !m.includes('skincare')));
  safety.end('a');
  safety.begin('a', 'publish', 'publishGroup', (m) => logs.push(m));
  runtime.onMessage(session, JSON.stringify({ method: 'Network.requestWillBeSent', params: { requestId: 'request', frameId: 'root', loaderId: 'current', type: 'XHR', timestamp: 2, request: { method: 'POST', url: 'https://www.tiktok.com/api/comment/publish/' } } }));
  response('XHR', 403, 'https://www.tiktok.com/api/comment/publish/');
  assert.ok(safety.blocked('a'), 'an actual comment publication 403 still stops automation');
  assert.ok(logs.some((m) => m.includes('HTTP 403') && m.includes('互动/发布请求') && !m.includes('/api/comment/publish/')));
  session.automation = false; safety.end('a');
  await runtime.kernelClick('a', 1, 1); // Manual recovery remains available.
  assert.equal(requests.length, count + 2);
});

test('group pause bookkeeping preserves personal denial and full cooldown in account state', (t) => {
  const { safety, clock } = harness(t);
  const file = fs.readFileSync(new URL('../src/main/libs/matrix/kernelPool.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('kernelPool.ts', file, ts.ScriptTarget.Latest, true);
  const fn = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === 'safetyLog');
  const source = ts.transpileModule(fn.getText(ast) + '\nsafetyLog;', { compilerOptions: { target: ts.ScriptTarget.ES2022 } }).outputText;
  const saved = new Map(), logs = [];
  const logger = runInNewContext(source, {
    automationSafety: safety, diagnosticAccountAlias, automationLogSink: undefined, observedRootWrites: new Set(),
    getAccount: id => saved.get(id), coworkLog: (...args) => logs.push(args),
    markAccountCooldown: (id, until) => saved.set(id, { recovery: { reason: 'rate_limited', nextCheckAt: until } }),
    setAccountStatus: (id, _status, reason) => saved.set(id, { reason }),
  });
  for (const id of ['first-account', 'second-account', 'peer-account']) safety.begin(id, id, 'group', message => logger(id, message));
  safety.halt('first-account', 'forbidden');
  safety.halt('second-account', 'rate_limited', 3600_000);
  assert.match(saved.get('first-account').reason, /拒绝访问/);
  assert.equal(saved.get('second-account').recovery.reason, 'rate_limited');
  assert.equal(saved.get('second-account').recovery.nextCheckAt, clock() + 3600_000);
  assert.match(saved.get('peer-account').reason, /多个账号受限/);
  assert.ok(logs.some(([, , line]) => line.includes(diagnosticAccountAlias('second-account'))));
  assert.equal(JSON.stringify(logs).includes('second-account'), false);
});

test('lead zero-delay overrides and YouTube retry bypasses stay disabled', async () => {
  const configSource = fs.readFileSync(new URL('../src/main/libs/matrix/leadEngageConfig.ts', import.meta.url), 'utf8');
  const { code } = await transform(configSource, { loader: 'ts', format: 'esm' });
  const { leadEngageConfig } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
  const config = leadEngageConfig({ behavior: { lead_unlimited: true, lead_watch_ms: [0, 0], lead_between_leads_pause: [0, 0] } });
  assert.equal(config.behavior.lead_unlimited, false);
  assert.deepEqual(config.behavior.lead_between_leads_pause, [15000, 30000]);
  assert.deepEqual(leadEngageConfig({ behavior: { lead_watch_ms: [20000, 30000] } }).behavior.lead_watch_ms, [20000, 30000]);
  const download = fs.readFileSync(new URL('../src/main/libs/matrix/youtubeDownloadRunner.ts', import.meta.url), 'utf8');
  const ast = ts.createSourceFile('download.ts', download, ts.ScriptTarget.Latest, true);
  let args;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(ast) === 'baseArgs') args = node.initializer.getText(ast);
    ts.forEachChild(node, visit);
  }
  visit(ast);
  const actual = runInNewContext(args, { fmt: 'format', outTpl: 'out', url: 'https://example.invalid/video' });
  const value = (flag) => actual[actual.indexOf(flag) + 1];
  assert.equal(value('--retries'), '0');
  assert.equal(value('--fragment-retries'), '0');
  assert.equal(value('--sleep-requests'), '3');
  assert.equal(value('--sleep-interval'), '10');
  assert.equal(value('--max-sleep-interval'), '20');
  assert.equal(download.includes("--extractor-args"), false);
});
