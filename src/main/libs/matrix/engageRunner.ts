import { runAutomationScript } from './kernelPool';
import { normalizeCustomCommentPolicy, type CustomCommentPolicy } from '../../../types/matrixCommentPolicy';

type CommentRound = { attempted: number; confirmed: number; restedAt: number; accountLimit?: number; homeWarmed?: boolean };
/**
 * 矩阵互动运行时 —— 让一批账号在各自指纹内核里跑抖音自动点赞/评论/关注。
 *
 * 复用后端 fork 的 douyin_auto_engage orchestrator(实战 DOM 逻辑:按关键词搜→
 * 滚动收集视频→按配额随机点赞/关注/评论),这里提供它需要的整套 ctx,把浏览器
 * 命令路由到该账号的内核 CDP(matrixCmd)、AI 写评论走后端 /api/ai、计费走
 * /api/charge/action、去重用本地 engageHistory。
 *
 * ⚠️ orchestrator 的 DOM 选择器/点击策略是按真实抖音页调过的;在指纹内核 CDP 上
 *    第一次跑大概率要据真机反馈微调(选择器/点击/滚动)。这是预期内的,不是写错。
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { coworkLog } from '../coworkLogger';
import { launchKernel, kernelNavigate, kernelEval, closeKernel, checkKernelLogin, getSession, NO_KERNEL_ERROR, acquireKernel, releaseKernel, isKernelLeaseCurrent } from './kernelPool';
import { inspectHoldMs } from './inspectHold';
import { installedKernelPath } from './kernelInstaller';
import { leadEngageConfig } from './leadEngageConfig';
import { commentLikeLimits, withTikTokKeywordLimits } from './commentLikeConfig';
import { TIKTOK_COMMENT_INTENT_PROMPT, withTikTokBuyerComments } from './tiktokCommentIntent';
import { CUSTOM_COMMENT_LEDGER, withTikTokCustomComments } from './tiktokCustomComments';
import { customCommentAccountUnavailable, withCustomCommentBatch, type CustomCommentBatch, type CustomCommentSummary } from './customCommentBatch';
import { commentAssignmentRandom, commentPostKey, type SavedCommentAssignmentPlan } from '../../../types/matrixCommentPlan';
import { validatedCommentPosts, type CommentLikeMode, type CommentPost } from '../../../types/matrixCommentPosts';
import { automationSafety, AutomationSafetyError, AUTOMATION_RESTRICTION_EXPR } from './automationSafety';
import { diagnosticAccountAlias, KernelNavigationError } from './kernelNavigation';
import { markAccountRecovery } from './accountManager';
import { isRecoverableFailure } from './recovery';

// 各平台主页(跑前导航 + 登录态检查用;不再写死抖音)。
const PLATFORM_HOME: Record<string, string> = {
  douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/', bilibili: 'https://www.bilibili.com/',
  kuaishou: 'https://www.kuaishou.com/', tiktok: 'https://www.tiktok.com/', x: 'https://x.com/home',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
  instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', reddit: 'https://www.reddit.com/',
  // 交易所广场三家:直接落各自广场页(互动的对象就在这个信息流里)。
  gate: 'https://www.gate.com/post', bitget: 'https://www.bitget.com/insights', bybit: 'https://www.bybit.com/social/',
  okx: 'https://www.okx.com/orbit',
};
// 视频下载直链的 Referer(各平台 CDN 防盗链要求,给错会 403)。video_download 剧本走 downloadVideoToDisk 时按平台取。
const DOWNLOAD_REFERER: Record<string, string> = {
  douyin: 'https://www.douyin.com/', kuaishou: 'https://www.kuaishou.com/',
  bilibili: 'https://www.bilibili.com/', tiktok: 'https://www.tiktok.com/',
  xhs: 'https://www.xiaohongshu.com/',
};
import { matrixCmd } from './cdpCommands';
import { getAccount, setAccountStatus, appendDerivedKeywords, effectiveKeywords, accountBadgeLabel, matrixGroupTitle, markAccountAlive, platformKey, markAccountChargeUncertain, registerDispatch, getDispatchedReceipt, archiveDispatchedResult, selectAvailability } from './accountManager';
import { promptReloginForExpiredAccount, loginUrlFor } from './reloginPrompt';
import { getNoobClawAuthToken, getMatrixCommentAIConfig } from '../claudeSettings';
import { isCommentAIRequest, requestCommentAI } from './commentAI';
import { withTikTokCommentPrompts, isLocalTikTokComment, publishableTikTokComment, prepareTikTokLeadCommentTask } from './tiktokCommentPrompts';
import { patchTikTokLeadScript } from './tiktokLeadScript';

// 多平台通用验证码检测(页面 JS,返回 boolean)。撞验证码不直接停,改成提示用户在【该账号窗口】
//   手动过、轮询到消失就继续(见 ctx.waitForCaptchaCleared)。以【验证码元素】为强信号,辅以少量
//   全屏滑块文案,尽量不误判(误判会白等)。覆盖抖音(verifycenter/secsdk)/TikTok/小红书/快手/B站/极验。
const CAPTCHA_DETECT_EXPR = "(function(){try{"
  + "if(document.querySelector('#captcha_container,#captcha-verify-image,[id*=\"captcha\" i][class*=\"verify\" i],[class*=\"captcha_verify\" i],[class*=\"vc_captcha\" i],[class*=\"captcha-container\" i],[class*=\"captcha-slider\" i],[class*=\"secsdk-captcha\" i],[class*=\"geetest\" i],[class*=\"red-captcha\" i],[class*=\"sc-captcha\" i]'))return true;"
  + "var b=document.body?(document.body.innerText||'').slice(0,3000):'';"
  + "if(/向右滑动|拖动滑块|拖动下方滑块|完成拼图|按住滑块|滑动完成验证|Verify you are human|请完成安全验证/i.test(b))return true;"
  + "return false;}catch(e){return false;}})()";

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }
function sleep(ms: number): Promise<void> { return new Promise((r) => setTimeout(r, ms)); }
/** 可中断等待:点停止后立即返回,不再干等整段(错峰 3-15s / 导航等待等停不下来的主因)。 */
function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal?.aborted) return resolve();
    const t = setTimeout(() => { cleanup(); resolve(); }, ms);
    const onAbort = () => { cleanup(); resolve(); };
    const cleanup = () => { clearTimeout(t); try { signal?.removeEventListener('abort', onAbort); } catch { /* ignore */ } };
    try { signal?.addEventListener('abort', onAbort, { once: true }); } catch { /* ignore */ }
  });
}

