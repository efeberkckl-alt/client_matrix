import assert from 'node:assert/strict';
import { readFile, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import { build, transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/main/libs/matrix/commentLikeConfig.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { commentLikeLimits, withTikTokKeywordLimits } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);
const intentModule = await transform(await readFile(new URL('../src/main/libs/matrix/tiktokCommentIntent.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { withTikTokBuyerComments } = await import(`data:text/javascript;base64,${Buffer.from(intentModule.code).toString('base64')}`);
// Actual server script fetched 2026-11-04; only browser, search and publication are simulated.
const script = await readFile(new URL('fixtures/tiktok-comment-like.js', import.meta.url), 'utf8');
const marker = 'ctx.stepStart(1);\nif (!DO_LIKE && !DO_REPLY)';
assert.equal(script.split(marker).length, 2);
const browser = `
var testVideo = -1, testPage = 0;
_navigate = async function(url) { testVideo = Number(videoIdOf(url)) - 1; testPage = 0; };
waitWithHold = jsleep = sleepWithHeartbeat = async function() {};
captchaGate = ensureCommentsOpen = async function() { return true; };
holdVideo = async function() {};
driftedFrom = async function() { return false; };
readVideoDesc = async function() { return 'Pottery demonstration'; };
tkCdp = async function() { return ctx.videos[testVideo].length > 0; };
scanCommentLikes = async function() { return ctx.videos[testVideo].slice(testPage * 4, (testPage + 1) * 4); };
likeCmtByKey = async function() { return {ok: true}; };
replyToComment = async function(st, c, url) {
  ctx.attempts.push({video: testVideo, comment: c.h});
  return c.fail ? {ok: false, msg: 'simulated failure'} : {ok: true, text: 'Reply to ' + c.h};
};
commentPanelState = async function() { return {top: testPage * 100, bottom: (testPage + 1) * 4 >= ctx.videos[testVideo].length}; };
scrollCommentPanel = async function() { testPage++; return true; };
searchNextKeyword = async function() {
  if (ctx.searched) return {exhausted: true};
  ctx.searched = true;
  candidates = ctx.videos.map(function(_, i) { return 'https://www.tiktok.com/@source/video/' + (i + 1); });
  return {};
};
`;
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;

async function simulate({ limit = 2, replies = 3, sizes = [12, 12, 12, 12], likes = true, reply = true, failures = [], dailyCap = 300, aborted = false, adapt = true, mode = 'keywords', saved = {}, buyers = false, ranks = {}, malformed = false, storageFails = false } = {}) {
  const states = structuredClone(saved), counts = {}, logs = [], attempts = [], classified = [];
  const videos = sizes.map((n, v) => Array.from({ length: n }, (_, i) => ({ h: `user_${v}_${i}`, t: `Comment ${i}`, fullText: `Full comment ${i}`, ap: i === 1 ? 'true' : 'false', fail: failures.includes(i) })));
  let source = adapt ? withTikTokKeywordLimits(script) : script;
  if (buyers) source = withTikTokBuyerComments(source);
  const run = new AsyncFunction('ctx', source.replace(marker, browser + '\n' + marker));
  const result = await run({
    task: { comment_mode: mode, keywords: ['pottery'], urls: ['https://www.tiktok.com/@source/video/1'], cl_do_like: likes, cl_do_reply: reply, cl_video_limit: limit, cl_replies_per_video: replies },
    manifest: { default_config: {}, risk_caps: { max_comments_per_day: dailyCap } },
    config: { behavior: { work_link_then_author: false } },
    videos, attempts,
    browser: async () => ({}), navigate: async () => {}, sleep: async () => {},
    aborted: () => aborted, report() {}, stepStart() {}, stepDone() {}, finish() {},
    stepLog(_step, _state, message) { logs.push(message); },
    getPrompt: () => 'Reply to the comment',
    aiCall: async (name, input) => {
      assert.equal(name, 'comment_intent');
      const { comments } = JSON.parse(input);
      classified.push(...comments);
      return malformed ? { items: [{ id: 999, rank: 2 }] } : { items: comments.map(c => ({ id: c.id, rank: ranks[c.text] || 0 })) };
    },
    readState: (key) => structuredClone(states[key] || null),
    writeState: (key, value) => { if (storageFails) return { ok: false }; states[key] = structuredClone(value); return { ok: true }; },
    addActionCount(key, n) { counts[key] = (counts[key] || 0) + n; },
    chargeAction: async () => ({ ok: true, charged: 0 }),
    writeReport: async () => ({ ok: true, path: 'simulated' }),
  });
  return { result, states, counts, attempts, logs, classified };
}

test('buyer selection prioritizes purchase intent, scans past unrelated comments and retains reply details across runs', async () => {
  const ranks = { 'Full comment 1': 1, 'Full comment 3': 2, 'Full comment 5': 2 };
  const first = await simulate({ buyers: true, replies: 2, ranks });
  assert.deepEqual(first.attempts.map(a => a.comment), ['user_0_3', 'user_0_1', 'user_1_3', 'user_1_1']);
  const rows = Object.values(first.states.comment_reply_ledger.keys);
  assert.equal(rows.length, 4);
  assert.equal(rows[0].comment, 'Full comment 3');
  assert.equal(rows[0].reply, 'Reply to user_0_3');
  assert.equal(rows[0].intent, 'purchase');
  assert.equal(rows[0].status, 'confirmed');
  assert.ok(rows[0].video.endsWith('/video/1'));
  assert.ok(Number.isFinite(Date.parse(rows[0].time)));
  const next = await simulate({ buyers: true, replies: 3, ranks, saved: first.states });
  assert.deepEqual(next.attempts.map(a => a.comment), ['user_0_5', 'user_1_5']);
  assert.equal(Object.keys(next.states.comment_reply_ledger.keys).length, 6);
  assert.ok(!next.classified.some(c => c.text === 'Full comment 3'));
  assert.equal((await simulate({ buyers: true })).attempts.length, 0, 'no ordinary comments fill the quota');
  assert.equal((await simulate({ buyers: true, ranks, malformed: true })).attempts.length, 0);
  assert.equal((await simulate({ buyers: true, ranks, reply: false })).classified.length, 0);
  assert.equal((await simulate({ buyers: true, ranks, adapt: false, mode: 'precise', sizes: [12] })).result.replies, 3);
  const legacy = { comment_reply_ledger: { keys: { '1|user_0_3|Comment 3': 123 } } };
  assert.ok(!(await simulate({ buyers: true, ranks, saved: legacy })).attempts.some(a => a.comment === 'user_0_3'));
  const oldKeys = Object.fromEntries(Array.from({ length: 8001 }, (_, i) => [`old_${i}`, i + 1]));
  const retained = await simulate({ buyers: true, ranks, sizes: [4], limit: 1, saved: { comment_reply_ledger: { keys: oldKeys } } });
  assert.equal(Object.keys(retained.states.comment_reply_ledger.keys).length, 8003, 'never trim old reply records');
  await assert.rejects(simulate({ buyers: true, saved: { comment_reply_ledger: { bad: true } } }), /账本损坏/);
  await assert.rejects(simulate({ buyers: true, ranks, storageFails: true }), /记录保存失败/);
  assert.throws(() => withTikTokBuyerComments(script.replace('var list = await scanCommentLikes();', 'var list = [];')), /不兼容/);
});

test('real reply publication persists before sending, records uncertain outcomes and blocks sends on disk failure', async () => {
  const c = { h: 'buyer', n: 'Buyer', t: 'Where to buy?', fullText: 'Where to buy?' };
  const key = '1|buyer|Where to buy?';
  const injected = `
    jsleep = async function() {};
    captchaGate = async function() { return true; };
    _b = async function() { return {}; };
    var reads = 0;
    tkCdp = async function() {
      reads++;
      if (reads === 1) return {x: 1, y: 2, text: ctx.comment.t};
      if (reads === 2) return {mode: 'inline', len: 0};
      if (reads === 3) return 20;
      if (reads === 4) return true;
      if (reads === 5) return 0;
      return ctx.confirm ? 1 : 0;
    };
    cdpClickSel = async function(selector) {
      if (selector === '[data-nc-rpost="1"]') ctx.onSend();
      return true;
    };
    var st = { reply: 0, desc: 'A product', intent: {'buyer|Where to buy?': 2} };
    return await maybeReply(st, ctx.comment, 'https://www.tiktok.com/@source/video/1');
  `;
  const run = new AsyncFunction('ctx', withTikTokBuyerComments(script).replace(marker, injected));
  for (const [confirm, failSave, output] of [[true, false, 'Please check the product page.'], [false, false, 'Please check the product page.'], [true, true, 'Please check the product page.'], [true, false, '']]) {
    const stored = {}, writes = [];
    let sends = 0;
    const execute = run({
      task: { cl_do_like: false, cl_do_reply: true }, manifest: { default_config: {} },
      config: { behavior: { reply_verify_total_ms: 1 } },
      comment: c, confirm,
      browser: async () => ({}), navigate: async () => {}, sleep: async () => {}, aborted: () => false,
      report() {}, stepLog() {}, finish() {}, getPrompt: () => 'Reply',
      readState: () => null,
      writeState(name, value) {
        if (failSave) return {ok: false};
        stored[name] = structuredClone(value);
        if (name === 'comment_reply_ledger') writes.push(stored[name].keys[key].status);
        return {ok: true};
      },
      aiCall: async () => output,
      chargeAction: async () => ({ok: true}),
      onSend() { assert.equal(stored.comment_reply_ledger.keys[key].status, 'pending'); sends++; },
    });
    if (failSave) await assert.rejects(execute, /记录保存失败/);
    else await execute;
    assert.equal(sends, failSave || !output ? 0 : 1);
    if (!failSave && output) assert.deepEqual(writes, ['pending', confirm ? 'confirmed' : 'unconfirmed']);
    if (!output) assert.equal(stored.comment_reply_ledger, undefined);
  }
});

test('keyword limits count successful replies, stop within a screen and span multiple screens/videos', async () => {
  const before = await simulate({ adapt: false });
  assert.equal(before.result.works, 4);
  assert.equal(before.result.replies, 24);
  for (const replies of [1, 3, 7]) {
    const after = await simulate({ replies });
    assert.equal(after.result.works, 2);
    assert.equal(after.result.replies, replies * 2);
    assert.equal(after.attempts.length, replies * 2);
    assert.equal(after.counts.like, (replies === 1 ? 1 : replies - 1) * 2, 'no extra like after reaching the reply cap');
  }
  const failed = await simulate({ likes: false, failures: [0] });
  assert.equal(failed.result.replies, 6);
  assert.equal(failed.attempts.length, 8, 'failed replies do not spend the success quota');
  const repeat = await simulate({ saved: failed.states, likes: false });
  assert.equal(repeat.result.replies, 6, 'new runs get new quotas while old replies remain deduplicated');
});

test('workbook comments preserve their video mapping, use no AI and survive an uncertain send without a duplicate', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const workbook = new ExcelJS.Workbook();
  const firstUrl = 'https://www.tiktok.com/@first/video/123';
  const secondUrl = 'https://www.tiktok.com/@second/video/456';
  const malaysia = workbook.addWorksheet('马来');
  malaysia.addRow(['视频链接', '自评话术']);
  malaysia.addRow([{ formula: 'HYPERLINK("' + firstUrl + '?lang=en","Open video")', result: 'Open video' }, '1. Très joli 💜\n2.Macam mana guna?']);
  const europe = workbook.addWorksheet('欧盟');
  europe.addRow(['视频链接', '国家', '自评话术']);
  europe.addRow([{ text: 'Video link', hyperlink: secondUrl }, 'FR', '1. Jolie couleur !']);
  europe.addRow(['Video title without a link', 'FR', '1. Skipped']);

  const parser = await build({ entryPoints: ['src/renderer/services/tiktokCommentWorkbook.ts'], bundle: true, packages: 'external', platform: 'node', format: 'esm', write: false });
  const { readTikTokCommentWorkbook } = await import('data:text/javascript;base64,' + Buffer.from(parser.outputFiles[0].text
    .replace('"exceljs"', JSON.stringify(import.meta.resolve('exceljs'))).replace('"zod"', JSON.stringify(import.meta.resolve('zod')))).toString('base64'));
  const { posts, issues } = await readTikTokCommentWorkbook(await workbook.xlsx.writeBuffer());
  const content = posts.map(({ url, text }) => ({ url, text }));
  assert.deepEqual(content, [
    { url: firstUrl, text: 'Très joli 💜' },
    { url: firstUrl, text: 'Macam mana guna?' },
    { url: secondUrl, text: 'Jolie couleur !' },
  ]);
  assert.deepEqual(issues, [{ sheet: '欧盟', row: 3, reason: 'url' }]);
  assert.deepEqual(posts[2].sources, [{ sheet: '欧盟', row: 2, column: 3, comment: 1 }]);

  const { customCommentHarness, withTikTokCustomComments } = await import('./helpers/customCommentHarness.mjs');
  const h = customCommentHarness({ hideFirst: true, focusDelay: 3 });
  assert.equal((await h.run(posts)).status, 'failed');
  assert.deepEqual(h.attempts, content);
  assert.equal(Object.values(h.state.custom_video_comments).filter(s => s === 'pending').length, 1);
  assert.deepEqual(h.charged, [], 'the workbook path never requests an action debit');
  assert.equal((await h.run(posts)).status, 'failed', 'an uncertain send remains incomplete on rerun');
  assert.deepEqual(h.attempts, content);
  const redirected = customCommentHarness({ wrongVideo: true });
  assert.equal((await redirected.run(posts)).status, 'failed');
  assert.deepEqual(redirected.attempts, []);
  const failedStore = customCommentHarness({ storageFails: true });
  await assert.rejects(failedStore.run(posts), /记录保存失败/);
  assert.deepEqual(failedStore.attempts, [], 'failed ledger writes block publication');
  assert.throws(() => withTikTokCustomComments(script.replace(marker, '')), /不兼容/);
});

test('short/empty videos, likes-only, daily caps, cancellation and precise mode retain their stopping rules', async () => {
  const short = await simulate({ sizes: [0, 1, 12] });
  assert.equal(short.result.works, 2);
  assert.equal(short.result.replies, 1);
  assert.equal((await simulate({ reply: false })).result.works, 2);
  assert.equal((await simulate({ likes: false, dailyCap: 2 })).result.replies, 2);
  assert.equal((await simulate({ dailyCap: 2 })).result.replies, 2);
  assert.equal((await simulate({ aborted: true })).result.works, 0);
  assert.equal((await simulate({ mode: 'precise', adapt: false, sizes: [8] })).result.replies, 8);
});

test('defaults, invalid inputs and incompatible remote scripts fail safely', () => {
  assert.deepEqual(commentLikeLimits({}), { commentVideoLimit: 10, commentRepliesPerVideo: 3 });
  for (const value of [0, -1, 1.5, Infinity, NaN, '3', 1001]) assert.throws(() => commentLikeLimits({ commentVideoLimit: value }));
  for (const value of [0, -1, 1.5, Infinity, NaN, '3', 301]) assert.throws(() => commentLikeLimits({ commentRepliesPerVideo: value }));
  assert.throws(() => withTikTokKeywordLimits(script.replace('await likeWorkHere(kurl);', 'await changed(kurl);')), /不兼容/);
});

test('real task store persists and reloads edited keyword limits in an isolated directory', async () => {
  const dir = await mkdtemp(path.join(tmpdir(), 'comment-limits-'));
  const bundled = await build({
    entryPoints: [new URL('../src/main/libs/matrix/taskStore.ts', import.meta.url).pathname.replace(/^\/([A-Z]:)/i, '$1')],
    bundle: true, write: false, platform: 'node', format: 'cjs',
    plugins: [{ name: 'isolate-task-services', setup(builder) {
      builder.onResolve({ filter: /\/(coworkLogger|matrixSchedule|folderPost)$/ }, (args) => ({ path: args.path, namespace: 'stub' }));
      builder.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({ contents: 'export const coworkLog=()=>{}, nextRunAt=()=>0, folderPostNextRunAt=()=>0, normSlots=x=>x;' }));
    } }],
  });
  const load = () => {
    const module = { exports: {} };
    runInNewContext(bundled.outputFiles[0].text, { module, exports: module.exports, require: createRequire(import.meta.url), process: { env: { NOOBCLAW_MATRIX_DIR: dir } } });
    return module.exports;
  };
  try {
    let store = load();
    const input = { platform: 'tiktok', type: 'comment_like', commentMode: 'keywords', accountIds: ['test'], frequency: 'once', commentVideoLimit: 7, commentRepliesPerVideo: 4 };
    const created = store.saveTask(input);
    assert.equal(created.ok, true);
    const edited = store.saveTask({ ...input, id: created.task.id, commentVideoLimit: 12, commentRepliesPerVideo: 2 });
    assert.equal(edited.ok, true);
    assert.equal(store.saveTask({ ...input, id: created.task.id, commentRepliesPerVideo: 0 }).ok, false);
    store = load();
    assert.equal(store.getTask(created.task.id).commentVideoLimit, 12);
    assert.equal(store.getTask(created.task.id).commentRepliesPerVideo, 2);
    const preserved = store.saveTask({ ...input, id: created.task.id, commentVideoLimit: undefined, commentRepliesPerVideo: undefined });
    assert.equal(preserved.task.commentVideoLimit, 12);
    assert.equal(preserved.task.commentRepliesPerVideo, 2);
    const customInput = { ...input, commentMode: 'custom', frequency: 'daily_random', commentPosts: [{ url: 'https://www.tiktok.com/@user/video/123', text: 'My own text 💜', sources: [{ sheet: 'Europe', row: 2, column: 6, comment: 1 }] }] };
    const selected = ['test'];
    const preview = store.previewCustomCommentAssignments(customInput, selected);
    assert.deepEqual(await readFile(path.join(dir, 'tasks.json'), 'utf8').then(text => JSON.parse(text)).then(tasks => tasks.map(task => task.commentMode)), ['keywords']);
    assert.equal(store.saveTask({ ...customInput, commentAssignmentPreview: preview }, []).error, 'comment_assignment_preview_stale');
    assert.equal(store.saveTask(customInput, []).error, 'comment_assignment_no_available_account');
    const custom = store.saveTask({ ...customInput, commentAssignmentPreview: preview }, selected);
    assert.equal(custom.ok, true, 'the workbook task can coexist with the previous task');
    assert.equal(custom.task.frequency, 'once');
    assert.equal(custom.task.commentDoReply, false);
    const reopened = load();
    const task = reopened.getTask(custom.task.id);
    assert.equal(task.commentPosts[0].text, 'My own text 💜');
    assert.deepEqual(JSON.parse(JSON.stringify(task.commentPosts[0].sources)), customInput.commentPosts[0].sources);
    assert.deepEqual(structuredClone(task.commentAssignmentPlan), structuredClone(preview.plan));
    const afterRestart = reopened.previewCustomCommentAssignments({ ...customInput, id: task.id }, []);
    assert.deepEqual(afterRestart.plan, task.commentAssignmentPlan);
    assert.equal(Object.values(afterRestart.plan.owners)[0], 'test');
    const changed = { version: 2, owners: { ...afterRestart.plan.owners, '["123","My own text 💜"]': 'replacement' } };
    reopened.setCustomCommentAssignmentPlan(task, changed);
    assert.deepEqual(structuredClone(load().getTask(task.id).commentAssignmentPlan), structuredClone(changed));
    const taskFile = path.join(dir, 'tasks.json');
    const legacyTasks = JSON.parse(await readFile(taskFile, 'utf8'));
    delete legacyTasks.find(item => item.id === task.id).commentAssignmentPlan;
    await writeFile(taskFile, JSON.stringify(legacyTasks));
    const legacyStore = load();
    const originalBytes = await readFile(taskFile, 'utf8');
    const legacyPreview = legacyStore.previewCustomCommentAssignments({ ...customInput, id: task.id }, selected);
    assert.equal(Object.values(legacyPreview.plan.owners)[0], 'test');
    assert.equal(await readFile(taskFile, 'utf8'), originalBytes);
    assert.equal(legacyStore.getTask(task.id).commentAssignmentPlan, undefined);
    const savedLegacy = legacyStore.saveTask({ ...customInput, id: task.id, commentAssignmentPreview: legacyPreview }, selected);
    assert.equal(savedLegacy.ok, true);
    assert.deepEqual(structuredClone(load().getTask(task.id).commentAssignmentPlan), structuredClone(legacyPreview.plan));
    assert.equal(store.saveTask({ ...customInput, id: custom.task.id, commentPosts: [{ url: 'https://tiktok.com.evil.test/@user/video/123', text: 'Wrong site' }] }).error, 'comment_like_invalid_posts');
  } finally { await rm(dir, { recursive: true, force: true }); }
});
