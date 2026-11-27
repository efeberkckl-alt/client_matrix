import React, { useEffect, useRef, useState } from 'react';
import { Device, L, api, bd, btnGhost, btnPrimary, errText, normDevice, shortId, sub, surface, txt } from './cloudPhoneShared';
import { runPool } from './cloudPhoneBatch';

/**
 * 云手机指令进度窗口(单台 / 批量通用)。
 * 指令要等手机下次心跳(约 15 秒)才取走并执行,所以发出后逐台轮询手机状态,
 * 看到预期变化(开始运行 / 已停止 / 已拿到新任务列表)才算成功;超过 TIMEOUT 记为超时。
 * 窗口可以关掉(后台继续),全部结束后由 onFinished 汇报结果。
 */

export type ProgressKind = 'run' | 'stop' | 'tasks';
export interface CommandJob {
  /** 唯一 id,用作 React key / 区分任务。 */
  id: string;
  title: string;
  kind: ProgressKind;
  devices: Device[];
  /** 对一台手机发指令 / 保存任务。抛错 = 这台失败。 */
  send: (d: Device) => Promise<void>;
  /** 运行指令:每台要运行的任务 id(用来确认手机跑的是它)。 */
  runTaskIds?: Record<string, string>;
}
type State = 'send' | 'wait' | 'ok' | 'bad' | 'to';
interface Row { state: State; reason?: string; base: number; sentAt: number }

const TIMEOUT_MS = 45_000;
const POLL_MS = 3_000;
/** 手机一般多久响应(心跳间隔约 15 秒):进度条按这个节奏往前走 */
const EXPECT_MS = 18_000;

const okText = (k: ProgressKind) => (k === 'run' ? L('已开始运行', '已開始運行', 'Running')
  : k === 'stop' ? L('已停止', '已停止', 'Stopped') : L('手机已同步', '手機已同步', 'Synced'));

/** 手机状态里是否已经看到这个指令的效果。 */
function confirmed(kind: ProgressKind, d: Device, row: Row, taskId?: string): boolean {
  if (kind === 'stop') return !(d.online && d.running);
  if (kind === 'run') {
    if (d.online && d.running && (!taskId || !d.progress?.task_id || d.progress.task_id === taskId)) return true;
    // 很短的任务可能在两次轮询之间就跑完了:任务的最近运行时间更新也算
    const t = taskId ? d.tasks.find((x) => x.id === taskId) : null;
    return !!(t && t.last_run_at && t.last_run_at > row.base);
  }
  // 任务变更:手机发过一次新心跳 = 已经拿到新任务列表
  return d.last_seen > row.base;
}

