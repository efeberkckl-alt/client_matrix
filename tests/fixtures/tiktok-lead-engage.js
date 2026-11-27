/**
 * orchestrator.js — TikTok 定向获客 (tiktok_lead_engage)。
 *
 * 完全独立的卡片/剧本,与 tiktok_auto_engage(互动涨粉)互不影响;互动子函数
 * (tryLike/tryFollow/tryComment 等)按【矩阵复用铁律】从该剧本整段 copy,原地维护。
 *
 * 两段式流程(2026-08-16 与用户逐条对齐):
 *   STEP 1 · 采集潜客:
 *     - 模式 accounts(精准获客):逐个打开用户填的同行账号主页(≤50 个),遍历其作品
 *       (每个源账号最多翻 50 条),逐条开评论区、滚动加载,收【除作者外】的评论者 handle。
 *     - 模式 keywords(关键词获客):按赛道关键词搜视频,同样只收评论者。
 *     - 名单是【长期账本】(ctx.readState/writeState,<matrixDir>/state/tiktok/<acct>/lead_ledger.json):
 *       本地已有的 handle 不重复入库、不重复计费;每收 1 个【新】潜客计费 lead_collect 一次。
 *       收够 max_leads(1-5000)立即停止采集。
 *   STEP 2 · 触达互动(新旧客一起,长期轮转):
 *     - 触达队列 = 【本次新获得的潜客按获得时间倒序排最前】,其次是老客(上次互动最久优先);
 *       每次运行最多触达 leads_per_run 人。
 *     - 配额是【本次总量】:max_likes / max_follows / max_comments。每人分到多少 = 总量 ÷ 实际
 *       触达人数(向上取整,优先保证「互动潜客人数」跑满);跑完一轮额度没用满会再轮一遍名单。
 *     - 每人每次只挑【没互动过】的作品,
 *       只挑【没互动过】的作品(账本记 doneVideoIds → 第二次跑自动换新作品,形成长期互动);
 *       关注终身一次(账本记 followed)。私密号/无作品 → 只关注。
 *   STEP 3 · 名单落盘 + 报告:
 *     - 全量名单固定写 `TikTok潜在客户名单.txt`(持续增长,每次全量重写);
 *     - 进度里明确:「📇 同行的潜在客户:本地累计 X 人 · 本次新增 Y 人」+ 每个触达对象标注(新客/旧客)。
 *
 * DOM 依据(2026-08-16 真机实测):评论区默认收起,点 [data-e2e="comment-icon"] 展开;
 * 评论者 handle 取 [data-e2e^="comment-level"] 容器里的 a[href^="/@"];点赞控件是
 * div[role=button] 且 aria-pressed 挂在图标自身(详见 SEL_LIKE_BTN 注释)。
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
var _tt403At = 0;   // 最近一次撞 HTTP 403 的时间
async function _ttViaHome(url) {
  if (_ttIsHomeUrl(url)) { if (/tiktok\.com/i.test(String(url || ''))) _ttHomeAt = Date.now(); return; }
  if (Date.now() - _ttHomeAt < 12000) return;
  // 2026-10-26 用户反馈「暂无内容也要等半天才跳过」:原来每次距上次进首页超过 12s 就先进首页再停 7-9s,
  //   每位潜客平均多出近 10 秒。改成【只在最近 3 分钟撞过 403 时】才走首页热身,平时直达。
  if (Date.now() - _tt403At > 180000) return;
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
    await ctx.sleep(500, 800);   // 原 1.5-2.5s;页面是否就绪由调用方 waitReady 判断
    if (!(await _isHttpErrorPage())) { if (lastErr) throw lastErr; __hudPush(null); return; }
    _tt403At = Date.now();
    ctx.report('⚠️ TikTok 拒绝了这次页面请求(HTTP 403,瞬时风控)' + (attempt < 2 ? ',等几秒后重载 ' + (attempt + 2) + '/3' : ',连续 3 次被拒,跳过这条'));
    if (attempt < 2) await ctx.sleep(4000 + attempt * 4000, 8000 + attempt * 6000);
  }
  throw new Error('http_403_blocked');
}
// ── 运行提示卡(HUD)· 2026-10-27 用户要求:参考插件浏览器的「运行中」提示框,做得更好看,并用一行显示进度 ──
//   剧本侧注入(热更新即生效,先在 TikTok 定向获客试验):每写一条日志就把最新进度刷到卡片上。
//   防干扰/防识别:pointer-events:none(可信点击和 elementFromPoint 命中测试都会穿透它);
//   内容在 closed shadowRoot 里、宿主不带 id/class,页面脚本读不到文案;只在顶层文档渲染。
//   整页跳转后卡片随旧页面销毁 —— _navigate 完成后立即补画一次。
var __hud = { step: 1, msg: '准备开始…', n: { lead: 0, like: 0, follow: 0, comment: 0 }, t0: Date.now(), busy: false, dirty: false, last: 0 };
var __HUD_STEPS = { 1: '采集潜客', 2: '触达互动', 3: '整理名单' };
var __HUD_JS = '(function(D){try{if(window.top!==window.self)return 0;}catch(e){return 0;}'
  + 'try{var K="__ncHud9";var h=window[K];'
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
  + '.t{font-weight:700;color:#86efac;white-space:nowrap}'
  + '.s{font-size:11.5px;font-weight:600;color:#bbf7d0;background:rgba(34,197,94,.16);border:1px solid rgba(74,222,128,.35);border-radius:999px;padding:1px 8px;margin-left:6px}'
  + '.n{font-variant-numeric:tabular-nums;color:#d1fae5;white-space:nowrap;font-size:12.5px}'
  + '.n b{color:#fff;font-weight:700}'
  + '.p{display:flex;align-items:center;gap:8px;margin-top:7px;color:#f0fdf4}'
  + '.d{flex:none;width:7px;height:7px;border-radius:50%;background:#4ade80;box-shadow:0 0 0 0 rgba(74,222,128,.7);animation:pu 1.6s infinite}'
  + '.m{flex:1;min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}'
  + '.e{flex:none;color:#86efac;font-variant-numeric:tabular-nums;font-size:12px}'
  + '.b{position:absolute;left:0;bottom:0;height:2px;width:35%;background:linear-gradient(90deg,transparent,#4ade80,transparent);animation:mv 2.4s linear infinite}'
  + '@keyframes pu{0%{box-shadow:0 0 0 0 rgba(74,222,128,.7)}70%{box-shadow:0 0 0 7px rgba(74,222,128,0)}100%{box-shadow:0 0 0 0 rgba(74,222,128,0)}}'
  + '@keyframes mv{0%{left:-35%}100%{left:100%}}'
  + '</style><div class="c"><div class="w">⚠️ 运行中,请勿切换标签页 / 缩小窗口,以免干扰运行</div>'
  + '<div class="r"><div><span class="t">🐾 NoobClaw · TikTok 定向获客</span><span class="s"></span></div><div class="n"></div></div>'
  + '<div class="p"><span class="d"></span><span class="m"></span><span class="e"></span></div><div class="b"></div></div>\';'
  + 'var q=function(x){return sr.querySelector(x);};'
  + 'h={host:host,s:q(".s"),n:q(".n"),m:q(".m"),e:q(".e")};'
  + 'try{Object.defineProperty(window,K,{value:h,enumerable:false,configurable:true,writable:true});}catch(_){window[K]=h;}'
  + 'root.appendChild(host);}'
  + 'h.s.textContent=D.s;h.n.innerHTML=D.n;h.m.textContent=D.m;h.e.textContent=D.e;'
  // 剧本结束/被停止后不会再有更新 → 最后一次更新 90s 后自动撤掉卡片,不留一张「运行中」在页面上
  + 'try{clearTimeout(h.t);}catch(_){}h.t=setTimeout(function(){try{h.host.remove();}catch(_){}},90000);'
  + 'return 1;}catch(e){return 0;}})';
function __hudEsc(x) { return String(x).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }
function __hudData() {
  var sec = Math.floor((Date.now() - __hud.t0) / 1000);
  var el = (sec >= 3600 ? Math.floor(sec / 3600) + ':' : '') + ('0' + Math.floor(sec / 60) % 60).slice(-2) + ':' + ('0' + sec % 60).slice(-2);
  var n = __hud.n;
  return {
    s: '第 ' + __hud.step + '/3 步 · ' + (__HUD_STEPS[__hud.step] || ''),
    n: '👥 <b>' + n.lead + '</b> &nbsp;👍 <b>' + n.like + '</b> &nbsp;➕ <b>' + n.follow + '</b> &nbsp;💬 <b>' + n.comment + '</b>',
    m: String(__hud.msg || '').replace(/\s+/g, ' ').trim().slice(0, 160),
    e: '⏱ ' + el,
  };
}
async function __hudFlush() {
  if (__hud.busy) { __hud.dirty = true; return; }
  __hud.busy = true;
  try {
    do {
      __hud.dirty = false;
      var wait = 700 - (Date.now() - __hud.last);
      if (wait > 0) await new Promise(function (r) { setTimeout(r, wait); });
      __hud.last = Date.now();
      try { await _b('cdp_eval', { expression: __HUD_JS + '(' + JSON.stringify(__hudData()).split(String.fromCharCode(8232)).join(' ').split(String.fromCharCode(8233)).join(' ') + ')', awaitPromise: false }, 3000); } catch (_) {}
    } while (__hud.dirty);
  } finally { __hud.busy = false; }
}
function __hudPush(msg) { if (msg != null) __hud.msg = msg; __hudFlush().catch(function () {}); }
(function () {
  var oLog = ctx.stepLog, oRep = ctx.report, oStart = ctx.stepStart, oAdd = ctx.addActionCount;
  if (typeof oLog === 'function') ctx.stepLog = function (st, lvl, m) { var r = oLog.apply(ctx, arguments); try { if (typeof st === 'number' && __HUD_STEPS[st]) __hud.step = st; __hudPush(m); } catch (_) {} return r; };
  if (typeof oRep === 'function') ctx.report = function (m) { var r = oRep.apply(ctx, arguments); try { __hudPush(m); } catch (_) {} return r; };
  if (typeof oStart === 'function') ctx.stepStart = function (st) { var r = oStart.apply(ctx, arguments); try { if (__HUD_STEPS[st]) { __hud.step = st; __hudPush('开始' + __HUD_STEPS[st] + '…'); } } catch (_) {} return r; };
  if (typeof oAdd === 'function') ctx.addActionCount = function (k, v) {
    var r = oAdd.apply(ctx, arguments);
    try { var key = k === 'lead_new' ? 'lead' : k; if (key in __hud.n) { __hud.n[key] += (Number(v) || 1); __hudPush(null); } } catch (_) {}
    return r;
  };
})();

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

// ── Per-action quota ranges from task / defaults ──
// 种子号可能是【完整主页链接】(用户粘什么存什么),也可能是裸 id(老任务)。
//   ⚠️ 小红书主页/笔记 URL 带 ?xsec_token=,自己拆了再拼会把它丢掉,页面就打不开
//   (2026-08-22 用户指出:精准模式读不到同行昵称就是这么来的)。所以看到 http 开头
// seed 的【裸 id 形态】。seedUrl() 管导航(整条链接原样用),这个管【比较和拼接】——
//   凡是要拿 seed 去跟「页面上读到的裸 id」比对、或者拼进别的 URL 的地方,都必须用它。
//   2026-08-22 审计:seedUrl 只覆盖了导航,漏了这几类地方,结果三家精准模式当场归零
//   (bilibili 拼出 space.bilibili.com/https://space.bilibili.com/...、
//    tiktok 拿裸 handle 跟整条 URL 比恒 false、xhs 笔记归属过滤把自己的笔记全剔了)。
function seedId(s) {
  return normHandle(String(s || '').trim());
}

//   就原样用,绝不重新拼装。
function seedUrl(s, build) {
  var v = String(s || '').trim();
  if (/^https?:\/\//i.test(v)) return v;
  return build(v);
}

function pickInt(taskVal, defaultVal, fallback) {
  if (typeof taskVal === 'number') return taskVal;
  if (typeof defaultVal === 'number') return defaultVal;
  return fallback;
}

// ── 定向获客参数(与向导字段一一对应) ──
function randInt(a, b) { return Math.floor(Math.random() * (b - a + 1)) + a; }
function clampInt(v, lo, hi) { v = Math.round(Number(v)); if (!(v >= lo)) v = lo; if (v > hi) v = hi; return v; }

// handle 归一:接受 "@x" / "x" / "https://www.tiktok.com/@x?lang=en" 三种填法,统一成小写裸 handle。
function normHandle(s) {
  s = String(s || '').trim();
  s = s.replace(/^https?:\/\/(www\.)?tiktok\.com\//i, '');
  s = s.replace(/^@/, '');
  s = s.replace(/[/?#].*$/, '');
  return s.toLowerCase().replace(/[^a-z0-9._]/g, '');
}
// 种子号归一。三种填法:完整主页链接 / @id / 裸 id。
//   ⚠️ 是链接就【原样返回】—— 小红书主页/笔记 URL 带 ?xsec_token=,自己拆了再拼会把它
//   丢掉、页面根本打不开(用户 2026-08-22 指出);抖音分享短链同理。导航侧见 seedUrl()。
//   ⚠️ 认不出来的返回空串,由调用方丢弃并计数 —— 别把「剥完剩下的残渣」当账号:
//   `www.douyin.com/user/xxx`(漏写协议)剥完是 `www.douyin.com`,
//   `https://v.douyin.com/iRabc/`(分享短链)剥完是 `https`,以前这两个都被存了进去。
function normSeed(s) {
  var v = String(s || '').trim();
  if (!v) return '';
  if (/^https?:\/\//i.test(v)) {
    // 光秃秃的域名(https://www.douyin.com)不是主页,别当同行号收下。
    return /^https?:\/\/[^/]+\/[^/?#]/i.test(v) ? v : '';
  }
  var h = normHandle(v);
  if (!h || h.length < 4) return '';
  // 域名残渣 / 协议头残渣
  if (/^(https?|www|com|cn|net|org)$/i.test(h)) return '';
  if (/\.(com|cn|net|org)$/i.test(h)) return '';
  return h;
}


var commentPrompt = (task.comment_prompt || defaults.comment_prompt || '').trim();
var _modeRaw = String(task.mode || defaults.mode || 'accounts');
var leadMode = _modeRaw === 'keywords' ? 'keywords' : (_modeRaw === 'live' ? 'live' : 'accounts');

// 直播间获客(2026-10-19 用户定):填直播间链接(https://www.tiktok.com/@xxx/live,或只填主播账号),
//   停在直播间里收【发弹幕 / 进场】的观众当潜客。弹幕滚得快,所以不看画面:页面里装一个 0.5 秒一次的
//   收集器,直接读每条弹幕背后的用户数据(display_id = @账号),去重攒在 window 上,外层每 2 秒取一次新的。
var liveRooms = [];
(function () {
  var raw = Array.isArray(task.live_urls) ? task.live_urls : [];
  var seen = {};
  for (var i = 0; i < raw.length && liveRooms.length < 20; i++) {
    var s0 = String(raw[i] || '').trim();
    if (!s0) continue;
    var m = s0.match(/tiktok\.com\/@([^\/?#\s]+)/i);
    var h = m ? m[1] : s0.replace(/^@/, '').replace(/[\/?#].*$/, '');
    h = normHandle(h);
    if (!h || seen[h]) continue;
    seen[h] = 1;
    liveRooms.push({ owner: h, url: 'https://www.tiktok.com/@' + h + '/live' });
  }
})();
// 每个直播间最多停多久 / 连续多久没新人就换下一间
var LIVE_MAX_MS = clampInt(pickInt(task.live_dwell_minutes, defaults.live_dwell_minutes, 20), 1, 60) * 60000;
var LIVE_IDLE_MS = 5 * 60000;

// 同行种子账号(accounts 模式):去重、封顶 50。
var seedDropped = 0;   // 认不出来的行数,给用户一个明确提示
var seedAccounts = [];
(function () {
  var raw = Array.isArray(task.seed_accounts) ? task.seed_accounts : [];
  var seen = {};
  for (var i = 0; i < raw.length && seedAccounts.length < 50; i++) {
    var h = normSeed(raw[i]);
    if (!h) { seedDropped++; continue; }
    if (!seen[h]) { seen[h] = 1; seedAccounts.push(h); }
  }
})();
var seedSet = {};
for (var _si = 0; _si < seedAccounts.length; _si++) seedSet[seedAccounts[_si]] = 1;
// seed 可能是整条链接,而评论区解出来的是裸 id —— 两种形态都要进排除集,
//   否则同行本人在自己作品下的留言会被当成潜客收录(还照计费、照互动)。
// 2026-10-19:精准获客的框里可以混填直播间链接 —— 挑出来放进 liveRooms(STEP1 先进直播间收人,再翻同行/作品)。
(function () {
  var keep = [];
  var have = {};
  for (var li = 0; li < liveRooms.length; li++) have[liveRooms[li].url] = 1;
  for (var si0 = 0; si0 < seedAccounts.length; si0++) {
    var raw0 = seedAccounts[si0];
    var m0 = String(raw0).match(/tiktok\.com\/@([^\/?#\s]+)\/live/i);
    if (m0) {
      var room = (function (m) { var h = normHandle(m[1]); return h ? { owner: h, url: 'https://www.tiktok.com/@' + h + '/live' } : null; })(m0);
      if (room && !have[room.url] && liveRooms.length < 20) { have[room.url] = 1; liveRooms.push(room); }
      continue;
    }
    keep.push(raw0);
  }
  seedAccounts = keep;
})();
for (var _si2 = 0; _si2 < seedAccounts.length; _si2++) {
  var _sid = seedId(seedAccounts[_si2]);
  if (_sid) seedSet[typeof handleKey === 'function' ? handleKey(_sid) : _sid] = 1;
}
// 把【执行账号自己】也加进排除集:运营者本人若在被扫的作品下评论过,会被当成潜客
//   入库计费,STEP2 还会对自己点赞/关注/评论。engageRunner 注入了 selfDisplayId /
//   selfUid / selfNickname,取能归一成 handle 的那个。
var selfHandle = normHandle(task.selfDisplayId || task.selfUid || '');
if (selfHandle) seedSet[selfHandle] = 1;

// 🚨 tryComment 是从 tiktok_auto_engage 整段抄来的,它组 prompt 时会读【搜索流的】
//   trackId / pickedKeyword。本剧本重写了配置段、没带这两个变量过来 —— 结果一走到
//   写评论就 ReferenceError: trackId is not defined,整个号被跳过(2026-08-17 用户实测,
//   而且是在关注成功之后才炸,所以前面的动作白做了)。抄函数必须连它依赖的变量一起抄。
var trackId = task.track || 'tiktok_default';
// 关键词模式下会在搜每个词时更新,给 AI 当写评论的语境;精准模式没有关键词,留空。
var pickedKeyword = '';

var keywordsList = Array.isArray(task.keywords) ? task.keywords.filter(Boolean) : [];

// 配置口径(2026-08-21 用户改定):向导填的是【本次总量】,不是每人条数 ——
//   本次获取潜客上限 / 本次最多互动多少人 / 本次点赞·关注·评论各自的总量上限。
//   每人分到几条由剧本按「总量 ÷ 实际触达人数」算(见 STEP2),因为要【优先保证互动人数】。
var maxNewLeads = clampInt(pickInt(task.max_leads, defaults.max_leads, 50), 1, 5000);
// 2026-10-27 用户定:定向获客主要是捞潜客 + 去他们主页点赞 —— 评论区的人【全部捞完、不设名额上限】。
//   要恢复按 max_leads 封顶,设 behavior.lead_unlimited=false。
var LEAD_UNLIMITED = beh.lead_unlimited !== false;
if (LEAD_UNLIMITED) maxNewLeads = 1e9;
var maxLikesTotal = clampInt(pickInt(task.max_likes, defaults.max_likes, 0), 0, 5000);
var maxFollowsTotal = clampInt(pickInt(task.max_follows, defaults.max_follows, 0), 0, 100);
var maxCommentsTotal = clampInt(pickInt(task.max_comments, defaults.max_comments, 0), 0, 300);
var doLike = task.lead_do_like !== false;
// ── AI自主评论开关(task.ai_comment):只有显式 false 才关闭;缺省/老任务 = 开 = 原行为一字不改。
//   关闭时每条评论/回复只发引流语:每次随机取一行 funnel_phrase(最多 20 行),让 AI 用自己的话改写
//   (不照抄、保留意思),不再写针对内容的自由评论;概率视为 100%(忽略 funnel_probability)。
//   没填引流语 → 不发评论/回复(点赞/关注等照常),只记一次日志;
//   改写失败/返回垃圾 → 跳过这一条,绝不发原句、绝不回落成自由评论。
var AI_COMMENT = task.ai_comment !== false;
var LEAD_LINES = String(task.funnel_phrase || '').split(/\r?\n/).map(function (x) { return x.trim(); }).filter(Boolean).slice(0, 20);
var LEAD_ONLY_NO_PHRASE = !AI_COMMENT && LEAD_LINES.length === 0;
// funnel_rewrite:只有显式 false 才关闭 AI 改写(各账号模式下由客户端把本账号的值拍平到 task.funnel_rewrite)。
//   关闭时引流语【原样】使用:AI自主评论关 → 直接发随机选中的那一行(不调 AI);
//   AI自主评论开 → AI 照常写评论,再按 funnel_probability 把选中的那一行原样接在末尾(代替 AI 融合)。
var FUNNEL_REWRITE = task.funnel_rewrite !== false;
function funnelAppendVerbatim(orig, phrase, step, cap, label) {
  orig = String(orig || '').trim(); phrase = String(phrase || '').trim();
  if (!phrase) return orig;
  if (cap && phrase.length + 1 > cap) { ctx.stepLog(step, 'warn', '   ⚠️ 引流语比字数上限还长,这条不加引流'); return orig; }
  // 要裁评论才放得下、但裁完评论剩不到 ~15 字 → 不接(别让引流语喧宾夺主,更不能把评论裁没)
  if (cap && orig && orig.length + 1 + phrase.length > cap && cap - phrase.length - 1 < Math.min(15, orig.length)) { ctx.stepLog(step, 'warn', '   ⚠️ 接上引流语会把评论裁没,这条不加引流'); return orig; }
  if (cap && orig.length + 1 + phrase.length > cap) {
    orig = orig.slice(0, cap - phrase.length - 1);
    if (/[\uD800-\uDBFF]$/.test(orig)) orig = orig.slice(0, -1);   // 别把 emoji 等代理对切成半个
    orig = orig.trim();
  }
  ctx.stepLog(step, 'running', '   🎣 ' + (label || '引流语原样发布(已关闭AI改写)') + ',已接在评论末尾');
  return orig ? orig + ' ' + phrase : phrase;
}
var __leadFlags = { on: false, none: false };
function leadOnlyNotice(step) {
  if (AI_COMMENT) return;
  if (LEAD_ONLY_NO_PHRASE) {
    if (!__leadFlags.none) { __leadFlags.none = true; ctx.stepLog(step, 'warn', '⚠️ 已关闭AI自主评论但没填引流语,本次不发评论'); }
    return;
  }
  if (!__leadFlags.on) { __leadFlags.on = true; ctx.stepLog(step, 'running', FUNNEL_REWRITE ? '🎣 AI自主评论已关闭 · 只发引流语(AI 改写)' : '🎣 AI自主评论已关闭 · 只发引流语(原样发布,已关闭AI改写)'); }
}
function __leadText(v) {
  if (typeof v === 'string') return v;
  if (v && typeof v === 'object') {
    var ks = ['text', 'reply', 'comment', 'content', 'output', 'result'];
    for (var i = 0; i < ks.length; i++) if (typeof v[ks[i]] === 'string' && v[ks[i]].trim()) return v[ks[i]];
    for (var k in v) { var x = __leadText(v[k]); if (x && x.trim()) return x; }
  }
  return '';
}
// cap = 平台字数上限(0/缺省 = 不限):改写结果超限就作废重试;原样模式下引流语超限 → 这条跳过。绝不截断引流语。
async function leadOnlyRewrite(step, lang, cap) {
  leadOnlyNotice(step);
  if (LEAD_ONLY_NO_PHRASE) return '';
  var phrase = LEAD_LINES[Math.floor(Math.random() * LEAD_LINES.length)];
  if (!FUNNEL_REWRITE) {
    if (cap && phrase.length > cap) { ctx.stepLog(step, 'warn', '   ⚠️ 引流语超过字数上限(' + phrase.length + ' > ' + cap + '),这条跳过 —— 不截断引流语'); return ''; }
    ctx.stepLog(step, 'running', '   🎣 引流语原样发布(已关闭AI改写): "' + phrase.slice(0, 40) + (phrase.length > 40 ? '…' : '') + '"');
    return phrase;
  }
  return await leadRewritePhrase(phrase, step, lang, '这条评论跳过 —— 不发原句、不改发自由评论', cap);
}
// AI 单独改写一句引流语(不照抄、保留意思);失败/垃圾 → 记 warn(failNote 说明后果)并返回 ''。
async function leadRewritePhrase(phrase, step, lang, failNote, cap) {
  var sys = [
    '你的任务:把一句「引流文案」用你自己的话改写成一条可以直接发出去的评论/回复。',
    '',
    '# 核心要求',
    '1. 【严禁照抄引流文案】换措辞、换句式、换角度重新说一遍;但意思必须保留 ——',
    '   要引导对方做的事,以及名称/账号/号码/链接/暗号等关键信息,一个字都不能改错、不能漏。',
    '2. 只表达这句引流的意思:不要评价帖子/视频/评论内容,不要加与引流无关的寒暄或长篇大论。',
    '3. 读起来像真人随口一说,自然、简短,别像硬广;长度跟原文案差不多。',
    '4. 输出语言:' + (lang ? String(lang) : '与引流文案相同的语言') + '。',
    (cap ? '5. 【硬上限】整条不超过 ' + cap + ' 个字符(超了会被平台拒发)。' : ''),
    '',
    '# 输出',
    '只输出改写后的纯文本,不要 JSON、不要引号包裹、不要任何解释。',
  ].join('\n');
  var user = JSON.stringify({ task: 'rewrite_lead_phrase', funnel_phrase: phrase, output_language: lang ? String(lang) : '', nonce: Date.now().toString(36) + Math.random().toString(36).slice(2, 6) });
  var t = '', why = '';
  for (var at = 0; at < 2 && !t; at++) {
    if (at > 0 && typeof ctx.aborted === 'function' && ctx.aborted()) break;
    try {
      var r = await ctx.aiCall('__raw__', sys, user, { expectJson: false });
      t = String(__leadText(r) || '').trim();
      if (/^[\[{]/.test(t)) { try { t = String(__leadText(JSON.parse(t)) || '').trim(); } catch (_) {} }
      // 只剥【成对】包裹的引号,别把属于引流语本身的收尾 」/』 剥掉
      var __q = { '"': '"', "'": "'", '“': '”', '「': '」', '『': '』' }[t.charAt(0)];
      if (__q && t.length > 2 && t.charAt(t.length - 1) === __q) t = t.slice(1, -1).trim();
      var __min = /[\u3040-\u30ff\u3400-\u9fff\uac00-\ud7af]/.test(t) ? 2 : Math.max(1, Math.min(4, phrase.length));
      if (/^[\[{]/.test(t) || /"\s*:\s*["\[{]/.test(t)) { why = '返回像 JSON'; t = ''; }
      else if (t.length < __min) { why = t ? '太短:"' + t + '"' : '为空'; t = ''; }
      else if (cap && t.length > cap) { why = '超过字数上限(' + t.length + ' > ' + cap + ')'; t = ''; }
      else if (t.length > Math.max(150, phrase.length * 4)) { why = '太长(' + t.length + ' 字)'; t = ''; }
      else if (t.replace(/\s+/g, '') === phrase.replace(/\s+/g, '')) { why = '照抄了原句'; t = ''; }
    } catch (eLR) { why = String((eLR && eLR.message) || eLR).slice(0, 60); t = ''; }
  }
  if (!t) { ctx.stepLog(step, 'warn', '   ⚠️ 引流语改写失败(' + (why || '未知') + '),' + failNote); return ''; }
  ctx.stepLog(step, 'running', '   🎣 引流语已改写(' + t.length + '字): "' + t.slice(0, 40) + (t.length > 40 ? '…' : '') + '"');
  return t;
}
// 尾巴引流语(AI自主评论开;按概率命中后由调用方传入选中的那一行):引流语一律接在评论【末尾】,不再揉进中间。
//   funnel_rewrite 开 → 单独 AI 改写这一行再接上;关 → 原样接上。改写失败 → 这条评论不带尾巴照常发(绝不接原句)。
//   有字数上限时裁评论、不裁引流语;引流语本身放不下就不接。
async function funnelTail(orig, phrase, step, cap) {
  phrase = String(phrase || '').trim();
  if (!phrase) return orig;
  if (!FUNNEL_REWRITE) return funnelAppendVerbatim(orig, phrase, step, cap);
  var t = await leadRewritePhrase(phrase, step, '与这条评论相同的语言(评论:「' + String(orig || '').slice(0, 60) + '」,只用来判断语言,不要重复或回应它);要简短', '这条评论不带引流尾巴,照常发出', cap ? Math.max(1, cap - Math.min(16, String(orig || '').length + 1)) : 0);
  if (!t) return orig;
  return funnelAppendVerbatim(orig, t, step, cap, '引流语已改写');
}

var doComment = task.lead_do_comment !== false && !LEAD_ONLY_NO_PHRASE;   // AI自主评论关闭但没填引流语 → 这次不发评论(点赞/关注照常)
var doFollow = task.lead_do_follow !== false;
// 单次运行最多触达多少人(新旧客轮转;旧客多了一次跑不完,剩下的下次接着)。
// 2026-10-19:向导把「获取潜客」和「互动潜客」合并成一个数,只传 max_leads 时触达人数跟它一样。
var leadsPerRun = clampInt(pickInt(task.leads_per_run, (task.max_leads != null ? task.max_leads : defaults.leads_per_run), 100), 1, 5000);
// 进度分母:采集(STEP1)一开始就得有,否则「获得潜客」那一格只有一个光秃秃的数字,
//   看不出跑没跑满。这里下发的是【本账号自己的上限】—— 顶部「本次运行进度」由客户端
//   把各账号求和,单账号卡显示的就是这一份。STEP2 排完队后会再发一次,把 lead_engaged
//   收窄成本轮真正排上的人数、follow 收窄成还没关注过的人数。
if (typeof ctx.setActionTargets === 'function') {
  ctx.setActionTargets({
    lead_new: LEAD_UNLIMITED ? 0 : maxNewLeads,
    lead_engaged: leadsPerRun,
    like: doLike ? maxLikesTotal : 0,
    follow: doFollow ? maxFollowsTotal : 0,
    comment: doComment ? maxCommentsTotal : 0,
  });
}

// 每个源账号最多翻多少条作品(2026-08-16 用户定 50)。
var SEED_WORKS_CAP = 50;

// 一行种子是【作品链接】还是【账号/主页】(用户 2026-08-23:两种可以混填)。
//   同行的作品有爆有扑,扑的那些评论区是空的,一条条开进去白等;你自己刷到一条爆帖时,
//   明明知道就是这条评论区有人,却没法直接指过去 —— 所以放行作品链接,进去就采。
//   ⚠️ 链接长什么样是机器判得比人选得准的事,所以不加模式选择,直接看形态。
function seedKind(v) {
  v = String(v || '');
  if (/tiktok\.com\/(@[^/]+\/)?(video|photo)\/\d+/i.test(v) || /(vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+/i.test(v)) return 'work';
  return 'profile';
}
// 这行种子是不是【分享短链】。短链看形态判断不了指向 —— v.douyin.com/xxx 既可能是
//   一条作品也可能是某人主页 —— 所以单独标出来,交给 resolveShortLink 打开看落到哪。
function isShortLink(v) {
  v = String(v || '');
  return /(vm|vt)\.tiktok\.com\/[A-Za-z0-9_-]+/i.test(v);
}
// 打开短链,返回它最终落到的真实 URL(拿不到返回空串)。
//   多花一次导航,换一个确定的答案:猜错的代价是整个同行白翻一遍,或者把一条作品
//   当主页翻不出东西来(用户 2026-08-23 真机踩到)。
// 读当前地址。⚠️ 本函数原来【压根不存在】,而 resolveShortLink 里就在调它 ——
//   ReferenceError 正好落进那圈 catch (_e2) { u = ''; } 被吞掉,于是 8 次轮询全是空串,
//   浏览器明明已经落到作品页,剧本还是报「读不到地址」(用户 2026-08-26 实测)。
async function getUrl() {
  try {
    var r = await _b('get_url');
    return (r && (r.url || (r.data && r.data.url))) || '';
  } catch (_) { return ''; }
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

// 采集时顺手在【当前这条作品】下留一条评论(用户 2026-08-23:「打开了就别浪费」)。
//   跟触达阶段「去潜客主页留言」是两件事:那条引潜客回访,这条打给【刷这条作品的人】看。
//   ⚠️【不占】max_comments,照常按 comment 计费(跟互动评论同价,没有另立名目)。
//   防风控硬上限:一个同行就能翻 50 条投稿,真按每条都评就是 50 条评论砸在同一批作品下,
//   平台侧几乎必然风控 —— 那是钱花了号也赔了。
var COLLECT_CMT_CAP = 30;
// 2026-10-26 用户定:采集阶段只点赞,不在同行作品下留言(评论放到 STEP2 对潜客做)。要恢复设 behavior.harvest_source_comment=true。
var collectCmtCap = (doComment && beh.harvest_source_comment === true) ? COLLECT_CMT_CAP : 0;
var collectCmtDone = 0;

// ── 长期名单账本(跨运行持久,readState/writeState 需 v3.4.26+ 客户端) ──
var LEDGER_NAME = 'lead_ledger';
var ledgerPersistent = (typeof ctx.readState === 'function' && typeof ctx.writeState === 'function');
var ledger = (ledgerPersistent && ctx.readState(LEDGER_NAME)) || null;
if (!ledger || typeof ledger !== 'object') ledger = { leads: {} };
if (!ledger.leads || typeof ledger.leads !== 'object') ledger.leads = {};
function saveLedger() {
  if (ledgerPersistent) { try { ctx.writeState(LEDGER_NAME, ledger); } catch (_) {} }
}
function ledgerSize() { var n = 0; for (var k in ledger.leads) n++; return n; }

// ── Selectors (TikTok 自家 data-e2e 属性,不依赖 i18n 文案) ──
//
// 2026-05 实测: orchestrator 通过 ctx.navigate 直接进 /@user/video/<id>
// 走的是 "video player" 页面,跟从 Explore feed 点开的 modal 是**完全不
// 同的 DOM 树**。modal 用 browse-* 命名空间,player 页用 like-icon /
// feed-follow / comment-icon / video-desc 等(无 browse 前缀)。整套
// scenario 之前用 browse-* 在生产环境完全跑不动 — 这是导致"TikTok 互动
// 涨粉全部不可用"的根因。修复后实测每个 selector 都命中 + 状态判断就
// 位(button-still-exists for follow / contenteditable for comment input).
// ⚠️ 2026-08-16 真机更正:"aria-pressed for like"这半句【仍然成立】,坏掉的是选择器 ——
//   点赞控件已从 <button> 变成 div[role="button"],详见下方 SEL_LIKE_BTN 处。
// ⚠️ 点赞控件:选图标本身,不能写 `button:has(...)`。2026-08-16 真机(@jiaxch 那条视频)实测:
//     祖先链 = DIV[role=button]{aria-pressed=false} < DIV < SECTION < ARTICLE —— 【没有 button 祖先】。
//     TikTok 已把点赞从 <button> 换成 div[role="button"],所以初版的
//     `button:has([data-e2e="like-icon"])` 命中数 = 0(实测,不是 :has() 不被支持 —— 它正常求值)。
//   getAttr 是 `els[0] && els[0][attr]`,选择器空命中同样返回 undefined,于是 tryLike
//   误报「没找到点赞按钮」而且【连点都不点】—— 这就是用户反馈的 0/74 赞。
//   关注没坏,是因为 SEL_FOLLOW_BTN 用的是纯 data-e2e、不带标签名,改版没波及。
//   aria-pressed 依然存在,但挂在图标元素【自己】身上(不在祖先上),所以状态要就地读。
var SEL_LIKE_BTN = '[data-e2e="like-icon"], [data-e2e="browse-like-icon"]';
// ⚠️ 2026-10-27 根因:剧本是从上到下线性执行的,主流程(STEP1/2)在文件中段就跑了、末尾 return;
//   这几个字符串常量原来写在文件末尾 → 主流程跑的时候它们全是 undefined(var 只提升声明不提升赋值),
//   找点赞的查询拼出来是 "(function(){undefinedvar icon=pick()..." → 语法错误 → 永远报「没找到点赞按钮」,
//   SEL_PICKED_LIKE 也是 undefined → 找到了也点不了。所以必须放在主流程之前(这里)。
var PICK_LIKE_JS = 'function pick(){var a=document.querySelectorAll(\'[data-e2e="browse-like-icon"],[data-e2e="like-icon"]\');'
  + 'var best=null,bs=1e9,vh=window.innerHeight||800,vw=window.innerWidth||1200;'
  + 'for(var i=0;i<a.length;i++){a[i].removeAttribute("data-nc-like");var r=a[i].getBoundingClientRect();'
  + 'if(!(r.width>0&&r.height>0))continue;'
  + 'var st=getComputedStyle(a[i]);if(st.visibility==="hidden"||st.display==="none")continue;'
  + 'var inV=!(r.bottom<0||r.top>vh||r.right<0||r.left>vw);'
  + 'var sc=Math.abs((r.top+r.height/2)-vh/2)+(a[i].getAttribute("data-e2e")==="browse-like-icon"?0:5000)+(inV?0:20000);'
  + 'if(sc<bs){bs=sc;best=a[i];}}'
  // 兜底:data-e2e 两个都没命中(改版/窄版面)→ 认「带 aria-pressed、aria-label 像点赞」的按钮,排除评论区里的留言赞。
  + 'if(!best){var bb=document.querySelectorAll("button[aria-pressed],[role=button][aria-pressed]");'
  + 'for(var j=0;j<bb.length;j++){var l=bb[j].getAttribute("aria-label")||"";if(!/like|赞|讚|喜欢|喜歡|いいね|좋아요/i.test(l)||/dislike|踩/i.test(l))continue;'
  + 'if(bb[j].closest(\'[data-e2e^="comment-level"],[data-e2e*="comment-item"],[class*="CommentItem"]\')||bb[j].querySelector(\'[data-e2e="comment-like-icon"]\'))continue;'
  + 'var r2=bb[j].getBoundingClientRect();if(!(r2.width>0&&r2.height>0))continue;var sc2=Math.abs((r2.top+r2.height/2)-vh/2);if(sc2<bs){bs=sc2;best=bb[j];}}}'
  + 'if(best)best.setAttribute("data-nc-like","1");return best;}';
var SEL_PICKED_LIKE = '[data-nc-like="1"]';
var SIMPLE_PICK_JS = 'function spick(){var a=document.querySelectorAll(\'[data-e2e="browse-like-icon"],[data-e2e="like-icon"]\');'
  + 'var vh=window.innerHeight||800,vw=window.innerWidth||1200,i;'
  + 'for(i=0;i<a.length;i++)a[i].removeAttribute("data-nc-like");'
  + 'for(i=0;i<a.length;i++){var r=a[i].getBoundingClientRect();'
  + 'if(r.width>0&&r.height>0&&r.bottom>0&&r.top<vh&&r.right>0&&r.left<vw){a[i].setAttribute("data-nc-like","1");return a[i];}}'
  + 'return null;}';
var __likeProbeErr = '';
var _likeEmptyStreak = 0;
var SEL_FOLLOW_BTN = '[data-e2e="feed-follow"]';
// player 页评论面板默认是关的,先 click 这个图标按钮才能打开右侧 panel。
// modal 页是默认开的所以之前没写,这里必须显式 open。
// ⚠️ 不用 :has()（指纹内核 Chromium 若不支持,整串 querySelector 失效 → 点不到 → 面板不开,真机实测「命中全 0」）。
//   直接点图标本身,click 事件会冒泡到父级 handler;多候选覆盖改版后的 data-e2e / aria-label。
var SEL_COMMENT_OPEN_BTN = '[data-e2e="comment-icon"], [data-e2e="browse-comment"], button[aria-label*="omment" i], [aria-label*="Read or add comment" i]';
var SEL_COMMENT_INPUT_WRAP = '[data-e2e="comment-input"], div[contenteditable="true"][role="textbox"], .public-DraftEditor-content';
// 评论输入框(contenteditable):TikTok 改版后 [data-e2e="comment-input"] 内不一定有 contenteditable
//   (真机报 editor_not_found)→ 放宽到 DraftEditor 常见形态(role=textbox / .public-DraftEditor-content),
//   querySelector 取首个命中。仍找不到才算真没有。
var SEL_COMMENT_INPUT_CE = '[data-e2e="comment-input"] [contenteditable="true"], [data-e2e*="comment"] [contenteditable="true"], [data-e2e*="comment"] [contenteditable], div[contenteditable="true"][role="textbox"], .public-DraftEditor-content [contenteditable="true"], .public-DraftEditor-content, .notranslate[contenteditable="true"], [contenteditable="true"], [contenteditable="plaintext-only"]';
var SEL_COMMENT_POST = '[data-e2e="comment-post"]';
var SEL_VIDEO_DESC = '[data-e2e="video-desc"]';
// 顶部评论文本: 必须用 comment-level-1 限定,否则会把 comment-input 内部
// 的 placeholder ("Add comment...") 也当成置顶评论喂给 AI(实测 v1 就是
// 拿了 placeholder 当 top comment 喂给 LLM 的)。
var SEL_TOP_COMMENT_TEXT = '[data-e2e="comment-level-1"] [data-e2e="comment-text"]';

// ── Helpers ──

function shuffle(arr) {
  var a = arr.slice();
  for (var i = a.length - 1; i > 0; i--) {
    var j = Math.floor(Math.random() * (i + 1));
    var t = a[i]; a[i] = a[j]; a[j] = t;
  }
  return a;
}

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

// 潜客主页可能一条作品都没有 —— 平台给的是「暂无内容 / 还没有发布过作品」的空态。
//   翻作品那一步会带着滚动反复找一批永远不会出现的链接,白耗十几秒;先探一次空态就能
//   整段跳过。注意【不标记 gone】:今天没发不代表以后不发,这种号下轮照常排队,
//   本轮只是不翻作品(关注还是照做,那正是要让对方回访的动作)。
// ⚠️ 取整页文本(8000 字)而不是开头一小段:主页的 innerText 前面全是左侧导航、
//   搜索框、tab 行,「暂无内容」在更靠后的位置。2026-08-23 真机实测,原来的
//   1200 字窗口截不到它 —— 探测返回 false,没作品的号照样被翻作品、被占关注额度。
//   别再把这个窗口缩小。
// 2026-10-26 用户反馈定向获客点赞太慢:每位潜客原来固定等「主页 8-14s + 作品 6-12s + 观看 1-2s + 点前 1-2s
//   + 确认 1.5-3s + 下一位前 1-5s」≈ 20-40 秒。改成「页面一就绪就走」:每 0.4s 看一次关键元素,出现即继续,封顶超时。
async function waitReady(kind, maxMs, owner) {
  // video:点赞按钮一出现就返回 true。
  // profile:主页上一出现【这位潜客自己的】作品卡片就返回 'v:<作品链接>'(调用方立刻点它);
  //   出现空态/不存在/私密文案返回 'empty';都没等到返回 false。
  var expr = kind === 'video'
    ? '(function(){try{' + PICK_LIKE_JS + 'if(pick())return "1";}catch(e){}try{' + SIMPLE_PICK_JS + 'if(spick())return "1";}catch(e){}return "";})()'
    : '(function(){try{var O=' + JSON.stringify(String(owner || '').toLowerCase()) + ';'
      + 'var as=document.querySelectorAll(\'a[href*="/video/"],a[href*="/photo/"]\');'
      + 'for(var i=0;i<as.length;i++){var h=as[i].getAttribute("href")||"";var m=h.match(/\\/@([^\\/?#]+)\\/(?:video|photo)\\/(\\d+)/);'
      + 'if(m&&(!O||decodeURIComponent(m[1]).toLowerCase()===O)){var r=as[i].getBoundingClientRect();if(r.width>0&&r.height>0){as[i].setAttribute("data-nc-lv","1");return "v:"+(h.indexOf("http")===0?h:"https://www.tiktok.com"+h).split("?")[0];}}}'
      + 'var t=(document.body&&document.body.innerText||"");'
      + 'if(/沒有內容|没有内容|尚無內容|尚无内容|沒有作品|没有作品|沒有影片|没有视频|尚未發佈|尚未发布|還沒有任何|还没有任何|私人帳戶|私密帳戶|此帳號為私人|此账号为私密|暂无内容|暫無內容|暂无作品|暫無作品|还没有发布|還沒有發布|No content|No videos yet|hasn.t posted|has not posted|hasn.t published|User not found|Couldn.t find this account|用户不存在|用戶不存在|This account is private|Private account|私密账号|私密帳號|私人帳號|账号是私密的|콘텐츠 없음|게시물 없음|동영상 없음|비공개 계정|계정을 찾을 수 없|コンテンツはありません|まだ投稿|非公開アカウント|アカウントが見つかりません|Chưa có nội dung|Tài khoản riêng tư|Không tìm thấy tài khoản/i.test(t))return "empty";'
      + 'var hd=document.querySelector(\'[data-e2e="user-title"],[data-e2e="user-subtitle"],[data-e2e="followers-count"]\');'
      + 'if(hd&&!document.querySelector(\'[data-e2e="user-post-item"],[class*="Loading"],[class*="loading"],[class*="Skeleton"],[class*="skeleton"]\')){'
      + 'var k0=location.pathname;if(window.__ncHdrK!==k0){window.__ncHdrK=k0;window.__ncHdrAt=Date.now();}'
      + 'else if(Date.now()-window.__ncHdrAt>2000)return "empty";}else{window.__ncHdrK="";}'
      + 'if(/Something went wrong|出错了|出錯了|发生错误|發生錯誤/.test(t)){var bs=document.querySelectorAll("button");for(var k=0;k<bs.length;k++){if(/^(Refresh|刷新|重新整理|重试|重試)$/i.test((bs[k].innerText||"").trim()))return "error";}}'
      + '}catch(e){}return "";})()';
  var t0 = Date.now();
  while (Date.now() - t0 < (maxMs || 10000)) {
    if (ctx.aborted && ctx.aborted()) return false;
    try {
      if (kind === 'video') { try { await holdVideo(); } catch (_) {} }   // 作品一出 <video> 就暂停
      var r = await _b('cdp_eval', { expression: expr, awaitPromise: false }, 4000);
      var v = r && (r.value !== undefined ? r.value : (r.result && r.result.value));
      if (v === '1') return true;
      if (typeof v === 'string' && v && v !== '1') return v;
    } catch (_) {}
    await ctx.sleep(250);
  }
  return false;
}

async function probeNoWorks() {
  try {
    var r = await _b('cdp_eval', {
      expression: '(function(){try{'
        + 'var t=(document.body&&document.body.innerText||"").slice(0,8000);'
        + 'if(/暂无内容|暂无作品|暂无视频|暂无笔记|空间主人还没投过视频|还没投过视频|还没有发布过作品|还没有发布作品|还未发布过作品|还未发布作品|未发布过作品|未发布过任何作品|还没有发布过笔记|还没有发布笔记|还没有投稿|TA还没有发过内容|No content yet|This user has no|hasn.t posted/.test(t))return "1";'
        + 'return "";}catch(_e){return "";}})()',
      awaitPromise: false,
    }, 6000);
    return !!(r && r.value === '1');
  } catch (_) { return false; }
}

// 潜客号可能已经注销 / 被封 / 改了 id —— 平台给的是「用户不存在」的空页面。
//   这种页上没有作品、也没有关注按钮,不拦的话会白等满一套 first_screen_pause +
//   翻作品 + 找关注按钮的超时(每人几十秒),而且它永远留在名单里、每轮都占一个名额。
//   命中就记一笔 gone 并跳过;连着两轮都不存在才真的踢出队列 —— 单次可能只是页面没
//   加载出来,一次误判就把真潜客从队列里丢了,不划算。打得开的那一次会把 gone 清零。
async function probeUserGone() {
  try {
    var r = await _b('cdp_eval', {
      expression: '(function(){try{'
        + 'var t=(document.body&&document.body.innerText||"").slice(0,2500);'
        + 'if(/用户不存在|该用户不存在|作者不存在|账号已注销|帐号已注销|该账号封禁中|账号封禁中|账号已封禁|帐号已封禁|已被封禁|账号被封|该账号已被封|你访问的页面不见了|页面不存在|内容不存在|空空如也的页面|Couldn.t find this account|User not found/.test(t))return "1";'
        + 'return "";}catch(_e){return "";}})()',
      awaitPromise: false,
    }, 6000);
    return !!(r && r.value === '1');
  } catch (_) { return false; }
}

async function getTexts(selector, limit) {
  try {
    var res = await _b('query_selector', { selector: selector, limit: limit || 5 });
    var els = unwrapElements(res);
    return els.map(function (e) { return (e && e.text) || ''; }).filter(Boolean);
  } catch (_) { return []; }
}

// 检测 TikTok 人机验证(captcha)是否出现。撞 captcha 通常是账号被风控
// 标记的信号 — 立即停止 task 让用户决定下一步,继续跑只会触发更严重
// 的限流。selector 覆盖常见 captcha 容器命名(id / class / iframe src 含
// "captcha" 关键字)。
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

// Run arbitrary JS in the page (isolated world via content.js executeJavascript)
// and best-effort JSON-parse the result. Used to dispatch ClipboardEvent for
// the comment input — see tryComment for why execCommand path doesn't work.
async function evalJs(code) {
  try {
    // ⚠️ 内核 'javascript' 命令会把 code 二次包进 (function(){ code })():直接传【自调用 IIFE】外层无
    //   return → 恒 undefined。对 '(' 开头的 IIFE 补 return(新旧客户端都工作,2026-07-05 全平台修)。
    var res = await _b('javascript', { code: (String(code).trim().charAt(0) === '(' ? 'return ' + code : code) });
    if (res == null) return null;
    if (typeof res === 'string') {
      try { return JSON.parse(res); } catch (_) { return res; }
    }
    if (res.result != null) {
      var inner = res.result;
      if (typeof inner === 'string') {
        try { return JSON.parse(inner); } catch (_) { return inner; }
      }
      return inner;
    }
    return res;
  } catch (_) { return null; }
}

// Single isolated-world full event sequence. composed:true crosses shadow
// DOM boundaries so TikTok like icon (a web component) actually receives
// the click; single dispatch means no double-fire even if the user's
// chrome-extension version ignores main_world_click's clickOnce flag
// (which was causing comments to post twice and likes to toggle on→off).
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

function buildQuotaSummary(nL, nF, nC) {
  var parts = [];
  if (nL > 0) parts.push('👍×' + nL);
  if (nF > 0) parts.push('➕×' + nF);
  if (nC > 0) parts.push('💬×' + nC);
  return parts.join(' + ') || '空';
}


// 名单里的「获得时间」用到年月日时分,fmtDate 只有日期。
function fmtDateTime(ts) {
  if (!ts) return '-';
  var d = new Date(ts);
  var pad = function (n) { return (n < 10 ? '0' : '') + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate())
    + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

// 名单里的「潜客来源」整句:说清是谁的评论区、以及那条作品是怎么找到的。
//   关键词模式:昵称 X 账号 Y(「词」搜索出来的) 的作品评论区
//   精准模式  :昵称 X 账号 Y(你填的同行) 的作品评论区
function idleReason(tl) {
  if (!tl) return '';
  if ((tl.likedCount || 0) > 0 || (tl.commentedCount || 0) > 0) return '';   // 有互动就不用解释
  if (tl.noWorks) return ' · 对方没作品,所以没有点赞/评论';
  if ((tl.gone || 0) >= 2) return ' · 该账号已注销/打不开,已停止排队';
  if (!tl.lastEngagedAt) return ' · 还没轮到他';
  return '';
}

function sourceLine(tl) {
  if (!tl) return '(未知)';
  if (tl.srcLive) {
    return '主播 ' + (cleanNick(tl.srcOwnerNick) || '(昵称未取到)') + ' 账号 ' + (tl.srcOwner || '(未知)') + ' 的直播间(在直播间发言/进场)'
      + ((tl.srcVideo || '').trim() ? ('\n              └ 直播间: ' + String(tl.srcVideo).trim()) : '');
  }
  var nick = cleanNick(tl.srcOwnerNick) || '(昵称未取到)';
  var acct = tl.srcOwner || '(未知)';
  // 2026-08-21 之前入库的旧数据:那会儿 readVideoOwner 会把导航栏那颗「我的」(/user/self)
  //   当成作品作者,于是来源被写成「昵称 我的 账号 self」。照原样印出来只会让人以为是自己的号,
  //   直接说清它是坏数据。新入库的不会再有(见 readVideoOwner 里的 self 排除)。
  if (acct === 'self' || nick === '我的' || nick === '我') {
    return (tl.srcKw ? '「' + tl.srcKw + '」关键词搜到的作品评论区' : '你填的同行账号的作品评论区')
      + '(同行身份未记录 —— 早期版本的已知问题,不影响这个潜客本身)';
  }
  var how = tl.srcKw ? ('(「' + tl.srcKw + '」关键词搜索出来的)') : '(你填的同行账号)';
  // 作品名 + 链接都给出来 —— 光有一串 id 没法一眼认出是哪条(用户 2026-08-22)。
  var _vt = String(tl.srcTitle || '').trim();
  var vsuffix = (tl.srcVideo || '').trim()
    ? ('\n              └ 那条作品: ' + (_vt ? '「' + _vt + '」 ' : '') + String(tl.srcVideo).trim())
    : (_vt ? ('\n              └ 那条作品: 「' + _vt + '」') : '');
  return '昵称 ' + nick + ' 账号 ' + acct + ' ' + how + ' 的作品评论区' + vsuffix;
}

// 昵称里常粘着「1月前」这类时间(快手实测「火聚合AI 1月前」),渲染前剥掉。
function cleanNick(n) {
  return String(n || '').replace(/\s*(刚刚|\d+\s*(秒|分钟|分|小时|天|周|月|年)前)\s*$/g, '').trim();
}
// 「他的哪条作品」——有作品名就带上,没有就省略,别留一对空引号。
function workPhrase(t) {
  var s = String(t || '').trim();
  return s ? ('的「' + s + '」作品') : '的作品';
}

// 把「他为什么被视为潜客」讲成一句人话,在触达每个客户时打一行(用户 2026-08-21 要求)。
//   关键词模式:因该用户评论了 关键词「X」搜到的 <同行> 的「<作品名>」作品,因此视为潜客
//   精准模式  :因该用户评论了 同行 <X> 的「<作品名>」作品,因此视为潜客
function whyLead(o) {
  if (!o) return '潜客来源:(未知)';
  if (o.live) {
    return '潜客来源:因该用户在主播 ' + (cleanNick(o.ownerNick) || '@' + (o.ownerHandle || '?')) + ' 的直播间发言/进场,因此视为潜客'
      + (String(o.videoUrl || '').trim() ? '(' + String(o.videoUrl).trim() + ')' : '');
  }
  var who = (cleanNick(o.ownerNick) || '@' + (o.ownerHandle || '?'));
  // 2026-08-21 之前入库的坏数据:那会儿会把导航栏那颗「我的」(/user/self)当成作者。
  //   照原样印出来会让人以为是自己的号(名单那边 sourceLine 也做了同样的守卫)。
  if (o.ownerHandle === 'self' || o.ownerUid === 'self'
      || (o.ownerNick || '').trim() === '我的' || (o.ownerNick || '').trim() === '我') {
    who = '(同行身份未记录 —— 早期版本的已知问题)';
  }
  // 用户 2026-08-22:运行记录里也要能看到【是同行的哪一条】,方便当场点开回查。
  var vs = String(o.videoUrl || '').trim();
  var tail = vs ? ('(' + vs + ')') : '';
  if (o.kw) return '潜客来源:因该用户评论了 关键词「' + o.kw + '」搜到的 ' + who + ' ' + workPhrase(o.videoTitle) + ',因此视为潜客' + tail;
  return '潜客来源:因该用户评论了 同行 ' + who + ' ' + workPhrase(o.videoTitle) + ',因此视为潜客' + tail;
}


// 贬损词过滤。AI 偶尔还是会写出挖苦话(2026-08-23 真机:「标题党有点东西啊」),
//   尤其是引流语融合那第二次 AI 调用 —— 它的 prompt 里没有语气约束,
//   第一步 comment_composer 管住的东西到那儿又松了。
//   所以这里做确定性拦截:命中就重写一次,再命中就不发。
//   ⚠️ 只收【明确贬损】的词。像「有点东西」是夸人的网络用语,不能进这个表。
var NEGATIVE_WORDS = [
  '标题党', '割韭菜', '智商税', '营销号', '蹭热度', '恰烂钱', '水文', '洗稿', '抄袭',
  '也就那样', '也就这样', '没什么干货', '没啥干货', '没营养', '没新意', '毫无新意',
  '废话', '劝退', '避雷', '翻车', '忽悠', '骗人', '骗子', '吹牛', '装的', '可笑',
  '笑死', '就这', '垃圾', '拉胯', '离大谱', '不敢苟同', '不认同', '错了吧', '不对吧',
  '有问题吧', '别再', '你应该', '建议你', '看不下去', '尬', '无聊透',
];
// AI 复读检测:融合那步偶尔会把整句吐两遍(真机 2026-08-23,X)。
//   客户端的达标校验只卡下限不卡上限,复读照样通过 —— 发出去就是一条重复两遍的评论。
//   这里在【定稿处】砍掉:从 40%~60% 的位置扫一遍切点,前后两半完全相同就只留前半。
//   只认「完全相同」,不做模糊匹配 —— 宁可漏掉一条,也不能把正常评论砍半。
function dedupeEcho(t) {
  var s = String(t || '').trim();
  if (s.length < 20) return s;
  var lo = Math.floor(s.length * 0.4), hi = Math.ceil(s.length * 0.6);
  for (var cut = lo; cut <= hi && cut < s.length; cut++) {
    var a = s.slice(0, cut).trim(), b = s.slice(cut).trim();
    if (a.length >= 10 && a === b) return a;
  }
  return s;
}

function looksNegative(t) {
  var s = String(t || '');
  for (var i = 0; i < NEGATIVE_WORDS.length; i++) {
    if (s.indexOf(NEGATIVE_WORDS[i]) >= 0) return NEGATIVE_WORDS[i];
  }
  return '';
}

// ── 计费(best-effort:余额不足/网络失败不阻断动作,和互动剧本同口径) ──
var taskCharge = 0;
async function chargeIfPossible(actionType) {
  try {
    var r = await ctx.chargeAction(actionType, 'tiktok');
    if (r && r.ok && typeof r.charged === 'number') { taskCharge += r.charged; return r.charged; }
  } catch (_) {}
  return 0;
}

// ⚠️ 图集(photo mode)作品是 /@handle/photo/<id>,和视频 /@handle/video/<id> 同一个 id 号段。
//   只认 /video/ 的话,只发图集的潜客会被当成「没有作品」直接跳过(用户 2026-10-10 反馈,
//   跟 douyin_lead_engage 的 /note/ 同一个坑;插件 extBridge 的 WORK_RE 早就两种都认)。
function videoIdOf(url) { return (String(url || '').match(/\/(?:video|photo)\/(\d+)/) || [])[1] || ''; }
function authorOfVideoUrl(url) {
  var m = String(url || '').match(/\/(@[\w.]+)\/(?:video|photo)\//);
  return m ? normHandle(m[1]) : '';
}
function isPhotoUrl(url) { return /tiktok\.com\/@[^/]+\/photo\/\d+/i.test(String(url || '')); }

// 撞验证码统一处理:等用户手动过,过不了就终止任务(与互动剧本同款)。
async function captchaGate(step) {
  if (!(await detectCaptcha())) return true;
  var w = (ctx.waitForCaptchaCleared ? await ctx.waitForCaptchaCleared() : { ok: false, reason: 'no_wait_helper' });
  if (!w.ok) {
    ctx.stepLog(step, 'error', '🛑 验证码未在限时内手动完成(' + w.reason + '),任务停止。');
    return false;
  }
  return true;
}

// 当前页面收集作品链接(/video/ 和 /photo/;主页作品网格、搜索结果通用)。滚动加载直到够数或连续 2 轮无增长。
// owner(可选):只收这个账号自己的作品。整页 query 会混进推荐区别人的作品,触达时只取 1 条,
//   不在收的时候就按作者过滤的话,可能正好拿到别人的那条(2026-10-13)。
async function collectVideoLinksOnPage(cap, owner) {
  var seen = {}, out = [], still = 0;
  for (var round = 0; round < 12 && out.length < cap; round++) {
    var res;
    // 图集作品是 a[href*="/photo/"],必须一起收(见 videoIdOf 上方说明)。
    try { res = await _b('query_selector', { selector: 'a[href*="/video/"], a[href*="/photo/"]', limit: 120, attrs: 'href' }); } catch (_) { res = null; }
    var els = unwrapElements(res);
    var grew = false;
    for (var i = 0; i < els.length && out.length < cap; i++) {
      var href = els[i] && els[i].href;
      if (!href) continue;
      if (href.indexOf('http') !== 0) href = 'https://www.tiktok.com' + href;
      var vid = videoIdOf(href);
      if (!vid || seen[vid]) continue;
      if (owner && authorOfVideoUrl(href) !== owner) continue;
      seen[vid] = 1; out.push(href); grew = true;
    }
    if (!grew) { still++; if (still >= 2) break; } else { still = 0; }
    if (out.length >= cap) break;
    try { await _scroll(); } catch (_) {}
    await jsleep(beh.feed_scroll_pause || [3000, 8000]);
  }
  return out;
}

// 打开当前视频页的评论面板(默认收起;已开就不再点,防切回 You may like)。
// 读主页的账号昵称(精准模式:进同行主页时读一次,给它名下所有作品复用)。
// [data-e2e="user-title"] 真机实测就是显示名(如「茶叙浮生」)。
async function readProfileNick() {
  var n = await tkCdp('(function(){var e=document.querySelector(\'[data-e2e="user-title"]\');'
    + 'return {ok:true,value:e?((e.innerText||e.textContent||"").replace(/\\s+/g," ").trim().slice(0,40)):""};})()', '');
  return String(n || '').trim();
}

// 读作品页上【作者(同行)】的昵称。原剧本注释说 player 页没有显式 username 元素、
//   只能从 URL 取 handle —— 但获客要在日志里说清「这个潜客是从谁的评论区捞的」,
//   所以多候选探一次:modal 的 browse-username、作者头像链接的 title/alt、
//   以及指向 /@handle 的链接文本。都读不到就留空,调用方回落成账号。
async function readVideoOwnerNick(ownerHandle) {
  var expr = '(function(){'
    + 'var pick=function(e){if(!e)return "";var t=(e.innerText||e.textContent||"").replace(/\\s+/g," ").trim();return t;};'
    + 'var c=document.querySelector(\'[data-e2e="browse-username"]\');var v=pick(c);if(v)return {ok:true,value:v.slice(0,40)};'
    + 'var av=document.querySelector(\'[data-e2e="video-author-avatar"], [data-e2e="browse-user-avatar"]\');'
    + 'if(av){var img=av.querySelector("img");var alt=img&&(img.getAttribute("alt")||"");'
    + 'if(alt&&alt.trim())return {ok:true,value:alt.trim().slice(0,40)};}'
    + 'var h=' + JSON.stringify(String(ownerHandle || '')) + ';'
    + 'if(h){var a=document.querySelector(\'a[href="/@\'+h+\'"]\');var t2=pick(a);'
    + 'if(t2&&t2.toLowerCase()!==h.toLowerCase())return {ok:true,value:t2.slice(0,40)};}'
    + 'return {ok:true,value:""};})()';
  var n = await tkCdp(expr, '');
  return String(n || '').trim();
}

// 把「这个潜客从哪来」渲染成人话,两种模式说法不同(用户 2026-08-17 定):
//   关键词模式 → 来源关键词 X · 同行昵称 Y 账号 @Z 的评论区
//   精准模式   → 来源 同行昵称 Y 账号 @Z 的评论区
function describeSource(o) {
  if (!o) return '来源 (未知)';
  if (o.live) return '来源 主播昵称 ' + ((o.ownerNick || '').trim() || '(未取到)') + ' 账号 @' + (o.ownerHandle || '?') + ' 的直播间';
  var who = '同行昵称 ' + ((o.ownerNick || '').trim() || '(未取到)') + ' 账号 @' + (o.ownerHandle || '?') + ' 的评论区';
  return (o.kw ? '来源关键词 ' + o.kw + ' · ' : '来源 ') + who;
}

// 2026-10-26 用户反馈:填了作品链接,评论区明明开着却报「评论面板打不开」,采集一个潜客都没收到,
//   直接拿上次的老潜客去互动。根因同 tiktok_comment_like 10-24 修过的那个:旧逻辑只认输入框,
//   没认到就去点 SEL_COMMENT_OPEN_BTN —— 评论区本来就开着时一点反而关掉,而且 button[aria-label*="omment"]
//   会误中输入框旁的「@」按钮。改成:输入框 / 已有留言 / 评论搜索区任一在场就算开着;
//   确认没开才点【评论图标】(不再用 aria-label 模糊匹配),点完轮询最多约 8 秒,第二次点之前再确认一遍。
var SEL_COMMENT_TOGGLE = '[data-e2e="comment-icon"], [data-e2e="browse-comment-icon"], [data-e2e="browse-comment"], [aria-label*="Read or add comment" i]';
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

// 收当前评论面板里所有评论者 handle(含二级回复者;作者/同行种子号在外层排掉)。
// 真机结构:每条 [data-e2e^="comment-level"] 往上找到带 a[href^="/@"] 的容器。
// 返回 [{h:账号, n:昵称}]。昵称取评论容器里的 [data-e2e="comment-username-1"]
//   (真机实测就是显示名),读不到就留空、由调用方回落成账号。
// 2026-10-26 用户要求:采集时把评论区的留言【全部点赞】(移植自 tiktok_comment_like),一边点一边收潜客。
//   宽松识别同 tiktok_comment_like:作者 = 任意含 /@ 的链接;点赞 = 容器里 aria-label 像「赞」的 [aria-pressed](排除「踩」)。
var CMT_HELPERS = 'function ncA(p){return p&&p.querySelector?p.querySelector(\'a[href*="/@"]\'):null;}'
  + 'function ncH(a){var m=(a.getAttribute("href")||"").match(/\\/@([^\\/?#]+)/);return m?decodeURIComponent(m[1]).toLowerCase():"";}'
  + 'function ncB(p){var bs=p.querySelectorAll(\'[aria-pressed]\');var f=null;for(var j=0;j<bs.length;j++){var l=(bs[j].getAttribute("aria-label")||"");'
  + 'if(/dislike|踩|不喜欢|不喜歡/i.test(l))continue;if(/like|赞|讚|喜欢|喜歡|いいね|좋아요|thích|me gusta/i.test(l))return bs[j];if(!f)f=bs[j];}return f;}'
  + 'function ncC(lv){var p=lv;for(var k=0;k<6&&p;k++){if(ncA(p)&&ncB(p))return p;p=p.parentElement;}return null;}';
var HARVEST_CMT_LIKE = beh.harvest_comment_like === true;   // 2026-10-27 用户定:采集时不再在评论区点赞(默认关),只快速捞人
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
var cmtLikeStats = { like: 0, already: 0, failed: 0 };
// 给当前这一屏所有没赞过的留言点赞。返回 false = 这条作品连续点不上,别再点了。
async function likeVisibleComments(st, vurl) {
  var list = await scanCommentLikes();
  for (var ci = 0; ci < list.length; ci++) {
    if (ctx.aborted && ctx.aborted()) return false;
    var c = list[ci];
    var key = c.h + '|' + c.t;
    if (st.seen[key]) continue;
    st.seen[key] = 1;
    if (selfHandle && c.h === selfHandle) continue;
    if (c.ap === 'true') { st.already++; cmtLikeStats.already++; continue; }
    if (await driftedFrom(vurl)) { delete st.seen[key]; return true; }
    var r = await likeCmtByKey(c.h, c.t, beh.harvest_cmt_verify_pause || [150, 250]);
    if (r.already) { st.already++; cmtLikeStats.already++; continue; }
    if (r.gone) { delete st.seen[key]; continue; }   // 列表回收了、这条暂时不在 DOM:下一屏再遇到再点
    if (r.ok) {
      st.like++; st.fail = 0; cmtLikeStats.like++;
      if (typeof ctx.addActionCount === 'function') ctx.addActionCount('like', 1);
      await chargeIfPossible('like_lite');
      ctx.stepLog(1, 'running', '   💗 已赞 ' + (c.n || '@' + c.h) + ' 的留言(这条作品已赞 ' + st.like + ')');
      var lp = beh.harvest_cmt_like_pause || [0, 0];
      if (lp[1] > 0) await jsleep(lp);
      if (cmtLikeStats.like % 20 === 0 && !(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
    } else {
      st.failed++; st.fail++; cmtLikeStats.failed++;
      // 没登录时点赞会弹出登录框、状态不变 —— 别当成「被限制」去冷却,直接说清楚(2026-10-26 第二个号一直「点赞冷却中」)。
      var _lg = await tkCdp('(function(){var t=(document.body&&document.body.innerText||"");'
        + 'var m=/Log in to TikTok|Log in to follow|Sign up for TikTok|登录 TikTok|登入 TikTok|登錄 TikTok|로그인|ログイン/i.test(t)&&!!document.querySelector(\'[role="dialog"],[id*="login" i],[class*="LoginModal" i]\');'
        + 'return {ok:true,value:m};})()', false);
      if (_lg === true) {
        ctx.stepLog(1, 'warn', '   ⛔ 点赞时弹出了 TikTok 登录框 —— 这个号在这个浏览器里没登录(或登录失效了),先在账号窗口里登录再跑。本次不再点赞,只收潜客');
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

async function harvestCommentHandles() {
  var arr = await tkCdp('(function(){var out={};'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var p=items[i];'
    + 'for(var k=0;k<6&&p;k++){if(p.querySelector&&p.querySelector(\'a[href*="/@"]\'))break;p=p.parentElement;}'
    + 'if(!p||!p.querySelector)continue;var a=p.querySelector(\'a[href*="/@"]\');if(!a)continue;'
    + 'var hm=(a.getAttribute("href")||"").match(/\\/@([^\\/?#]+)/);var h=hm?decodeURIComponent(hm[1]):"";'
    + 'if(!h)continue;'
    + 'var u=p.querySelector(\'[data-e2e^="comment-username"]\');'
    + 'var n=(u&&(u.innerText||u.textContent)||"").replace(/\\s+/g," ").trim().slice(0,40);'
    + 'var key=h.toLowerCase();if(!out[key]||(!out[key].n&&n))out[key]={h:key,n:n};}'
    + 'var res=[];for(var k2 in out)res.push(out[k2]);'
    + 'return {ok:true,value:res};})()', null);
  return Array.isArray(arr) ? arr : [];
}

// ════════════════════════════════════════════════════════════════════
// STEP 1 · 采集同行的潜在客户
// ════════════════════════════════════════════════════════════════════

// 任务标签页先落【真首页】而不是 /explore:openTab 不经过 _navigate,原来等于任务第一步就「冷启动空降非首页」,
//   正是最容易撞 403 的姿势。首页停留(ensureTaskTabOpenedOnce 内已 sleep 8~12s)种好 cookie 后,再按原样过渡到 /explore,
//   后续流程看到的页面与改动前一致。没开出 task tab(老路径)时不额外导航,保持原行为。
await ensureTaskTabOpenedOnce('tiktok', 'main', 'https://www.tiktok.com/');
if (_activeTab) { _ttHomeAt = Date.now(); try { await _navigate('https://www.tiktok.com/explore'); } catch (_) {} await ctx.sleep(3000, 5000); }
// ⚠️ 这几个必须在 STEP1 之前就位 —— 采集结束那次 flushOutputs(1) 会用到它们。
//   var 只提升声明不提升赋值:留在 STEP2 那儿的话,那次落盘里 engagedLog/done 是
//   undefined,拼报告时抛 TypeError,又被 flushOutputs 自己的 try/catch 静默吞掉
//   —— 表现就是「中途停止只有名单、没有报告」,而且一行日志都没有。
var done = { like: 0, follow: 0, comment: 0, skipped: 0 };
var engagedLog = [];   // { handle, isNew, like, comment, followed, note }
var engagedSeen = Object.create(null);  // handle → 上面那行,补跑轮再次轮到同一人时并进去(见循环收尾)
var skippedSeen = Object.create(null);  // 只被跳过、没做过动作的 handle(不计触达)
// 落盘时算出来的账本人数 —— 收尾日志和 return 都要用,所以放在函数外面。
var finalTotal = 0;
// 报告文件名的时间戳【整轮固定】:一轮要落盘很多次,用实时时间会攒出一堆 md。
var RUN_STAMP = (function () { var d = new Date();
  return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0')
    + '_' + String(d.getHours()).padStart(2, '0') + '_' + String(d.getMinutes()).padStart(2, '0'); })();

ctx.stepStart(1);
// 2026-10-29 用户:「矩阵账号是英文,给潜客评论却还是中文」—— 强制语言时(客户端按账号内容语言下发 comment_language_hint),
//   开跑先把用的语言打出来(便于排查),写完评论再校验一遍语言,不对就重写一次,还不对就不发这条。
var FORCED_LANG = (function () {
  var h = String(task.comment_language_hint || '');
  if (/English/i.test(h)) return 'en';
  if (/简体中文|繁体中文|Chinese/i.test(h)) return 'zh';
  return '';
})();
ctx.stepLog(1, 'running', FORCED_LANG === 'en' ? '🌐 评论语言:English(按矩阵账号的内容语言)'
  : FORCED_LANG === 'zh' ? '🌐 评论语言:中文(按矩阵账号的内容语言)' : '🌐 评论语言:跟随视频');
leadOnlyNotice(1);
function langMismatch(t) {
  t = String(t || '');
  if (FORCED_LANG === 'en') return /[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]/.test(t);
  if (FORCED_LANG === 'zh') return !/[\u4e00-\u9fff]/.test(t);
  return false;
}

if (leadMode === 'accounts' && seedAccounts.length === 0 && liveRooms.length === 0) {
  ctx.stepLog(1, 'error', '精准获客模式需要至少填 1 个同行 TikTok 账号(一行一个,最多 50 个)。');
  ctx.finish('error', 'no_seed_accounts');
  return { status: 'failed', reason: 'no_seed_accounts' };
}
if (leadMode === 'live' && liveRooms.length === 0) {
  ctx.stepLog(1, 'error', '直播间获客模式需要至少填 1 个直播间链接(如 https://www.tiktok.com/@xxx/live)。');
  ctx.finish('error', 'no_live_rooms');
  return { status: 'failed', reason: 'no_live_rooms' };
}
if (leadMode === 'keywords' && keywordsList.length === 0) {
  ctx.stepLog(1, 'error', '关键词获客模式需要赛道关键词 — 请在配置里选赛道或填关键词。');
  ctx.finish('error', 'no_keywords');
  return { status: 'failed', reason: 'no_keywords' };
}
if (!ledgerPersistent) {
  ctx.stepLog(1, 'warn', '⚠️ 当前客户端版本不支持名单长期保存(需升级),本次名单仅在运行内有效。');
}

var priorTotal = ledgerSize();
// ⚠️ 计费口径(lead_collect 只对新入库的号收)不进任何用户可见文案 —— 2026-08-16 用户明确要求。
ctx.stepLog(1, 'running', '📇 潜在客户账本:本地已有 ' + priorTotal + ' 人' + (LEAD_UNLIMITED ? ' · 本次把评论区的人全部捞完(不设上限,已有的不会重复收录)' : ' · 本次目标新增 ' + maxNewLeads + ' 人(已有的不会重复收录)'));
if (seedDropped > 0) ctx.stepLog(1, 'warn', '⚠️ 有 ' + seedDropped + ' 行同行账号没认出来,已忽略 —— 请填主页链接或账号 id(昵称是搜不到主页的)。');
if (leadMode === 'accounts') {
  var _nWork = 0;
  for (var _sk = 0; _sk < seedAccounts.length; _sk++) if (seedKind(seedAccounts[_sk]) === 'work') _nWork++;
  var _nAcct = seedAccounts.length - _nWork;
  ctx.stepLog(1, 'running', '🎯 精准获客:'
    + (_nAcct > 0 ? '同行账号 ' + _nAcct + ' 个(每个最多翻 ' + SEED_WORKS_CAP + ' 条)' : '')
    + (_nWork > 0 ? ((_nAcct > 0 ? ' · ' : '') + '指定视频 ' + _nWork + ' 条(直接进这条采,不翻主页)') : ''));
  if (liveRooms.length) ctx.stepLog(1, 'running', '📺 另有直播间 ' + liveRooms.length + ' 个(先进直播间收发弹幕/进场的观众,每间最多停 ' + Math.round(LIVE_MAX_MS / 60000) + ' 分钟)');
} else if (leadMode === 'live') {
  ctx.stepLog(1, 'running', '🎯 直播间获客:直播间 ' + liveRooms.length + ' 个(每间最多停 ' + Math.round(LIVE_MAX_MS / 60000)
    + ' 分钟,连续 ' + Math.round(LIVE_IDLE_MS / 60000) + ' 分钟没新人就换下一间;收发弹幕/进场的观众)');
} else {
  ctx.stepLog(1, 'running', '🎯 关键词获客:关键词 ' + keywordsList.length + ' 个');
}
if (collectCmtCap > 0) {
  ctx.stepLog(1, 'running', '   ✍️ 每打开一条视频会顺手留一条评论(本次最多 ' + collectCmtCap + ' 条,与触达潜客的评论各算各的)');
}

var newLeads = [];   // 本次新增的 handle 列表(入库顺序)
var collectStats = { videosVisited: 0, commentersSeen: 0 };

// 把一批 handle 过账本:排除作者/种子号/已有记录,新号入库 + 计费。返回是否已收满。
// items 是 harvestCommentHandles 的 [{h,n}];也兼容纯字符串数组(以防某次只拿到账号)。
// sourceTag 形如 'kw:茶生活' / 'seed:@somebody',日志里拆成「来源关键词/来源同行」显示。
// src = { kw:'关键词或空', ownerHandle:'作品作者账号', ownerNick:'作品作者昵称' }
async function absorbHandles(items, authorHandle, src) {
  for (var i = 0; i < items.length; i++) {
    if (newLeads.length >= maxNewLeads) return true;
    var it = items[i];
    var h = normHandle(typeof it === 'string' ? it : (it && it.h));
    var nick = (typeof it === 'string' ? '' : (it && it.n) || '').trim();
    if (!h || h === authorHandle || seedSet[h]) continue;
    collectStats.commentersSeen++;
    if (ledger.leads[h]) continue;                       // 本地已有 → 不写、不计费
    ledger.leads[h] = {
      addedAt: Date.now(), nickname: nick,
      // 结构化来源:关键词(可空)+ 是从谁的评论区捞到的。STEP2/名单都要复述,所以存全。
      srcKw: (src && src.kw) || '', srcOwner: (src && src.ownerHandle) || '', srcOwnerNick: (src && src.ownerNick) || '',
      // 是同行的【哪一条】作品的评论区捞到的 —— 名单/运行记录都要复述,方便回查。
      srcVideo: (src && src.videoUrl) || '',
      srcTitle: (src && src.videoTitle) || '',
      srcLive: (src && src.live) ? 1 : 0,   // 直播间获客(2026-10-19)
      followed: 0, likedCount: 0, commentedCount: 0,
      doneVideoIds: [], lastEngagedAt: 0,
    };
    newLeads.push(h);
    // 上报「本次新增潜客」给任务详情页(与点赞/关注/评论同一套 addActionCount 通道)。
    if (typeof ctx.addActionCount === 'function') ctx.addActionCount('lead_new', 1);
    saveLedger();
    // 采集名单免费(2026-10-21 用户定),不再计费 lead_collect。
    ctx.stepLog(1, 'running',
      '   📇 获得新潜客(' + newLeads.length + (LEAD_UNLIMITED ? '' : '/' + maxNewLeads) + ')'
      + ' · 昵称 ' + (nick || '(未取到)')
      + ' · 账号 @' + h);   // 2026-10-28 用户:潜客来源文案不再展示(太多),来源仍存在账本/名单里
  }
  return newLeads.length >= maxNewLeads;
}

// 打开一条视频、展开评论区、滚动加载并收评论者。返回是否已收满。
// kw = 关键词模式下的当前关键词(精准模式传 '');ownerNickHint = 已知的作者昵称
// ── 已收干净的作品:下轮不再进 ──
// 同一个关键词每轮搜出来基本是同一批作品,评论区一遍遍重开、结果全是账本里已有的人,
//   时间白花(用户 2026-08-22 提)。收干净的打个标记,下轮直接跳过。
//   「收干净」= 评论区滚到底,或连续 4 屏没有新人(后者说明这条的评论者都收过了)。
//   收满名额提前退出的不算 —— 那条其实还没翻完,下轮还得接着翻。
// ⚠️ 退路:整轮新增为 0 且确实跳过了作品时,把本轮跳过的标记清掉(见 STEP1 收尾),
//   下轮它们又能进 —— 那时评论区多半已经有新评论了。
var harvestedSkippedThisRun = [];
function isHarvested(vid) {
  return !!(vid && ledger.doneVideos && ledger.doneVideos[vid]);
}
function markHarvested(vid) {
  if (!vid) return;
  if (!ledger.doneVideos) ledger.doneVideos = {};
  ledger.doneVideos[vid] = Date.now();
  // 环形封顶:天天跑会让这张表无限长,而账本每次动作都全量重写。留最近 2000 条
  //   足够覆盖「同一批搜索结果」的重复面。
  var ks = Object.keys(ledger.doneVideos);
  if (ks.length > 2000) {
    ks.sort(function (a, b) { return ledger.doneVideos[a] - ledger.doneVideos[b]; });
    for (var i = 0; i < ks.length - 2000; i++) delete ledger.doneVideos[ks[i]];
  }
  saveLedger();
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
// 2026-10-26 用户要求:关键词 / 作者下的作品要【一直往下刷到底】,不再只做开头那十几条。
//   上限 maxWorks(默认 300);上滑到底(没有下一条)、或滑回看过的作品才停。
async function swipeHarvest(list, kw, nickHint, owner, maxWorks, entryUrl) {
  maxWorks = maxWorks || beh.swipe_max_works || 300;
  if (!list.length) return false;
  var done = Object.create(null);
  // 点开列表里第一条(可信点击),等地址变成作品页。
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
    try { await _navigate(list[0]); opened = true; } catch (_) { return false; }
    await waitWithHold(beh.watch_open_pause || [5000, 10000]);
  }
  for (var n = 0; n < maxWorks + 5; n++) {
    if (ctx.aborted && ctx.aborted()) return true;
    var cur = await getUrl();
    var vid = videoIdOf(cur);
    if (!vid) break;
    if (done[vid]) break;   // 上滑回到看过的 → 到头了
    if (owner && authorOfVideoUrl(cur) && authorOfVideoUrl(cur) !== owner) { ctx.stepLog(1, 'running', '   ⏹️ 已经滑出这位同行的作品了'); break; }
    done[vid] = 1;
    var curUrl = String(cur).split('?')[0];
    ctx.stepLog(1, 'running', '   ▶️ 第 ' + Object.keys(done).length + ' 条作品 · ' + curUrl);
    if ((await collectFromVideo(curUrl, kw, nickHint, { inPlace: true })) && !HARVEST_CMT_LIKE) return true;
    var _cut = __batchCut; __batchCut = false;
    if (await maybeEngageBatch(_cut)) {
      if (_cut) {
        // 这条中途停下的:回到这条作品重新采(已收过的人会自动跳过),不往下滑。
        delete done[vid]; n--;
        if (ctx.aborted && ctx.aborted()) return true;
        if (!(await reenterAt(entryUrl, vid))) {
          ctx.stepLog(1, 'running', '   ↪️ 回不到列表里的位置,直接打开这条作品接着采');
          try { await _navigate(curUrl); } catch (_) { break; }
          await waitWithHold(beh.watch_open_pause || [5000, 10000]);
        }
        continue;
      }
      // 点完一批回来:回到刚才这条作品(弹层),后面照常上滑;回不去就退回直接打开列表里下一条
      if (!(await reenterAt(entryUrl, vid))) {
        var nx = '';
        for (var lj = 0; lj < list.length; lj++) { if (!done[videoIdOf(list[lj])]) { nx = list[lj]; break; } }
        if (!nx) { ctx.stepLog(1, 'running', '   ⏹️ 回不到刚才的位置,这一组先到这里'); break; }
        ctx.stepLog(1, 'running', '   ↪️ 回不到刚才的位置,直接打开下一条');
        try { await _navigate(nx); } catch (_) { break; }
        await waitWithHold(beh.watch_open_pause || [5000, 10000]);
        continue;
      }
    }
    if (Object.keys(done).length >= maxWorks) { ctx.stepLog(1, 'running', '   ⏹️ 已刷满 ' + maxWorks + ' 条作品,换下一个'); break; }
    await jsleep(beh.swipe_next_pause || [300, 600]);
    // 评论区里可能因恢复整页打开过这条 —— 先回到这条再上滑
    if (!(await goNextInModal(vid))) {
      var nextUrl = '';
      for (var li = 0; li < list.length; li++) { if (!done[videoIdOf(list[li])]) { nextUrl = list[li]; break; } }
      if (!nextUrl) { ctx.stepLog(1, 'running', '   ⏹️ 已经刷到最后一条了(没有下一条)'); break; }
      ctx.stepLog(1, 'running', '   ↪️ 上滑没反应,直接打开下一条');
      try { await _navigate(nextUrl); } catch (_) { break; }
      await waitWithHold(beh.watch_open_pause || [5000, 10000]);
    }
  }
  return newLeads.length >= maxNewLeads && !HARVEST_CMT_LIKE;
}

async function collectFromVideo(vurl, kw, ownerNickHint, opts) {
  var _vid = videoIdOf(vurl) || String(vurl || '');
  if (isHarvested(_vid)) {
    harvestedSkippedThisRun.push(_vid);
    return false;   // 上轮已收干净,这轮不重复进
  }
  var _exhausted = false;   // true = 评论区翻到头了(不是因为收满名额提前退出)
  __batchCut = false;
  if (opts && opts.inPlace) {
    // 已经在这条作品上了(从列表点开 / 上滑过来的),不再整页打开。
    await waitWithHold(beh.swipe_open_pause || [800, 1200]);
  } else {
    try { await _navigate(vurl); } catch (e) {
      ctx.stepLog(1, 'running', '   ⚠️ 打不开视频,跳过: ' + String(e && e.message || e).slice(0, 60));
      return false;
    }
    await waitWithHold(beh.watch_open_pause || [5000, 10000]);   // 一打开就暂停视频,防被自动滑走
  }
  if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
  collectStats.videosVisited++;
  var author = authorOfVideoUrl(vurl);
  // 关键词模式下每条视频作者都不同,得就地读一次昵称。
  var ownerNick = (ownerNickHint || '').trim();
  if (!ownerNick) { try { ownerNick = await readVideoOwnerNick(author); } catch (_) { ownerNick = ''; } }
  // 作品名 —— 名单/运行记录要说清「是他哪条作品下面的评论」(用户 2026-08-22)。
  var _srcTitle = '';
  try { _srcTitle = String(await getText(SEL_VIDEO_DESC) || '').replace(/\s+/g, ' ').trim().slice(0, 40); } catch (_e) { _srcTitle = ''; }
  var src = { kw: kw || '', ownerHandle: author, ownerNick: ownerNick , videoUrl: String(vurl || ''), videoTitle: _srcTitle };

  // 先评论、再采集(用户 2026-08-23):采集要滚几十屏,滚完之后评论入口早就不在视口里了,

  //   那时候再发根本发不出去(真机:「没找到评论图标」)。这一步顺带把评论区打开,

  //   紧接着的采集省一次展开。

  await commentOnSource(_srcTitle, ownerNick, _vid);
  if (!(await ensureCommentsOpen())) {
    ctx.stepLog(1, 'running', '   ⚠️ 评论面板打不开,跳过这条');
    return false;
  }
  await holdVideo();
  // 首屏 + 逐屏滚动加载。评论列表是【虚拟化】的(DOM 里同时只有 7~12 条,滚过去的被回收),
  //   所以必须每滚一屏就抓一次,而且轮次要给够 —— 老的 3~5 轮 × 每屏几条,一条作品最多
  //   也就十来个人,这正是用户反馈「评论那么多却只取到 3 个潜客」的另一半原因。
  //   收满本次名额会提前 return,所以上限给大不浪费;连续几轮没新人再停。
  // 2026-10-26 用户反馈:作品明明 1000 多条评论只采到 60 多个。原因两个:① 最多只翻 25 屏(虚拟列表每屏只露 7-12 条);
  //   ② 「连续 4 屏没有【新】潜客就停」—— 同一条作品再跑一次时,前面的人都已在名单里,很快就被判「翻完了」。
  //   改为:最多翻 1500 屏;停的条件看「这一屏有没有出现【这次没见过】的留言者」(不管他是不是老名单里的人),
  //   连续 6 屏都没有才算到底。名额收满照旧提前结束。
  // 2026-10-26 用户反馈:留言没点完、评论区没翻到底就去潜客主页了。旧的停止条件两个都会提前结束:
  //   ① scrollCommentPanel 一读到「滚动条在底部」就退出 —— 而 TikTok 正是滚到底才去加载下一批,当时就在底部;
  //   ② 连续 6 屏没出现新面孔就停 —— 下一批加载慢一点就被判翻完。
  //   改成和 tiktok_comment_like 一样:到底了先等 3-5 秒看有没有加载出新留言,连续 4 次到底且没新留言才算翻完;
  //   滚不动连续 6 次才放弃;作品被自动滑走就切回原作品接着翻(已赞的会自动跳过)。
  var maxScrolls = 3000;
  var seenHere = Object.create(null);
  var cl = { seen: Object.create(null), like: 0, already: 0, failed: 0, fail: 0, on: HARVEST_CMT_LIKE };
  var full = false, bottomTries = 0, stuckTries = 0, emptyTries = 0, recovers = 0, lastSeenN = 0;
  if (cl.on) ctx.stepLog(1, 'running', '   💗 先把这条作品的留言逐个点赞,同时收潜客(已赞过的自动跳过)');
  for (var s = 0; s <= maxScrolls; s++) {
    if (ctx.aborted && ctx.aborted()) return true;
    // 被自动滑到别的作品 → 切回来接着翻
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
    if (cl.on) { cl.on = await likeVisibleComments(cl, vurl); }
    var handles = await harvestCommentHandles();
    if (!handles || !handles.length) {
      // 一条都扫不到:评论区可能被收起来了 / 还没加载 —— 重新打开评论区,几次都不行才放弃。
      if (++emptyTries > 4) { ctx.stepLog(1, 'warn', '   ⛔ 评论区一直扫不到留言,这条先到这里'); break; }
      await ensureCommentsOpen(); await holdVideo();
      await jsleep([1500, 2500]);
      continue;
    }
    emptyTries = 0;
    for (var hi = 0; hi < handles.length; hi++) {
      var _it = handles[hi];
      var _hh = normHandle(typeof _it === 'string' ? _it : (_it && _it.h));
      if (_hh && !seenHere[_hh]) seenHere[_hh] = 1;
    }
    if (!full && await absorbHandles(handles, author, src)) {
      full = true;
      if (!cl.on) return true;
      ctx.stepLog(1, 'running', '   📇 潜客名额收满了,继续往下把这条作品的留言点完');
    }
    // 2026-10-29 用户:「不是捞到 500 先工作么」—— 以前只在【一条作品采完后】才检查够不够一批,
    //   评论很多的作品会在同一条里一直收(用户实测收到 684 还没开始互动)。改成翻每一屏都看:
    //   本批够了就先停下这条(不标记「已收干净」),去互动,回来再接着采这条。
    //   点赞/评论/关注额度都没了就不停(停了也没事可做,白白回头重翻)。
    if (!full && newLeads.length - __batchFrom >= LEAD_BATCH && (__ensureEngageInit(), pickLeadAction(null, true))) {
      __batchCut = true;
      ctx.stepLog(1, 'running', '   📦 这条作品下已收满一批(' + (newLeads.length - __batchFrom) + ' 位),先去互动,回来再接着采这条');
      break;
    }
    if (s > 0 && s % 50 === 0) ctx.stepLog(1, 'running', '   📜 已翻 ' + s + ' 屏,这条作品下看过 ' + Object.keys(seenHere).length + ' 位留言者、点赞 ' + cl.like + ' 条,本次新收 ' + newLeads.length + ' 位');
    var st0 = await commentPanelState();
    await scrollCommentPanel();
    await jsleep(beh.harvest_scroll_pause || [1200, 2200]);
    var st1 = await commentPanelState();
    var nowSeen = Object.keys(seenHere).length + Object.keys(cl.seen).length;
    var progressed = nowSeen > lastSeenN;
    lastSeenN = nowSeen;
    if (!st1) continue;
    if (st1.bottom) {
      if (progressed && bottomTries === 0) continue;   // 刚到底,这一屏还有新留言 → 先扫完这屏
      // 到底了:下一批可能还在加载,等一等再看(连续 3 次到底、没有新留言才算翻完)。
      bottomTries++;
      if (bottomTries >= 3) {
        var cntTxt = await tkCdp('(function(){var e=document.querySelector(\'[data-e2e="comment-count"],[data-e2e="browse-comment-count"]\');return {ok:true,value:e?(e.innerText||"").trim():""};})()', '');
        ctx.stepLog(1, 'running', '   📭 这条作品的留言翻完了:看过 ' + Object.keys(seenHere).length + ' 位留言者'
          + (cntTxt ? '(作品显示 ' + cntTxt + ' 条评论,这个数包含了留言下面的回复)' : ''));
        _exhausted = !full;
        break;
      }
      await jsleep(beh.harvest_bottom_wait_pause || [1500, 2500]);
      continue;
    }
    bottomTries = 0;
    if (st0 && st1.top === st0.top) {
      // 没到底却滚不动(鼠标没落在面板上之类)—— 重新打开评论区再试,连续 6 次才放弃。
      if (++stuckTries >= 6) { ctx.stepLog(1, 'warn', '   ⚠️ 评论区滚不动了,这条先到这里'); break; }
      if (stuckTries % 2 === 0) { await ensureCommentsOpen(); await holdVideo(); }
    } else { stuckTries = 0; }
  }
  if (HARVEST_CMT_LIKE) ctx.stepLog(1, 'running', '   📊 这条作品留言:点赞 ' + cl.like + ' · 之前已赞 ' + cl.already + (cl.failed ? ' · 失败 ' + cl.failed : ''));
  // 翻到头了才算收干净 —— 收满名额提前退出的不能标记,那条还没翻完。
  if (_exhausted) markHarvested(_vid);
  return newLeads.length >= maxNewLeads;
}

// 在【当前打开的这条作品】下留一条评论。采集完顺手做,别浪费这次打开(用户 2026-08-23)。
//   计费跟互动评论完全同价(都走 chargeAction('comment')),没有另立名目。
//   ⚠️ 三点保护:① 防风控硬上限 COLLECT_CMT_CAP;② 同一条作品一轮只留一次;
//   ③ 评论失败不影响采集(整个函数吞异常)—— 采潜客才是主线。
// 【跨运行】记住哪些作品已经留过言 —— 只靠内存里的 commentedSources 的话,
//   明天再跑同一批同行会把同一条作品再评一次,对作者来说就是同个号连着刷屏。
//   环形封顶 2000 条,理由同 markHarvested。
function hasCommentedWork(vid) {
  return !!(vid && ledger.commentedWorks && ledger.commentedWorks[vid]);
}
function markCommentedWork(vid) {
  if (!vid) return;
  if (!ledger.commentedWorks) ledger.commentedWorks = {};
  ledger.commentedWorks[vid] = Date.now();
  var _ks = Object.keys(ledger.commentedWorks);
  if (_ks.length > 2000) {
    _ks.sort(function (a, b) { return ledger.commentedWorks[a] - ledger.commentedWorks[b]; });
    for (var _i = 0; _i < _ks.length - 2000; _i++) delete ledger.commentedWorks[_ks[_i]];
  }
  saveLedger();
}

var commentedSources = Object.create(null);
async function commentOnSource(title, ownerNick, vid) {
  try {
    if (collectCmtCap <= 0 || collectCmtDone >= collectCmtCap) return;
    if (!vid || commentedSources[vid]) return;
    // 之前的运行已经在这条下面留过言了 —— 别再评一次(用户 2026-08-23)。
    if (hasCommentedWork(vid)) {
      ctx.stepLog(1, 'running', '   ⏭️ 这条之前已经留过言了,不重复评论');
      commentedSources[vid] = 1;
      return;
    }
    if (ctx.aborted && ctx.aborted()) return;
    commentedSources[vid] = 1;
    ctx.stepLog(1, 'running', '   ✍️ 顺手在这条作品下留一条(' + (collectCmtDone + 1) + '/' + collectCmtCap + ')');
    var cr = await tryComment(title || '', ownerNick || '', 1);
    if (cr && cr.ok) {
      collectCmtDone++;
      markCommentedWork(vid);
      // ⚠️ 不动 done.comment —— 那是 STEP2 触达的计数器,加进去会让触达阶段
      //   done.comment < cmtBudget 提前判满,白白少评潜客。
      if (typeof ctx.addActionCount === 'function') ctx.addActionCount('comment', 1);
      await chargeIfPossible('comment', vid);
    }
    if (cr && cr.msg) ctx.stepLog(1, (cr.warn ? 'warn' : 'running'), cr.msg);
  } catch (_e) { /* 留言失败不影响采集主线 */ }
}


