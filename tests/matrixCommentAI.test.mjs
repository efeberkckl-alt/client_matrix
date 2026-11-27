import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { renderToStaticMarkup } from 'react-dom/server';
import React from 'react';
import ts from 'typescript';
import { transform } from 'esbuild';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const compiled = await transform(read('../src/main/libs/matrix/commentAI.ts'), { loader: 'ts', format: 'cjs' });
const promptCode = await transform(read('../src/main/libs/matrix/tiktokCommentPrompts.ts'), { loader: 'ts', format: 'esm' });
const promptHelpers = await import(`data:text/javascript;base64,${Buffer.from(promptCode.code).toString('base64')}`);
const runner = read('../src/main/libs/matrix/engageRunner.ts');
const file = ts.createSourceFile('runner.ts', runner, ts.ScriptTarget.Latest, true);
const makeAiCall = file.statements.filter((node) => ts.isFunctionDeclaration(node)
  && ['makeAiCall', 'fetchEngageJson', 'abortableSleep'].includes(node.name?.text)).map((node) => node.getText(file)).join('\n');
const pack = { prompts: { comment_composer: 'Write a specific comment about this video based on the supplied context.', reply_composer: 'Write a short reply to the supplied comment.', binge_matcher: 'Judge whether this video matches the niche.' } };
const config = { source: 'custom', baseUrl: 'https://api.deepseek.com', apiKey: 'private-test-key', model: 'deepseek-chat', apiFormat: 'openai' };

async function harness(fetch, setting = config, taskType = 'lead_engage', requestPack = pack, leadFunnel) {
  const module = { exports: {} };
  const costs = [];
  const context = {
    ...promptHelpers,
    module, exports: module.exports, fetch, URL, AbortController, AbortSignal, setTimeout, clearTimeout,
    getMatrixCommentAIConfig: () => setting,
    baseUrl: () => 'https://official.invalid',
    sleep: async () => {},
  };
  runInNewContext(compiled.code, context);
  Object.assign(context, module.exports);
  const source = await transform(`${makeAiCall}\nmodule.exports = makeAiCall;`, { loader: 'ts', format: 'cjs' });
  runInNewContext(source.code, context);
  const call = context.module.exports(requestPack, 'official-login-token', () => {}, (...args) => costs.push(args), undefined, taskType, leadFunnel);
  return { call, costs, ...module.exports };
}

test('real adapter sends named/raw comments, language retries and funnel rewrites with full context to the custom model only', async () => {
  const requests = [];
  const h = await harness(async (url, options) => {
    requests.push({ url: String(url), options, body: JSON.parse(options.body) });
    return Response.json({ choices: [{ message: { content: 'A relevant comment' } }], _noobclaw: { billableTokens: 999 } });
  });
  const input = JSON.stringify({ author_name: 'Alice', video_desc: 'Handmade bowl', top_comments: '- Beautiful', keyword: 'pottery', user_prompt: 'Be concise', language_hint: 'English' });
  assert.equal(await h.call('comment_composer', input, undefined, { expectJson: false, model: 'noobclawai-chat' }), 'A relevant comment');
  await h.call('__raw__', pack.prompts.comment_composer + '\nEnglish only.', input, { expectJson: false });
  await h.call('__raw__', 'Rewrite the lead phrase without changing its meaning.', JSON.stringify({ task: 'rewrite_lead_phrase', funnel_phrase: 'My shop' }), { expectJson: false });
  await h.call('reply_composer', { comment_text: 'Where?', video_desc: 'Bowl' }, undefined, { expectJson: false });
  await h.call('__raw__', 'Return JSON with note_reply and comment_replies.', JSON.stringify({ task: 'reply_to_xhs_article_and_comments', article: { title: 'Bowl' }, comment_reply_targets: [] }));
  for (const request of requests) {
    assert.equal(request.url, 'https://api.deepseek.com/v1/chat/completions');
    assert.equal(request.options.headers.Authorization, 'Bearer private-test-key');
    assert.equal(request.body.model, 'deepseek-chat');
    assert.equal(request.body.stream, false);
  }
  assert.equal(requests[0].body.messages[0].content, pack.prompts.comment_composer);
  assert.equal(requests[0].body.messages[1].content, input);
  assert.equal(requests[1].body.messages[1].content, input);
  assert.equal(requests[3].body.messages[1].content, '{"comment_text":"Where?","video_desc":"Bowl"}');
  assert.equal(requests[4].body.response_format.type, 'json_object');
  assert.equal(h.costs.length, 0, 'custom provider cannot report official credit charges');
});

