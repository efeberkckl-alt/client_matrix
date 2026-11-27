import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { customCommentHarness, withTikTokCustomComments } from './helpers/customCommentHarness.mjs';
const post = (id, text) => ({ url: `https://www.tiktok.com/@source/video/${id}`, text });

test('a changed remote click contract stops before the custom scenario can run', async () => {
  const scenario = await readFile(new URL('./fixtures/tiktok-comment-like.js', import.meta.url), 'utf8');
  const knownClick = "try { await _b('cdp_click', { x: p.x, y: p.y }); return true; }";
  const patched = withTikTokCustomComments(scenario);
  assert.equal(patched.includes(knownClick), false);
  assert.throws(() => withTikTokCustomComments(scenario.replace(knownClick, "try { await _b('cdp_click', p); return true; }")), /点击接口不兼容/);
});

test('delayed editor, hidden duplicate, delayed focus and send button still publish each comment in order', async () => {
  const h = customCommentHarness({ mountDelay: 3, focusDelay: 3, sendDelay: 4, hiddenFirst: true });
  const posts = [post(1, 'first'), post(1, 'second'), post(2, 'third')];
  assert.equal((await h.run(posts)).status, 'done');
  assert.deepEqual(h.attempts, posts);
  assert.deepEqual(h.charged, [], 'successful prewritten comments never request an action debit');
});

test('a failed first send preflight clears its own draft so the next comment can publish', async () => {
  const h = customCommentHarness({ neverReadyFirst: true });
  const result = await h.run([post(1, 'first'), post(1, 'second')]);
  assert.equal(result.status, 'failed');
  assert.deepEqual(h.attempts, [post(1, 'second')]);
  assert.ok(h.commands.includes('keypress'));
  assert.equal(h.state.custom_video_comments[JSON.stringify(['1', 'first'])], undefined);
});

test('user drafts, ambiguous editors, covered send buttons, and wrong target do not publish', async () => {
  for (const options of [{ userDraft: 'my unfinished comment' }, { ambiguous: true }, { covered: true }, { wrongVideo: true }]) {
    const h = customCommentHarness(options);
    assert.equal((await h.run([post(1, 'first')])).status, 'failed');
    assert.deepEqual(h.attempts, []);
    if (options.userDraft) { assert.equal(h.editor.text, options.userDraft); assert.deepEqual(h.commands, []); }
  }
});

test('an unsuccessful input response prevents sending even if text appeared', async () => {
  for (const inputFailsWithText of [false, true]) {
    const h = customCommentHarness({ inputFails: true, inputFailsWithText });
    assert.equal((await h.run([post(1, 'first')])).status, 'failed');
    assert.deepEqual(h.attempts, []);
    assert.equal(h.editor.text, '');
  }
});

test('another author with the same text never confirms our send; pending reruns stay incomplete', async () => {
  const h = customCommentHarness({ foreignEcho: true });
  const posts = [post(1, 'same text')];
  assert.equal((await h.run(posts)).pending, 1);
  assert.equal((await h.run(posts)).status, 'failed');
  assert.deepEqual(h.attempts, posts);
  assert.deepEqual(h.charged, []);
});

test('unconfirmed clicks never repeat, storage failure blocks clicks, and account mismatch blocks input', async () => {
  const h = customCommentHarness({ clickFails: true });
  const posts = [post(1, 'first')];
  assert.equal((await h.run(posts)).pending, 1);
  assert.equal((await h.run(posts)).status, 'failed');
  assert.deepEqual(h.attempts, []);
  const failedStore = customCommentHarness({ storageFails: true });
  await assert.rejects(failedStore.run(posts), /记录保存失败/);
  assert.deepEqual(failedStore.attempts, []);
  const mismatch = customCommentHarness({ pageAuthor: 'wrong-user' });
  await assert.rejects(mismatch.run(posts), /账号不一致/);
  assert.deepEqual(mismatch.commands, []);
});

test('daily limits and cancellation retain explicit unfinished work', async () => {
  const posts = [post(1, 'first'), post(2, 'second')];
  const limited = customCommentHarness({ dailyCap: 1 });
  const result = await limited.run(posts);
  assert.equal(result.status, 'failed');
  assert.equal(result.remaining, 1);
  assert.deepEqual(limited.attempts, [posts[0]]);
  const cancelled = customCommentHarness({ stopAfterInput: true });
  assert.equal((await cancelled.run(posts)).status, 'failed');
  assert.deepEqual(cancelled.attempts, []);
});

test('reopening can confirm an earlier uncertain send without typing, clicking send, or charging again', async () => {
  const h = customCommentHarness({ hideAll: true, reconcile: true });
  const posts = [post(1, 'late comment')];
  assert.equal((await h.run(posts)).pending, 1);
  assert.deepEqual(h.attempts, posts);
  const commands = h.commands.length;
  assert.equal((await h.run(posts)).pending, 1, 'no evidence must keep the record unresolved');
  h.revealAll();
  const reviewed = await h.run(posts);
  assert.equal(reviewed.status, 'done');
  assert.equal(reviewed.reconciled, 1);
  assert.equal(reviewed.sent, 0);
  assert.equal(h.commands.length, commands);
  assert.deepEqual(h.attempts, posts);
  assert.deepEqual(h.charged, []);
});

test('custom navigation uses one home warmup, or one per video with the rollback setting', async () => {
  const posts = [post(41, 'first'), post(41, 'second'), post(42, 'third'), post(43, 'fourth')];
  const home = 'https://www.tiktok.com/';
  for (const [mode, expected] of [
    ['once', [home, posts[0].url, posts[2].url, posts[3].url]],
    ['per_video', [home, posts[0].url, home, posts[2].url, home, posts[3].url]],
  ]) {
    const h = customCommentHarness({ policy: { homeWarmup: mode, accountLimit: 20, restEvery: 6 } });
    assert.equal((await h.run(posts)).status, 'done');
    assert.deepEqual(h.navigations, expected);
    assert.deepEqual(h.attempts, posts);
    console.log('navigation fixture', JSON.stringify({ mode, homeVisits: h.navigations.filter(u => u === home).length, actual: h.navigations }));
  }
});

test('a navigation change fails closed; explicit 403/429 and untyped error pages never retry', async () => {
  const scenario = await readFile(new URL('./fixtures/tiktok-comment-like.js', import.meta.url), 'utf8');
  assert.throws(() => withTikTokCustomComments(scenario.replace('async function _navigate(url)', 'async function _navigateV2(url)')), /导航接口不兼容/);
  const posts = [post(46, 'denied'), post(47, 'not visited')];
  for (const denial of [{ denied: 'https://www.tiktok.com/', deniedCode: 'http_403' },
    { denied: posts[0].url, deniedCode: 'http_429' }, { denied: posts[0].url }]) {
    const h = customCommentHarness(denial);
    await assert.rejects(h.run(posts), /simulated denial|http_403_blocked/);
    assert.equal(h.navigations.filter(url => url === denial.denied).length, 1);
    assert.ok(!h.navigations.includes(posts[1].url));
    assert.equal(h.attempts.length, 0);
  }
});

