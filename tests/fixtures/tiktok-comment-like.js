// <nc-run-hud v1> —— 运行提示卡(所有矩阵剧本共用,由 backend/scripts/apply_run_hud.py 原样插到各 orchestrator.js 顶部)
// 2026-10-27 用户要求:参考 TikTok 定向获客的提示卡,所有矩阵任务都加;【绝不能影响原剧本功能】。
//   · 整段是一个立即执行函数,不新增任何全局名字,不和剧本变量冲突。
//   · 只给 ctx.stepLog / report / stepStart / addActionCount / navigate 包一层:原函数照常调用、参数原样传、
//     返回值原样返回;画卡的任何异常都在内部吞掉。画卡是后台触发(不 await),剧本流程不多等。
//   · 卡片:pointer-events:none(点击和 elementFromPoint 都穿透)、closed shadowRoot、宿主无 id/class、只在顶层文档;
//     最后一次更新 90s 后自动撤掉。要改卡片请改本文件再跑脚本同步,不要在单个剧本里手改。
(function () {
  try {
    if (typeof ctx !== 'object' || !ctx || typeof ctx.browser !== 'function') return;
    var man = ctx.manifest || {};
    var title = String(man.name_zh || man.id || '运行中').replace(/\s+/g, ' ').slice(0, 30);
    var st = { step: 0, msg: '准备开始…', n: {}, order: [], t0: Date.now(), busy: false, dirty: false, last: 0 };
    var LABEL = { lead_new: '👥', lead_engaged: '🤝', like: '👍', follow: '➕', comment: '💬', favorite: '⭐', download: '⬇️', post: '📤', note: '📝', report: '📋' };
    var JS = '(function(D){try{if(window.top!==window.self)return 0;}catch(e){return 0;}'
      + 'try{var K="__ncHud10";var h=window[K];'
      + 'if(!h||!h.host||!h.host.isConnected){var root=document.body||document.documentElement;if(!root)return 0;'
      + 'var host=document.createElement("div");host.style.cssText="position:fixed;top:54px;left:50%;transform:translateX(-50%);z-index:2147483647;pointer-events:none;width:min(560px,94vw)";'
      + 'var sr=host.attachShadow?host.attachShadow({mode:"closed"}):host;'
      + 'sr.innerHTML=\'<style>'
      + '.c{box-sizing:border-box;font:13px/1.45 -apple-system,"PingFang SC","Microsoft YaHei",system-ui,sans-serif;color:#e7f5ec;'
      + 'background:linear-gradient(180deg,rgba(17,27,22,.92),rgba(10,16,13,.92));-webkit-backdrop-filter:blur(10px);backdrop-filter:blur(10px);'
      + 'border:1px solid rgba(74,222,128,.55);border-radius:14px;padding:10px 14px 12px;position:relative;overflow:hidden;'
      + 'box-shadow:0 10px 30px rgba(0,0,0,.45),0 0 22px rgba(34,197,94,.22)}'
      + '.w{background:linear-gradient(90deg,#f59e0b,#fbbf24);color:#1f1300;font-weight:700;border-radius:9px;padding:6px 10px;text-align:center;font-size:13px;letter-spacing:.2px}'
      + '.r{display:flex;align-items:center;justify-content:space-between;gap:10px;margin-top:9px}'
      + '.r>div:first-child{min-width:0;overflow:hidden;white-space:nowrap;text-overflow:ellipsis}'
      + '.t{font-weight:700;color:#86efac}'
      + '.s{font-size:11.5px;font-weight:600;color:#bbf7d0;background:rgba(34,197,94,.16);border:1px solid rgba(74,222,128,.35);border-radius:999px;padding:1px 8px;margin-left:6px}'
      + '.s:empty{display:none}'
      + '.n{flex:none;font-variant-numeric:tabular-nums;color:#d1fae5;white-space:nowrap;font-size:12.5px}'
      + '.p{display:flex;align-items:center;gap:8px;margin-top:7px;color:#f0fdf4}'
      + '.d{flex:none;width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,.7);animation:pu 1.6s infinite}'
      + '.m{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
      + '.e{flex:none;color:#86efac;font-variant-numeric:tabular-nums;font-size:12px}'
      + '.b{position:absolute;left:0;bottom:0;height:2px;width:35%;background:linear-gradient(90deg,transparent,#4ade80,transparent);animation:mv 2.4s linear infinite}'
      + '@keyframes pu{0%{box-shadow:0 0 0 0 rgba(74,222,128,.7)}70%{box-shadow:0 0 0 7px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}'
      + '@keyframes mv{0%{left:-35%}100%{left:100%}}'
      + '</style><div class="c"><div class="w">⚠️ 运行中,请勿切换标签页 / 缩小窗口,以免干扰运行</div>'
      + '<div class="r"><div><span class="t"></span><span class="s"></span></div><div class="n"></div></div>'
      + '<div class="p"><span class="d"></span><span class="m"></span><span class="e"></span></div><div class="b"></div></div>\';'
      + 'var q=function(x){return sr.querySelector(x);};'
      + 'h={host:host,t:q(".t"),s:q(".s"),n:q(".n"),m:q(".m"),e:q(".e")};'
      // 2026-11-03 用户:「计时器不会动」→ 页面里每秒自己走:总用时 + 「已等 / 还剩」倒计时(剧本每 10 秒才发一次)
      + 'var fs=function(x){x=Math.max(0,x);return x<60?x+"s":Math.floor(x/60)+"m"+(x%60)+"s";};'
      + 'var fe=function(x){return (x>=3600?Math.floor(x/3600)+":":"")+("0"+Math.floor(x/60)%60).slice(-2)+":"+("0"+x%60).slice(-2);};'
      + 'h.tk=setInterval(function(){try{var now=Date.now();'
      + 'if(h.b0)h.e.textContent="⏱ "+fe(Math.floor((now-h.b0)/1000));'
      + 'if(h.dl){var r=Math.round((h.dl-now)/1000);if(r<0)r=0;h.m.textContent=h.mp+" · 已等 "+fs(h.wa+Math.round((now-h.w0)/1000)-0)+" / 还剩 "+fs(r);}'
      + '}catch(_){}},1000);'
      + 'try{Object.defineProperty(window,K,{value:h,enumerable:false,configurable:true,writable:true});}catch(_){window[K]=h;}'
      + 'root.appendChild(host);}'
      + 'h.t.textContent=D.t;h.s.textContent=D.s;h.n.textContent=D.n;h.m.textContent=D.m;h.e.textContent=D.e;'
      + 'h.b0=Date.now()-(D.z||0);'
      + 'var mm=/^(.*?)\\s*·\\s*已等\\s*(\\d+)m?(\\d*)s\\s*\\/\\s*还剩\\s*(\\d+)m?(\\d*)s\\s*$/.exec(D.m||"");'
      + 'var sv=function(a,b){return b===""?+a:(+a)*60+(+b);};'
      + 'if(mm){h.mp=mm[1];h.wa=sv(mm[2],mm[3]);h.w0=Date.now();h.dl=Date.now()+sv(mm[4],mm[5])*1000;}else h.dl=0;'
      + 'try{clearTimeout(h.x);}catch(_){}h.x=setTimeout(function(){try{h.host.remove();}catch(_){}},90000);'
      + 'return 1;}catch(e){return 0;}})';
    var data = function () {
      var sec = Math.floor((Date.now() - st.t0) / 1000);
      var el = (sec >= 3600 ? Math.floor(sec / 3600) + ':' : '') + ('0' + Math.floor(sec / 60) % 60).slice(-2) + ':' + ('0' + sec % 60).slice(-2);
      var parts = [];
      for (var i = 0; i < st.order.length; i++) { var k = st.order[i]; parts.push(LABEL[k] + ' ' + st.n[k]); }
      return {
        t: '🐾 NoobClaw · ' + title,
        s: st.step > 0 ? '第 ' + st.step + ' 步' : '',
        n: parts.join('  '),
        m: String(st.msg == null ? '' : st.msg).replace(/\s+/g, ' ').trim().slice(0, 160),
        e: '⏱ ' + el,
        z: Date.now() - st.t0,
      };
    };
    var flush = function () {
      if (st.busy) { st.dirty = true; return; }
      st.busy = true;
      (async function () {
        try {
          do {
            st.dirty = false;
            var wait = 700 - (Date.now() - st.last);
            if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
            st.last = Date.now();
            var expr = JS + '(' + JSON.stringify(data()).split(String.fromCharCode(8232)).join(' ').split(String.fromCharCode(8233)).join(' ') + ')';
            try { await ctx.browser('cdp_eval', { expression: expr, awaitPromise: false }, 3000); } catch (_) {}
          } while (st.dirty);
        } catch (_) {
        } finally { st.busy = false; }
      })().catch(function () {});
    };
    var push = function (m) { try { if (m != null) st.msg = m; flush(); } catch (_) {} };
    var oLog = ctx.stepLog, oRep = ctx.report, oStart = ctx.stepStart, oAdd = ctx.addActionCount, oNav = ctx.navigate;
    if (typeof oLog === 'function') ctx.stepLog = function (s, lvl, m) {
      var r = oLog.apply(ctx, arguments);
      try { if (typeof s === 'number' && s > 0) st.step = s; push(m); } catch (_) {}
      return r;
    };
    if (typeof oRep === 'function') ctx.report = function (m) {
      var r = oRep.apply(ctx, arguments);
      try { push(m); } catch (_) {}
      return r;
    };
    if (typeof oStart === 'function') ctx.stepStart = function (s) {
      var r = oStart.apply(ctx, arguments);
      try { if (typeof s === 'number' && s > 0) { st.step = s; push(null); } } catch (_) {}
      return r;
    };
    if (typeof oAdd === 'function') ctx.addActionCount = function (k, v) {
      var r = oAdd.apply(ctx, arguments);
      try {
        if (LABEL[k]) { if (!(k in st.n)) { st.n[k] = 0; st.order.push(k); } st.n[k] += (Number(v) || 1); push(null); }
      } catch (_) {}
      return r;
    };
    if (typeof oNav === 'function') ctx.navigate = function () {
      var p = oNav.apply(ctx, arguments);
      try { Promise.resolve(p).then(function () { push(null); }, function () {}); } catch (_) {}
      return p;
    };
  } catch (_) {}
})();
// </nc-run-hud v1>
/**
 * orchestrator.js — TikTok 作品评论区点赞 (tiktok_comment_like)。
 *
 * 2026-10-21 用户定:输入 1-20 条 TikTok 作品(视频/图文)链接或博主主页链接(主页会展开成他的作品),逐条打开,展开评论区、
 * 一屏一屏往下翻,给每位留言者的留言点赞(执行账号自己的留言跳过、已赞过的跳过),
 * 本账号点满 comment_like_max(1-5000)即停。每个成功的点赞计费一次(chargeAction('tt_comment_like'),4-70 积分;
 *   基础版及以上有效会员免费,服务端判定)。
 *
 * 实际上就是 tiktok_lead_engage「评论区点赞补量」那段尾巴的独立版:DOM 与可信点击写法同源,
 * 2026-10-21 在真实 TikTok 作品页实测(找到留言、点赞后 aria-pressed false→true、赞数 +1)。
 *
 * ctx.task 读取:urls(作品链接数组)、comment_like_max(每号本次上限)、selfDisplayId/selfUid。
 *
 * 2026-10-29 产品改版 →「TikTok 评论区点赞评论」(id / workflow_type 不变,老任务照跑):
 *   · 不再有用户设的次数:comment_like_max 忽略;只留 manifest.risk_caps 里的隐藏安全上限
 *     (max_run_duration_ms 单次时长、max_likes_per_day / max_comments_per_day 每号每天,走 ctx.readState/writeState 记账)。
 *   · task.comment_mode:'precise'(缺省 = 老任务)用 task.urls,链接处理和以前完全一样;
 *     'keywords' 用 task.keywords(执行账号自己的关键词)搜视频,搜索代码原样拷自 tiktok_auto_engage,刷到时长上限为止。
 *   · task.cl_do_like / task.cl_do_reply:点赞 / 回复两个开关(至少开一个)。没传(老客户端 / 老任务)= 两个都开。
 *   · 回复:每条留言由 AI(prompts/reply_composer.txt)按 留言原文 + 作品文案 + task.persona 写一句短回复;
 *     精准模式每条都回,关键词模式隔一条回一条(回一半)。回复成功按普通评论计费 chargeAction('comment')。
 *   · ⚠️ 在留言下「回复」这段 DOM 本仓库此前没有真机验证过的实现,全部标了「TODO 真机验证」。
 */
var task = ctx.task;
var manifest = ctx.manifest;
var config = ctx.config || {};
var beh = config.behavior || {};
var caps = (manifest && manifest.risk_caps) || {};
var defaults = (manifest && manifest.default_config) || {};

