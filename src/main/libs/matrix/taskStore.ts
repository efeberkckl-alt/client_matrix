/**
 * 矩阵任务存储 —— 本地 JSON,与 accounts.json 同目录(见 accountManager)。
 *
 * 约束(产品定义):每平台最多 5 个任务、同平台同类型只允许 1 个(重复无意义);
 * 全局同时只跑 1 个 —— 那个「运行时锁」在 sidecar 侧维护,不在这里。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { randomUUID } from 'crypto';
import { coworkLog } from '../coworkLogger';
import { nextRunAt } from './matrixSchedule';
import { isRecoverableFailure, recoveryDelay } from './recovery';
import { commentLikeLimits } from './commentLikeConfig';
import { validatedCommentPosts, type CommentLikeMode, type CommentPost } from '../../../types/matrixCommentPosts';
import { normalizeCustomCommentPolicy, type CustomCommentPolicy } from '../../../types/matrixCommentPolicy';
import { commentAssignmentRandom, commentPostKey, commentWorkbookContent, type CommentAssignmentPreview, type SavedCommentAssignmentPlan } from '../../../types/matrixCommentPlan';
import { CustomCommentBatch } from './customCommentBatch';
import { REPORT_LIMITS, COMMENT_LIKE_LIMITS, BLOCK_LIMITS } from './types';
import type { ReportItem, ReportItemResult } from './types';
import { validateReportItem } from './reportTaxonomy';
import { folderPostNextRunAt, normSlots } from './folderPost';
import type { FolderPostConfig } from './types';
import type { MatrixTask, EngageQuota, ReplyFanConfig, ImageTextConfig, ViralRewriteConfig, TweetPostConfig, BinancePostConfig, FacebookPostConfig, RedditPostConfig, InstagramPostConfig, BinanceRepostConfig, LeadEngageConfig, MatrixTaskType, MatrixTaskFrequency } from './types';

/** 任务启用且非 once 才排下次运行;否则清空(手动触发)。 */
function planned(t: { enabled: boolean; frequency: MatrixTaskFrequency; type?: MatrixTaskType; id?: string; accountIds?: string[]; folderPost?: FolderPostConfig }, fromTs: number, isFirst: boolean): number | undefined {
  // 文件夹定时发布:不按频率,按各号时段排(到点没发的 → 现在;否则最近的未来时段)。
  if (t.type === 'folder_post') return t.enabled && t.id ? folderPostNextRunAt(t.id, t.accountIds || [], t.folderPost, fromTs) : undefined;
  return t.enabled && t.frequency !== 'once' ? nextRunAt(t.frequency, fromTs, isFirst) : undefined;
}

