import React, { useEffect, useRef, useState } from 'react';
import {
  Device, L, PlatformId, RawTask, Schedule, ScriptId, TaskView, asPlatform, bd, btnGhost, btnPrimary, errText, isEngage, isLead,
  platformName, saveTask, scriptShort, scriptName, scriptsFor, sub, surface, txt,
} from './cloudPhoneShared';

/**
 * 创建 / 编辑一台手机的云机任务(每个平台 1 个)。分步向导:
 *   评论区点赞评论:① 任务 → ② 动作与数量 → ③ 评论设置(勾了评论才有)→ ④ 运行频率
 *   定向获客:      ① 任务 → ② 数量(点赞目标 + 关注 / 评论总量,和浏览器任务一样)→ ③ 评论设置(评论 > 0 才有)→ ④ 运行频率
 *   互动涨粉(抖音 / 小红书):① 任务 → ② 动作与数量(点赞 / 收藏 / 关注 / 评论)→ ③ 评论设置(评论 > 0 才有)→ ④ 运行频率
 * 任务类型按平台(scriptsFor);保存的任务 platform = 编辑器的平台。
 * 保存整台手机的任务列表(PUT /devices/:id/tasks);编辑器不展示的已有字段从 `raw` 原样保留。
 * 批量模式(无 device):任务类型固定,不保存,做好的任务交给 `batch.onNext`。
 */

export interface BatchEditorMode {
  scriptId: ScriptId;
  /** Platform the batch creates for (default: the script's platform / TikTok). */
  platform?: PlatformId;
  /** Task built on a previous visit of this step (going back from the phone picker keeps the settings). */
  seed: RawTask | null;
  onBack: () => void;
  onNext: (task: RawTask) => void;
}

type SchedKey = '0.5' | '1' | '3' | '6' | 'daily' | 'random' | 'manual';
type StepKey = 'task' | 'act' | 'cmt' | 'lvl' | 'freq';

const SCHEDULES: { k: SchedKey; label: () => string }[] = [
  { k: '0.5', label: () => L('每 30 分钟', '每 30 分鐘', 'Every 30 min') },
  { k: '1', label: () => L('每 1 小时', '每 1 小時', 'Every 1 h') },
  { k: '3', label: () => L('每 3 小时', '每 3 小時', 'Every 3 h') },
  { k: '6', label: () => L('每 6 小时', '每 6 小時', 'Every 6 h') },
  { k: 'daily', label: () => L('每天定时', '每天定時', 'Daily at') },
  { k: 'random', label: () => L('每天随机时间', '每天隨機時間', 'Daily, random time') },
  { k: 'manual', label: () => L('手动', '手動', 'Manual') },
];
/** Per-run ceilings the phone app enforces (RunCaps.CEIL_*): an empty "max" box means up to these. */
const CEIL_LIKES = 1000;
const CEIL_COMMENTS = 300;