export const CommandProgress: React.FC<{
  job: CommandJob;
  /** 关掉窗口但后台继续。 */
  hidden: boolean;
  onHide: () => void;
  onClose: () => void;
  /** 全部结束(成功 n 台、失败 / 超时 m 台);用于刷新列表 + 窗口已关时提示结果。 */
  onFinished: (ok: number, bad: number) => void;
}> = ({ job, hidden, onHide, onClose, onFinished }) => {
  const [rows, setRows] = useState<Record<string, Row>>(() => Object.fromEntries(job.devices.map((d) => [d.id, { state: 'send', base: 0, sentAt: 0 } as Row])));
  const [, setTick] = useState(0);
  const rowsRef = useRef(rows);
  rowsRef.current = rows;
  const alive = useRef(true);
  const finishedRef = useRef(false);
  const onFinishedRef = useRef(onFinished);
  onFinishedRef.current = onFinished;
  const [retry, setRetry] = useState(0);

  const patch = (id: string, r: Partial<Row>) => setRows((s) => ({ ...s, [id]: { ...s[id], ...r } }));

  // 发送(最多 4 台并发)。基准:运行 = 发出时间(对比任务最近运行时间);任务变更 = 当时的心跳时间。
  const sentFor = useRef(-1);
  useEffect(() => {
    alive.current = true;
    // 开发模式 StrictMode 会把 effect 跑两遍:同一轮(retry)只发一次,避免指令重复发送
    if (sentFor.current === retry) return () => { alive.current = false; };
    sentFor.current = retry;
    finishedRef.current = false;
    // 重试:只重发【发送失败】的;超时的指令其实已经发出(服务器还替手机留着),重发可能让手机执行两次 → 只再等一轮
    if (retry > 0) {
      const now = Date.now();
      job.devices.forEach((d) => { if (rowsRef.current[d.id]?.state === 'to') patch(d.id, { state: 'wait', sentAt: now }); });
    }
    const targets = job.devices.filter((d) => (retry === 0 ? true : rowsRef.current[d.id]?.state === 'bad'));
    targets.forEach((d) => patch(d.id, { state: 'send', reason: undefined }));
    void runPool(targets, async (d) => {
      const startedAt = Date.now();
      try {
        await job.send(d);
        // 任务变更:以【保存之后】那一刻的心跳时间为基准,之后再来一次心跳 = 手机已拿到新列表(宁可多等一轮,不误报)
        let base = startedAt;
        if (job.kind === 'tasks') {
          try { const fr = await api<{ device: unknown }>(`/devices/${encodeURIComponent(d.id)}`); base = (fr?.device ? normDevice(fr.device).last_seen : 0) || d.last_seen; }
          catch { base = d.last_seen; }
        }
        if (alive.current) patch(d.id, { state: 'wait', base, sentAt: Date.now() });
      } catch (e) {
        if (alive.current) patch(d.id, { state: 'bad', reason: errText(e) });
      }
    }, () => { /* 每行自己显示状态 */ });
    return () => { alive.current = false; };
  }, [retry]);

  // 轮询手机状态(一次拉整个列表),秒数每秒刷新
  useEffect(() => {
    const sec = setInterval(() => setTick((n) => n + 1), 1000);
    let busy = false;
    const poll = setInterval(async () => {
      const waiting = (Object.entries(rowsRef.current) as [string, Row][]).filter(([, r]) => r.state === 'wait');
      if (!waiting.length || busy) return;
      busy = true;
      try {
        const r = await api<{ devices: unknown[] }>('/devices');
        if (!alive.current) return;
        const byId = new Map<string, Device>((Array.isArray(r.devices) ? r.devices : []).map(normDevice).map((d) => [d.id, d] as [string, Device]));
        const now = Date.now();
        waiting.forEach(([id, row]) => {
          const d = byId.get(id);
          if (d && confirmed(job.kind, d, row, job.runTaskIds?.[id])) patch(id, { state: 'ok' });
          else if (now - row.sentAt > TIMEOUT_MS) patch(id, { state: 'to' });
        });
      } catch { /* 网络抖动:下一轮再看,超时照算 */ } finally { busy = false; }
    }, POLL_MS);
    return () => { clearInterval(sec); clearInterval(poll); };
  }, [job]);

  const list = job.devices.map((d) => ({ d, r: rows[d.id] || { state: 'send' as State, base: 0, sentAt: 0 } }));
  const fin = list.filter(({ r }) => r.state === 'ok' || r.state === 'bad' || r.state === 'to').length;
  const nOk = list.filter(({ r }) => r.state === 'ok').length;
  const nBad = fin - nOk;
  const done = fin === list.length;
  const tNow = Date.now();
  const partial = list.reduce((acc, { r }) => {
    if (r.state === 'send') return acc + 0.05;
    if (r.state === 'wait' && r.sentAt) return acc + Math.min(0.9, 0.1 + ((tNow - r.sentAt) / EXPECT_MS) * 0.8);
    return acc;
  }, 0);
  const barPct = done ? 100 : Math.min(99, Math.round(((fin + partial) / Math.max(1, list.length)) * 100));

  useEffect(() => {
    if (done && !finishedRef.current) { finishedRef.current = true; onFinishedRef.current(nOk, nBad); }
  }, [done, nOk, nBad]);

  // Esc = 关掉(进行中 = 后台继续)
  const escRef = useRef(() => {});
  escRef.current = done ? onClose : onHide;
  useEffect(() => {
    if (hidden) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') escRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [hidden]);

  if (hidden) return null;
  const now = Date.now();
  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={job.title}>
      <div className={`w-full max-w-[520px] max-h-[calc(100vh-32px)] overflow-auto rounded-2xl border ${bd} ${surface} p-5 flex flex-col gap-3 shadow-modal`}>
        <div className="flex items-start gap-2">
          <h2 className={`m-0 text-base font-bold ${txt}`}>{job.title} · {L(`${list.length} 台`, `${list.length} 台`, `${list.length}`)}</h2>
          <button type="button" onClick={done ? onClose : onHide} aria-label={L('关闭', '關閉', 'Close')}
            className={`ml-auto -mt-1 text-lg leading-none ${sub} hover:text-claude-text dark:hover:text-white`}>✕</button>
        </div>
        <p className={`m-0 text-[12.5px] leading-relaxed ${sub}`}>
          {done
            ? (nBad ? L('部分手机没有确认,可以重试失败的。', '部分手機沒有確認,可以重試失敗的。', 'Some phones did not confirm — you can retry them.') : L('全部完成。', '全部完成。', 'All done.'))
            : L('指令已发出,手机一般 15 秒内响应。可以关掉窗口,后台继续等结果。', '指令已發出,手機一般 15 秒內回應。可以關掉視窗,背景繼續等結果。', 'Sent — phones usually respond within 15 s. You can close this; it keeps waiting in the background.')}
        </p>
        <div className="h-2 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={barPct}>
          <div className="h-full rounded-full transition-all duration-700" style={{ width: `${barPct}%`, background: '#00FF88' }} />
        </div>
        <ul className={`list-none m-0 p-0 flex flex-col border ${bd} rounded-xl max-h-[280px] overflow-auto`}>
          {list.map(({ d, r }) => {
            const secs = r.sentAt ? Math.min(Math.round(TIMEOUT_MS / 1000), Math.floor((now - r.sentAt) / 1000)) : 0;
            const st = r.state === 'ok' ? <span className="text-green-600 dark:text-claude-accent">✓ {okText(job.kind)}</span>
              : r.state === 'bad' ? <span className="text-[#ff5c7a]" title={r.reason}>✗ {L('失败', '失敗', 'Failed')}{r.reason ? ` · ${r.reason}` : ''}</span>
              : r.state === 'to' ? <span className="text-amber-500 dark:text-amber-400">⏱ {L('超时未响应 · 手机可能离线', '逾時未回應 · 手機可能離線', 'No response — phone may be offline')}</span>
              : r.state === 'send' ? <span className={sub}>{L('发送中…', '發送中…', 'Sending…')}</span>
              : <span className={sub}>{L(`等待手机响应 ${secs}s`, `等待手機回應 ${secs}s`, `Waiting for the phone ${secs}s`)}</span>;
            return (
              <li key={d.id} className={`flex items-center gap-2 px-3 py-2 text-[12.5px] border-b last:border-b-0 ${bd}`}>
                <span className={`min-w-0 truncate ${txt}`}>{d.vendor || shortId(d.id)}</span>
                <span className={`font-mono text-[11px] ${sub}`}>{shortId(d.id)}</span>
                <span className="ml-auto text-right truncate max-w-[60%]">{st}</span>
              </li>
            );
          })}
        </ul>
        <div className={`text-[12.5px] ${sub}`}>
          {done
            ? <>{L('完成:', '完成:', 'Done: ')}<b className="text-green-600 dark:text-claude-accent">{L(`成功 ${nOk} 台`, `成功 ${nOk} 台`, `${nOk} OK`)}</b>
              {nBad > 0 && <b className="text-[#ff5c7a]">{L(`,失败 / 超时 ${nBad} 台`, `,失敗 / 逾時 ${nBad} 台`, `, ${nBad} failed / timed out`)}</b>}</>
            : L(`已完成 ${fin} / ${list.length}`, `已完成 ${fin} / ${list.length}`, `${fin} / ${list.length} done`)}
        </div>
        <div className="flex gap-1.5 justify-end">
          {!done && <button type="button" className={`${btnGhost} px-4 py-2 text-[12.5px]`} onClick={onHide}>{L('后台继续,先关闭', '背景繼續,先關閉', 'Keep going in background')}</button>}
          {done && nBad > 0 && <button type="button" className={`${btnGhost} px-4 py-2 text-[12.5px]`} onClick={() => setRetry((n) => n + 1)}>{L('重试失败的', '重試失敗的', 'Retry failed')}</button>}
          {done && <button type="button" className={`${btnPrimary} px-5 py-2 text-[12.5px]`} onClick={onClose}>{L('完成', '完成', 'Done')}</button>}
        </div>
      </div>
    </div>
  );
};

export default CommandProgress;