// ═══════════════════════════════════════════════
//   v1.x dual-track per-task tab routing — ALIAS-SAFE pattern
// ═══════════════════════════════════════════════
// ⚠️ helper fallthrough 用 __origCtxX 别名,防 replace_all 撞自递归
//   (memory feedback_replace_all_helper_recursion.md)
var __origCtxBrowser = ctx.browser.bind(ctx);
var __origCtxNavigate = ctx.navigate.bind(ctx);
var __origCtxScroll = (typeof ctx.scroll === 'function') ? ctx.scroll.bind(ctx) : null;
var __hasTaskTabs = (typeof ctx.openTab === 'function');
var _activeTab = null;
async function _b(cmd, params, timeout) {
  if (_activeTab) return await _activeTab.browser(cmd, params || {}, timeout);
  if (arguments.length <= 1) return await __origCtxBrowser(cmd);
  if (arguments.length === 2) return await __origCtxBrowser(cmd, params);
  return await __origCtxBrowser(cmd, params, timeout);
}
// ── TikTok 瞬时 403(用户 2026-09-11 实报:定向任务开完主页、连开视频常撞 Chrome 的「HTTP ERROR 403」
//   错误页,手动刷新一下就能开)—— 边缘 WAF 对连续整页请求的瞬时拒绝,不是页面结构问题。
//   所以每次导航后看一眼:落在 chrome-error:// 或正文是 403/ERR_ 错误页,就退避几秒重载,最多 3 次;
//   3 次仍拒才抛错(调用处本来就 try/catch → 跳过这一条),不再把 403 页当成正常页面往下点。
async function _rawNavigate(url) {
  if (_activeTab) return await _activeTab.navigate(url);
  return await __origCtxNavigate(url);
}
async function _isHttpErrorPage() {
  try {
    var u = '';
    try { var ur = await _b('get_url'); u = String((ur && (ur.url || (ur.data && ur.data.url))) || ''); } catch (_) { u = ''; }
    if (/^chrome-error:\/\//i.test(u)) return true;
    var r = await _b('cdp_eval', {
      expression: '(function(){try{var t=(document.body&&document.body.innerText||"").slice(0,600);'
        + 'if(document.title===""&&/HTTP ERROR 4\\d\\d|ERR_[A-Z_]+|遭到拒绝|请求被拒绝|Access Denied/.test(t))return "1";'
        + 'if(/^HTTP ERROR 4\\d\\d$/m.test(t)&&t.length<400)return "1";return "";}catch(_e){return "";}})()',
      awaitPromise: false,
    }, 5000);
    return !!(r && r.value === '1');
  } catch (_) { return false; }
}
// ── TikTok 先首页再目标页(用户 2026-09-18 定的硬规则)──
//   没有首页种下的身份 cookie(ttwid/msToken)就直接落作品页 / 主页 / 搜索页 / 短链,边缘风控会直接 403
//   (用户真机实测:先开首页、停几秒,再开目标页就放行)。所以凡是去【非首页】的 TikTok 页面,一律先进首页停 ~8s。
//   刚进过首页(12s 内)不重复进。下面 _navigate 的「403 退避重载」保留作第二道防线。
//   ⚠️ 这只治「没带 cookie 空降」那种 403;出口 IP 本身被 TikTok 判成机房/代理的,代码救不了,得换住宅 IP。
var _ttHomeAt = 0, _ttHomeLogged = false;
function _ttIsHomeUrl(url) {
  var u = String(url || '');
  if (/^https?:\/\/v[mt]\.tiktok\.com\//i.test(u)) return false;   // 短链会落到作品页
  var m = u.match(/^https?:\/\/(?:www\.)?tiktok\.com(\/[^?#]*)?/i);
  if (!m) return true;                                               // 非 TikTok 地址:不管
  var p = (m[1] || '/').replace(/\/+$/, '');
  return p === '' || p === '/foryou' || p === '/en' || p === '/following';
}
async function _ttViaHome(url) {
  if (_ttIsHomeUrl(url)) { if (/tiktok\.com/i.test(String(url || ''))) _ttHomeAt = Date.now(); return; }
  if (Date.now() - _ttHomeAt < 12000) return;
  if (!_ttHomeLogged) { _ttHomeLogged = true; try { ctx.report('🏠 TikTok 防 403:去目标页前先进首页停几秒'); } catch (_) {} }
  try { await _rawNavigate('https://www.tiktok.com/'); } catch (_) {}
  await ctx.sleep(7000, 9000);
  _ttHomeAt = Date.now();
}
async function _navigate(url) {
  await _ttViaHome(url);
  var lastErr = null;
  for (var attempt = 0; attempt < 3; attempt++) {
    try { await _rawNavigate(url); lastErr = null; } catch (e) { lastErr = e; }
    await ctx.sleep(1500, 2500);
    if (!(await _isHttpErrorPage())) { if (lastErr) throw lastErr; return; }
    ctx.report('⚠️ TikTok 拒绝了这次页面请求(HTTP 403,瞬时风控)' + (attempt < 2 ? ',等几秒后重载 ' + (attempt + 2) + '/3' : ',连续 3 次被拒,跳过这条'));
    if (attempt < 2) await ctx.sleep(4000 + attempt * 4000, 8000 + attempt * 6000);
  }
  throw new Error('http_403_blocked');
}
async function _scroll(amount) {
  if (_activeTab) return await _activeTab.scroll(amount);
  if (!__origCtxScroll) return;
  if (arguments.length === 0) return await __origCtxScroll();
  return await __origCtxScroll(amount);
}
async function ensureTaskTabOpenedOnce(platform, role, url) {
  if (_activeTab || !__hasTaskTabs) return;
  if (typeof ctx.getTaskTab === 'function') {
    try {
      var reused = await ctx.getTaskTab(role);
      if (reused) {
        _activeTab = reused;
        ctx.report('♻️ 复用 task tab ' + platform + '/' + role + ' #' + _activeTab.id);
        try { await _activeTab.navigate(url); } catch (_) {}
        await ctx.sleep(3000, 5000);
        return;
      }
    } catch (_) {}
  }
  try {
    _activeTab = await ctx.openTab({ platform: platform, role: role, url: url });
    ctx.report('🆕 task-tab routing: opened ' + platform + '/' + role + ' tab #' + _activeTab.id);
    await ctx.sleep(8000, 12000);
  } catch (e) {
    ctx.report('⚠️ openTab 失败,回退老路径: ' + String(e && e.message || e).slice(0, 100));
    _activeTab = null;
  }
}


// ════ 以下 helper 从 tiktok_lead_engage 原样拷贝(矩阵复用铁律:各剧本独立维护)════
var SEL_COMMENT_OPEN_BTN = '[data-e2e="comment-icon"], [data-e2e="browse-comment"], button[aria-label*="omment" i], [aria-label*="Read or add comment" i]';
var SEL_COMMENT_INPUT_WRAP = '[data-e2e="comment-input"], div[contenteditable="true"][role="textbox"], .public-DraftEditor-content';

async function jsleep(rangeOrMs) {
  if (Array.isArray(rangeOrMs)) {
    await ctx.sleep(rangeOrMs[0], rangeOrMs[1]);
  } else {
    await ctx.sleep(rangeOrMs);
  }
}

function unwrapElements(res) {
  if (!res) return [];
  if (Array.isArray(res.elements)) return res.elements;
  if (res.result && Array.isArray(res.result.elements)) return res.result.elements;
  return [];
}

async function getAttr(selector, attr) {
  try {
    var res = await _b('query_selector', { selector: selector, limit: 1, attrs: attr });
    var els = unwrapElements(res);
    return els[0] && els[0][attr];
  } catch (_) { return null; }
}

async function getText(selector) {
  try {
    var res = await _b('query_selector', { selector: selector, limit: 1 });
    var els = unwrapElements(res);
    return (els[0] && els[0].text) || '';
  } catch (_) { return ''; }
}

async function detectCaptcha() {
  // 返回命中的元素描述(或空串)。走 cdp_eval(CDP 主世界,不被页面 CSP 拦)。
  //   【收紧】只认可见 + >=150px 的容器(真验证码弹窗都够大;小元素误命中会假报验证码)。
  // ⚠️ 表达式【直接返回裸字符串】:内核层已包一层 {ok,value},再包会双层嵌套 → 检测死掉(协议坑)。
  try {
    var r = await _b('cdp_eval', {
      expression: '(function(){try{'
        + 'var els=document.querySelectorAll(\'[id*="captcha" i],[class*="captcha" i],iframe[src*="captcha" i],[class*="secsdk-captcha" i],[class*="geetest" i]\');'
        + 'for(var i=0;i<els.length;i++){var e=els[i];if(!e||e.getClientRects().length===0)continue;var cs=window.getComputedStyle(e);'
        + 'if(cs.display==="none"||cs.visibility==="hidden")continue;var b=e.getBoundingClientRect();'
        + 'if(b.width>=150&&b.height>=150){var cls=(typeof e.className==="string"?e.className:"").slice(0,40);return (e.id||cls||e.tagName)+" "+Math.round(b.width)+"x"+Math.round(b.height);}}'
        + 'return "";}catch(_e){return "";}})()',
      awaitPromise: false,
    }, 6000);
    return (r && typeof r.value === 'string') ? r.value : '';
  } catch (_) { return ''; }
}

async function nativeClick(selector) {
  // v5.x+: main_world_click + clickOnce — 跟扩展 background.js 配合,在 MAIN
  // world 跑完整套 mouse 序列后跳过兜底 el.click(),净效果是单次 click。
  // f7a40ba 把这换成隔离世界 dispatchEvent 合成事件是错的:合成事件留在
  // 隔离世界,主世界 web component listener 收不到。回退。
  await _b('main_world_click', {
    selector: selector,
    clickOnce: true,
  });
}

function fmtSec(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return sec + 's';
  return Math.floor(sec / 60) + 'm' + (sec % 60) + 's';
}

function normHandle(s) {
  s = String(s || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '');
  s = s.replace(/^@/, '');
  s = s.replace(/[/?#].*$/, '');
  return s.toLowerCase().replace(/[^a-z0-9._]/g, '');
}

async function getUrl() {
  try {
    var r = await _b('get_url');
    return (r && (r.url || (r.data && r.data.url))) || '';
  } catch (_) { return ''; }
}

function isShortLink(v) {
  v = String(v || '');
  return /(vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+/i.test(v);
}

async function resolveShortLink(v, stepNum) {
  // ⚠️ Page.navigate 超时 ≠ 页面没跳过去。短链 302 到中间页时常有资源一直 pending，
  //   CDP 命令就不返回，但浏览器其实已经落到作品页了。直接 return 会白丢这条
  //   （用户 2026-08-25 实测：CDP timeout: Page.navigate）—— 改成继续往下轮询读地址，
  //   读到真实 URL 就算成功；轮询也读不到才真的放弃。
  var _navErr = '';
  try { await _navigate(v); } catch (_e) {
    _navErr = String(_e && _e.message || _e).slice(0, 60);
    ctx.stepLog(stepNum, 'warn', '   ⚠️ 短链 navigate 超时，但页面可能已经跳了，继续读地址: ' + _navErr);
  }
  // 短链是 302 跳转,落地要时间;抖音这类还会先过一个中间页。固定睡几秒就读 location,
  //   常常还停在短链本身、或者压根读不到 —— 2026-08-23 真机就是这么空手而归的。
  //   改成轮询到「URL 不再是短链」为止,最多约 20s。
  var u = '';
  for (var _ri = 0; _ri < 8; _ri++) {
    if (ctx.aborted && ctx.aborted()) return '';
    await jsleep([2000, 3000]);
    try { u = String((await getUrl()) || ''); } catch (_e2) { u = ''; }
    if (u && !isShortLink(u)) break;
  }
  if (!u) {
    ctx.stepLog(stepNum, 'warn', '   ⚠️ 短链跳转后读不到地址(内核没返回 URL),跳过这行');
    return '';
  }
  if (isShortLink(u)) {
    ctx.stepLog(stepNum, 'warn', '   ⚠️ 短链一直没跳过去(仍停在 ' + u.slice(0, 60) + '),跳过这行');
    return '';
  }
  ctx.stepLog(stepNum, 'running', '   🔗 短链落到:' + u.slice(0, 90));
  return u;
}

async function captchaGate(step) {
  if (!(await detectCaptcha())) return true;
  var w = (ctx.waitForCaptchaCleared ? await ctx.waitForCaptchaCleared() : { ok: false, reason: 'no_wait_helper' });
  if (!w.ok) {
    ctx.stepLog(step, 'error', '🛑 验证码未在限时内手动完成(' + w.reason + '),任务停止。');
    return false;
  }
  return true;
}

async function tkCdp(expr, fallback) {
  try {
    var res = await _b('cdp_eval', { expression: expr, awaitPromise: false }, 6000);
    var r = (res && (res.result !== undefined ? res.result : res)) || {};
    if (r.ok && r.value !== undefined) {
      var v = r.value;
      // ⚠️ 兼容双包裹(2026-07-11 真机根因):内核 cdp_eval 已包一层 {ok,value},本文件很多老表达式
      //   自己又 return {ok:true,value:X} → v 是包裹对象 → tkMarkAndRead 的 info.desc/uid 全 undefined
      //   → 第 1 条没文案、恒判"不相关"、上滑校验永不确认。识别包裹形状再解一层;裸值不受影响。
      if (v && typeof v === 'object' && v.ok === true && ('value' in v)) return v.value;
      return v;
    }
  } catch (_) {}
  return fallback;
}

async function rectOf(selector) {
  var code = 'try{var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return "";try{e.scrollIntoView({block:"center"});}catch(_){}'
    + 'var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return "";return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}catch(er){return "";}';
  var jr = null;
  try { jr = await _b('javascript', { code: code }); } catch (e) { return null; }
  var v = (jr && (jr.result !== undefined ? jr.result : jr.value)) || '';
  try { return JSON.parse(v); } catch (e) { return null; }
}

async function cdpClickSel(selector) {
  var p = await rectOf(selector);
  if (!p) return false;
  try { await _b('cdp_click', { x: p.x, y: p.y }); return true; } catch (e) { return false; }
}

// 2026-10-24 用户反馈:从博主主页点进作品,评论区明明开着却报「评论区没打开」。
//   旧逻辑只认输入框(走 query_selector 取 data-e2e),取不到就去点评论按钮 —— 主页弹层里评论区默认就开着,
//   一点反而把它关掉;按钮选择器还会误中输入框里的「@」按钮(aria-label 含 comment)。
//   现在:用 CDP 主世界直接看「输入框 / 已有留言 / 评论搜索区」任一在场就算开着;只有确认没开才点开关,
//   点完轮询最多约 8 秒,第二次点之前再确认一遍,避免开了又关。
var SEL_COMMENT_TOGGLE = '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="browse-comment"], [aria-label*="Read or add comment" i]';
async function commentsPanelOpen() {
  return await tkCdp('(function(){return {ok:true,value:!!(document.querySelector(\'[data-e2e="comment-input"]\')'
    + '||document.querySelector(\'[data-e2e^="comment-level"]\')||document.querySelector(\'[data-e2e="search-comment-container"]\'))};})()', false) === true;
}
async function waitPanelOpen(maxMs) {
  var t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await commentsPanelOpen()) return true;
    await ctx.sleep(800);
  }
  return await commentsPanelOpen();
}
async function ensureCommentsOpen() {
  if (await waitPanelOpen(2500)) { await ensureCommentsTab(); return true; }
  for (var k = 0; k < 2; k++) {
    if (await commentsPanelOpen()) { await ensureCommentsTab(); return true; }
    var opened = await cdpClickSel(SEL_COMMENT_TOGGLE);
    if (!opened) { try { await nativeClick(SEL_COMMENT_TOGGLE); } catch (_) {} }
    if (await waitPanelOpen(8000)) { await ensureCommentsTab(); return true; }
  }
  return false;
}
// 评论面板此刻的状态:DOM 里有几条留言、滚动条是否到底。
//   2026-10-22 真机(1385 条评论的作品):留言是一批约 17 条整批塞进 DOM 的,一批要往下翻约 4 屏才看完 ——
//   所以「这一屏没有新留言」不代表到底,只有「滚动条到底 + 等几秒留言数不再增加」才是真到底。
async function commentPanelState() {
  return await tkCdp('(function(){var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'var it=items[0];var p=null;if(it){var e=it;for(var i=0;i<10&&e;i++){if(e.scrollHeight>e.clientHeight+10){p=e;break;}e=e.parentElement;}}'
    + 'return {ok:true,value:{n:items.length,top:p?Math.round(p.scrollTop):-1,bottom:p?(p.scrollTop+p.clientHeight>=p.scrollHeight-40):false}};})()', null);
}
// 右侧面板停在「You may like / 猜你喜欢」时切回第一个标签(评论)。标签文字跟界面语言变,所以按位置认:
//   视频右边那条标签栏(tux-tabbar)的第一个就是评论。只在面板里一条留言都没有时才点。
async function ensureCommentsTab() {
  var ok = await tkCdp('(function(){if(document.querySelector(\'[data-e2e^="comment-level"]\'))return {ok:true,value:false};'
    + 'var bars=document.querySelectorAll(\'[class*="tux-tabbar__item-container"]\');'
    + 'for(var i=0;i<bars.length;i++){var r=bars[i].getBoundingClientRect();if(r.width>0&&r.left>window.innerWidth*0.55){'
    + 'var first=bars[i].parentElement&&bars[i].parentElement.querySelector(\'[class*="tux-tabbar__item-container"] button\');'
    + 'if(first){first.setAttribute("data-nc-ctab","1");return {ok:true,value:true};}}}return {ok:true,value:false};})()', false);
  if (ok !== true) return false;
  var c = await cdpClickSel('[data-nc-ctab="1"]');
  await jsleep([1500, 2500]);
  return c;
}

async function scrollCommentPanel() {
  // 先拿到可滚容器的中心坐标 + 当前滚动位置(滚轮要打在面板上,不能打在视频上)。
  var info = await tkCdp('(function(){'
    + 'var it=document.querySelector(\'[data-e2e^="comment-level"]\');'
    + 'var p=null;'
    + 'if(it){var e=it;for(var i=0;i<10&&e;i++){if(e.scrollHeight>e.clientHeight+10){p=e;break;}e=e.parentElement;}}'
    + 'if(!p)p=document.querySelector(\'div[class*="DivCommentMain"]\');'
    + 'if(!p)return {ok:true,value:null};'
    + 'var r=p.getBoundingClientRect();'
    + 'return {ok:true,value:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),'
    + 'top:Math.round(p.scrollTop),h:p.scrollHeight,ch:p.clientHeight}};})()', null);
  if (!info || !info.x) return false;
  var atBottom = (info.top + info.ch) >= (info.h - 40);
  try {
    // 分两下滚,更像真人;deltaY 取面板高度的 ~0.8 屏。
    var step = Math.max(200, Math.round(info.ch * 0.8));
    await _b('cdp_wheel', { x: info.x, y: info.y, deltaY: step });
    await jsleep([500, 900]);
    await _b('cdp_wheel', { x: info.x, y: info.y, deltaY: step });
  } catch (e) {
    // 老内核没有 cdp_wheel → 回落到赋 scrollTop(聊胜于无,至少虚拟列表会重排一次)
    await tkCdp('(function(){var p=document.querySelector(\'div[class*="DivCommentMain"]\');'
      + 'if(!p)return {ok:true,value:false};p.scrollTop=p.scrollTop+p.clientHeight;return {ok:true,value:true};})()', false);
  }
  return !atBottom;
}

function videoIdOf(url) { return (String(url || '').match(/\/(?:video|photo)\/(\d+)/) || [])[1] || ''; }

async function chargeIfPossible(actionType) {
  try {
    var r = await ctx.chargeAction(actionType, 'tiktok');
    if (r && r.ok && typeof r.charged === 'number') { taskCharge += r.charged; return r.charged; }
  } catch (_) {}
  return 0;
}

// ═══════════════════════════════════════════════
//   作品评论区点赞 · 主流程
// ═══════════════════════════════════════════════
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function clampInt(v, lo, hi) { v = Math.round(Number(v)); if (!(v >= lo)) v = lo; if (v > hi) v = hi; return v; }
var taskCharge = 0;

var URL_CAP = 20;
var rawUrls = Array.isArray(task.urls) ? task.urls : [];
var urls = [];
(function () {
  var seen = {};
  for (var i = 0; i < rawUrls.length && urls.length < URL_CAP; i++) {
    var u = String(rawUrls[i] || '').trim();
    if (!u || seen[u]) continue;
    seen[u] = 1;
    urls.push(u);
  }
})();
// 2026-10-29:不再有用户设的点赞上限(task.comment_like_max 老任务里可能还带着,一律忽略)。
// ── 模式与开关 ──
var MODE = String(task.comment_mode || '') === 'keywords' ? 'keywords' : 'precise';
var DO_LIKE = (typeof task.cl_do_like === 'boolean') ? task.cl_do_like : true;
// 2026-10-29 用户定:没勾选(老客户端 / 老任务没这个字段)= 点赞 + 回复都做;新客户端取消勾选会传 false。
var DO_REPLY = (typeof task.cl_do_reply === 'boolean') ? task.cl_do_reply : true;
var PERSONA = String(task.persona || '').trim().slice(0, 400);
// 2026-10-29 用户:留言看不出语言(只有表情等)时,不看视频文案,一律用【矩阵账号的语言】回(客户端下发 task.account_lang)。
var ACC_LANG_NAME = task.account_lang === 'en' ? '英文 (English)' : (task.account_lang === 'zh' ? '简体中文' : '');
var REPLY_LANG_HINT = String(task.comment_language_hint || '').trim() || ('回复语言跟随这条留言本身的语言(中文留言回中文,英文留言回英文,以此类推)。'
  + (ACC_LANG_NAME ? '留言只有表情 / 看不出是什么语言时,用【' + ACC_LANG_NAME + '】回复(这是本账号的语言),不要按视频文案的语言。' : ''));
// ── 隐藏安全上限(manifest.risk_caps,用户看不到也改不了)──
var RUN_T0 = Date.now();
var MAX_RUN_MS = Number(caps.max_run_duration_ms) > 0 ? Number(caps.max_run_duration_ms) : 36000000;
var DAY_LIKE_CAP = Number(caps.max_likes_per_day) > 0 ? Number(caps.max_likes_per_day) : 5000;
var DAY_REPLY_CAP = Number(caps.max_comments_per_day) > 0 ? Number(caps.max_comments_per_day) : 300;
var stopReason = '';   // 'time' | 'like_cap' | 'reply_cap' —— 一旦有值,各层循环尽快收工
function shouldStop() {
  if (ctx.aborted && ctx.aborted()) return true;
  if (stopReason) return true;
  if (Date.now() - RUN_T0 >= MAX_RUN_MS) {
    stopReason = 'time';
    ctx.stepLog(1, 'running', '⏹️ 已到本次运行时长上限(' + fmtSec(MAX_RUN_MS / 1000) + '),收工');
    return true;
  }
  return false;
}
// 每号每天的点赞 / 回复计数(跨运行,readState/writeState 需 v3.4.26+ 客户端;没有就只在本次内存里记)。
var statePersistent = (typeof ctx.readState === 'function' && typeof ctx.writeState === 'function');
function todayStr() { var d = new Date(); return d.getFullYear() + '-' + (d.getMonth() + 1) + '-' + d.getDate(); }
var DAILY_NAME = 'comment_like_daily';
var daily = null;
try { daily = statePersistent ? ctx.readState(DAILY_NAME) : null; } catch (_) { daily = null; }
if (!daily || typeof daily !== 'object' || daily.day !== todayStr()) daily = { day: todayStr(), like: 0, reply: 0 };
function bumpDaily(k) {
  if (daily.day !== todayStr()) { daily.day = todayStr(); daily.like = 0; daily.reply = 0; }
  daily[k]++; saveDaily();
}
function saveDaily() {
  if (daily.day !== todayStr()) { daily.day = todayStr(); daily.like = 0; daily.reply = 0; }
  if (statePersistent) { try { ctx.writeState(DAILY_NAME, daily); } catch (_) {} }
}
// 回复过的留言账本(跨运行,防止同一条留言被重复回复)。key = 作品id|账号|留言前 60 字。
var REPLY_LEDGER_NAME = 'comment_reply_ledger';
var replyLedger = null;
try { replyLedger = statePersistent ? ctx.readState(REPLY_LEDGER_NAME) : null; } catch (_) { replyLedger = null; }
if (!replyLedger || typeof replyLedger !== 'object' || !replyLedger.keys || typeof replyLedger.keys !== 'object') replyLedger = { keys: {} };
function saveReplyLedger() {
  var ks = Object.keys(replyLedger.keys);
  if (ks.length > 8000) {
    ks.sort(function (a, b) { return replyLedger.keys[a] - replyLedger.keys[b]; });
    for (var i = 0; i < ks.length - 6000; i++) delete replyLedger.keys[ks[i]];
  }
  if (statePersistent) { try { ctx.writeState(REPLY_LEDGER_NAME, replyLedger); } catch (_) {} }
}
var MAX_SCREENS = clampInt(beh.max_comment_screens || 1500, 1, 3000);   // 真到底会提前停,这里只是防死循环(一批约 17 条要翻约 4 屏)
// 执行账号自己的留言不点(engageRunner 注入 selfDisplayId / selfUid)。
var selfHandle = normHandle(task.selfDisplayId || task.selfUid || '');
var done = { like: 0, already: 0, failed: 0, works: 0, worksSkipped: 0, reply: 0, replyFailed: 0 };
var perWork = [];
var RUN_STAMP = (function () { var d = new Date(); function p(n) { return (n < 10 ? '0' : '') + n; }
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' + p(d.getHours()) + p(d.getMinutes()); })();

function isTikTokUrl(u) { return /^https?:\/\/([\w-]+\.)?tiktok\.com\//i.test(String(u || '')); }

// 2026-10-26 用户反馈:从博主主页点进的作品「完全不点」,作品链接直接打开的正常。
//   两种页面的留言 DOM 不完全一样:主页弹层里作者链接可能是完整地址(https://www.tiktok.com/@xx,不以 /@ 开头),
//   点赞按钮也不一定是 div[role=button]。原来写死 a[href^="/@"] + div[role="button"][aria-pressed] → 一条都扫不到。
//   现在两处(scanComments / readCmtLikeByKey)共用同一套宽松识别:作者 = 任意含 /@ 的链接;
//   点赞 = 容器里 aria-label 像「赞」的 [aria-pressed] 元素(排除「踩」),找不到再取第一个 [aria-pressed]。
var CMT_HELPERS = 'function ncA(p){return p&&p.querySelector?p.querySelector(\'a[href*="/@"]\'):null;}'
  + 'function ncH(a){var m=(a.getAttribute("href")||"").match(/\\/@([^\\/?#]+)/);return m?decodeURIComponent(m[1]).toLowerCase():"";}'
  + 'function ncB(p){var bs=p.querySelectorAll(\'[aria-pressed]\');var f=null;for(var j=0;j<bs.length;j++){var l=(bs[j].getAttribute("aria-label")||"");'
  + 'if(/dislike|踩|不喜欢|不喜歡/i.test(l))continue;if(/like|赞|讚|喜欢|喜歡|いいね|좋아요|thích|me gusta/i.test(l))return bs[j];if(!f)f=bs[j];}return f;}'
  + 'function ncC(lv){var p=lv;for(var k=0;k<6&&p;k++){if(ncA(p)&&ncB(p))return p;p=p.parentElement;}return null;}';
// 扫一遍当前评论区:每条留言 = [data-e2e^="comment-level"] 往上找到带 a[href^="/@"] 的容器
//   (同 tiktok_lead_engage 的 harvestCommentHandles / findLeadCommentLikes,2026-10-21 真机实测)。
//   容器里 div[role=button][aria-pressed] 是这条留言的点赞(aria-pressed=true 即已赞)。
//   评论列表是虚拟化的、元素会被回收复用 → 每次扫描先清掉旧标记,再按本次序号重新打标记;
//   跨屏去重用「账号 + 留言前 80 字」当 key(由调用方记)。
async function scanComments() {
  var arr = await tkCdp('(function(){' + CMT_HELPERS + 'var out=[];var seen=[];'
    + 'var old=document.querySelectorAll("[data-nc-cl]");for(var o=0;o<old.length;o++)old[o].removeAttribute("data-nc-cl");'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);'
    + 'if(!p||seen.indexOf(p)>=0)continue;seen.push(p);'
    + 'var a=ncA(p);if(!a)continue;var h=ncH(a);if(!h)continue;'
    + 'var b=ncB(p);if(!b)continue;'
    + 'var u=p.querySelector(\'[data-e2e^="comment-username"]\');'
    + 'var n=(u&&(u.innerText||u.textContent)||"").replace(/\\s+/g," ").trim().slice(0,40);'
    + 'var t=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);'
    + 'b.setAttribute("data-nc-cl",String(i));'
    + 'out.push({i:i,h:h,n:n,t:t,ap:b.getAttribute("aria-pressed")});}'
    + 'return {ok:true,value:out};})()', null);
  return Array.isArray(arr) ? arr : [];
}

// 点赞后 TikTok 会重渲染这条留言,按钮上的 data-nc-cl 标记常随之丢失。
//   以前读不到就直接当成功(2026-10-22 用户投诉)——
//   现在按「账号(+ 留言前 80 字)」重新找到这条留言,读它此刻真实的 aria-pressed 和赞数。
async function readCmtLikeByKey(h, t) {
  return await tkCdp('(function(){' + CMT_HELPERS + 'var H=' + JSON.stringify(h) + ',T=' + JSON.stringify(t || '') + ';var best=null;'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);'
    + 'if(!p)continue;var a=ncA(p);if(!a)continue;'
    + 'if(ncH(a)!==H)continue;'
    + 'if(T){var tt=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);if(tt!==T)continue;}'
    + 'var b=ncB(p);if(!b)continue;'
    + 'var m=(b.getAttribute("aria-label")||"").match(/(\\d[\\d,.]*)/);'
    + 'var r={ap:b.getAttribute("aria-pressed"),n:m?parseInt(m[1].replace(/[,.]/g,""),10):null};'
    + 'if(r.ap==="true")return {ok:true,value:r};if(!best)best=r;}'
    + 'return {ok:true,value:best};})()', null);
}
// 点一下 → 最多确认 3 次(约 4-6 秒)。只有读到 aria-pressed=true 或赞数 +1 才算成功、才计费。
async function clickAndVerifyCmtLike(sel, h, t, pause) {
  var before = await readCmtLikeByKey(h, t);
  try {
    var trusted = await cdpClickSel(sel);   // 可信点击(isTrusted=true);拿不到坐标才回落合成点击
    if (!trusted) await nativeClick(sel);
  } catch (e) { return { ok: false, msg: String(e && e.message || e).slice(0, 60) }; }
  // 2026-10-26 用户要求:点完直接下一个、不要等。只留极短的确认(150-250ms 一次,通常第一次就确认到;
  //   没变红才多查几次,最多约 1.5s)—— 确认必须保留:没点上的不计数、不扣费。
  for (var v = 0; v < 6; v++) {
    await jsleep(pause || [150, 250]);
    if ((await getAttr(sel, 'aria-pressed')) === 'true') return { ok: true };
    var now = await readCmtLikeByKey(h, t);
    if (now && now.ap === 'true') return { ok: true };
    if (now && before && now.n != null && before.n != null && now.n > before.n) return { ok: true };
  }
  return { ok: false, msg: '点赞没有生效(可能被 TikTok 限制或弹了验证)' };
}
// 视频播完 TikTok 会自动滑到下一条(2026-10-22 用户定位:打开评论区后没暂停,作品被滑走,
//   评论区换成了别的作品)。打开评论区后把页面上所有视频暂停,并拦住之后的自动播放。
// 2026-10-23 用户反馈:有些作品很短,页面一打开就该先暂停,不能等 6-12 秒开页等待结束再停(短视频早播完自动滑到下一条了)。
//   页面加载期间每 0.4 秒试一次,一拿到 <video> 就暂停并挂上 play 拦截,之后照常等满开页时间。
async function waitWithHold(range) {
  var r = Array.isArray(range) ? range : [range, range];
  var total = Math.round(r[0] + Math.random() * Math.max(0, r[1] - r[0]));
  var t0 = Date.now(), held = false;
  while (Date.now() - t0 < total) {
    if (ctx.aborted && ctx.aborted()) return;
    if (!held) { var n = await holdVideo(); if (typeof n === 'number' && n > 0) held = true; }
    var left = total - (Date.now() - t0);
    if (left <= 0) break;
    await ctx.sleep(Math.min(held ? 1500 : 400, left));
  }
  await holdVideo();
}
async function holdVideo() {
  return await tkCdp('(function(){window.__ncHold=true;if(!window.__ncHoldBound){window.__ncHoldBound=true;'
    + 'document.addEventListener("play",function(e){if(window.__ncHold&&e.target&&e.target.pause){try{e.target.pause();}catch(_){}}},true);}'
    + 'var vs=document.querySelectorAll("video");for(var i=0;i<vs.length;i++){try{vs[i].pause();}catch(_){}}'
    + 'return {ok:true,value:vs.length};})()', 0);
}
// 当前页面是不是已经不是目标作品了(被自动滑走)。读不到地址时当作没滑走。
async function driftedFrom(url) {
  var want = videoIdOf(url);
  if (!want) return false;
  var cur = videoIdOf(await getUrl());
  return !!cur && cur !== want;
}
async function likeOne(c) {
  return await clickAndVerifyCmtLike('[data-nc-cl="' + c.i + '"]', c.h, c.t, beh.verify_pause);
}

// 评论区不见了 / 没打开时的补救(2026-10-21 用户反馈:点了十几个赞后把窗口缩小,评论区消失,
//   剧本把「一条留言都扫不到」当成「翻到底了」直接收工;重开后几秒就结束)。
//   先看是不是弹了验证码(等用户手动过),再点一次评论图标;还不行就整页重开再点一次。
//   返回 true = 评论区回来了。
async function recoverComments(url, why) {
  ctx.stepLog(1, 'warn', '   ⚠️ ' + why + ' —— 尝试重新打开评论区(运行中请不要缩小/最小化窗口)');
  if (!(await captchaGate(1))) return 'captcha';
  if (!(await driftedFrom(url)) && await ensureCommentsOpen()) {
    await holdVideo();
    await jsleep([1500, 2500]);
    if ((await scanComments()).length) return true;
  }
  var inApp = (await driftedFrom(url)) && (await openWorkInApp(url, videoIdOf(url)));
  if (!inApp) { try { await _navigate(url); } catch (_) { return false; } }
  await waitWithHold(beh.watch_open_pause || [6000, 12000]);
  if (!(await captchaGate(1))) return 'captcha';
  if (await ensureCommentsOpen()) {
    await holdVideo();
    await jsleep([1500, 2500]);
    if ((await scanComments()).length) return true;
  }
  return false;
}


// 2026-10-21 用户要求:除了作品链接,也支持填【博主主页】(https://www.tiktok.com/@handle)——
//   打开主页后不再预先收一批作品:逐条从网格里取下一条(跳过置顶)点进去点赞,直到点满上限或作品看完(2026-10-26)。
//   主页在轮到时才展开(不一开始就把所有主页都打开一遍),展开出来的作品插在队列当前位置。
var PROFILE_WORKS_CAP = clampInt(task.comment_like_profile_works || beh.profile_works_cap || 30, 1, 200);
function profileHandleOf(u) {
  var m = String(u || '').match(/tiktok\.com\/@([\w.]+)\/?(?:[?#].*)?$/i);
  return m ? m[1].toLowerCase() : '';
}
function authorOfVideoUrl(url) {
  var m = String(url || '').match(/\/@([\w.]+)\/(?:video|photo)\//);
  return m ? m[1].toLowerCase() : '';
}
// 主页作品网格收链接(从 tiktok_lead_engage.collectVideoLinksOnPage 拷贝,按作者过滤掉推荐区别人的作品)。
async function collectVideoLinksOnPage(cap, owner) {
  var seen = {}, out = [], still = 0;
  for (var round = 0; round < 20 && out.length < cap; round++) {
    var res;
    try { res = await _b('query_selector', { selector: 'a[href*="/video/"], a[href*="/photo/"]', limit: 200, attrs: 'href' }); } catch (_) { res = null; }
    var els = unwrapElements(res);
    var grew = false;
    for (var i = 0; i < els.length && out.length < cap; i++) {
      var href = els[i] && els[i].href;
      if (!href) continue;
      if (href.indexOf('http') !== 0) href = 'https://www.tiktok.com' + href;
      var vid = videoIdOf(href);
      if (!vid || seen[vid]) continue;
      if (owner && authorOfVideoUrl(href) !== owner) continue;
      seen[vid] = 1; out.push(href.split('?')[0]); grew = true;
    }
    if (!grew) { still++; if (still >= 2) break; } else { still = 0; }
    if (out.length >= cap) break;
    try { await _scroll(); } catch (_) {}
    await jsleep(beh.profile_scroll_pause || [2500, 5000]);
  }
  return out;
}

// 2026-10-21 用户反馈:博主主页最前面的置顶作品(TikTok 最多置顶 3 条)数据往往很差,跳过。
//   判定两路取并集:① 卡片上的「置顶 / Pinned」角标(角标文字跟着 TikTok 界面语言变,列了常见十几种语言;认不出的语言靠 ②);② 作品 id 时间序 —— 主页网格除置顶外按发布时间倒序,
//   TikTok 作品 id 前 32 位是发布时间戳,所以排在前面、却比后面作品还旧的,就是置顶上去的。
// 2026-10-22 用户要求:回复也点赞。作品显示的评论数包含回复(真机:127 条主留言下挂了 283 条回复),
//   只点主留言永远点不到那个数。回复默认收起在「View N replies」下,展开一次出 3 条,再点「View N more」继续。
//   展开后回复是 [data-e2e="comment-level-2"],结构和主留言一样 → scanComments / likeOne 直接能用,不用另写。
//   按钮文字跟界面语言变,所以按结构认:DivViewRepliesContainer 里带数字的那个是「展开 / 更多」,不带数字的是「收起」。
//   点了没反应(TikTok 不给回复数据,真机见过「View 98 more」点了也不出来)就标记放弃这条,不卡住。

// ── 以下函数逐字取自 tiktok_lead_engage(同名的旧版本被覆盖)──
async function scanCommentLikes() {
  var arr = await tkCdp('(function(){' + CMT_HELPERS + 'var out=[];var seen=[];'
    + 'var old=document.querySelectorAll("[data-nc-hl]");for(var o=0;o<old.length;o++)old[o].removeAttribute("data-nc-hl");'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);'
    + 'if(!p||seen.indexOf(p)>=0)continue;seen.push(p);'
    + 'var a=ncA(p);if(!a)continue;var h=ncH(a);if(!h)continue;var b=ncB(p);if(!b)continue;'
    + 'var r=b.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;'
    + 'var u=p.querySelector(\'[data-e2e^="comment-username"]\');'
    + 'var n=(u&&(u.innerText||u.textContent)||"").replace(/\\s+/g," ").trim().slice(0,40);'
    + 'var t=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);'
    + 'b.setAttribute("data-nc-hl",String(i));'
    + 'out.push({i:i,h:h,n:n,t:t,ap:b.getAttribute("aria-pressed")});}'
    + 'return {ok:true,value:out};})()', null);
  return Array.isArray(arr) ? arr : [];
}

// 2026-10-26:点之前按「账号 + 留言前 80 字」重新找到这条留言再点。评论列表是虚拟化的,滚动时 DOM 节点会被回收给别的留言用,
//   扫描时打在按钮上的标记可能已经跑到另一条(甚至已赞过的)留言上 —— 照标记点会点错、甚至把别人的赞点掉,验证必然失败。
// ⚠️ 2026-10-26 用户反馈:跑着跑着点到了右边的「Creator videos / 创作者视频」标签,评论区没了就再也点不了赞。
//   原因:按钮滚到面板顶部时被吸顶的标签栏盖住,按坐标点下去点中的是标签。现在滚到面板中间,
//   并且点之前用 elementFromPoint 确认这个坐标上确实是这颗按钮,被盖住就不点(下一屏再来)。
async function likeCmtByKey(h, t, pause) {
  var pos = await tkCdp('(function(){' + CMT_HELPERS + 'var H=' + JSON.stringify(h) + ',T=' + JSON.stringify(t || '') + ';'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);if(!p)continue;var a=ncA(p);if(!a||ncH(a)!==H)continue;'
    + 'var tt=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);if(T&&tt!==T)continue;'
    + 'var b=ncB(p);if(!b)continue;if(b.getAttribute("aria-pressed")==="true")return {ok:true,value:{already:1}};'
    + 'try{b.scrollIntoView({block:"center"});}catch(_){}var r=b.getBoundingClientRect();if(!(r.width>0&&r.height>0))continue;'
    + 'var hx=Math.round(r.left+r.width/2),hy=Math.round(r.top+r.height/2),hit=document.elementFromPoint(hx,hy);'
    + 'if(!hit||!(hit===b||b.contains(hit)))return {ok:true,value:{gone:1,covered:1}};'
    + 'var m=(b.getAttribute("aria-label")||"").match(/(\\d[\\d,.]*)/);'
    + 'return {ok:true,value:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),n:m?parseInt(m[1].replace(/[,.]/g,""),10):null}};}'
    + 'return {ok:true,value:{gone:1}};})()', null);
  if (!pos) return { ok: false, msg: '读不到留言' };
  if (pos.already) return { already: true };
  if (pos.gone) return { gone: true };
  try { await _b('cdp_click', { x: pos.x, y: pos.y }); } catch (e) { return { ok: false, msg: String(e && e.message || e).slice(0, 60) }; }
  for (var v = 0; v < 6; v++) {
    await jsleep(pause || [150, 250]);
    var now = await readCmtLikeByKey(h, t);
    if (now && now.ap === 'true') return { ok: true };
    if (now && pos.n != null && now.n != null && now.n > pos.n) return { ok: true };
  }
  return { ok: false, msg: '点赞没有生效(可能被 TikTok 限制或弹了验证)' };
}

// 点赞后 TikTok 会重渲染这条留言,按钮上的 data-nc-cl 标记常随之丢失。
//   以前读不到就直接当成功(2026-10-22 用户投诉)——
//   现在按「账号(+ 留言前 80 字)」重新找到这条留言,读它此刻真实的 aria-pressed 和赞数。
async function readCmtLikeByKey(h, t) {
  return await tkCdp('(function(){' + CMT_HELPERS + 'var H=' + JSON.stringify(h) + ',T=' + JSON.stringify(t || '') + ';var best=null;'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);'
    + 'if(!p)continue;var a=ncA(p);if(!a)continue;if(ncH(a)!==H)continue;'
    + 'if(T){var tt=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);if(tt!==T)continue;}'
    + 'var b=ncB(p);if(!b)continue;'
    + 'var m=(b.getAttribute("aria-label")||"").match(/(\\d[\\d,.]*)/);'
    + 'var r={ap:b.getAttribute("aria-pressed"),n:m?parseInt(m[1].replace(/[,.]/g,""),10):null};'
    + 'if(r.ap==="true")return {ok:true,value:r};if(!best)best=r;}'
    + 'return {ok:true,value:best};})()', null);
}

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-29 新增:给留言【回复】一句(AI 写)。
//   ⚠️ 本仓库此前没有「在 TikTok 网页版某条留言下回复」的真机验证实现(tiktok_auto_engage 的 tryComment / tkTryComment
//   只会发一级评论)。下面的 DOM 假设全部标了「TODO 真机验证」,上线前必须在真机上逐条核对。
//   流程:按「账号 + 留言前 80 字」重新定位这条留言(同 likeCmtByKey)→ 找这条留言自己的「回复」按钮 → 可信点击 →
//   找到进入「回复状态」的输入框 → 再调 AI(先确认能回再花 AI 的钱)→ 可信聚焦 + cdp_insert_text(同 tryComment)→
//   找输入框旁边的发送按钮可信点击 → 确认回复出现在评论区或输入框已清空,才计数、才扣费。
//   任何一步失败:写一句中文日志、这条不回,继续点赞;绝不让整个任务崩。
// ═══════════════════════════════════════════════════════════════════════════
var REPLY = { on: DO_REPLY, mine: [], consecFail: 0, capLogged: false };
// 回复要用 prompts/reply_composer;剧本包里没有就不回复(否则 AI 会在没有约束的情况下乱写)。
if (REPLY.on && typeof ctx.getPrompt === 'function') {
  var _rp = ''; try { _rp = String(ctx.getPrompt('reply_composer') || ''); } catch (_) { _rp = ''; }
  if (!_rp.trim()) { REPLY.on = false; ctx.stepLog(1, 'warn', '⚠️ 剧本包里缺少回复提示词(reply_composer),本次不回复' + (DO_LIKE ? ',只点赞' : '')); }
}

// 页面里共用的回复相关小函数(拼在 CMT_HELPERS 后面用)。
// TODO 真机验证:回复按钮 —— 先找留言容器里 [data-e2e^="comment-reply"](排除 *list*,TikTok 旧版见过 comment-reply-1 / comment-reply-2),
//   找不到再按文字认(span / p / button / div[role=button] / a,文字是各语言的「回复 / Reply」、不含数字、≤16 字),
//   并且要求它在文档顺序上紧跟这条留言(ncOwn:它前面最近的 [data-e2e^="comment-level"] 就是这条),免得点到楼中楼别人的「回复」。
//   容器先用 ncC 找到的 p,找不到再往上一层 p.parentElement。
var REPLY_HELPERS = CMT_HELPERS
  + 'var RRE=/^(reply|回复|回覆|返信|답글\\s*달기|답글|responder|trả lời|répondre|antworten|balas|rispondi|ответить|yanıtla|odpowiedz|ตอบกลับ|antwoorden)$/i;'
  + 'function ncVis(e){if(!e)return false;var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}'
  + 'function ncFind(H,T){var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');for(var i=0;i<items.length;i++){var lv=items[i];var p=ncC(lv);if(!p)continue;'
  + 'var a=ncA(p);if(!a||ncH(a)!==H)continue;var tt=(lv.innerText||lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,80);if(T&&tt!==T)continue;return {lv:lv,p:p};}return null;}'
  + 'function ncOwn(p,lv,el){var ls=p.querySelectorAll(\'[data-e2e^="comment-level"]\');var last=null;for(var k=0;k<ls.length;k++){if(ls[k]===el||ls[k].contains(el))continue;if(ls[k].compareDocumentPosition(el)&4)last=ls[k];}return !last||last===lv;}'
  + 'function ncR(p,lv){var cs=p.querySelectorAll(\'[data-e2e^="comment-reply"]\');for(var i=0;i<cs.length;i++){if(/list/i.test(cs[i].getAttribute("data-e2e")||""))continue;if(ncVis(cs[i])&&ncOwn(p,lv,cs[i]))return cs[i];}'
  + 'var bs=p.querySelectorAll(\'span,p,button,div[role="button"],a\');for(var j=0;j<bs.length;j++){var b=bs[j];if(b.children.length>2)continue;'
  + 'var x=(b.innerText||b.textContent||"").replace(/\\s+/g," ").trim();if(!x||x.length>16||/\\d/.test(x))continue;if(RRE.test(x)&&ncVis(b)&&ncOwn(p,lv,b))return b;}return null;}';

// 作品文案(给 AI 当背景)。video-desc 在 tiktok_auto_engage 播放页真机用过;
// TODO 真机验证:[data-e2e="browse-video-desc"](主页弹层里的文案)是推测的,弹层里读不到就当没有文案。
async function readVideoDesc() {
  var d = await tkCdp('(function(){var e=document.querySelector(\'[data-e2e="browse-video-desc"]\')||document.querySelector(\'[data-e2e="video-desc"]\');'
    + 'return {ok:true,value:e?(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim().slice(0,300):""};})()', '');
  return typeof d === 'string' ? d : '';
}

function replyKeyOf(vurl, c) { return (videoIdOf(vurl) || String(vurl || '').slice(0, 80)) + '|' + c.h + '|' + String(c.t || '').slice(0, 60); }
function looksLikeMyReply(t) {
  t = String(t || '');
  for (var i = 0; i < REPLY.mine.length; i++) { if (REPLY.mine[i] && t.indexOf(REPLY.mine[i]) >= 0) return true; }
  return false;
}

// 决定这条留言回不回,回的话执行并记账。返回 'ok' | 'skip' | 'fail' | 'gone' | 'stop'。
async function maybeReply(st, c, vurl) {
  if (!REPLY.on || st.replyOff) return 'skip';
  if (shouldStop()) return 'stop';
  if (daily.day !== todayStr()) { daily.day = todayStr(); daily.like = 0; daily.reply = 0; }
  if (daily.reply >= DAY_REPLY_CAP) {
    if (!REPLY.capLogged) { REPLY.capLogged = true; ctx.stepLog(1, 'warn', '   ⏹️ 这个号今天已回复 ' + daily.reply + ' 条,到了每日安全上限(' + DAY_REPLY_CAP + '),今天不再回复' + (DO_LIKE ? ',只点赞' : '')); }
    REPLY.on = false;
    if (!DO_LIKE) { stopReason = 'reply_cap'; return 'stop'; }
    return 'skip';
  }
  if (looksLikeMyReply(c.t)) return 'skip';                 // 自己刚发的回复(没拿到 selfHandle 时也能认出来)
  var rk = replyKeyOf(vurl, c);
  if (replyLedger.keys[rk]) return 'skip';                  // 以前回过这条
  // 关键词模式:隔一条回一条(回一半)。精准模式:每条都回。
  st.replyTurn = (st.replyTurn || 0) + 1;
  if (MODE === 'keywords' && st.replyTurn % 2 === 0) return 'skip';
  var r;
  try { r = await replyToComment(st, c, vurl); } catch (e) { r = { ok: false, msg: '回复时出错: ' + String(e && e.message || e).slice(0, 60) }; }
  if (r && r.gone) return 'gone';
  if (r && r.ok) {
    st.reply++; done.reply++; st.replyFail = 0; REPLY.consecFail = 0;
    REPLY.mine.push(String(r.text || '').slice(0, 20));
    if (REPLY.mine.length > 200) REPLY.mine.shift();
    replyLedger.keys[rk] = Date.now(); saveReplyLedger();
    bumpDaily('reply');
    if (typeof ctx.addActionCount === 'function') ctx.addActionCount('comment', 1);
    await chargeIfPossible('comment');   // 回复 = 一条普通评论,同 tiktok_auto_engage 的评论计费
    ctx.stepLog(1, 'running', '   💬 已回复 ' + (c.n || '@' + c.h) + ':「' + String(r.text || '').slice(0, 60) + '」(这条作品已回复 ' + st.reply + ')');
    await jsleep(beh.reply_pause || [10000, 20000]);
    if (done.reply % 10 === 0 && !(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
    return 'ok';
  }
  if (r && r.unconfirmed) { replyLedger.keys[rk] = Date.now(); saveReplyLedger(); }   // 可能已发出:记账本,以后不再回这条
  st.replyFail = (st.replyFail || 0) + 1; done.replyFailed++; REPLY.consecFail++;
  ctx.stepLog(1, 'warn', '   ⚠️ 没能回复 ' + (c.n || '@' + c.h) + ' 的留言:' + ((r && r.msg) || '原因不明') + (DO_LIKE ? '(这条不回了,继续点赞)' : '(这条跳过)'));
  if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
  if (r && r.login) {
    REPLY.on = false;
    ctx.stepLog(1, 'warn', '   ⛔ 回复时弹出了 TikTok 登录框 —— 这个号在这个浏览器里没登录(或登录失效了),本次不再回复');
    if (!DO_LIKE) { stopReason = 'reply_cap'; return 'stop'; }
    return 'fail';
  }
  if (r && r.residual) {
    st.replyOff = true;
    ctx.stepLog(1, 'warn', '   ⛔ 回复框里留着没发出去的字,这条作品先不再回复(换下一条作品会重置)');
  } else if (st.replyFail >= 3) {
    st.replyOff = true;
    ctx.stepLog(1, 'warn', '   ⛔ 这条作品连续 3 次回复失败,这条作品先不再回复' + (DO_LIKE ? ',只点赞' : ''));
  }
  if (done.reply === 0 && REPLY.consecFail >= 6) {
    REPLY.on = false;
    ctx.stepLog(1, 'warn', '   ⛔ 连续 6 次都回复不上、一次也没成功(可能 TikTok 改版了回复入口),本次不再回复' + (DO_LIKE ? ',只点赞' : ''));
    if (!DO_LIKE) { stopReason = 'reply_cap'; return 'stop'; }
  }
  return 'fail';
}

// 在留言下回复一句。返回 { ok, text } 或 { ok:false, msg, gone?, login?, residual? }。
async function replyToComment(st, c, vurl) {
  var H = JSON.stringify(c.h), T = JSON.stringify(c.t || ''), N = JSON.stringify(c.n || '');
  // ① 定位这条留言的「回复」按钮,滚到中间,命中测试通过才点。
  // TODO 真机验证:回复按钮选择器见 REPLY_HELPERS.ncR;命中测试 elementFromPoint 允许命中按钮本身 / 子元素 / 直接包住它的父元素。
  var pos = await tkCdp('(function(){' + REPLY_HELPERS + 'var f=ncFind(' + H + ',' + T + ');if(!f)return {ok:true,value:{gone:1}};'
    + 'var b=ncR(f.p,f.lv)||(f.p.parentElement?ncR(f.p.parentElement,f.lv):null);if(!b)return {ok:true,value:{noBtn:1}};'
    + 'try{b.scrollIntoView({block:"center"});}catch(_){}var r=b.getBoundingClientRect();if(!(r.width>0&&r.height>0))return {ok:true,value:{noBtn:1}};'
    + 'var x=Math.round(r.left+r.width/2),y=Math.round(r.top+r.height/2),hit=document.elementFromPoint(x,y);'
    + 'if(!hit||!(hit===b||b.contains(hit)||hit.contains(b)))return {ok:true,value:{covered:1}};'
    + 'var txt=(f.lv.innerText||f.lv.textContent||"").replace(/\\s+/g," ").trim().slice(0,300);'
    + 'return {ok:true,value:{x:x,y:y,text:txt}};})()', null);
  if (!pos) return { ok: false, msg: '读不到这条留言' };
  if (pos.gone) return { ok: false, gone: true };
  if (pos.noBtn) return { ok: false, msg: '这条留言下找不到「回复」按钮(TikTok 可能改版,待真机核对)' };
  if (pos.covered) return { ok: false, msg: '「回复」按钮被别的东西挡住了' };
  try { await _b('cdp_click', { x: pos.x, y: pos.y }); } catch (e) { return { ok: false, msg: '点「回复」失败: ' + String(e && e.message || e).slice(0, 60) }; }

  // ② 找进入「回复状态」的输入框,打标记 data-nc-ri。三种形态依次找:
  // TODO 真机验证:输入框 —— (a) 内联:留言容器 p / p.parentElement 里出现可见的 [contenteditable="true"] / [contenteditable="plaintext-only"];
  //   (b) 焦点:document.activeElement 是 contenteditable;(c) 主输入框:[data-e2e="comment-input"] [contenteditable="true"](同 tryComment 的 SEL_COMMENT_INPUT_CE 首选项)。
  //   (b)(c) 必须看到「回复这条留言」的迹象才用:输入框往上最多 3 层(不跨进评论列表)的文字里有这条留言的昵称 / @账号(只有 reply 字样不算,可能是上一条的回复状态),
  //   否则发出去就成了一级评论,宁可不回。
  var edExpr = '(function(){' + REPLY_HELPERS
    + 'var o=document.querySelectorAll("[data-nc-ri]");for(var q=0;q<o.length;q++)o[q].removeAttribute("data-nc-ri");'
    + 'var H=' + H + ',T=' + T + ',N=' + N + ';var CE=\'[contenteditable="true"],[contenteditable="plaintext-only"]\';'
    + 'var f=ncFind(H,T);var ed=null,mode="";'
    // 2026-10-29 真机核对:点「Reply」后的内联回复框 = [data-e2e="comment-reply-input"] 里的编辑器,它和留言正文不一定在
    //   同一层(新版整页布局里在留言容器往上 2 层),所以先按它找:从回复框往上走到第一个含留言的祖先,那里第一条
    //   comment-level 就是它回复的那条 —— 必须正是这条留言、而且是刚点「Reply」后拿到焦点的那个框才用
    //   (同一串里可能还开着给别的楼中楼的旧回复框,不能误用)。
    + 'if(f){var ris=document.querySelectorAll(\'[data-e2e="comment-reply-input"] [contenteditable="true"],[data-e2e="comment-reply-input"] [contenteditable="plaintext-only"]\');'
    + 'for(var ri=0;ri<ris.length&&!ed;ri++){if(!ncVis(ris[ri]))continue;var fa=document.activeElement;if(!(fa&&(fa===ris[ri]||ris[ri].contains(fa))))continue;var an=ris[ri];for(var up=0;up<8&&an;up++){an=an.parentElement;if(an&&an.querySelector(\'[data-e2e^="comment-level"]\'))break;}'
    + 'if(an&&an.querySelector(\'[data-e2e^="comment-level"]\')===f.lv){ed=ris[ri];mode="inline";}}}'
    + 'if(f&&!ed){var scs=[f.p,f.p.parentElement];for(var u=0;u<scs.length&&!ed;u++){if(!scs[u])continue;var es=scs[u].querySelectorAll(CE);'
    + 'for(var k=0;k<es.length;k++){if(es[k].closest&&es[k].closest(\'[data-e2e="comment-input"]\'))continue;if(ncVis(es[k])&&ncOwn(scs[u],f.lv,es[k])){ed=es[k];mode="inline";break;}}}}'
    + 'if(!ed){var ae=document.activeElement;if(ae&&ae.isContentEditable){ed=(ae.closest&&ae.closest(CE))||ae;mode="focused";}}'
    + 'if(!ed){var m=document.querySelector(\'[data-e2e="comment-input"] [contenteditable="true"]\');if(m&&ncVis(m)){ed=m;mode="main";}}'
    + 'if(!ed)return {ok:true,value:{mode:""}};'
    + 'var w=ed,ind=false;for(var z=0;z<3;z++){var pp=w.parentElement;if(!pp||pp.querySelector(\'[data-e2e^="comment-level"]\'))break;w=pp;}'
    + 'var wt=(w.innerText||w.textContent||"");'
    + 'if((N&&wt.indexOf(N)>=0)||wt.indexOf("@"+H)>=0)ind=true;'
    + 'ed.setAttribute("data-nc-ri","1");'
    + 'var et=(ed.textContent||"").replace(/\\u200b/g,"").trim();'
    + 'return {ok:true,value:{mode:mode,ind:ind,len:et.length,txt:et.slice(0,60)}};})()';
  var ed = null;
  for (var w = 0; w < 10; w++) {
    await jsleep([400, 600]);
    ed = await tkCdp(edExpr, null);
    if (ed && ed.mode && (ed.mode === 'inline' || ed.ind)) break;
  }
  if (!ed || !ed.mode) return { ok: false, msg: '点了「回复」但没出现回复输入框(待真机核对)', login: await loginWallShown() };
  if (ed.mode !== 'inline' && !ed.ind) return { ok: false, msg: '找到了输入框,但看不出已进入「回复这条留言」状态,怕发成一级评论,不发' };
  // 回复状态下 TikTok 可能预填「@昵称」—— 只有 @提及 不算残留;别的字算残留(上一次没发出去),不往上叠。
  // TODO 真机验证:回复状态下输入框是否预填 @提及。
  if (ed.len > 0 && !/^@\S+$/.test(String(ed.txt || ''))) return { ok: false, residual: true, msg: '回复框里已经有字了' };

  // ③ 能回了才调 AI。
  var desc = st.desc != null ? st.desc : '';
  var promptInput = JSON.stringify({
    comment_text: String(pos.text || c.t || '').slice(0, 300),
    commenter_name: c.n || c.h || '',
    video_desc: desc,
    persona: PERSONA,
    language_hint: REPLY_LANG_HINT,
  });
  ctx.stepLog(1, 'running', '   🤖 AI 给 ' + (c.n || '@' + c.h) + ' 的留言写回复...');
  var raw;
  // 同 tiktok_auto_engage:aiCall(name, promptInput, undefined, { expectJson:false }) —— promptInput 必须放第 2 个参数。
  try { raw = await ctx.aiCall('reply_composer', promptInput, undefined, { expectJson: false }); }
  catch (e) { return { ok: false, msg: 'AI 生成回复失败: ' + String(e && e.message || e).slice(0, 60) }; }
  var text = String((raw && raw.text != null ? raw.text : raw) || '').trim()
    .replace(/^["'“”「」]+|["'“”「」]+$/g, '')
    .replace(/https?:\/\/\S+/gi, '').replace(/#[^\s#]+/g, '').replace(/\s+/g, ' ').trim()
    .slice(0, 150);
  if (!text) return { ok: false, msg: 'AI 回复为空' };

  // ④ 写入 —— 同 tryComment 的【全可信 CDP】:cdp_click 聚焦 → cdp_insert_text 插入(合成事件 Draft 不认)。
  //   打字时长按 type_dwell_per_char_ms 估一下(插入是整句一次进去的,先停一段像在打字)。
  var dw = beh.type_dwell_per_char_ms || [50, 130];
  var typeMs = Math.min(15000, text.length * randInt(dw[0], dw[1]));
  if (!(await cdpClickSel('[data-nc-ri="1"]'))) return { ok: false, msg: '回复输入框点不到(没坐标)' };
  await jsleep([400, 900]);
  if (typeMs > 0) await ctx.sleep(typeMs);
  try { await _b('cdp_insert_text', { text: text }); }
  catch (e) { return { ok: false, msg: '写入回复失败(cdp_insert_text): ' + String(e && e.message || e).slice(0, 60) }; }
  await jsleep([1200, 2500]);
  var wrote = await tkCdp('(function(){var e=document.querySelector(\'[data-nc-ri="1"]\');return {ok:true,value:e?(e.textContent||"").replace(/\\u200b/g,"").trim().length:-1};})()', -1);
  if (!(wrote > 0)) return { ok: false, msg: '写入后回复框仍是空的' };

  // 2026-10-29 真机核对(Chrome 登录态,@tiktok 作品):点留言下「Reply」后,内联回复框是
  //   [data-e2e="comment-reply-input"] 里的 Draft 编辑器,发送按钮是纯图标的 button[data-e2e="comment-reply-post"][aria-label="Post"]
  //   (不是主输入框的 comment-post,也没有文字 —— 这就是以前「找不到发送按钮」的原因);发出的回复以 comment-level-2 出现。
  // ⑤ 发送按钮:从输入框往上最多 8 层(进到评论列表就停),找最近的 [data-e2e="comment-post"](同 tryComment 的 SEL_COMMENT_POST),
  //   找不到再按文字认 Post / 发布 等。
  // TODO 真机验证:回复状态下发送按钮是否仍是 [data-e2e="comment-post"];内联回复框的发送按钮选择器 / 文字。
  var pb = await tkCdp('(function(){var o=document.querySelectorAll("[data-nc-rpost]");for(var q=0;q<o.length;q++)o[q].removeAttribute("data-nc-rpost");'
    + 'var ed=document.querySelector(\'[data-nc-ri="1"]\');if(!ed)return {ok:true,value:0};'
    + 'function vis(e){var r=e.getBoundingClientRect();return r.width>0&&r.height>0;}'
    + 'var PRE=/^(post|发布|發佈|發布|发送|發送|投稿|게시|publicar|đăng|publier|posten|senden|kirim|invia|pubblica|отправить|опубликовать|gönder|paylaş|wyślij|โพสต์)$/i;'
    + 'function lab(e){return ((e.innerText||e.textContent||"").replace(/\\s+/g," ").trim()||(e.getAttribute("aria-label")||"").trim());}'
    + 'var sc=ed;for(var u=0;u<8;u++){sc=sc.parentElement;if(!sc)break;'
    + 'var p0=sc.querySelector(\'[data-e2e="comment-reply-post"]\');if(p0&&vis(p0)){p0.setAttribute("data-nc-rpost","1");return {ok:true,value:3};}'
    + 'var p1=sc.querySelector(\'[data-e2e="comment-post"]\');if(p1&&vis(p1)){p1.setAttribute("data-nc-rpost","1");return {ok:true,value:1};}'
    + 'var bs=sc.querySelectorAll(\'button,div[role="button"],[data-e2e*="post"],[aria-label]\');for(var j=0;j<bs.length;j++){if(bs[j]===ed||bs[j].contains(ed)||bs[j].tagName==="A"||bs[j].closest("a[href]"))continue;var x=lab(bs[j]);'
    + 'if(x&&x.length<=12&&PRE.test(x)&&vis(bs[j])){bs[j].setAttribute("data-nc-rpost","1");return {ok:true,value:2};}}'
    + 'if(u>=3&&sc.querySelector(\'[data-e2e^="comment-level"]\'))break;}'
    + 'return {ok:true,value:0};})()', 0);
  // 发送前先数一下评论区里已有几条含这段文字的留言,发送后必须变多才算发出去(短回复可能撞上别人的留言)。
  var snip = text.slice(0, Math.min(text.length, 20));
  var cntExpr = '(function(){var S=' + JSON.stringify(snip) + ';var n=0;var ls=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<ls.length;i++){if((ls[i].innerText||ls[i].textContent||"").indexOf(S)>=0)n++;}return {ok:true,value:n};})()';
  var baseCnt = await tkCdp(cntExpr, -1);
  if (typeof baseCnt !== 'number' || baseCnt < 0) return { ok: false, residual: true, msg: '发送前读不到评论区,不发' };
  if (pb) {
    if (!(await cdpClickSel('[data-nc-rpost="1"]'))) return { ok: false, residual: true, msg: '发送按钮点不到(没坐标)' };
  } else {
    // 找不到发送按钮(2026-10-29 用户真机报):把输入框往上几层的结构记一行日志(核对选择器用),再退回【回车发送】
    //   (TikTok 评论框回车即发)。是否真的发出去,仍由下面「评论区里含这条回复的留言变多了」严格确认,没确认不计数不扣费。
    var diag = await tkCdp('(function(){var ed=document.querySelector(\'[data-nc-ri="1"]\');if(!ed)return {ok:true,value:""};var out=[],sc=ed;'
      + 'for(var u=0;u<6&&sc;u++){var d=sc.getAttribute&&sc.getAttribute("data-e2e");var al=sc.getAttribute&&sc.getAttribute("aria-label");'
      + 'out.push(sc.tagName.toLowerCase()+(d?"[e2e="+d+"]":"")+(al?"[aria="+al.slice(0,20)+"]":""));sc=sc.parentElement;}'
      + 'var near=[];var box=ed.parentElement&&ed.parentElement.parentElement&&ed.parentElement.parentElement.parentElement;'
      + 'if(box){var bs=box.querySelectorAll("button,[role=button],[data-e2e],[aria-label]");for(var i=0;i<bs.length&&near.length<10;i++){var b=bs[i];if(b===ed||b.contains(ed))continue;'
      + 'var t=((b.innerText||"").replace(/\\s+/g," ").trim()).slice(0,12);near.push(b.tagName.toLowerCase()+(b.getAttribute("data-e2e")?"[e2e="+b.getAttribute("data-e2e")+"]":"")+(b.getAttribute("aria-label")?"[aria="+b.getAttribute("aria-label").slice(0,16)+"]":"")+(t?"「"+t+"」":""));}}'
      + 'return {ok:true,value:(out.join(" < ")+" || 附近:"+near.join(" , ")).slice(0,600)};})()', '');
    ctx.stepLog(1, 'running', '   🔬 没找到发送按钮,改用回车发送。回复框结构:' + String(diag || '(读不到)'));
    if (!(await cdpClickSel('[data-nc-ri="1"]'))) return { ok: false, residual: true, msg: '回复框旁边找不到发送按钮,回复框也点不到' };
    await jsleep([300, 600]);
    var kp = null;
    try { kp = await _b('keypress', { key: 'Enter' }); } catch (e) { kp = { ok: false }; }
    if (kp && kp.ok === false) return { ok: false, residual: true, msg: '回复框旁边找不到发送按钮,回车发送也失败' };
  }

  // ⑥ 确认:评论区里含回复文字的留言比发送前多了,才算发出去、才计数扣费。
  //   回复框清空 / 收起但没看到回复 → 「未确认」:记账本防重复回复,但不计数、不扣费。
  // TODO 真机验证:发出后回复是否立刻以 [data-e2e="comment-level-2"] 出现在这条留言下。
  var vt = Number(beh.reply_verify_total_ms) > 0 ? Number(beh.reply_verify_total_ms) : 8000;
  var t0 = Date.now(), edGone = false;
  while (Date.now() - t0 < vt) {
    await ctx.sleep(1500);
    var nowCnt = await tkCdp(cntExpr, -1);
    if (typeof nowCnt === 'number' && nowCnt > baseCnt) return { ok: true, text: text };
    var el = await tkCdp('(function(){var e=document.querySelector(\'[data-nc-ri="1"]\');return {ok:true,value:e?(e.textContent||"").replace(/\\u200b/g,"").trim().length:-1};})()', -2);
    if (el === 0 || el === -1) edGone = true;
  }
  if (edGone) return { ok: false, unconfirmed: true, text: text, msg: '回复框已清空,但评论区里没看到这条回复,不计数、不扣费' };
  return { ok: false, residual: true, msg: '点了发送,但没看到回复出现、回复框也没清空(可能被 TikTok 拦了)', login: await loginWallShown() };
}

// 是否弹出了 TikTok 登录框(同 likeVisibleComments 里点赞失败时的判断)。
async function loginWallShown() {
  return (await tkCdp('(function(){var t=(document.body&&document.body.innerText||"");'
    + 'var m=/Log in to TikTok|Log in to follow|Sign up for TikTok|登录 TikTok|登入 TikTok|登錄 TikTok|로그인|ログイン/i.test(t)&&!!document.querySelector(\'[role="dialog"],[id*="login" i],[class*="LoginModal" i]\');'
    + 'return {ok:true,value:m};})()', false)) === true;
}

// 给当前这一屏所有没赞过的留言点赞(并按模式回复)。返回 false = 这条作品连续点不上,别再点了。
async function likeVisibleComments(st, vurl) {
  var list = await scanCommentLikes();
  for (var ci = 0; ci < list.length; ci++) {
    if (shouldStop()) return false;
    var c = list[ci];
    var key = c.h + '|' + c.t;
    if (st.seen[key]) continue;
    st.seen[key] = 1;
    if (selfHandle && c.h === selfHandle) continue;
    // 2026-10-29「只回复、不点赞」:不点赞,逐条交给 maybeReply(它自己判断该不该回)。
    if (!DO_LIKE) {
      if (await driftedFrom(vurl)) { delete st.seen[key]; return true; }
      var rr = await maybeReply(st, c, vurl);
      if (rr === 'gone') delete st.seen[key];
      if (rr === 'stop') return false;
      continue;
    }
    if (c.ap === 'true') {
      st.already++; cmtLikeStats.already++;
      // 以前赞过的留言也要回复(上次可能到了回复上限 / 回复失败);账本会挡住回过的。
      if (DO_REPLY) {
        if (await driftedFrom(vurl)) { delete st.seen[key]; return true; }
        var ra = await maybeReply(st, c, vurl);
        if (ra === 'gone') delete st.seen[key];
        if (ra === 'stop') return false;
      }
      continue;
    }
    if (await driftedFrom(vurl)) { delete st.seen[key]; return true; }
    var r = await likeCmtByKey(c.h, c.t, beh.harvest_cmt_verify_pause || [150, 250]);
    if (r.already) {
      st.already++; cmtLikeStats.already++;
      if (DO_REPLY) {
        var rb = await maybeReply(st, c, vurl);
        if (rb === 'gone') delete st.seen[key];
        if (rb === 'stop') return false;
      }
      continue;
    }
    if (r.gone) { delete st.seen[key]; continue; }   // 列表回收了、这条暂时不在 DOM:下一屏再遇到再点
    if (r.ok) {
      st.like++; st.fail = 0; cmtLikeStats.like++;
      if (typeof ctx.addActionCount === 'function') ctx.addActionCount('like', 1);
      await chargeIfPossible('tt_comment_like');   // 独立计费类型:基础版及以上会员免费(2026-10-28)
      ctx.stepLog(1, 'running', '   💗 已赞 ' + (c.n || '@' + c.h) + ' 的留言(这条作品已赞 ' + st.like + ')');
      bumpDaily('like');
      var lp = beh.harvest_cmt_like_pause || [0, 0];
      if (lp[1] > 0) await jsleep(lp);
      if (cmtLikeStats.like % 20 === 0 && !(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
      // 2026-10-29:点赞成功后,按模式给这条留言回一句(精准每条都回,关键词隔一条回一条)。
      if (DO_REPLY && (await maybeReply(st, c, vurl)) === 'stop') return false;
      if (daily.like >= DAY_LIKE_CAP && !stopReason) {
        stopReason = 'like_cap';
        ctx.stepLog(1, 'warn', '   ⏹️ 这个号今天已在评论区点赞 ' + daily.like + ' 个,到了每日安全上限(' + DAY_LIKE_CAP + '),今天先到这里');
        return false;
      }
    } else {
      st.failed++; st.fail++; cmtLikeStats.failed++;
      // 没登录时点赞会弹出登录框、状态不变 —— 别当成「被限制」去冷却,直接说清楚(2026-10-26 第二个号一直「点赞冷却中」)。
      var _lg = await tkCdp('(function(){var t=(document.body&&document.body.innerText||"");'
        + 'var m=/Log in to TikTok|Log in to follow|Sign up for TikTok|登录 TikTok|登入 TikTok|登錄 TikTok|로그인|ログイン/i.test(t)&&!!document.querySelector(\'[role="dialog"],[id*="login" i],[class*="LoginModal" i]\');'
        + 'return {ok:true,value:m};})()', false);
      if (_lg === true) {
        ctx.stepLog(1, 'warn', '   ⛔ 点赞时弹出了 TikTok 登录框 —— 这个号在这个浏览器里没登录(或登录失效了),先在账号窗口里登录再跑。本次不再点赞');
        return false;
      }
      ctx.stepLog(1, 'warn', '   ⚠️ ' + (c.n || '@' + c.h) + ' 的留言点赞没成功: ' + (r.msg || ''));
      if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
      if (st.fail >= 5) {
        // 以前这里直接「这条作品不再点赞」,后面就只剩收潜客(用户 2026-10-26 反馈「跑着跑着不点赞了」)。
        //   改成:歇 30-60 秒再接着点;同一条作品歇过 3 次还是一个都点不上才放弃。
        st.cool = (st.cool || 0) + 1;
        if (st.cool >= 3 && st.likeAtCool === st.like) { ctx.stepLog(1, 'warn', '   ⛔ 歇了几次还是点不上(TikTok 可能限制了这个号给留言点赞),这条作品只收潜客'); return false; }
        st.likeAtCool = st.like;
        var cms = randInt(30000, 60000);
        ctx.stepLog(1, 'warn', '   ⏸️ 连续 5 条留言点不上,先歇 ' + fmtSec(cms / 1000) + ' 再接着点');
        await sleepWithHeartbeat(1, cms, '点赞冷却中');
        st.fail = 0;
        return true;
      }
    }
  }
  return true;
}

// 评论面板往下滚一屏(加载更多评论)。容器 class 带 hash 前缀,用 [class*=] 模糊匹配 + data-e2e 兜底。
// 🚨 评论区加载更多 —— 必须【滚对容器】+【用可信滚轮】,两个条件缺一不可。
//   2026-08-17 真机实测(5202 条评论那条视频):
//   ① 老写法滚的 `DivCommentListContainer` 是 `overflow:visible`、scrollHeight===clientHeight
//      的【非滚动】元素,赋 scrollTop 完全是空操作(实测 scrollTop 纹丝不动)。
//      真正可滚的是它父级 `div[class*="DivCommentMain"]`(overflow-y:scroll)。
//   ② 即使滚对了容器,直接赋 scrollTop 也【触发不了】TikTok 的无限加载(实测卡在 7 条不动);
//      换成 CDP 可信滚轮后 scrollHeight 立刻 2212→4475,潜客 7→22 还在涨。
//   ③ 评论列表是虚拟化的(DivVirtualItemContainer),DOM 里同时只有 7~12 条、滚过去的被回收,
//      所以【每滚一屏就要抓一次】,不能滚完再抓(harvest 已在调用方按轮抓)。
//   返回是否还能继续滚(到底了就没必要再滚)。
async function commentPanelState() {
  return await tkCdp('(function(){var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'var it=items[0];var p=null;if(it){var e=it;for(var i=0;i<10&&e;i++){if(e.scrollHeight>e.clientHeight+10){p=e;break;}e=e.parentElement;}}'
    + 'return {ok:true,value:{n:items.length,top:p?Math.round(p.scrollTop):-1,bottom:p?(p.scrollTop+p.clientHeight>=p.scrollHeight-40):false}};})()', null);
}

async function scrollCommentPanel() {
  // 先拿到可滚容器的中心坐标 + 当前滚动位置(滚轮要打在面板上,不能打在视频上)。
  var info = await tkCdp('(function(){'
    + 'var it=document.querySelector(\'[data-e2e^="comment-level"]\');'
    + 'var p=null;'
    + 'if(it){var e=it;for(var i=0;i<10&&e;i++){if(e.scrollHeight>e.clientHeight+10){p=e;break;}e=e.parentElement;}}'
    + 'if(!p)p=document.querySelector(\'div[class*="DivCommentMain"]\');'
    + 'if(!p)return {ok:true,value:null};'
    + 'var r=p.getBoundingClientRect();'
    + 'return {ok:true,value:{x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2),'
    + 'top:Math.round(p.scrollTop),h:p.scrollHeight,ch:p.clientHeight}};})()', null);
  if (!info || !info.x) return false;
  var atBottom = (info.top + info.ch) >= (info.h - 40);
  try {
    // 分两下滚,更像真人;deltaY 取面板高度的 ~0.8 屏。
    var step = Math.max(200, Math.round(info.ch * 0.8));
    await _b('cdp_wheel', { x: info.x, y: info.y, deltaY: step });
    await jsleep([500, 900]);
    await _b('cdp_wheel', { x: info.x, y: info.y, deltaY: step });
  } catch (e) {
    // 老内核没有 cdp_wheel → 回落到赋 scrollTop(聊胜于无,至少虚拟列表会重排一次)
    await tkCdp('(function(){var p=document.querySelector(\'div[class*="DivCommentMain"]\');'
      + 'if(!p)return {ok:true,value:false};p.scrollTop=p.scrollTop+p.clientHeight;return {ok:true,value:true};})()', false);
  }
  return !atBottom;
}

async function commentsPanelOpen() {
  return await tkCdp('(function(){return {ok:true,value:!!(document.querySelector(\'[data-e2e="comment-input"]\')'
    + '||document.querySelector(\'[data-e2e^="comment-level"]\')||document.querySelector(\'[data-e2e="search-comment-container"]\'))};})()', false) === true;
}

async function waitPanelOpen(maxMs) {
  var t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    if (await commentsPanelOpen()) return true;
    await ctx.sleep(500);
  }
  return await commentsPanelOpen();
}

// 右侧面板被切到「Creator videos / You may like」时切回第一个标签(评论)。标签文字随界面语言变,按位置认:
//   视频右边那条标签栏的第一个就是评论(同 tiktok_comment_like)。只在面板里一条留言都没有时才点。
async function ensureCommentsTab() {
  var ok = await tkCdp('(function(){if(document.querySelector(\'[data-e2e^="comment-level"]\'))return {ok:true,value:false};'
    + 'var bars=document.querySelectorAll(\'[class*="tux-tabbar__item-container"],[role="tablist"]\');'
    + 'for(var i=0;i<bars.length;i++){var r=bars[i].getBoundingClientRect();if(r.width>0&&r.left>window.innerWidth*0.5){'
    + 'var first=bars[i].querySelector(\'button,[role="tab"]\');'
    + 'if(first){first.setAttribute("data-nc-ctab","1");return {ok:true,value:true};}}}return {ok:true,value:false};})()', false);
  if (ok !== true) return false;
  var c = await cdpClickSel('[data-nc-ctab="1"]');
  if (c) ctx.stepLog(1, 'running', '   ↩️ 右边被切到了别的标签,切回评论');
  await jsleep([1200, 2000]);
  return c;
}

async function ensureCommentsOpen() {
  if (await waitPanelOpen(1500)) return true;
  if (await ensureCommentsTab() && await waitPanelOpen(4000)) return true;
  for (var k = 0; k < 2; k++) {
    if (await commentsPanelOpen()) return true;
    var opened = await cdpClickSel(SEL_COMMENT_TOGGLE);
    if (!opened) { try { await nativeClick(SEL_COMMENT_TOGGLE); } catch (_) {} }
    if (await waitPanelOpen(8000)) return true;
  }
  return false;
}

// 视频播完 TikTok 会自动滑到下一条(2026-10-22 用户定位:打开评论区后没暂停,作品被滑走,
//   评论区换成了别的作品)。打开评论区后把页面上所有视频暂停,并拦住之后的自动播放。
async function holdVideo() {
  return await tkCdp('(function(){window.__ncHold=true;if(!window.__ncHoldBound){window.__ncHoldBound=true;'
    + 'document.addEventListener("play",function(e){if(window.__ncHold&&e.target&&e.target.pause){try{e.target.pause();}catch(_){}}},true);}'
    + 'var vs=document.querySelectorAll("video");for(var i=0;i<vs.length;i++){try{vs[i].pause();}catch(_){}}'
    + 'return {ok:true,value:vs.length};})()', 0);
}

// 2026-10-26 用户要求(同评论区点赞 10-23):作品一打开就先暂停,不然短视频播完会被自动滑到下一条。
//   页面加载期间每 0.4 秒试一次,一拿到 <video> 就暂停并挂上 play 拦截,之后照常等满开页时间。
async function waitWithHold(range) {
  var r = Array.isArray(range) ? range : [range, range];
  var total = Math.round(r[0] + Math.random() * Math.max(0, r[1] - r[0]));
  var t0 = Date.now(), held = false;
  while (Date.now() - t0 < total) {
    if (ctx.aborted && ctx.aborted()) return;
    if (!held) { var n = await holdVideo(); if (typeof n === 'number' && n > 0) held = true; }
    var left = total - (Date.now() - t0);
    if (left <= 0) break;
    await ctx.sleep(Math.min(held ? 1500 : 400, left));
  }
  await holdVideo();
}

// 当前页面是不是已经不是目标作品了(被自动滑走)。读不到地址时当作没滑走。
async function driftedFrom(url) {
  var want = videoIdOf(url);
  if (!want) return false;
  var cur = videoIdOf(await getUrl());
  return !!cur && cur !== want;
}

//   (精准模式从同行主页读过一次,免得每条作品都再探)。
// 2026-10-26 用户要求的刷法:
//   关键词:搜索结果里点开第一条 → 打开评论区把留言依次点赞完(同时收潜客)→ 上滑到下一条 → 再开评论区…
//   同行主页:点开他的第一条作品 → 同上 → 上滑到他的下一条…
//   「上滑」= 弹层里的「下一条」按钮(data-e2e="arrow-right"),没有就按 ↓ 键。
//   上滑失败(比如中途被切成了整页播放)就整页打开列表里下一条还没做过的,保证不漏。
async function goNextInModal(curVid) {
  var clicked = false;
  try {
    var mk = await tkCdp('(function(){var b=document.querySelector(\'[data-e2e="arrow-right"]\');'
      + 'if(!b||b.disabled)return {ok:true,value:0};var r=b.getBoundingClientRect();if(!(r.width>0&&r.height>0))return {ok:true,value:0};'
      + 'b.setAttribute("data-nc-next","1");return {ok:true,value:1};})()', 0);
    if (mk === 1) clicked = await cdpClickSel('[data-nc-next="1"]');
  } catch (_) {}
  if (!clicked) { try { await _b('keypress', { key: 'ArrowDown' }); } catch (_) {} }
  for (var w = 0; w < 24; w++) {
    await ctx.sleep(250);
    var v = videoIdOf(await getUrl());
    if (v && v !== curVid) return true;
  }
  return false;
}

async function sleepWithHeartbeat(stepNum, totalMs, labelPrefix) {
  var HEARTBEAT_MS = 10000;
  var slept = 0;
  while (slept < totalMs) {
    if (ctx.aborted && ctx.aborted()) return;
    var chunk = Math.min(HEARTBEAT_MS, totalMs - slept);
    await ctx.sleep(chunk);
    slept += chunk;
    if (slept < totalMs) {
      ctx.stepLog(stepNum, 'running',
        '   ⏳ ' + (labelPrefix || '等待中')
        + ' · 已等 ' + fmtSec(slept / 1000)
        + ' / 还剩 ' + fmtSec((totalMs - slept) / 1000));
    }
  }
}

// 读元素中心坐标(视口坐标,给 cdp_click / cdp_insert_text 用);先滚进视口再取 rect。取不到返 null。
async function rectOf(selector) {
  var code = 'try{var e=document.querySelector(' + JSON.stringify(selector) + ');if(!e)return "";try{e.scrollIntoView({block:"center"});}catch(_){}'
    + 'var r=e.getBoundingClientRect();if(!(r.width>0&&r.height>0))return "";return JSON.stringify({x:Math.round(r.left+r.width/2),y:Math.round(r.top+r.height/2)});}catch(er){return "";}';
  var jr = null;
  try { jr = await _b('javascript', { code: code }); } catch (e) { return null; }
  var v = (jr && (jr.result !== undefined ? jr.result : jr.value)) || '';
  try { return JSON.parse(v); } catch (e) { return null; }
}

// 可信点击一个选择器的中心(CDP Input.dispatchMouseEvent,isTrusted=true)。
//   真机实测(2026-07-05 浏览器验证):TikTok 评论 = Draft.js 编辑器,【合成事件不被登记】——
//   合成 click 不开面板、合成 paste 被 preventDefault 但不插字、execCommand 插了字但 post 按钮仍 disabled。
//   只有可信 CDP(cdp_click 聚焦 + cdp_insert_text 插入 + cdp_click 发送)才认。见记忆 reference_matrix_trusted_input_activation。
async function cdpClickSel(selector) {
  var p = await rectOf(selector);
  if (!p) return false;
  try { await _b('cdp_click', { x: p.x, y: p.y }); return true; } catch (e) { return false; }
}

// ═══════════════════════════════════════════════════════════════════════════
// 2026-10-27 用户定:除了「收潜客」之外,完全照抄 tiktok_lead_engage 精准模式的评论区点赞流程:
//   · 作品链接 → 先把这条点完,再进博主主页,从他第一条作品开始逐条点、上滑下一条,刷完他全部作品(上限 300);
//   · 主页链接 → 点开他第一条作品,同上;同一位博主本次只刷一遍;
//   · 点赞不限量(不再看 comment_like_max)、不展开楼中楼、不跳置顶 —— 与定向获客一致;
//   · 点赞前按「账号+留言」重新定位并做命中测试(防点到吸顶标签 / 虚拟列表回收点错)、被切到别的标签自动切回评论、
//     连续点不上先歇 30-60 秒、弹登录框就停;翻到底 = 连续 3 次到底(每次等 1.5-2.5s)。
// 以下 likeVisibleComments / likeCmtByKey / ensureCommentsTab / goNextInModal 等函数逐字取自 tiktok_lead_engage。
// ═══════════════════════════════════════════════════════════════════════════
var HARVEST_CMT_LIKE = true;
var cmtLikeStats = { like: 0, already: 0, failed: 0 };

// 在【当前已打开】的这条作品上:评论区逐条点赞,翻到底为止(= lead 的 collectFromVideo 去掉收潜客)。
async function likeWorkHere(vurl, opts) {
  var W = { url: vurl, like: 0, already: 0, failed: 0, reply: 0, note: '' };
  perWork.push(W);
  if (opts && opts.inPlace) {
    await waitWithHold(beh.swipe_open_pause || [800, 1200]);
  } else {
    try { await _navigate(vurl); } catch (e) {
      W.note = '作品打不开'; done.worksSkipped++;
      ctx.stepLog(1, 'running', '   ⚠️ 打不开视频,跳过: ' + String(e && e.message || e).slice(0, 60));
      return;
    }
    await waitWithHold(beh.watch_open_pause || [5000, 10000]);
  }
  if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
  if (!(await ensureCommentsOpen())) {
    W.note = '评论面板打不开'; done.worksSkipped++;
    ctx.stepLog(1, 'running', '   ⚠️ 评论面板打不开,跳过这条');
    return;
  }
  await holdVideo();
  done.works++;
  var cl = { seen: Object.create(null), like: 0, already: 0, failed: 0, fail: 0, on: true, reply: 0, replyFail: 0, replyTurn: 0, replyOff: false, desc: null };
  var bottomTries = 0, stuckTries = 0, emptyTries = 0, recovers = 0, lastSeenN = 0;
  if (REPLY.on) cl.desc = await readVideoDesc();   // 作品文案给 AI 写回复当背景(读不到就空)
  ctx.stepLog(1, 'running', '   💗 ' + (DO_LIKE && REPLY.on
    ? '把这条作品的留言逐个点赞并回复' + (MODE === 'keywords' ? '(隔一条回一条)' : '') + '(已赞过的自动跳过)'
    : (DO_LIKE ? '把这条作品的留言逐个点赞(已赞过的自动跳过)' : '把这条作品的留言逐个回复' + (MODE === 'keywords' ? '(隔一条回一条)' : '') + '(回过的自动跳过)')));
  for (var s = 0; s <= 3000; s++) {
    if (shouldStop()) break;
    if (await driftedFrom(vurl)) {
      if (++recovers > 5) { ctx.stepLog(1, 'warn', '   ⛔ 作品反复被滑走,这条先到这里'); break; }
      ctx.stepLog(1, 'running', '   ↩️ 作品被滑走了,切回原作品接着翻');
      try { await _navigate(vurl); } catch (_) { break; }
      await waitWithHold(beh.watch_open_pause || [3000, 5000]);
      if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
      if (!(await ensureCommentsOpen())) break;
      await holdVideo();
      continue;
    }
    if (!cl.on) break;
    var b0 = cl.like;
    cl.on = await likeVisibleComments(cl, vurl);
    var anyItem = await tkCdp('(function(){return {ok:true,value:!!document.querySelector(\'[data-e2e^="comment-level"]\')};})()', false);
    if (!anyItem) {
      if (++emptyTries > 4) { ctx.stepLog(1, 'warn', '   ⛔ 评论区一直扫不到留言,这条先到这里'); break; }
      await ensureCommentsOpen(); await holdVideo();
      await jsleep([1500, 2500]);
      continue;
    }
    emptyTries = 0;
    if (s > 0 && s % 50 === 0) ctx.stepLog(1, 'running', '   📜 已翻 ' + s + ' 屏,这条作品已赞 ' + cl.like + ' 条');
    var st0 = await commentPanelState();
    await scrollCommentPanel();
    await jsleep(beh.harvest_scroll_pause || beh.scroll_pause || [1200, 2200]);
    var st1 = await commentPanelState();
    var nowSeen = Object.keys(cl.seen).length;
    var progressed = nowSeen > lastSeenN;
    lastSeenN = nowSeen;
    if (!st1) continue;
    if (st1.bottom) {
      if (progressed && bottomTries === 0) continue;
      bottomTries++;
      if (bottomTries >= 3) {
        var cntTxt = await tkCdp('(function(){var e=document.querySelector(\'[data-e2e="comment-count"],[data-e2e="browse-comment-count"]\');return {ok:true,value:e?(e.innerText||"").trim():""};})()', '');
        ctx.stepLog(1, 'running', '   📭 这条作品的留言翻完了:看过 ' + nowSeen + ' 条留言'
          + (cntTxt ? '(作品显示 ' + cntTxt + ' 条评论,这个数包含了留言下面的回复)' : ''));
        break;
      }
      await jsleep(beh.harvest_bottom_wait_pause || [1500, 2500]);
      continue;
    }
    bottomTries = 0;
    if (st0 && st1.top === st0.top) {
      if (++stuckTries >= 6) { ctx.stepLog(1, 'warn', '   ⚠️ 评论区滚不动了,这条先到这里'); break; }
      if (stuckTries % 2 === 0) { await ensureCommentsOpen(); await holdVideo(); }
    } else { stuckTries = 0; }
  }
  W.like = cl.like; W.already = cl.already; W.failed = cl.failed; W.reply = cl.reply;
  done.like += cl.like; done.already += cl.already; done.failed += cl.failed;
  ctx.stepLog(1, 'running', '   📊 这条作品留言:点赞 ' + cl.like + ' · 之前已赞 ' + cl.already + (cl.failed ? ' · 失败 ' + cl.failed : '')
    + (DO_REPLY ? ' · 回复 ' + cl.reply : '')
    + ' · 本次累计 👍 ' + done.like + (DO_REPLY ? ' 💬 ' + done.reply : ''));
}

// = lead 的 swipeHarvest(点开列表第一条 → 一直上滑),去掉收潜客。
async function swipeLike(list, owner, maxWorks) {
  maxWorks = maxWorks || beh.swipe_max_works || 300;
  if (!list.length) return;
  var seenV = Object.create(null);
  var firstVid = videoIdOf(list[0]);
  var opened = false;
  try {
    var mk = await tkCdp('(function(){var as=document.querySelectorAll(\'a[href*="/video/' + firstVid + '"],a[href*="/photo/' + firstVid + '"]\');'
      + 'for(var i=0;i<as.length;i++){var r=as[i].getBoundingClientRect();if(r.width>0&&r.height>0){as[i].setAttribute("data-nc-first","1");return {ok:true,value:1};}}return {ok:true,value:0};})()', 0);
    if (mk === 1 && await cdpClickSel('[data-nc-first="1"]')) {
      for (var w = 0; w < 24 && !opened; w++) { await ctx.sleep(250); opened = videoIdOf(await getUrl()) === firstVid; }
    }
  } catch (_) {}
  if (!opened) {
    try { await _navigate(list[0]); opened = true; } catch (_) { return; }
    await waitWithHold(beh.watch_open_pause || [5000, 10000]);
  }
  for (var n = 0; n < maxWorks + 5; n++) {
    if (shouldStop()) return;
    var cur = await getUrl();
    var vid = videoIdOf(cur);
    if (!vid) break;
    if (seenV[vid]) break;
    if (owner && authorOfVideoUrl(cur) && authorOfVideoUrl(cur) !== owner) { ctx.stepLog(1, 'running', '   ⏹️ 已经滑出这位博主的作品了'); break; }
    seenV[vid] = 1;
    var curUrl = String(cur).split('?')[0];
    ctx.stepLog(1, 'running', '   ▶️ 第 ' + Object.keys(seenV).length + ' 条作品 · ' + curUrl);
    if (doneWorkIds[vid]) { ctx.stepLog(1, 'running', '   ⏭️ 这条刚才已经点过了'); }
    else { doneWorkIds[vid] = 1; await likeWorkHere(curUrl, { inPlace: true }); }
    if (Object.keys(seenV).length >= maxWorks) { ctx.stepLog(1, 'running', '   ⏹️ 已刷满 ' + maxWorks + ' 条作品'); break; }
    await jsleep(beh.swipe_next_pause || [300, 600]);
    if (!(await goNextInModal(vid))) {
      var nextUrl = '';
      for (var li = 0; li < list.length; li++) { if (!seenV[videoIdOf(list[li])]) { nextUrl = list[li]; break; } }
      if (!nextUrl) { ctx.stepLog(1, 'running', '   ⏹️ 已经刷到最后一条了(没有下一条)'); break; }
      ctx.stepLog(1, 'running', '   ↪️ 上滑没反应,直接打开下一条');
      try { await _navigate(nextUrl); } catch (_) { break; }
      await waitWithHold(beh.watch_open_pause || [5000, 10000]);
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// 关键词模式的搜索(2026-10-29)—— 矩阵复用铁律:以下 shuffleKw / deriveMoreEngageKeywords / queryVideoLinks /
//   queryPageState / runSearchOnce / searchNextKeyword 以及它们用到的状态变量,
//   逐字拷自 backend/matrix/scenarios/tiktok_auto_engage/orchestrator.js(第 561-922 行,真机验证过的搜索流程),一字未改。
//   本剧本只在拷贝块前面补了 keywordsList,在后面把 kwDerivedOnce 设成 true(见下)。
// ═══════════════════════════════════════════════════════════════════════════
var keywordsList = (Array.isArray(task.keywords) ? task.keywords : []).map(function (k) { return String(k || '').trim(); }).filter(Boolean);
// ──── 拷贝开始(tiktok_auto_engage/orchestrator.js L561-L922)────
// v5.x+: 关键词池全用,不再 slice(0, 3) 砍掉用户配的额外关键词。collect 阶段
// 按需推进 —— 够了就停,不够就吃下一个词,直到达标或全部用完。
function shuffleKw(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}
var attemptKeywords = shuffleKw(keywordsList);
var kwDerivedOnce = false; // v6: 是否已让 AI 衍生过关键词(整个任务只衍生一次)

// v6: 关键词「衍生」—— 原关键词跑满轮次 / 连续 0 新候选 = 新鲜内容搜尽时,让 AI 按【赛道 + 原关键词】
//   衍生几个全新的同领域同语言关键词,接续搜索,并通过 ctx.appendKeywords 累积存回任务配置 →
//   下次运行自动纳入。reasoner JSON 不可靠 → 走 chat 取文本自行稳健解析。
//   AI 失败 / 老客户端无 appendKeywords → 返回 [](只衍生当次用、不持久化)。
async function deriveMoreEngageKeywords(seed, n) {
  n = n || 5;
  seed = (seed || []).map(function (s) { return String(s || '').trim(); }).filter(Boolean);
  try {
    var tk = String(task.track || '');
    var trackHint = (tk && tk.indexOf('_default') === -1) ? tk : '';
    var prompt =
      '你是内容选题助手。已有一批内容平台搜索关键词,它们能搜到的新鲜内容已被抓取殆尽,需要扩展。\n' +
      '请基于以下信息衍生 ' + n + ' 个【全新】搜索关键词:与已有关键词保持相同语言(中文/英文)、同一领域/受众、' +
      '换不同切入点或长尾词,不要与已有关键词重复或近义,每个尽量简短,适合在内容平台搜索。\n' +
      (trackHint ? '【赛道】' + trackHint + '\n' : '') +
      '【已有关键词】' + (seed.join('、') || '(无)') + '\n' +
      ((String(task.persona || task.comment_prompt || '').trim()) ? '【人设】' + String(task.persona || task.comment_prompt || '').trim().slice(0, 200) + '\n' : '') +
      '⚠️ 硬性要求(先想清楚再输出,别急着给词):\n' +
      '1. 先吃透【已有关键词】【赛道】【人设】三者共同指向的领域与受众,新词必须是【同一批人会去搜的东西】;\n' +
      '2. 逐个给候选词打一个 0-100 的关联度分(与上述领域/受众的贴合程度),【低于 40 分的一律不要输出】;\n' +
      '3. 宁可少给几个,也不要为了凑数塞泛词、蹭热点词、跨领域词 —— 一个都想不出就返回空数组 [];\n' +
      '输出 JSON 数组,每项形如 {"w":"关键词","rel":85}(rel 即第 2 步的关联度分),不要任何解释或多余文字。';
    var raw = await ctx.aiCall('__raw__', prompt, JSON.stringify({ seed: seed }), {
      model: 'noobclawai-chat', expectJson: false,
    });
    var text = String((raw && (raw.text != null ? raw.text : raw)) || '');
    var arr = [];
    try { arr = JSON.parse(text); } catch (e1) {
      var m = text.match(/\[[\s\S]*\]/);
      if (m) { try { arr = JSON.parse(m[0]); } catch (e2) { arr = []; } }
    }
    if (!Array.isArray(arr)) arr = [];
    // 关联度过滤(用户 2026-08-22 定):AI 现在返回 [{w,rel}],rel<40 的直接丢掉 ——
    //   低关联的词补进来会把后续搜索带偏,而且会一直留在衍生池里污染以后每一轮。
    //   兼容老格式(纯字符串数组):没有分数就按通过处理(prompt 已要求 AI 自己先筛一遍)。
    var REL_FLOOR = 40;
    arr = (Array.isArray(arr) ? arr : []).map(function (it) {
      if (it && typeof it === 'object') {
        var rel = Number(it.rel);
        if (isFinite(rel) && rel < REL_FLOOR) return '';
        return String(it.w || it.word || it.keyword || '').trim();
      }
      return String(it || '').trim();
    }).filter(Boolean);
    var have = {};
    seed.forEach(function (k) { have[k] = true; });
    var out = [];
    arr.forEach(function (w) {
      var s = String(w || '').trim();
      if (s && !have[s] && out.indexOf(s) < 0) out.push(s);
    });
    out = out.slice(0, n);
    if (out.length > 0 && typeof ctx.appendKeywords === 'function') {
      try { ctx.appendKeywords(out); } catch (e3) { /* 持久化失败不影响本次使用 */ }
    }
    return out;
  } catch (e) {
    ctx.stepLog(1, 'running', '   ⚠️ AI 衍生关键词失败: ' + String(e && e.message || e).slice(0, 80));
    return [];
  }
}

// v5.x+: search → engage 交替模式 ——
// 之前是 batch-then-process(先把 videosNeeded=80 个 URL 全搜完再开始互动),
// 风控指纹太重(连续滚 30 屏 grab 几十个 URL 再切视频页,不是真人行为)。
// 现在改成"搜 1 个关键词 → 拿一小批(2-5 屏自然量) → 互动这批 → 候选用完
// 再搜下一个关键词"。candidates 作为 queue,主循环按需 refill 一小批。
var pickedKeyword = attemptKeywords[0];
var candidates = [];
var seen = {};
var usedKeywords = [];
var passNum = 1;
var MAX_PASSES = 5;
var consecutiveEmptyKeywords = 0;
var diag = { rawElements: 0, noHref: 0, noVideoId: 0, dupes: 0 };

// helper functions 提到外层作用域,runSearchOnce 和 step-2 都能复用
async function queryVideoLinks() {
  try {
    return await _b('query_selector', {
      selector: 'a[href*="/video/"]',
      limit: 80,
      attrs: 'href',
    });
  } catch (qErr) {
    return { __err: qErr };
  }
}
// 完整 page state 诊断 — 失败时塞 log 帮排查 0 命中
async function queryPageState() {
  try {
    return await _b('javascript', {
      // 裸表达式必须自带 return(内核会包 (function(){ code })(),无 return 则恒 undefined)。
      code:
        'return JSON.stringify({' +
        'readyState:document.readyState,' +
        'docHeight:document.documentElement.scrollHeight,' +
        'scrollY:Math.round(window.scrollY),' +
        'aHrefVideoCount:document.querySelectorAll(\'a[href*="/video/"]\').length,' +
        'searchTopItemCount:document.querySelectorAll(\'[data-e2e="search_top-item"]\').length,' +
        'allDataE2eCount:document.querySelectorAll(\'[data-e2e]\').length,' +
        'url:(location.pathname+location.search).slice(0,100)' +
        '})',
    });
  } catch (_) { return null; }
}

// 单次完整搜索 + 累积候选。
//   - passNum: 第几轮(1=首轮,>=2 表示同一批关键词重跑)。重跑时 preScrollCount
//     按 passNum 翻倍,深翻新页避免拿到全 seen 的首屏重复
// 返回新增的候选数(0 = 这关键词空手或全重复)。
// 单次 nav/click/type/submit/collect 失败软返回 0 让外层换关键词,不直接 bail。
async function runSearchOnce(kw, passNum) {
  passNum = passNum || 1;
  pickedKeyword = kw;
  usedKeywords.push(kw);

  // 真用户搜索路径 —
  //   1. navigate /explore
  //   2. click button[data-e2e="nav-search"] 展开搜索面板
  //   3. focus visible input (page 上有 2 个同 data-e2e,visible:true 拿对的那个)
  //   4. _b('type', ...) 写入
  //   5. form.requestSubmit() 触发 isTrusted=true 的 native submit
  var ttHomeUrl = 'https://www.tiktok.com/explore';
  ctx.stepLog(1, 'running', '   🌐 打开 TikTok: ' + ttHomeUrl);
  try {
    await _navigate(ttHomeUrl);
  } catch (e) {
    ctx.stepLog(1, 'running', '   ⚠️ 关键词「' + kw + '」导航失败,换下一个: ' + String(e && e.message || e).slice(0, 80));
    return 0;
  }
  await jsleep(beh.first_screen_pause || [6000, 12000]);

  // step a: 点 nav-search 展开搜索面板
  ctx.stepLog(1, 'running', '   🔎 展开搜索面板...');
  try {
    await _b('main_world_click', {
      selector: 'button[data-e2e="nav-search"]',
      clickOnce: true,
    });
  } catch (_) { /* 按钮不存在(可能 panel 已展开或别的状态)— 忽略,后面靠 visible filter 兜底 */ }
  await jsleep([1500, 3500]);

  // step b: focus visible input — 同 selector 有 2 个(hidden+visible),
  // visible:true 让 background 在 MAIN world 遍历选 bounds.width>0 那个
  ctx.stepLog(1, 'running', '   🔎 点击搜索框...');
  try {
    await _b('main_world_click', {
      selector: 'input[data-e2e="search-user-input"]',
      visible: true,
      clickOnce: true,
    });
  } catch (e) {
    ctx.stepLog(1, 'running', '   ⚠️ 关键词「' + kw + '」搜索框点击失败,换下一个: ' + String(e && e.message || e).slice(0, 80));
    return 0;
  }
  await jsleep([1500, 3500]);

  ctx.stepLog(1, 'running', '   ⌨️ 输入「' + kw + '」...');
  try {
    await _b('type', { text: kw, perChar: true, charDelay: [60, 180] });
  } catch (e) {
    ctx.stepLog(1, 'running', '   ⚠️ 关键词「' + kw + '」输入失败,换下一个: ' + String(e && e.message || e).slice(0, 80));
    return 0;
  }
  await jsleep([1500, 3000]);

  ctx.stepLog(1, 'running', '   🔍 提交搜索 (form.requestSubmit)...');
  // 唯一能跳转的: form.requestSubmit() 触发原生 form submit,绕过 React 的
  // isTrusted 检查,直接走 GET /search?q=... 路径
  await _b('form_request_submit', {
    selector: 'form[data-e2e="search-box"]',
    visible: true,
  }).catch(function () { /* navigation 可能让 message 通道断,忽略 */ });
  await jsleep([3500, 5000]);

  // URL 校验:跳到 /search 才算真提交。没跳就 Enter 兜底
  var submitted = false;
  try {
    var urlRes = await _b('get_url');
    var curUrl = (urlRes && urlRes.url) || (urlRes && urlRes.data && urlRes.data.url) || '';
    submitted = /\/search(\b|\/|\?)/.test(curUrl);
    if (submitted) {
      ctx.stepLog(1, 'running', '   ✅ 已跳转到搜索结果页');
    } else {
      ctx.stepLog(1, 'running', '   ⚠️ form.requestSubmit 后 URL 未跳转 (' + curUrl.slice(0, 80) + '),退回 Enter 兜底');
    }
  } catch (urlErr) {
    ctx.stepLog(1, 'running', '   ⚠️ get_url 失败,假设没跳转,退回 Enter 兜底: ' + String(urlErr).slice(0, 80));
  }

  if (!submitted) {
    try {
      await _b('keypress', { key: 'Enter' });
    } catch (e2) {
      ctx.stepLog(1, 'running', '   ⚠️ 关键词「' + kw + '」回车也失败,换下一个: ' + String(e2 && e2.message || e2).slice(0, 80));
      return 0;
    }
  }
  await jsleep([5000, 9000]);

  // 单次搜索只拿"一小批"(2-5 屏自然量)。重轮 × passNum 但封顶 12 屏,
  // 避免异常深翻指纹。
  var basePreScroll = randInt(2, 5);
  var preScrollCount = Math.min(12, basePreScroll * passNum);
  ctx.stepLog(1, 'running', '   📜 AI 浏览搜索结果 ' + preScrollCount + ' 屏 (当前候选池 ' + candidates.length + ' 个)');
  for (var s = 0; s < preScrollCount; s++) {
    if (ctx.aborted && ctx.aborted()) return 0;
    var ttCurRes = null;
    try { ttCurRes = await _b('query_selector', { selector: 'a[href*="/video/"]', limit: 80, attrs: 'href' }); } catch (_) {}
    var ttCurEls = unwrapElements(ttCurRes);
    if (ttCurEls.length > 0 && ttCurEls[ttCurEls.length - 1].href) {
      var ttLastSel = 'a[href="' + String(ttCurEls[ttCurEls.length - 1].href).replace(/"/g, '\\"') + '"]';
      try { await _b('scroll_to', { selector: ttLastSel }); } catch (_) {}
      ctx.stepLog(1, 'running', '   AI 滚动 ' + (s + 1) + '/' + preScrollCount + ' (已加载 ' + ttCurEls.length + ' 个)');
    } else {
      try { await _scroll(randInt(2, 4)); } catch (_) {}
      ctx.stepLog(1, 'running', '   AI 滚动 ' + (s + 1) + '/' + preScrollCount);
    }
    await jsleep(beh.feed_scroll_pause || [3000, 8000]);
  }

  // 3 attempts: 立即 → 5s 后 → 10s 后,给慢 hydrate / 风控延迟留余量
  var collectRes = null;
  var elements = [];
  var waitSchedule = [0, 5000, 10000];
  for (var ra = 0; ra < waitSchedule.length; ra++) {
    if (waitSchedule[ra] > 0) {
      ctx.stepLog(1, 'running', '   ⏳ 第 ' + (ra) + ' 次 0 命中,等 ' + Math.round(waitSchedule[ra]/1000) + 's 后再试');
      await jsleep([waitSchedule[ra], waitSchedule[ra] + 2000]);
    }
    collectRes = await queryVideoLinks();
    if (collectRes && collectRes.__err) {
      ctx.stepLog(1, 'running', '   ⚠️ 关键词「' + kw + '」收集失败,换下一个: ' + String(collectRes.__err && collectRes.__err.message || collectRes.__err).slice(0, 80));
      return 0;
    }
    elements = unwrapElements(collectRes);
    if (elements.length > 0) break;
  }
  diag.rawElements += elements.length;
  var addedThisRound = 0, dupesThisRound = 0;
  for (var k = 0; k < elements.length; k++) {
    var href = elements[k].href;
    if (!href) { diag.noHref++; continue; }
    var m = String(href).match(/\/(@[\w.\-_]+)\/video\/(\d{15,25})/);
    if (!m) { diag.noVideoId++; continue; }
    var canon = 'https://www.tiktok.com/' + m[1] + '/video/' + m[2];
    if (seen[canon]) { diag.dupes++; dupesThisRound++; continue; }
    seen[canon] = 1;
    candidates.push(canon);
    addedThisRound++;
  }
  // 失败时打详细 page state — 帮诊断"为什么 query 拿 0 但 page 实际有内容"
  var diagSuffix = '';
  if (addedThisRound === 0 && elements.length === 0) {
    var ps = await queryPageState();
    var psResult = (ps && ps.result !== undefined) ? ps.result : ps;
    diagSuffix = ' | pageState:' + (typeof psResult === 'string' ? psResult.slice(0, 200) : JSON.stringify(psResult).slice(0, 200));
  }
  ctx.stepLog(1, 'running',
    '🔍 关键词「' + kw + '」: 扫到 ' + elements.length + ' 个 a[href*="/video/"]'
    + ' → 新增 ' + addedThisRound + ' (当前候选池 ' + candidates.length
    + ',去重 ' + dupesThisRound + ')' + diagSuffix);
  return addedThisRound;
}

// 搜索下一个未用关键词,拿一小批候选 push 进 candidates。
async function searchNextKeyword(stepNum) {
  stepNum = stepNum || 1;
  // 【停止即断】用户点停止后 ctx.sleep 全部秒回、runSearchOnce 采集必 0 —— 若不在这里断,
  //   循环会把「停止」误解成「没搜到」疯狂换词冲完整个关键词池 + 白调 AI 衍生词(真机实测 16 词 56 秒)。
  if (ctx.aborted && ctx.aborted()) {
    ctx.stepLog(stepNum, "running", "🛑 用户已停止 — 结束搜索补货");
    return { added: 0, exhausted: true };
  }
  var kw = null;
  for (var ki = 0; ki < attemptKeywords.length; ki++) {
    if (usedKeywords.indexOf(attemptKeywords[ki]) === -1) {
      kw = attemptKeywords[ki];
      break;
    }
  }
  if (kw === null) {
    if (passNum >= MAX_PASSES) {
      // v6: 跑满 MAX_PASSES 轮仍要补货 = 原关键词新鲜内容搜尽 → AI 衍生一批新词接续(整个任务只一次)。
      var gotMore = false;
      if (!kwDerivedOnce) {
        kwDerivedOnce = true;
        var more = await deriveMoreEngageKeywords(keywordsList.slice(), 5);
        if (more.length > 0) {
          for (var mi = 0; mi < more.length; mi++) { attemptKeywords.push(more[mi]); keywordsList.push(more[mi]); }
          ctx.stepLog(stepNum, 'running', '   🔁 原关键词新鲜内容已搜尽 → AI 衍生新词接续: ' + more.join('、'));
          gotMore = true;
        }
      }
      if (!gotMore) {
        ctx.stepLog(stepNum, 'running',
          '🛑 已跑 ' + MAX_PASSES + ' 轮关键词 — 候选池耗尽,停止补货');
        return { added: 0, exhausted: true };
      }
      // 衍生成功:usedKeywords 仍含旧词,下面从首个【未用】的新词继续搜(不重置 passNum)。
    } else {
      passNum++;
      usedKeywords = [];
      kw = attemptKeywords[0];
      ctx.stepLog(stepNum, 'running', '🔄 关键词池跑完一轮 — 进入第 ' + passNum + ' 轮(同关键词二刷,深翻避免 seen 重复)');
    }
    if (kw === null) {
      for (var kk = 0; kk < attemptKeywords.length; kk++) {
        if (usedKeywords.indexOf(attemptKeywords[kk]) === -1) { kw = attemptKeywords[kk]; break; }
      }
    }
    if (kw === null) {
      return { added: 0, exhausted: true };
    }
  }
  if (passNum === 1 && usedKeywords.length === 0) {
    ctx.stepLog(stepNum, 'running', '🤖 AI 智能挑选关键词: 「' + kw + '」 → 模拟用户搜索 TikTok...');
  } else {
    ctx.stepLog(stepNum, 'running',
      '🔍 第 ' + passNum + ' 轮 · 关键词 ' + (usedKeywords.length + 1) + '/' + attemptKeywords.length
      + '「' + kw + '」搜索...');
  }
  var before = candidates.length;
  await runSearchOnce(kw, passNum);
  var added = candidates.length - before;
  if (added === 0) {
    consecutiveEmptyKeywords++;
    if (consecutiveEmptyKeywords >= attemptKeywords.length * 2) {
      // v6: 连续多个关键词都 0 新候选 = 新鲜内容搜尽 → AI 衍生一批新词接续(整个任务只一次)。
      if (!kwDerivedOnce) {
        kwDerivedOnce = true;
        var more2 = await deriveMoreEngageKeywords(keywordsList.slice(), 5);
        if (more2.length > 0) {
          for (var mj = 0; mj < more2.length; mj++) { attemptKeywords.push(more2[mj]); keywordsList.push(more2[mj]); }
          consecutiveEmptyKeywords = 0;
          ctx.stepLog(stepNum, 'running', '   🔁 原关键词新鲜内容已搜尽 → AI 衍生新词接续: ' + more2.join('、'));
          return { added: 0, exhausted: false };
        }
      }
      ctx.stepLog(stepNum, 'running',
        '🛑 连续 ' + consecutiveEmptyKeywords + ' 个关键词都 0 新候选 — 候选池真的耗尽,停止补货');
      return { added: 0, exhausted: true };
    }
  } else {
    consecutiveEmptyKeywords = 0;
  }
  return { added: added, exhausted: false };
}
// ──── 拷贝结束 ────
// 关键词由客户端按执行账号注入(task.keywords),要原样使用:关掉「AI 衍生新关键词」(那条路会调 ctx.appendKeywords 改写任务关键词)。
//   关键词用尽时由下面主流程自己重开一轮。
kwDerivedOnce = true;

// ── 主流程 ──
//   精准模式 = lead 精准模式的种子循环(去掉收潜客),链接处理与改版前完全一样;
//   关键词模式 = 搜索(上面原样拷来的 searchNextKeyword)→ 逐条作品 likeWorkHere → 关键词轮流用,直到时长上限。
ctx.stepStart(1);
if (!DO_LIKE && !DO_REPLY) {
  ctx.stepLog(1, 'error', '「点赞」和「回复」都没勾选,这个任务没事可做 —— 请在任务里至少勾选一项');
  ctx.finish('error', 'nothing_to_do');
  return { status: 'failed', reason: 'nothing_to_do' };
}
if (!DO_LIKE && !REPLY.on) {
  ctx.stepLog(1, 'error', '只勾了「回复」,但这次没法回复(缺少回复提示词),先停下');
  ctx.finish('error', 'nothing_to_do');
  return { status: 'failed', reason: 'nothing_to_do' };
}
if (MODE === 'precise' && !urls.length) {
  ctx.stepLog(1, 'error', '没有可用的 TikTok 作品 / 主页链接');
  ctx.finish('error', 'no_urls');
  return { status: 'failed', reason: 'no_urls' };
}
if (MODE === 'keywords' && !keywordsList.length) {
  ctx.stepLog(1, 'error', '关键词模式没有可用的关键词 —— 请先给执行账号设置关键词');
  ctx.finish('error', 'no_keywords');
  return { status: 'failed', reason: 'no_keywords' };
}
ctx.stepLog(1, 'running', '🛡️ 安全上限:单次最长 ' + fmtSec(MAX_RUN_MS / 1000)
  + (DO_LIKE ? ' · 每号每天点赞 ≤' + DAY_LIKE_CAP + '(今天已 ' + daily.like + ')' : '')
  + (DO_REPLY ? ' · 每号每天回复 ≤' + DAY_REPLY_CAP + '(今天已 ' + daily.reply + ')' : ''));
if (DO_REPLY && daily.reply >= DAY_REPLY_CAP) {
  REPLY.on = false; REPLY.capLogged = true;
  ctx.stepLog(1, 'warn', '   ⏹️ 这个号今天的回复已到每日安全上限,本次不回复');
}
if (DO_LIKE && daily.like >= DAY_LIKE_CAP) {
  DO_LIKE = false;
  ctx.stepLog(1, 'warn', '   ⏹️ 这个号今天的评论区点赞已到每日安全上限,本次不点赞' + (REPLY.on ? ',只回复' : ''));
}
if (!DO_LIKE && !REPLY.on) {
  ctx.stepLog(1, 'done', '今天的安全上限已经用完,明天再跑');
  ctx.stepDone(1);
  ctx.finish('done');
  return { status: 'ok', action_count: { like: 0, comment: 0 }, reason: 'daily_cap' };
}
var DO_TXT = (DO_LIKE ? '点赞' : '') + (DO_LIKE && REPLY.on ? ' + ' : '') + (REPLY.on ? (MODE === 'keywords' ? '回复一半留言' : '逐条回复') : '');
if (MODE === 'precise') {
  ctx.stepLog(1, 'running', '🎯 精准模式 · 本次共 ' + urls.length + ' 条链接(作品或博主主页) · 点开 → 评论区逐条' + DO_TXT + ' → 上滑下一条,刷完博主全部作品');
} else {
  ctx.stepLog(1, 'running', '🔎 关键词模式 · ' + keywordsList.length + ' 个关键词 · 搜视频 → 评论区' + DO_TXT + ' → 下一条,关键词轮流用,到时长上限为止');
}
if (REPLY.on) ctx.stepLog(1, 'running', '🧑 回复人设:' + (PERSONA ? PERSONA.slice(0, 60) : '(未设置,按普通观众口吻)'));
await ensureTaskTabOpenedOnce('tiktok', 'main', 'https://www.tiktok.com/');
if (_activeTab) _ttHomeAt = Date.now();
var SEED_WORKS_CAP = beh.seed_works_cap || 50;
var doneWorkIds = Object.create(null);
var _authorsDone = Object.create(null);
try {
  if (MODE === 'precise') {
    for (var si = 0; si < urls.length; si++) {
      if (shouldStop()) break;
      var seed = urls[si];
      if (isShortLink(seed)) {
        ctx.stepLog(1, 'running', '── 短链 ' + (si + 1) + '/' + urls.length + ' · 先打开看指向哪 ──');
        var _final = await resolveShortLink(seed, 1);
        if (!_final) continue;
        seed = _final;
      }
      if (videoIdOf(seed)) {
        ctx.stepLog(1, 'running', '── 指定作品 ' + (si + 1) + '/' + urls.length + ' ──');
        var _fv = videoIdOf(seed);
        if (!doneWorkIds[_fv]) { doneWorkIds[_fv] = 1; await likeWorkHere(String(seed).split('?')[0]); }
        if (shouldStop()) break;
        await jsleep(beh.feed_scroll_pause || [3000, 8000]);
        var _wa = authorOfVideoUrl(seed);
        if (!_wa || _authorsDone[_wa] || beh.work_link_then_author === false) continue;
        ctx.stepLog(1, 'running', '   ➡️ 接着去博主 @' + _wa + ' 的主页,从他第一条作品开始逐条刷');
        seed = 'https://www.tiktok.com/@' + _wa;
      }
      var ph = profileHandleOf(seed) || normHandle(seed);
      if (!ph) { ctx.stepLog(1, 'warn', '   ⚠️ 认不出这条链接,跳过: ' + String(urls[si]).slice(0, 60)); continue; }
      if (_authorsDone[ph]) continue;
      _authorsDone[ph] = 1;
      ctx.stepLog(1, 'running', '── 博主 ' + (si + 1) + '/' + urls.length + ' · @' + ph + ' ──');
      try { await _navigate('https://www.tiktok.com/@' + ph); } catch (e) {
        ctx.stepLog(1, 'running', '   ⚠️ 打不开主页,跳过: ' + String(e && e.message || e).slice(0, 60));
        continue;
      }
      await jsleep(beh.first_screen_pause || [6000, 10000]);
      if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', action_count: { like: done.like, comment: done.reply } }; }
      var seedVideos = await collectVideoLinksOnPage(SEED_WORKS_CAP, ph);
      if (!seedVideos.length) { ctx.stepLog(1, 'running', '   ⚠️ 这个账号没有可见作品,跳过'); continue; }
      ctx.stepLog(1, 'running', '   🎬 点开他的第一条作品,逐条' + DO_TXT + '、上滑下一条');
      await swipeLike(seedVideos, ph);
    }
  } else {
    // 关键词模式:候选用完就搜下一个词;searchNextKeyword 报「耗尽」就重开一轮(重新洗牌、清搜索去重),
    //   做过的作品本次不再做(doneWorkIds)。连续两轮一条新作品都没做到 = 真搜不到新东西了,提前收工。
    var kwIdleCycles = 0, worksAtCycleStart = 0;
    while (!shouldStop()) {
      if (!candidates.length) {
        var sr = await searchNextKeyword(1);
        if (shouldStop()) break;
        if (sr && sr.exhausted) {
          var worksNow = done.works + done.worksSkipped;
          if (worksNow === worksAtCycleStart) kwIdleCycles++; else kwIdleCycles = 0;
          if (kwIdleCycles >= 2) { ctx.stepLog(1, 'warn', '   ⏹️ 关键词连续两轮都搜不到新作品,先收工(可以给账号多配几个关键词)'); break; }
          worksAtCycleStart = worksNow;
          passNum = 1; usedKeywords = []; consecutiveEmptyKeywords = 0; seen = {};
          attemptKeywords = shuffleKw(keywordsList);
          var restMs = randInt(60000, 120000);
          ctx.stepLog(1, 'running', '   🔄 这一轮关键词用完了,歇 ' + fmtSec(restMs / 1000) + ' 后从头再轮一遍');
          await sleepWithHeartbeat(1, restMs, '换一轮关键词前歇一会');
        }
        continue;
      }
      var kurl = candidates.shift();
      var kvid = videoIdOf(kurl);
      if (!kvid || doneWorkIds[kvid]) continue;
      doneWorkIds[kvid] = 1;
      if (selfHandle && authorOfVideoUrl(kurl) === selfHandle) continue;   // 自己的作品不刷
      ctx.stepLog(1, 'running', '── 关键词「' + pickedKeyword + '」· 第 ' + (done.works + done.worksSkipped + 1) + ' 条作品 · ' + kurl + ' ──');
      await likeWorkHere(kurl);
      if (shouldStop()) break;
      await jsleep(beh.between_works_pause || [3000, 8000]);
    }
  }
} catch (e) {
  if (String(e && e.message) === 'LEAD_CAPTCHA_ABORT') return { status: 'failed', reason: 'captcha', action_count: { like: done.like, comment: done.reply } };
  throw e;
}
var STOP_TXT = stopReason === 'time' ? '(到了单次时长上限)' : stopReason === 'like_cap' ? '(到了每日点赞安全上限)' : stopReason === 'reply_cap' ? '(回复停了)' : '';
ctx.stepLog(1, 'done', '本次共点赞 ' + done.like + ' 个留言' + (DO_REPLY ? ' · 回复 ' + done.reply + ' 条' : '') + ' · 打开作品 ' + done.works + ' 条'
  + (done.worksSkipped ? ' · 跳过 ' + done.worksSkipped + ' 条' : '') + STOP_TXT);
ctx.stepDone(1);

ctx.stepStart(2);
var md = '# TikTok 评论区点赞评论报告 · ' + RUN_STAMP + '\n\n'
  + '- 模式:' + (MODE === 'keywords' ? '关键词(' + keywordsList.slice(0, 10).join('、') + ')' : '精准链接') + '\n'
  + '- 本次点赞:**' + done.like + '** 个留言\n'
  + '- 之前已赞过、本次跳过:' + done.already + '\n'
  + (done.failed ? '- 点赞失败:' + done.failed + '\n' : '')
  + (DO_REPLY ? '- 本次回复:**' + done.reply + '** 条' + (done.replyFailed ? '(没回上 ' + done.replyFailed + ' 条)' : '') + '\n' : '')
  + (STOP_TXT ? '- 结束原因:' + STOP_TXT.replace(/[()]/g, '') + '\n' : '')
  + '\n## 逐条作品\n\n';
for (var pi = 0; pi < perWork.length; pi++) {
  var P = perWork[pi];
  md += (pi + 1) + '. ' + P.url + ' — 👍×' + P.like + (P.reply ? ' · 💬×' + P.reply : '') + (P.already ? ' · 已赞跳过 ' + P.already : '') + (P.failed ? ' · 失败 ' + P.failed : '') + (P.note ? ' · ' + P.note : '') + '\n';
}
md += '\n---\n\n*由 NoobClaw TikTok 评论区点赞评论任务生成*\n';
if (typeof ctx.writeReport === 'function') {
  try {
    var wr = await ctx.writeReport('TikTok评论区点赞评论-' + RUN_STAMP + '.md', md);
    if (wr && wr.ok) ctx.stepLog(2, 'running', '✅ 运行报告已保存 → ' + wr.path);
  } catch (_) {}
}
ctx.stepLog(2, 'done', '💗 本次在评论区点赞 ' + done.like + ' 个' + (DO_REPLY ? ' · 💬 回复 ' + done.reply + ' 条' : ''));
ctx.stepDone(2);

ctx.finish('done');
return { status: 'ok', action_count: { like: done.like, comment: done.reply }, already: done.already, failed: done.failed, works: done.works, replies: done.reply };