/** One deadline covers headers and body; the race also bounds an unresponsive transport. */
async function fetchEngageJson(url: string, init: RequestInit, timeoutMs: number, signal?: AbortSignal): Promise<{ response: Response; data: any }> {
  if (signal?.aborted) throw new Error('user_stopped');
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const cancelled = new Promise<never>((_resolve, reject) => {
    onAbort = () => { controller.abort(); reject(new Error('user_stopped')); };
    signal?.addEventListener('abort', onAbort, { once: true });
    timer = setTimeout(() => { controller.abort(); reject(new Error('request_timeout')); }, timeoutMs);
  });
  try {
    return await Promise.race([
      (async () => {
        const response = await fetch(url, { ...init, signal: controller.signal });
        // An HTML error page still has an authoritative HTTP rejection status.
        // A malformed successful body remains an error (especially for debits).
        let data: any;
        try { data = await response.json(); } catch (error) { if (response.ok) throw error; }
        return { response, data };
      })(),
      cancelled,
    ]);
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
function randInt(min: number, max: number): number {
  const lo = Math.min(min, max), hi = Math.max(min, max);
  return lo + Math.floor(Math.random() * (hi - lo + 1));
}

export interface EngageQuota {
  daily_like_min?: number; daily_like_max?: number;
  daily_follow_min?: number; daily_follow_max?: number;
  daily_comment_min?: number; daily_comment_max?: number;
  comment_lang?: string;            // 评论语言:'auto'|'zh'|'zh-TW'|'en'|'ja'|'ko'|'ru'|'fr'|'de'|'vi'(空/auto=跟帖子语言)
  // 刷剧模式(仅抖音 engage):'binge'=无视关键词,在账号自己的推荐流里沉浸式刷视频互动。
  // 走 quota 通道透传(wizard→taskStore→sidecar 全链已贯通,零新管道);关键词为空时剧本也会自动进入。
  engage_mode?: '' | 'binge' | 'precise';
  // ⚠️ 这份 EngageQuota 与 types.ts 那份是各自独立的重复声明(runner 不 import 那边),
  //   新字段两边都要加 —— 只加 types.ts 的话这里读属性全是 TS2339。
  daily_favorite_min?: number; daily_favorite_max?: number;
  max_comment_per_work?: number;
  precise_urls?: string[];
  precise_like?: number; precise_favorite?: number;
  precise_follow?: number; precise_comment?: number;
}

// 评论语言 code → AI 语言名(强制模式)。auto/空 → 不下发,剧本回落「跟帖子语言」。
const COMMENT_LANG_NAME: Record<string, string> = {
  zh: '简体中文 (Simplified Chinese)', 'zh-TW': '繁体中文 (Traditional Chinese)', en: '英文 (English)',
  ja: '日语 (Japanese)', ko: '韩语 (Korean)', ru: '俄语 (Russian)', fr: '法语 (French)', de: '德语 (German)', vi: '越南语 (Vietnamese)',
};
function commentLangHint(code?: string): string | undefined {
  if (!code || code === 'auto') return undefined;
  const name = COMMENT_LANG_NAME[code];
  if (!name) return undefined;
  return `⚠️ 硬性规则(压倒一切):整条评论必须用【${name}】书写,只用这一种语言,第一个字符就是该语言,绝不混入其它语言。不管帖子/视频是什么语言,你都用 ${name} 回复。`;
}

export interface EngageTaskOptions {
  platform: string;                 // 目前 douyin
  manualRetry?: boolean;            // 显式手动运行可提前复查技术故障；不解除平台冷却或人工暂停。
  taskId?: string;                  // 任务 id(标签分组 pill 显示 🤖 平台 #缩写;手动/无任务上下文可缺省)
  accountIds: string[];
  quota?: EngageQuota;              // 每号配额区间(缺省用 scenario 默认)
  // 任务类型:'engage'=互动涨粉(点赞/评论/关注,按关键词搜);'reply_fan'=自动回复粉丝评论
  // (抖音创作者中心评论管理,不需关键词、无配额、有引流尾巴);'video_download'=视频无水印下载
  // (单账号,粘贴多个链接逐个下载,不需关键词、无配额)。缺省 'engage' 兼容旧调用。
  // 'report'=举报(白名单功能,可多账号逐个顺序执行、1-4 条链接、只能手动触发;剧本 *_report 下发需登录 + 白名单)。
  // 'comment_like'=评论区点赞评论(仅 TikTok,剧本 tiktok_comment_like):注入 ctx.task.urls + comment_like_max。
  // 'block'=批量拉黑(仅抖音,剧本 douyin_block):注入 ctx.task.block_targets / block_keywords。
  taskType?: 'engage' | 'reply_fan' | 'video_download' | 'lead_engage' | 'report' | 'comment_like' | 'block';
  // 定向获客(lead_engage)配置。任务级(对所有执行账号相同):种子号/关键词/名额等由向导填,
  // 注入到 orchestrator 读的 ctx.task.mode/seed_accounts/max_leads/... 顶层字段。
  leadEngage?: {
    seedByAccount?: Record<string, string[]>;
    mode?: 'accounts' | 'keywords' | 'live';
    liveUrls?: string[];
    liveDwellMinutes?: number;
    seedAccounts?: string[];
    keywords?: string[];
    maxLeads?: number;
    maxLikes?: number;
    maxFollows?: number;
    maxComments?: number;
    leadsPerRun?: number;
    doLike?: boolean;
    doComment?: boolean;
    doFollow?: boolean;
    commentPrompt?: string;
  };
  // 刷剧模式(仅抖音 engage):'binge'=无视关键词,在账号自己的推荐流里沉浸式刷视频互动。
  // 关键词为空时后端剧本也会自动进入 binge(兜底),此字段是向导显式开关的透传。
  engageMode?: 'search' | 'binge' | 'precise';
  scenarioId?: string;             // 显式指定后端剧本 id(reply_fan→*_reply_fans_comment / video_download→*_video_download);缺省按平台推
  funnel?: { funnel_phrase?: string; funnel_probability?: number; funnel_rewrite?: boolean }; // 引流配置:下发给剧本,引流尾巴 / 只发引流语全部由后端剧本处理(客户端不加工评论)
  // 各账号独立引流语:有值时按 accountId 取,未配的账号视为不带引流(不回落共用值);
  // undefined 时沿用 funnel(共用,老行为)。
  funnelByAccount?: Record<string, { funnel_phrase?: string; funnel_probability?: number; funnel_rewrite?: boolean }>;
  // AI自主评论(任务级):只有 false 才关 —— 评论只发引流语(AI 改写或原样);缺省 = 老行为。
  aiComment?: boolean;
  // 单个用户评论最大回复数(仅抖音回复粉丝剧本读它;不传 → 剧本回落 1 = 老行为)
  maxReplyPerComment?: number;
  // 每号本次运行最多回复几条(仅抖音回复粉丝剧本读它;不传 → 剧本按 100 兜底;只管本次运行,不跨运行累计)
  maxRepliesPerRun?: number;
  urls?: string[];                 // video_download:待下载视频链接清单;comment_like:作品链接(注入 ctx.task.urls)
  commentLikeMax?: number;         // 仅 comment_like:老字段(剧本已不读)
  commentMode?: CommentLikeMode;
  commentPosts?: CommentPost[];
  commentPostAccountIds?: string[];
  commentAssignmentPlan?: SavedCommentAssignmentPlan;
  onCommentAssignmentPlan?: (plan: SavedCommentAssignmentPlan) => void;
  customCommentPolicy?: CustomCommentPolicy;
  commentVideoLimit?: number;
  commentRepliesPerVideo?: number;
  commentDoLike?: boolean;         // 仅 comment_like:注入 ctx.task.cl_do_like
  commentDoReply?: boolean;        // 仅 comment_like:注入 ctx.task.cl_do_reply
  blockTargets?: string[];         // 仅 block:名单(注入 ctx.task.block_targets)
  blockKeywords?: string[];        // 仅 block:关键词(注入 ctx.task.block_keywords)
  blockMode?: 'precise' | 'keyword'; // 仅 block:精准=各号名单 / 关键词=各号自己的关键词;缺省=老任务
  blockTargetsByAccount?: Record<string, string[]>; // 仅 block 精准模式:accountId → 名单
  reportItems?: Array<{ url: string; targetType: string; reason: string; subReason?: string; description: string }>; // 仅 report:条目(注入 ctx.task.report_items)
  reportDryRun?: boolean;          // 仅 report:试运行(选原因+填描述,停在提交前;不计费)
  concurrency?: number;
  jitterMinMs?: number; jitterMaxMs?: number;
  kernelPath?: string;
  authToken?: string;              // aiCall / chargeAction 用
  signal?: AbortSignal;            // 停止任务:已开始的号靠 ctx.aborted() 中途退,未开始的号跳过
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
  // 该账号本次随机选定的动作目标(orchestrator ctx.setActionTargets 抛出)。
  // 进度面板靠它聚合 action_progress 的 target(N 账号求和),没有则回落配额上限。
  // 定向获客多两维(获得潜客 / 互动潜客)—— 它们才是这张卡的产出,没有分母的话
  //   进度里只能显示一个光秃秃的数字,看不出跑没跑满。
  onTargets?: (accountId: string, targets: { like?: number; follow?: number; comment?: number; favorite?: number; lead_new?: number; lead_engaged?: number }) => void;
}

export interface EngageItemResult {
  accountId: string;
  state: 'success' | 'failed' | 'skipped';
  // like/follow/comment 是互动涨粉的维度;post(图文创作发帖数)/download(视频下载条数)是
  // 别的任务类型各自的完成维度,可选。各任务只填自己有的那个。
  counts?: { like: number; follow: number; comment: number; post?: number; download?: number; report?: number;
    // 定向获客专用:本次新增潜客数 / 本次触达潜客数。
    favorite?: number; lead_new?: number; lead_engaged?: number };
  // 该号本次累计实际扣费(积分 + 美元)。每条互动动作扣费后累加,用于「本次/累计消耗」。
  chargedCredits?: number;
  chargedUsd?: number;
  reason?: string;
  // 仅 report:剧本回传的逐条结果(sidecar 存到任务上给专属详情页)
  reportResults?: Array<{ url: string; status: string; why?: string; confirmed?: boolean; ts?: number }>;
}

// ── scenario pack 下发(/api/matrix/scenarios/:id)──
// authToken:举报剧本(*_report)是白名单功能,后端要求带登录 token 校验 UID;其它剧本无鉴权,不带也行。
//   403 report_not_whitelisted → 返回 { __denied: true }(不重试,告诉用户未开通)。
async function fetchEngagePack(id: string, authToken?: string, signal?: AbortSignal): Promise<any | null> {
  // 两次尝试:用户常为 TikTok 等开关 VPN,对 api 的请求会瞬断/超时 —— 一次失败别直接判「后端未部署」,
  // 等 3s 再试一次,大多数抖动都能扛过去。
  for (let attempt = 1; attempt <= 2; attempt++) {
    if (signal?.aborted) throw new Error('user_stopped');
    try {
      const headers: Record<string, string> = authToken ? { Authorization: `Bearer ${authToken}` } : {};
      const { response: res, data } = await fetchEngageJson(`${baseUrl()}/api/matrix/scenarios/${id}`, { headers }, 10_000, signal);
      if (res.ok) return data;
      coworkLog('WARN', 'engageRunner', 'fetch pack non-ok', { id, status: res.status, attempt });
      if (res.status === 404) return null; // 真没这个剧本,重试无意义
      if (res.status === 401 || res.status === 403) return { __denied: true, status: res.status }; // 白名单/登录拦截,重试无意义
      if (res.status < 500 && res.status !== 429) return { __unavailable: `scenario_rejected_http_${res.status}` };
    } catch (e) {
      if (signal?.aborted) throw new Error('user_stopped');
      coworkLog('WARN', 'engageRunner', 'fetch pack failed', { id, attempt, err: String(e) });
    }
    if (attempt === 1) await abortableSleep(3000, signal);
  }
  return { __unavailable: 'network_error:scenario_unavailable' };
}

// ── 本地 engageHistory(按号去重,避免重复互动同一视频)──
function engageHistoryFor(accountId: string) {
  const dir = path.join(process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'), 'engage');
  const file = path.join(dir, `${accountId}.json`);
  let mem: Record<string, true> = {};
  try { mem = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { mem = {}; }
  const save = () => { try { fs.mkdirSync(dir, { recursive: true }); fs.writeFileSync(file, JSON.stringify(mem)); } catch { /* ignore */ } };
  return {
    has: (type: string, id: string) => !!mem[`${type}:${id}`],
    remember: (type: string, id: string) => { mem[`${type}:${id}`] = true; save(); },
  };
}

// ── 简化版 aiCall(写评论/衍生关键词):POST /api/ai/chat/completions ──
// onCost:写评论等 AI 调用也是真扣积分(_noobclaw.billableTokens/costUsd),回传给上层累进「本次消耗」,
//        否则评论的 token 费看不见 → 消耗算少了。
// 引流语(AI自主评论 / AI改写引流语 / 引流尾巴)全部由后端剧本处理:客户端只把 task.funnel_* /
// ai_comment / funnel_rewrite 下发给剧本,comment_composer 出口原样返回 AI 评论,不做任何引流加工。
function makeAiCall(pack: any, authToken: string | undefined, _report: (m: string) => void, onCost?: (credits: number, usd: number) => void, signal?: AbortSignal, taskType?: string, leadFunnel?: { phrase: string; probability: number }) {
  const commentConfig = getMatrixCommentAIConfig(); // Snapshot for this account run; no mid-comment provider switch.
  // 单次 chat 调用(系统提示 + 用户消息 → content 文本)。
  const doChat = async (systemPrompt: string, userMessage: string, wantJson: boolean, model?: string): Promise<string> => {
    if (!authToken) throw new Error('AI_NOT_CONFIGURED');
    const body: any = {
      model: model || 'noobclawai-chat',
      messages: [{ role: 'system', content: systemPrompt }, { role: 'user', content: userMessage }],
      stream: false, max_tokens: 8000,
    };
    if (wantJson && (/json/i.test(systemPrompt) || /json/i.test(userMessage))) body.response_format = { type: 'json_object' };
    else if (!wantJson) body.response_format = { type: 'text' };
    // 网络抖动重试:用户常开着 VPN,对 api 的请求会瞬断(undici「fetch failed」)或 5xx/429 →
    //   评论生成只调一次就报「AI 生成评论失败: fetch failed」白丢一条。退避重试 3 次;
    //   402 余额不足 / 4xx 确定性错误 / 用户已停止(abort)不重试。
    const MAX_ATTEMPTS = 3;
    let lastErr: any = null;
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
      if (signal?.aborted) throw new Error('user_stopped');
      let res: Response;
      let data: any;
      try {
        const reply = await fetchEngageJson(`${baseUrl()}/api/ai/chat/completions`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify(body),
        }, 90_000, signal);
        res = reply.response; data = reply.data;
      } catch (e: any) {
        if (signal?.aborted || /aborted/i.test(String(e?.message || e))) throw new Error('user_stopped');
        lastErr = e; // 网络层错误(fetch failed / ECONNRESET / 超时)→ 退避重试
        if (attempt < MAX_ATTEMPTS) { await abortableSleep(attempt * 2000, signal); continue; }
        throw new Error('AI 请求网络失败(已重试 ' + MAX_ATTEMPTS + ' 次):' + String(e?.message || e).slice(0, 80));
      }
      // 后端非 2xx(余额不足 402 / 内容审核 / 限流 / 5xx)必须抛错,不能把 {error,message}
      //   当成空 content 静默吞掉 —— 否则上层只看到空串误报「返回空」,看不出是余额不足。
      if (!res.ok) {
        const beMsg = String((data && (data.message || data.error)) || ('http_' + res.status));
        if (res.status === 402 || /INSUFFICIENT_TOKENS|insufficient|余额/i.test(beMsg)) throw new Error('余额不足,请充值后重试 (' + beMsg + ')');
        if ((res.status >= 500 || res.status === 429) && attempt < MAX_ATTEMPTS) { lastErr = new Error('http_' + res.status); await abortableSleep(attempt * 2000, signal); continue; }
        throw new Error('AI 请求失败 ' + res.status + ': ' + beMsg);
      }
      // AI 调用的权威扣费(同视频管线口径):billableTokens=实扣积分,costUsd=权威美元。累进「本次消耗」。
      try {
        const aiCredits = Number(data?._noobclaw?.billableTokens) || 0;
        const aiUsd = Number(data?._noobclaw?.costUsd) || 0;
        if ((aiCredits > 0 || aiUsd > 0) && onCost) onCost(aiCredits, aiUsd);
      } catch { /* ignore */ }
      return data?.choices?.[0]?.message?.content ?? '';
    }
    throw lastErr || new Error('AI 请求失败');
  };

  return async (promptNameOrRaw: string, promptOrInput: any, rawInput?: string, opts?: any) => {
    let prompt = promptNameOrRaw === '__raw__' ? String(promptOrInput) : String(pack?.prompts?.[promptNameOrRaw] || '');
    const userMessage = promptNameOrRaw === '__raw__'
      ? String(rawInput || '')
      : (typeof promptOrInput === 'string' ? promptOrInput : JSON.stringify(promptOrInput));
    const wantJson = opts?.expectJson !== false;
    const localComment = isLocalTikTokComment(pack, promptNameOrRaw, prompt);
    if (localComment && leadFunnel) {
      const allow = !leadFunnel.phrase || Math.random() * 100 < leadFunnel.probability;
      prompt += `\n\n本条${allow ? '允许有事实依据的轻量主页邀请' : '不允许主页引导，只回应作品内容'}。`;
      if (allow && leadFunnel.phrase) prompt += `可选引导偏好（不是事实证明，不得照搬不实承诺）：${JSON.stringify(leadFunnel.phrase)}`;
    }
    const useCustom = commentConfig?.source === 'custom' && isCommentAIRequest(pack, promptNameOrRaw, prompt, userMessage, taskType);
    const content = useCustom
      ? await requestCommentAI(commentConfig, prompt, userMessage, wantJson, signal)
      : await doChat(prompt, userMessage, wantJson, opts && opts.model);
    if (localComment) {
      const comment = publishableTikTokComment(content);
      if (!comment) _report('⏭️ AI 选择跳过或返回内容不可发布，本条不写入、不发送评论');
      return comment;
    }
    // 纯文本出口(comment_composer 评论 / 关键词衍生等)原样返回;引流语由剧本自己处理。
    if (opts?.expectJson === false) return content;
    try { return JSON.parse(content); } catch { return content; }
  };
}

async function chargeAction(authToken: string | undefined, actionType: string, platform: string, refId?: string, signal?: AbortSignal) {
  if (!authToken) return { ok: false, reason: 'auth_missing' };
  if (signal?.aborted) return { ok: false, reason: 'aborted' };
  try {
    const { response: res, data } = await fetchEngageJson(`${baseUrl()}/api/charge/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
      body: JSON.stringify({ action_type: actionType, platform, ref_id: refId || null }),
    }, 30_000, signal);
    // No proven server idempotency: after dispatch a timeout, cancellation or
    // server failure may hide a completed debit. Never retry this POST blindly.
    if (res.status >= 500) return { ok: false, reason: 'charge_uncertain' };
    if (!res.ok) {
      if (res.status === 402) return { ok: false, reason: 'insufficient_balance' };
      if (res.status === 401 || res.status === 403) return { ok: false, reason: 'auth_required' };
      return { ok: false, reason: `charge_rejected_http_${res.status}` };
    }
    if (data?.ok === false) return { ok: false, reason: /insufficient|余额/i.test(String(data.error || '')) ? 'insufficient_balance' : 'charge_rejected' };
    const validAmount = (value: unknown): boolean => (typeof value === 'number' || typeof value === 'string' && value.trim() !== '')
      && Number.isFinite(Number(value)) && Number(value) >= 0;
    if (!data || typeof data !== 'object' || !validAmount(data.charged)
      || (data.cost_usd != null && !validAmount(data.cost_usd))) {
      return { ok: false, reason: 'charge_uncertain' };
    }
    // 后端 /api/charge/action 返回 charged(积分)+ cost_usd(按 token_price_per_million 算好的权威美元)。
    // 两个都带回去 → 任务的「本次/累计消耗」💎 + $ 才算得对(之前丢了 → 一直显示 0)。
    return { ok: true, charged: Number(data?.charged) || 0, cost_usd: Number(data?.cost_usd) || 0, balance_after: data?.balance_after };
  } catch { return { ok: false, reason: 'charge_uncertain' }; }
}

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;

async function runOne(opts: EngageTaskOptions, pack: any, accountId: string, chargeFatal?: { reason: string }, custom?: { batch: CustomCommentBatch; posts: CommentPost[]; stopSignal: AbortSignal; round: CommentRound }): Promise<EngageItemResult> {
  const acc = getAccount(accountId);
  const workSignal = custom?.stopSignal ?? opts.signal;
  if (chargeFatal && chargeFatal.reason) return { accountId, state: 'skipped', reason: 'charge_failed:' + chargeFatal.reason };   // 扣费已失败 → 池里排队的号不再跑
  const log = (m: string) => { try { opts.onLog?.(accountId, m); } catch { /* ignore */ } };
  if (opts.signal?.aborted) return { accountId, state: 'skipped', reason: 'aborted' }; // 已停止:还没轮到的号直接跳过
  // 早期守卫一律补日志:以前直接 return 不打日志 → 账号被跳过却「啥日志都没有」,无法排查。
  if (!acc) { log('❌ 跳过:账号不存在'); return { accountId, state: 'skipped', reason: 'account_not_found' }; }
  if (acc.authority) {
    const available = selectAvailability(accountId);
    if (!available?.available) return { accountId, state: 'skipped', reason: available?.reasons[0] || available?.status || 'storage_or_migration_hold' };
  }
  const commentPosts = custom?.posts;
  const assignedCommentKeys = new Set(commentPosts?.map(commentPostKey));
  const pendingComments = custom?.batch.pendingFor(accountId) ?? [];
  if (opts.commentMode === 'custom' && !commentPosts?.length && !pendingComments.length) {
    log('此账号没有分配到自定义评论');
    return { accountId, state: 'skipped', reason: 'no_custom_comments' };
  }
  if (acc.manualDisconnect) { log('⏸️ 账号已手动断开，请重新连接后运行'); return { accountId, state: 'skipped', reason: 'manual_disconnect' }; }
  if (acc.platform !== opts.platform) { log('❌ 跳过:账号平台与任务不符'); return { accountId, state: 'skipped', reason: 'platform_mismatch' }; }
  // 币安广场是 feed 互动(刷广场帖、按内置 CRYPTO 规则筛,不按关键词搜),不需要用户配关键词;
  //   reply_fan(回复粉丝评论)对象是自己作品下的粉丝评论,也不按关键词搜 → 同样豁免。
  //   其它平台(抖音/小红书等按关键词搜的互动)才要。漏掉豁免 → 账号没关键词被静默拦掉、无日志。
  // lead_engage(定向获客)自己处理来源(accounts 模式用种子号、keywords 模式用任务关键词),
  //   不读账号级 acc.keywords → 豁免这里的关键词守卫,否则账号没配关键词会被静默跳过。
  const needsKeywords = opts.taskType !== 'reply_fan' && opts.taskType !== 'video_download' && opts.taskType !== 'lead_engage' && opts.taskType !== 'report' && opts.taskType !== 'comment_like' && opts.taskType !== 'block' && opts.platform !== 'binance';
  // 抖音/快手/TikTok 互动支持「刷剧模式」(binge):显式开启 or 关键词为空时,后端剧本走推荐流沉浸式互动,不需要关键词。
  const bingeCapable = ['douyin', 'kuaishou', 'tiktok'].includes(opts.platform) && (opts.taskType === 'engage' || !opts.taskType);
  // 🎯 精准模式的链接是用户给的,跟账号配没配关键词无关 —— 不豁免的话 bilibili/youtube
  //   (不在 bingeCapable 里)的无词账号会被下面直接 return no_keywords 静默跳过,
  //   抖音/快手/TikTok 则会打出误导性的「未配置关键词 → 刷剧模式」日志(实际下发的是 precise)。
  const isPrecise = String((opts.quota as any)?.engage_mode || opts.engageMode || '') === 'precise';
  if (needsKeywords && !isPrecise && (!acc.keywords || acc.keywords.length === 0)) {
    if (bingeCapable) {
      log('📺 未配置关键词 → 刷剧模式:在账号自己的推荐流里刷视频互动');
    } else {
      log('❌ 跳过:未配置关键词(到「我的矩阵账号」编辑里添加)'); return { accountId, state: 'skipped', reason: 'no_keywords' };
    }
  }
  // 批量拉黑:按模式算出本号的名单/关键词;本号没东西可拉就跳过并说明原因。
  let blockTargetsForAcc = opts.blockTargets, blockKeywordsForAcc = opts.blockKeywords;
  if (opts.taskType === 'block' && opts.blockMode === 'keyword') {
    blockTargetsForAcc = [];
    blockKeywordsForAcc = effectiveKeywords(acc).map((k) => String(k).slice(0, 30)).slice(0, 20);
    if (!blockKeywordsForAcc.length) { log('❌ 跳过:关键词模式但该账号没配关键词(到「我的矩阵账号」编辑里添加)'); return { accountId, state: 'skipped', reason: 'no_keywords' }; }
  } else if (opts.taskType === 'block' && opts.blockMode === 'precise') {
    blockKeywordsForAcc = [];
    blockTargetsForAcc = (opts.blockTargetsByAccount && opts.blockTargetsByAccount[accountId]) || [];
    if (!blockTargetsForAcc.length) { log('❌ 跳过:该账号没有填要拉黑的名单'); return { accountId, state: 'skipped', reason: 'no_targets' }; }
  }
  if (acc.chargeUncertain) return { accountId, state: 'skipped', reason: 'charge_uncertain' };
  const manualRecoveryProbe = opts.manualRetry === true && acc.status === 'limited' && !!acc.recovery
    && isRecoverableFailure(acc.recovery.reason) && !acc.bindingConflict;
  if (acc.status === 'limited' && acc.recovery && acc.recovery.nextCheckAt > Date.now() && !manualRecoveryProbe) {
    log(`⏳ 等待自动复查：${new Date(acc.recovery.nextCheckAt).toLocaleString()}`);
    return { accountId, state: 'skipped', reason: 'recovery_pending' };
  }
  if (acc.status === 'banned' || (acc.status === 'limited' && !acc.recovery)) { log('❌ 跳过:账号状态为 ' + acc.status); return { accountId, state: 'skipped', reason: 'account_' + acc.status }; }
  if (manualRecoveryProbe) log('🔎 手动重试：先复查网络出口和登录状态，确认通过后再执行任务');

  // Workbook accounts are staggered by the task scheduler. Keep the existing delay for other tasks.
  if (!custom) await abortableSleep(randInt(opts.jitterMinMs ?? 3000, opts.jitterMaxMs ?? 15000), opts.signal);
  if (opts.signal?.aborted) { log('🛑 已停止'); return { accountId, state: 'skipped', reason: 'aborted' }; }

  // 计数键必须覆盖所有 driver 会调 addActionCount 的动作,否则被下面的 `type in counts` 白名单丢弃。
  // 全集(grep backend/matrix/scenarios):like/follow/comment/download/post/note。漏 download → 视频下载记录恒 0。
  //   定向获客另加两维:lead_new = 本次新收录的潜客数、lead_engaged = 本次触达过的潜客数。
  //   任务详情页要在点赞/关注/评论上方单独展示这两个数(本次/上次/累计)。
  const counts = { like: 0, follow: 0, comment: 0, favorite: 0, download: 0, post: 0, note: 0, lead_new: 0, lead_engaged: 0, report: 0, block: 0 };
  let chargedCredits = 0; // 该号本次累计扣费(积分),每笔互动动作扣费后累加
  let chargedUsd = 0;     // 同上,美元(后端按 token_price_per_million 算好)
  const history = engageHistoryFor(accountId);
  const q = opts.quota || {};
  const authToken = opts.authToken || getNoobClawAuthToken() || undefined; // aiCall/计费 token(main 侧)
  let finished: { status: string; error?: string } | null = null;
  // launch 失败时 kernelPool 已回退本次的引用计数/使用锁,finally 不能再 closeKernel ——
  // 否则会错放【别的流程】正持有的锁 / 把它刚开的窗关掉(对齐 keepAliveOne 的 launched 守卫)。
  let kernelLaunched = false;
  let kernelReceipt: Awaited<ReturnType<typeof acquireKernel>> | undefined;
  const reportFiles = new Set<string>();
  const accountRestriction = /^(?:captcha(?:_timeout)?|login_wall|forbidden|account_flag|rate_limited)$/;
  const finishRun = (state: EngageItemResult['state'], reason?: string, reportResults?: EngageItemResult['reportResults'], statusDetail?: string): EngageItemResult => {
    const restricted = state === 'failed' && (!custom || accountRestriction.test(reason || ''));
    const status = reason === 'login_expired' ? 'login_required' : (restricted || reason === 'login_unknown') ? 'limited' : 'idle';
    const detail = statusDetail || (reason === 'login_unknown' ? '登录状态未确认，请检查网络或页面后重试' : reason);
    const recovery = getAccount(accountId)?.recovery;
    const cooldown = recovery?.reason === 'rate_limited' && recovery.nextCheckAt > Date.now();
    const stale = acc.authority && kernelReceipt && !isKernelLeaseCurrent(kernelReceipt);
    if (cooldown || stale) {
      // The safety layer already saved the server cooldown; cleanup must not turn it into a permanent hold.
    } else if (isRecoverableFailure(reason || '') && (state === 'failed' || reason === 'login_unknown')) {
      markAccountRecovery(accountId, reason || 'network_error');
    } else if (!custom || status !== 'idle' || (getAccount(accountId)?.status === 'running' && !getAccount(accountId)?.manualDisconnect)) {
      setAccountStatus(accountId, status, status === 'limited' ? detail : undefined);
    }
    coworkLog(state === 'failed' ? 'WARN' : 'INFO', 'matrix-task', `[${diagnosticAccountAlias(accountId)}] task=${opts.taskId || '(unsaved)'} terminal`, { state, reason: detail || '', counts, chargedCredits, chargedUsd });
    const terminal = `\n\n---\n任务终态：${state === 'success' ? '成功' : state === 'skipped' ? '已跳过/停止' : '失败/待检查'}${detail ? `；原因：${detail}` : ''}\n账号：${accountId}；任务：${opts.taskId}\n`;
    for (const file of reportFiles) {
      try { fs.appendFileSync(file, terminal, 'utf8'); }
      catch { coworkLog('WARN', 'matrix-task', `[${diagnosticAccountAlias(accountId)}] task=${opts.taskId} could not append report terminal state`); }
    }
    return { accountId, state, reason, counts, chargedCredits, chargedUsd, reportResults };
  };

  try {
    if (opts.signal?.aborted) return finishRun('skipped', 'aborted');
    if (!manualRecoveryProbe) setAccountStatus(accountId, 'running');
    log('启动指纹内核');
    const launchOptions = {
      signal: workSignal,
      accountId, kernelPath: opts.kernelPath, kernelVersion: acc.kernelVersion,
      userDataDir: acc.userDataDir, fingerprint: acc.fingerprint, proxy: acc.proxy,
      // 窗口左上角常驻角标(账号名 + 代理/本机 IP):所有任务执行都显示,便于核对在哪个号、走哪个 IP(撞 IP 会红)。
      // groupTitle 同名,免得标签页显示 raw accountId。
      label: accountBadgeLabel(acc),                       // 绿色角标:账号信息(平台·昵称·备注)
      groupTitle: matrixGroupTitle(opts.platform, opts.taskId), // 蓝色 pill:🤖 平台 #任务缩写(不重复账号信息)
    };
    if (acc.authority) kernelReceipt = await acquireKernel(launchOptions);
    else await launchKernel(launchOptions);
    kernelLaunched = true;
    // 导航 URL + 登录态 key:回复粉丝(reply_fan)在【创作者中心】评论管理操作,快手须导航
    //   cp.kuaishou.com 并按创作端登录态校验(platformKey 把快手创作号映成 'kuaishou_creator',
    //   主站/创作端登录互不覆盖);互动涨粉走主站。非快手账号无 loginScope → 行为不变(主站 + 平台名)。
    const loginKey = platformKey(acc);
    const customPolicy = custom ? normalizeCustomCommentPolicy(opts.customCommentPolicy) : undefined;
    if (custom && customPolicy) custom.round.accountLimit = customPolicy.accountLimit;
    // A healthy account may inherit another share later in this round. Recheck login on
    // its first eligible video, without running the homepage warmup again.
    const customPreflight = custom?.round.homeWarmed && customPolicy?.homeWarmup === 'once'
      ? (pendingComments[0]?.url || commentPosts?.[0]?.url) : undefined;
    const navUrl = customPreflight || ((opts.taskType === 'reply_fan' && acc.loginScope)
      ? loginUrlFor(opts.platform, acc.loginScope)
      : (PLATFORM_HOME[opts.platform] || 'https://www.douyin.com/'));
    // 中止直接 return,由 finally 统一 closeKernel(原来这里 force 关 + finally 再关一次 → 双关:
    // force 会无视引用计数把同号挂着的扫码重连窗杀掉,二次关还会错放别的流程刚拿到的使用锁)。
    workSignal?.throwIfAborted();
    await kernelNavigate(accountId, navUrl);
    if (custom && !customPreflight) custom.round.homeWarmed = true;
    const protection = automationSafety.signal(accountId);
    const loginSignal = protection && workSignal ? AbortSignal.any([workSignal, protection]) : protection || workSignal;
    // TikTok 等待真实主文档后由活体检查处理 SPA 就绪，其他平台保留原渲染缓冲。
    if (loginKey !== 'tiktok') await abortableSleep(4500, loginSignal);
    loginSignal?.throwIfAborted();

    // 跑前登录态检查:cookie 过期 / 没关联 → 跳过该号 + 标「需关联」(其它号照跑),不空转。
    let loggedIn: boolean | null = null;
    try { loggedIn = await checkKernelLogin(accountId, loginKey); } catch { loggedIn = null; }
    if (acc.authority && !isKernelLeaseCurrent(kernelReceipt)) return finishRun('skipped', 'aborted'); // 读取失败保持未知
    workSignal?.throwIfAborted();
    protection?.throwIfAborted();
    // Shared login checks retain an observed challenge even if its DOM disappears later.
    const firstRestriction = getSession(accountId)?.loginRestriction;
    if (firstRestriction) return finishRun('failed', firstRestriction);
    // 首判「未登录」可能是页面还没跳转/渲染完就判了 → 再等 4s 复判一次,给慢页面第二次机会,绝不过早判死好号(铁律)。
    if (loggedIn !== true && !workSignal?.aborted) {
      await abortableSleep(4000, loginSignal);
      loginSignal?.throwIfAborted();
      try { loggedIn = await checkKernelLogin(accountId, loginKey); } catch { loggedIn = null; }
      if (acc.authority && !isKernelLeaseCurrent(kernelReceipt)) return finishRun('skipped', 'aborted');
    }
    workSignal?.throwIfAborted();
    protection?.throwIfAborted();
    const retryRestriction = getSession(accountId)?.loginRestriction;
    if (retryRestriction) return finishRun('failed', retryRestriction);
    workSignal?.throwIfAborted();
    if (loggedIn === null) {
      const restriction = await kernelEval(accountId, AUTOMATION_RESTRICTION_EXPR);
      if (acc.authority && !isKernelLeaseCurrent(kernelReceipt)) return finishRun('skipped', 'aborted');
      if (['captcha', 'login_wall', 'forbidden', 'account_flag', 'rate_limited'].includes(restriction)) {
        setAccountStatus(accountId, 'limited', `页面需要人工检查：${restriction}`);
        return finishRun('failed', restriction);
      }
      log('⚠️ 登录检测未完成，本轮跳过，保留登录资料');
      return finishRun('skipped', 'login_unknown');
    }
    if (!loggedIn) {
      setAccountStatus(accountId, 'login_required');
      log('⚠️ 登录态失效/未关联,弹窗扫码重连(其它号照跑)');
      // 命中失效 → 弹该号扫码窗(置顶 + 红角标 + 后台轮询扫码成功翻 idle),跟「刷新信息」口径对齐。
      // skipLease 自带 refCount+1 → 下面 finally 的 closeKernel 只 -1、不会关掉扫码窗;用户已点停止则不打扰。
      if (!opts.signal?.aborted) { try { await promptReloginForExpiredAccount(accountId); } catch { /* 弹窗失败不影响跳过 */ } }
      return finishRun('skipped', 'login_expired');
    }
    markAccountAlive(accountId); // 确认登录有效 → 更新活跃时间,常跑的号不进主动保活名单。
    if (manualRecoveryProbe) setAccountStatus(accountId, 'running');

    // orchestrator 需要的 task(配额从 opts.quota,缺省回落 scenario manifest 默认)。
    // reply_fan 剧本读 task.persona / funnel_phrase / funnel_probability;engage 剧本读 keywords/配额/comment_prompt。
    // 两套字段都带上(互不干扰),由各自剧本按需取。
    const task: any = {
      // ⚠️ track 传【真赛道显示名 acc.group】(如"🍲 美食 · 探店做饭")给剧本 —— 刷剧的内容匹配 AI
      //   要靠它;acc.track 是 platform_default 占位、喂给 AI 是噪音会误判(用户实测美食视频判"不相关")。
      id: accountId, keywords: effectiveKeywords(acc),
      track: (acc.group && String(acc.group).trim()) || acc.track || 'douyin_default',
      // 人设 → 复用老剧本现成的 comment_prompt 槽(comment_composer 的 user_prompt 口味提示),
      // 不另造 persona 路径(老抖音剧本本就支持,backend 零改动)。
      comment_prompt: acc.persona || '',
      // reply_fan 剧本用:persona(回复口吻)+ 引流尾巴(文案/概率)。
      persona: acc.persona || '',
      // 作者本人身份 —— 任务已指定账号,添加时就抓到并存了 nickname/displayId/boundUid(绿标即用 nickname)。
      // reply_fan 剧本据此排除"作者自己的回复",不必再去爬页面 DOM(抖音本人昵称根本不在评论管理页、
      // 小红书也不稳)。剧本优先用这些,爬页面只作兜底。
      selfNickname: acc.nickname || '',
      selfUid: acc.boundUid || acc.displayId || '',
      selfDisplayId: acc.displayId || '',
      // 引流语按模式取:各账号模式下取本账号的(未配=不带引流,【不】回落共用值);
      // 共用模式(funnelByAccount 为空)沿用任务级 funnel。reply_fan 与 engage 剧本都读这些字段自己接引流尾巴。
      ...(() => {
        const f = opts.funnelByAccount ? (opts.funnelByAccount[accountId] || {}) : (opts.funnel || {});
        return {
          funnel_phrase: f.funnel_phrase || '',
          // AI自主评论关闭 → 概率视为 100(向导已存 100,这里再兜一次)。
          funnel_probability: opts.aiComment === false ? 100 : (typeof f.funnel_probability === 'number' ? f.funnel_probability : 0),
          // AI改写引流语:各账号模式只看本账号那份,共用模式看任务级 funnel;只有 false 才下发 false。
          funnel_rewrite: (opts.funnelByAccount ? f.funnel_rewrite : opts.funnel?.funnel_rewrite) === false ? false : true,
        };
      })(),
      // AI自主评论(任务级):只有 false 才关;缺省 true = 老行为。
      ai_comment: opts.aiComment !== false,
      // 回复粉丝:单个用户评论最大回复数(仅抖音向导有这个选项)。
      max_reply_per_comment: opts.maxReplyPerComment,
      // 回复粉丝:每号本次运行最多回复几条(1~300;只管本次运行)。
      max_replies_per_run: opts.maxRepliesPerRun,
      // video_download 剧本读 task.urls(用户粘贴的待下载链接清单)。
      urls: Array.isArray(opts.urls) ? opts.urls : [],
      // comment_like 剧本读 task.comment_like_max(每号本次最多点赞数;缺省剧本按 100)。
      comment_like_max: opts.commentLikeMax,
      // comment_like 剧本读 task.comment_mode:precise(链接)/ keywords(用本账号的关键词 task.keywords 搜视频)。
      comment_mode: opts.commentMode,
      cl_custom_posts: commentPosts,
      cl_custom_pending: pendingComments,
      cl_custom_policy: customPolicy,
      cl_custom_round: custom?.round,
      cl_custom_startup_home: !!custom?.round.homeWarmed,
      cl_custom_preflight: customPreflight,
      cl_video_limit: opts.commentVideoLimit,
      cl_replies_per_video: opts.commentRepliesPerVideo,
      // 要不要点赞 / 回复(老任务 / 老客户端没有这两个字段:剧本按「点赞 + 回复」处理)。
      cl_do_like: opts.commentDoLike,
      cl_do_reply: opts.commentDoReply,
      // 矩阵账号的内容语言(中文 / English;存量号没这个字段按中文)。comment_like 回复:留言看不出语言时用它。
      account_lang: acc?.contentLang === 'en' ? 'en' : 'zh',
      // block 剧本读 task.block_targets / block_keywords。
      block_targets: blockTargetsForAcc,
      block_keywords: blockKeywordsForAcc,
      // report 剧本读 task.report_items(1-4 条 {url, reason, description},用户手填原样提交)。
      report_items: Array.isArray(opts.reportItems) ? opts.reportItems.map((it) => ({
        url: it.url, target_type: it.targetType, reason: it.reason, sub_reason: it.subReason || '', description: it.description,
      })) : [],
      report_dry_run: !!opts.reportDryRun,
      daily_like_min: q.daily_like_min, daily_like_max: q.daily_like_max,
      daily_follow_min: q.daily_follow_min, daily_follow_max: q.daily_follow_max,
      daily_comment_min: q.daily_comment_min, daily_comment_max: q.daily_comment_max,
      // 收藏配额(剧本读 daily_favorite_*;没配 = 0 = 不做收藏)
      daily_favorite_min: q.daily_favorite_min, daily_favorite_max: q.daily_favorite_max,
      // 单个作品最多评论几次(剧本读它;不下发时剧本回落 1 = 老行为)
      max_comment_per_work: q.max_comment_per_work,
      // 精准模式:链接清单 + 每条链接的动作次数。多账号共用同一批链接(各自做一遍)。
      precise_urls: Array.isArray(q.precise_urls) ? q.precise_urls : [],
      precise_like: typeof q.precise_like === 'number' ? q.precise_like : 0,
      precise_favorite: typeof q.precise_favorite === 'number' ? q.precise_favorite : 0,
      precise_follow: typeof q.precise_follow === 'number' ? q.precise_follow : 0,
      precise_comment: typeof q.precise_comment === 'number' ? q.precise_comment : 0,
      // 评论语言(强制模式;auto/空时不下发,剧本回落「跟帖子语言」)。各 *_auto_engage 剧本优先用它。
      comment_language_hint: commentLangHint(q.comment_lang),
      comment_lang: q.comment_lang || 'auto',
      // 刷剧模式透传(抖音 engage 专用;剧本在关键词为空时也会自动进入 binge)
      engage_mode: opts.engageMode || (opts.quota as any)?.engage_mode || '',
    };

    // 定向获客:把任务级配置铺进 task 顶层(tiktok_lead_engage orchestrator 读这些)。
    //   comment_prompt 覆盖上面的 acc.persona —— 获客卡有自己的评论口味输入,不复用账号人设。
    if (opts.taskType === 'lead_engage' && opts.leadEngage) {
      const le = opts.leadEngage;
      task.mode = le.mode || 'accounts';
      // 每账号独立种子(2026-08-23):有本账号的配置就用它,否则回落共用 seedAccounts(老任务)。
      //   没配的账号 seed_accounts=[] → orchestrator 会报「至少填 1 行」并跳过该号,安全。
      task.seed_accounts = (le.seedByAccount && Array.isArray(le.seedByAccount[accountId]))
        ? le.seedByAccount[accountId]
        : (Array.isArray(le.seedAccounts) ? le.seedAccounts : []);
      // 关键词模式跟随【账号自己的关键词】(与互动涨粉一致,用户要改就去改账号)。
      //   所以只有向导显式传了词才覆盖,否则保留上面 effectiveKeywords(acc) 的结果 ——
      //   直接赋空数组会把账号关键词冲掉,关键词模式就没词可搜了。
      if (Array.isArray(le.keywords) && le.keywords.length) task.keywords = le.keywords;
      task.max_leads = le.maxLeads;
      // 直播间获客(2026-10-19):剧本读 live_urls / live_dwell_minutes
      task.live_urls = Array.isArray(le.liveUrls) ? le.liveUrls : [];
      if (typeof le.liveDwellMinutes === 'number') task.live_dwell_minutes = le.liveDwellMinutes;
      // 总量口径:每人分到多少由剧本按「总量 / 实际触达人数」算(优先保证互动人数)。
      task.max_likes = le.maxLikes;
      task.max_follows = le.maxFollows;
      task.max_comments = le.maxComments;
      task.leads_per_run = le.leadsPerRun;
      task.lead_do_like = le.doLike !== false;
      task.lead_do_comment = le.doComment !== false;
      task.lead_do_follow = le.doFollow !== false;
      if (le.commentPrompt) task.comment_prompt = le.commentPrompt;
      // 仅 TikTok:获客评论是直接留在潜客的视频下(没有可以「跟着回」的留言)→ 评论语言跟【矩阵账号的内容语言】走
      //   (账号编辑里的 中文 / English;存量号没这个字段按中文)。任务里强制选了语言的仍以任务为准。
      if (opts.platform === 'tiktok' && !task.comment_language_hint) task.comment_language_hint = commentLangHint(acc?.contentLang === 'en' ? 'en' : 'zh');
    }

    // 写评论等 AI 调用的扣费也累进「本次消耗」(与动作按次扣费相加,二者是不同的账,不重复)。
    const leadFunnel = prepareTikTokLeadCommentTask(opts.platform, opts.taskType, task);
    const aiCall = opts.commentMode === 'custom'
      ? async () => { throw new Error('自定义评论模式不调用 AI'); }
      : makeAiCall(pack, authToken, log, (credits: number, usd: number) => {
        chargedCredits += credits; chargedUsd += usd;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      }, opts.signal, opts.taskType, leadFunnel);
    const browserFn: any = (command: string, params?: any, timeout?: number) => matrixCmd(accountId, command, params, timeout);
    const stateFilePath = (name: string) => {
      const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
      const safeName = String(name || 'state').replace(/[\\/:*?"<>|]/g, '_').slice(0, 100);
      return path.join(base, 'state', opts.platform || acc.platform || 'unknown', accountId, safeName + '.json');
    };
    // task-tab 对象:orchestrator 在 _activeTab 上调 browser/navigate/scroll/id。
    // 内核单页,全部路由到本账号的 CDP(之前只返回 {id} 导致 _activeTab.navigate is not a function)。
    const taskTab: any = {
      id: 'main',
      browser: browserFn,
      navigate: async (url: string) => { await kernelNavigate(accountId, url); },
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
    };

    // A failed debit stops this batch. Uncertain outcomes require reconciliation,
    // including cancellation after dispatch; no automatic repeat debit or comment.
    let chargeFailure = '';
    const doCharge = async (a: string, p: string, r?: string) => {
      if (chargeFailure || chargeFatal?.reason) return { ok: false, reason: chargeFailure || chargeFatal.reason };
      opts.signal?.throwIfAborted();
      // This context sends only prewritten workbook comments. Guard the
      // dispatch even if a remote scenario still calls its legacy debit helper.
      if (custom && opts.platform === 'tiktok' && opts.taskType === 'comment_like' && opts.commentMode === 'custom') {
        return a === 'comment' ? { ok: true, charged: 0, cost_usd: 0 }
          : { ok: false, reason: 'action_not_enabled_for_prewritten_comments' };
      }
      const session = acc.authority ? getSession(accountId) : undefined;
      const document = session?.navigation?.snapshot();
      if (acc.authority && (!session || !kernelReceipt || session.diagnosticsId !== kernelReceipt.sessionInstanceId)) {
        throw Error('storage_or_migration_hold');
      }
      const receipt = acc.authority ? registerDispatch(accountId, 'billing', {
        action: a, platform: p, refId: r, at: Date.now(),
        instance: session?.diagnosticsId, connection: document?.connectionEpoch, generation: document?.generation,
      }) : undefined;
      let res: Awaited<ReturnType<typeof chargeAction>>;
      try { res=await chargeAction(authToken, a, p, r, opts.signal); }
      catch(error) {
        if(receipt)archiveDispatchedResult(receipt,'charge_uncertain');
        throw error;
      }
      if(receipt)archiveDispatchedResult(receipt,res?.ok?'confirmed':res?.reason==='charge_uncertain'?'charge_uncertain':'rejected');
      if (res && res.ok) {
        chargedCredits += Number(res.charged) || 0;
        chargedUsd += Number(res.cost_usd) || 0;
        try { opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); } catch { /* ignore */ }
      } else {
        const why = String((res && res.reason) || 'unknown');
        chargeFailure = why;
        if (chargeFatal && !chargeFatal.reason) chargeFatal.reason = why;
        if (why === 'charge_uncertain' && !receipt) markAccountChargeUncertain(accountId, { action: a, platform: p, refId: r, at: Date.now() });
        log(why === 'charge_uncertain' ? '⛔ 扣费结果未确认，已停止；请核对账单后再恢复，不会自动重扣或重发评论'
          : /insufficient|余额/i.test(why) ? '⛔ 任务已暂停,请充值后继续' : '⛔ 任务已停止，请检查计费状态后再恢复');
        try { coworkLog('WARN', 'engageCharge', `[${accountId}] ${a} charge failed: ${why}`); } catch { /* ignore */ }
      }
      return res;
    };

    const ctx: any = {
      platform: opts.platform,
      task,
      config: opts.platform === 'tiktok' && opts.taskType === 'lead_engage'
        ? leadEngageConfig(pack?.config || {}) : (pack?.config || {}),
      manifest: pack?.manifest || {},
      appLocale: 'zh',
      aborted: () => !!workSignal?.aborted || !!chargeFatal?.reason || (!!custom && !!protection?.aborted),
      // 浏览器
      browser: browserFn,
      navigate: (url: string) => kernelNavigate(accountId, url),
      scroll: (amount?: number) => matrixCmd(accountId, 'scroll', { amount: amount || randInt(2, 4) }),
      // task-tab:内核单页,openTab=导航并返回伪 tab,getTaskTab 复用
      openTab: async (o: any) => { if (o?.url) { await kernelNavigate(accountId, o.url); await sleep(1500); } return taskTab; },
      getTaskTab: async () => taskTab,
      // 进度/日志(同时写 cowork.log,方便真机排查互动卡在哪一步)
      report: (m: string) => { log(m); try { coworkLog('INFO', 'engage', `[${accountId}] ${m}`); } catch { /* ignore */ } },
      stepStart: (s: number) => log('▶ 步骤 ' + s),
      stepLog: (_s: number, st: string, m: string) => {
        log(m);
        if (/warn|error|fail/i.test(st) || /⚠️|⛔|🛑/.test(m)) coworkLog(/error|fail/i.test(st) ? 'ERROR' : 'WARN', 'engage-step', `[${accountId}] task=${opts.taskId || '(unsaved)'} ${m}`);
      },
      stepDone: (_s: number) => {},
      startAction: (..._a: any[]) => {},
      stepResetAll: () => {},
      setActionTargets: (t: any) => {
        // reply_fan(回复粉丝)没有点赞/关注/评论配额 —— 它就是逐条回全部粉丝评论;只有 engage 才有配额。
        // 老日志写死 `赞${t.like}/关${t.follow}/评${t.comment}`,回复任务没传这三个 → 显示「赞undefined/关undefined/评undefined」误导用户。
        // 改成只打有值的字段,且 reply_fan 用「目标」(作品数)而非「配额」。
        const parts: string[] = [];
        if (typeof t.like === 'number') parts.push(`赞${t.like}`);
        if (typeof t.follow === 'number') parts.push(`关${t.follow}`);
        if (typeof t.comment === 'number') parts.push(`评${t.comment}`);
        // 收藏也要打出来:漏了的话用户配了收藏却在日志里看不到,只能靠猜。
        if (typeof t.favorite === 'number') parts.push(`藏${t.favorite}`);
        if (typeof t.note === 'number') parts.push(`作品${t.note}`);
        if (typeof t.lead_new === 'number') parts.push(`潜客${t.lead_new}`);
        if (typeof t.lead_engaged === 'number') parts.push(`触达${t.lead_engaged}`);
        if (parts.length) log(`🎯 ${opts.taskType === 'reply_fan' ? '目标' : '配额'} ${parts.join('/')}`);
        try { opts.onTargets?.(accountId, { like: t.like, follow: t.follow, comment: t.comment, favorite: t.favorite, lead_new: t.lead_new, lead_engaged: t.lead_engaged }); } catch { /* ignore */ }
      },
      addActionCount: (type: string, n: number) => { if (type in counts) (counts as any)[type] += n; opts.onItem?.({ accountId, state: 'success', counts: { ...counts }, chargedCredits, chargedUsd }); },
      finish: (status: string, error?: string) => { if (finished?.status !== 'error' && finished?.status !== 'failed') finished = { status, error }; },
      // 计费 / AI / 去重 —— 扣费成功就把 charged(积分)+ cost_usd 累加,并推一次 onItem 让「本次消耗」实时跳。
      chargeAction: doCharge,
      charge: doCharge,
      aiCall,
      getPrompt: (name: string) => { const t = pack?.prompts?.[name]; if (!t) throw new Error('Missing prompt: ' + name); return t; },
      engageHistory: history,
      // AI 衍生新词 → 存进【衍生池】(不污染原始关键词,封顶 30,满了整批换)。
      appendKeywords: (arr: string[]) => { try { appendDerivedKeywords(accountId, arr); } catch { /* ignore */ } },
      // 互动报告落盘:写到 <matrixDir>/reports/<平台>/<accountId>/ 下,返回绝对路径给编排器记日志。
      // 老空桩只返 {ok:true} 没 path → 编排器日志「报告已保存 → undefined」且文件根本没存。
      // 落盘位置:<matrixDir>/reports/<平台>/<任务id>/<账号id>/
      //   ⚠️ 中间那层【任务id】是 2026-08-22 加的。原来是 reports/<平台>/<账号id>/ ——
      //   同一平台上所有任务的产出全堆在一起,详情页「打开输出文件夹」只能打开平台级目录,
      //   用户点开看到的根本不是这个任务的东西。sidecar 的 scenario:getTaskDir 按同一套
      //   路径拼,两边必须一起改。
      //   scope:'account' 例外:定向获客的「潜客名单」是跟着【账号】长期累积的(账本口径),
      //   拆进各任务目录会变成一人一份重复副本,所以它仍写在账号级目录。
      writeReport: async (fname: string, md: string, wopts?: { scope?: 'task' | 'account' }) => {
        try {
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const platDir = path.join(base, 'reports', opts.platform || acc.platform || 'unknown');
          const dir = wopts?.scope === 'account' || !opts.taskId
            ? path.join(platDir, accountId)
            : path.join(platDir, String(opts.taskId), accountId);
          fs.mkdirSync(dir, { recursive: true });
          // 文件名去掉路径分隔符等非法字符,保留中文/字母数字,限长。
          const safeName = String(fname || 'report.md').replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          fs.writeFileSync(filePath, String(md), 'utf8');
          if (opts.taskId && wopts?.scope !== 'account' && /\.(md|txt)$/i.test(safeName)) reportFiles.add(filePath);
          coworkLog('INFO', 'engage', `[${accountId}] writeReport ok → ${filePath}`);
          return { ok: true, path: filePath, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] writeReport failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err) };
        }
      },
      // 跨运行持久状态(lead_engage 等剧本用):按【平台+账号+名字】读写一份 JSON。
      // engageHistory 只有布尔 has/remember 没法枚举,writeReport 只写不读 —— 长期增长的
      // 「潜客名单账本」这类需要读回来的状态走这对接口。落在 <matrixDir>/state/<平台>/<accountId>/<name>.json。
      readState: (name: string, options?: { strict?: boolean }) => {
        if (custom && name === CUSTOM_COMMENT_LEDGER) return custom.batch.readLedger();
        try {
          const filePath = stateFilePath(name);
          return JSON.parse(fs.readFileSync(filePath, 'utf8'));
        } catch (err: any) {
          if (options?.strict && err?.code !== 'ENOENT') throw err;
          return null;
        }
      },
      prepareCustomComment: (key: string, before: unknown) => {
        if (!custom) throw new Error('当前任务不是表格评论');
        custom.stopSignal.throwIfAborted();
        if (customPolicy && custom.round.attempted >= customPolicy.accountLimit) throw new Error('custom_comment_round_limit');
        if (!assignedCommentKeys.has(key)) throw new Error('该评论未分配给当前账号');
        const session = acc.authority ? getSession(accountId) : undefined;
        const document = session?.navigation?.snapshot();
        if (acc.authority && (!kernelReceipt || !session || session.diagnosticsId !== kernelReceipt.sessionInstanceId ||
            !document || document.state !== 'confirmed')) throw Error('storage_or_migration_hold');
        const receipt = acc.authority ? registerDispatch(accountId, 'comment', {
          action: 'comment', platform: opts.platform, at: Date.now(), ledgerKey: key, ledgerId: custom.batch.ledgerId,
          instance: session?.diagnosticsId, connection: document?.connectionEpoch, generation: document?.generation,
        }) : undefined;
        custom.batch.prepare(key, accountId, before, receipt?.id);
        if (receipt) archiveDispatchedResult(receipt, 'comment_pending');
        return { ok: true };
      },
      confirmCustomComment: (key: string, after: unknown, source: 'same_page' | 'reopened') => {
        if (!custom) throw new Error('当前任务不是表格评论');
        const dispatchId = custom.batch.confirm(key, accountId, after, source);
        if (dispatchId) {
          const receipt = getDispatchedReceipt(dispatchId);
          if (!receipt) throw Error('storage_or_migration_hold');
          archiveDispatchedResult(receipt, 'confirmed');
        }
        return { ok: true };
      },
      writeState: (name: string, obj: unknown) => {
        try {
          if (custom && name === CUSTOM_COMMENT_LEDGER) {
            throw new Error('表格评论必须通过发送意图和确认接口保存证据');
          }
          const filePath = stateFilePath(name);
          fs.mkdirSync(path.dirname(filePath), { recursive: true });
          // ⚠️ 必须原子落盘(临时文件 + rename):这份账本承载「新潜客只计费一次」的去重语义,
          //   裸 writeFileSync 若在写入中途崩溃/断电会留下截断的半截 JSON → 下次 readState
          //   parse 失败返回 null → 剧本按空账本重来 → 已收录的潜客被当新客【重复采集 + 重复扣费】。
          //   同目录 rename 在同一文件系统上是原子的(taskStore.persist 也是这个写法)。
          const tmp = filePath + '.tmp';
          fs.writeFileSync(tmp, JSON.stringify(obj), 'utf8');
          fs.renameSync(tmp, filePath);
          return { ok: true, path: filePath };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] writeState failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err) };
        }
      },
      // 视频下载落盘(video_download 剧本用:douyin/kuaishou/bilibili 直链下载):把无水印 mp4
      // 直链下到 <matrixDir>/downloads/<平台>/<accountId>/<fileName>,返回绝对路径 + 字节数。
      // ⚠️ Referer 必须按平台给(bilibili/kuaishou CDN 防盗链,给错 Referer 会 403),不能写死抖音。
      // 浏览器 UA + 5 分钟超时;点停止(signal abort)立即中断本次下载。
      downloadVideoToDisk: async (videoUrl: string, o?: { fileName?: string; outputDir?: string }) => {
        try {
          if (!videoUrl || !/^https?:\/\//i.test(videoUrl)) return { ok: false, reason: 'invalid_url' };
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const dir = o?.outputDir || path.join(base, 'downloads', opts.platform || acc.platform || 'unknown', accountId);
          fs.mkdirSync(dir, { recursive: true });
          const safeName = String(o?.fileName || `video_${Date.now()}.mp4`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          const referer = DOWNLOAD_REFERER[opts.platform || ''] || PLATFORM_HOME[opts.platform || ''] || 'https://www.douyin.com/';
          const ctrl = new AbortController();
          const to = setTimeout(() => ctrl.abort(), 5 * 60 * 1000);
          const onAbort = () => ctrl.abort();
          if (opts.signal?.aborted) ctrl.abort();
          else opts.signal?.addEventListener('abort', onAbort, { once: true });
          let buf: Buffer;
          try {
            const resp = await fetch(videoUrl, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36', Referer: referer }, signal: ctrl.signal });
            if (!resp.ok) return { ok: false, reason: `http_${resp.status}` };
            buf = Buffer.from(await resp.arrayBuffer());
          } finally {
            clearTimeout(to);
            opts.signal?.removeEventListener('abort', onAbort);
          }
          if (!buf.length) return { ok: false, reason: 'empty_body' };
          fs.writeFileSync(filePath, buf);
          coworkLog('INFO', 'engage', `[${accountId}] downloadVideoToDisk ok → ${filePath} (${buf.length}B)`);
          return { ok: true, filePath, size: buf.length, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] downloadVideoToDisk failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err).slice(0, 120) };
        }
      },
      // 二进制资产落盘(tiktok 视频下载剧本用):把 base64 数据(剧本先用浏览器/Node fetch 拿到字节)
      // 写到 <matrixDir>/downloads/<平台>/<accountId>/<subdir>/<fileName>,返回绝对路径。
      // tiktok 不走 downloadVideoToDisk(它要浏览器 main_world_fetch_api base64 + 多级 fallback 自己拿字节)。
      writeAsset: async (fileName: string, base64Data: string, o?: { subdir?: string }) => {
        try {
          const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
          const dir = path.join(base, 'downloads', opts.platform || acc.platform || 'unknown', accountId, String(o?.subdir || '').replace(/[\\/:*?"<>|]/g, '_'));
          fs.mkdirSync(dir, { recursive: true });
          const safeName = String(fileName || `asset_${Date.now()}`).replace(/[\\/:*?"<>|]/g, '_').slice(0, 200);
          const filePath = path.join(dir, safeName);
          const buf = Buffer.from(String(base64Data || ''), 'base64');
          if (!buf.length) return { ok: false, reason: 'empty_data' };
          fs.writeFileSync(filePath, buf);
          coworkLog('INFO', 'engage', `[${accountId}] writeAsset ok → ${filePath} (${buf.length}B)`);
          return { ok: true, path: filePath, size: buf.length, dir };
        } catch (err: any) {
          coworkLog('WARN', 'engage', `[${accountId}] writeAsset failed: ${String(err?.message || err)}`);
          return { ok: false, reason: String(err?.message || err).slice(0, 120) };
        }
      },
      // 工具。sleep 可被停止打断:点停止后 abort 立即唤醒,不再傻等动作间延时跑完(否则停了要等当前 sleep 结束才退)。
      sleep: (min: number, max?: number) => abortableSleep(max ? randInt(min, max) : min, custom ? loginSignal : workSignal),
      // 撞验证码不直接停:提示用户在【该账号窗口】手动过,轮询到消失就继续;超时/停止才放弃。
      //   返回 { ok:true } 过了 / { ok:false, reason } 超时或中止。窗口对用户可见(带角标),手动滑最自然。
      waitForCaptchaCleared: async (o?: { maxMs?: number }) => {
        const maxMs = (o && o.maxMs) || 180000; // 默认最多等 3 分钟
        const startedWait = Date.now();
        let notified = false;
        while (Date.now() - startedWait < maxMs) {
          if (workSignal?.aborted) return { ok: false, reason: 'aborted' };
          let showing = false;
          try { const r: any = await matrixCmd(accountId, 'cdp_eval', { expression: CAPTCHA_DETECT_EXPR }); showing = !!(r && (r.value === true || r.value === 'true')); } catch { showing = false; }
          if (!showing) { if (notified) log('✅ 验证码已通过,继续任务'); return { ok: true }; }
          if (!notified) { notified = true; log('🧩 检测到验证码,请在该账号浏览器窗口【手动完成验证】(最多等 ' + Math.round(maxMs / 60000) + ' 分钟,过了自动继续)…'); }
          await abortableSleep(4000, workSignal);
        }
        log('⏱ 验证码等待超时(' + Math.round(maxMs / 60000) + ' 分钟未完成),放弃本号');
        return { ok: false, reason: 'captcha_timeout' };
      },
      randInt,
      log: (m: string) => coworkLog('INFO', 'engage-orch', m),
    };

    const code = pack?.orchestrator;
    if (!code) return finishRun('failed', 'no_orchestrator');
    const fn = new AsyncFunction('ctx', code);
    const orchRet: any = await runAutomationScript(accountId, fn, ctx, kernelReceipt);
    if (opts.signal?.aborted) return finishRun('skipped', 'aborted');
    if (custom) protection?.throwIfAborted();
    // report 剧本回传逐条结果 → 带在 item 上(其它剧本的返回值不关心,保持原样)
    const reportResults = opts.taskType === 'report' && Array.isArray(orchRet?.results) ? orchRet.results : undefined;

    if (chargeFatal && chargeFatal.reason) {
      return finishRun('failed', 'charge_failed:' + chargeFatal.reason);
    }
    const fin = finished as { status: string; error?: string } | null;
    if (fin?.status === 'error' || fin?.status === 'failed' || orchRet?.status === 'failed' || orchRet?.status === 'error') return finishRun('failed', fin?.error || orchRet?.reason || 'remote_error');
    if (custom && fin?.error === 'custom_comment_round_limit') return finishRun('success', fin.error);
    coworkLog('INFO', 'engage', `[${accountId}] done 赞${counts.like}/关${counts.follow}/评${counts.comment} · 扣费 ${chargedCredits}积分`);
    return finishRun('success', undefined, reportResults);
  } catch (e: any) {
    if (opts.signal?.aborted) return finishRun('skipped', 'aborted');
    if (custom && chargeFatal?.reason) return finishRun('failed', 'charge_failed:' + chargeFatal.reason);
    if (custom?.stopSignal.aborted) return finishRun('skipped', 'aborted');
    const _emsg = String(e?.message || e);
    const browserFailure = e instanceof KernelNavigationError || _emsg === NO_KERNEL_ERROR || /^kernel_start:[a-z_]+$/.test(_emsg);
    coworkLog('ERROR', 'engage', `[${diagnosticAccountAlias(accountId)}] threw: ${browserFailure ? _emsg : String(e?.stack || e?.message || e).slice(0, 300)}`);
    // ⚠️ 之前只写 cowork.log 文件、没调用户可见的 log() → 内核启动/导航/剧本一抛异常,界面就停在
    //   「启动指纹内核」毫无原因(用户实测快手/tiktok「跑一会没反应就停」)。这里把原因打给用户看。
    log((e instanceof AutomationSafetyError ? '🛑 本轮已暂停,该号停止(其它号按各自状态执行):' : '🛑 运行出错,该号跳过(其它号照跑):')
      + (_emsg.indexOf(NO_KERNEL_ERROR) >= 0 ? '指纹内核未就绪/未下载 — 请在「我的矩阵账号」下载内核' : _emsg.slice(0, 160)));
    if (e instanceof AutomationSafetyError && accountRestriction.test(e.code || '')) return finishRun('failed', e.code, undefined, e.reason);
    if (e instanceof KernelNavigationError) return finishRun('failed', e.code === 'http_407' ? 'proxy_auth_required' : `navigation:${e.code}`);
    if (custom && _emsg === '验证码未完成') return finishRun('failed', 'captcha_timeout');
    // 抛错前可能已经扣过几笔 —— 钱已花,照样回传,别让「已扣的费」从消耗统计里消失。
    return finishRun('failed', 'engage_threw:' + _emsg.slice(0, 140));
  } finally {
    // 完成后留时间让用户检查浏览器里的结果再关窗(点「停止」立即关、不等)。
    // 普通 20s;撞到登录墙/验证墙留 60s,好让用户当场手动登录/过验证(2026-07-06 用户要求)。
    const holdMs = inspectHoldMs(finished?.error);
    await abortableSleep(holdMs, workSignal);
    if (kernelLaunched) {
      try {
        if (kernelReceipt) releaseKernel(kernelReceipt);
        else closeKernel(accountId);
      } catch { /* ignore */ }
    }
  }
}

async function runPool(ids: string[], k: number, worker: (id: string) => Promise<EngageItemResult>, onItem?: (i: EngageItemResult) => void): Promise<EngageItemResult[]> {
  const results: EngageItemResult[] = new Array(ids.length);
  let cursor = 0;
  async function lane() {
    while (true) {
      const i = cursor++;
      if (i >= ids.length) return;
      const r = await worker(ids[i]);
      results[i] = r;
      try { onItem?.(r); } catch { /* ignore */ }
    }
  }
  await Promise.all(Array.from({ length: Math.max(1, Math.min(k, ids.length)) }, () => lane()));
  return results;
}

export interface EngageReport {
  platform: string;
  total: number;
  success: number;
  failed: number;
  skipped: number;
  items: EngageItemResult[];
  customComments?: CustomCommentSummary;
  chargeFailureReason?: string;
}

export async function runEngageTask(opts: EngageTaskOptions): Promise<EngageReport> {
  const customComments = opts.platform === 'tiktok' && opts.taskType === 'comment_like' && opts.commentMode === 'custom';
  if (customComments) {
    if (!opts.taskId) throw new Error('自定义评论需要先保存任务');
    opts = { ...opts, commentPosts: validatedCommentPosts(opts.commentPosts), commentDoLike: false, commentDoReply: false };
  }
  const keywordLimits = opts.platform === 'tiktok' && opts.taskType === 'comment_like' && opts.commentMode === 'keywords';
  if (keywordLimits) opts = { ...opts, ...commentLikeLimits(opts) };
  // 内核校验(手动 + 定时统一兜底):没装指纹浏览器且没显式路径 → 整个任务【不跑】,
  // 抛 NO_KERNEL 让上层弹「去下载」。否则定时任务会空转、每个号都失败。
  if (!opts.kernelPath && !installedKernelPath()) {
    throw new Error(`${NO_KERNEL_ERROR}: 指纹浏览器内核未安装,请先到「我的矩阵账号」下载内核`);
  }
  // 平台 → 后端 backend/matrix/scenarios 的剧本 id。币安是 binance_SQUARE_auto_engage(非 binance_auto_engage),
  // 别的都是 `<平台>_auto_engage`。漏了币安这个特例会取不到剧本 → 指纹浏览器都不唤起、无日志。
  const ENGAGE_SCENARIO_ID: Record<string, string> = { binance: 'binance_square_auto_engage' };
  // reply_fan 等非互动任务显式传 scenarioId(如 douyin_reply_fans_comment);engage 按平台推。
  // 定向获客固定用 tiktok_lead_engage(目前只 TikTok 有这张卡)。
  const scenarioId = opts.scenarioId
    || (opts.taskType === 'lead_engage' ? `${opts.platform}_lead_engage` : '')
    || (opts.taskType === 'comment_like' ? `${opts.platform}_comment_like` : '')
    || (opts.taskType === 'block' ? `${opts.platform}_block` : '')
    || ENGAGE_SCENARIO_ID[opts.platform] || `${opts.platform}_auto_engage`;
  // 举报剧本要带登录 token(后端按白名单 UID 放行);其它剧本保持原样不带。
  const packToken = opts.taskType === 'report' ? (opts.authToken || getNoobClawAuthToken() || undefined) : undefined;
  const pack = withTikTokCommentPrompts(await fetchEngagePack(scenarioId, packToken, opts.signal), opts.platform, opts.taskType);
  if (keywordLimits && pack?.orchestrator) pack.orchestrator = withTikTokKeywordLimits(pack.orchestrator);
  if (opts.platform === 'tiktok' && opts.taskType === 'comment_like' && pack?.orchestrator) {
    if (customComments) {
      pack.orchestrator = withTikTokCustomComments(pack.orchestrator);
    } else {
      pack.prompts.comment_intent = TIKTOK_COMMENT_INTENT_PROMPT;
      pack.orchestrator = withTikTokBuyerComments(pack.orchestrator);
    }
  }
  if (pack && pack.__denied) {
    const items = opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: 'report_not_whitelisted' }));
    for (const it of items) {
      try { opts.onLog?.(it.accountId, '⛔ 你的账号未开通「举报」功能(需管理员加入白名单),本次未执行'); } catch { /* ignore */ }
      try { opts.onItem?.(it); } catch { /* ignore */ }
    }
    return { platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length, items };
  }
  if (!pack || !pack.orchestrator) {
    // ⚠️ 必须发日志+item 再返回:这条路以前【静默】返回 → UI 永远停在「已加入运行队列…」装死
    //   (任务实际已完成),用户以为卡住(真机实测,常见诱因是开关 VPN 时对 api 的请求瞬断)。
    const items = opts.accountIds.map((id) => ({ accountId: id, state: 'skipped' as const, reason: pack?.__unavailable || 'no_scenario(后端未部署)' }));
    for (const it of items) {
      try { opts.onLog?.(it.accountId, `❌ 取不到互动剧本「${scenarioId}」：${it.reason}。本次跳过，请查看任务状态与下次运行时间`); } catch { /* ignore */ }
      try { opts.onItem?.(it); } catch { /* ignore */ }
    }
    return { platform: opts.platform, total: opts.accountIds.length, success: 0, failed: 0, skipped: opts.accountIds.length, items };
  }
  if (opts.platform === 'tiktok' && opts.taskType === 'lead_engage') {
    pack.orchestrator = patchTikTokLeadScript(pack.orchestrator);
  }
  coworkLog('INFO', 'engageRunner', `${opts.taskType || 'engage'} ${opts.platform} x${opts.accountIds.length} (${scenarioId})`);
  const customStop = customComments ? new AbortController() : undefined;
  let chargeReason = '';
  const chargeFatal = {
    get reason() { return chargeReason; },
    set reason(reason: string) {
      chargeReason = reason;
      if (reason) customStop?.abort();
    },
  };
  let customSummary: CustomCommentSummary | undefined;
  const items = customComments ? await withCustomCommentBatch(
    process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'),
    opts.commentPosts,
    async batch => {
      const results = new Map<string, EngageItemResult>();
      const configured = [...new Set(opts.commentPostAccountIds ?? opts.accountIds)];
      const runnable = new Set(opts.accountIds);
      const unavailable = (id: string) => runnable.has(id) ? customCommentAccountUnavailable(getAccount(id), opts.manualRetry)
        : 'account_unavailable_or_signing_in';
      const stopSignal = opts.signal
        ? AbortSignal.any([opts.signal, customStop!.signal]) : customStop!.signal;
      const active = new Map<string, Promise<void>>();
      const released = new Set<string>();
      const retained = new Set<string>();
      const rounds = new Map<string, CommentRound>();
      const releasesShare = /^(?:login_expired|login_required|manual_disconnect|account_not_found|account_banned|account_limited|charge_uncertain|captcha(?:_timeout)?|login_wall|forbidden|account_flag|rate_limited|custom_comment_daily_limit)$/;
      const independentlyUnavailable = /^(?:account_not_found|account_banned|manual_disconnect|binding_conflict|charge_uncertain|login_required)$/;
      let savedPlan = opts.commentAssignmentPlan?.version === 2 ? opts.commentAssignmentPlan : undefined;
      const planForIdleAccounts = () => batch.plan(
        configured.filter(id => !active.has(id) && !released.has(id) && !retained.has(id) && !unavailable(id)),
        savedPlan, [...active.keys(), ...retained], savedPlan ? undefined : commentAssignmentRandom(opts.taskId!),
      );
      const reportLog = (id: string, msg: string) => { try { opts.onLog?.(id, msg); } catch { /* Progress does not own publication. */ } };
      const reportTarget = (id: string, comment: number) => {
        try { opts.onTargets?.(id, { like: 0, follow: 0, comment }); } catch { /* Progress does not own publication. */ }
      };
      const reportItem = (item: EngageItemResult) => { try { opts.onItem?.(item); } catch { /* Progress does not own publication. */ } };
      const savePlan = (next: ReturnType<CustomCommentBatch['plan']>) => {
        const previousOwners = savedPlan?.owners;
        if (!previousOwners || Object.keys(previousOwners).length !== next.owners.size
          || [...next.owners].some(([key, id]) => previousOwners[key] !== id)) {
          if (!opts.onCommentAssignmentPlan) throw new Error('表格评论分工无法保存，本次未发送');
          opts.onCommentAssignmentPlan(next.savedPlan);
          const transfers = new Map<string, number>();
          const ledger = batch.readLedger();
          for (const [key, account] of next.owners) {
            if (!ledger[key] && previousOwners?.[key] && previousOwners[key] !== account) {
              transfers.set(account, (transfers.get(account) ?? 0) + 1);
            }
          }
          for (const [account, count] of transfers) reportLog(account, `分工已更新：接手 ${count} 条明确未发送的评论`);
          savedPlan = next.savedPlan;
        }
      };
      const execute = async (id: string, posts: CommentPost[], pending: number) => {
        const previous = results.get(id);
        const round = rounds.get(id) ?? { attempted: 0, confirmed: 0, restedAt: 0 };
        rounds.set(id, round);
        const cumulative = (item: EngageItemResult): EngageItemResult => ({
          ...item,
          counts: {
            like: (previous?.counts?.like ?? 0) + (item.counts?.like ?? 0),
            follow: (previous?.counts?.follow ?? 0) + (item.counts?.follow ?? 0),
            comment: (previous?.counts?.comment ?? 0) + (item.counts?.comment ?? 0),
          },
          chargedCredits: (previous?.chargedCredits ?? 0) + (item.chargedCredits ?? 0),
          chargedUsd: (previous?.chargedUsd ?? 0) + (item.chargedUsd ?? 0),
        });
        reportTarget(id, (previous?.counts?.comment ?? 0) + posts.length + pending);
        reportLog(id, `开始执行：${new Set(posts.map(post => post.url)).size} 个视频、${posts.length} 条未发送评论，另有 ${pending} 条待核验`);
        let progress: EngageItemResult | undefined;
        let result: EngageItemResult;
        try {
          result = await runOne({
            ...opts,
            onTargets: () => {},
            onItem: item => { progress = item; reportItem(cumulative(item)); },
          }, pack, id, chargeFatal, { batch, posts, stopSignal, round });
        } catch (error) {
          const detail = String(error).slice(0, 160);
          reportLog(id, '账号执行失败：' + detail);
          result = { ...progress, accountId: id, state: 'failed', reason: 'engage_threw:' + detail };
        }
        const ledger = batch.readLedger();
        const remaining = posts.filter(post => !ledger[commentPostKey(post)]).length;
        // Ownership follows the consumed round budget, even if a daily or protection
        // failure supplies the terminal reason. Only uncapped shares may be released.
        if (round.accountLimit !== undefined && round.attempted >= round.accountLimit) retained.add(id);
        else if (releasesShare.test(result.reason || '') || independentlyUnavailable.test(unavailable(id) || '')) released.add(id);
        else if (result.reason === 'custom_comment_round_limit' || result.state !== 'success' || remaining) retained.add(id);
        const combined = cumulative(result);
        results.set(id, combined);
        reportTarget(id, (combined.counts?.comment ?? 0) + batch.pendingFor(id).length + (retained.has(id) ? remaining : 0));
        reportItem(combined);
      };

      // The scheduler alone starts accounts and saves plans. An active account retains
      // its share until runOne has completed cleanup and released the account lease.
      let nextStartAt = -Infinity;
      try {
        while (!stopSignal.aborted) {
          const next = planForIdleAccounts();
          const ready = configured.filter(id => next.assignments.has(id)
            && (next.assignments.get(id)!.length || (!results.has(id) && batch.pendingFor(id).length)));
          const id = ready.find(id => !results.has(id)) ?? ready[0];
          if (!id) {
            if (!active.size) {
              savePlan(next);
              break;
            }
            await Promise.race(active.values());
            continue;
          }
          const delay = nextStartAt - performance.now();
          if (delay > 0) {
            await abortableSleep(Math.ceil(delay), stopSignal);
            continue; // Recheck stop, account eligibility and ledger after waiting.
          }
          savePlan(next);
          if (stopSignal.aborted) break;
          nextStartAt = performance.now() + randInt(3000, 5000);
          const attempt = execute(id, next.assignments.get(id)!, batch.pendingFor(id).length)
            .finally(() => active.delete(id));
          active.set(id, attempt);
        }
      } catch (error) {
        customStop!.abort();
        throw error;
      } finally {
        await Promise.allSettled(active.values());
      }
      for (const id of configured) {
        if (results.has(id)) continue;
        const reason = opts.signal?.aborted ? 'aborted' : chargeFatal.reason ? 'charge_failed:' + chargeFatal.reason
          : unavailable(id) || 'no_custom_comments';
        const result: EngageItemResult = { accountId: id, state: 'skipped', reason };
        results.set(id, result);
        reportTarget(id, 0);
        if (reason !== 'no_custom_comments') reportLog(id, '本账号未启动：' + reason);
        reportItem(result);
      }
      customSummary = batch.summary();
      const capped = [...results.values()].filter(item => item.state === 'success' && item.reason === 'custom_comment_round_limit');
      if (capped.length && ![...results.values()].some(item => item.state === 'failed')) {
        const cappedIds = new Set(capped.map(item => item.accountId));
        const ledger = batch.readLedger();
        const unattempted = batch.posts.filter(post => !ledger[commentPostKey(post)]);
        const outsideCap = capped.reduce((count, item) => count + batch.pendingFor(item.accountId).length, 0) !== customSummary.pending;
        if (!outsideCap && unattempted.every(post => cappedIds.has(savedPlan?.owners?.[commentPostKey(post)] || ''))) {
          customSummary = { ...customSummary, roundLimitReached: true };
        }
      }
      const summary = customSummary;
      if (configured.length) reportLog(configured[0], `表格评论总计 ${summary.total} 条：已确认 ${summary.confirmed}，待核验 ${summary.pending}，未执行 ${summary.remaining}`);
      return configured.map(id => results.get(id)!);
    },
  ) : await runPool(opts.accountIds, Math.max(1, Math.min(opts.concurrency ?? 3, 10)), (id) => runOne(opts, pack, id, chargeFatal), opts.onItem);
  return {
    platform: opts.platform, total: items.length,
    success: items.filter((x) => x.state === 'success').length,
    failed: items.filter((x) => x.state === 'failed').length,
    skipped: items.filter((x) => x.state === 'skipped').length,
    items,
    ...(customSummary ? { customComments: customSummary } : {}),
    ...(customComments && chargeFatal.reason ? { chargeFailureReason: chargeFatal.reason } : {}),
  };
}
