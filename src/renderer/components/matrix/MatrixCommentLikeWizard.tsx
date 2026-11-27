import { normalizeCustomCommentPolicy, type CustomCommentPolicy } from '../../../types/matrixCommentPolicy';
/**
 * MatrixCommentLikeWizard — 矩阵版「TikTok · 评论区点赞评论」向导(type='comment_like')。
 *
 * 对应后端 tiktok_comment_like 剧本(2026-10-29 改版):
 *   精准模式 —— 逐条打开用户粘贴的作品 / 主页作品,翻完整个评论区,每条评论点赞 + 回复;
 *   关键词模式 —— 用各执行账号自己的关键词搜视频,按设置的视频数和每个视频回复数运行。
 *   表格自定义评论 —— 从工作簿读取链接和文案，按作品发布一级评论。
 *   点赞 / 回复可勾选,至少一个。回复由 AI 按评论逐条写(扣积分),点赞会员免费。
 *
 *   Step 1 — 模式 + 链接(精准)+ 要做的动作
 *   Step 2 — 选执行账号(可多选)
 *   Step 3 — 运行频率 + 摘要 + 条款
 *
 * 文案内联中/繁/英(同定向获客卡片的做法),不进 i18n 大表。
 */

import React, { useEffect, useMemo, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { presetAccountIds, usePresetUsed, usePresetPrune } from '../../uiEdition';
import { readTikTokCommentWorkbook } from '../../services/tiktokCommentWorkbook';
import type { CommentLikeMode, CommentPost } from '../../../types/matrixCommentPosts';
import { commentPostKey, commentVideoId, type CommentAssignmentPreview } from '../../../types/matrixCommentPlan';

type WizardStep = 1 | 2 | 3;

export const COMMENT_LIKE_MAX_LINKS = 20;
export const COMMENT_LIKE_MAX_MIN = 1;
export const COMMENT_LIKE_MAX_MAX = 5000; // 和 main/libs/matrix/types.ts COMMENT_LIKE_LIMITS.maxMax 一致
export const COMMENT_LIKE_MAX_DEFAULT = 100;

export interface WizardAccount { id: string; displayName: string; status: string; keywords?: string[]; group?: string; platform?: string; nickname?: string; displayId?: string; avatar?: string }

const TIKTOK_LINK_RE = /^https?:\/\/([\w-]+\.)?tiktok\.com\//i;

/** zh / zh-TW / 其它语言(英文)三选一。 */
const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

export interface CommentLikeWizardInput {
  name: string;
  accountIds: string[];
  concurrency: number;
  frequency: string;
  urls: string[];
  commentMode: CommentLikeMode;
  commentDoLike: boolean;
  commentDoReply: boolean;
  commentVideoLimit?: number;
  commentRepliesPerVideo?: number;
  commentPosts?: CommentPost[];
  customCommentPolicy?: CustomCommentPolicy;
  commentAssignmentPreview?: CommentAssignmentPreview;
}

export interface CommentAssignmentPreviewInput { commentPosts: CommentPost[]; accountIds: string[]; seed?: string }

interface Props {
  platformLabel: string;
  platform?: string;
  accounts: WizardAccount[];
  accountsLoading?: boolean;
  initialTask?: any | null;
  onCancel: () => void;
  onPreview: (input: CommentAssignmentPreviewInput) => Promise<CommentAssignmentPreview>;
  onSave: (input: CommentLikeWizardInput) => Promise<void> | void;
}

const MatrixCommentLikeWizard: React.FC<Props> = ({ platformLabel, platform, accounts, accountsLoading, initialTask, onCancel, onPreview, onSave }) => {
  const editing = !!initialTask;
  const [step, setStep] = useState<WizardStep>(1);

  const [linksText, setLinksText] = useState<string>(() => (initialTask?.commentMode !== 'custom' && Array.isArray(initialTask?.urls) ? initialTask.urls.join('\n') : ''));
  const parsedLinks = useMemo(() => linksText.split(/[\s\n]+/).map((s) => s.trim()).filter(Boolean), [linksText]);
  const validLinks = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    for (const u of parsedLinks) { if (TIKTOK_LINK_RE.test(u) && !seen.has(u)) { seen.add(u); out.push(u); } }
    return out;
  }, [parsedLinks]);
  const badLinks = useMemo(() => parsedLinks.filter((u) => !TIKTOK_LINK_RE.test(u)), [parsedLinks]);
  // 2026-10-29:不再设数量;改成 模式(精准 / 关键词)+ 要不要点赞 / 回复(至少一个)。
  const [mode, setMode] = useState<CommentLikeMode>(() => initialTask?.commentMode || 'precise');
  const custom = mode === 'custom';
  const [doLike, setDoLike] = useState<boolean>(() => !initialTask || initialTask.commentMode === 'custom' || initialTask.commentDoLike !== false);
  const [doReply, setDoReply] = useState<boolean>(() => !initialTask || initialTask.commentMode === 'custom' || initialTask.commentDoReply !== false);
  const [policy, setPolicy] = useState(() => normalizeCustomCommentPolicy(initialTask?.customCommentPolicy));
  const [commentPosts, setCommentPosts] = useState<CommentPost[]>(() => initialTask?.commentPosts || []);
  const [importIssues, setImportIssues] = useState<Awaited<ReturnType<typeof readTikTokCommentWorkbook>>['issues']>([]);
  const [importSheets, setImportSheets] = useState<Awaited<ReturnType<typeof readTikTokCommentWorkbook>>['sheets']>([]);
  const [workbookName, setWorkbookName] = useState('');
  const [importing, setImporting] = useState(false);
  const [importError, setImportError] = useState('');
  const customLinks = [...new Map(commentPosts.map(post => [commentVideoId(post), post.url])).values()];
  const customSummary = L(`${customLinks.length} 个作品 · ${commentPosts.length} 条评论`, `${customLinks.length} 個作品 · ${commentPosts.length} 則留言`, `${customLinks.length} posts · ${commentPosts.length} comments`);
  const [videoLimit, setVideoLimit] = useState<number>(initialTask?.commentVideoLimit ?? 10);
  const [repliesPerVideo, setRepliesPerVideo] = useState<number>(initialTask?.commentRepliesPerVideo ?? 3);

  const [selected, setSelected] = useState<Set<string>>(() => new Set<string>((initialTask ? (initialTask.accountIds || []) : presetAccountIds(platform)).map(String)));
  // 简洁版预选号:账号加载完后剔除不在本向导列表里的号(见 usePresetPrune)
  const presetUsed = usePresetUsed(initialTask, platform);
  usePresetPrune(presetUsed, accounts, accountsLoading, (live) => setSelected((prev) => { const n = new Set(Array.from(prev).filter((id) => live.has(id))); return n.size === prev.size ? prev : n; }));
  const [runInterval, setRunInterval] = useState<string>(initialTask?.frequency || 'once');
  const [saving, setSaving] = useState(false);
  const [planning, setPlanning] = useState(false);
  const [preview, setPreview] = useState<CommentAssignmentPreview | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { if (saveError) setSaveError(null); }, [linksText, mode, doLike, doReply, videoLimit, repliesPerVideo, selected, runInterval, commentPosts]);

  const importWorkbook = async (file: File) => {
    setImporting(true);
    setImportError('');
    try {
      const { posts, issues, sheets } = await readTikTokCommentWorkbook(await file.arrayBuffer());
      setCommentPosts(posts);
      setImportIssues(issues);
      setImportSheets(sheets);
      setWorkbookName(file.name);
    } catch {
      setImportError(L('无法读取工作簿，请选择有效的 .xlsx 文件', '無法讀取活頁簿，請選擇有效的 .xlsx 檔案', 'Could not read the workbook. Choose a valid .xlsx file.'));
    } finally {
      setImporting(false);
    }
  };

  const readyAccounts = accounts.filter((a) => a.status !== 'banned' && a.status !== 'login_required');
  const toggle = (id: string) => setSelected((prev) => { const n = new Set(prev); if (n.has(id)) n.delete(id); else n.add(id); return n; });
  const requestPreview = () => onPreview({ commentPosts, accountIds: [...selected], seed: preview?.seed });
  const unassigned = preview ? commentPosts.filter(post => {
    const key = commentPostKey(post);
    return !preview.ledger[key] && !preview.plan.owners[key];
  }).length : 0;

  const canAdvance: Record<WizardStep, { ok: boolean; reason?: string }> = {
    1: custom
      ? { ok: !importing && !importError && commentPosts.length > 0, reason: importError || L('请导入包含有效视频链接和评论文案的工作簿', '請匯入包含有效影片連結和留言文案的活頁簿', 'Import a workbook with post links and comment text') }
      : !doLike && !doReply
      ? { ok: false, reason: L('点赞和评论至少选一个', '按讚和留言至少選一個', 'Pick at least one: like or reply') }
      : mode === 'keywords' && (!Number.isInteger(videoLimit) || videoLimit < 1 || videoLimit > 1000 || (doReply && (!Number.isInteger(repliesPerVideo) || repliesPerVideo < 1 || repliesPerVideo > 300)))
      ? { ok: false, reason: L('视频数量请输入 1–1000 的整数,每个视频回复数请输入 1–300 的整数', '影片數量請輸入 1–1000 的整數,每個影片回覆數請輸入 1–300 的整數', 'Enter 1–1000 whole videos and 1–300 replies per video') }
      : mode === 'keywords'
      ? { ok: true }
      : validLinks.length === 0
      ? { ok: false, reason: L('请至少粘贴 1 个有效的 TikTok 作品或主页链接', '請至少貼上 1 個有效的 TikTok 作品或主頁連結', 'Paste at least one valid TikTok post or profile link') }
      : validLinks.length > COMMENT_LIKE_MAX_LINKS
        ? { ok: false, reason: L(`最多 ${COMMENT_LIKE_MAX_LINKS} 个链接`, `最多 ${COMMENT_LIKE_MAX_LINKS} 個連結`, `At most ${COMMENT_LIKE_MAX_LINKS} links`) }
        : { ok: true },
    2: { ok: selected.size > 0, reason: L('请至少选 1 个执行账号', '請至少選 1 個執行帳號', 'Select at least one account') },
    3: { ok: !custom || !!preview && !unassigned, reason: L('还有未分配的评论，请选择可用账号后更新预览', '還有未分配的留言，請選擇可用帳號後更新預覽', 'Select an available account and update the preview for unassigned comments.') },
  };

  const handleNext = async () => {
    if (planning || step === 3) return;
    if (!canAdvance[step].ok) { setSaveError(canAdvance[step].reason || ''); return; }
    setSaveError(null);
    if (custom && step === 2) {
      setPlanning(true);
      try { setPreview(await requestPreview()); }
      catch (error) { setSaveError(error instanceof Error ? error.message : String(error)); return; }
      finally { setPlanning(false); }
    }
    setStep((step + 1) as WizardStep);
  };

  const handleSave = async () => {
    if (saving) return;
    for (const s of [1, 2, 3] as WizardStep[]) { if (!canAdvance[s].ok) { setSaveError(canAdvance[s].reason || ''); setStep(s); return; } }
    setSaving(true);
    try {
      await onSave({
        // 名字是自动生成的(没被用户改过)就跟着模式 / 链接数重新生成;用户自己改过的保持不动。
        name: (initialTask?.name && !/评论区点赞|留言區按讚|Comment Lik|表格自定义评论|表格自訂留言|Workbook Comments/.test(initialTask.name) ? initialTask.name : '') || (custom
          ? L(`${platformLabel} 表格自定义评论`, `${platformLabel} 表格自訂留言`, `${platformLabel} Workbook Comments`)
          : mode === 'keywords'
          ? L(`${platformLabel} 评论区点赞评论(关键词)`, `${platformLabel} 留言區按讚留言(關鍵詞)`, `${platformLabel} Comment Like & Reply (keywords)`)
          : L(`${platformLabel} 评论区点赞评论(${validLinks.length} 条作品)`, `${platformLabel} 留言區按讚留言(${validLinks.length} 則作品)`, `${platformLabel} Comment Like & Reply (${validLinks.length} posts)`)),
        accountIds: Array.from(selected),
        concurrency: Math.max(1, selected.size),   // 勾几个号就几个号一起跑(同互动任务;runner 内部有上限兜底)
        frequency: custom ? 'once' : runInterval,
        urls: custom ? customLinks : mode === 'keywords' ? [] : validLinks.slice(0, COMMENT_LIKE_MAX_LINKS),
        commentMode: mode,
        commentDoLike: !custom && doLike,
        commentDoReply: !custom && doReply,
        commentPosts: custom ? commentPosts : undefined,
        customCommentPolicy: custom ? normalizeCustomCommentPolicy(policy) : undefined,
        commentAssignmentPreview: custom ? preview ?? undefined : undefined,
        commentVideoLimit: mode === 'keywords' ? videoLimit : undefined,
        commentRepliesPerVideo: mode === 'keywords' ? (doReply ? repliesPerVideo : 3) : undefined,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (custom && message === 'comment_assignment_preview_stale') {
        try {
          setPreview(await requestPreview());
          setSaveError(L('账号状态或发布记录已变化。请核对更新后的分工，再保存。', '帳號狀態或發佈紀錄已變更。請核對更新後的分工，再儲存。', 'Account availability or publication history changed. Review the updated assignments before saving.'));
        } catch (error) {
          setStep(2);
          setSaveError(error instanceof Error ? error.message : String(error));
        }
      } else {
        setSaveError(message || L('保存失败', '儲存失敗', 'Save failed'));
      }
    } finally { setSaving(false); }
  };

  const freqOptions: Array<[string, string]> = [
    ['once', L('仅手动运行', '僅手動執行', 'Manual only')],
    ['6h', L('每 6 小时', '每 6 小時', 'Every 6h')],
    ['daily_random', L('每天随机一次', '每天隨機一次', 'Once a day (random time)')],
  ];
  const freqLabel = custom ? freqOptions[0][1] : (freqOptions.find(([v]) => v === runInterval) || [runInterval, runInterval])[1];

  return (
    <div className="w-full max-w-2xl mx-auto rounded-2xl bg-white dark:bg-gray-900 border border-gray-200 dark:border-gray-800 shadow-sm overflow-hidden flex flex-col">
      <div className="flex items-center justify-between px-6 py-4 border-b border-gray-200 dark:border-gray-800 shrink-0">
        <div className="text-base font-semibold dark:text-white">💗 {editing ? L('编辑', '編輯', 'Edit') + ' · ' : ''}{platformLabel} · {L('评论区点赞评论', '留言區按讚留言', 'Comment Like & Reply')}</div>
        <div className="flex items-center gap-3">
          <span className="text-xs px-2.5 py-1 rounded-full border border-pink-500/40 text-pink-500 bg-pink-500/5">{L(`第 ${step}/3 步`, `第 ${step}/3 步`, `Step ${step}/3`)}</span>
          <button type="button" onClick={onCancel} disabled={saving} className="text-gray-400 hover:text-gray-600 dark:hover:text-gray-200">✕</button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto px-6 py-5 space-y-5">
        {step === 1 && (
          <>
            {/* 模式 */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{L('模式', '模式', 'Mode')}</label>
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
                {([
                  ['precise', L('🎯 精准模式', '🎯 精準模式', '🎯 Precise'), L('粘作品 / 主页链接,逐条处理', '貼作品 / 主頁連結,逐則處理', 'Paste post / profile links')],
                  ['keywords', L('🔍 关键词模式', '🔍 關鍵詞模式', '🔍 Keywords'), L('用各执行账号自己的关键词搜视频', '用各執行帳號自己的關鍵詞搜影片', "Search videos with each account's keywords")],
                  ['custom', L('📄 表格自定义评论', '📄 表格自訂留言', '📄 Workbook comments'), L('导入作品链接与文案，全程不用 AI', '匯入作品連結與文案，全程不用 AI', 'Import post links and text, without AI')],
                ] as Array<[CommentLikeMode, string, string]>).map(([v, t, d]) => (
                  <button key={v} type="button" onClick={() => setMode(v)} disabled={saving}
                    className={`text-left rounded-lg border px-3 py-2 transition-colors ${mode === v ? 'border-pink-500 bg-pink-500/10' : 'border-gray-300 dark:border-gray-700 hover:border-pink-500/50'}`}>
                    <div className={`text-sm font-semibold ${mode === v ? 'text-pink-500' : 'dark:text-gray-200'}`}>{t}</div>
                    <div className="text-[11px] text-gray-500 dark:text-gray-400 mt-0.5">{d}</div>
                  </button>
                ))}
              </div>
            </div>
            {custom ? (
              <div className="space-y-3">
                <label className="block space-y-2 text-sm dark:text-gray-200">
                  <span>{L('导入评论工作簿（.xlsx）', '匯入留言活頁簿（.xlsx）', 'Import comment workbook (.xlsx)')}</span>
                  <input type="file" accept=".xlsx" disabled={saving || importing} className="block w-full text-sm"
                    onChange={(e) => {
                      const file = e.currentTarget.files?.[0];
                      e.currentTarget.value = '';
                      if (file) void importWorkbook(file);
                    }} />
                </label>
                <p className="text-xs text-gray-500 dark:text-gray-400">{L('读取全部 Sheet，按「视频链接」与「自评话术／评论内容」表头配对，不限定评论列位置。单元格内每行文案各发一条评论。成功发布按普通评论计费。', '讀取全部 Sheet，依「影片連結」與「自評話術／評論內容」表頭配對，不限定留言欄位置。儲存格內每行文案各發一則留言。成功發佈按一般留言計費。', 'Read every sheet and match video and comment columns by header. Each line in a cell becomes one comment. Confirmed posts use the standard comment rate.')}</p>
                {importing && <p role="status" className="text-sm">{L('正在读取工作簿…', '正在讀取活頁簿…', 'Reading workbook…')}</p>}
                {importError && <p role="alert" className="text-sm text-red-600">{importError}</p>}
                {importSheets.length > 0 && <div className="overflow-x-auto rounded-lg border border-gray-200 dark:border-gray-700">
                  <table className="w-full text-xs text-left dark:text-gray-200">
                    <caption className="text-left px-3 py-2 font-medium">{L(`已检查全部 ${importSheets.length} 个 Sheet`, `已檢查全部 ${importSheets.length} 個 Sheet`, `Checked all ${importSheets.length} sheets`)}</caption>
                    <thead><tr className="bg-gray-50 dark:bg-gray-800"><th className="px-3 py-2">Sheet</th><th>{L('视频', '影片', 'Videos')}</th><th>{L('评论', '留言', 'Comments')}</th><th>{L('问题', '問題', 'Issues')}</th></tr></thead>
                    <tbody>{importSheets.map(sheet => <tr key={sheet.name} className="border-t border-gray-100 dark:border-gray-800"><td className="px-3 py-2">{sheet.name}</td><td>{sheet.videos}</td><td>{sheet.comments}</td><td>{sheet.issues || '—'}</td></tr>)}</tbody>
                  </table>
                </div>}
                {(workbookName || commentPosts.length > 0) && (
                  <details className="rounded-lg border border-gray-200 dark:border-gray-700 px-3 py-2 text-sm dark:text-gray-200">
                    <summary className="cursor-pointer">{[workbookName, customSummary].filter(Boolean).join(' · ')}</summary>
                    <ul className="mt-2 max-h-48 overflow-y-auto space-y-2 text-xs">
                      {commentPosts.map(({ url, text, sources }) => (
                        <li key={JSON.stringify([url, text])}><div>{text}</div><div className="break-all text-gray-500">{url}</div>{sources?.length ? <div className="text-gray-500">{sources.map(source => `${source.sheet} · ${L(`第 ${source.row} 行，第 ${source.comment} 条`, `第 ${source.row} 行，第 ${source.comment} 則`, `row ${source.row}, comment ${source.comment}`)}`).join('；')}</div> : null}</li>
                      ))}
                    </ul>
                  </details>
                )}
                {!!importIssues.length && (
                  <details className="text-xs text-amber-700 dark:text-amber-400">
                    <summary className="cursor-pointer">{L(`${importIssues.length} 处导入问题，点击查看`, `${importIssues.length} 處匯入問題，點擊查看`, `${importIssues.length} import issues, view details`)}</summary>
                    <ul className="mt-1 max-h-32 overflow-y-auto">
                      {importIssues.map(({ sheet, row, reason }) => (
                        <li key={JSON.stringify([sheet, row])}>{sheet} · {reason === 'headers' ? L('未识别到视频链接与评论表头，本表未导入', '未辨識到影片連結與留言表頭，本表未匯入', 'Missing video/comment headers; sheet not imported') : `${L(`第 ${row} 行`, `第 ${row} 行`, `row ${row}`)} · ${reason === 'url' ? L('缺少有效作品链接', '缺少有效作品連結', 'Missing valid post link') : L('缺少有效文案', '缺少有效文案', 'Missing valid comment text')}`}</li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            ) : <>
            <div className="rounded-lg border px-3 py-2 text-[11px] leading-relaxed border-pink-500/30 bg-pink-500/5 text-pink-700 dark:text-pink-300">
              💗 {mode === 'precise'
                ? L('每个执行账号逐条打开作品(主页链接会展开成他最近的作品),翻阅评论区并执行勾选的动作,链接用完为止。需要开 VPN。',
                    '每個執行帳號逐則打開作品(主頁連結會展開成他最近的作品),翻閱留言區並執行勾選的動作,連結用完為止。需要開 VPN。',
                    'Each account opens posts (profile links expand to recent posts), scrolls comments and performs the selected actions until links run out. VPN required.')
                : L('每个执行账号用自己的关键词搜视频,按下方数量运行。成功回复达到每视频上限就切换;意向评论不足时翻完评论区再切换,不用普通留言凑数。无评论或打不开的视频也计入视频数。每日安全上限和运行时长仍可能提前结束任务。需要开 VPN。',
                    '每個執行帳號用自己的關鍵詞搜影片,按下方數量執行。成功回覆達到每影片上限就切換;意向留言不足時翻完留言區再切換,不用普通留言湊數。無留言或打不開的影片也計入影片數。每日安全上限和執行時長仍可能提前結束任務。需要開 VPN。',
                    'Each account searches its own keywords. Switch at the reply limit or after scanning all comments; never fill the quota with unrelated comments. Empty or unavailable videos count toward the video limit. Daily and time limits apply. VPN required.')}
              {doReply && <div className="mt-1">{L('AI 逐屏识别购买意向和产品咨询,当前批次优先回复购买意向。每个账号保存回复明细并跨运行去重;发送结果未确认的也不自动重发。意向识别会产生 AI 调用费用。',
                'AI 逐屏辨識購買意向和產品諮詢,目前批次優先回覆購買意向。每個帳號儲存回覆明細並跨執行去重;發送結果未確認的也不自動重發。意向辨識會產生 AI 呼叫費用。',
                'AI screens each loaded batch for purchase intent and product questions, prioritizing purchase intent within that batch. Reply details are saved per account across runs; unconfirmed sends are not retried automatically. Screening uses additional AI calls.')}</div>}
            </div>
            {mode === 'precise' && (
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
                🔗 {L('作品或博主主页链接', '作品或博主主頁連結', 'Post or profile links')}<span className="text-xs text-gray-400 font-normal ml-1">{L(`每行 1 个,最多 ${COMMENT_LIKE_MAX_LINKS} 个`, `每行 1 個,最多 ${COMMENT_LIKE_MAX_LINKS} 個`, `one per line, up to ${COMMENT_LIKE_MAX_LINKS}`)}</span>
              </label>
              <textarea
                value={linksText}
                onChange={(e) => setLinksText(e.target.value)}
                placeholder={'https://www.tiktok.com/@user/video/...\nhttps://www.tiktok.com/@user/photo/...\nhttps://www.tiktok.com/@user  (博主主页 / profile)\nhttps://vm.tiktok.com/...'}
                rows={6}
                className="w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2 text-sm dark:text-white focus:outline-none focus:ring-2 focus:ring-pink-500/40 resize-y min-h-[120px] font-mono"
                disabled={saving}
              />
              <div className="flex items-center gap-3 text-[11px] mt-1">
                <span className="text-pink-500">{L(`有效 ${validLinks.length} 条`, `有效 ${validLinks.length} 則`, `${validLinks.length} valid`)}</span>
                {badLinks.length > 0 && <span className="text-amber-500">{L(`${badLinks.length} 条不是 TikTok 链接,会被忽略`, `${badLinks.length} 則不是 TikTok 連結,會被忽略`, `${badLinks.length} not TikTok links (ignored)`)}</span>}
                {validLinks.length > COMMENT_LIKE_MAX_LINKS && <span className="text-red-500">{L(`超过 ${COMMENT_LIKE_MAX_LINKS} 条上限`, `超過 ${COMMENT_LIKE_MAX_LINKS} 則上限`, `over the ${COMMENT_LIKE_MAX_LINKS}-link limit`)}</span>}
              </div>
            </div>
            )}
            {/* 要做的动作:至少一个 */}
            <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">{L('对每条评论做什么', '對每則留言做什麼', 'What to do on each comment')}<span className="text-xs text-gray-400 font-normal ml-1">{L('至少选一个', '至少選一個', 'pick at least one')}</span></label>
              <div className="flex flex-col gap-2">
                <label className="flex items-start gap-2 text-sm dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={doLike} onChange={(e) => setDoLike(e.target.checked)} disabled={saving} className="mt-0.5 h-4 w-4 accent-pink-500" />
                  <span>👍 {L('点赞', '按讚', 'Like')}<span className="text-[11px] text-gray-400 ml-1">{L('基础版及以上会员免费', '基礎版及以上會員免費', 'free for Basic members and up')}</span></span>
                </label>
                <label className="flex items-start gap-2 text-sm dark:text-gray-200 cursor-pointer">
                  <input type="checkbox" checked={doReply} onChange={(e) => setDoReply(e.target.checked)} disabled={saving} className="mt-0.5 h-4 w-4 accent-pink-500" />
                  <span>💬 {L('回复评论', '回覆留言', 'Reply')}<span className="text-[11px] text-gray-400 ml-1">{L('AI 按每条评论写,每条回复扣积分', 'AI 按每則留言寫,每則回覆扣積分', 'AI-written per comment; each reply costs credits')}</span></span>
                </label>
              </div>
            </div>
            {mode === 'keywords' && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <label className="text-sm dark:text-gray-200">
                  {L('每账号每次处理视频数', '每帳號每次處理影片數', 'Videos per account per run')}
                  <input type="number" min={1} max={1000} step={1} value={Number.isNaN(videoLimit) ? '' : videoLimit} onChange={(e) => setVideoLimit(e.target.valueAsNumber)} disabled={saving} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2" />
                </label>
                {doReply && <label className="text-sm dark:text-gray-200">
                  {L('每个视频回复评论数', '每個影片回覆留言數', 'Successful replies per video')}
                  <input type="number" min={1} max={300} step={1} value={Number.isNaN(repliesPerVideo) ? '' : repliesPerVideo} onChange={(e) => setRepliesPerVideo(e.target.valueAsNumber)} disabled={saving} className="mt-1 w-full rounded-lg border border-gray-300 dark:border-gray-700 bg-white dark:bg-gray-800 px-3 py-2" />
                </label>}
              </div>
            )}
            </>}
          </>
        )}

        {step === 2 && (
          <div>
            {custom && <p className="mb-2 text-xs text-gray-500">{L('同一视频的文案会随机分给所选可用账号，尽量均衡。每条文案只分给一个账号。', '同一影片的文案會隨機分給所選可用帳號，盡量均衡。每則文案只分給一個帳號。', 'Each video’s comments are split randomly and as evenly as possible across available selected accounts. Each comment is assigned once.')}</p>}
            <label className="text-sm font-medium dark:text-gray-200 mb-1.5 block">
              {L(`选择执行账号(${platformLabel},可多选)`, `選擇執行帳號(${platformLabel},可多選)`, `Accounts (${platformLabel}, multiple allowed)`)}
              <span className="text-xs text-gray-400 font-normal ml-1">{L(`已选 ${selected.size} 个`, `已選 ${selected.size} 個`, `${selected.size} selected`)}</span>
              {readyAccounts.length > 0 && (
                <button type="button" disabled={planning} className="ml-2 text-xs text-pink-500 hover:underline" onClick={() => setSelected(selected.size === readyAccounts.length ? new Set() : new Set(readyAccounts.map((a) => a.id)))}>
                  {selected.size === readyAccounts.length ? L('全不选', '全不選', 'Clear') : L('全选', '全選', 'Select all')}
                </button>
              )}
            </label>
            <div className="space-y-1.5 max-h-72 overflow-auto rounded-lg border border-gray-200 dark:border-gray-700 p-2">
              {accounts.length === 0 && accountsLoading && <div className="p-3 text-center text-xs text-gray-400">{L('账号加载中…', '帳號載入中…', 'Loading accounts…')}</div>}
              {accounts.length === 0 && !accountsLoading && (
                <div className="p-3 text-center space-y-2.5">
                  <div className="text-xs text-gray-400">{L(`还没有 ${platformLabel} 账号`, `還沒有 ${platformLabel} 帳號`, `No ${platformLabel} accounts yet`)}</div>
                  <button type="button" onClick={() => { window.dispatchEvent(new CustomEvent('noobclaw:show-matrix-accounts', { detail: { platform } })); onCancel(); }} className="inline-flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-white text-sm font-semibold bg-pink-500 hover:bg-pink-600 active:scale-95">{L('去添加账号', '去新增帳號', 'Add an account')}</button>
                </div>
              )}
              {accounts.map((a) => {
                const ready = a.status !== 'login_required' && a.status !== 'banned';
                const title = a.nickname || a.displayName;
                return (
                  <label key={a.id} className={`flex items-center gap-2.5 text-sm px-2 py-1.5 rounded ${ready ? 'dark:text-gray-200 cursor-pointer hover:bg-gray-100 dark:hover:bg-gray-800' : 'opacity-45 cursor-not-allowed'}`}>
                    <input type="checkbox" checked={selected.has(a.id)} onChange={() => toggle(a.id)} disabled={saving || planning || !(ready || custom && selected.has(a.id))} className="h-4 w-4 accent-pink-500 shrink-0" />
                    {a.avatar
                      ? <img src={a.avatar.replace(/^http:/, 'https:')} referrerPolicy="no-referrer" alt="" className="w-7 h-7 rounded-full object-cover bg-gray-200 dark:bg-gray-700 shrink-0" onError={(e) => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }} />
                      : <span className="w-7 h-7 rounded-full bg-pink-500/20 text-pink-500 flex items-center justify-center text-xs font-bold shrink-0">{(title || '?').slice(0, 1)}</span>}
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-1.5 min-w-0">
                        <span className="font-medium truncate dark:text-white">{title}</span>
                        {a.displayId && <span className="text-[11px] text-gray-500 dark:text-gray-400 shrink-0">@{a.displayId}</span>}
                        {mode === 'keywords' && ready && !(a.keywords && a.keywords.length) && <span className="text-[11px] text-amber-500 shrink-0">{L('没设关键词', '沒設關鍵詞', 'no keywords')}</span>}
                        {!ready && <span className="text-[11px] text-amber-500 shrink-0">{a.status === 'banned' ? L('已封禁', '已封鎖', 'banned') : L('掉线,需重新登录', '離線,需重新登入', 'logged out')}</span>}
                      </div>
                      <div className="text-[11px] text-gray-400 truncate">{a.displayName}{a.group ? ` · ${a.group}` : ''}</div>
                    </div>
                  </label>
                );
              })}
            </div>
          </div>
        )}

        {step === 3 && (
          <>
            {!custom && <div>
              <label className="text-sm font-medium dark:text-gray-200 mb-2 block">{L('运行频率', '執行頻率', 'Schedule')}</label>
              <div className="flex gap-2 flex-wrap">
                {freqOptions.map(([value, label]) => (
                  <button key={value} type="button" onClick={() => setRunInterval(value)} className={`px-2.5 py-1 rounded-md text-xs border transition-colors ${runInterval === value ? 'border-pink-500 bg-pink-500/10 text-pink-500 font-medium' : 'border-gray-300 dark:border-gray-700 text-gray-600 dark:text-gray-400 hover:border-pink-500/50'}`}>{label}</button>
                ))}
              </div>
            </div>}
            <div className="rounded-xl border border-gray-200 dark:border-gray-700 bg-gray-50 dark:bg-gray-800/50 px-4 py-3 text-sm space-y-1.5">
              <div className="font-semibold dark:text-gray-200 mb-1">{L('任务摘要', '任務摘要', 'Summary')}</div>
              <SummaryRow label={L('模式', '模式', 'Mode')} value={custom ? customSummary : mode === 'keywords' ? L('关键词模式(各账号自己的关键词)', '關鍵詞模式(各帳號自己的關鍵詞)', "Keywords (each account's own)") : L(`精准模式 · ${validLinks.length} 条链接`, `精準模式 · ${validLinks.length} 則連結`, `Precise · ${validLinks.length} links`)} />
              <SummaryRow label={L('执行账号', '執行帳號', 'Accounts')} value={L(`${selected.size} 个`, `${selected.size} 個`, `${selected.size}`)} />
              <SummaryRow label={L('动作', '動作', 'Actions')} value={custom ? L('发布自定义评论', '發佈自訂留言', 'Publish workbook comments') : [doLike ? L('点赞', '按讚', 'like') : '', doReply ? L('回复', '回覆', 'reply') : ''].filter(Boolean).join(' + ')} />
              {mode === 'keywords' && <SummaryRow label={L('运行数量', '執行數量', 'Limits')} value={L(`每账号每次最多 ${videoLimit} 个视频${doReply ? `,每个视频最多回复 ${repliesPerVideo} 条` : ''}`, `每帳號每次最多 ${videoLimit} 個影片${doReply ? `,每個影片最多回覆 ${repliesPerVideo} 則` : ''}`, `Up to ${videoLimit} videos per account per run${doReply ? `, up to ${repliesPerVideo} replies each` : ''}`)} />}
              <SummaryRow label={L('运行频率', '執行頻率', 'Schedule')} value={freqLabel} />
            </div>
            {custom && <fieldset className="grid grid-cols-2 gap-3 rounded-lg border border-black/10 dark:border-white/10 p-3">
              <legend className="px-1 text-sm">{L('本轮节奏', '本輪節奏', 'Round pacing')}</legend>
              <label className="col-span-2 flex items-center gap-2 text-sm">
                <input type="checkbox" checked={policy.homeWarmup === 'once'} onChange={e => setPolicy(p => ({ ...p, homeWarmup: e.target.checked ? 'once' : 'per_video' }))} />
                {L('仅首访预热首页（取消后每次切换视频前回首页）', '僅首訪預熱首頁（取消後每次切換影片前回首頁）', 'Warm up once (uncheck to visit home before each video)')}
              </label>
              {([
                ['accountLimit', L('单号每轮上限', '單號每輪上限', 'Per-account limit'), 300],
                ['restEvery', L('每隔几条休息', '每隔幾則休息', 'Rest every N comments'), 300],
                ['restMinMinutes', L('最短休息（分钟）', '最短休息（分鐘）', 'Min rest (minutes)'), 30],
                ['restMaxMinutes', L('最长休息（分钟）', '最長休息（分鐘）', 'Max rest (minutes)'), 30],
              ] as const).map(([key, label, max]) => <label key={key} className="text-xs">{label}
                <input type="number" min={1} max={max} value={policy[key] || ''} onChange={e => setPolicy(p => ({ ...p, [key]: Number(e.target.value) }))} className="block w-full rounded border border-black/15 dark:border-white/15 bg-transparent p-1.5" />
              </label>)}
            </fieldset>}
            {custom && preview && <CommentAssignmentDetails posts={commentPosts} accounts={accounts} selected={selected} preview={preview} unassigned={unassigned} />}
          </>
        )}
      </div>

      {saveError && (
        <div className="px-6 pt-2 pb-1 shrink-0">
          <div className="rounded-lg border px-3 py-2 text-xs leading-relaxed border-red-500/30 bg-red-500/5 text-red-600 dark:text-red-400">❌ {saveError}</div>
        </div>
      )}

      <div className="px-6 py-4 border-t border-gray-200 dark:border-gray-800 flex items-center gap-2 shrink-0">
        <button type="button" onClick={onCancel} disabled={saving} className="text-sm text-gray-500 dark:text-gray-400 hover:text-gray-700 dark:hover:text-gray-200 px-2">{L('取消', '取消', 'Cancel')}</button>
        <div className="flex-1" />
        {step > 1 && <button type="button" onClick={() => { setSaveError(null); setStep((step - 1) as WizardStep); }} disabled={saving || planning} className="px-4 py-2 rounded-lg text-sm font-medium border border-gray-300 dark:border-gray-700 text-gray-700 dark:text-gray-300 hover:bg-gray-100 dark:hover:bg-gray-800 disabled:opacity-50">{L('上一步', '上一步', 'Back')}</button>}
        {step < 3 ? (
          <button type="button" onClick={handleNext} disabled={saving || importing || planning} className="px-4 py-2 rounded-lg text-sm font-semibold bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50">{planning ? L('正在生成分工…', '正在產生分工…', 'Preparing assignments…') : L('下一步', '下一步', 'Next')}</button>
        ) : (
          <button type="button" onClick={handleSave} disabled={saving} className="px-5 py-2 rounded-lg text-sm font-semibold bg-pink-500 text-white hover:bg-pink-600 disabled:opacity-50">{saving ? L('保存中…', '儲存中…', 'Saving…') : (editing ? L('保存修改', '儲存修改', 'Save') : L('创建任务', '建立任務', 'Create task'))}</button>
        )}
      </div>
    </div>
  );
};

const CommentAssignmentDetails: React.FC<{
  posts: CommentPost[];
  accounts: WizardAccount[];
  selected: Set<string>;
  preview: CommentAssignmentPreview;
  unassigned: number;
}> = ({ posts, accounts, selected, preview, unassigned }) => {
  const names = new Map(accounts.map(account => [account.id, account.nickname || account.displayName]));
  const available = new Set(preview.availableAccountIds);
  const totals = new Map([...selected].map(id => [id, { videos: new Set<string>(), scheduled: 0, pending: 0, confirmed: 0 }]));
  const comments = posts.map(post => {
    const key = commentPostKey(post);
    const record = preview.ledger[key];
    const account = record ? record.accountId : preview.plan.owners[key];
    const status = record?.status ?? 'scheduled';
    const video = commentVideoId(post);
    if (account) {
      let total = totals.get(account);
      if (!total) totals.set(account, total = { videos: new Set(), scheduled: 0, pending: 0, confirmed: 0 });
      if (status === 'scheduled') total.videos.add(video);
      total[status]++;
    }
    return { key, post, account, status };
  });
  const unknownHistory = comments.filter(comment => !comment.account && comment.status !== 'scheduled').length;
  return <div className="rounded-lg border border-gray-200 dark:border-gray-700 p-3 space-y-2 text-xs dark:text-gray-200">
    <p className="font-medium">{L('账号分工预览', '帳號分工預覽', 'Account assignment preview')}</p>
    <p className="text-gray-500 dark:text-gray-400">{L('保存后按此分工执行。已确认的评论会跳过，待核验的评论由原账号核验。账号失效时，仅重新分配明确未发送的评论。', '儲存後依此分工執行。已確認的留言會跳過，待核驗的留言由原帳號核驗。帳號失效時，僅重新分配明確未送出的留言。', 'The saved plan is used during execution. Confirmed comments are skipped and the original account checks uncertain sends. Only never-sent comments can be reassigned if an account becomes unavailable.')}</p>
    <div className="overflow-x-auto">
      <table className="w-full text-left">
        <thead><tr><th className="py-1">{L('账号', '帳號', 'Account')}</th><th>{L('待发视频', '待發影片', 'Videos to post on')}</th><th>{L('待发', '待發', 'To send')}</th><th>{L('待核验', '待核驗', 'To verify')}</th><th>{L('已确认', '已確認', 'Confirmed')}</th></tr></thead>
        <tbody>{[...totals].map(([id, total]) => (
          <tr key={id} className="border-t border-gray-100 dark:border-gray-800">
            <td className="py-2">{names.get(id) || id}
              {!selected.has(id) ? <span className="ml-1 text-gray-500">{L('原账号', '原帳號', 'Original account')}</span>
                : !available.has(id) && <span className="ml-1 text-amber-700 dark:text-amber-400">{L('当前不可用', '目前無法使用', 'Currently unavailable')}</span>}
            </td>
            <td>{total.videos.size}</td><td>{total.scheduled}</td><td>{total.pending}</td><td>{total.confirmed}</td>
          </tr>
        ))}</tbody>
      </table>
    </div>
    {unassigned > 0 && <p role="status" className="text-amber-700 dark:text-amber-400">{L(`${unassigned} 条未分配，请选择可用账号。`, `${unassigned} 則未分配，請選擇可用帳號。`, `${unassigned} unassigned. Select an available account.`)}</p>}
    {unknownHistory > 0 && <p className="text-gray-500 dark:text-gray-400">{L(`${unknownHistory} 条历史记录没有原账号信息。`, `${unknownHistory} 則歷史紀錄沒有原帳號資訊。`, `${unknownHistory} historical records lack account information.`)}</p>}
    <details>
      <summary className="cursor-pointer font-medium">{L('查看逐条分工', '查看逐則分工', 'View individual assignments')}</summary>
      <ul className="mt-2 max-h-52 overflow-auto divide-y divide-gray-100 dark:divide-gray-800">
        {comments.map(({ key, post, account, status }) => (
          <li key={key} className="py-2">
            <div>{post.text}</div>
            <div className="text-gray-500 dark:text-gray-400 break-all">
              {L('视频', '影片', 'Video')} {commentVideoId(post)} · {account ? names.get(account) || account : status === 'scheduled' ? L('未分配', '未分配', 'Unassigned') : L('原账号未知', '原帳號未知', 'Original account unknown')} · {status === 'confirmed' ? L('已确认', '已確認', 'Confirmed') : status === 'pending' ? L('待核验', '待核驗', 'To verify') : L('待发', '待發', 'To send')}
            </div>
          </li>
        ))}
      </ul>
    </details>
  </div>;
};

const SummaryRow: React.FC<{ label: string; value: string }> = ({ label, value }) => (
  <div className="flex gap-3 text-xs"><span className="text-gray-500 dark:text-gray-400 shrink-0 w-20">{label}</span><span className="text-gray-800 dark:text-gray-200 break-all">{value}</span></div>
);

export default MatrixCommentLikeWizard;