// ── 直播间采集 ──
// 页面内收集器:每 0.5 秒扫一遍弹幕/进场/礼物消息(进场的人在 message.payload.anchor_display_text.pieces[].user_value.user,深 7 层),从 React 节点的 props 里取 user.display_id(=@账号)和 nickname,
//   按账号去重攒到 window.__ncLive。弹幕区是虚拟列表、滚出去的节点会被复用,所以不做「处理过」标记,每次全扫(就几十个节点)。
var LIVE_INSTALL_JS = '(function(){window.__ncLive=window.__ncLive||{};window.__ncDiag=window.__ncDiag||{els:0,fiber:0,users:0,keys:""};if(window.__ncLiveTimer)return {ok:true,value:"already"};'
  // 账号字段兼容几种写法(2026-10-19 用户真机:登录态/中文界面下没收到人,不确定字段名,宽松匹配 + 诊断)
  + 'var HK=["display_id","displayId","unique_id","uniqueId"],NK=["nickname","nickName","nick_name"];'
  + 'function pick(o,ks){for(var i=0;i<ks.length;i++){var v=o[ks[i]];if(typeof v==="string"&&v)return v;}return "";}'
  + 'function hasAny(o,ks){for(var i=0;i<ks.length;i++){if(ks[i] in o)return true;}return false;}'
  + 'function usr(el){var k=null;for(var x in el){if((x.indexOf("__reactFiber")===0||x.indexOf("__reactInternalInstance")===0)){k=x;break;}}if(!k)return null;window.__ncDiag.fiber++;var f=el[k];'
  + 'for(var up=0;up<3&&f;up++,f=f.return){var p=f.memoizedProps;if(!p||typeof p!=="object")continue;var st=[[p,0]],seen=[],n=0;'
  + 'while(st.length&&n<800){var c=st.pop(),o=c[0],d=c[1];n++;if(!o||typeof o!=="object"||d>8||seen.indexOf(o)>=0)continue;seen.push(o);'
  + 'if(hasAny(o,NK)){var h=pick(o,HK);if(h)return {h:h,n:pick(o,NK)};if(!window.__ncDiag.keys)window.__ncDiag.keys=Object.keys(o).slice(0,40).join(",");}'
  + 'for(var key in o){if(key==="_owner"||key==="return"||key==="stateNode"||key==="ref")continue;var v=o[key];'
  + 'if(v&&typeof v==="object"&&!(typeof Node!=="undefined"&&v instanceof Node))st.push([v,d+1]);}}}return null;}'
  + 'function rows(){var els=document.querySelectorAll(\'[data-e2e="chat-message"],[data-e2e="enter-message"],[data-e2e="social-message"],[data-e2e="gift-message"]\');'
  + 'if(els.length)return els;var c=document.querySelector(\'[data-e2e="live-chat-container"]\');'
  + 'if(!c)return [];var out=[],q=[[c,0]];while(q.length&&out.length<300){var it=q.shift(),e=it[0];for(var i=0;i<e.children.length;i++){out.push(e.children[i]);if(it[1]<4)q.push([e.children[i],it[1]+1]);}}return out;}'
  + 'function scan(){try{var els=rows();window.__ncDiag.els=els.length;'
  + 'for(var i=0;i<els.length;i++){var r=null;try{r=usr(els[i]);}catch(e){}'
  + 'if(r&&r.h){var key=String(r.h).replace(/^@/,"").toLowerCase();if(!window.__ncLive[key]){window.__ncLive[key]={h:key,n:String(r.n||"").slice(0,40),sent:0};window.__ncDiag.users++;}}}}catch(e){}}'
  + 'window.__ncLiveScan=scan;scan();window.__ncLiveTimer=setInterval(scan,500);return {ok:true,value:"installed"};})()';
