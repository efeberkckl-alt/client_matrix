import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const source = await readFile(new URL('../../src/main/libs/matrix/tiktokCustomComments.ts', import.meta.url), 'utf8');
const compiled = await transform(source, { loader: 'ts', format: 'esm' });
export const { withTikTokCustomComments } = await import(`data:text/javascript;base64,${Buffer.from(compiled.code).toString('base64')}`);
const scenario = await readFile(new URL('../fixtures/tiktok-comment-like.js', import.meta.url), 'utf8');
const marker = 'ctx.stepStart(1);\nif (!DO_LIKE && !DO_REPLY)';
const bridge = `_rawNavigate=ctx.open;_isHttpErrorPage=ctx.httpErrorPage || (async()=>false);getUrl=ctx.currentUrl;waitWithHold=jsleep=async()=>{};
captchaGate=ensureCommentsOpen=async()=>true;tkCdp=ctx.evaluate;cdpClickSel=ctx.click;_b=ctx.command;`;
const AsyncFunction = Object.getPrototypeOf(async function() {}).constructor;
export const fixtureBrowserScenario = scenario.replace(marker, bridge + marker);
const run = new AsyncFunction('ctx', withTikTokCustomComments(fixtureBrowserScenario));

class Element {
  constructor(tag = 'div', attrs = {}, text = '') { this.tag = tag; this.attrs = { ...attrs }; this.text = text; this.children = []; this.parentElement = null; this.style = { display: 'block', visibility: 'visible' }; this.disabled = false; }
  add(...nodes) { for (const node of nodes) { node.parentElement = this; this.children.push(node); } return this; }
  get textContent() { return this.text + this.children.map(n => n.textContent).join(''); }
  get id() { return this.attrs.id || ''; }
  getAttribute(name) { return this.attrs[name] ?? null; }
  setAttribute(name, value) { this.attrs[name] = String(value); }
  removeAttribute(name) { delete this.attrs[name]; }
  contains(node) { return this === node || this.children.some(n => n.contains(node)); }
  matches(selector) {
    return selector.split(',').some(part => {
      const tag = /^[\w-]+/.exec(part)?.[0];
      if (tag && tag !== this.tag) return false;
      for (const match of part.matchAll(/\[([\w-]+)(?:(\^=|\*=|=)"([^"]*)")?\]/g)) {
        const [, key, operator, value] = match, actual = this.getAttribute(key);
        if (actual === null) return false;
        if (operator === '=' && actual !== value || operator === '^=' && !actual.startsWith(value) || operator === '*=' && !actual.includes(value)) return false;
      }
      return true;
    });
  }
  querySelectorAll(selector) { return this.children.flatMap(n => [...(n.matches(selector) ? [n] : []), ...n.querySelectorAll(selector)]); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] ?? null; }
  closest(selector) { return this.matches(selector) ? this : this.parentElement?.closest(selector) ?? null; }
  getBoundingClientRect() { return { left: 10, top: 10, width: this.style.display === 'none' ? 0 : 100, height: 20 }; }
}

