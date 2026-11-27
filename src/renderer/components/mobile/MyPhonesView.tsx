import React, { useCallback, useEffect, useRef, useState } from 'react';
import { LoginGate, useLoggedIn } from '../common/LoginGate';
import { openWallet } from '../../services/walletNav';
import {
  ConsoleConfig, Device, L, PlatformId, asPlatform, taskName, TaskView, api, bd, deleteTask, errText, sendCommand, sub, surface, txt, visiblePlatforms, runHidden,
  normDevice, shortId,
} from './cloudPhoneShared';
import { AndroidIcon, ConfirmDialog, useComplianceHidden } from './cloudPhoneUi';
import { AddCard, GuideCard, PhoneCard } from './PhoneCard';
import PhoneTaskDetail from './PhoneTaskDetail';
import PhoneTaskEditor from './PhoneTaskEditor';
import BatchDialog from './BatchDialog';
import CommandProgress, { CommandJob } from './CommandProgress';
import { BatchAct, selectable } from './cloudPhoneBatch';
import './cloudPhone.css';

/**
 * 云手机 — phones running NoobClaw Mobile on this account, drawn as vertical phone cards. Any number of phones
 * may log in; the plan's phone_limit caps how many run at the same time. A setup-guide card follows the phones.
 * Commands reach the phone with its next heartbeat (~15 s). The task detail opens inline in this page.
 */

const PAGE = 9;