var LIVE_DRAIN_JS = '(function(){try{if(window.__ncLiveScan)window.__ncLiveScan();}catch(e){}var m=window.__ncLive||{};var out=[];for(var k in m){if(!m[k].sent){m[k].sent=1;out.push({h:m[k].h,n:m[k].n});}}'
  + 'var chat=!!document.querySelector(\'[data-e2e="live-chat-container"],[data-e2e="chat-message"]\');'
  + 'var t=(document.body&&document.body.innerText||"").slice(0,4000);'
  + 'var ended=/LIVE has ended|直播已结束|直播已結束|This LIVE has ended/i.test(t);'
  + 'var a=document.querySelector(\'[data-e2e="room-header-anchor-name"]\');'
  + 'var dg=window.__ncDiag||{};var nm=document.querySelectorAll(\'[data-e2e="chat-message"]\').length;'
  + 'return {ok:true,value:{path:String(location.pathname||""),items:out,chat:chat,ended:ended,anchor:a?(a.innerText||"").trim().slice(0,40):"",diag:{rows:dg.els||0,fiber:dg.fiber||0,users:dg.users||0,chatMsgs:nm,keys:dg.keys||""}}};})()';
var LIVE_STOP_JS = '(function(){try{clearInterval(window.__ncLiveTimer);window.__ncLiveTimer=0;}catch(e){}return {ok:true,value:1};})()';

