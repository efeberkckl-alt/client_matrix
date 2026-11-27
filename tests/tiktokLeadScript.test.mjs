import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { transform } from 'esbuild';
import ts from 'typescript';

const { code } = await transform(await readFile(new URL('../src/main/libs/matrix/tiktokLeadScript.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { patchTikTokLeadScript } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const original = await readFile(new URL('fixtures/tiktok-lead-engage.js', import.meta.url), 'utf8');
const patched = patchTikTokLeadScript(original);
const ast = ts.createSourceFile('lead.js', patched, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
const functionSource = (name) => ast.statements.find((n) => ts.isFunctionDeclaration(n) && n.name?.text === name).getText(ast);

test('downloaded script adaptation is executable, rejects version drift and is wired only into TikTok lead tasks', async () => {
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  assert.doesNotThrow(() => new AsyncFunction('ctx', patched));
  assert.equal(patchTikTokLeadScript(original.replace(/\r\n/g, '\n')), patched);
  assert.throws(() => patchTikTokLeadScript(original.replace("await _navigate(wurl)", "await _navigate(otherUrl)")), /脚本版本已变化/);
  assert.throws(() => patchTikTokLeadScript(original + original), /脚本版本已变化/);
  const runner = await readFile(new URL('../src/main/libs/matrix/engageRunner.ts', import.meta.url), 'utf8');
  assert.match(runner, /if \(opts.platform === 'tiktok' && opts.taskType === 'lead_engage'\) \{\s*pack.orchestrator = patchTikTokLeadScript\(pack.orchestrator\);/);
});

test('shared click helper checks explicit failure, missing response, thrown error, success and stop', async () => {
  for (const result of [{ ok: false, error: '限速等待期间页面/点击目标变化，取消本次点击' }, undefined, {}, { ok: true }]) {
    const logs = [];
    const click = runInNewContext(`${functionSource('cdpClickSel')}; cdpClickSel`, {
      rectOf: async () => ({ x: 10, y: 20 }), _b: async () => result,
      ctx: { report: (m) => logs.push(m), aborted: () => false },
    });
    assert.equal(await click('a'), result?.ok === true);
    assert.equal(logs.length, result?.ok === true ? 0 : 1);
    if (result?.error) assert.ok(logs[0].includes(result.error));
  }
  const stopped = runInNewContext(`${functionSource('cdpClickSel')}; cdpClickSel`, {
    rectOf: async () => ({ x: 10, y: 20 }), _b: () => assert.fail('stopped task must not click'),
    ctx: { aborted: () => true },
  });
  assert.equal(await stopped('a'), false);
  const throwing = runInNewContext(`${functionSource('cdpClickSel')}; cdpClickSel`, {
    rectOf: async () => ({ x: 10, y: 20 }), _b: async () => { throw new Error('CDP disconnected'); },
    ctx: { report() {} },
  });
  assert.equal(await throwing('a'), false);
});

test('a delayed successful card open is detected before trying to click the profile again', async () => {
  const open = runInNewContext(`${functionSource('openCardOnProfile')}; openCardOnProfile`, {
    videoIdOf: (url) => url.split('/').at(-1), getUrl: async () => 'https://www.tiktok.com/@lead/video/123',
    tkCdp: () => assert.fail('already open; no second click'), ctx: { aborted: () => false },
  });
  assert.equal(await open('https://www.tiktok.com/@lead/video/123'), true);
});

test('missing cards and navigation timeouts have distinct diagnostics; stop cancels polling', async () => {
  for (const mode of ['missing', 'timeout', 'stopped']) {
    const logs = [];
    let sleeps = 0;
    const open = runInNewContext(`${functionSource('openCardOnProfile')}; openCardOnProfile`, {
      videoIdOf: (url) => url.split('/').at(-1), getUrl: async () => 'https://www.tiktok.com/@lead',
      tkCdp: async () => mode === 'missing' ? 0 : 1, cdpClickSel: async () => true,
      ctx: { report: (m) => logs.push(m), sleep: async () => { sleeps++; }, aborted: () => mode === 'stopped' && sleeps > 0 },
    });
    assert.equal(await open('https://www.tiktok.com/@lead/video/123'), false);
    if (mode === 'missing') assert.match(logs[0], /不存在或不可见/);
    if (mode === 'timeout') assert.match(logs[0], /未检测到目标作品地址/);
    if (mode === 'stopped') assert.equal(sleeps, 1);
  }
});

test('real customer loop skips failed cards, preserves follow success and keeps working cards interactive', async () => {
  for (const [opens, follow] of [[false, false], [false, true], [true, false]]) {
    const navigations = [], reports = [], rows = [], charges = [];
    let clicks = 0, likes = 0, comments = 0;
    const lead = { lastEngagedAt: 0, likedCount: 0, commentedCount: 0 };
    const ctx = { aborted: () => false, sleep: async () => {}, stepLog() {}, report: (m) => reports.push(m), addActionCount() {} };
    const env = {
      ctx, ledger: { leads: { lead } }, done: { like: 0, comment: 0, follow: 0, skipped: 0 },
      pickLeadAction: () => true, _navigate: async (url) => navigations.push(url),
      waitReady: async () => 'v:https://www.tiktok.com/@lead/video/123',
      authorOfVideoUrl: () => 'lead', videoIdOf: () => '123',
      followBudget: follow ? 1 : 0, cmtBudget: 1, doLike: true,
      saveLedger() {}, jsleep: async () => {}, beh: { lead_like_all: false },
      tryFollowOnProfile: async () => ({ ok: true }),
      openCardOnProfile: async () => { clicks++; return opens; },
      holdVideo: async () => {}, captchaGate: async () => true, getText: async () => '真实描述', SEL_VIDEO_DESC: 'desc',
      randInt: () => 0, sleepWithHeartbeat: async () => {},
      tryLike: async () => { likes++; return { ok: true }; },
      tryComment: async () => { comments++; return { ok: true }; },
      chargeIfPossible: async (action) => charges.push(action),
      pushOrMerge: (_handle, row, skipped) => rows.push({ row, skipped }),
      flushOutputs: async () => {}, maybeTopUp() {},
    };
    const batch = runInNewContext(`${functionSource('__engageBatch')}; __engageBatch`, env);
    await batch(['lead']);
    assert.deepEqual(navigations, ['https://www.tiktok.com/@lead'], 'no direct video navigation on failure or success');
    assert.equal(clicks, opens ? 1 : 2);
    assert.equal(likes, opens ? 1 : 0);
    assert.equal(comments, opens ? 1 : 0);
    assert.equal(rows[0].skipped, !(opens || follow), 'failed open alone must not count as engagement');
    assert.equal(!!lead.engagedDone, opens || follow, 'failed open alone must not permanently exhaust the customer');
    assert.ok(lead.lastEngagedAt > 0, 'still rotate the queue');
    assert.equal(reports.length, opens ? 0 : 1);
    assert.deepEqual(charges, opens ? ['like_lite', 'comment'] : follow ? ['follow'] : []);
  }
});

test('failed comment focus returns before typing or publishing', async () => {
  const attempt = runInNewContext(`${functionSource('tryComment')}; tryComment`, {
    ensureCommentsOpen: async () => {}, getTexts: async () => [], rectOf: async () => ({ x: 10, y: 20 }),
    SEL_TOP_COMMENT_TEXT: 'comments', SEL_COMMENT_INPUT_CE: 'input',
    AI_COMMENT: false, leadOnlyRewrite: async () => 'A valid comment', FORCED_LANG: 'en',
    cdpClickSel: async () => false, ctx: { stepLog() {} },
    _b: () => assert.fail('failed focus must not type or publish'),
  });
  assert.equal((await attempt('description', 'author', 2)).ok, false);
});