test('optimized TikTok prompts use either provider, preserve payloads and normalize SKIP before the scenario sees it', async () => {
  for (const type of ['lead_engage', 'comment_like']) {
    const localPack = promptHelpers.withTikTokCommentPrompts({ ...pack, orchestrator: 'test' }, 'tiktok', type);
    const name = localPack.clientCommentPromptName;
    const payload = '{"video_desc":"Only a caption","user_prompt":"真实业务信息"}';
    for (const source of ['noobclaw', 'custom']) {
      let response = '能看出你在认真记录这个过程，最难的是哪一步？';
      const calls = [];
      const h = await harness(async (url, options) => {
        const body = JSON.parse(options.body);
        calls.push({ url: String(url), body });
        return Response.json({ choices: [{ message: { content: response } }] });
      }, { ...config, source }, type, localPack, type === 'lead_engage' ? { phrase: '看主页', probability: 0 } : undefined);
      assert.equal(await h.call(name, payload, undefined, { expectJson: false }), response);
      response = '"SKIP"';
      assert.equal(await h.call('__raw__', localPack.prompts[name] + '\nEnglish only.', payload, { expectJson: false }), '');
      assert.equal(calls.length, 2, 'no second CTA rewrite or fallback');
      for (const call of calls) {
        assert.equal(call.body.messages[1].content, payload);
        assert.ok(call.body.messages[0].content.startsWith(localPack.prompts[name]));
        assert.equal(call.url, source === 'custom' ? 'https://api.deepseek.com/v1/chat/completions' : 'https://official.invalid/api/ai/chat/completions');
        if (type === 'lead_engage') assert.ok(call.body.messages[0].content.includes('本条不允许主页引导'));
      }
    }
  }
});

test('buyer classification uses the selected comment provider and preserves structured ranks', async () => {
  const localPack = promptHelpers.withTikTokCommentPrompts({ ...pack, orchestrator: 'test' }, 'tiktok', 'comment_like');
  localPack.prompts.comment_intent = 'Classify purchase intent; return JSON.';
  for (const source of ['noobclaw', 'custom']) {
    const h = await harness(async (url, options) => {
      assert.equal(String(url), source === 'custom' ? 'https://api.deepseek.com/v1/chat/completions' : 'https://official.invalid/api/ai/chat/completions');
      assert.equal(JSON.parse(options.body).response_format.type, 'json_object');
      return Response.json({ choices: [{ message: { content: '{"items":[{"id":0,"rank":2}]}' } }] });
    }, { ...config, source }, 'comment_like', localPack);
    const result = await h.call('comment_intent', '{"comments":[{"id":0,"text":"Nak beli kat mana?"}]}');
    assert.equal(result.items[0].rank, 2, 'classification must not go through publication text sanitization');
  }
});

test('default mode, keyword expansion, niche matching and unrelated tasks keep the official route and charging', async () => {
  const requests = [];
  const fetch = async (url, options) => {
    requests.push({ url: String(url), body: JSON.parse(options.body), headers: options.headers });
    return Response.json({ choices: [{ message: { content: 'yes' } }], _noobclaw: { billableTokens: 2, costUsd: 0.001 } });
  };
  for (const setting of [null, { ...config, source: 'noobclaw' }]) {
    const h = await harness(fetch, setting);
    await h.call('comment_composer', '{}', undefined, { expectJson: false });
    assert.deepEqual(h.costs, [[2, 0.001]]);
  }
  const h = await harness(fetch);
  await h.call('__raw__', 'Expand the search keywords', '{"seed":["pottery"]}', { expectJson: false });
  await h.call('__raw__', pack.prompts.binge_matcher, undefined, { expectJson: false });
  await h.call('binge_matcher', '{}', undefined, { expectJson: false });
  const report = await harness(fetch, config, 'report');
  await report.call('comment_composer', '{}', undefined, { expectJson: false });
  for (const request of requests) {
    assert.equal(request.url, 'https://official.invalid/api/ai/chat/completions');
    assert.equal(request.headers.Authorization, 'Bearer official-login-token');
  }
  assert.equal(h.costs.length, 3);
});

test('custom mode supports saved Anthropic format and complete endpoints; errors and abort never fall back', async () => {
  let count = 0;
  const h = await harness(async (url, options) => {
    count++;
    assert.equal(String(url), 'https://provider.invalid/anthropic/v1/messages');
    assert.equal(options.headers['x-api-key'], config.apiKey);
    assert.equal(options.headers.Authorization, undefined);
    assert.equal(JSON.parse(options.body).system, pack.prompts.reply_composer);
    return Response.json({ content: [{ type: 'thinking', thinking: 'hidden' }, { type: 'text', text: 'A reply' }] });
  }, { ...config, apiFormat: 'anthropic', baseUrl: 'https://provider.invalid/anthropic/v1/messages' });
  assert.equal(await h.call('reply_composer', '{}', undefined, { expectJson: false }), 'A reply');
  assert.equal(count, 1);
  for (const status of [401, 402, 400]) {
    const failed = await harness(async (url) => {
      assert.equal(String(url), 'https://api.deepseek.com/v1/chat/completions');
      return Response.json({ error: 'private-test-key' }, { status });
    });
    await assert.rejects(failed.call('comment_composer', '{}', undefined, { expectJson: false }), (error) => error.message.includes(String(status)) && !error.message.includes(config.apiKey));
  }
  const invalid = await harness(() => assert.fail('invalid config must not make a request'), { ...config, apiKey: '' });
  await assert.rejects(invalid.call('reply_composer', '{}', undefined, { expectJson: false }), /API Key/);
  const broken = await harness(async () => Response.json({ choices: [{ message: { reasoning_content: 'do not publish this' } }] }));
  await assert.rejects(broken.call('comment_composer', '{}', undefined, { expectJson: false }), /未返回评论正文/);
  const controller = new AbortController();
  controller.abort();
  const module = { exports: {} };
  runInNewContext(compiled.code, { module, exports: module.exports, URL, AbortSignal, setTimeout, clearTimeout, fetch: () => assert.fail('aborted call') });
  await assert.rejects(module.exports.requestCommentAI(config, 'system', 'user', false, controller.signal));
  let attempts = 0;
  const waits = [];
  const retryModule = { exports: {} };
  runInNewContext(compiled.code, { module: retryModule, exports: retryModule.exports, URL, AbortSignal, clearTimeout,
    setTimeout: (fn, ms) => { waits.push(ms); queueMicrotask(fn); return 1; },
    fetch: async () => {
      attempts++;
      return attempts < 3 ? Response.json({}, { status: 429, headers: { 'Retry-After': '7' } })
        : Response.json({ choices: [{ message: { content: 'Recovered reply' } }] });
    },
  });
  assert.equal(await retryModule.exports.requestCommentAI(config, 'system', 'user', false), 'Recovered reply');
  assert.equal(attempts, 3);
  assert.deepEqual(waits, [7000, 7000]);
});

