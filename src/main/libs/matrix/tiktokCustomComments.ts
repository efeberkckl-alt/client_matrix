export const CUSTOM_COMMENT_LEDGER = 'custom_video_comments';

// Reuse the scenario's navigation, comment panel and daily limit.
const runtime = String.raw`
  const posts = task.cl_custom_posts;
  const policy = task.cl_custom_policy || { homeWarmup: 'once', accountLimit: 20, restEvery: 6, restMinMinutes: 2, restMaxMinutes: 4 };
  const round = task.cl_custom_round || { attempted: 0, confirmed: 0, restedAt: 0 };
  let homeWarm = task.cl_custom_startup_home === true, firstTarget = true;
  async function openCustomTarget(url) {
    const warm = !homeWarm || (!firstTarget && policy.homeWarmup === 'per_video');
    const reusePreflight = firstTarget && task.cl_custom_preflight === url && await onTarget(url);
    firstTarget = false;
    if (reusePreflight) return;
    await _navigate(url, warm ? 'custom_with_home' : 'custom_direct');
    homeWarm = true;
  }
  const isDenial = error => ['forbidden', 'rate_limited', 'http_403', 'http_429'].includes(error?.code) || error?.message === 'http_403_blocked';
  const ledgerName = '__LEDGER__';
  const ledger = ctx.readState(ledgerName, { strict: true }) ?? Object.create(null);
  if (typeof ledger !== 'object' || Array.isArray(ledger) || Object.values(ledger).some(s => s !== 'pending' && s !== 'confirmed')) {
    throw new Error('自定义评论记录损坏，本次未执行');
  }
  const editor = '[data-nc-custom-editor="active"]';
  const send = '[data-nc-custom-send="active"]';
  const pageValue = (body, fallback) => tkCdp('(function(){return {ok:true,value:(' + body + ')};})()', fallback);
  function probeComposer() {
    const visible = e => {
      if (!e || e.closest('[hidden],[aria-hidden="true"]')) return false;
      const r = e.getBoundingClientRect(), style = getComputedStyle(e);
      return r.width > 0 && r.height > 0 && style.display !== 'none' && style.visibility !== 'hidden';
    };
    for (const old of document.querySelectorAll('[data-nc-custom-editor],[data-nc-custom-send]')) {
      old.removeAttribute('data-nc-custom-editor'); old.removeAttribute('data-nc-custom-send');
    }
    const candidates = [];
    for (const e of document.querySelectorAll('[contenteditable="true"]')) {
      if (!visible(e) || e.getAttribute('aria-disabled') === 'true') continue;
      let container = e.closest('[data-e2e="comment-input"],[data-e2e="comment-input-container"]');
      let button = null, parent = e.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 6; depth++, parent = parent.parentElement) {
        const buttons = [...parent.querySelectorAll('[data-e2e="comment-post"]')].filter(visible);
        const editors = [...parent.querySelectorAll('[contenteditable="true"]')].filter(visible);
        if (editors.length > 1) break;
        if (buttons.length === 1) { button = buttons[0]; container = parent; break; }
      }
      if (container) candidates.push({ e, button });
    }
    if (candidates.length !== 1) return { reason: candidates.length ? 'ambiguous_editor' : 'editor_not_ready' };
    const { e, button } = candidates[0];
    e.setAttribute('data-nc-custom-editor', 'active');
    let ready = !!button && !button.disabled && button.getAttribute('aria-disabled') !== 'true';
    if (ready) {
      const r = button.getBoundingClientRect();
      const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      ready = hit === button || button.contains(hit);
    }
    if (button) button.setAttribute('data-nc-custom-send', 'active');
    return { reason: '', text: (e.textContent || '').replace(/\u200b/g, '').trim(), focused: e.contains(document.activeElement), sendReady: ready };
  }
  const snapshot = () => pageValue('(' + probeComposer.toString() + ')()', null);
  async function waitComposer(predicate, attempts = 20) {
    for (let attempt = 0; attempt < attempts && !shouldStop(); attempt++) {
      const state = await snapshot();
      if (state && !state.reason && predicate(state)) return state;
      await ctx.sleep(250);
    }
    return null;
  }
  function ownComments(text, author) {
    const matches = [];
    for (const node of document.querySelectorAll('[data-e2e="comment-level-1"]')) {
      if ((node.textContent || '').replace(/\u200b/g, '').trim() !== text) continue;
      let parent = node.parentElement;
      for (let depth = 0; parent && parent !== document.body && depth < 6; depth++, parent = parent.parentElement) {
        if (parent.querySelectorAll('[data-e2e="comment-level-1"]').length !== 1) break;
        const link = [...parent.querySelectorAll('a[href*="/@"]')].find(a => /\/@[\w.-]+\/?(?:[?#].*)?$/.test(a.getAttribute('href') || ''));
        if (!link) continue;
        const handle = /\/@([\w.-]+)/.exec(link.getAttribute('href') || '')?.[1]?.toLowerCase();
        if (handle === author) {
          const identified = node.closest('[data-comment-id],[id^="comment-"]') || parent.querySelector('[data-comment-id]');
          matches.push(identified?.getAttribute('data-comment-id') || identified?.id || '');
        }
        break;
      }
    }
    return { count: matches.length, ids: matches.filter(Boolean) };
  }
  const readOwn = (text, author) => pageValue('(' + ownComments.toString() + ')(' + JSON.stringify(text) + ',' + JSON.stringify(author) + ')', null);
  async function currentAuthor() {
    const known = String(task.selfDisplayId || '').replace(/^@/, '').toLowerCase();
    const observed = await pageValue('(function(){const n=document.querySelector(\'[data-e2e="nav-profile"]\');const a=n?.matches("a[href]")?n:n?.querySelector("a[href]");return /\\/@([\\w.-]+)/.exec(a?.getAttribute("href")||"")?.[1]?.toLowerCase()||"";})()', '');
    if (known && observed && known !== observed) throw new Error('当前页面账号与任务账号不一致');
    const author = observed || known;
    if (!/^[\w.-]+$/.test(author)) throw new Error('无法确认执行账号的 TikTok 用户名，本次未发送');
    return author;
  }
  function matchesTarget(current, url) {
    return /^https:\/\/(?:(?:m|www)\.)?tiktok\.com\/@[\w.-]+\/(?:video|photo)\/\d+\/?(?:[?#][^\s]*)?$/.test(current)
      && videoIdOf(current) === videoIdOf(url);
  }
  const onTarget = async url => matchesTarget(await getUrl(), url);
  function prepare(key, author, before) {
    if (typeof ctx.prepareCustomComment !== 'function' || ctx.prepareCustomComment(key, { author, ...before })?.ok !== true) throw new Error('自定义评论记录保存失败');
    ledger[key] = 'pending';
  }
  function confirm(key, author, after, source) {
    if (typeof ctx.confirmCustomComment !== 'function' || ctx.confirmCustomComment(key, { author, ...after }, source)?.ok !== true) throw new Error('自定义评论确认记录保存失败');
    ledger[key] = 'confirmed';
  }

  let draft = null;
  async function clearOwnDraft(post) {
    const state = await snapshot();
    if (!state || state.reason) return false;
    if (!state.text) return true;
    if (!draft || draft.video !== videoIdOf(post.url) || draft.text !== state.text || !(await onTarget(post.url))) return false;
    if (!(await cdpClickSel(editor)) || !(await waitComposer(s => s.focused && s.text === draft.text))) return false;
    const selected = await pageValue('(function(){const e=document.querySelector(' + JSON.stringify(editor) + ');if(!e||!e.contains(document.activeElement)||(e.textContent||"").replace(/\\u200b/g,"").trim()!==' + JSON.stringify(draft.text) + ')return false;const r=document.createRange();r.selectNodeContents(e);const s=window.getSelection();s.removeAllRanges();s.addRange(r);return s.toString().replace(/\\u200b/g,"").trim()===' + JSON.stringify(draft.text) + ';})()', false);
    if (!selected || shouldStop() || !(await onTarget(post.url))) return false;
    const result = await _b('keypress', { key: 'Backspace', target: { selector: editor, url: await getUrl(), text: draft.text } });
    if (result?.ok !== true || !(await waitComposer(s => s.text === ''))) return false;
    draft = null;
    return true;
  }

  let lastUrl = '', sent = 0, notSent = 0, skipped = 0, pending = 0;
  const reviews = task.cl_custom_pending || [];
  let unresolvedReviews = reviews.length, reconciled = 0;
  for (const review of reviews) {
    if (shouldStop()) break;
    const key = JSON.stringify([videoIdOf(review.url), review.text]);
    if (ledger[key] !== 'pending') { unresolvedReviews--; continue; }
    try {
      await openCustomTarget(review.url);
      await waitWithHold(beh.watch_open_pause || [5000, 10000]);
    } catch (error) { if (isDenial(error)) throw error; ctx.stepLog(1, 'warn', '待核验视频打不开，保留原记录 · ' + review.url); continue; }
    if (shouldStop()) break;
    if (!(await captchaGate(1))) throw new Error('验证码未完成');
    if (!(await onTarget(review.url)) || !(await ensureCommentsOpen())) continue;
    const author = await currentAuthor();
    if (author !== review.before.author) { ctx.stepLog(1, 'warn', '原评论账号与当前账号不一致，保留待核验 · ' + review.url); continue; }
    let stable = 0, proof = null;
    for (let attempt = 0; attempt < 6 && !shouldStop(); attempt++) {
      const after = await readOwn(review.text, author);
      if (!(await onTarget(review.url))) break;
      const newer = after && (after.count > review.before.count || after.ids.some(id => !review.before.ids.includes(id)));
      stable = newer ? stable + 1 : 0;
      if (stable >= 2) { proof = after; break; }
      await ctx.sleep(1500);
    }
    if (proof) {
      confirm(key, author, proof, 'reopened');
      unresolvedReviews--; reconciled++;
      ctx.stepLog(1, 'running', '已核实上次评论，未重新发送 · ' + review.url + ' · ' + review.text);
    } else ctx.stepLog(1, 'warn', '尚无足够新评论证据，保留待核验且不重发 · ' + review.url + ' · ' + review.text);
  }
  let dailyLimitReached = false;
  for (const post of posts) {
    if (shouldStop()) break;
    if (daily.day === todayStr() && daily.reply >= DAY_REPLY_CAP) {
      dailyLimitReached = true;
      ctx.stepLog(1, 'warn', '当前账号已达每日评论上限');
      break;
    }
    const key = JSON.stringify([videoIdOf(post.url), post.text]);
    if (ledger[key]) {
      if (ledger[key] === 'pending') { pending++; ctx.stepLog(1, 'warn', '发送结果待核对，未重复发送 · ' + post.url + ' · ' + post.text); }
      else skipped++;
      continue;
    }
    if (round.attempted >= policy.accountLimit) break;
    if (round.confirmed && round.confirmed % policy.restEvery === 0 && round.restedAt !== round.confirmed) {
      round.restedAt = round.confirmed;
      const min = policy.restMinMinutes * 60000, max = policy.restMaxMinutes * 60000;
      const wait = typeof ctx.randInt === 'function' ? ctx.randInt(min, max) : min + Math.floor(Math.random() * (max - min + 1));
      ctx.stepLog(1, 'running', '阶段休息 ' + Math.round(wait / 1000) + ' 秒，已确认 ' + round.confirmed + ' 条');
      await ctx.sleep(wait);
      if (shouldStop()) break;
    }
    if (lastUrl !== post.url || !(await onTarget(post.url))) {
      lastUrl = '';
      try {
        await openCustomTarget(post.url);
        await waitWithHold(beh.watch_open_pause || [5000, 10000]);
      } catch (error) {
        if (isDenial(error)) throw error;
        ctx.stepLog(1, 'warn', '打不开视频 · ' + post.url);
        notSent++;
        continue;
      }
      if (shouldStop()) break;
      if (!(await captchaGate(1))) throw new Error('验证码未完成');
      if (!(await onTarget(post.url)) || !(await ensureCommentsOpen())) {
        ctx.stepLog(1, 'warn', '无法确认目标视频或打开评论区 · ' + post.url);
        notSent++;
        continue;
      }
      lastUrl = post.url;
    }
    const author = await currentAuthor();
    if (!(await waitComposer(() => true))) {
      ctx.stepLog(1, 'warn', '评论框未就绪或存在多个输入框 · ' + post.url);
      notSent++;
      continue;
    }
    if (!(await clearOwnDraft(post))) {
      ctx.stepLog(1, 'warn', '评论框保留了非本轮程序草稿，未覆盖 · ' + post.url);
      notSent++;
      continue;
    }
    if (!(await cdpClickSel(editor)) || !(await waitComposer(s => s.focused && s.text === ''))) {
      ctx.stepLog(1, 'warn', '无法聚焦评论框 · ' + post.url);
      notSent++;
      continue;
    }
    if (shouldStop()) break;
    const targetUrl = await getUrl();
    if (!matchesTarget(targetUrl, post.url)) { notSent++; continue; }
    const inserted = await _b('cdp_insert_text', { text: post.text, target: { selector: editor, url: targetUrl, text: '' } });
    const afterInsert = await snapshot();
    if (afterInsert?.text === post.text) draft = { video: videoIdOf(post.url), text: post.text };
    if (inserted?.ok !== true) {
      ctx.stepLog(1, 'warn', '可信输入命令失败，未点击发送 · ' + post.url);
      notSent++;
      await clearOwnDraft(post);
      continue;
    }
    if (await waitComposer(s => s.text === post.text)) draft = { video: videoIdOf(post.url), text: post.text };
    if (!(await waitComposer(s => s.text === post.text && s.sendReady)) || !(await onTarget(post.url))) {
      ctx.stepLog(1, 'warn', '评论正文或发送按钮未就绪 · ' + post.url);
      notSent++;
      await clearOwnDraft(post);
      continue;
    }
    const before = await readOwn(post.text, author);
    if (!before || !Number.isInteger(before.count)) { notSent++; await clearOwnDraft(post); continue; }
    if (shouldStop()) break;
    // Persist before dispatch so interruption cannot lead to another send.
    prepare(key, author, before);
    round.attempted++; // Includes ambiguous dispatches. Reconciliation never consumes this budget.
    let confirmed = false, proof = null;
    if (await cdpClickSel(send, { selector: editor, clickSelector: send, url: targetUrl, text: post.text })) {
      let stable = 0;
      for (let attempt = 0; attempt < 8 && !shouldStop(); attempt++) {
        await ctx.sleep(1500);
        if (!(await onTarget(post.url))) break;
        const after = await readOwn(post.text, author), inputState = await snapshot();
        const newer = after && (after.count > before.count || after.ids.some(id => !before.ids.includes(id)));
        stable = newer && inputState && !inputState.reason && inputState.text === '' ? stable + 1 : 0;
        if (stable >= 2) { confirmed = true; proof = after; break; }
      }
    }
    if (!confirmed) {
      ctx.stepLog(1, 'warn', '发送结果待核对 · ' + post.url + ' · ' + post.text);
      pending++;
      await clearOwnDraft(post);
      continue;
    }
    confirm(key, author, proof, 'same_page');
    sent++;
    round.confirmed++;
    draft = null;
    bumpDaily('reply');
    ctx.addActionCount('comment', 1);
    ctx.stepLog(1, 'running', '已发布自定义评论 · ' + post.url + ' · ' + post.text);
    if (!shouldStop()) await jsleep(beh.reply_pause || [10000, 20000]);
  }
  const remaining = Math.max(0, posts.length - sent - skipped - notSent - pending);
  pending += unresolvedReviews;
  const incomplete = notSent + pending + remaining;
  const capExhausted = round.attempted >= policy.accountLimit;
  const normalCap = capExhausted && !shouldStop() && !dailyLimitReached && notSent === 0;
  const failed = dailyLimitReached || (incomplete > 0 && !normalCap);
  if (capExhausted && !shouldStop()) {
    ctx.stepLog(1, normalCap ? 'done' : 'warn', '本号本轮已达 ' + policy.accountLimit + ' 条上限'
      + (normalCap ? '，正常收尾' : '，保留失败及原账号分工')
      + '；触顶延后 ' + remaining + ' 条，发送前失败 ' + notSent + ' 条，待核验 ' + pending + ' 条');
  }
  ctx.stepDone(1, { sent, skipped, notSent, pending, remaining, reconciled });
  ctx.stepStart(2);
  ctx.stepLog(2, incomplete ? 'warn' : 'done', '自定义评论本轮发布 ' + sent + ' 条，核实上次发布 ' + reconciled + ' 条，已有记录 ' + skipped + ' 条，失败 ' + notSent + ' 条，待核验 ' + pending + ' 条，未执行 ' + remaining + ' 条');
  ctx.stepDone(2, { sent, skipped, notSent, pending, remaining, reconciled });
  ctx.finish(failed ? 'error' : 'done', dailyLimitReached ? 'custom_comment_daily_limit' : failed ? 'custom_comments_incomplete' : normalCap ? 'custom_comment_round_limit' : undefined);
  return { status: failed ? 'failed' : 'done', sent, pending, remaining, reconciled };
`.replace('__LEDGER__', CUSTOM_COMMENT_LEDGER);

