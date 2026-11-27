import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';

const { code } = await transform(await readFile(new URL('../src/main/libs/matrix/tiktokCommentPrompts.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'esm' });
const { LEAD_COMMENT_FIELDS, REPLY_COMMENT_FIELDS, withTikTokCommentPrompts, prepareTikTokLeadCommentTask, publishableTikTokComment } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

test('the two user-protected field descriptions are byte-for-byte unchanged and only the two TikTok scenarios receive overrides', () => {
  assert.equal(LEAD_COMMENT_FIELDS, `你收到的 user message 是一段 JSON,字段说明:
- author_name: 视频作者名
- video_desc: 视频文案/描述(权威信息源,务必基于此判断视频内容主题)
- top_comments: 置顶评论原文(供你感知语言+氛围,不要复述,可能为空字符串)
- track: 赛道(感知氛围,不要写进评论)
- keyword: 本次搜索词(感知氛围,不要写进评论)
- user_prompt: 用户给的口味提示(可参考可忽略)
- language_hint: 语言提示(指定了具体语言时必须照做,见规则 3)`);
  assert.equal(REPLY_COMMENT_FIELDS, `你收到的 user message 是一段 JSON,字段说明:
- comment_text: 你要回复的那条留言原文(最重要,回复必须接着它说)
- commenter_name: 留言者昵称(感知用,不要写进回复,也不要 @ 他)
- video_desc: 视频文案/描述(背景信息,可能为空)
- persona: 你的人设(可能为空;有的话用这个身份的口吻自然地说话,但绝不打广告、不自我介绍、不引流)
- language_hint: 语言提示`);
  const pack = { orchestrator: 'unchanged script', config: { behavior: {} }, prompts: { comment_composer: 'old', reply_composer: 'old reply', binge_matcher: 'same matcher' } };
  const lead = withTikTokCommentPrompts(pack, 'tiktok', 'lead_engage');
  const reply = withTikTokCommentPrompts(pack, 'tiktok', 'comment_like');
  assert.ok(lead.prompts.comment_composer.includes(LEAD_COMMENT_FIELDS));
  assert.ok(reply.prompts.reply_composer.includes(REPLY_COMMENT_FIELDS));
  assert.equal(lead.prompts.reply_composer, pack.prompts.reply_composer);
  assert.equal(reply.prompts.comment_composer, pack.prompts.comment_composer);
  assert.equal(lead.config, pack.config);
  assert.equal(lead.orchestrator, pack.orchestrator);
  assert.equal(pack.prompts.comment_composer, 'old', 'do not mutate the remote response');
  for (const [platform, type] of [['douyin', 'lead_engage'], ['tiktok', 'engage'], ['tiktok', 'reply_fan'], ['xhs', 'comment_like']]) assert.equal(withTikTokCommentPrompts(pack, platform, type), pack);
  assert.equal(withTikTokCommentPrompts(null, 'tiktok', 'lead_engage'), null);
});

test('complete AI comments suppress duplicate tails, preserve business/persona input and leave explicit lead-only mode and other tasks alone', () => {
  const savedTask = { persona: '店主；主页有产品实拍', comment_prompt: '简短、自然', funnel_phrase: '看主页', funnel_probability: 75, ai_comment: true, max_comments: 50 };
  const task = structuredClone(savedTask);
  assert.deepEqual(prepareTikTokLeadCommentTask('tiktok', 'lead_engage', task), { phrase: '看主页', probability: 75 });
  assert.equal(task.funnel_probability, 0);
  assert.ok(task.comment_prompt.includes(savedTask.persona));
  assert.ok(task.comment_prompt.includes(savedTask.comment_prompt));
  assert.equal(task.max_comments, 50);
  assert.equal(savedTask.funnel_probability, 75);
  for (const [platform, type, ai] of [['tiktok', 'comment_like', true], ['douyin', 'lead_engage', true], ['tiktok', 'lead_engage', false]]) {
    const copy = { ...savedTask, ai_comment: ai };
    const before = structuredClone(copy);
    assert.equal(prepareTikTokLeadCommentTask(platform, type, copy), undefined);
    assert.deepEqual(copy, before);
  }
  for (const value of ['', 'SKIP', '"SKIP"', '```text\nSKIP\n```', '{"comment":"hello"}', 'one\ntwo', 'x'.repeat(151)]) assert.equal(publishableTikTokComment(value), '');
  assert.equal(publishableTikTokComment('“这一步你试了几次才成功？”'), '这一步你试了几次才成功？');
});

test('real TikTok lead scenario skips without typing, posting, action charging or a second rewrite; valid comments still publish', async () => {
  const script = await readFile(new URL('fixtures/tiktok-lead-engage.js', import.meta.url), 'utf8');
  const marker = "await ensureTaskTabOpenedOnce('tiktok', 'main', 'https://www.tiktok.com/');";
  assert.equal(script.split(marker).length, 2);
  const injected = `
    FORCED_LANG = 'zh';
    ensureCommentsOpen = async function() {};
    getTexts = async function() { return ['具体的原评论']; };
    rectOf = async function() { return {x: 10, y: 20}; };
    cdpClickSel = async function(sel) { ctx.clicks.push(sel); return true; };
    jsleep = async function() {};
    _b = async function(command, params) {
      if (command === 'cdp_insert_text') ctx.typed.push(params.text);
      return { result: ctx.typed.length ? ctx.typed[0].length : 0 };
    };
    return await tryComment('记录第一次完成手工作品', '作者', 2);
  `;
  const run = new (Object.getPrototypeOf(async function() {}).constructor)('ctx', script.replace(marker, injected));
  for (const output of ['SKIP', '', '第一次完成后，你最想改进哪一步？']) {
    const calls = [];
    const task = { seed_accounts: ['https://www.tiktok.com/@source/video/1'], ai_comment: true, comment_prompt: '店主；主页有实拍', funnel_phrase: '看主页', funnel_probability: 100, max_comments: 50, max_leads: 500 };
    prepareTikTokLeadCommentTask('tiktok', 'lead_engage', task);
    const local = withTikTokCommentPrompts({ orchestrator: script, prompts: {} }, 'tiktok', 'lead_engage');
    const ctx = { task, manifest: { default_config: {} }, config: {}, clicks: [], typed: [],
      browser: async () => ({}), navigate: async () => {}, sleep: async () => {},
      aborted: () => false, report() {}, stepStart() {}, stepLog() {}, stepDone() {}, finish() {}, setActionTargets() {},
      readState: () => null, writeState: () => {},
      getPrompt: (name) => local.prompts[name],
      aiCall: async (name, prompt) => { calls.push({ name, prompt }); return publishableTikTokComment(output); },
      chargeAction: () => assert.fail('skip must never charge a social action'),
    };
    const result = await run(ctx);
    assert.equal(calls.length, 1, 'no separate funnel rewrite');
    assert.ok(calls[0].prompt.startsWith(local.prompts.comment_composer));
    if (!output || output === 'SKIP') {
      assert.equal(result.ok, false);
      assert.equal(ctx.typed.length, 0);
      assert.equal(ctx.clicks.length, 0);
    } else {
      assert.equal(result.ok, true);
      assert.deepEqual(ctx.typed, [output]);
      assert.equal(ctx.clicks.length, 2);
    }
  }
});