export function customCommentHarness(options = {}) {
  const state = structuredClone(options.saved || {}), attempts = [], charged = [], logs = [], commands = [], navigations = [], sleeps = [];
  let url = '', tick = 0, focusAt = Infinity, insertedAt = -Infinity, inserts = 0, selected = null, stopped = false;
  const body = new Element('body');
  const nav = new Element('a', { 'data-e2e': 'nav-profile', href: '/@' + (options.pageAuthor || 'runner') });
  const composer = new Element('section');
  const inputContainer = new Element('div', { 'data-e2e': 'comment-input' });
  const editor = new Element('div', { contenteditable: 'true', role: 'textbox' });
  const send = new Element('button', { 'data-e2e': 'comment-post' });
  const comments = new Element('section');
  body.add(nav, composer.add(inputContainer.add(editor), send), comments);
  if (options.hiddenFirst) {
    const hidden = new Element('div', { 'data-e2e': 'comment-input', hidden: '' }).add(new Element('div', { contenteditable: 'true' }));
    body.children.unshift(hidden); hidden.parentElement = body;
  }
  if (options.ambiguous) body.add(new Element('section').add(new Element('div', { 'data-e2e': 'comment-input', contenteditable: 'true' }), new Element('button', { 'data-e2e': 'comment-post' })));
  const published = [];
  const renderComments = () => {
    comments.children = [];
    for (const [index, p] of published.entries()) {
      if (p.url !== url || p.hidden) continue;
      comments.add(new Element('article', { 'data-comment-id': String(1000 + index) }).add(
        new Element('a', { href: '/@' + p.author }, p.author),
        new Element('p', { 'data-e2e': 'comment-level-1' }, p.text),
      ));
    }
  };
  const document = {
    body, activeElement: body,
    querySelector: selector => body.querySelector(selector), querySelectorAll: selector => body.querySelectorAll(selector),
    elementFromPoint: () => options.covered ? body : send,
    createRange: () => ({ selectNodeContents: node => { selected = node; } }),
  };
  const selection = { removeAllRanges() {}, addRange() {}, toString: () => selected?.textContent || '' };
  const update = () => {
    inputContainer.style.display = tick < (options.mountDelay || 0) ? 'none' : 'block';
    editor.style.display = inputContainer.style.display;
    if (tick >= focusAt) document.activeElement = editor;
    send.disabled = !editor.text || tick - insertedAt < (options.sendDelay || 0) || options.neverReadyFirst && inserts === 1;
  };
  const ctx = {
    browser: async () => ({}), navigate: async () => {},
    open: async value => {
      navigations.push(value);
      if (options.denied === value && options.deniedCode) throw Object.assign(Error('simulated denial'), { code: options.deniedCode });
      url = value; editor.text = options.userDraft || ''; document.activeElement = body; focusAt = Infinity; renderComments(); update(); },
    currentUrl: async () => options.wrongVideo ? 'https://www.tiktok.com/@other/video/999' : url,
    evaluate: async expression => { update(); return runInNewContext(expression, { document, window: { getSelection: () => selection }, getComputedStyle: e => e.style }).value; },
    click: async (selector, target) => {
      update();
      if (!document.querySelector(selector)) return false;
      if (selector.includes('custom-editor')) { focusAt = tick + (options.focusDelay || 0); update(); return true; }
      if (selector.includes('custom-send')) {
        assert.equal(target?.url, url, 'send must retain the validated input URL');
        assert.equal(target?.text, editor.text, 'send must constrain the exact comment text');
        assert.equal(target?.clickSelector, selector, 'send must constrain its actual button');
        if (options.clickFails) return false;
        const key = JSON.stringify([url.split('/').at(-1), editor.text]);
        assert.equal(options.readPending ? options.readPending(key) : state.custom_video_comments?.[key], 'pending');
        attempts.push({ url, text: editor.text });
        published.push({ url, text: editor.text, author: options.foreignEcho ? 'another' : 'runner', hidden: options.hideAll || options.hideFirst && attempts.length === 1 });
        editor.text = '';
        renderComments();
        return true;
      }
      return false;
    },
    command: async (name, params) => {
      commands.push(name);
      if (name === 'cdp_insert_text') {
        assert.equal(document.activeElement, editor, 'only insert into the focused comment editor');
        inserts++; insertedAt = tick;
        if (!options.inputFails || options.inputFailsWithText) editor.text = params.text;
        if (options.stopAfterInput) stopped = true;
        update();
        return { ok: !options.inputFails };
      }
      if (name === 'keypress' && params.key === 'Backspace') {
        assert.equal(selected, editor, 'clear only the selected program draft');
        editor.text = ''; update(); return { ok: true };
      }
      throw Error('Unexpected command: ' + name);
    },
    aiCall: async () => assert.fail('Custom comments must not call AI'),
    readState: name => structuredClone(state[name] || null),
    prepareCustomComment: (key, before) => {
      if (options.storageFails) return { ok: false };
      state.custom_video_comments ??= {};
      state.evidence ??= {};
      assert.equal(state.custom_video_comments[key], undefined, 'never prepare an existing send again');
      state.custom_video_comments[key] = 'pending';
      state.evidence[key] = structuredClone(before);
      return { ok: true };
    },
    confirmCustomComment: (key, after, source) => {
      if (options.storageFails) return { ok: false };
      const before = state.evidence[key];
      assert.equal(after.author, before.author);
      assert.ok(after.count > before.count || after.ids.some(id => !before.ids.includes(id)));
      assert.ok(['same_page', 'reopened'].includes(source));
      state.custom_video_comments[key] = 'confirmed';
      return { ok: true };
    },
    writeState: (name, value) => { if (options.storageFails) return { ok: false }; state[name] = structuredClone(value); return { ok: true }; },
    chargeAction: async action => { charged.push(action); return { ok: true }; },
    httpErrorPage: async () => url === options.denied,
    sleep: async (min, max) => { sleeps.push([min, max]); if (min >= 60000) await options.longSleep?.(min, () => { stopped = true; }); tick++; update(); },
    aborted: () => stopped,
    randInt: options.randInt || ((min, max) => Math.floor((min + max) / 2)),
    addActionCount() {}, stepStart() {}, stepDone() {}, stepLog(_step, _status, text) { logs.push(text); }, finish() {},
  };
  return {
    attempts, state, charged, logs, commands, editor, navigations, sleeps,
    browser: { open: ctx.open, currentUrl: ctx.currentUrl, evaluate: ctx.evaluate, click: ctx.click, command: ctx.command,
      sleep: ctx.sleep, aborted: ctx.aborted, httpErrorPage: ctx.httpErrorPage },
    revealAll: () => { for (const p of published) p.hidden = false; renderComments(); },
    run: posts => {
      const reviews = options.reconcile ? posts.flatMap(p => {
        const key = JSON.stringify([p.url.split('/').at(-1), p.text]);
        return state.custom_video_comments?.[key] === 'pending' && state.evidence?.[key] ? [{ ...p, before: state.evidence[key] }] : [];
      }) : [];
      const fresh = posts.filter(p => !reviews.some(r => r.url === p.url && r.text === p.text));
      return run({ ...ctx, task: { cl_custom_posts: fresh, cl_custom_pending: reviews, cl_custom_policy: options.policy, cl_do_like: false, cl_do_reply: false, selfDisplayId: 'runner' },
        manifest: { default_config: {}, risk_caps: { max_comments_per_day: options.dailyCap ?? 300 } } });
    },
  };
}