// 当前页是不是目标主播的直播间(主播下播后 TikTok 会自动转到别人的直播间,不能把别间的观众收进来)。
async function onRoomPage(room) {
  var path = await tkCdp('(function(){return {ok:true,value:String(location.pathname||"").toLowerCase()};})()', '');
  return String(path || '').replace(/\/+$/, '') === ('/@' + room.owner + '/live');
}
// 整页进 /live(直播广场),再在页面内切到目标直播间。成功返回 true。
async function openLiveRoomInApp(room) {
  var cur = await tkCdp('(function(){return {ok:true,value:String(location.pathname||"")};})()', '');
  if (!/^\/live\b|\/live$/.test(String(cur || '')) || (await _isHttpErrorPage())) {
    try { await _navigate('https://www.tiktok.com/live'); } catch (e) {
      ctx.stepLog(1, 'running', '   ⚠️ 直播广场打不开: ' + String(e && e.message || e).slice(0, 60));
      return false;
    }
    await jsleep(beh.first_screen_pause || [8000, 14000]);
  }
  var target = '/@' + room.owner + '/live';
  await tkCdp('(function(){try{history.pushState({}, "", ' + JSON.stringify(target) + ');window.dispatchEvent(new PopStateEvent("popstate",{state:{}}));}catch(e){}return {ok:true,value:1};})()', null);
  for (var w = 0; w < 10; w++) {
    await ctx.sleep(1500, 2000);
    if (await _isHttpErrorPage()) return false;
    var ok = await tkCdp('(function(){var p=String(location.pathname||"").toLowerCase().replace(/\\/+$/,"");'
      + 'var a=document.querySelector(\'[data-e2e="room-header-anchor-name"],[data-e2e="live-chat-container"]\');'
      + 'return {ok:true,value:(p===' + JSON.stringify(target.toLowerCase()) + '&&!!a)};})()', false);
    if (ok === true) {
      ctx.stepLog(1, 'running', '   ✅ 已从直播广场切进直播间(不整页打开,避开 403)');
      await jsleep([4000, 7000]);
      return true;
    }
  }
  return false;
}