function schedKeyOf(s: Schedule | null | undefined): SchedKey {
  if (!s) return 'daily';   // 新建默认每天定时
  if (s.kind === 'manual') return 'manual';
  if (s.kind === 'daily') return 'daily';
  if (s.kind === 'random') return 'random';
  const h = String(s.hours);
  return (['0.5', '1', '3', '6'] as string[]).includes(h) ? (h as SchedKey) : '3';
}
function toSchedule(k: SchedKey, at: string, win: [string, string] = ['09:00', '22:00']): Schedule {
  if (k === 'manual') return { kind: 'manual' };
  if (k === 'daily') return { kind: 'daily', at };
  if (k === 'random') return { kind: 'random', from: win[0], to: win[1] };
  return { kind: 'every', hours: Number(k) };
}
const splitList = (s: string): string[] => Array.from(new Set(s.split(/[\n,，、]/).map((x) => x.trim()).filter(Boolean)));
const lines = (s: string): string[] => Array.from(new Set(s.split('\n').map((x) => x.trim()).filter(Boolean))).slice(0, 20);
/** 定向获客每次运行的上限(和服务器 mobile_caps 一致) */
const LEAD_CEIL = { likes: 5000, follows: 100, comments: 100 };
const intIn = (v: string, lo: number, hi: number): number => { const n = Math.round(Number(v)); return Number.isFinite(n) && v.trim() ? Math.max(lo, Math.min(hi, n)) : lo; };
/** The server keeps only these video links (normalizeTask). */
const TIKTOK_URL = /^https:\/\/(www\.|m\.|vm\.|vt\.)?tiktok\.com\/\S+$/i;
/** "@user" / "user" → profile URL, missing scheme → https://, http → https. */
function normalizeLink(x: string): string {
  const v = x.trim();
  // TikTok 用户 ID(手机上通常只看得到 ID,没有链接):@name / name / na.me → 主页链接
  if (/^@?[A-Za-z0-9._]{2,24}$/.test(v) && !/^(www\.)?tiktok\.com$/i.test(v)) return `https://www.tiktok.com/@${v.replace(/^@/, '')}`;
  if (/^http:\/\//i.test(v)) return v.replace(/^http:\/\//i, 'https://');
  if (/^https:\/\//i.test(v)) return v;
  if (!/[./]/.test(v)) return `https://www.tiktok.com/@${v}`;
  return `https://${v.replace(/^\/+/, '')}`;
}
/** 抖音 / 小红书:只收 https 链接(同行主页 / 作品,在 App 里「分享 → 复制链接」);分享文案里夹着的链接也能取出来。 */
const httpsLinks = (s: string, max: number): string[] => Array.from(new Set(s.split('\n')
  .map((x) => (x.match(/https?:\/\/[A-Za-z0-9\-._~:/?#[\]@!$&'()*+,;=%]+/) || [''])[0].replace(/[.,;:!?)]+$/, '').replace(/^http:\/\//i, 'https://'))
  .filter(Boolean))).slice(0, max);
const hasBadLine = (s: string): string[] => s.split('\n').map((x) => x.trim()).filter((x) => x && !/https?:\/\//i.test(x));
/** 互动涨粉每次运行的上限(和服务器一致) */
const ENGAGE_CEIL = { likes: 500, favorites: 100, follows: 100, comments: 100, keywords: 30, links: 50 };
const LEAD_LINKS_MAX = 50;
const posInt = (v: string, lo: number, hi: number): number | null => {
  const n = Math.round(Number(v));
  return v.trim() && Number.isFinite(n) ? Math.max(lo, Math.min(hi, n)) : null;
};

type Cfg = {
  comment_mode?: string; mode?: string; keywords?: string[]; urls?: string[]; seed_accounts?: string[]; level?: string;
  leads_per_run?: number; lead_do_like?: boolean; lead_do_follow?: boolean; lead_do_comment?: boolean;
  cl_do_like?: boolean; cl_do_reply?: boolean; cl_like_gap_sec?: number; cl_reply_gap_sec?: number; cl_like_nolimit?: boolean; cl_reply_nolimit?: boolean;
  cl_ai_comment?: boolean; cl_funnel?: string[]; cl_funnel_rewrite?: boolean; cl_funnel_prob?: number;
  engage_mode?: string; precise_urls?: string[]; max_favorites?: number; max_comment_per_work?: number;
};
const strList = (v: unknown): string[] => (Array.isArray(v) ? v.map(String) : []);

/** 下拉选择:右边实心绿色方块里的箭头,一眼看出能点。 */
function Dropdown<T extends string>({ value, options, onChange, ariaLabel }: { value: T; options: { v: T; label: string }[]; onChange: (v: T) => void; ariaLabel: string }) {
  const [open, setOpen] = useState(false);
  const cur = options.find((o) => o.v === value) || options[0];
  const menuRef = useRef<HTMLDivElement | null>(null);
  // 展开后把选项滚进可见区(弹窗中间是滚动区,靠下的下拉不会被底部挡住)
  useEffect(() => { if (open) menuRef.current?.scrollIntoView({ block: 'nearest' }); }, [open]);
  return (
    <div className="relative">
      {open && <div className="fixed inset-0 z-10" onClick={() => setOpen(false)} />}
      <button type="button" aria-label={ariaLabel} aria-expanded={open} onClick={() => setOpen((o) => !o)}
        className="w-full flex items-center justify-between gap-2 h-10 px-3.5 rounded-xl text-sm font-bold text-left bg-gray-200 dark:bg-[#202640] dark:text-white">
        <span className="min-w-0 truncate">{cur?.label}</span>
        {/* 和「全部状态」筛选一样的普通箭头 */}
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
          className="shrink-0 opacity-80 transition-transform" style={{ transform: open ? 'rotate(180deg)' : undefined }}><path d="M6 9l6 6 6-6" /></svg>
      </button>
      {open && (
        <div ref={menuRef} className={`absolute left-0 right-0 top-[calc(100%+6px)] z-20 p-1.5 rounded-xl border ${bd} ${surface} shadow-xl`}>
          {options.map((o) => (
            <button key={o.v} type="button" onClick={() => { onChange(o.v); setOpen(false); }}
              style={o.v === value ? { background: 'rgba(0,255,136,0.10)' } : undefined}
              className={`w-full text-left text-sm px-2.5 py-2 rounded-lg ${o.v === value ? 'text-claude-accent font-semibold' : `${txt} hover:bg-black/5 dark:hover:bg-white/5`}`}>{o.label}</button>
          ))}
        </div>
      )}
    </div>
  );
}

const Toggle: React.FC<{ on: boolean; onClick: () => void; label: string }> = ({ on, onClick, label }) => (
  <button type="button" role="switch" aria-checked={on} aria-label={label} onClick={onClick}
    className="relative flex-none w-[42px] h-6 rounded-full transition-colors" style={{ background: on ? '#00FF88' : '#3a4260' }}>
    <span className="absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white transition-all" style={{ left: on ? 21 : 3 }} />
  </button>
);

const PhoneTaskEditor: React.FC<{
  device?: Device; initial: TaskView | null; onCancel: () => void; onSaved?: (msg: string) => void; batch?: BatchEditorMode;
  /** Platform of a new task (editing uses the task's own platform). */
  platform?: PlatformId;
}> = ({ device, initial, onCancel, onSaved, batch, platform: platformProp }) => {
  // 平台:批量 = 选的平台;编辑 = 任务自己的平台;新建 = 卡片上选中的平台
  const platform: PlatformId = asPlatform(batch?.platform || (batch ? batch.scriptId.split('_')[0] : '') || initial?.platform || platformProp);
  const pfName = platformName(platform);
  const isTiktok = platform === 'tiktok';
  const scripts = scriptsFor(platform);
  const seed = batch?.seed && batch.seed.script_id === batch.scriptId ? batch.seed : null;
  // 初值:编辑 = 任务原来的 config;批量回退 = 上次填的;新建 = 默认
  const base: Cfg = (initial?.raw?.config || seed?.config || {}) as Cfg;
  const baseTask = (initial?.raw || seed || null) as RawTask | null;
  const [script, setScript] = useState<ScriptId>(batch ? batch.scriptId
    : (scripts as readonly string[]).includes(initial?.script_id || '') ? (initial!.script_id as ScriptId) : scripts[0]);
  const [mode, setMode] = useState<'keywords' | 'precise'>(initial ? (initial.mode === 'precise' ? 'precise' : 'keywords')
    : base.comment_mode === 'precise' || base.mode === 'accounts' || base.engage_mode === 'precise' ? 'precise' : 'keywords');
  const [keywords, setKeywords] = useState((initial ? initial.keywords || [] : strList(base.keywords)).join('\n'));
  const [targets, setTargets] = useState((initial ? initial.targets || [] : strList(base.urls).concat(strList(base.seed_accounts), strList(base.precise_urls))).join('\n'));
  // 互动涨粉(抖音 / 小红书):点赞 / 收藏 / 关注 / 评论各自的本次数量(0 = 不做)+ 每条作品最多评论几条
  const hasEngage = !!baseTask && isEngage(baseTask.script_id);
  const [eLike, setELike] = useState(String(hasEngage ? Number(baseTask?.max_likes ?? 0) || 0 : 30));
  const [eFav, setEFav] = useState(String(hasEngage ? Number(base.max_favorites ?? 0) || 0 : 10));
  const [eFollow, setEFollow] = useState(String(hasEngage ? Number(baseTask?.max_follows ?? 0) || 0 : 10));
  const [eComment, setEComment] = useState(String(hasEngage ? Number(baseTask?.max_comments ?? 0) || 0 : 5));
  const [ePerWork, setEPerWork] = useState(String(hasEngage ? Number(base.max_comment_per_work ?? 1) || 1 : 1));
  // 定向获客(和浏览器任务一样):采集不设上限;点赞数是目标(每个潜客都点,不够回评论区补赞),关注 / 评论是本次总量(0 = 不做)
  const hasLead = !!baseTask && isLead(baseTask.script_id);
  const leadN = (k: 'max_likes' | 'max_follows' | 'max_comments', on: boolean | undefined, dflt: number) =>
    String(hasLead ? (on === false ? 0 : Number(baseTask?.[k] ?? dflt) || 0) : dflt);
  const [lLike, setLLike] = useState(leadN('max_likes', base.lead_do_like, 300));
  const [lFollow, setLFollow] = useState(leadN('max_follows', base.lead_do_follow, 0));
  const [lComment, setLComment] = useState(leadN('max_comments', base.lead_do_comment, 0));
  // 评论区点赞评论:动作 + 每个动作的最多数量(空 = 不限)和间隔秒数
  const hasCl = !!baseTask && baseTask.script_id === 'tiktok_comment_like';
  const [doLike, setDoLike] = useState(hasCl ? base.cl_do_like !== false : true);
  const [doReply, setDoReply] = useState(hasCl ? base.cl_do_reply !== false : false);
  const [nLike, setNLike] = useState(hasCl && !base.cl_like_nolimit && baseTask?.max_likes ? String(baseTask.max_likes) : '');
  const [nReply, setNReply] = useState(hasCl && !base.cl_reply_nolimit && baseTask?.max_comments ? String(baseTask.max_comments) : '');
  const [likeGap, setLikeGap] = useState(String(base.cl_like_gap_sec ?? 1));
  const [replyGap, setReplyGap] = useState(String(base.cl_reply_gap_sec ?? 30));
  const [aiComment, setAiComment] = useState(base.cl_ai_comment !== false);
  const [funnel, setFunnel] = useState(strList(base.cl_funnel).join('\n'));
  const [rewrite, setRewrite] = useState(base.cl_funnel_rewrite !== false);
  const [prob, setProb] = useState(typeof base.cl_funnel_prob === 'number' ? base.cl_funnel_prob : 100);
  const firstSchedule = initial ? initial.schedule : seed?.schedule;
  const [sched, setSched] = useState<SchedKey>(schedKeyOf(firstSchedule));
  const [at, setAt] = useState(() => { const s = firstSchedule; return s && s.kind === 'daily' ? s.at : '09:30'; });
  // 每天随机:在这个时间段里每天随机挑一个时间跑一次
  const [rFrom, setRFrom] = useState(() => { const s = firstSchedule; return s && s.kind === 'random' ? s.from : '09:00'; });
  const [rTo, setRTo] = useState(() => { const s = firstSchedule; return s && s.kind === 'random' ? s.to : '22:00'; });
  const [step, setStep] = useState<StepKey>('task');
  const [err, setErr] = useState('');
  const [saving, setSaving] = useState(false);
  const lead = isLead(script);
  const engage = isEngage(script);
  const leadCmt = intIn(lComment, 0, LEAD_CEIL.comments) > 0;
  const engageN = {
    likes: intIn(eLike, 0, ENGAGE_CEIL.likes), favorites: intIn(eFav, 0, ENGAGE_CEIL.favorites),
    follows: intIn(eFollow, 0, ENGAGE_CEIL.follows), comments: intIn(eComment, 0, ENGAGE_CEIL.comments), perWork: intIn(ePerWork, 1, 5),
  };

  const steps: StepKey[] = lead ? (leadCmt ? ['task', 'lvl', 'cmt', 'freq'] : ['task', 'lvl', 'freq'])
    : engage ? (engageN.comments > 0 ? ['task', 'act', 'cmt', 'freq'] : ['task', 'act', 'freq'])
    : doReply ? ['task', 'act', 'cmt', 'freq'] : ['task', 'act', 'freq'];
  const idx = Math.max(0, steps.indexOf(step));
  const stepName: Record<StepKey, string> = {
    task: L('任务', '任務', 'Task'), act: L('动作与数量', '動作與數量', 'Actions'), cmt: L('评论设置', '評論設定', lead || engage ? 'Comments' : 'Replies'),
    lvl: L('数量', '數量', 'Amount'), freq: L('运行频率', '運行頻率', 'Schedule'),
  };
  // 取消勾选「评论」后如果停在评论设置这一步,退回动作那一步
  useEffect(() => { if (!steps.includes(step)) setStep(steps.includes('act') ? 'act' : steps[0]); });
  // 换步骤时清掉错误提示(在这里清,不用 effect:最后一步校验失败跳回某步时要保留提示)
  const goStep = (k: StepKey) => { setErr(''); setStep(k); };

  // Esc = 取消(非批量);批量模式由外层处理
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;
  useEffect(() => {
    if (batch) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') cancelRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [batch]);

  /** 当前这一步能不能往下走;不能就返回原因。 */
  const checkStep = (k: StepKey): string => {
    if (k === 'task') {
      const kw = splitList(keywords);
      const tg = splitList(targets);
      if (mode === 'keywords' && !kw.length) return L('请填写关键词', '請填寫關鍵詞', 'Enter at least one keyword');
      if (engage && mode === 'keywords' && kw.length > ENGAGE_CEIL.keywords) return L(`关键词最多 ${ENGAGE_CEIL.keywords} 个`, `關鍵詞最多 ${ENGAGE_CEIL.keywords} 個`, `At most ${ENGAGE_CEIL.keywords} keywords`);
      if (!isTiktok && mode === 'precise') {
        // 抖音 / 小红书:只认 https 链接(同行主页 / 作品,App 里「分享 → 复制链接」)
        const max = engage ? ENGAGE_CEIL.links : LEAD_LINKS_MAX;
        const bad = hasBadLine(targets);
        if (bad.length) return L('这些行里没有 https:// 链接:', '這些行裡沒有 https:// 連結:', 'No https:// link in: ') + bad.join('、');
        if (!httpsLinks(targets, max).length) return L('请填写链接(https:// 开头)', '請填寫連結(https:// 開頭)', 'Enter at least one link (https://…)');
        if (httpsLinks(targets, Infinity).length > max) return L(`链接最多 ${max} 条`, `連結最多 ${max} 條`, `At most ${max} links`);
      }
      if (isTiktok && mode === 'precise' && !tg.length) return lead ? L('请填写同行账号', '請填寫同行帳號', 'Enter at least one rival account') : L('请填写作品链接', '請填寫作品連結', 'Enter at least one video link');
      if (isTiktok && mode === 'precise' && !lead) {
        const bad = tg.filter((x) => !TIKTOK_URL.test(normalizeLink(x)));
        if (bad.length) return L('这些不是 TikTok 链接或用户 ID:', '這些不是 TikTok 連結或用戶 ID:', 'Not TikTok links or user IDs: ') + bad.join('、');
      }
    }
    if (k === 'act' && engage && engageN.likes + engageN.favorites + engageN.follows + engageN.comments === 0)
      return L('点赞、收藏、关注、评论至少一项大于 0', '點讚、收藏、關注、評論至少一項大於 0', 'Set at least one of likes, favorites, follows, comments above 0');
    if (k === 'act' && !engage && !doLike && !doReply) return L('至少选一个动作', '至少選一個動作', 'Pick at least one action');
    if (k === 'lvl' && intIn(lLike, 0, LEAD_CEIL.likes) + intIn(lFollow, 0, LEAD_CEIL.follows) + intIn(lComment, 0, LEAD_CEIL.comments) === 0)
      return L('点赞、关注、评论至少一项大于 0', '點讚、關注、評論至少一項大於 0', 'Set at least one of likes, follows, comments above 0');
    if (k === 'cmt' && !aiComment && !lines(funnel).length) return L('关掉 AI 自主评论后,请至少填一条引流语', '關掉 AI 自主評論後,請至少填一條引流語', 'With AI replies off, add at least one funnel line');
    if (k === 'freq' && sched === 'daily' && !/^\d{2}:\d{2}$/.test(at)) return L('请选择每天运行的时间', '請選擇每天運行的時間', 'Pick a time of day');
    if (k === 'freq' && sched === 'random' && !(/^\d{2}:\d{2}$/.test(rFrom) && /^\d{2}:\d{2}$/.test(rTo) && rTo > rFrom)) return L('请选择时间段(结束要晚于开始)', '請選擇時間段(結束要晚於開始)', 'Pick a window (end after start)');
    return '';
  };

  const build = (): RawTask => {
    const kw = splitList(keywords);
    let tg = splitList(targets);
    // 抖音 / 小红书:不加 '@',只留 https 链接
    if (!isTiktok) tg = httpsLinks(targets, engage ? ENGAGE_CEIL.links : LEAD_LINKS_MAX);
    else if (lead) tg = tg.map((x) => (/^https?:/i.test(x) || x.startsWith('@') ? x : `@${x}`));
    else tg = tg.map(normalizeLink).filter((x) => TIKTOK_URL.test(x));
    const prev = initial?.raw;
    const sameScript = !!prev && prev.script_id === script;
    const prevCfg: Record<string, unknown> = sameScript ? { ...(prev!.config || {}) } : {};
    const config: Record<string, unknown> = { ...prevCfg };
    let maxes: Partial<RawTask> = {};
    if (lead) {
      const ll = intIn(lLike, 0, LEAD_CEIL.likes); const lf = intIn(lFollow, 0, LEAD_CEIL.follows); const lc = intIn(lComment, 0, LEAD_CEIL.comments);
      maxes = { max_likes: ll, max_comments: lc, max_follows: lf };
      Object.assign(config, {
        mode: mode === 'precise' ? 'accounts' : 'keywords', keywords: kw, seed_accounts: tg, level: '',
        lead_do_like: ll > 0, lead_do_follow: lf > 0, lead_do_comment: lc > 0, cl_like_nolimit: true,
        cl_ai_comment: aiComment, cl_funnel: lines(funnel), cl_funnel_rewrite: rewrite, cl_funnel_prob: aiComment ? prob : 100,
      });
    } else if (engage) {
      maxes = { max_likes: engageN.likes, max_comments: engageN.comments, max_follows: engageN.follows };
      Object.assign(config, {
        engage_mode: mode === 'precise' ? 'precise' : 'search',
        keywords: kw.slice(0, ENGAGE_CEIL.keywords), precise_urls: tg,
        max_favorites: engageN.favorites, max_comment_per_work: engageN.perWork,
        cl_ai_comment: aiComment, cl_funnel: lines(funnel), cl_funnel_rewrite: rewrite, cl_funnel_prob: aiComment ? prob : 100,
      });
    } else {
      const ml = posInt(nLike, 1, CEIL_LIKES);
      const mc = posInt(nReply, 1, CEIL_COMMENTS);
      maxes = { max_likes: ml ?? CEIL_LIKES, max_comments: mc ?? CEIL_COMMENTS, max_follows: 0 };
      Object.assign(config, {
        comment_mode: mode, keywords: kw, urls: tg, level: '',
        cl_do_like: doLike, cl_do_reply: doReply,
        cl_like_nolimit: ml === null, cl_reply_nolimit: mc === null,
        cl_like_gap_sec: posInt(likeGap, 1, 600) ?? 1,
        cl_reply_gap_sec: posInt(replyGap, 5, 3600) ?? 30,
        cl_ai_comment: aiComment, cl_funnel: lines(funnel), cl_funnel_rewrite: rewrite, cl_funnel_prob: aiComment ? prob : 100,
      });
    }
    const task: RawTask = {
      ...(prev || {}),
      id: prev?.id || initial?.id || 't' + Date.now().toString(36),
      name: sameScript && prev?.name ? prev.name : scriptName(script),
      script_id: script,
      platform,
      schedule: toSchedule(sched, at, [rFrom, rTo]),
      // A daily time picked here means this computer's local time (old tasks often carry tz 'UTC').
      tz: sched === 'daily' || sched === 'random' || !prev?.tz ? Intl.DateTimeFormat().resolvedOptions().timeZone : prev.tz,
      ...maxes,
      // 人设不再展示:清空,免得看不见的旧人设还在影响 AI 回复
      persona: '',
      config,
    };
    // Legacy fields are re-derived by the server from `schedule` (for old phone apps).
    delete task.enabled;
    delete task.slots;
    return task;
  };

  const next = async () => {
    const why = checkStep(step);
    if (why) { setErr(why); return; }
    if (idx < steps.length - 1) { goStep(steps[idx + 1]); return; }
    // 最后一步:每一步都再校验一遍(编辑时可能直接跳过来)
    for (const k of steps) { const w = checkStep(k); if (w) { setStep(k); setErr(w); return; } }
    const task = build();
    if (batch) { batch.onNext(task); return; }
    if (!device) return;
    setSaving(true); setErr('');
    try {
      await saveTask(device, task);
      onSaved?.(L('已保存', '已儲存', 'Saved'));
    } catch (e) {
      setErr(L('保存失败:', '儲存失敗:', 'Save failed: ') + errText(e));
    } finally {
      setSaving(false);
    }
  };
  const back = () => { if (idx > 0) goStep(steps[idx - 1]); else if (batch) batch.onBack(); else onCancel(); };

  const label = `text-xs font-semibold ${sub} mb-1.5 block`;
  const input = `w-full rounded-xl border ${bd} dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-3 py-2 text-sm ${txt} outline-none focus:border-claude-accent`;
  const numBox = `w-[78px] text-center rounded-lg border ${bd} dark:bg-claude-darkSurfaceInset bg-claude-surfaceInset px-2 py-1.5 text-sm ${txt} outline-none focus:border-claude-accent placeholder:opacity-60`;
  const isLast = idx === steps.length - 1;
  const title = batch ? L('批量创建任务', '批量建立任務', 'Batch create task') : initial ? L('编辑云机任务', '編輯雲機任務', 'Edit cloud task') : L('创建云机任务', '創建雲機任務', 'Create cloud task');
  const capsLine = engage ? [
    `👍 ${engageN.likes}`, `⭐ ${engageN.favorites}`, `➕ ${engageN.follows}`,
    `💬 ${engageN.comments}${engageN.comments > 0 ? L(`(每条最多 ${engageN.perWork})`, `(每條最多 ${engageN.perWork})`, ` (≤ ${engageN.perWork} per post)`) : ''}`,
  ].join(' · ') : lead ? [
    `${L('点赞目标', '點讚目標', 'Like target')} ${intIn(lLike, 0, LEAD_CEIL.likes)}`,
    `${L('关注', '關注', 'Follows')} ${intIn(lFollow, 0, LEAD_CEIL.follows)}`,
    `${L('评论', '評論', 'Comments')} ${intIn(lComment, 0, LEAD_CEIL.comments)}`,
  ].join(' · ') : [
    doLike ? `${L('点赞', '點讚', 'Likes')} ${nLike.trim() ? L(`最多 ${nLike} 次`, `最多 ${nLike} 次`, `≤ ${nLike}`) : L('不限数量', '不限數量', 'no limit')}、${L('间隔', '間隔', 'gap')} ${likeGap || 1}s` : '',
    doReply ? `${L('评论', '評論', 'Replies')} ${nReply.trim() ? L(`最多 ${nReply} 条`, `最多 ${nReply} 條`, `≤ ${nReply}`) : L('不限数量', '不限數量', 'no limit')}、${L('间隔', '間隔', 'gap')} ${replyGap || 30}s` : '',
  ].filter(Boolean).join(' · ');

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}>
      {/* 固定高度:换步骤时弹窗不跳;内容多了在中间滚动 */}
      <div className={`w-full max-w-[520px] h-[min(680px,90vh)] flex flex-col rounded-2xl border ${bd} ${surface} shadow-modal`}>
        <div className="flex items-start gap-2 px-5 pt-5">
          <div className="min-w-0">
            <h3 className={`m-0 text-base font-bold ${txt}`}>{title}</h3>
            <p className={`m-0 mt-0.5 text-xs ${sub}`}>{batch
              ? `${L('第 2 步 / 共 3 步 · 配置任务', '第 2 步 / 共 3 步 · 設定任務', 'Step 2 of 3 · Set up the task')} · ${pfName} · ${scriptName(script)}`
              : `${pfName} · ${device?.vendor || device?.id || ''}`}</p>
          </div>
          <button type="button" onClick={onCancel} aria-label={L('关闭', '關閉', 'Close')} className={`ml-auto -mt-1 text-lg leading-none ${sub} hover:text-claude-text dark:hover:text-white`}>✕</button>
        </div>
        <div className={`flex items-center gap-2 px-5 pt-3 pb-3 border-b ${bd} overflow-x-auto`}>
          {steps.map((k, i) => (
            <React.Fragment key={k}>
              {i > 0 && <span className="flex-1 min-w-[12px] max-w-[36px] h-px bg-black/15 dark:bg-white/15" />}
              <span className={`inline-flex items-center gap-1.5 text-xs whitespace-nowrap ${i === idx ? `font-bold ${txt}` : sub}`}>
                <span className="w-5 h-5 rounded-full grid place-items-center text-[11px] border"
                  style={i === idx ? { background: '#00FF88', borderColor: '#00FF88', color: '#04140c' } : i < idx ? { background: 'rgba(0,255,136,0.12)', borderColor: 'rgba(0,255,136,0.5)', color: '#00CC6E' } : undefined}>{i < idx ? '✓' : i + 1}</span>
                {stepName[k]}
              </span>
            </React.Fragment>
          ))}
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4 flex flex-col gap-4">
          {step === 'task' && (<>
            {!batch && (
              <div><span className={label}>{L('任务类型', '任務類型', 'Task type')}</span>
                <Dropdown<ScriptId> ariaLabel={L('任务类型', '任務類型', 'Task type')} value={script} onChange={setScript}
                  options={scripts.map((id) => ({ v: id, label: `${isLead(id) ? '🎯' : isEngage(id) ? '📈' : '💬'} ${scriptShort(id)}` }))} /></div>
            )}
            <div><span className={label}>{L('模式', '模式', 'Mode')}</span>
              <Dropdown<'keywords' | 'precise'> ariaLabel={L('模式', '模式', 'Mode')} value={mode} onChange={setMode}
                options={[{ v: 'keywords', label: `🔎 ${L('关键词模式', '關鍵詞模式', 'Keyword mode')}` },
                  { v: 'precise', label: `🎯 ${lead ? (isTiktok ? L('精准模式 · 同行账号', '精準模式 · 同行帳號', 'Precise · rival accounts') : L('精准模式 · 同行 / 作品链接', '精準模式 · 同行 / 作品連結', 'Precise · rival / post links')) : L('精准模式 · 作品 / 主页链接', '精準模式 · 作品 / 主頁連結', 'Precise · video / profile links')}` }]} />
            </div>
            <div>
              {/* 输入框上面给个标题,不然一个空框不知道填什么 */}
              <span className={label}>{mode === 'keywords' ? (engage ? L(`关键词(每行一个,最多 ${ENGAGE_CEIL.keywords} 个)`, `關鍵詞(每行一個,最多 ${ENGAGE_CEIL.keywords} 個)`, `Keywords (one per line, up to ${ENGAGE_CEIL.keywords})`) : L('关键词(每行一个)', '關鍵詞(每行一個)', 'Keywords (one per line)'))
                : !isTiktok ? (lead
                  ? (platform === 'xhs' ? L('同行主页链接 / 笔记链接(每行一个)', '同行主頁連結 / 筆記連結(每行一個)', 'Rival profile links / note links (one per line)') : L('同行主页链接 / 作品链接(每行一个)', '同行主頁連結 / 作品連結(每行一個)', 'Rival profile links / post links (one per line)'))
                  : (platform === 'xhs' ? L('笔记链接 / 主页链接(每行一个)', '筆記連結 / 主頁連結(每行一個)', 'Note links / profile links (one per line)') : L('作品链接 / 主页链接(每行一个)', '作品連結 / 主頁連結(每行一個)', 'Post links / profile links (one per line)')))
                : lead ? L('同行账号 / 作品链接(每行一个)', '同行帳號 / 作品連結(每行一個)', 'Rival accounts / post links (one per line)') : L('作品链接 / 主页链接 / 用户 ID(每行一个)', '作品連結 / 主頁連結 / 用戶 ID(每行一個)', 'Video link / profile link / user ID (one per line)')}</span>
              {mode === 'keywords' ? (
                <textarea className={input} rows={4} value={keywords} onChange={(e) => setKeywords(e.target.value)}
                  placeholder={L('每行一个关键词,例如 latte art', '每行一個關鍵詞,例如 latte art', 'One keyword per line, e.g. latte art')} />
              ) : (
                <textarea className={input} rows={4} value={targets} onChange={(e) => setTargets(e.target.value)}
                  placeholder={!isTiktok
                    ? (platform === 'xhs'
                      ? L(`每行一个,最多 50 条,例如:\nhttps://xhslink.com/…\n在小红书里打开主页或笔记,点「分享 → 复制链接」`, `每行一個,最多 50 條,例如:\nhttps://xhslink.com/…\n在小紅書裡打開主頁或筆記,點「分享 → 複製連結」`, `One per line, up to 50, e.g.:\nhttps://xhslink.com/…\nIn RedNote open a profile or note and tap Share → Copy link`)
                      : L(`每行一个,最多 50 条,例如:\nhttps://v.douyin.com/…\n在抖音里打开主页或作品,点「分享 → 复制链接」`, `每行一個,最多 50 條,例如:\nhttps://v.douyin.com/…\n在抖音裡打開主頁或作品,點「分享 → 複製連結」`, `One per line, up to 50, e.g.:\nhttps://v.douyin.com/…\nIn Douyin open a profile or post and tap Share → Copy link`))
                    : lead
                    ? L('每行一个,例如:\n@cafe_rival(同行账号,收他作品评论区里的人)\nhttps://www.tiktok.com/@name/video/…(只收这条作品的评论区)', '每行一個,例如:\n@cafe_rival(同行帳號,收他作品評論區裡的人)\nhttps://www.tiktok.com/@name/video/…(只收這條作品的評論區)', 'One per line, e.g.:\n@cafe_rival (rival account: collects its commenters)\nhttps://www.tiktok.com/@name/video/… (that post\'s commenters only)')
                    : L('每行一个,例如:\nhttps://www.tiktok.com/@name/video/…\n@name(用户 ID,会做这个人主页的作品)', '每行一個,例如:\nhttps://www.tiktok.com/@name/video/…\n@name(用戶 ID,會做這個人主頁的作品)', 'One per line, e.g.:\nhttps://www.tiktok.com/@name/video/…\n@name (user ID: works that profile\'s videos)')} />
              )}
            </div>
          </>)}

          {step === 'act' && engage && (<>
            {/* 互动涨粉:每个动作一行,右边填本次数量(0 = 不做) */}
            <div className={`flex flex-col gap-3 p-4 rounded-2xl border ${bd}`}>
              {([
                ['like', L('👍 点赞', '👍 點讚', '👍 Likes'), L(`给作品点赞 · 0 = 不点赞 · 最多 ${ENGAGE_CEIL.likes}`, `給作品點讚 · 0 = 不點讚 · 最多 ${ENGAGE_CEIL.likes}`, `Like posts · 0 = off · max ${ENGAGE_CEIL.likes}`), eLike, setELike],
                ['fav', L('⭐ 收藏', '⭐ 收藏', '⭐ Favorites'), L(`收藏作品 · 0 = 不收藏 · 最多 ${ENGAGE_CEIL.favorites}`, `收藏作品 · 0 = 不收藏 · 最多 ${ENGAGE_CEIL.favorites}`, `Save posts to favorites · 0 = off · max ${ENGAGE_CEIL.favorites}`), eFav, setEFav],
                ['follow', L('➕ 关注', '➕ 關注', '➕ Follows'), L(`关注作品的作者 · 0 = 不关注 · 最多 ${ENGAGE_CEIL.follows}`, `關注作品的作者 · 0 = 不關注 · 最多 ${ENGAGE_CEIL.follows}`, `Follow the post's author · 0 = off · max ${ENGAGE_CEIL.follows}`), eFollow, setEFollow],
                ['comment', L('💬 评论', '💬 評論', '💬 Comments'), L(`在作品下评论(下一步设置内容)· 0 = 不评论 · 最多 ${ENGAGE_CEIL.comments}`, `在作品下評論(下一步設定內容)· 0 = 不評論 · 最多 ${ENGAGE_CEIL.comments}`, `Comment on posts (content set next) · 0 = off · max ${ENGAGE_CEIL.comments}`), eComment, setEComment],
              ] as const).map(([k, title, desc, v, setV], i) => (
                <div key={k} className={`flex items-center gap-3 ${i > 0 ? `pt-3 border-t ${bd}` : ''}`}>
                  <div className="min-w-0 flex-1"><b className={`block text-sm ${txt}`}>{title}</b><span className={`text-xs ${sub}`}>{desc}</span></div>
                  <input className={numBox} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} aria-label={title} />
                </div>
              ))}
              {engageN.comments > 0 && (
                <div className={`flex items-center gap-3 pt-3 border-t ${bd}`}>
                  <div className="min-w-0 flex-1"><b className={`block text-sm ${txt}`}>{L('每条最多评论', '每條最多評論', 'Max comments per post')}</b>
                    <span className={`text-xs ${sub}`}>{L('同一条作品最多评论几条(1-5)', '同一條作品最多評論幾條(1-5)', 'Comments on the same post (1-5)')}</span></div>
                  <input className={numBox} inputMode="numeric" value={ePerWork} onChange={(e) => { const v = e.target.value.replace(/\D/g, '').slice(0, 1); setEPerWork(v ? String(Math.max(1, Math.min(5, Number(v)))) : ''); }} aria-label={L('每条最多评论', '每條最多評論', 'Max comments per post')} />
                </div>
              )}
            </div>
            <p className={`m-0 text-xs ${sub}`}>{L('数量都是本次运行的总量,至少一项大于 0。', '數量都是本次運行的總量,至少一項大於 0。', 'All numbers are totals for one run; set at least one above 0.')}</p>
          </>)}

          {step === 'act' && !engage && (<>
            {/* 和「评论设置」一样的交互:每个动作一行,右边开关;打开后在下面填最多数量和间隔 */}
            <div className={`flex flex-col gap-4 p-4 rounded-2xl border ${bd}`}>
              {([
                ['like', L('点赞评论', '點讚評論', 'Like comments'), L('给评论区的评论点赞', '給評論區的評論點讚', 'Like comments under the video'), doLike, () => setDoLike((v) => !v),
                  nLike, setNLike, likeGap, setLikeGap, L('次', '次', ''), L('点赞', '點讚', 'Like')],
                ['reply', L('回复评论', '回覆評論', 'Reply to comments'), L('给评论写回复(下一步设置内容)', '給評論寫回覆(下一步設定內容)', 'Reply to comments (content set next)'), doReply, () => setDoReply((v) => !v),
                  nReply, setNReply, replyGap, setReplyGap, L('条', '條', ''), L('评论', '評論', 'Reply')],
              ] as const).map(([k, title, desc, on, toggle, n, setN, gap, setGap, unit, short], i) => (
                <div key={k} className={`flex flex-col gap-2.5 ${i > 0 ? `pt-4 border-t ${bd}` : ''}`}>
                  <div className="flex items-center gap-3">
                    <div className="min-w-0"><b className={`block text-sm ${txt}`}>{title}</b>
                      <span className={`text-xs ${sub}`}>{on ? desc : L('已关闭:不做这个动作', '已關閉:不做這個動作', 'Off: skipped')}</span></div>
                    <span className="ml-auto" /><Toggle on={on} onClick={toggle} label={title} />
                  </div>
                  {on && (
                    <div className="flex items-center gap-2 flex-wrap text-[13px]">
                      <span className={sub}>{L('最多', '最多', 'Max')}</span>
                      <input className={numBox} inputMode="numeric" value={n} placeholder={L('不限', '不限', 'No limit')} onChange={(e) => setN(e.target.value.replace(/\D/g, ''))} aria-label={`${short} ${L('最多数量', '最多數量', 'max')}`} />
                      <span className={sub}>{unit} · {L('间隔', '間隔', 'gap')}</span>
                      <input className={numBox} inputMode="numeric" value={gap} placeholder={k === 'like' ? '1' : '30'} onChange={(e) => setGap(e.target.value.replace(/\D/g, ''))} aria-label={`${short} ${L('间隔秒数', '間隔秒數', 'gap (s)')}`} />
                      <span className={sub}>{L('秒', '秒', 's')}</span>
                    </div>
                  )}
                </div>
              ))}
            </div>
            <p className={`m-0 text-xs ${sub}`}>{L('至少打开一个。最多数量留空 = 不限,有多少做多少;间隔 = 做完一个再等几秒做下一个,留空用默认(点赞 1 秒、评论 30 秒)。', '至少打開一個。最多數量留空 = 不限,有多少做多少;間隔 = 做完一個再等幾秒做下一個,留空用預設(點讚 1 秒、評論 30 秒)。', 'Turn on at least one. Leave max empty for no limit. Gap = seconds to wait between actions; empty uses the default (likes 1 s, replies 30 s).')}</p>
          </>)}

          {step === 'cmt' && (
            <div className={`flex flex-col gap-4 p-4 rounded-2xl border ${bd}`}>
              <div className="flex items-center gap-3">
                <div className="min-w-0"><b className={`block text-sm ${txt}`}>{L('AI 自主评论', 'AI 自主評論', 'AI replies')}</b>
                  <span className={`text-xs ${sub}`}>{aiComment ? (lead ? L('AI 根据潜客作品的内容写评论', 'AI 根據潛客作品的內容寫評論', 'AI writes a comment from the lead\'s post') : engage ? L('AI 根据作品内容写评论', 'AI 根據作品內容寫評論', 'AI writes a comment from the post') : L('AI 根据视频和评论内容写回复', 'AI 根據影片和評論內容寫回覆', 'AI writes a reply from the video and comment')) : L('已关闭:评论只发引流语', '已關閉:評論只發引流語', 'Off: replies are only the funnel line')}</span></div>
                <span className="ml-auto" /><Toggle on={aiComment} onClick={() => setAiComment((v) => !v)} label={L('AI 自主评论', 'AI 自主評論', 'AI replies')} />
              </div>
              <div>
                <span className={label}>{L('引流语', '引流語', 'Funnel lines')} <span className="font-normal">· {aiComment ? L('选填', '選填', 'optional') : L('必填', '必填', 'required')} · {L('一行一条,随机选一条', '一行一條,隨機選一條', 'one per line, picked at random')}</span></span>
                <textarea className={input} rows={4} value={funnel} onChange={(e) => setFunnel(e.target.value)}
                  placeholder={L('一行一条,例如:\n完整教程在我主页置顶视频,需要的可以去看\n同款清单私信我发你', '一行一條,例如:\n完整教程在我主頁置頂影片,需要的可以去看\n同款清單私訊我發你', 'One per line, e.g.:\nFull tutorial pinned on my profile\nDM me for the list')} />
              </div>
              <div className="flex items-center gap-3">
                <div className="min-w-0"><b className={`block text-sm ${txt}`}>{L('AI 改写引流语', 'AI 改寫引流語', 'AI rewrites funnel lines')}</b>
                  <span className={`text-xs ${sub}`}>{L('每次换个说法,避免重复', '每次換個說法,避免重複', 'A fresh wording each time')}</span></div>
                <span className="ml-auto" /><Toggle on={rewrite} onClick={() => setRewrite((v) => !v)} label={L('AI 改写引流语', 'AI 改寫引流語', 'AI rewrites funnel lines')} />
              </div>
              {aiComment && (
                <div>
                  <span className={label}>{L('引流语概率', '引流語機率', 'Funnel probability')} <span className="font-normal">· {L('多少比例的评论带上引流语', '多少比例的評論帶上引流語', 'share of replies that carry a funnel line')}</span></span>
                  <div className="flex items-center gap-3">
                    <input type="range" min={0} max={100} step={10} value={prob} onChange={(e) => setProb(Number(e.target.value))} className="flex-1 accent-[#00ff88]" aria-label={L('引流语概率', '引流語機率', 'Funnel probability')} />
                    <b className="w-11 text-right text-green-600 dark:text-claude-accent tabular-nums">{prob}%</b>
                  </div>
                </div>
              )}
            </div>
          )}

          {step === 'lvl' && (<>
            {/* 和浏览器的定向获客一样:本次潜客数 + 三个动作各自的本次总量 */}
            <div className={`flex flex-col gap-3 p-4 rounded-2xl border ${bd}`}>
              {([
                ['like', L('👍 本次点赞目标', '👍 本次點讚目標', '👍 Like target this run'), platform === 'douyin'
                  ? L(`给潜客的第一条作品点赞 · 0 = 不点赞 · 最多 ${LEAD_CEIL.likes}`, `給潛客的第一條作品點讚 · 0 = 不點讚 · 最多 ${LEAD_CEIL.likes}`, `Likes the lead's first post · 0 = off · max ${LEAD_CEIL.likes}`)
                  : platform === 'xhs'
                  ? L(`点赞的总量 · 0 = 不点赞 · 最多 ${LEAD_CEIL.likes}`, `點讚的總量 · 0 = 不點讚 · 最多 ${LEAD_CEIL.likes}`, `Total likes · 0 = off · max ${LEAD_CEIL.likes}`)
                  : L(`每个潜客都点(最多 2 条作品);不够这个数会回评论区给潜客的留言补赞 · 基础版及以上会员点赞免费 · 0 = 不点赞`, `每個潛客都點(最多 2 條作品);不夠這個數會回評論區給潛客的留言補讚 · 基礎版及以上會員點讚免費 · 0 = 不點讚`, `Every lead is liked (up to 2 posts); short of this, the run likes the leads' comments · likes free for Basic members and up · 0 = off`), lLike, setLLike],
                ['follow', L('👤 本次关注最大数量', '👤 本次關注最大數量', '👤 Total follows this run'), L(`还有额度就关注 · 0 = 不关注 · 最多 ${LEAD_CEIL.follows}`, `還有額度就關注 · 0 = 不關注 · 最多 ${LEAD_CEIL.follows}`, `Follows while the total lasts · 0 = off · max ${LEAD_CEIL.follows}`), lFollow, setLFollow],
                ['comment', L('💬 本次评论最大数量', '💬 本次評論最大數量', '💬 Total comments this run'), L(`还有额度就在他第一条作品下评论一条(下一步设置内容)· 0 = 不评论 · 最多 ${LEAD_CEIL.comments}`, `還有額度就在他第一條作品下評論一條(下一步設定內容)· 0 = 不評論 · 最多 ${LEAD_CEIL.comments}`, `Comments on their first post while the total lasts (content set next) · 0 = off · max ${LEAD_CEIL.comments}`), lComment, setLComment],
              ] as const).map(([k, title, desc, v, setV], i) => (
                <div key={k} className={`flex items-center gap-3 ${i > 0 ? `pt-3 border-t ${bd}` : ''}`}>
                  <div className="min-w-0 flex-1"><b className={`block text-sm ${txt}`}>{title}</b><span className={`text-xs ${sub}`}>{desc}</span></div>
                  <input className={numBox} inputMode="numeric" value={v} onChange={(e) => setV(e.target.value.replace(/\D/g, ''))} aria-label={title} />
                </div>
              ))}
            </div>
            <p className={`m-0 text-xs ${sub}`}>{platform === 'douyin'
              ? L('在来源评论区里找到的每个新潜客马上互动:还有关注额度就关注、点他第一条作品的赞、还有评论额度就评论;私密号 / 没作品的跳过。',
                '在來源評論區裡找到的每個新潛客馬上互動:還有關注額度就關注、點他第一條作品的讚、還有評論額度就評論;私密號 / 沒作品的跳過。',
                'Every new lead found in the sources\' comment sections is engaged right away: follow while the follow total lasts, like their first post, comment while the comment total lasts; private / empty accounts are skipped.')
              : platform === 'xhs'
              ? L('在来源评论区里找到的每个新潜客只做一个动作:按剩余额度的比例在评论 / 关注 / 点赞里选一个。',
                '在來源評論區裡找到的每個新潛客只做一個動作:按剩餘額度的比例在評論 / 關注 / 點讚裡選一個。',
                'Each new lead found in the sources\' comment sections gets exactly one action: comment, follow or like, picked by the remaining share of each total.')
              : L('采集不设上限:来源评论区里的人全部收(收过的不重复收),每收满 100 人先去互动这一批,再回去接着收。只互动这次收到的人,每人只互动一次:还有关注额度就关注、点他第一条作品(和下一条)的赞、还有评论额度就评论;私密号 / 没作品的跳过。',
              '採集不設上限:來源評論區裡的人全部收(收過的不重複收),每收滿 100 人先去互動這一批,再回去接著收。只互動這次收到的人,每人只互動一次:還有關注額度就關注、點他第一條作品(和下一條)的讚、還有評論額度就評論;私密號 / 沒作品的跳過。',
              'Collecting has no cap: everyone in the sources\' comment sections is collected (no duplicates); every 100 leads the run engages that batch, then goes back. Only this run\'s leads are engaged, once each: follow while the follow total lasts, like their first post (and the next), comment while the comment total lasts; private / empty accounts are skipped.')}</p>
          </>)}

          {step === 'freq' && (<>
            <p className={`m-0 text-xs ${sub}`}>{L('本任务:', '本任務:', 'This task: ')}{capsLine}</p>
            <div><span className={label}>{L('运行频率', '運行頻率', 'Schedule')}</span>
              <Dropdown<SchedKey> ariaLabel={L('运行频率', '運行頻率', 'Schedule')} value={sched} onChange={setSched} options={SCHEDULES.map((s) => ({ v: s.k, label: s.label() }))} />
              {sched === 'daily' && <input type="time" className={`${input} mt-2`} value={at} onChange={(e) => setAt(e.target.value)} aria-label={L('每天运行时间', '每天運行時間', 'Time of day')} />}
              {sched === 'random' && (
                <div className="mt-2 flex items-center gap-2">
                  <input type="time" className={input} value={rFrom} onChange={(e) => setRFrom(e.target.value)} aria-label={L('开始时间', '開始時間', 'From')} />
                  <span className={sub}>—</span>
                  <input type="time" className={input} value={rTo} onChange={(e) => setRTo(e.target.value)} aria-label={L('结束时间', '結束時間', 'To')} />
                </div>
              )}
              {sched === 'random' && <p className={`m-0 mt-1.5 text-xs ${sub}`}>{L('每天在这个时间段里随机挑一个时间运行一次(需要手机 App 0.8.7 以上)', '每天在這個時間段裡隨機挑一個時間運行一次(需要手機 App 0.8.7 以上)', 'Runs once a day at a random time in this window (phone app 0.8.7+)')}</p>}
            </div>
          </>)}
        </div>

        {err && <p className="m-0 px-5 text-sm text-[#ff5c7a]">{err}</p>}
        <div className="flex items-center gap-2 px-5 pt-3 pb-5">
          <span className={`mr-auto text-xs ${sub}`}>{L(`第 ${idx + 1} / ${steps.length} 步`, `第 ${idx + 1} / ${steps.length} 步`, `Step ${idx + 1} of ${steps.length}`)}</span>
          <button type="button" className={`${btnGhost} px-4 py-2 text-sm`} onClick={back}>{idx > 0 || batch ? L('上一步', '上一步', 'Back') : L('取消', '取消', 'Cancel')}</button>
          <button type="button" className={`${btnPrimary} px-4 py-2 text-sm`} disabled={saving} onClick={() => void next()}>
            {!isLast ? `${L('下一步:', '下一步:', 'Next: ')}${stepName[steps[idx + 1]]}`
              : batch ? L('下一步:确认手机', '下一步:確認手機', 'Next: confirm phones')
              : saving ? L('保存中…', '儲存中…', 'Saving…') : L('保存', '儲存', 'Save')}
          </button>
        </div>
      </div>
    </div>
  );
};

export default PhoneTaskEditor;