type Confirm = { kind: 'remove'; device: Device } | { kind: 'task'; device: Device; task: TaskView };
type StFilter = 'all' | 'online' | 'offline' | 'running' | 'idle';
const jobId = () => 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const MyPhonesView: React.FC<{ onUpgrade?: () => void }> = ({ onUpgrade }) => {
  const loggedIn = useLoggedIn();
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [limit, setLimit] = useState(0);
  const [plan, setPlan] = useState('');
  const [err, setErr] = useState('');
  const [msg, setMsg] = useState('');
  const [config, setConfig] = useState<ConsoleConfig | null>(null);
  const [page, setPage] = useState(1);
  const [sel, setSel] = useState<Record<string, PlatformId>>({});
  const [detail, setDetail] = useState<{ deviceId: string; taskId: string; platform: PlatformId } | null>(null);
  const [editor, setEditor] = useState<{ device: Device; task: TaskView | null; platform: PlatformId } | null>(null);
  const [confirm, setConfirm] = useState<Confirm | null>(null);
  const [busy, setBusy] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(() => new Set());
  const [batch, setBatch] = useState<BatchAct | null>(null);
  // 顶部一行筛选:状态 + 搜索(设备 ID / 型号 / IP / 账号)
  const [stFilter, setStFilter] = useState<StFilter>('all');
  const [q, setQ] = useState('');
  const [stOpen, setStOpen] = useState(false);
  // 没勾手机就点批量按钮 → 弹窗提示
  const [needPick, setNeedPick] = useState(false);
  // 指令进度窗口(单台 / 批量通用);hidden = 关掉窗口、后台继续
  // 可以同时有多个进度任务(上一个关掉后台等结果时又发了新指令):都保留,各自结束时刷新 + 提示
  const [jobs, setJobs] = useState<{ job: CommandJob; hidden: boolean; done?: boolean }[]>([]);
  const msgTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const hidden = useComplianceHidden();
  const platforms = visiblePlatforms(hidden);
  const pfNames = platforms.map((p) => p.name()).join(' / ');
  const detailVisible = !detail || platforms.some((p) => p.id === detail.platform);
  // Batch: run / create need a live visible platform; with no visible platform at all there is nothing to do.
  const liveVisible = platforms.some((p) => p.live);
  const batchOn = platforms.length > 0;
  const upgrade = useCallback(() => { if (onUpgrade) onUpgrade(); else openWallet('subscription'); }, [onUpgrade]);

  const flash = useCallback((t: string) => {
    setMsg(t);
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = setTimeout(() => setMsg(''), 5000);
  }, []);
  useEffect(() => () => { if (msgTimer.current) clearTimeout(msgTimer.current); }, []);

  // Polling guards: newest request wins, timer ticks skip while one is in flight, nothing is set after unmount.
  const seq = useRef(0);
  const inFlight = useRef(false);
  const alive = useRef(true);
  useEffect(() => { alive.current = true; return () => { alive.current = false; }; }, []);

  /** `force` = after a user action: run even if a poll is in flight (its stale answer is then ignored). */
  const load = useCallback(async (force = false) => {
    if (inFlight.current && !force) return;
    inFlight.current = true;
    const my = ++seq.current;
    try {
      const r = await api<{ devices: Device[]; phone_limit: number; plan: string; running_now?: number }>('/devices');
      if (!alive.current || my !== seq.current) return;
      setDevices((Array.isArray(r.devices) ? r.devices : []).map(normDevice).filter((x) => x.id));
      setLimit(Number(r.phone_limit) || 0);
      setPlan(String(r.plan || ''));
      setErr('');
    } catch (e) {
      if (alive.current && my === seq.current) setErr(errText(e));
    } finally {
      if (my === seq.current) inFlight.current = false;
    }
  }, []);
  // List polls every 10 s (paused while the task detail is open — it polls on its own).
  // 未登录:不轮询(没有 token 的请求回 401 会把刚登录的人又登出),清掉上一个账号的手机;登录 / 换号后马上重拉
  useEffect(() => {
    if (!loggedIn) { seq.current++; inFlight.current = false; setDevices(null); return; }
    if (detail) return;
    void load(true);
    const t = setInterval(() => { void load(); }, 10_000);
    return () => clearInterval(t);
  }, [load, detail, loggedIn]);
  useEffect(() => { if (!loggedIn) return; api<ConsoleConfig>('/config').then((c) => { if (alive.current) setConfig(c); }).catch(() => { /* guide buttons stay disabled */ }); }, [loggedIn]);
  // Close the detail page if the compliance config hides its task's platform.
  useEffect(() => { if (detail && !detailVisible) setDetail(null); }, [detail, detailVisible]);

  const closeDetail = useCallback(() => setDetail(null), []);
  // Selection survives polling; phones that disappear (or go over the limit) drop out.
  useEffect(() => {
    if (!devices) return;
    setPicked((s) => {
      const keep = new Set(devices.filter((d) => selectable(d) && s.has(d.id)).map((d) => d.id));
      return keep.size === s.size ? s : keep;
    });
  }, [devices]);

  const platformOf = (d: Device): PlatformId => {
    const s = sel[d.id];
    if (s && platforms.some((p) => p.id === s)) return s;
    return platforms[0]?.id || 'tiktok';
  };
  const startJob = (j: CommandJob) => setJobs((s) => [...s.filter((x) => !x.done).map((x) => ({ ...x, hidden: true })), { job: j, hidden: false }]);   // 已结束的旧窗口直接丢掉,别藏起来常驻
  const setHidden = (id: string, hidden: boolean) => setJobs((s) => s.map((x) => (x.job.id === id ? { ...x, hidden } : x)));
  const dropJob = (id: string) => setJobs((s) => s.filter((x) => x.job.id !== id));
  // 单台运行 / 停止:同样走进度窗口,等手机反馈再出结果
  const command = (d: Device, action: 'run' | 'stop', taskId?: string) => {
    startJob({
      id: jobId(), kind: action, devices: [d],
      title: action === 'run' ? L('运行', '運行', 'Run') : L('停止', '停止', 'Stop'),
      runTaskIds: action === 'run' && taskId ? { [d.id]: taskId } : undefined,
      send: (x) => sendCommand(x.id, action, taskId),
    });
  };
  const doConfirm = async () => {
    if (!confirm) return;
    if (confirm.kind === 'task') {
      // 删除任务:交给进度窗口(保存后等手机同步)
      const c = confirm;
      setConfirm(null);
      startJob({ id: jobId(), kind: 'tasks', devices: [c.device], title: L('删除任务', '刪除任務', 'Delete task'), send: (x) => deleteTask(x, c.task.id) });
      return;
    }
    setBusy(true);
    try {
      await api(`/devices/${encodeURIComponent(confirm.device.id)}`, { method: 'DELETE' });
      setConfirm(null);
      void load(true);
    } catch (e) {
      setConfirm(null);
      flash((confirm.kind === 'remove' ? L('移除失败：', '移除失敗：', 'Remove failed: ') : L('删除失败：', '刪除失敗：', 'Delete failed: ')) + errText(e));
    } finally { setBusy(false); }
  };

  // Cards: phones, then one setup-guide card.
  const all = devices || [];
  const qq = q.trim().toLowerCase();
  const filtering = stFilter !== 'all' || !!qq;
  // 跑的是合规隐藏平台的任务 → 当作没在运行(任务照跑,只是不显示)
  const isRun = (d: Device) => d.online && d.running && !runHidden(d, platforms);
  const list = all.filter((d) => {
    if (stFilter === 'online' && !d.online) return false;
    if (stFilter === 'offline' && d.online) return false;
    if (stFilter === 'running' && !isRun(d)) return false;
    if (stFilter === 'idle' && !(d.online && !isRun(d))) return false;
    if (!qq) return true;
    // 只搜可见平台的账号(隐藏平台的账号不出现在任何地方)
    const accts = platforms.map((x) => x.id).flatMap((k) => { const a = d.accounts?.[k]; return a ? [a.handle || '', a.nickname || ''] : []; });
    return [d.id, shortId(d.id), d.vendor, d.ip || '', ...accts].some((x) => String(x).toLowerCase().includes(qq));
  });
  const cards: React.ReactNode[] = list.map((d) => (
    <PhoneCard key={d.id} device={d} platforms={platforms} platform={platformOf(d)}
      onPlatform={(p) => setSel((s) => ({ ...s, [d.id]: p }))}
      onCreate={() => setEditor({ device: d, task: null, platform: platformOf(d) })}
      onView={(t) => setDetail({ deviceId: d.id, taskId: t.id, platform: asPlatform(t.platform) })}
      onRun={(t) => command(d, 'run', t.id)}
      onStop={(taskId) => command(d, 'stop', taskId)}
      onDeleteTask={(t) => setConfirm({ kind: 'task', device: d, task: t })}
      onRemove={() => setConfirm({ kind: 'remove', device: d })}
      onUpgrade={upgrade}
      picked={batchOn && picked.has(d.id)}
      onPick={!batchOn ? undefined : (on) => setPicked((s) => { const n = new Set(s); if (on) n.add(d.id); else n.delete(d.id); return n; })} />
  ));
  // 全选 = 当前状态 / 搜索条件下的全部手机(所有分页,不只这一页)
  const runningNow = (devices || []).filter(isRun).length;   // 同时运行的台数
  const selectableIds = list.filter(selectable).map((d) => d.id);
  const allPicked = selectableIds.length > 0 && selectableIds.every((id) => picked.has(id));
  const somePicked = !allPicked && selectableIds.some((id) => picked.has(id));
  const nPicked = picked.size;
  const barBtn = 'inline-flex items-center justify-center font-bold rounded-[10px] h-10 px-3.5 text-[13px] whitespace-nowrap transition-opacity hover:opacity-90 disabled:opacity-40 disabled:cursor-not-allowed';
  const openBatch = (a: BatchAct) => { if (!nPicked) { setNeedPick(true); return; } setBatch(a); };
  // 空槽位 / 增加槽位只在没筛选时显示
  if (devices && !filtering) {
    // 登录不限手机数:末尾固定一张「接入新手机」引导卡;会员数量只管同时运行的台数
    cards.push(<GuideCard key="slot-new" n={list.length + 1} config={config} />);
    // 最高档以外:一张「增加同时运行台数」→ 升级会员(会员数量限制的是同时运行的台数)
    if (devices.length && plan !== 'ultra' && plan !== 'max') cards.push(<AddCard key="add" onUpgrade={upgrade} />);
  }
  const pages = Math.max(1, Math.ceil(cards.length / PAGE));
  const cur = Math.min(page, pages);
  // 换筛选条件:回到第 1 页,不在新结果里的手机取消勾选(免得对看不见的手机误操作)
  const listKey = list.map((d) => d.id).join(',');
  useEffect(() => {
    setPage(1);
    const ids = new Set(listKey ? listKey.split(',') : []);
    setPicked((s) => { const keep = new Set([...s].filter((id) => ids.has(id))); return keep.size === s.size ? s : keep; });
  }, [stFilter, q]);
  const pageIds = new Set(list.slice((cur - 1) * PAGE, cur * PAGE).map((d) => d.id));
  const otherPicked = [...picked].filter((id) => !pageIds.has(id)).length;
  const ST_OPTS: [StFilter, string][] = [['all', L('全部状态', '全部狀態', 'All statuses')], ['online', L('在线', '在線', 'Online')], ['offline', L('离线', '離線', 'Offline')], ['running', L('运行中', '運行中', 'Running')], ['idle', L('空闲', '空閒', 'Idle')]];
  const pagerBtn = `min-w-[30px] h-[30px] px-2 rounded-lg border ${bd} ${surface} ${txt} text-[12.5px] tabular-nums disabled:opacity-35 disabled:cursor-default`;

  if (!loggedIn) return <LoginGate title={L('登录账号，管理你的云手机', '登入帳號，管理你的雲手機', 'Log in to manage your cloud phones')} />;   // 未登录不显示本地数据(2026-11-02)
  return (
    <div className="h-full overflow-y-auto overflow-x-hidden">
      <div className="max-w-[1180px] mx-auto px-5 pt-[18px] pb-6 flex flex-col gap-4">
        {!detail && (<>
          {/* 第一行:状态 · 搜索 · 重置 …… 右边批量按钮(默认实心亮色,不用先勾选) */}
          <div className="flex items-center gap-2.5 flex-wrap">
            <div className="relative">
              {stOpen && <div className="fixed inset-0 z-30" onClick={() => setStOpen(false)} />}
              <button type="button" aria-expanded={stOpen} onClick={() => setStOpen((o) => !o)}
                className="inline-flex items-center gap-2 h-10 px-3.5 rounded-xl text-sm font-bold bg-gray-200 dark:bg-[#202640] dark:text-white">
                {(ST_OPTS.find(([k]) => k === stFilter) || ST_OPTS[0])[1]}
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden><path d="M6 9l6 6 6-6" /></svg>
              </button>
              {stOpen && (
                <div className={`absolute left-0 top-[calc(100%+6px)] z-40 min-w-[150px] p-1.5 rounded-xl shadow-xl border ${bd} ${surface}`}>
                  {ST_OPTS.map(([k, label]) => (
                    <button key={k} type="button" onClick={() => { setStFilter(k); setStOpen(false); }}
                      style={stFilter === k ? { background: 'rgba(0,255,136,0.10)' } : undefined}
                      className={`w-full text-left text-sm px-2.5 py-2 rounded-lg ${stFilter === k ? 'text-claude-accent font-semibold' : `${txt} hover:bg-black/5 dark:hover:bg-white/5`}`}>{label}</button>
                  ))}
                </div>
              )}
            </div>
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder={L('搜索设备 ID / 型号 / IP / 账号', '搜尋設備 ID / 型號 / IP / 帳號', 'Search device ID / model / IP / account')}
              className={`h-10 w-60 text-sm px-3 rounded-xl border ${bd} bg-transparent ${txt}`} />
            <button type="button" onClick={() => { setStFilter('all'); setQ(''); setStOpen(false); }}
              className={`h-10 px-3 rounded-xl text-sm ${sub} hover:text-claude-text dark:hover:text-white`}>{L('重置', '重置', 'Reset')}</button>
            <span className="flex-1" />
            {devices && batchOn && (<>
              {liveVisible && <button type="button" onClick={() => openBatch('run')} className={`${barBtn} text-white`} style={{ background: '#2A63FF' }}>▶ {L('批量运行', '批量運行', 'Run')}</button>}
              <button type="button" onClick={() => openBatch('stop')} className={`${barBtn} text-white`} style={{ background: '#E0702D' }}>■ {L('批量停止', '批量停止', 'Stop')}</button>
              <button type="button" onClick={() => openBatch('del')} className={`${barBtn} text-white`} style={{ background: '#E5484D' }}>{L('批量删除任务', '批量刪除任務', 'Delete tasks')}</button>
              {liveVisible && <button type="button" onClick={() => openBatch('new')} className={`${barBtn} text-[#04140c]`} style={{ background: '#00FF88' }}>＋ {L('批量创建任务', '批量建立任務', 'Create tasks')}</button>}
            </>)}
          </div>
          {/* 第二行:全选 + 已选 …… 右边已用 / 翻页 */}
          <div className="flex items-center gap-2.5 flex-wrap min-h-[34px] -mt-1">
            {devices && batchOn && (
              <button type="button" role="checkbox" aria-checked={allPicked ? true : somePicked ? 'mixed' : false} disabled={!selectableIds.length}
                onClick={() => setPicked(allPicked ? new Set() : new Set(selectableIds))}
                className={`inline-flex items-center gap-2 text-[13px] ${sub} disabled:opacity-40`}>
                <span className="w-[17px] h-[17px] rounded-[5px] border-[1.5px] grid place-items-center text-[11px] font-black leading-none bg-transparent"
                  style={{ borderColor: allPicked || somePicked ? '#4D8DFF' : '#8B93B0', color: '#4D8DFF' }}>{allPicked ? '✓' : somePicked ? '—' : ''}</span>
                {L('全选', '全選', 'Select all')}
              </button>
            )}
            {nPicked > 0 && (
              <div className="inline-flex items-center gap-2.5 px-3 py-1.5 rounded-xl text-[13px] border" style={{ background: 'rgba(77,141,255,0.08)', borderColor: 'rgba(77,141,255,0.35)' }}>
                <span className={txt}>{L('已选', '已選', 'Selected')} <b style={{ color: '#7AA8FF' }}>{nPicked}</b> {L('台', '台', '')}</span>
                {otherPicked > 0 && <span className={sub}>{L(`(含其他页 ${otherPicked} 台)`, `(含其他頁 ${otherPicked} 台)`, `(${otherPicked} on other pages)`)}</span>}
                <button type="button" onClick={() => setPicked(new Set())} className={`${sub} hover:text-claude-text dark:hover:text-white`}>{L('取消选择', '取消選擇', 'Clear')}</button>
              </div>
            )}
            <nav className="ml-auto flex items-center gap-1 flex-wrap" aria-label={L('手机分页', '手機分頁', 'Phone pages')}>
              <span className={`text-xs mr-2 tabular-nums ${sub}`} title={L('会员可同时运行的手机数', '會員可同時運行的手機數', 'Phones your plan can run at once')}>{L('同时运行', '同時運行', 'Running')} {runningNow} / {limit}</span>
              <button type="button" className={pagerBtn} disabled={cur <= 1} onClick={() => setPage(cur - 1)} aria-label={L('上一页', '上一頁', 'Previous page')}>‹</button>
              {Array.from({ length: pages }, (_, i) => i + 1).map((n) => (
                <button key={n} type="button" aria-current={n === cur ? 'page' : undefined} onClick={() => setPage(n)}
                  className={n === cur ? `${pagerBtn} !bg-claude-accent !border-claude-accent !text-[#04140c] font-bold` : pagerBtn}>{n}</button>
              ))}
              <button type="button" className={pagerBtn} disabled={cur >= pages} onClick={() => setPage(cur + 1)} aria-label={L('下一页', '下一頁', 'Next page')}>›</button>
            </nav>
          </div>
        </>)}
        {err && <div className="text-sm text-[#ff5c7a]">{err}</div>}
        {msg && <div className="text-[12.5px] text-green-600 dark:text-claude-accent">{msg}</div>}

        {detail ? (
          <PhoneTaskDetail deviceId={detail.deviceId} taskId={detail.taskId} onBack={closeDetail} onJob={startJob} />
        ) : !devices ? (
          <div className={`text-sm ${sub}`}>{err ? '' : L('加载中…', '載入中…', 'Loading…')}</div>
        ) : (
          filtering && !list.length
            ? <div className={`text-sm ${sub} py-10 text-center`}>{L('没有符合条件的手机', '沒有符合條件的手機', 'No matching phones')}</div>
            : <div className="grid grid-cols-[repeat(auto-fill,minmax(208px,1fr))] gap-4 [&>*]:min-w-0">{cards.slice((cur - 1) * PAGE, cur * PAGE)}</div>
        )}
      </div>

      {batch && devices && batchOn && (
        <BatchDialog act={batch} devices={devices} picked={picked} platforms={platforms}
          onClose={() => setBatch(null)}
          // 批量指令发出后清空勾选(进度窗口里照样列着这批手机,失败的可在那里重试)
          onStart={(j) => { startJob(j); setPicked(new Set()); }} />
      )}
      {editor && (
        <PhoneTaskEditor device={editor.device} initial={editor.task} platform={editor.platform} onCancel={() => setEditor(null)}
          onSaved={() => {
            // 已保存:弹进度窗口等手机拿到新任务列表
            const d = editor.device;
            setEditor(null);
            void load(true);
            startJob({ id: jobId(), kind: 'tasks', devices: [d], title: editor.task ? L('保存任务', '儲存任務', 'Save task') : L('创建云机任务', '創建雲機任務', 'Create cloud task'), send: async () => { /* 已保存 */ } });
          }} />
      )}
      {jobs.map(({ job, hidden }) => (
        <CommandProgress key={job.id} job={job} hidden={hidden} onHide={() => setHidden(job.id, true)}
          onClose={() => dropJob(job.id)}
          onFinished={(ok, bad) => {
            void load(true);
            setJobs((s) => s.map((x) => (x.job.id === job.id ? { ...x, done: true } : x)));
            if (hidden) { dropJob(job.id); flash(bad ? L(`${job.title}:成功 ${ok} 台,失败 / 超时 ${bad} 台`, `${job.title}:成功 ${ok} 台,失敗 / 逾時 ${bad} 台`, `${job.title}: ${ok} OK, ${bad} failed`) : L(`${job.title}:全部完成`, `${job.title}:全部完成`, `${job.title}: all done`)); }
          }} />
      ))}
      {needPick && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="alertdialog" aria-modal="true" aria-label={L('请至少选择一台云手机', '請至少選擇一台雲手機', 'Select at least one cloud phone')}
          onClick={(e) => { if (e.target === e.currentTarget) setNeedPick(false); }}>
          <div className={`relative w-full max-w-[380px] rounded-2xl border ${bd} ${surface} px-5 pt-7 pb-5 flex flex-col items-center gap-2 text-center shadow-modal`}>
            <button type="button" onClick={() => setNeedPick(false)} aria-label={L('关闭', '關閉', 'Close')}
              className={`absolute right-4 top-3 text-lg leading-none ${sub} hover:text-claude-text dark:hover:text-white`}>✕</button>
            <AndroidIcon className="!w-10 !h-10" />
            <b className={`text-[17px] ${txt}`}>{L('请至少选择一台云手机', '請至少選擇一台雲手機', 'Select at least one cloud phone')}</b>
            <p className={`m-0 text-[13px] leading-relaxed ${sub}`}>{L('先勾选手机卡片左上角的选择框,或点「全选」,再进行批量操作。', '先勾選手機卡片左上角的選擇框,或點「全選」,再進行批量操作。', 'Tick the box at the top-left of a phone card, or "Select all", then use a batch action.')}</p>
            <button type="button" className="mt-2 px-6 py-2 rounded-xl text-sm font-bold text-[#04140c]" style={{ background: '#00FF88' }} onClick={() => setNeedPick(false)}>{L('知道了', '知道了', 'Got it')}</button>
          </div>
        </div>
      )}
      {confirm && (confirm.kind === 'remove' ? (
        <ConfirmDialog busy={busy} title={L('移除这台手机？', '移除這台手機？', 'Remove this phone?')}
          body={pfNames
            ? L(`${confirm.device.vendor || shortId(confirm.device.id)} 已离线。移除后会清空它的任务和绑定的 ${pfNames} 账号，运行记录保留；空出 1 个手机槽位。这台手机以后重新上线，会自动回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} 已離線。移除後會清空它的任務和綁定的 ${pfNames} 帳號，運行記錄保留；空出 1 個手機槽位。這台手機以後重新上線，會自動回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} is offline. Removing it clears its tasks and linked ${pfNames} accounts (run history is kept) and frees 1 phone slot. If the phone comes back online it returns to the list.`)
            : L(`${confirm.device.vendor || shortId(confirm.device.id)} 已离线。移除后会清空它的任务和绑定的账号，运行记录保留；空出 1 个手机槽位。这台手机以后重新上线，会自动回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} 已離線。移除後會清空它的任務和綁定的帳號，運行記錄保留；空出 1 個手機槽位。這台手機以後重新上線，會自動回到列表。`,
              `${confirm.device.vendor || shortId(confirm.device.id)} is offline. Removing it clears its tasks and linked account (run history is kept) and frees 1 phone slot. If the phone comes back online it returns to the list.`)}
          confirmText={L('移除', '移除', 'Remove')} onCancel={() => setConfirm(null)} onConfirm={doConfirm} />
      ) : (
        <ConfirmDialog busy={busy} title={L('删除这个任务？', '刪除這個任務？', 'Delete this task?')}
          body={L(`「${taskName(confirm.task)}」会从这台手机上删除，运行记录保留。`, `「${taskName(confirm.task)}」會從這台手機上刪除，運行記錄保留。`, `“${taskName(confirm.task)}” will be removed from this phone. Run history is kept.`)}
          confirmText={L('删除', '刪除', 'Delete')} onCancel={() => setConfirm(null)} onConfirm={doConfirm} />
      ))}
    </div>
  );
};

export default MyPhonesView;