// 停在一个直播间收潜客。返回是否已收满。
async function collectFromLive(room, idx, total) {
  ctx.stepLog(1, 'running', '── 直播间 ' + (idx + 1) + '/' + total + ' · @' + room.owner + ' ──');
  // 2026-10-19 真机:指纹浏览器里【整页】打开 /@xxx/live 常被 TikTok 边缘风控直接 403(同一 IP 的普通 Chrome 能开)。
  //   改成「先整页进直播广场 /live,再在页面内切到目标直播间」(history.pushState + popstate,TikTok LIVE 的前端路由
  //   会接管,不发整页请求,就不吃那道 403)。切不过去(路由没接管 / 跳到 404)才退回老办法整页打开。
  var opened = await openLiveRoomInApp(room);
  if (!opened) {
    try { await _navigate(room.url); } catch (e) {
      ctx.stepLog(1, 'running', '   ⚠️ 打不开直播间,跳过: ' + String(e && e.message || e).slice(0, 60));
      return false;
    }
    await jsleep(beh.first_screen_pause || [8000, 14000]);
  }
  if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
  if (!(await onRoomPage(room))) {
    ctx.stepLog(1, 'running', '   ⏭️ 打开后不是 @' + room.owner + ' 的直播间(主播可能已下播,被转到了别的直播),跳过');
    return false;
  }
  await tkCdp(LIVE_INSTALL_JS, null);
  var t0 = Date.now(), lastNew = Date.now(), lastBeat = Date.now(), chatSeen = false, before = newLeads.length;
  var anchorNick = '';
  var full = false;
  var diagLogged = false;
  try {
  while (Date.now() - t0 < LIVE_MAX_MS) {
    if (ctx.aborted && ctx.aborted()) break;
    await ctx.sleep(1800, 2600);
    // 页面可能自己刷新 / 重定向(TikTok 进直播间后常见,2026-10-19 真机:装好的收集器被冲掉,之后一直 0 人)
    //   —— 每次取数前都确认一次收集器还在(已在就是空操作)。
    await tkCdp(LIVE_INSTALL_JS, null);
    var st = await tkCdp(LIVE_DRAIN_JS, null);
    if (!st || typeof st !== 'object') {
      if (Date.now() - t0 > 60000 && !chatSeen) { ctx.stepLog(1, 'running', '   ⚠️ 读不到直播间页面数据,跳过这间'); break; }
      continue;
    }
    if (st.anchor && !anchorNick) anchorNick = st.anchor;
    if (st.ended) { ctx.stepLog(1, 'running', '   ⏹️ 直播已结束,换下一间'); break; }
    if (st.path && String(st.path).toLowerCase().replace(/\/+$/, '') !== ('/@' + room.owner + '/live')) {
      ctx.stepLog(1, 'running', '   ⏹️ 页面已经不在 @' + room.owner + ' 的直播间(主播可能下播了),换下一间');
      break;
    }
    if (st.chat) chatSeen = true;
    if (!chatSeen && Date.now() - t0 > 30000) { ctx.stepLog(1, 'running', '   ⚠️ 30 秒没看到弹幕区 —— 主播可能没在直播,跳过'); break; }
    var items = Array.isArray(st.items) ? st.items : [];
    if (items.length) {
      var n0 = newLeads.length;
      full = await absorbHandles(items, room.owner, { live: 1, kw: '', ownerHandle: room.owner, ownerNick: anchorNick, videoUrl: room.url, videoTitle: '' });
      if (newLeads.length > n0) lastNew = Date.now();
      if (full) break;
    }
    if (Date.now() - lastNew > LIVE_IDLE_MS) {
      ctx.stepLog(1, 'running', '   ⏭️ 连续 ' + Math.round(LIVE_IDLE_MS / 60000) + ' 分钟没有新观众,换下一间');
      break;
    }
    if (!diagLogged && Date.now() - t0 > 25000 && newLeads.length === before) {
      diagLogged = true;
      var _dg = st.diag || {};
      ctx.stepLog(1, 'warn', '   🔎 诊断:弹幕节点 ' + (_dg.chatMsgs || 0) + ' · 扫描行 ' + (_dg.rows || 0) + ' · React节点 ' + (_dg.fiber || 0) + ' · 读到用户 ' + (_dg.users || 0)
        + (_dg.keys ? ' · 字段 ' + String(_dg.keys).slice(0, 300) : ''));
    }
    if (Date.now() - lastBeat > 60000) {
      lastBeat = Date.now();
      ctx.stepLog(1, 'running', '   ⏳ 已在直播间停留 ' + Math.round((Date.now() - t0) / 60000) + ' 分钟 · 这间新增 ' + (newLeads.length - before) + ' 人');
    }
  }
  } finally {
    await tkCdp(LIVE_STOP_JS, null);   // 出异常也要把页面里的收集器停掉
  }
  collectStats.videosVisited++;
  ctx.stepLog(1, 'running', '   ✅ 这间共收到 ' + (newLeads.length - before) + ' 个新潜客');
  return full || newLeads.length >= maxNewLeads;
}