function baseDir(): string { return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix'); }
function storeFile(): string { return path.join(baseDir(), 'tasks.json'); }

const MAX_PER_PLATFORM = 5;
let cache: MatrixTask[] | null = null;

// 老任务类型归一。交易所广场四家(gate/okx/bitget/bybit)的发帖/搬运向导曾把【任务类型】
// 拼成 `${platform}_post` / `${platform}_repost` 存进 tasks.json —— 这不是合法的 MatrixTaskType,
// 跑起来直接 unsupported_task_type(用户实测 gate 自动发帖)。新建路径已修,但【已经存盘的老任务】
// 里还是坏值,不归一就永远跑不起来,而且重复校验按 type 比,还会让用户重复建一条。
// ⚠️ 只认这 4 个交易所前缀:x_post / facebook_post / reddit_post / instagram_post 本身就是合法类型。
const LEGACY_EXCHANGE_TYPE = /^(gate|okx|bitget|bybit)_(post|repost)$/;
function normalizeTaskType(t: any): any {
  const m = LEGACY_EXCHANGE_TYPE.exec(String(t?.type || ''));
  if (!m) return t;
  return { ...t, type: m[2] === 'repost' ? 'binance_repost' : 'binance_post' };
}

export function loadTasks(): MatrixTask[] {
  if (cache) return cache;
  const f = storeFile();
  if (!fs.existsSync(f)) { cache = []; return cache; }
  try {
    const arr = JSON.parse(fs.readFileSync(f, 'utf8'));
    cache = Array.isArray(arr) ? arr.map(normalizeTaskType) : [];
  } catch (e) {
    // 坏文件备份留证,不静默清空。
    try { fs.copyFileSync(f, `${f}.corrupt.${Date.now()}`); } catch { /* ignore */ }
    coworkLog('ERROR', 'taskStore', `tasks.json parse failed, backed up; starting empty: ${String(e)}`);
    cache = [];
  }
  return cache;
}

function persist(tasks = cache || []): void {
  fs.mkdirSync(baseDir(), { recursive: true });
  const f = storeFile();
  const tmp = `${f}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(tasks, null, 2), 'utf8');
  fs.renameSync(tmp, f);
}

export function listTasks(): MatrixTask[] { return [...loadTasks()]; }
export function getTask(id: string, readOnly = false): MatrixTask | undefined {
  if (!readOnly || cache) return loadTasks().find(task => task.id === id);
  try {
    const rows = JSON.parse(fs.readFileSync(storeFile(), 'utf8'));
    return Array.isArray(rows) ? rows.map(normalizeTaskType).find(task => task.id === id) : undefined;
  } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
}

export function previewCustomCommentAssignments(input: { id?: string; commentPosts: unknown; accountIds: string[]; seed?: string },
  availableIds: readonly string[]): CommentAssignmentPreview {
  const batch = new CustomCommentBatch(baseDir(), input.commentPosts, { readOnly: true, reconcile: true });
  const task = input.id ? getTask(input.id, true) : undefined;
  const previous = task?.commentAssignmentPlan?.version === 2 ? task.commentAssignmentPlan : undefined;
  const selected = new Set(input.accountIds);
  const availableAccountIds = [...new Set(availableIds)].filter(id => selected.has(id)).sort();
  const sameSelection = task?.commentMode === 'custom' && selected.size === new Set(task.accountIds).size && task.accountIds.every(id => selected.has(id));
  const sameDraft = task && sameSelection && commentWorkbookContent(task.commentPosts) === commentWorkbookContent(batch.posts);
  const seed = typeof input.seed === 'string' && /^[a-f0-9-]{36}$/.test(input.seed) ? input.seed : randomUUID();
  const ledger = batch.assignmentLedger();
  if (sameDraft && previous) return { seed, plan: previous, availableAccountIds, ledger };

  const retainedPlan = previous && {
    ...previous,
    owners: Object.fromEntries(Object.entries(previous.owners).filter(([, id]) => id && selected.has(id))),
  };
  const planned = batch.plan(availableAccountIds, retainedPlan, undefined, commentAssignmentRandom(sameDraft ? task.id : seed));
  return { seed, plan: planned.savedPlan, availableAccountIds, ledger };
}

export function setCustomCommentAssignmentPlan(task: MatrixTask, plan: SavedCommentAssignmentPlan): void {
  const tasks = loadTasks();
  if (!tasks.includes(task)) throw new Error('表格评论任务已修改，请重新打开任务');
  persist(tasks.map(current => current === task ? { ...current, commentAssignmentPlan: plan } : current));
  task.commentAssignmentPlan = plan;
}

export interface SaveTaskInput {
  id?: string;                       // 传则更新,不传则新建
  platform: string;
  type: MatrixTaskType;
  name?: string;
  enabled?: boolean;
  accountIds: string[];
  quota?: EngageQuota;             // engage 必填;reply_fan / video_download 可省(存空对象)
  funnel?: ReplyFanConfig;         // reply_fan 用:引流尾巴配置
  // 各账号独立引流语:对象=各账号模式;null=显式清掉(切回共用);undefined=更新时保留旧值。
  funnelByAccount?: Record<string, ReplyFanConfig> | null;
  // AI自主评论:false = 关;true = 开(落库时清掉字段,缺省即开);undefined = 更新时保留旧值。
  ai_comment?: boolean;
  maxReplyPerComment?: number;
  maxRepliesPerRun?: number;          // reply_fan(抖音)用:每号本次运行最多回复几条
  imageText?: ImageTextConfig;     // image_text 用:图文创作配置
  viralRewrite?: ViralRewriteConfig; // viral_rewrite 用:爆款仿写配置
  tweetPost?: TweetPostConfig;     // x_post 用:自动发推配置
  binancePost?: BinancePostConfig; // binance_post 用:币安广场自动发帖配置
  facebookPost?: FacebookPostConfig; // facebook_post 用:Facebook 自动发帖配置(含数据源)
  redditPost?: RedditPostConfig;   // reddit_post 用:Reddit 自动发帖配置(含数据源 + subreddit)
  instagramPost?: InstagramPostConfig; // instagram_post 用:Instagram 自动发帖配置(含数据源,图必带)
  binanceRepost?: BinanceRepostConfig; // binance_repost 用:币安广场批量搬运配置
  leadEngage?: LeadEngageConfig;   // lead_engage 用:定向获客配置
  urls?: string[];                 // video_download 用:待下载视频链接清单
  reportItems?: ReportItem[];      // report 用:1-4 条举报条目
  commentLikeMax?: number;         // comment_like 用:每号每次最多点赞数(1-5000)
  commentMode?: CommentLikeMode;
  commentPosts?: CommentPost[];
  customCommentPolicy?: CustomCommentPolicy;
  commentAssignmentPreview?: CommentAssignmentPreview;
  commentDoLike?: boolean;
  commentDoReply?: boolean;
  commentVideoLimit?: number;
  commentRepliesPerVideo?: number;
  blockTargets?: string[];         // block 用:名单
  blockKeywords?: string[];        // block 用:关键词
  blockMode?: 'precise' | 'keyword'; // block 用:模式(缺省=老任务)
  folderPost?: FolderPostConfig;    // folder_post 用:各号时段 + 随机浮动
  blockTargetsByAccount?: Record<string, string[]>; // block 精准模式:各账号名单
  concurrency?: number;
  frequency: MatrixTaskFrequency;
}
export interface SaveTaskResult { ok: boolean; error?: string; task?: MatrixTask }

// ── 举报(report)合规校验 ──────────────────────────────────────────────
// 产品拍板的硬约束,存盘时就拦死(UI 也会拦,这里是最后一道):
//   · 目前仅抖音;只能选【1 个】账号;1-4 条链接;每条必须有合法原因 + 5-200 字描述
//   · 频率恒 'once'、enabled 恒 false(永不进定时调度);同时只开 1 个窗口
//   · 只能手动触发,每次触发逐条只提交一次(不重试);可编辑、可再次手动运行
const REPORT_PLATFORMS = ['douyin'];
// 返回值用宽松对象而非判别联合:本项目 tsconfig 不开 strictNullChecks,`ok: true|false` 判别联合不会收窄(CI 报 TS2339)。
function validateReport(input: SaveTaskInput): { ok: boolean; items?: ReportItem[]; error?: string } {
  if (!REPORT_PLATFORMS.includes(input.platform)) return { ok: false, error: 'report_platform_unsupported' };
  const ids = (input.accountIds || []).filter(Boolean);
  // 2026-10-18 用户要求:支持选多个执行账号(每个号各自把这些条目逐条提交一次)
  if (ids.length < 1) return { ok: false, error: 'report_requires_account' };
  const raw = Array.isArray(input.reportItems) ? input.reportItems : [];
  if (raw.length < REPORT_LIMITS.minItems || raw.length > REPORT_LIMITS.maxItems) return { ok: false, error: 'report_item_count' };
  const items: ReportItem[] = [];
  const seen = new Set<string>();
  for (const it of raw) {
    // 与渲染层向导同一套规则(reportTaxonomy.validateReportItem):抖音原文原因/具体类型、类型与链接一致、描述 5-200 字
    const err = validateReportItem(it as any);
    if (err) return { ok: false, error: err };
    const url = String(it.url).trim();
    if (seen.has(url)) return { ok: false, error: 'report_duplicate_url' };
    seen.add(url);
    items.push({
      url,
      targetType: it.targetType,
      reason: String(it.reason),
      subReason: it.subReason ? String(it.subReason) : undefined,
      description: String(it.description).trim(),
    });
  }
  return { ok: true, items };
}

/** 抖音Report:记录最近一次正式执行时间(展示用;不锁定,任务可编辑、可再次手动运行)。 */
export function markReportExecuted(id: string): void {
  const t = getTask(id);
  if (!t || t.type !== 'report') return;
  t.reportExecutedAt = Date.now();
  t.reportResults = []; // 新一轮正式执行:清掉上一轮结果,各号跑完再逐个写入
  t.enabled = false;
  t.nextPlannedRunAt = undefined;
  persist();
}

/** 保存 Report 逐条结果(剧本回传)。dryRun=试运行结果(不影响执行锁)。 */
export function setReportResults(id: string, results: ReportItemResult[], dryRun: boolean, accountId?: string): void {
  const t = getTask(id);
  if (!t || t.type !== 'report') return;
  const clean = (Array.isArray(results) ? results : []).slice(0, REPORT_LIMITS.maxItems).map((r) => ({
    url: String(r?.url || ''), status: r?.status, why: r?.why ? String(r.why) : undefined,
    confirmed: typeof r?.confirmed === 'boolean' ? r.confirmed : undefined, ts: typeof r?.ts === 'number' ? r.ts : Date.now(),
    accountId: accountId ? String(accountId) : undefined,
  })) as ReportItemResult[];
  // 多账号:只替换这个号的结果,保留其它号的
  const merge = (prev?: ReportItemResult[]) => [...(prev || []).filter((r) => !accountId || r.accountId !== accountId), ...clean];
  if (dryRun) { t.reportDryRunAt = Date.now(); t.reportDryRunResults = merge(t.reportDryRunResults); }
  else { t.reportResults = merge(t.reportResults); }
  persist();
}

/** 新建/更新任务,带约束校验。 */
export function saveTask(input: SaveTaskInput, availableCommentAccounts = input.accountIds): SaveTaskResult {
  const tasks = loadTasks();
  let commentAssignmentPlan: SavedCommentAssignmentPlan | undefined;

  // 举报:先过合规校验,并把调度相关字段强制成「仅手动、仅一次、单窗口」。
  let reportItems: ReportItem[] | undefined;
  if (input.type === 'report') {
    const v = validateReport(input);
    if (!v.ok || !v.items) return { ok: false, error: v.error || 'report_invalid' };
    reportItems = v.items;
    input = { ...input, reportItems, frequency: 'once', enabled: false, concurrency: 1, quota: {} };
  }

  // 评论区点赞评论(仅 TikTok):1-20 条 TikTok 作品链接(去重)+ 每号点赞上限夹到 1-5000。
  if (input.type === 'comment_like' && input.platform !== 'tiktok') return { ok: false, error: 'comment_like_platform_unsupported' };
  if (input.type === 'comment_like' && input.commentMode === 'custom') {
    const accountIds = [...new Set((input.accountIds || []).filter(Boolean))];
    if (!accountIds.length) return { ok: false, error: 'comment_like_no_account' };
    try {
      const commentPosts = validatedCommentPosts(input.commentPosts);
      input = { ...input, accountIds, commentPosts, customCommentPolicy: normalizeCustomCommentPolicy({ ...tasks.find(t => t.id === input.id)?.customCommentPolicy, ...input.customCommentPolicy }), urls: [...new Set(commentPosts.map(post => post.url))],
        commentDoLike: false, commentDoReply: false, frequency: 'once', quota: {} };
    } catch { return { ok: false, error: 'comment_like_invalid_posts' }; }
    const shown = input.commentAssignmentPreview;
    const current = previewCustomCommentAssignments(
      { id: input.id, accountIds, commentPosts: input.commentPosts, seed: shown?.seed }, availableCommentAccounts,
    );
    if (shown && JSON.stringify(shown) !== JSON.stringify(current)) return { ok: false, error: 'comment_assignment_preview_stale' };
    if (input.commentPosts.some(post => !current.ledger[commentPostKey(post)] && !current.plan.owners[commentPostKey(post)])) {
      return { ok: false, error: 'comment_assignment_no_available_account' };
    }
    commentAssignmentPlan = current.plan;
  } else if (input.type === 'comment_like') {
    const seen = new Set<string>();
    const urls: string[] = [];
    for (const raw of Array.isArray(input.urls) ? input.urls : []) {
      const u = String(raw || '').trim();
      if (!/^https?:\/\/([\w-]+\.)?tiktok\.com\//i.test(u) || seen.has(u)) continue;
      seen.add(u); urls.push(u);
    }
    const keywordsMode = input.commentMode === 'keywords';
    if (keywordsMode) {
      const previous = tasks.find((t) => t.id === input.id);
      try {
        input = { ...input, ...commentLikeLimits({
          commentVideoLimit: input.commentVideoLimit ?? previous?.commentVideoLimit,
          commentRepliesPerVideo: input.commentRepliesPerVideo ?? previous?.commentRepliesPerVideo,
        }) };
      } catch { return { ok: false, error: 'comment_like_invalid_limits' }; }
    }
    // 关键词模式不需要链接(用各执行账号自己的关键词搜);精准模式仍要 1-20 条链接。
    if (!keywordsMode && (urls.length < 1 || urls.length > COMMENT_LIKE_LIMITS.maxLinks)) return { ok: false, error: 'comment_like_link_count' };
    if (!(input.accountIds || []).filter(Boolean).length) return { ok: false, error: 'comment_like_no_account' };
    const n = Math.round(Number(input.commentLikeMax));
    const commentLikeMax = Number.isFinite(n) ? Math.min(COMMENT_LIKE_LIMITS.maxMax, Math.max(COMMENT_LIKE_LIMITS.maxMin, n)) : COMMENT_LIKE_LIMITS.maxDefault;
    const doLike = input.commentDoLike !== false, doReply = input.commentDoReply !== false;
    if (!doLike && !doReply) return { ok: false, error: 'comment_like_no_action' };
    input = { ...input, urls: keywordsMode ? [] : urls, commentLikeMax, commentMode: keywordsMode ? 'keywords' : 'precise', commentDoLike: doLike, commentDoReply: doReply, quota: {} };
  }

  // 批量拉黑(仅抖音):名单 + 关键词去重、裁剪;两者至少一项;至少 1 个执行账号。不限人数。
  if (input.type === 'block') {
    if (input.platform !== 'douyin') return { ok: false, error: 'block_platform_unsupported' };
    const uniq = (arr: unknown, maxLen: number, cap: number) => {
      const seen = new Set<string>(); const out: string[] = [];
      for (const raw of Array.isArray(arr) ? arr : []) {
        const v = String(raw || '').trim().slice(0, maxLen);
        if (!v || seen.has(v)) continue;
        seen.add(v); out.push(v);
        if (out.length >= cap) break;
      }
      return out;
    };
    const accIds = (input.accountIds || []).filter(Boolean).map(String);
    if (!accIds.length) return { ok: false, error: 'block_no_account' };
    if (input.blockMode === 'keyword') {
      // 关键词模式:不存词 —— 运行时取各账号自己的关键词(和矩阵账号是同一份,改了就生效)。
      input = { ...input, blockMode: 'keyword', blockTargets: [], blockKeywords: [], blockTargetsByAccount: undefined, quota: {} };
    } else if (input.blockMode === 'precise') {
      // 精准模式:每个执行账号各自一份名单;只保留选中的账号,每号去重裁剪。
      const byAcc: Record<string, string[]> = {};
      const src = input.blockTargetsByAccount || {};
      for (const id of accIds) {
        const list = uniq(src[id], 300, BLOCK_LIMITS.maxTargets);
        if (list.length) byAcc[id] = list;
      }
      if (!Object.keys(byAcc).length) return { ok: false, error: 'block_no_targets' };
      // blockTargets 存并集,只给详情页/摘要展示用;运行时以 blockTargetsByAccount 为准。
      const union = uniq(Object.values(byAcc).flat(), 300, BLOCK_LIMITS.maxTargets * 50);
      input = { ...input, blockMode: 'precise', blockTargets: union, blockKeywords: [], blockTargetsByAccount: byAcc, quota: {} };
    } else {
      const blockTargets = uniq(input.blockTargets, 300, BLOCK_LIMITS.maxTargets);
      const blockKeywords = uniq(input.blockKeywords, BLOCK_LIMITS.keywordMaxLen, BLOCK_LIMITS.maxKeywords);
      if (!blockTargets.length && !blockKeywords.length) return { ok: false, error: 'block_no_targets' };
      input = { ...input, blockTargets, blockKeywords, blockMode: undefined, blockTargetsByAccount: undefined, quota: {} };
    }
  }

  // 文件夹定时发布(仅抖音):只留选中号的时段,每号 3 个 HH:MM;至少一个号开了一个时段;准点发(浮动已取消,恒为 0)。
  if (input.type === 'folder_post') {
    if (input.platform !== 'douyin') return { ok: false, error: 'folder_post_platform_unsupported' };
    const accIds = (input.accountIds || []).filter(Boolean).map(String);
    if (!accIds.length) return { ok: false, error: 'folder_post_no_account' };
    const src = input.folderPost?.slotsByAccount || {};
    const slotsByAccount: FolderPostConfig['slotsByAccount'] = {};
    for (const id of accIds) slotsByAccount[id] = normSlots(src[id]);
    if (!accIds.some((id) => slotsByAccount[id].some((x) => x.on))) return { ok: false, error: 'folder_post_no_slot' };
    const j = Math.round(Number(input.folderPost?.jitterMin));
    // 2026-10-29 用户:去掉随机浮动,一律准点(字段保留为 0,兼容老数据结构)
    void j;
    const jitterMin = 0;
    // frequency 只是占位(调度看时段),必须不是 once 才会进定时。
    input = { ...input, folderPost: { slotsByAccount, jitterMin }, frequency: 'daily_random', quota: {} };
  }

  const sameTaskType = (t: MatrixTask) => t.type === input.type && (input.type !== 'comment_like'
    || (t.commentMode === 'custom') === (input.commentMode === 'custom'));
  if (input.id) {
    const i = tasks.findIndex((t) => t.id === input.id);
    if (i < 0) return { ok: false, error: 'task_not_found' };
    // 别的类型不能改成/改出抖音Report(白名单 + 单账号等约束只对 report 生效,类型切换会绕过)。
    if ((tasks[i].type === 'report') !== (input.type === 'report')) return { ok: false, error: 'report_type_change_forbidden' };
    // 改 type 不能撞到同平台已有的别的同类型任务(举报除外:每次举报是独立的一次性单据,可并存多张)
    const dup = input.type === 'report' ? undefined : tasks.find((t) => t.id !== input.id && t.platform === input.platform && sameTaskType(t));
    if (dup) return { ok: false, error: 'duplicate_type' };
    const updated: MatrixTask = {
      ...tasks[i],
      platform: input.platform, type: input.type,
      name: input.name || tasks[i].name,
      enabled: input.enabled ?? tasks[i].enabled,
      accountIds: input.accountIds || [],
      quota: input.quota || {},
      funnel: input.funnel ?? tasks[i].funnel,
      // null=显式清掉(向导切回共用模式);undefined=没动这块(如 updateTask 兜底),保留旧值。
      funnelByAccount: input.funnelByAccount === undefined ? tasks[i].funnelByAccount : (input.funnelByAccount || undefined),
      ai_comment: input.ai_comment === undefined ? tasks[i].ai_comment : (input.ai_comment === false ? false : undefined),
      // undefined = 本次没传(保留原值);传了就覆盖 —— 与 funnelByAccount 同一口径,
      //   否则编辑任务时只改频率也会把它抹掉。
      maxReplyPerComment: input.maxReplyPerComment === undefined ? tasks[i].maxReplyPerComment : input.maxReplyPerComment,
      maxRepliesPerRun: input.maxRepliesPerRun === undefined ? tasks[i].maxRepliesPerRun : input.maxRepliesPerRun,
      imageText: input.imageText ?? tasks[i].imageText,
      viralRewrite: input.viralRewrite ?? tasks[i].viralRewrite,
      tweetPost: input.tweetPost ?? tasks[i].tweetPost,
      binancePost: input.binancePost ?? tasks[i].binancePost,
      facebookPost: input.facebookPost ?? tasks[i].facebookPost,
      redditPost: input.redditPost ?? tasks[i].redditPost,
      instagramPost: input.instagramPost ?? tasks[i].instagramPost,
      binanceRepost: input.binanceRepost ?? tasks[i].binanceRepost,
      leadEngage: input.leadEngage ?? tasks[i].leadEngage,
      urls: input.urls ?? tasks[i].urls,
      commentLikeMax: input.type === 'comment_like' ? input.commentLikeMax : tasks[i].commentLikeMax,
      commentMode: input.type === 'comment_like' ? input.commentMode : tasks[i].commentMode,
      customCommentPolicy: input.type === 'comment_like' && input.commentMode === 'custom' ? input.customCommentPolicy : undefined,
      commentPosts: input.type === 'comment_like' && input.commentMode === 'custom' ? input.commentPosts : undefined,
      commentAssignmentPlan,
      commentDoLike: input.type === 'comment_like' ? input.commentDoLike : tasks[i].commentDoLike,
      commentDoReply: input.type === 'comment_like' ? input.commentDoReply : tasks[i].commentDoReply,
      commentVideoLimit: input.commentVideoLimit ?? tasks[i].commentVideoLimit,
      commentRepliesPerVideo: input.commentRepliesPerVideo ?? tasks[i].commentRepliesPerVideo,
      blockTargets: input.type === 'block' ? input.blockTargets : tasks[i].blockTargets,
      blockKeywords: input.type === 'block' ? input.blockKeywords : tasks[i].blockKeywords,
      blockMode: input.type === 'block' ? input.blockMode : tasks[i].blockMode,
      blockTargetsByAccount: input.type === 'block' ? input.blockTargetsByAccount : tasks[i].blockTargetsByAccount,
      folderPost: input.type === 'folder_post' ? input.folderPost : tasks[i].folderPost,
      reportItems: input.type === 'report' ? reportItems : tasks[i].reportItems,
      concurrency: input.concurrency,
      frequency: input.frequency,
    };
    updated.nextPlannedRunAt = planned(updated, Date.now(), true); // 配置变更视为从现在重排
    delete updated.retryCount; delete updated.lastError; delete updated.recoveryPaused;
    const next = tasks.map((task, index) => index === i ? updated : task);
    persist(next); cache = next;
    return { ok: true, task: updated };
  }

  // 举报单据不占「每平台 5 个任务」名额、也不受同类型唯一限制(一次性单据,执行完即归档)。
  const platformTasks = tasks.filter((t) => t.platform === input.platform && t.type !== 'report');
  if (input.type !== 'report') {
    if (platformTasks.length >= MAX_PER_PLATFORM) return { ok: false, error: 'platform_task_limit' };
    if (platformTasks.some(sameTaskType)) return { ok: false, error: 'duplicate_type' };
  }

  const task: MatrixTask = {
    id: `${input.platform}_${input.type}_${Date.now().toString(36)}_${Math.floor(Math.random() * 1e4).toString(36)}`,
    platform: input.platform,
    type: input.type,
    name: input.name || `${input.platform} 互动`,
    enabled: input.enabled ?? true,
    accountIds: input.accountIds || [],
    quota: input.quota || {},
    funnel: input.funnel,
    funnelByAccount: input.funnelByAccount || undefined,
    ai_comment: input.ai_comment === false ? false : undefined,
    maxReplyPerComment: input.maxReplyPerComment,
    maxRepliesPerRun: input.maxRepliesPerRun,
    imageText: input.imageText,
    viralRewrite: input.viralRewrite,
    tweetPost: input.tweetPost,
    binancePost: input.binancePost,
    facebookPost: input.facebookPost,
    redditPost: input.redditPost,
    instagramPost: input.instagramPost,
    binanceRepost: input.binanceRepost,
    leadEngage: input.leadEngage,
    urls: input.urls,
    commentLikeMax: input.type === 'comment_like' ? input.commentLikeMax : undefined,
    commentMode: input.type === 'comment_like' ? input.commentMode : undefined,
    customCommentPolicy: input.type === 'comment_like' && input.commentMode === 'custom' ? input.customCommentPolicy : undefined,
    commentPosts: input.type === 'comment_like' && input.commentMode === 'custom' ? input.commentPosts : undefined,
    commentAssignmentPlan,
    commentDoLike: input.type === 'comment_like' ? input.commentDoLike : undefined,
    commentDoReply: input.type === 'comment_like' ? input.commentDoReply : undefined,
    commentVideoLimit: input.type === 'comment_like' ? input.commentVideoLimit : undefined,
    commentRepliesPerVideo: input.type === 'comment_like' ? input.commentRepliesPerVideo : undefined,
    blockTargets: input.type === 'block' ? input.blockTargets : undefined,
    blockKeywords: input.type === 'block' ? input.blockKeywords : undefined,
    blockMode: input.type === 'block' ? input.blockMode : undefined,
    blockTargetsByAccount: input.type === 'block' ? input.blockTargetsByAccount : undefined,
    folderPost: input.type === 'folder_post' ? input.folderPost : undefined,
    reportItems,
    concurrency: input.concurrency,
    frequency: input.frequency || 'once',
    createdAt: Date.now(),
  };
  task.nextPlannedRunAt = planned(task, Date.now(), true);
  const next = [...tasks, task];
  persist(next); cache = next;
  return { ok: true, task };
}

export function removeTask(id: string): void {
  cache = loadTasks().filter((t) => t.id !== id);
  persist();
}

/**
 * 删号联动:把某个账号 id 从所有任务的 accountIds 里摘掉,避免 tasks.json 残留已删账号的
 * 幽灵 id(运行时会被误判「超额暂停」并在 UI 冒出一个不存在的号)。只在有实际变更时落盘。
 */
export function pruneAccountFromTasks(accountId: string): void {
  const tasks = loadTasks();
  let changed = false;
  for (const t of tasks) {
    if (Array.isArray(t.accountIds) && t.accountIds.includes(accountId)) {
      t.accountIds = t.accountIds.filter((id) => id !== accountId);
      changed = true;
    }
  }
  if (changed) { cache = tasks; persist(); }
}

export function setTaskEnabled(id: string, enabled: boolean): void {
  const t = getTask(id); if (!t) return;
  if (t.type === 'report') return; // 举报永不进定时调度
  t.enabled = enabled;
  if (enabled) { delete t.retryCount; delete t.lastError; delete t.recoveryPaused; }
  t.nextPlannedRunAt = planned(t, Date.now(), true);
  persist();
}

export function setTaskLastRun(id: string, ts: number): void {
  finishTaskRun(id, ts, { state: 'success' });
}

/** 用户明确重试才清任务级暂停;账号保护由账号预检单独负责。 */
export function clearTaskRecovery(id: string): void {
  const t = getTask(id); if (!t) return;
  delete t.retryCount; delete t.lastError; delete t.recoveryPaused;
  persist();
}

export function finishTaskRun(id: string, ts: number, result: {
  state: 'success' | 'failed' | 'stopped' | 'skipped'; reason?: string; nextCheckAt?: number;
}): void {
  const t = getTask(id); if (!t) return;
  t.lastRunAt = ts;
  t.lastError = result.state === 'success' ? undefined : result.reason;
  delete t.recoveryPaused;
  if (result.state === 'failed') {
    t.retryCount = (t.retryCount || 0) + 1;
    if (isRecoverableFailure(result.reason || '')) {
      t.nextPlannedRunAt = t.enabled && t.frequency !== 'once' && t.type !== 'report'
        ? ts + recoveryDelay(t.retryCount) : undefined;
    } else {
      t.recoveryPaused = true;
      t.nextPlannedRunAt = undefined;
    }
  } else {
    delete t.retryCount;
    t.nextPlannedRunAt = planned(t, ts, false);
    if (result.state === 'skipped' && t.nextPlannedRunAt != null && Number.isFinite(result.nextCheckAt)) {
      t.nextPlannedRunAt = Math.min(t.nextPlannedRunAt, Math.max(ts + 60_000, result.nextCheckAt!));
    }
  }
  persist();
}

/** Pause inherited schedules before starting this release's scheduler. User data and history stay intact. */
export function holdSchedulesForRelease(): boolean {
  const marker = path.join(baseDir(), 'schedule-review-3.4.93');
  if (fs.existsSync(marker)) return false;
  if (fs.existsSync(storeFile()) && !Array.isArray(JSON.parse(fs.readFileSync(storeFile(), 'utf8')))) {
    throw Error('matrix_release_task_store_unavailable');
  }
  const existing = loadTasks();
  const next = existing.map(task => task.enabled && task.frequency !== 'once' && task.type !== 'report' && !task.recoveryPaused
    ? { ...task, recoveryPaused: true, lastError: '升级后请先核对任务，再手动运行或重新启用定时' } : task);
  if (next.some((task, i) => task !== existing[i])) {
    persist(next);
    cache = next;
  }
  fs.mkdirSync(baseDir(), { recursive: true });
  fs.writeFileSync(marker, '3.4.93\n', { flag: 'wx' });
  return true;
}

/** 调度器用:到点该自动跑的任务(启用、非 once、已到 nextPlannedRunAt)。 */
export function dueTasks(now: number): MatrixTask[] {
  return loadTasks().filter((t) => t.type !== 'report' && t.enabled && !t.recoveryPaused && t.frequency !== 'once' && t.nextPlannedRunAt != null && t.nextPlannedRunAt <= now);
}