export function withTikTokCustomComments(source: string): string {
  const marker = 'ctx.stepStart(1);\nif (!DO_LIKE && !DO_REPLY)';
  const normalized = source.replace(/\r\n/g, '\n');
  const click = "async function cdpClickSel(selector) {\n  var p = await rectOf(selector);\n  if (!p) return false;\n  try { await _b('cdp_click', { x: p.x, y: p.y }); return true; } catch (e) { return false; }\n}";
  const declarations = normalized.match(/\bfunction\s+cdpClickSel\s*\(/g)?.length ?? 0;
  if (!declarations || normalized.split(click).length - 1 !== declarations) {
    throw new Error('自定义评论与服务器点击接口不兼容，请更新客户端');
  }
  const code = normalized.replaceAll(click, click.replace('cdpClickSel(selector)', 'cdpClickSel(selector, target)').replace(
    "try { await _b('cdp_click', { x: p.x, y: p.y }); return true; }",
    "try { var result = await _b('cdp_click', { x: p.x, y: p.y, target }); return result?.ok === true; }",
  ));
  if (code.split(marker).length !== 2) throw new Error('自定义评论与服务器剧本不兼容，请更新客户端');
  const navigation = 'async function _navigate(url) {\n  await _ttViaHome(url);';
  if (code.split(navigation).length !== 2 || (code.match(/\bfunction\s+_navigate\s*\(/g)?.length ?? 0) !== 1
      || (code.match(/\basync function _rawNavigate\(url\) \{/g)?.length ?? 0) !== 1) {
    throw new Error('自定义评论与服务器导航接口不兼容，请更新客户端');
  }
  const withNavigation = code.replace(navigation, String.raw`async function _navigate(url, customMode) {
  if (customMode === 'custom_direct' || customMode === 'custom_with_home') {
    if (customMode === 'custom_with_home') {
      await _rawNavigate('https://www.tiktok.com/');
      await ctx.sleep(7000, 9000);
      if (shouldStop()) throw new Error('user_stopped');
    }
    await _rawNavigate(url);
    await ctx.sleep(1500, 2500);
    if (await _isHttpErrorPage()) throw new Error('http_403_blocked');
    return;
  }
  await _ttViaHome(url);`);
  return withNavigation.replace(marker, 'ctx.stepStart(1);\n{\n' + runtime + '\n}\nif (!DO_LIKE && !DO_REPLY)');
}