// 2026-10-27 用户定:边收边点 —— 每收满一批(默认 500 人,2026-10-28 由 1000 改)就先去这批人的主页点赞,点完再回去接着收。
//   触达循环抽成函数,采集中途按批调用、采集结束后再调一次处理剩下的人。返回 {status:'failed'} 表示撞验证码要整体停。
async function __engageBatch(queue) {
var profileErrStreak = 0;   // 连续几位潜客主页作品加载失败(TikTok 风控)
  for (var qi = 0; qi < queue.length; qi++) {
    if (ctx.aborted && ctx.aborted()) break;
    if (!pickLeadAction(null, true)) {
      ctx.stepLog(2, 'running', '✅ 本次点赞/评论/关注额度都用完了,剩下的潜客留到下次');
      break;
    }
    var handle = queue[qi];
    var lead = ledger.leads[handle];
    var isNew = lead.lastEngagedAt === 0;
    var row = { handle: handle, nickname: (lead.nickname || '').trim(), isNew: isNew, like: 0, comment: 0, followed: 0, note: '' };
  
    var leadNick = (lead.nickname || '').trim();
    ctx.stepLog(2, 'running',
      '── 客户 ' + (qi + 1) + '/' + queue.length
      + ' · 昵称 ' + (leadNick || '(未取到)')
      + ' · 账号 @' + handle
      + '(' + (isNew ? '潜在新客' : '老客') + ') ──');
    // ⚠️ 来源【只在下面这行 ℹ️ 里说一次】。以前头部也拼了一份来源描述,两行讲同一件事、
    //   还各带一串 sec_uid,进度里读起来全是噪音(2026-08-22 用户反馈)。
    try { await _navigate('https://www.tiktok.com/@' + handle); } catch (e) {
      ctx.stepLog(2, 'running', '   ⚠️ 打不开主页,跳过: ' + String(e && e.message || e).slice(0, 60));
      lead.lastEngagedAt = Date.now(); saveLedger();
      row.note = '主页打不开'; pushOrMerge(handle, row, true); done.skipped++;
      maybeTopUp(qi);
      continue;
    }
    // 2026-10-26 用户要求:主页上一看到他的作品就立刻点进去(不固定等、不先跑空态/不存在探测)。
    var pr = await waitReady('profile', 8000, handle);   // 认不出状态时最多等 8s
    if (pr === 'error') {
      // 2026-10-26 真机实测:作品格子显示「Something went wrong / Refresh」,点 Refresh 仍报错 —— 是 TikTok 不给这个号
      //   加载别人主页的作品列表(风控),不是我们等得不够。点一次 Refresh 再看,还不行就立刻跳过,不白等 12 秒。
      try { await tkCdp('(function(){var bs=document.querySelectorAll("button");for(var k=0;k<bs.length;k++){if(/^(Refresh|刷新|重新整理|重试|重試)$/i.test((bs[k].innerText||"").trim())){bs[k].click();return {ok:true,value:1};}}return {ok:true,value:0};})()', null); } catch (_) {}
      pr = await waitReady('profile', 4000, handle);
    }
    if (pr === 'error') {
      profileErrStreak++;
      lead.lastEngagedAt = Date.now(); saveLedger();
      ctx.stepLog(2, 'warn', '   ⚠️ TikTok 没加载出他的作品列表(页面显示 Something went wrong),跳过');
      row.note = '主页作品加载失败'; pushOrMerge(handle, row, true); done.skipped++;
      if (profileErrStreak >= 3) {
        ctx.stepLog(2, 'warn', '⛔ 连续 ' + profileErrStreak + ' 位潜客的主页作品都加载失败 —— TikTok 暂时限制了这个号浏览别人主页,本次先停;'
          + '建议这个号休息一段时间再跑。');
        break;
      }
      maybeTopUp(qi);
      continue;
    }
    profileErrStreak = 0;
    var quickVideo = (typeof pr === 'string' && pr.indexOf('v:') === 0) ? pr.slice(2) : '';
    // 2026-10-26 用户要求:主页上没有任何作品、或是私密账号 → 直接跳过这位(不做关注、不再探测、不等)。
    if (!quickVideo) {
      var whyEmpty = pr === 'empty' ? '没有作品或是私密账号' : '主页上没看到作品';
      lead.lastEngagedAt = Date.now(); if (pr === 'empty') lead.noWorks = 1; saveLedger();
      ctx.stepLog(2, 'running', '   ⏭️ ' + whyEmpty + ',跳过');
      row.note = whyEmpty; pushOrMerge(handle, row, true); done.skipped++;
      maybeTopUp(qi);
      continue;
    }
    if (!quickVideo && !(await captchaGate(2))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', engaged: engagedLog }; }
  
    if (quickVideo || !(await probeUserGone())) {
      // 主页这次是打得开的 —— 把之前累积的 gone 清零。
      //   不清的话「连续两轮」就变成了「有生之年累计两次」:三月误判一次、八月再误判一次
      //   就够把一个大活人永久踢出队列,而且此后再也不会被探测,没有翻身机会。
      if (lead.gone) { lead.gone = 0; saveLedger(); }
    } else {
      lead.gone = (lead.gone || 0) + 1;
      lead.lastEngagedAt = Date.now(); saveLedger();
      ctx.stepLog(2, 'running', '   ⏭️ 用户不存在(已注销/被封/改号),跳过'
        + (lead.gone >= 2 ? ' —— 连续两轮都不存在,不再排进队列' : ''));
      row.note = lead.gone >= 2 ? '用户不存在(已停止排队)' : '用户不存在';
      pushOrMerge(handle, row, true); done.skipped++;
      maybeTopUp(qi);
      continue;
    }
  
    // 空态先探一次:没作品就别翻了(翻作品会滚动着找一批永远不会出现的链接)。
    //   下面 fresh.length===0 的分支会照常在主页做关注,该拿的动作不丢。
    var leadVideos = [];
    if (quickVideo) {
      leadVideos = [quickVideo];
    } else if (await probeNoWorks()) {
      ctx.stepLog(2, 'running', '   ℹ️ 暂无内容(该用户还没发布作品)—— 没作品可点赞/评论,这位会跳过');
      row.note = row.note || '暂无内容';
      // 记进账本:名单里那行「累计 👍0 / 💬0」才说得出为什么是 0(用户 2026-08-22 要求)。
      lead.noWorks = 1; saveLedger();
    } else {
      // 2026-10-13 用户定:每人只要有一条作品就能互动,不翻页 —— 只取第一屏的第一条(收到 1 条就停,
      //   不会往下滚;只有网格还没加载出来时才会等)。互动完这个人就标 engagedDone,以后不再排队。
      leadVideos = await collectVideoLinksOnPage(1, handle);
    }
    if (leadVideos.length > 0 && lead.noWorks) { lead.noWorks = 0; saveLedger(); }   // 今天发了作品 → 旧的「没作品」标记作废
    var fresh = [];
    for (var fv = 0; fv < leadVideos.length; fv++) {
      if (authorOfVideoUrl(leadVideos[fv]) !== handle) continue;   // 排掉主页里混入的他人视频
      var fvid = videoIdOf(leadVideos[fv]);
      if (fvid && (lead.doneVideoIds || []).indexOf(fvid) === -1) fresh.push(leadVideos[fv]);
    }
  
    // 2026-10-19 用户定:每个潜客【一辈子只做 1 个动作】—— 点赞 / 评论 / 关注 三选一,做完就不再碰他。
    //   选哪个由 pickLeadAction 按「剩余额度比例」挑(哪样剩得多做哪样),点赞/评论都落在他的第一条作品上。
    //   私密号 / 有作品但都互动过(旧账本)→ 只可能是关注;真没作品 → 跳过。
    if (fresh.length === 0) {
      if (lead.noWorks || leadVideos.length > 0) { lead.exhaustedAt = Date.now(); saveLedger(); }
      if (lead.noWorks) {
        lead.lastEngagedAt = Date.now(); saveLedger();
        ctx.stepLog(2, 'running', '   ⏭️ 暂无内容(还没发布作品)—— 跳过这位');
        row.note = row.note || '暂无内容,未互动';
        pushOrMerge(handle, row, true); done.skipped++;
        continue;
      }
    }
    // 2026-10-26 用户定:不再「每人三选一」。到了潜客这里:有关注额度就关注、有评论额度就评论,
    //   同时都给他第一条作品点个赞(点赞不限量)。顺序:先在主页关注 → 打开作品 → 点赞 → 评论。
    var wantFollow = followBudget > done.follow && !lead.followed;
    var wantCmt = fresh.length > 0 && cmtBudget > done.comment;
    var wantLike = fresh.length > 0 && doLike;
    var act = (wantLike || wantCmt) ? 'video' : (wantFollow ? 'follow' : null);
    if (!act) {
      row.note = row.note || (fresh.length === 0 ? '没有作品可点赞/评论,关注额度已用完' : '本次额度已用完');
      ctx.stepLog(2, 'running', '   ⏭️ ' + row.note);
      lead.lastEngagedAt = Date.now(); saveLedger();
      pushOrMerge(handle, row, true); done.skipped++;
      continue;
    }
    lead.exhaustedAt = 0;
    if (wantFollow) {
      // 关注直接在主页做,不用再开作品
      await jsleep(beh.before_follow_pause || [4000, 10000]);
      var pf = await tryFollowOnProfile();
      if (pf.ok) {
        lead.followed = 1; row.followed = 1; done.follow++;
        if (typeof ctx.addActionCount === 'function') ctx.addActionCount('follow', 1);
        await chargeIfPossible('follow');
        ctx.stepLog(2, 'running', '   ➕ 已在主页关注 @' + handle);
      } else {
        ctx.stepLog(2, 'running', '   ' + (pf.msg || '⚠️ 主页关注失败'));
        row.note = '关注失败';
      }
    }
    if (act === 'video') {
      var wurl = fresh[0];
      var _opened = true;
      var _clicked = false;
      // 2026-10-27 真机:直接整页打开作品链接,TikTok 现在一律回 403(Access denied)→ 页面上根本没有点赞按钮,
      //   日志就是「没找到点赞按钮」。所以必须从主页【点卡片】进去:每次点之前重新定位卡片(关注后页面会重渲染,
      //   旧标记会丢),点不开重试一次;实在不行才整页打开,打开后撞 403 就回主页再点一次。
      _clicked = await openCardOnProfile(wurl);
      if (!_clicked) { ctx.stepLog(2, 'running', '   ↪️ 卡片没点开,再点一次'); await ctx.sleep(800); _clicked = await openCardOnProfile(wurl); }
      if (!_clicked) {
        try { await _navigate(wurl); } catch (e) { _opened = false; done.skipped++; row.note = '作品打不开'; }
        if (_opened && await isTk403()) {
          ctx.stepLog(2, 'warn', '   ⚠️ 直接打开作品被 TikTok 拒绝(403),回主页从卡片点进去');
          try { await _navigate('https://www.tiktok.com/@' + handle); } catch (_) {}
          await waitReady('profile', 10000, handle);
          _clicked = await openCardOnProfile(wurl);
          if (!_clicked) { _opened = false; done.skipped++; row.note = '作品打不开(403)'; ctx.stepLog(2, 'warn', '   ⚠️ 作品还是打不开,跳过这位'); }
        }
      }
      if (_opened) {
        await waitReady('video', 10000);   // 点赞按钮一出现就继续(原 watch_open_pause 6-12s 固定等)
        await holdVideo();
        if (!(await captchaGate(2))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', engaged: engagedLog }; }
        var wdesc = await getText(SEL_VIDEO_DESC);
        var dwell = randInt((beh.lead_watch_ms || [1000, 2000])[0], (beh.lead_watch_ms || [1000, 2000])[1]);
        await sleepWithHeartbeat(2, dwell, '观看中');
        if (wantLike) {
          await jsleep(beh.before_like_pause || [1000, 2000]);
          var lr = await tryLike();
          if (lr.ok) {
            lead.likedCount++; row.like++; done.like++;
            if (typeof ctx.addActionCount === 'function') ctx.addActionCount('like', 1);
            await chargeIfPossible('like_lite');
          }
          ctx.stepLog(2, lr.warn ? 'warn' : 'running', lr.msg);
        }
        if (wantCmt) {
          await jsleep(beh.before_comment_open_pause || [4000, 9000]);
          var cr = await tryComment(wdesc, handle);
          if (cr.ok) {
            lead.commentedCount++; row.comment++; done.comment++;
            if (typeof ctx.addActionCount === 'function') ctx.addActionCount('comment', 1);
            await chargeIfPossible('comment');
          }
          ctx.stepLog(2, cr.warn ? 'warn' : 'running', cr.msg);
        }
        var wvid = videoIdOf(wurl);
        if (wvid && (row.like || row.comment)) {   // 只记做成了的(没做成的下次还能再轮到)
          if (!lead.doneVideoIds) lead.doneVideoIds = [];
          lead.doneVideoIds.push(wvid);
          if (lead.doneVideoIds.length > 300) lead.doneVideoIds = lead.doneVideoIds.slice(-300);
        }
        // 2026-10-28 用户:潜客有多个作品 → 在作品弹层里点「下一个」,把他的作品都点赞完(增加点赞数)。
        //   只要地址还是他的作品就继续;翻到别人的作品 / 翻不动 / 这位赞满上限 / 翻满上限条就停。
        //   已赞过的跳过不计;没点上的记一行日志,接着点下一条(2026-10-28 用户:不要「连续 3 条没点上就停」)。
        if (wantLike && beh.lead_like_all !== false) {
          // 2026-10-28 12:32 用户定:每位潜客只点 2 条作品(第一条 + 往下翻 1 条),然后换下一位(原为最多赞 40 条 / 翻 100 条)。
          var _laLikeCap = Math.max(1, Number(beh.lead_like_per_lead_max) || 2);
          var _laMax = Math.max(0, Number(beh.lead_like_all_max) || 1), _laDone = 0, _laSeen = 0, _laVid = wvid;
          // 2026-10-28 用户:连续 5 条作品都没点上(每条本来就会点两次)→ 这位直接跳过,换下一位。第一条没点上也算。
          var _laFailCap = Math.max(1, Number(beh.lead_like_fail_skip) || 5);
          var _laFail = (lr && !lr.ok && !lr.skip) ? 1 : 0;
          while (_laSeen < _laMax && row.like < _laLikeCap && _laFail < _laFailCap && !(ctx.aborted && ctx.aborted())) {
            await jsleep(beh.like_all_next_pause || [600, 1200]);
            if (!_laVid || !(await goNextInModal(_laVid))) break;
            var _laUrl = await getUrl(), _laNv = videoIdOf(_laUrl), _laAu = authorOfVideoUrl(_laUrl);
            if (!_laNv || _laNv === _laVid || (_laAu && _laAu !== handle)) break;
            _laVid = _laNv; _laSeen++;
            await waitReady('video', 10000);
            await holdVideo();
            if (!(await captchaGate(2))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', engaged: engagedLog }; }
            await jsleep(beh.before_like_pause || [1000, 2000]);
            var _laR = await tryLike();
            if (_laR.ok) {
              _laDone++; _laFail = 0;
              lead.likedCount++; row.like++; done.like++;
              if (typeof ctx.addActionCount === 'function') ctx.addActionCount('like', 1);
              await chargeIfPossible('like_lite');
              if (!lead.doneVideoIds) lead.doneVideoIds = [];
              lead.doneVideoIds.push(_laNv);
              if (lead.doneVideoIds.length > 300) lead.doneVideoIds = lead.doneVideoIds.slice(-300);
              ctx.stepLog(2, 'running', '   👍 他的第 ' + (_laSeen + 1) + ' 条作品 · 点赞成功');
            } else if (_laR.skip) {
              ctx.stepLog(2, 'running', '   ⏭️ 他的第 ' + (_laSeen + 1) + ' 条作品已赞过');
            } else {
              _laFail++;
              ctx.stepLog(2, 'warn', '   ⚠️ 他的第 ' + (_laSeen + 1) + ' 条作品' + String(_laR.msg || '').replace(/^\s*⚠️\s*/, ' · '));
              if (_laFail >= _laFailCap) ctx.stepLog(2, 'warn', '   ⏭️ 连续 ' + _laFailCap + ' 条作品都没点上,跳过这位,换下一位');
            }
          }
          if (_laSeen > 0) { saveLedger(); ctx.stepLog(2, 'running', '   ✅ 他的作品翻了 ' + (_laSeen + 1) + ' 条,这次多点了 ' + _laDone + ' 个赞'); }
        }
      }
    }
    // 兜底:无论上面循环跑了几条(哪怕 0 条),都要把这个号标成「本轮已轮到」。
    //   否则 lastEngagedAt 停在旧值/0,下轮它照样排在队首 → 队列卡住不轮转。
    lead.lastEngagedAt = Date.now();
    saveLedger();
    // 上报「本次已触达潜客」—— 这里是每个客户的必经收尾点(不管做成几个动作,一人算一次)。
    // 做成了任一动作,或者已经打开过他的作品 → 记「已互动」,以后不再排队(一辈子一次)。
    if (row.like || row.comment || row.followed || (lead.doneVideoIds && lead.doneVideoIds.length > 0)) { lead.engagedDone = 1; saveLedger(); }
    pushOrMerge(handle, row);
  
    await flushOutputs(2, true);   // 每位客户跑完就落一次,中途停止不至于全丢
    maybeTopUp(qi);
  
    if (qi < queue.length - 1) {
      var lp = beh.lead_between_leads_pause || [1000, 5000];
      var lpMs = randInt(lp[0], lp[1]);
      if (lpMs > 0) {
        ctx.stepLog(2, 'running', '⏸️ 下一位客户前等待 ' + fmtSec(lpMs / 1000));
        await sleepWithHeartbeat(2, lpMs, '下一位客户前等待');
      }
    }
  }
  
  return null;
}

// ── 分批触达 ──
var __batchCut = false;       // collectFromVideo 因「收满一批」中途停下(这条还没采完,互动完要回来接着采)
var LEAD_BATCH = beh.lead_batch_size || 500;   // 2026-10-28 用户:每收 500 位就先点赞一轮(原 1000,收满太久)
var __batchFrom = 0;          // newLeads 里还没触达的起点
var __engInit = false;
function __ensureEngageInit() {
  if (__engInit) return;
  __engInit = true;
  likeBudget = doLike ? 1000000 : 0;
  cmtBudget = doComment ? maxCommentsTotal : 0;
  followBudget = doFollow ? maxFollowsTotal : 0;
  LEAD_TOPUP_MAX = 0; topUpRounds = 0; baseQueue = []; queue = [];
  LEAD_ACTION_CAP_PER_RUN = 1;
}
// 收满一批就先去点赞。返回 true = 刚跑过一批(页面已离开,调用方要自己回到原位置)。
async function maybeEngageBatch(force) {
  var pend = newLeads.slice(__batchFrom);
  if (!pend.length || (!force && pend.length < LEAD_BATCH)) return false;
  __batchFrom = newLeads.length;
  __ensureEngageInit();
  var bq = pend.filter(function (h) { var L = ledger.leads[h]; return L && !L.engagedDone && !L.followed && !(L.lastEngagedAt > 0); });
  if (!bq.length) return false;
  ctx.stepLog(2, 'running', '📦 已收满一批 ' + bq.length + ' 位潜客 → 先去他们主页点赞,点完再回去接着收(本次累计已收 ' + newLeads.length + ' 人)');
  var r = await __engageBatch(bq);
  if (r && r.status) throw new Error('LEAD_CAPTCHA_ABORT');
  ctx.stepLog(1, 'running', '↩️ 这批点完了,回去接着收潜客');
  return true;
}
// 跑完一批回来:重新打开列表页(搜索结果 / 博主主页),找到刚才那条作品的卡片点进去(回到弹层里原来的位置),
//   这样后面还能接着「上滑下一条」。找不到就返回 false(调用方退回直接打开列表里下一条)。
async function reenterAt(entryUrl, vid) {
  if (!entryUrl || !vid) return false;
  try { await _navigate(entryUrl); } catch (_) { return false; }
  await jsleep(beh.first_screen_pause || [6000, 10000]);
  if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); throw new Error('LEAD_CAPTCHA_ABORT'); }
  var sel = 'a[href*="/video/' + vid + '"], a[href*="/photo/' + vid + '"]';
  for (var r = 0; r < 40; r++) {
    if (ctx.aborted && ctx.aborted()) return false;
    if (await rectOf(sel)) {
      if (await cdpClickSel(sel)) {
        for (var w = 0; w < 24; w++) { await ctx.sleep(250); if (videoIdOf(await getUrl()) === vid) { await holdVideo(); return true; } }
      }
      return false;
    }
    try { await _scroll(); } catch (_) {}
    await jsleep([1200, 2000]);
  }
  return false;
}

try {
  // 直播间(live 模式,或精准获客框里混填的直播间链接)先跑,再按模式翻同行/作品或搜关键词。
  if (liveRooms.length && leadMode !== 'keywords') {
    for (var lri = 0; lri < liveRooms.length && newLeads.length < maxNewLeads; lri++) {
      if (ctx.aborted && ctx.aborted()) break;
      if (await collectFromLive(liveRooms[lri], lri, liveRooms.length)) break;
      await maybeEngageBatch();
      await jsleep(beh.feed_scroll_pause || [3000, 8000]);
    }
  }
  if (leadMode === 'live') {
    // 只有直播间,上面已经跑完
  } else if (leadMode === 'accounts') {
    // 2026-10-26 用户要求:填了多个作品链接 → 先【依次】把每条作品的评论区点赞完 + 收潜客,全部做完才进 STEP2 去潜客主页点赞。
    //   潜客名额收满后,剩下的作品链接照样打开把留言点完(只是不再收人);同行主页类的种子满额后就不再翻。
    var _authorsDone = Object.create(null);
    for (var si = 0; si < seedAccounts.length && (newLeads.length < maxNewLeads || HARVEST_CMT_LIKE); si++) {
      if (ctx.aborted && ctx.aborted()) break;
      var seed = seedAccounts[si];
      if (newLeads.length >= maxNewLeads && !isShortLink(seed) && seedKind(seed) !== 'work') continue;
      // 直接给了作品链接:进这条采就完了,不用翻谁的投稿列表(用户 2026-08-23)。
      // 短链:先打开看落到哪,再决定当作品采还是当主页翻(见 resolveShortLink 的注释)。
      if (isShortLink(seed)) {
        ctx.stepLog(1, 'running', '── 短链 ' + (si + 1) + '/' + seedAccounts.length + ' · 先打开看指向哪 ──');
        var _final = await resolveShortLink(seed, 1);
        if (!_final) continue;   // 上面 resolveShortLink 已经说明原因了
        if (seedKind(_final) === 'work') {
          ctx.stepLog(1, 'running', '   ➡️ 落到一条作品,直接采它的评论区');
          seed = _final;   // 走下面「指定作品」那条路(做完再去博主主页逐条刷)
        }
        // 落到主页 —— 转成裸 id 继续走下面的老路径(翻他的作品)
        var _h2 = seedKind(_final) === 'work' ? '' : normHandle(_final);
        if (_h2) {
          ctx.stepLog(1, 'running', '   ➡️ 落到一个主页,按同行账号翻他的作品');
          seed = _h2;
          if (newLeads.length >= maxNewLeads) continue;   // 名额已满,同行主页不再翻
        }
      }
      if (seedKind(seed) === 'work') {
        // 手动指定的视频【强制重采】:那个「已收干净」标记是给「翻同行 50 条投稿」用的,
        //   免得下轮重复进同一批;而你专门粘这条链接就是想采它,评论区也会有新人。
        //   不解除的话进来就静默 return,日志上只剩一行「── 指定视频 ──」什么也没有
        //   (用户 2026-08-23 实测)。
        var _fvid = videoIdOf(seed) || String(seed);
        if (_fvid && ledger.doneVideos && ledger.doneVideos[_fvid]) {
          delete ledger.doneVideos[_fvid];
          saveLedger();
          ctx.stepLog(1, 'running', '   ♻️ 这条上轮采过,但你是手动指定的 —— 重新采一遍(评论区多半有新人了)');
        }
        ctx.stepLog(1, 'running', '── 指定视频 ' + (si + 1) + '/' + seedAccounts.length + ' ──');
        // 兜一条结论:collectFrom* 内部有好几条静默 return(异常页/评论区没渲染/导航失败),
        //   不兜的话这条视频跑完一行日志都没有,用户只看到标题然后就跳下一条了
        //   (用户 2026-08-23:「跳过也行,但是得说一下啊」)。
        var _beforeN = newLeads.length;
        await collectFromVideo(seed, '', '');
        // 这条评论太多、中途收满一批停下的:先互动这批,再重新打开这条接着采,直到采完。
        while (__batchCut && !(ctx.aborted && ctx.aborted())) {
          __batchCut = false;
          if (!(await maybeEngageBatch(true))) break;
          if (ctx.aborted && ctx.aborted()) break;
          ctx.stepLog(1, 'running', '   ↩️ 回到这条指定视频,接着采');
          await collectFromVideo(seed, '', '');
        }
        __batchCut = false;
        if (newLeads.length === _beforeN && _beforeN >= maxNewLeads) {
          ctx.stepLog(1, 'running', '   ℹ️ 潜客名额已满,这条只做了留言点赞');
        } else if (newLeads.length === _beforeN) {
          ctx.stepLog(1, 'running', '   ℹ️ 这条没采到新人 —— 评论区里的人可能都已经在名单里了,或者这条没人评论/没加载出来');
        } else {
          ctx.stepLog(1, 'running', '   ✅ 这条采到 ' + (newLeads.length - _beforeN) + ' 个新潜客');
        }
        await maybeEngageBatch();
        await jsleep(beh.feed_scroll_pause || [3000, 8000]);
        // 2026-10-26 用户要求:作品链接做完后,进这位博主的主页,从他第一条作品开始逐条点赞留言、上滑下一条(同一个人的),一直到他的作品刷完。
        var _wa = authorOfVideoUrl(seed);
        if (!_wa || _authorsDone[_wa] || beh.work_link_then_author === false) continue;
        ctx.stepLog(1, 'running', '   ➡️ 接着去博主 @' + _wa + ' 的主页,从他第一条作品开始逐条刷');
        seed = _wa;
      }
      if (_authorsDone[seedId(seed)]) continue;   // 同一位博主这次已经刷过了(多个链接是同一个人的)
      _authorsDone[seedId(seed)] = 1;
      ctx.stepLog(1, 'running', '── 同行 ' + (si + 1) + '/' + seedAccounts.length + ' · @' + (normHandle(seed) || String(seed).slice(0, 40)) + ' ──');
      try { await _navigate(seedUrl(seed, function (h) { return 'https://www.tiktok.com/@' + h; })); } catch (e) {
        ctx.stepLog(1, 'running', '   ⚠️ 打不开主页,跳过: ' + String(e && e.message || e).slice(0, 60));
        continue;
      }
      await jsleep(beh.first_screen_pause || [8000, 14000]);
      if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha' }; }
      var seedVideos = await collectVideoLinksOnPage(SEED_WORKS_CAP);
      // 只留该账号自己的作品 —— 主页偶有"相关推荐"混入别人的 /video/ 链接,凭 URL 里的 @author 过滤。
      // authorOfVideoUrl 返回裸 handle,seed 可能是整条链接 —— 拿裸的比(2026-08-22 审计)。
      var _seedId = seedId(seed);
      seedVideos = seedVideos.filter(function (u) { return authorOfVideoUrl(u) === _seedId; });
      if (seedVideos.length === 0) {
        ctx.stepLog(1, 'running', '   ⚠️ 该账号确实没有可见作品(空号),跳过');
        continue;
      }
      // 同行昵称在主页读一次就够,名下所有作品复用(省去每条作品再探一次)。
      var seedNick = '';
      try { seedNick = await readProfileNick(); } catch (_) {}
      ctx.stepLog(1, 'running', '   🎬 同行 ' + (seedNick || '(昵称未取到)') + ' @' + seed
        + ' 拿到 ' + seedVideos.length + ' 条作品,逐条开评论区收潜客');
      await swipeHarvest(seedVideos, '', seedNick, _seedId, 0, 'https://www.tiktok.com/@' + _seedId);
    }
  } else {
    var kws = shuffle(keywordsList);
    for (var ki = 0; ki < kws.length && (newLeads.length < maxNewLeads || HARVEST_CMT_LIKE); ki++) {
      if (ctx.aborted && ctx.aborted()) break;
      var kw = kws[ki];
      pickedKeyword = kw;   // 供 tryComment 组 prompt 用(写评论时的语境)
      ctx.stepLog(1, 'running', '── 关键词 ' + (ki + 1) + '/' + kws.length + ' · "' + kw + '" ──');
      try { await _navigate('https://www.tiktok.com/search/video?q=' + encodeURIComponent(kw)); } catch (e) {
        ctx.stepLog(1, 'running', '   ⚠️ 搜索打不开,换下一个词: ' + String(e && e.message || e).slice(0, 60));
        continue;
      }
      await jsleep(beh.first_screen_pause || [8000, 14000]);
      if (!(await captchaGate(1))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha' }; }
      var kwVideos = await collectVideoLinksOnPage(12);
      if (kwVideos.length === 0) { ctx.stepLog(1, 'running', '   ⚠️ 这个词搜不到视频,换下一个'); continue; }
      ctx.stepLog(1, 'running', '   🎬 拿到 ' + kwVideos.length + ' 条视频,逐条开评论区收潜客');
      await swipeHarvest(kwVideos, kw, '', '', 0, 'https://www.tiktok.com/search/video?q=' + encodeURIComponent(kw));
    }
  }
} catch (e) {
  if (String(e && e.message) === 'LEAD_CAPTCHA_ABORT') return { status: 'failed', reason: 'captcha' };
  throw e;
}

// 所有词都收不到新增了 → 解除本轮跳过的那些「已收干净」标记(用户 2026-08-22 定的退路)。
//   否则一旦所有作品都被标记过,这个号就再也采不到人了 —— 标记本意是省时间,不是封死。
if (newLeads.length === 0 && harvestedSkippedThisRun.length > 0) {
  var _released = 0;
  for (var _hi = 0; _hi < harvestedSkippedThisRun.length; _hi++) {
    var _hv = harvestedSkippedThisRun[_hi];
    if (ledger.doneVideos && ledger.doneVideos[_hv]) { delete ledger.doneVideos[_hv]; _released++; }
  }
  if (_released > 0) {
    saveLedger();
    ctx.stepLog(1, 'running', '   ♻️ 这轮所有关键词都没收到新人,已解除 ' + _released
      + ' 条「已收干净」标记,下轮这些作品会重新进(那时评论区多半有新评论了)');
  }
} else if (harvestedSkippedThisRun.length > 0) {
  ctx.stepLog(1, 'running', '   ⏭️ 跳过 ' + harvestedSkippedThisRun.length + ' 条上轮已收干净的作品(省掉重复翻评论区)');
}

var totalAfterCollect = ledgerSize();
ctx.stepLog(1, 'done',
  '📇 采集完成:看了 ' + collectStats.videosVisited + ' 条作品 · 见到评论者 ' + collectStats.commentersSeen + ' 人次'
  + ' · 本次新增潜客 ' + newLeads.length + ' 人 · 本地累计 ' + totalAfterCollect + ' 人(这些都是同行的潜在客户)'
  + (HARVEST_CMT_LIKE ? ' · 评论区留言点赞 ' + cmtLikeStats.like + ' 个(之前已赞 ' + cmtLikeStats.already + (cmtLikeStats.failed ? ' · 失败 ' + cmtLikeStats.failed : '') + ')' : ''));
await flushOutputs(1, true);   // 采集完先落一次:STEP2 中途被停也留得住这批新潜客
ctx.stepDone(1);

// ════════════════════════════════════════════════════════════════════
// STEP 2 · 触达互动(新旧客轮转:上次互动最久的优先,新客天然排最前)
// ════════════════════════════════════════════════════════════════════

ctx.stepStart(2);

var allHandles = [];
for (var lk in ledger.leads) allHandles.push(lk);
allHandles.sort(function (a, b) { return (ledger.leads[a].lastEngagedAt || 0) - (ledger.leads[b].lastEngagedAt || 0); });

// ⚠️ 不能纯按 lastEngagedAt 升序切前 N —— 新客的 lastEngagedAt 恒为 0、永远排在最前,
//   当「单次新增名额」>=「单次触达人数」时(默认 20/20)整批名额都被本轮新客吃光,
//   老客一次都轮不到,用户要的「第二次跑对同一个人的其他作品互动、形成长期互动」
//   永远不会发生(2026-08-16 模拟 8 轮:累计 160 人、老客复访 0 人次)。
//   因此给老客保底一半名额:两边各取一半,某一边不够时由另一边补满,不浪费名额。
var LEAD_EXHAUSTED_COOLDOWN_MS = 7 * 24 * 3600 * 1000;   // 作品耗尽的老客冷却 7 天(2026-10-12 用户定)
var exhaustedSkipped = 0;
var engagedOnceSkipped = 0;   // 已互动过、不再排队的人数(只打日志)
var freshQ = [], oldQ = [];
for (var qh = 0; qh < allHandles.length; qh++) {
  // 连续两轮都「用户不存在」的号(注销/封禁/改 id):留在名单里存档,但不再占名额。
  if ((ledger.leads[allHandles[qh]].gone || 0) >= 2) continue;
  // 每个潜客【一辈子只互动一次】(2026-10-13 用户定):互动过(engagedDone,或旧账本里已经
  //   互动过作品 doneVideoIds 非空)的人不再排队,名额全部留给没互动过的人。
  var _ldq = ledger.leads[allHandles[qh]];
  //   关注过(followed)也算互动过 —— 否则只做过关注的人(旧名单里没作品时关注的、或者只开了
  //   关注的任务)每轮还会被拉出来开主页、什么都不做(2026-10-13 审计)。
  if (_ldq.engagedDone || _ldq.followed || (_ldq.doneVideoIds && _ldq.doneVideoIds.length > 0)) { engagedOnceSkipped++; continue; }
  // 作品已全部互动过(或确认没作品)的老客:冷却期内不排队,名额让给新客和还有新作品的老客。
  //   以前照样每轮排进来 → 开主页、等加载、翻列表,最后「没有新作品」跳过,白耗 30-60 秒
  //   还占一个触达名额;名单越老这种人越多(用户 2026-10-12 反馈「只有 1-2 个作品就跳过」)。
  //   冷却期过了再放回来看一眼有没有发新作品,有就恢复正常轮转(见循环里 exhaustedAt 的维护)。
  var _ex = ledger.leads[allHandles[qh]].exhaustedAt || 0;
  if (_ex && Date.now() - _ex < LEAD_EXHAUSTED_COOLDOWN_MS) { exhaustedSkipped++; continue; }
  if ((ledger.leads[allHandles[qh]].lastEngagedAt || 0) === 0) freshQ.push(allHandles[qh]);
  else oldQ.push(allHandles[qh]);   // 已按「最久没互动」在前排好
}
// 排队规则(用户 2026-08-21 定):【新客优先,按获得时间正序】—— 本次刚采到的先互动,
//   趁热打铁;新客排完再接老客(按最久没互动在前),名额没用完就一直往后排。
// ⚠️ 必须【降序】(最近采到的在前):「新客」= 从未互动过的人,里面既有本轮刚采的,
//   也有前几轮采了但没轮到的(它们 addedAt 更早)。升序会让陈年积压的排最前,
//   用户要的「优先和本次获得的互动」就落空了(2026-08-21 实测:上来先跑旧潜客)。
freshQ.sort(function (a, b) { return (ledger.leads[b].addedAt || 0) - (ledger.leads[a].addedAt || 0); });
// 2026-10-26 用户定:只互动【本次采集到】的潜客,采到多少互动多少;没采到就不碰上次名单里的老潜客。
var _thisRun = {};
for (var nr = 0; nr < newLeads.length; nr++) _thisRun[newLeads[nr]] = 1;
var queue = freshQ.filter(function (h) { return _thisRun[h]; });   // 中途分批点过的人 lastEngagedAt 已>0,不在 freshQ 里
if (!queue.length) {
  ctx.stepLog(2, 'running', newLeads.length
    ? '✅ 这次收到的 ' + newLeads.length + ' 位潜客都已经分批点过了'
    : '⏹️ 本次没有采集到新的潜在客户 —— 不互动上次名单里的潜客,本次结束');
}
if (engagedOnceSkipped > 0) {
  ctx.stepLog(2, 'running', '   ℹ️ 名单里 ' + engagedOnceSkipped + ' 位已经互动过,不再重复互动');
}
if (exhaustedSkipped > 0) {
  ctx.stepLog(2, 'running', '   ℹ️ ' + exhaustedSkipped + ' 位老客的作品都互动过了,本次先不排(' + Math.round(LEAD_EXHAUSTED_COOLDOWN_MS / 86400000) + ' 天后再看有没有新作品)');
}
// 补跑用:baseQueue 是本轮的原始名单(queue 会在补跑时被追加,不能直接拿它当模板)。
//   likeBudget/cmtBudget = 本轮总额度(人数 x 每人条数),补跑就是为了把它们跑满。
var baseQueue = queue.slice();
var topUpRounds = 0;
// 2026-10-12 用户反馈:一个潜客有多条作品时,也只互动一次(点赞/评论/关注各最多 1 次),
//   不要一条条点过去。补跑会把同一个人再排一遍、换下一条作品再点一次 → 关掉(0 轮)。
//   额度没用满就留到下次运行(那时这个人才会换一条新作品互动)。
var LEAD_TOPUP_MAX = 0;

// 总量口径:优先保证【互动人数】,再把点赞/评论总量摊到实际触达的人头上。
//   例:互动 100 人、点赞总量 200 → 每人 ceil(200/100)=2 条;点赞总量 50、100 人 → 每人 1 条。
// 2026-10-26 用户定:点赞不再看设了多少 —— STEP2 每位潜客都点他一条作品的赞(没作品的除外)。
var likeBudget = doLike ? 1000000 : 0;
var cmtBudget = doComment ? maxCommentsTotal : 0;
var reach = Math.max(1, queue.length);
// 🚨 每人每轮硬上限:reach 是【实际队列长度】,首次运行/账本只有两三个人时
//   ceil(500/2)=250 —— 会对同一个人连开 250 条作品连点 250 个赞,必被风控。
//   改口径前 likesPerLead 就是 clampInt(...,1,10),这个保护必须留着;
//   摊不完的额度交给补跑轮(maybeTopUp)慢慢消化,而不是一次性砸在一个人头上。
// 2026-10-12 起每人每轮【只开 1 条作品】:点赞、评论都落在这一条上,各最多 1 次;关注终身 1 次。
//   (原来是 10 —— 总量摊到人头后一个人可能被连点好几条作品,用户反馈像刷屏。)
var LEAD_ACTION_CAP_PER_RUN = 1;
var followBudget = doFollow ? maxFollowsTotal : 0;
// 每人只做 1 个动作(2026-10-19):按剩余额度比例挑 —— 哪样剩得多(相对自己的总量)做哪样;一样多时 评论 > 关注 > 点赞。
//   canVideo=false(拿不到作品)时只剩关注可选。返回 'like' | 'comment' | 'follow' | null(都用完了)。
function pickLeadAction(ld, canVideo) {
  var opts = [];
  if (canVideo && cmtBudget > done.comment) opts.push(['comment', (cmtBudget - done.comment) / cmtBudget, 0]);
  if (followBudget > done.follow && !(ld && ld.followed)) opts.push(['follow', (followBudget - done.follow) / followBudget, 1]);
  if (canVideo && likeBudget > done.like) opts.push(['like', (likeBudget - done.like) / likeBudget, 2]);
  if (!opts.length) return null;
  opts.sort(function (x, y) { return (y[1] - x[1]) || (x[2] - y[2]); });
  return opts[0][0];
}
if (typeof ctx.setActionTargets === 'function') {
  // 关注是【终身一次】:队列里已关注过的人这轮不会再产生 follow,拿 followBudget 当分母
  //   会让老账本的进度条永远停在 0%。分母取「队列里还没关注过的人数」才追得平。
  var followableCnt = 0;
  for (var fq = 0; fq < queue.length; fq++) {
    var fl = ledger.leads[queue[fq]];
    if (fl && !fl.followed) followableCnt++;
  }
  ctx.setActionTargets({
    // 每人最多 1 赞 1 评 → 本轮能做到的上限就是排上的人数;用总量当分母进度条永远跑不满。
    like: doLike ? queue.length : 0, follow: Math.min(followBudget, followableCnt), comment: Math.min(cmtBudget, queue.length),
    // 采集已结束:潜客数的分母仍是上限(采不满是常态,要看得出来);触达的分母收窄成本轮
    //   真正排上的人数(= min(账本人数, leads_per_run)),账本人少时不会永远差一截。
    lead_new: LEAD_UNLIMITED ? newLeads.length : maxNewLeads,
    lead_engaged: queue.length,
  });
}

// 记一位已触达的潜客。⚠️ 补跑轮会把同一个人再排一遍(甚至走的是「无新作品」那条 continue),
//   所以每一个出口都必须经过这里按 handle 去重:否则「互动潜客数」会把同一个人数好几次,
//   互动账本里也会出现同名多行,而且跟详情页的 🤝 卡对不上。
//   再次轮到时把这一趟的动作数并进上一行,账本里仍是一人一行、数字是全轮合计。
//   skipped=true(主页打不开 / 用户不存在 / 频控):仍然进报告(要看到发生过、以及 note
//   写的原因),但【不计入触达数】—— 一个动作都没做却算触达,分母加上之后会显示成
//   「触达 20/20」而实际一个赞都没点。
function pushOrMerge(h, r, skipped) {
  if (!engagedSeen[h]) {
    engagedSeen[h] = r;
    if (!skipped && typeof ctx.addActionCount === 'function') ctx.addActionCount('lead_engaged', 1);
    engagedLog.push(r);
    if (skipped) skippedSeen[h] = 1;
    return;
  }
  // 先前被记成 skipped 的,这次真做了动作 → 补记一次触达。
  if (!skipped && skippedSeen[h]) {
    delete skippedSeen[h];
    if (typeof ctx.addActionCount === 'function') ctx.addActionCount('lead_engaged', 1);
  }
  var prevRow = engagedSeen[h];
  prevRow.like += r.like || 0;
  prevRow.comment += r.comment || 0;
  if (r.followed) prevRow.followed = 1;
  if (r.note && !prevRow.note) prevRow.note = r.note;
}
// 补跑(用户 2026-08-21 定):本轮所有潜客都跑完后,若点赞/评论额度还没用满,把潜客再排一遍
//   继续跑,直到额度跑满或没人还有没互动过的作品。doneVideoIds 每互动一条就更新,所以再排到
//   同一个人时会自然换新作品,不会重复互动同一条。topUpRounds 封顶防止无限循环。
//   ⚠️ 必须在循环体的【每一个出口】都调用 —— 队列最后一位若走 continue(主页打不开 / 无新
//   作品,补跑轮里后者还是常态),补跑就永远不触发,剩下的额度白白浪费。
function maybeTopUp(qi) {
  if (qi !== queue.length - 1 || topUpRounds >= LEAD_TOPUP_MAX) return;
    var needLike = doLike && done.like < likeBudget;
    var needCmt = doComment && done.comment < cmtBudget;
    if (needLike || needCmt) {
      topUpRounds++;
      var refill = [];
      for (var rq = 0; rq < baseQueue.length; rq++) refill.push(baseQueue[rq]);
      if (refill.length) {
        ctx.stepLog(2, 'running',
          '🔁 额度还没跑满(👍 ' + done.like + '/' + likeBudget + ' · 💬 ' + done.comment + '/' + cmtBudget
          + '),再排一轮继续跑(第 ' + topUpRounds + ' 轮补跑,会自动换没互动过的作品)');
        for (var rf = 0; rf < refill.length; rf++) queue.push(refill[rf]);
      }
    }
}

ctx.stepLog(2, 'running',
  '🚀 开始触达:本次安排 ' + queue.length + ' 人(账本共 ' + totalAfterCollect + ' 人,轮不到的下次接着)'
  + ' · 本次总量 👍' + (doLike ? '每人 1 个(不限量)' : '0') + ' / 💬' + cmtBudget + (doFollow ? ' / ➕' + followBudget : '')
  + '(每人:有额度就关注 + 点他第一条作品 + 有额度就评论)');

var __eb = await __engageBatch(queue);
if (__eb && __eb.status) return __eb;

// ════════════════════════════════════════════════════════════════════
// STEP 2b · 评论区点赞补量(2026-10-21 用户定)
//   触达跑完后,点赞额度还没用满 → 回到潜客当初留言的那条作品(lead.srcVideo),
//   在评论区给【名单里这些潜客自己的留言】点赞,补足点赞数。
//   ⚠️ 两种点赞分开记账:
//     - lead.likedCount  = 点过他主页作品的赞(触达阶段)
//     - lead.cmtLikedAt  = 在评论区点过他留言的赞(本段;每人最多一次)
//   前者做过、后者照样可以做;后者做过就不再做。直播间来的潜客没有留言可点,跳过。
//   计费同普通点赞(chargeIfPossible('like_lite'))。
// ════════════════════════════════════════════════════════════════════
var CMT_LIKE_MAX_WORKS = 12;     // 一次最多回访几条来源作品
var CMT_LIKE_MAX_SCROLLS = 8;    // 每条作品评论区最多往下翻几屏找人(列表是虚拟化的,每屏都要重新找)
done.cmtLike = 0;

// 在当前评论区里找【目标潜客】的留言,给它的点赞控件打标记(data-nc-cl=序号)。
//   DOM(2026-10-21 真机实测 /@kallaway.marketing/video/7683509820132969759):
//   每条评论 = [data-e2e^="comment-level"] 往上找到带 a[href^="/@"] 的容器(同 harvestCommentHandles);
//   容器里 div[role=button][aria-pressed] 就是这条评论的点赞(aria-label="Like video\n31 likes"),
//   aria-pressed 直接给出是否已赞。楼中楼的回复自己也有 comment-level,各认各的。
async function findLeadCommentLikes(handles) {
  var want = {};
  for (var i = 0; i < handles.length; i++) want[String(handles[i]).toLowerCase()] = 1;
  var arr = await tkCdp('(function(){var want=' + JSON.stringify(want) + ';var out=[];var seen=[];'
    + 'var items=document.querySelectorAll(\'[data-e2e^="comment-level"]\');'
    + 'for(var i=0;i<items.length;i++){var p=items[i];'
    + 'for(var k=0;k<6&&p;k++){if(p.querySelector&&p.querySelector(\'a[href^="/@"]\'))break;p=p.parentElement;}'
    + 'if(!p||!p.querySelector||seen.indexOf(p)>=0)continue;seen.push(p);'
    + 'var a=p.querySelector(\'a[href^="/@"]\');if(!a)continue;'
    + 'var h=(a.getAttribute("href")||"").replace(/^\\/@/,"").replace(/[\\/?#].*$/,"").toLowerCase();'
    + 'if(!h||!want[h])continue;'
    + 'var b=p.querySelector(\'div[role="button"][aria-pressed]\');if(!b)continue;'
    + 'b.setAttribute("data-nc-cl",String(i));'
    + 'out.push({h:h,i:i,ap:b.getAttribute("aria-pressed")});}'
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
    + 'if(!p)continue;var a=ncA(p);if(!a)continue;if(ncH(a)!==H)continue;'
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
async function likeOneLeadComment(t) {
  if (t.ap === 'true') return { ok: false, already: true };
  return await clickAndVerifyCmtLike('[data-nc-cl="' + t.i + '"]', t.h, '', beh.cmt_like_verify_pause);
}

// 2026-10-27 用户定:主页点赞跑完后,点赞数还不到任务设的点赞数(max_likes)→ 回到【这次】潜客留言的那些作品,
//   在评论区给他们的留言补点赞,补到够为止。点前按账号重新定位留言(likeCmtByKey,防虚拟列表回收点错)。
var CMT_TOPUP_ENABLED = beh.cmt_topup !== false;
var LIKE_TARGET = doLike ? maxLikesTotal : 0;
if (CMT_TOPUP_ENABLED && LIKE_TARGET > 0 && done.like < LIKE_TARGET && !(ctx.aborted && ctx.aborted())) {
  // 按来源作品把还没在评论区点过赞的潜客分组;最近收进来的作品排前面。
  var cwMap = {}, cwOrder = [];
  for (var ch in ledger.leads) {
    var cL = ledger.leads[ch];
    if (!cL || cL.cmtLikedAt || cL.srcLive || !_thisRun[ch]) continue;   // 只补这次捞到的人
    var cvid = videoIdOf(cL.srcVideo);
    if (!cvid) continue;
    if (!cwMap[cvid]) { cwMap[cvid] = { url: cL.srcVideo, hs: [], latest: 0 }; cwOrder.push(cvid); }
    cwMap[cvid].hs.push(ch);
    if ((cL.addedAt || 0) > cwMap[cvid].latest) cwMap[cvid].latest = cL.addedAt || 0;
  }
  cwOrder.sort(function (a, b) { return cwMap[b].latest - cwMap[a].latest; });
  if (cwOrder.length) {
    if (typeof ctx.setActionTargets === 'function') ctx.setActionTargets({ like: LIKE_TARGET });
    ctx.stepLog(2, 'running', '💗 点赞额度还差 ' + (LIKE_TARGET - done.like) + ' 个 —— 回到潜客留言的作品,在评论区给他们的留言点赞(共 ' + cwOrder.length + ' 条作品)');
    for (var cw = 0; cw < cwOrder.length; cw++) {
      if (done.like >= LIKE_TARGET || (ctx.aborted && ctx.aborted())) break;
      var W = cwMap[cwOrder[cw]];
      ctx.stepLog(2, 'running', '── 评论区点赞 ' + (cw + 1) + '/' + cwOrder.length + ' · ' + String(W.url).slice(0, 70) + ' · 这条下有 ' + W.hs.length + ' 位潜客');
      var wOk = true;
      try { await _navigate(W.url); } catch (e) { wOk = false; }
      if (!wOk) { ctx.stepLog(2, 'running', '   ⚠️ 作品打不开,换下一条'); continue; }
      await waitReady('video', 10000);
      if (!(await captchaGate(2))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', engaged: engagedLog }; }
      if (!(await ensureCommentsOpen())) { ctx.stepLog(2, 'running', '   ⏭️ 评论区没打开,换下一条'); continue; }
      await holdVideo();
      var pending = {};
      for (var ph = 0; ph < W.hs.length; ph++) pending[W.hs[ph]] = 1;
      for (var sc = 0; sc <= (beh.cmt_topup_max_screens || 300); sc++) {
        if (done.like >= LIKE_TARGET || (ctx.aborted && ctx.aborted())) break;
        var left = Object.keys(pending);
        if (!left.length) break;
        if (await driftedFrom(W.url)) {
          // 视频被自动滑到下一条了:切回原作品(只切一次,不行就换下一条)。
          if (W.drifted) { ctx.stepLog(2, 'running', '   ⏭️ 作品反复被自动滑走,换下一条'); break; }
          W.drifted = 1;
          ctx.stepLog(2, 'running', '   ↩️ 视频被自动滑到下一条了,切回原作品');
          try { await _navigate(W.url); } catch (_) { break; }
          await waitWithHold(beh.watch_open_pause || [5000, 10000]);
          if (!(await captchaGate(2))) { ctx.finish('error', 'captcha'); return { status: 'failed', reason: 'captcha', engaged: engagedLog }; }
          if (!(await ensureCommentsOpen())) break;
          await holdVideo();
        }
        var tg = await scanCommentLikes();
        for (var ti = 0; ti < tg.length; ti++) {
          if (done.like >= LIKE_TARGET) break;
          var T = tg[ti];
          if (!pending[T.h]) continue;
          delete pending[T.h];
          var TL = ledger.leads[T.h];
          if (!TL) continue;
          var cr = (T.ap === 'true') ? { already: true } : await likeCmtByKey(T.h, T.t, beh.harvest_cmt_verify_pause || [150, 250]);
          if (cr.gone) { pending[T.h] = 1; continue; }
          var nick = (TL.nickname || '').trim();
          if (cr.already) {
            TL.cmtLikedAt = Date.now(); saveLedger();
            ctx.stepLog(2, 'running', '   ⏭️ ' + (nick || '@' + T.h) + ' 的留言之前已经赞过');
            continue;
          }
          if (cr.ok) {
            TL.cmtLikedAt = Date.now(); saveLedger();
            done.like++; done.cmtLike++;
            if (typeof ctx.addActionCount === 'function') ctx.addActionCount('like', 1);
            await chargeIfPossible('like_lite');
            pushOrMerge(T.h, { handle: T.h, nickname: nick, isNew: false, like: 1, comment: 0, followed: 0, note: '评论区点赞' });
            ctx.stepLog(2, 'running', '   💗 已给 ' + (nick || '@' + T.h) + ' 的留言点赞(👍 ' + done.like + '/' + LIKE_TARGET + ')');
            await jsleep(beh.harvest_cmt_like_pause || [500, 1500]);
          } else {
            ctx.stepLog(2, 'warn', '   ⚠️ ' + (nick || '@' + T.h) + ' 的留言点赞没成功: ' + (cr.msg || ''));
          }
        }
        if (!Object.keys(pending).length) break;
        if (!(await scrollCommentPanel())) break;
        await jsleep([1200, 2200]);
      }
      await flushOutputs(2, true);
      if (cw < cwOrder.length - 1 && done.like < LIKE_TARGET) await jsleep([1000, 2000]);
    }
    ctx.stepLog(2, 'running', '💗 评论区点赞补量结束:本次在评论区点赞 ' + done.cmtLike + ' 个');
  }
}

ctx.stepLog(2, 'done',
  '本轮触达完成:' + engagedLog.length + ' 人 · 👍 ' + done.like + (done.cmtLike ? '(含评论区 ' + done.cmtLike + ')' : '') + ' / ➕ ' + done.follow + ' / 💬 ' + done.comment
  + (done.skipped ? ' / 跳过 ' + done.skipped : ''));
ctx.stepDone(2);

// ════════════════════════════════════════════════════════════════════
// STEP 3 · 名单落盘(txt 长期累积)+ 本次运行报告
// ════════════════════════════════════════════════════════════════════

ctx.stepStart(3);

// 名单 + 运行报告落盘。用户 2026-08-22:原来只在 STEP3 末尾写一次,中途停止就什么都没有。
//   现在采集结束、每触达完一位、正常收尾各调一次 —— 中断后磁盘上就是截至上一位客户的内容。
//   账本(lead_ledger.json)本来就每个动作都落,这里补的是【人能看的那两个文件】。
//   quiet=true 时不打日志(中途落盘不刷屏);stepNo 让中途调用把日志挂在当前步。
//   ⚠️ 函数声明会完整提升,所以定义在这儿、STEP1 就能调。
async function flushOutputs(stepNo, quiet) {
  try {
  var now = new Date();
  function fmtDate(ts) {
    if (!ts) return '-';
    var d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }
  var stamp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0') + '-' + String(now.getDate()).padStart(2, '0')
    + ' ' + String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');

  // ① 全量名单 txt — 固定文件名,每次全量重写 = 持续增长的长期名单。
  finalTotal = ledgerSize();   // 外层收尾日志/返回值也要用,别在这儿 var(会变成局部)
  var txt = '# TikTok 同行的潜在客户名单(长期累积)\n'
    + '# 更新时间: ' + stamp + ' · 累计 ' + finalTotal + ' 人(本次新增 ' + newLeads.length + ' 人)\n'
    + '# 每位潜客一段。「潜客来源」= 他是在谁的作品评论区里被发现的。\n\n';
  var sortedForTxt = [];
  for (var tk2 in ledger.leads) sortedForTxt.push(tk2);
  sortedForTxt.sort(function (a, b) { return (ledger.leads[a].addedAt || 0) - (ledger.leads[b].addedAt || 0); });
  for (var ti = 0; ti < sortedForTxt.length; ti++) {
    var th = sortedForTxt[ti], tl = ledger.leads[th];
    // 名单三件套:昵称 | 账号 | 主页链接 —— 用户要求都带上,方便逐个核对(2026-08-20)。
    txt += '【' + (ti + 1) + '】 ' + ((tl.nickname || '').trim() || '(昵称未取到)') + '\n'
      + '    账号: @' + th + '\n'
      + '    主页: https://www.tiktok.com/@' + th + '\n'
      + '    获得时间: ' + fmtDateTime(tl.addedAt) + '\n'
      + '    潜客来源: ' + sourceLine(tl) + '\n'
      + '    互动账本: 累计 👍' + (tl.likedCount || 0) + ' / 💬' + (tl.commentedCount || 0)
        + ' · ' + (tl.followed ? '已关注' : '未关注')
        + ' · 最近互动 ' + (tl.lastEngagedAt ? fmtDateTime(tl.lastEngagedAt) : '尚未互动')
        + idleReason(tl) + '\n\n';
  }

  var txtPath = '';
  if (typeof ctx.writeReport === 'function') {
    // 名单写在【任务目录】—— 跟运行报告放一起,详情页「打开输出文件夹」才找得到它。
    //   累计去重的真正载体是 state/lead_ledger.json(账号级),这个 txt 只是它的可读快照,
    //   每轮全量重写,所以多个任务各留一份也永远是最新的,不会互相矛盾。
    var wTxt = await ctx.writeReport('TikTok潜在客户名单.txt', txt);
    if (wTxt && wTxt.ok) { txtPath = wTxt.path; if (!quiet) ctx.stepLog(stepNo, 'running', '📇 潜在客户名单已更新 → ' + wTxt.path); }
    else if (!quiet) ctx.stepLog(stepNo, 'warn', '名单保存失败: ' + ((wTxt && wTxt.reason) || '未知'));
  }

  // ② 本次运行报告 md
  var md = '# TikTok 定向获客报告 · ' + stamp + '\n\n'
    + '## 📇 同行的潜在客户\n\n'
    + '- 本地累计:**' + finalTotal + ' 人**\n'
    + '- 本次新增:**' + newLeads.length + ' 人**' + (newLeads.length ? '(' + newLeads.slice(0, 20).map(function (h) { return '@' + h; }).join('、') + (newLeads.length > 20 ? ' …' : '') + ')' : '') + '\n'
    + '- 名单文件:' + (txtPath || '(未保存)') + '\n\n'
    + '## 🤝 本次触达(' + engagedLog.length + ' 人 · 👍' + done.like + (done.cmtLike ? '(含评论区点赞 ' + done.cmtLike + ')' : '') + ' ➕' + done.follow + ' 💬' + done.comment + ')\n\n';
  if (engagedLog.length === 0) md += '_无_\n';
  else for (var ei = 0; ei < engagedLog.length; ei++) {
    var E = engagedLog[ei];
    md += (ei + 1) + '. ' + (E.nickname ? '**' + E.nickname + '** ' : '') + '@' + E.handle
      + '(' + (E.isNew ? '潜在新客' : '老客') + ')'
      + ' — 👍×' + E.like + ' 💬×' + E.comment + (E.followed ? ' ➕已关注' : '')
      + (E.note ? ' · ' + E.note : '') + '\n';
  }
  md += '\n---\n\n*由 NoobClaw TikTok 定向获客任务生成*\n';

  if (typeof ctx.writeReport === 'function') {
    var wMd = await ctx.writeReport('TikTok定向获客-' + RUN_STAMP + '.md', md);
    if (wMd && wMd.ok) if (!quiet) ctx.stepLog(stepNo, 'running', '✅ 运行报告已保存 → ' + wMd.path);
  }

  } catch (_flushErr) {
    // 落盘失败不能把整个任务带走(中途调用尤其如此)。
    if (!quiet) ctx.stepLog(stepNo, 'warn', '名单/报告落盘失败: ' + String(_flushErr && _flushErr.message || _flushErr).slice(0, 80));
  }
}

await flushOutputs(3, false);

ctx.stepLog(3, 'done',
  '📇 同行的潜在客户:本地累计 ' + finalTotal + ' 人 · 本次新增 ' + newLeads.length + ' 人'
  + ' · 本次互动 ' + (done.like + done.follow + done.comment) + ' 次(触达 ' + engagedLog.length + ' 人,名单见 txt)');
ctx.stepDone(3);

ctx.finish('done');
return {
  status: 'ok',
  leads_total: finalTotal, leads_new: newLeads.length,
  action_count: done, engaged: engagedLog.length,
};

// ── 主页关注(私密号/无作品专用;作品页仍走 tryFollow 的 feed-follow) ──
// 主页按钮是 [data-e2e="follow-button"];已关注态文案 Following/Friends/已关注/互相关注 → 跳过防误取关。
async function tryFollowOnProfile() {
  var sel = '[data-e2e="follow-button"], [data-e2e="feed-follow"]';
  var txtNow = await getText(sel);
  if (!txtNow) return { ok: false, warn: true, msg: '⚠️ 主页没找到关注按钮' };
  if (/following|friends|已关注|互相关注|相互关注|回关/i.test(txtNow)) {
    return { ok: false, skip: true, msg: '⏭️ 已是关注状态(' + txtNow.slice(0, 12) + ')' };
  }
  try { await nativeClick(sel); } catch (e) {
    return { ok: false, warn: true, msg: '⚠️ 关注 click 失败: ' + String(e && e.message || e).slice(0, 50) };
  }
  await jsleep([1500, 3000]);
  var after = await getText(sel);
  if (/following|friends|已关注|互相关注|相互关注/i.test(after || '')) return { ok: true, msg: '➕ 关注成功' };
  return { ok: true, msg: '➕ 关注已点击' };
}
// ════════════════════════════════════════════════════════════════════
// 互动子函数 — 通过 main_world_click 派发 trusted click
// ════════════════════════════════════════════════════════════════════

// 一次 cdp_eval 把「控件在不在 / 什么状态」全查回来:
//   found — like-icon 存不存在。以前选择器空命中被 getAttr 抹成 undefined、误报成
//           "没找到点赞按钮",实际是选择器写错了,得把这两种情况分开报。
//   ap    — aria-pressed。真机实测就挂在图标自己身上,所以先读自身、再往上找带该属性的祖先。
//   red   — 心形是否已变红(未赞 rgb(22,24,35) 或白,已赞 rgb(254,44,85),svg fill=currentColor)。
// ⚠️ 判定顺序必须 ap 优先、颜色只当兜底:2026-08-16 真机实测点击后 2.5s,aria-pressed 已经
//    翻成 true,但 svg 颜色还停在未赞色(过一会儿才变红)。反过来先看颜色会把刚点成功的判成失败。
// 2026-10-26:页面里常同时有好几个点赞按钮(从主页点开的弹层 browse-like-icon + 背后/旁边隐藏的 like-icon、
//   上一条残留的)。以前 querySelector 只拿第一个 → 读到别的作品「已赞」就误跳过、点到 0 尺寸的隐藏按钮就点空。
//   现在只认【屏幕内可见】的,优先弹层里的 browse-like-icon,其次离屏幕中心最近的;选中的打上 data-nc-like。
// 2026-10-27 用户内核实报:诊断显示 browse-like-icon=32x32 可见、外层按钮「10 赞」也在,但 likeProbe 一直判没找到;
//   同一页面在用户 Chrome 里跑这段查询完全正常。说明这段查询在内核里【抛错】了 —— 原来异常被 CDP 吞掉、tkCdp 返回 null,
//   日志看不出原因。现在:① 查询包 try/catch,把异常原文带回来写进诊断;② 加一个极简找法 spick(只认屏幕内可见的
//   browse-like-icon / like-icon,不打分、不用正则),主查询异常或没找到时用它 —— 主查询坏了也照样点得到。
function __likeProbeExpr(pickJs, fnName) {
  return '(function(){try{' + pickJs
    + 'var icon=' + fnName + '();'
    + 'if(!icon)return {ok:true,value:{found:false}};'
    + 'var host=icon.hasAttribute("aria-pressed")?icon:(icon.closest("[aria-pressed]")||icon.closest("button")||icon.parentElement);'
    + 'var ap=host?host.getAttribute("aria-pressed"):null;'
    + 'var svg=icon.querySelector("svg")||icon;'
    + 'var c="";try{c=getComputedStyle(svg).color||"";}catch(e){}'
    + 'var m=c.match(/(\\d+),\\s*(\\d+),\\s*(\\d+)/);'
    + 'return {ok:true,value:{found:true,tag:icon.tagName,role:icon.getAttribute("role")||"",'
    + 'ap:ap,color:c,red:m?(+m[1]>200&&+m[2]<120):null}};'
    + '}catch(e){return {ok:true,value:{err:String(e&&e.message||e).slice(0,120)}};}})()';
}
async function likeProbe() {
  var v = await tkCdp(__likeProbeExpr(PICK_LIKE_JS, 'pick'), null);
  if (v && v.found === true) return v;
  var sp = await tkCdp(__likeProbeExpr(SIMPLE_PICK_JS, 'spick'), null);
  __likeProbeErr = (v && v.err) ? ('主查询异常: ' + v.err) : (!v ? '主查询无返回' : '');
  if (sp && sp.err) __likeProbeErr += (__likeProbeErr ? ' / ' : '') + '极简查询异常: ' + sp.err;
  else if (!sp) __likeProbeErr += (__likeProbeErr ? ' / ' : '') + '极简查询无返回';
  if (sp && sp.found === true) { sp.simple = true; return sp; }
  if (v && !v.err) return v;            // 正常执行、确实没找到
  if (sp && !sp.err) return sp;
  return { found: false, err: __likeProbeErr || 'unknown' };
}

// 作品数据有没有加载出来:点赞数文字 / 评论条目 任一出现即算已加载。
//   2026-10-27 用户内核截图:框架出来了,但心形旁没有赞数、评论区一直是灰色骨架 —— TikTok 没给这个号返回作品数据,
//   这时点赞按钮是空壳,怎么等都点不了。
async function workDataLoaded() {
  return await tkCdp('(function(){var c=document.querySelector(\'[data-e2e="browse-like-count"],[data-e2e="like-count"]\');'
    + 'var hasCnt=!!(c&&(c.textContent||"").trim());'
    + 'var hasCmt=!!document.querySelector(\'[data-e2e^="comment-level"],[data-e2e="comment-item"]\');'
    + 'return {ok:true,value:hasCnt||hasCmt};})()', true) !== false;
}
async function tryLike(_reloaded) {
  var p = await likeProbe();
  for (var lw = 0; lw < 24 && p && p.found !== true; lw++) { await ctx.sleep(250); p = await likeProbe(); }
  if ((!p || p.found !== true) && !_reloaded && !(await workDataLoaded())) {
    ctx.stepLog(2, 'warn', '   ⚠️ 作品页没加载出数据(赞数/评论都没出来),刷新一次再试');
    var _ru = String(await getUrl()).split('?')[0], _rok = false;
    if (_ru) { try { await _navigate(_ru); _rok = true; } catch (_) { _rok = false; } }
    if (!_rok) return { ok: false, warn: true, empty: true, msg: '   ⚠️ 作品页没加载出数据,刷新也没打开,这条跳过' };
    await waitReady('video', 12000);
    await holdVideo();
    var r2 = await tryLike(true);
    if (r2 && r2.empty) {
      _likeEmptyStreak++;
      if (_likeEmptyStreak >= 3) {
        var cool = randInt(120000, 240000);
        ctx.stepLog(2, 'warn', '   ⏸️ 连续 ' + _likeEmptyStreak + ' 位潜客的作品都没加载出数据 —— TikTok 很可能在限流这个号/IP,先歇 ' + fmtSec(cool / 1000));
        await sleepWithHeartbeat(2, cool, '限流冷却中');
        _likeEmptyStreak = 0;
      }
    } else if (r2 && r2.ok) { _likeEmptyStreak = 0; }
    return r2;
  }
  if (!_reloaded && p && p.found === true) _likeEmptyStreak = 0;   // 这位的作品数据正常 → 「连续」中断
  // cdp_eval 万一在某条路径上不可用,tkCdp 会静默返回 null —— 别又退化成"没找到点赞按钮"。
  // 选择器修对之后 getAttr 这条朴素路径自己就够用(真机实测直接读到 aria-pressed="false")。
  if (!p) {
    // 2026-10-27 真机:图标是 <span data-e2e="browse-like-icon">,aria-pressed 挂在外层 <button> 上 ——
    //   原兜底 getAttr 只读 span 自己 → 恒 null → 一走兜底就必报「没找到点赞按钮」。改成就地往上找。
    try {
      var jr0 = await _b('javascript', { code: PICK_LIKE_JS + 'var i=pick();if(!i)return "";var h=i.hasAttribute("aria-pressed")?i:(i.closest("[aria-pressed]")||i);return "f:"+(h.getAttribute("aria-pressed")||"");' });
      var s0 = String((jr0 && (jr0.result !== undefined ? jr0.result : jr0.value)) || '');
      if (s0.indexOf('f:') === 0) p = { found: true, ap: s0.slice(2) || null, color: '', red: null, degraded: true };
    } catch (_) {}
  }
  if (!p || p.found !== true) {
    // 把当时页面上有什么打进日志,下次一眼看出是没加载完、版面不同还是别的。
    var diag = await tkCdp('(function(){var c=function(q){return document.querySelectorAll(q).length;};'
      + 'return {ok:true,value:location.pathname.slice(0,60)+" · "+innerWidth+"x"+innerHeight+" · like-icon="+c(\'[data-e2e="like-icon"]\')+" browse-like-icon="+c(\'[data-e2e="browse-like-icon"]\')+" aria-pressed按钮="+c("[aria-pressed]")+" video="+c("video")'
      // 再细一点:每个候选点赞图标的尺寸/可见性 + 每个 aria-pressed 按钮的标签和位置 —— 窄窗口(内核 1180 宽)版面跟桌面不同,靠这个定位真按钮。
      + '+" | 图标:"+Array.prototype.map.call(document.querySelectorAll(\'[data-e2e="browse-like-icon"],[data-e2e="like-icon"]\'),function(x){var r=x.getBoundingClientRect(),st=getComputedStyle(x);var hid="";for(var e=x;e&&e!==document.body;e=e.parentElement){var cs=getComputedStyle(e);if(cs.display==="none"||cs.visibility==="hidden"||cs.opacity==="0"){hid=e.tagName+"."+String(e.className||"").replace(/\\s+/g,".").slice(0,40)+"("+cs.display+"/"+cs.visibility+"/"+cs.opacity+")";break;}}return x.getAttribute("data-e2e")+"="+Math.round(r.width)+"x"+Math.round(r.height)+"@"+Math.round(r.left)+","+Math.round(r.top)+(hid?" 藏于"+hid:"");}).join(";")'
      + '+" | 按钮:"+Array.prototype.map.call(document.querySelectorAll("[aria-pressed]"),function(b){var r=b.getBoundingClientRect();var de=b.querySelector("[data-e2e]");return (b.getAttribute("aria-label")||"").replace(/\\s+/g," ").slice(0,24)+"="+Math.round(r.width)+"x"+Math.round(r.height)+"@"+Math.round(r.left)+","+Math.round(r.top)+(de?"("+de.getAttribute("data-e2e")+")":"");}).join(";")};})()', '');
    var _loaded = await workDataLoaded();
    return { ok: false, warn: true, empty: !_loaded,
      msg: (_loaded ? '   ⚠️ 没找到点赞按钮(like-icon 不存在)' : '   ⚠️ TikTok 没返回这条作品的数据(赞数/评论都没加载,可能被限流),点不了赞')
        + (diag ? ' [' + diag + ']' : ' [页面读取失败]') + (__likeProbeErr ? ' {' + __likeProbeErr + '}' : '') };
  }
  if (p.ap === 'true' || p.red === true) {
    return { ok: false, skip: true, msg: '   ⏭️ 已点过赞,跳过' };
  }
  // 🚨 点赞必须走【可信点击】(CDP Input.dispatchMouseEvent),别用 main_world_click。
  //   main_world_click 是页面内 `el.dispatchEvent(new MouseEvent('click'))` 合成事件 ——
  //   isTrusted 恒 false、screenX/screenY 恒 0,TikTok 一行 `if(!e.isTrusted)` 就能识破,
  //   点赞比别的动作更容易触发风控(用户 2026-08-17 反馈)。
  //   2026-08-17 真机实测(For You 流点赞按钮 4.5M 赞那条):CDP 点击捕获到
  //   isTrusted=true / screenX=938 screenY=453,aria-pressed false→true、心形转红,
  //   再点一次能取消 —— 双向都生效。合成事件只在拿不到坐标时兜底(总比不点强)。
  try {
    var trusted = await cdpClickSel(SEL_PICKED_LIKE);
    if (!trusted) await nativeClick(SEL_PICKED_LIKE);
  } catch (e) {
    return { ok: false, warn: true, msg: '   ⚠️ 点赞 click 失败: ' + String(e.message || e).slice(0, 60) };
  }
  // 2026-10-26 用户要求:点完固定等 0.25s 看一次就走(没读到变红也按已发出计,与原逻辑一致)。
  await ctx.sleep(250);
  var v = await likeProbe();
  if (v && v.found && v.ap === 'false' && v.red !== true) {
    // 明确读到「没赞上」(aria-pressed 仍是 false):再等 0.5s,还是 false 就补点一次(只补一次,防止点两下变取消)。
    await ctx.sleep(500);
    v = await likeProbe();
    if (v && v.found && v.ap === 'false' && v.red !== true) {
      try { if (!(await cdpClickSel(SEL_PICKED_LIKE))) await nativeClick(SEL_PICKED_LIKE); } catch (_) {}
      await ctx.sleep(400);
      v = await likeProbe();
      if (v && v.found && v.ap === 'false' && v.red !== true) {
        return { ok: false, warn: true, msg: '   ⚠️ 点了两次都没赞上(TikTok 可能限制了这个号点赞),跳过' };
      }
    }
  }
  if (v && (v.ap === 'true' || v.red === true)) {
    return { ok: true, msg: '   👍 点赞成功' + (v.ap === 'true' ? '' : '(心形变红)') };
  }
  // 读不到状态切换时仍按成功计 —— 与刷剧模式一致:可信点击已派发,若在这里判失败,
  // 配额会永远跑不满(用户 2026-08-14 反馈过)。把实测值打进日志便于下次定位。
  return { ok: true,
    msg: '   👍 点赞 click 已发出(未读到状态切换,按成功计 · aria-pressed=' + (v && v.ap) + ' color=' + (v && v.color) + ')' };
}

async function tryFollow() {
  // feed-follow 按钮状态判断 — TikTok DOM 多次改版需要多路兼容:
  //   旧版 (~2025): 关注成功 → capsule 按钮被替换 → data-e2e=feed-follow 消失
  //   新版 (2026-05 实测): capsule 按钮**仍在**,只是文案/状态切换:
  //     - 文字从 "Follow"/"关注" → "Following"/"已关注"/"互相关注"
  //     - aria-label 同步变化
  //     - 头像旁出现 ✓ 标记(但那是另一个元素,这里不查)
  //   兼容策略: 任一指标命中即算成功,失败时 log 完整状态供诊断。
  var existsBefore = await getAttr(SEL_FOLLOW_BTN, 'data-e2e');
  var textBefore = '';
  if (existsBefore) {
    try { textBefore = (await getText(SEL_FOLLOW_BTN) || '').trim(); } catch (_) {}
  }
  // 提前 skip: 按钮不存在 OR 文案已经是已关注状态
  var followedRe = /^(following|已关注|互相关注|フォロー中|フォローしています)$/i;
  if (!existsBefore) {
    return { ok: false, skip: true, msg: '   ⏭️ 关注按钮不存在(可能已关注),跳过' };
  }
  if (followedRe.test(textBefore)) {
    return { ok: false, skip: true, msg: '   ⏭️ 已关注 (按钮文案: "' + textBefore + '"),跳过' };
  }

  try {
    await nativeClick(SEL_FOLLOW_BTN);
  } catch (e) {
    return { ok: false, warn: true, msg: '   ⚠️ 关注 click 失败: ' + String(e.message || e).slice(0, 60) };
  }
  await jsleep([2000, 4000]);

  // 多路 verify(任一通过即算成功):
  var existsAfter = await getAttr(SEL_FOLLOW_BTN, 'data-e2e');
  if (!existsAfter) {
    return { ok: true, msg: '   ➕ 关注成功 (按钮已消失)' };
  }
  var textAfter = '';
  var ariaAfter = '';
  try { textAfter = (await getText(SEL_FOLLOW_BTN) || '').trim(); } catch (_) {}
  try { ariaAfter = (await getAttr(SEL_FOLLOW_BTN, 'aria-label') || '').trim(); } catch (_) {}
  if (followedRe.test(textAfter) || followedRe.test(ariaAfter)) {
    return { ok: true, msg: '   ➕ 关注成功 (按钮状态已切换: "' + (textAfter || ariaAfter) + '")' };
  }
  // verify 文案没切换,但 click 已发出 — TT feed 同时挂 prev/current/next 三个
  // [data-e2e="feed-follow"] 按钮,getAttr/getText 内部 query_selector limit:1
  // 取 DOM order 第一个,未必是 current 视频那个;click 走 main_world_click 命
  // 中可视元素,实测服务端 follow 已生效。对齐 douyin tryFollow 的兜底语义,
  // 按成功计数,不再误报"风控/登录失效"。诊断字段保留方便后续 verify selector 收紧。
  // 用户 2026-08-17 实测:走到这条分支时关注【确实成功了】,只是读不到按钮状态。
  //   原来把 textAfter/aria/「可能抓到相邻视频按钮」整串诊断抛给用户,看着像出了事,
  //   实际一切正常 —— 只留结论,诊断细节收进 cowork 日志(ctx.log)不占用户界面。
  try { ctx.log && ctx.log('follow verify unreadable: text="' + textAfter.slice(0, 20) + '" aria="' + ariaAfter.slice(0, 30) + '"'); } catch (_) {}
  return { ok: true, msg: '   ➕ 关注成功' };
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
// 在主页上找到这条作品的卡片 → 滚到屏幕中间 → 可信点击 → 等地址变成这条作品(最多 8s)。
async function openCardOnProfile(wurl) {
  var vid = videoIdOf(wurl);
  if (!vid) return false;
  var mk = await tkCdp('(function(){var o=document.querySelectorAll("[data-nc-lv]");for(var j=0;j<o.length;j++)o[j].removeAttribute("data-nc-lv");'
    + 'var as=document.querySelectorAll(\'a[href*="/video/' + vid + '"],a[href*="/photo/' + vid + '"]\');'
    + 'for(var i=0;i<as.length;i++){var r=as[i].getBoundingClientRect();if(r.width>0&&r.height>0){try{as[i].scrollIntoView({block:"center"});}catch(_){}as[i].setAttribute("data-nc-lv","1");return {ok:true,value:1};}}'
    + 'return {ok:true,value:0};})()', 0);
  if (mk !== 1) return false;
  await ctx.sleep(300);
  var ok = false;
  try { ok = await cdpClickSel('a[data-nc-lv="1"]'); } catch (_) { ok = false; }
  if (!ok) return false;
  for (var w = 0; w < 32; w++) { await ctx.sleep(250); if (videoIdOf(await getUrl()) === vid) return true; }
  return false;
}
async function isTk403() {
  return await tkCdp('(function(){var t=(document.body&&document.body.innerText||"").slice(0,400);'
    + 'return {ok:true,value:/Access to www\\.tiktok\\.com was denied|HTTP ERROR 403/i.test(t)};})()', false) === true;
}

async function cdpClickSel(selector) {
  var p = await rectOf(selector);
  if (!p) return false;
  try { await _b('cdp_click', { x: p.x, y: p.y }); return true; } catch (e) { return false; }
}

// 生成一条评论。强制语言(按账号内容语言)时,把语言规则直接拼进【系统提示词】末尾 —— 原来只放在 user JSON 的
//   language_hint 字段里,而系统提示词是中文、user JSON 里赛道名 / 视频文案 / 人设也常是中文,模型容易跟着写中文
//   (用户 2026-10-29:英文账号给潜客评论还是中文)。走 __raw__ 通道(老客户端也支持)。
//   填了引流语且概率 > 0 时仍走 comment_composer(引流融入只挂在这个名字上),语言靠下面的校验兜底。
var __tkRawUsed = false;   // 本条评论是否走了 __raw__(没经过客户端融合)—— 只有这时剧本才自己接尾巴,防双重引流
async function composeComment(inputStr) {
  var hasFunnel = String(task.funnel_phrase || '').trim() && Number(task.funnel_probability) > 0;
  // 尾巴引流语:配了引流语时走 __raw__ 拿【纯评论】(客户端只对名叫 comment_composer 的调用做融合),
  //   引流语由 tryComment 接在末尾。拿不到 prompt(老客户端)→ 走老路 comment_composer,由老客户端自己融合、剧本不接尾巴。
  __tkRawUsed = false;
  if ((FORCED_LANG || hasFunnel) && typeof ctx.getPrompt === 'function') {
    var sp = '';
    try { sp = String(ctx.getPrompt('comment_composer') || ''); } catch (_) { sp = ''; }
    var extra = FORCED_LANG === 'en' ? '\nIMPORTANT: Write the entire comment in English only, no matter what language the video, its caption, the comments, the track name or the persona are in.' : '';
    if (sp) __tkRawUsed = true;
    if (sp) return await ctx.aiCall('__raw__', sp + '\n\n' + String(task.comment_language_hint || '') + extra, inputStr, { expectJson: false });
  }
  // 拿不到 prompt(只有很老的客户端)→ 老路,由客户端自己融合,剧本不接尾巴(funnel_rewrite=false 时也一样)
  return await ctx.aiCall('comment_composer', inputStr, undefined, { expectJson: false });
}

async function tryComment(desc, author, stepNum) {
  // ⚠️ 相对 auto_engage 的有意偏离:多了 stepNum 参数(默认 2)。采集阶段(STEP1)也要在
  //   同行作品下留言,而原函数里的 ctx.stepLog 全写死步骤 2,不加这个参数的话采集时的
  //   日志会串到「触达」那一步,用户看进度会以为跑错了。
  var _st = stepNum || 2;
  // player 页评论面板默认收起 — 必须先 click comment-icon 让右侧 panel
  // 展开,否则 [data-e2e="comment-input"] 根本不存在于 DOM。
  // 已展开时再点会切回 You may like — 所以先探一下 input 是否已经在,
  // 在了就跳过 open。
  // 2026-10-26:统一走 ensureCommentsOpen(开着就不点、只点评论图标、不误中「@」按钮)。
  await ensureCommentsOpen();

  // 抓置顶评论喂 AI(语言匹配 + 氛围对齐)。selector 加了 comment-level-1
  // 限定避开 input 区的 placeholder。
  var topComments = await getTexts(SEL_TOP_COMMENT_TEXT, 5);
  var topCommentsStr = topComments.slice(0, 5).map(function (t) {
    return '- ' + t.replace(/\s+/g, ' ').slice(0, 100);
  }).join('\n');

  // 面板必须已打开(输入框在 DOM 且有坐标),否则直接失败 —— 不白花 AI 评论钱。
  var inRect = await rectOf(SEL_COMMENT_INPUT_CE);
  if (!inRect) {
    try {
      var diagSels0 = ['[data-e2e="comment-input"]', '[contenteditable="true"]', '.public-DraftEditor-content', 'div[role="textbox"]', '[data-e2e="comment-icon"]'];
      var hit0 = [];
      for (var d0 = 0; d0 < diagSels0.length; d0++) { try { var q0 = await _b('query_selector', { selector: diagSels0[d0], limit: 2 }); var e0 = (q0 && (q0.elements || (q0.result && q0.result.elements))) || (Array.isArray(q0) ? q0 : []); if (e0 && e0.length) hit0.push(diagSels0[d0] + '×' + e0.length); } catch (eq) {} }
      ctx.stepLog(_st, 'running', '   🔬 评论框探测:' + (hit0.join(' , ') || '全 0'));
    } catch (eD0) {}
    return { ok: false, warn: true, msg: '   ⚠️ 评论面板没打开/找不到输入框' };
  }

  var comment = '';
  if (!AI_COMMENT) {
    // 🎣 AI自主评论关闭:不写针对视频的评论,只发引流语(按 funnel_rewrite 改写或原样);失败 → 这条不发
    comment = await leadOnlyRewrite(_st, (FORCED_LANG === 'en' ? 'English' : FORCED_LANG === 'zh' ? '简体中文'
      : '与这条视频文案相同的语言(文案:「' + String(desc || '').slice(0, 60) + '」,只用来判断语言,不要回应它的内容)') + ';不超过 150 字符', 150);
    if (!comment) return { ok: false, warn: true, msg: '   ⏭️ 引流语没准备好,这条不发评论' };
  } else {
  var langHint = task.comment_language_hint || (config.language_modes && config.language_modes.auto && config.language_modes.auto.system_hint) || '';
  var promptInput = JSON.stringify({
    author_name: author || '',
    video_desc: desc || '',
    top_comments: topCommentsStr,
    track: trackId,
    keyword: pickedKeyword,
    user_prompt: commentPrompt,
    language_hint: langHint,
  });
  ctx.stepLog(_st, 'running', '   🤖 AI 生成评论中...');
  // 注意:phaseRunner aiCall(name, promptOrInput, rawInput) 里 rawInput 完全没用,
  // userMessage = promptOrInput。所以 promptInput JSON 必须作为第二个参数传,
  // 否则 LLM 完全收不到视频信息(老调法把 promptInput 当 rawInput 静默丢弃)。
  var raw;
  try {
    raw = await composeComment(promptInput);
  } catch (e) {
    return { ok: false, warn: true, msg: '   ⚠️ AI 生成评论失败: ' + String(e.message || e).slice(0, 60) };
  }
  var comment = String(raw || '').trim()
    .replace(/^["'""]+|["'""]+$/g, '')
    .trim()
    .slice(0, 150);
  // 贬损词拦截:命中就让 AI 重写一次;再命中就不发这条 —— 宁可少发一条,
  //   也不能把一句挖苦挂在别人作品下面(那是招骂,比不发糟得多)。
  // 先去复读再判贬损词 —— 复读的文本发出去就是一条重复两遍的评论。
  comment = dedupeEcho(comment);
  var _neg = looksNegative(comment);
  if (_neg) {
    ctx.stepLog(_st || 2, 'running', '   ♻️ 生成的评论里有「' + _neg + '」,重写一次');
    try {
      var raw2 = await composeComment(promptInput);
      var c2 = String(raw2 || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim();
      if (c2 && !looksNegative(c2)) comment = c2.slice(0, 200);
      else return { ok: false, warn: true, msg: '   ⏭️ 两次生成都带贬损措辞,这条不发评论' };
    } catch (_e) { return { ok: false, warn: true, msg: '   ⏭️ 重写评论失败,这条不发' }; }
  }
  if (!comment) {
    return { ok: false, warn: true, msg: '   ⚠️ AI 评论为空' };
  }
  if (langMismatch(comment)) {
    var _ln = FORCED_LANG === 'en' ? 'English' : '中文';
    ctx.stepLog(_st || 2, 'running', '   ♻️ 生成的评论不是' + _ln + '(「' + comment.slice(0, 40) + '」),按账号语言重写一次');
    try {
      var _pi = JSON.parse(promptInput);
      _pi.language_hint = langHint + ' 上一次你没有用这种语言写,这一次整条评论必须只用 ' + _ln + '。';
      var raw3 = await composeComment(JSON.stringify(_pi));
      var c3 = dedupeEcho(String(raw3 || '').trim().replace(/^["'“”]+|["'“”]+$/g, '').trim().slice(0, 150));
      if (!c3 || langMismatch(c3) || looksNegative(c3)) return { ok: false, warn: true, msg: '   ⏭️ 重写后还不是' + _ln + ',这条不发评论' };
      comment = c3;
    } catch (_e3) { return { ok: false, warn: true, msg: '   ⏭️ 重写评论失败,这条不发' }; }
  }
  // 尾巴引流语:按 funnel_probability 把随机一行引流语单独改写(或原样)后接在末尾(代替 AI 融合)
  if (__tkRawUsed && LEAD_LINES.length && Math.random() * 100 < Number(task.funnel_probability || 0)) {
    comment = await funnelTail(comment, LEAD_LINES[Math.floor(Math.random() * LEAD_LINES.length)], _st, 150);
  }
  } // ── end of `if (!AI_COMMENT) ... else {`
  ctx.stepLog(_st, 'running', '   ✍️ 待发评论: "' + comment + '"');

  // 写入评论 —— 【全可信 CDP】(浏览器实测:合成 paste/execCommand 都不激活 Draft 的发送按钮):
  //   ① cdp_click 输入框中心聚焦 → ② cdp_insert_text 插入(CDP Input.insertText,isTrusted)→ Draft 登记、按钮激活。
  await cdpClickSel(SEL_COMMENT_INPUT_CE);          // 可信聚焦
  await jsleep([400, 900]);
  try {
    await _b('cdp_insert_text', { text: comment }); // 可信插入
  } catch (e) {
    return { ok: false, warn: true, msg: '   ⚠️ 写入评论失败(cdp_insert_text): ' + String(e.message || e).slice(0, 60) };
  }
  // Draft.js 异步 setState — 给它点时间消化输入并 enable post button。
  await jsleep([1200, 2500]);
  // 校验:输入框真有字了吗?(空 = 插入没生效,别点发送发个寂寞)
  var wroteLen = 0;
  try { var wr = await _b('javascript', { code: 'var e=document.querySelector(' + JSON.stringify(SEL_COMMENT_INPUT_CE) + ');return e?((e.textContent||"").length):0;' }); wroteLen = Number((wr && (wr.result !== undefined ? wr.result : wr.value)) || 0); } catch (eW) {}
  if (!wroteLen) {
    ctx.stepLog(_st, 'running', '   ⚠️ 可信插入后输入框仍为空,放弃这条');
    return { ok: false, warn: true, msg: '   ⚠️ 写入评论失败:插入后为空' };
  }

  // 发送 —— 可信 cdp_click 发送按钮中心。
  var posted = await cdpClickSel(SEL_COMMENT_POST);
  if (!posted) {
    return { ok: false, warn: true, msg: '   ⚠️ 评论提交失败:找不到发送按钮坐标' };
  }
  await jsleep([2500, 5000]);

  return { ok: true, msg: '   💬 评论发布成功', comment: comment };
}


// cdp_eval — 走 CDP Runtime.evaluate,不受页面 CSP 的 new Function 限制(快手同款原语)。
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