test('settings renders both sources, loads saved configurations as a copy, and saves only the comment setting', async () => {
  const module = { exports: {} };
  const require = createRequire(import.meta.url);
  const uiSource = await transform(read('../src/renderer/components/MatrixCommentAISettings.tsx'), { loader: 'tsx', format: 'cjs', jsx: 'automatic' });
  runInNewContext(uiSource.code, { module, exports: module.exports, require });
  const Component = module.exports.default;
  const providers = { deepseek: { enabled: true, apiKey: 'saved-secret', baseUrl: 'https://saved.invalid', apiFormat: 'openai', models: [{ id: 'saved-model' }] } };
  let value;
  const props = { value: config, onChange: (next) => { value = next; }, providers, isEn: false };
  const html = renderToStaticMarkup(React.createElement(Component, props));
  assert.ok(html.includes('使用 NoobClaw 服务器的 AI'));
  assert.ok(html.includes('使用我配置的 AI'));
  assert.ok(html.includes('type="password"'));
  const tree = Component(props);
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (node.props?.id === 'comment-ai-load-provider') node.props.onChange({ target: { value: 'deepseek' } });
    React.Children.forEach(node.props?.children, walk);
  };
  walk(tree);
  assert.equal(value.apiKey, 'saved-secret');
  value.apiKey = 'changed';
  assert.equal(providers.deepseek.apiKey, 'saved-secret');

  const settings = read('../src/renderer/components/Settings.tsx');
  const sourceFile = ts.createSourceFile('settings.tsx', settings, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let submit;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(sourceFile) === 'handleSubmit') submit = node.initializer.getText(sourceFile);
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
  const { outputText } = ts.transpileModule(`(${submit})({preventDefault(){}});`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  const saved = [];
  const didSaveRef = {};
  let closed = false;
  await runInNewContext(outputText, { URL, activeTab: 'commentAI', matrixCommentAI: config,
    setIsSaving() {}, setError(error) { if (error) assert.fail(error); }, didSaveRef,
    configService: { updateConfig: async (patch) => saved.push(patch) }, onClose: () => { closed = true; },
  });
  assert.deepEqual(Object.keys(saved[0]), ['matrixCommentAI']);
  assert.equal(saved[0].matrixCommentAI, config);
  assert.equal(closed, true);
  assert.equal(didSaveRef.current, true);
});

test('concurrent sidecar startup shares one store and failed initialization can be retried', async () => {
  const source = read('../src/main/sidecar-server.ts');
  const file = ts.createSourceFile('sidecar.ts', source, ts.ScriptTarget.Latest, true);
  const getter = file.statements.find((node) => ts.isFunctionDeclaration(node) && node.name?.text === 'getRunner').getText(file);
  const { outputText } = ts.transpileModule(`${getter}\ngetRunner;`, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  let creations = 0;
  let finish;
  const context = { runnerInstance: null, runnerInitPromise: null, initializeRunner: async () => {
    creations++;
    await new Promise((resolve) => { finish = resolve; });
    context.runnerInstance = { store: new Map() };
    return context.runnerInstance;
  } };
  const getRunner = runInNewContext(outputText, context);
  const callers = Array.from({ length: 20 }, () => getRunner());
  assert.equal(creations, 1);
  finish();
  const runners = await Promise.all(callers);
  runners[0].store.set('commentAI', 'custom');
  assert.ok(runners.every((runner) => runner === runners[0] && runner.store.get('commentAI') === 'custom'));
  assert.equal(await getRunner(), runners[0]);
  context.runnerInstance = null;
  context.initializeRunner = async () => { throw new Error('temporary failure'); };
  await assert.rejects(getRunner(), /temporary failure/);
  context.initializeRunner = async () => ({ recovered: true });
  assert.equal((await getRunner()).recovered, true);
});
