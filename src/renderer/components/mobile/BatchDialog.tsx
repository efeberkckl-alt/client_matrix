import React, { useEffect, useMemo, useRef, useState } from 'react';
import {
  Device, L, Platform, RawTask, ScriptId, accountOf, asPlatform, isLead, scriptsFor, runHidden, shortId, bd, btnGhost, btnPrimary, scriptName, sendCommand, sub, surface, surface2, taskName, txt,
} from './cloudPhoneShared';
import {
  BatchAct, batchCreate, batchDelete, batchStop, canStop, createBlock, runSkip, runningPlatform, selectable, taskOfPlatform,
} from './cloudPhoneBatch';
import type { CommandJob } from './CommandProgress';
import PhoneTaskEditor from './PhoneTaskEditor';

/**
 * 批量运行 / 批量停止 / 批量删除任务 / 批量创建任务 — 只对【外面已勾选的手机】操作(这里不再勾选手机,只展示每台的结果)。
 * 确认后交给指令进度窗口(CommandProgress)发送并等手机反馈。
 */

/** Task types of a platform, lead task first (as before for TikTok). */
const typesOf = (pf: string): ScriptId[] => [...scriptsFor(pf)].sort((a, b) => Number(isLead(b)) - Number(isLead(a)));
const dangerBtn = 'inline-flex items-center justify-center font-bold rounded-[10px] border border-[#ff5c7a] bg-[#ff5c7a] text-white disabled:opacity-40 disabled:cursor-not-allowed';
/** 「各跑各的 / 全部任务」选项的值 */
const OWN = '__own__';

const Opt: React.FC<{ on: boolean; glyph: string; label: string; disabled?: boolean; onClick?: () => void }> = ({ on, glyph, label, disabled, onClick }) => (
  <button type="button" disabled={disabled} onClick={onClick} aria-pressed={on}
    className={`inline-flex items-center gap-1.5 px-3 py-[7px] rounded-[10px] border text-[12.5px] ${surface2} disabled:opacity-45 disabled:cursor-not-allowed ${on ? 'border-claude-accent text-green-600 dark:text-claude-accent' : `${bd} ${txt}`}`}>
    {glyph} {label}
  </button>
);

export interface BatchDialogProps {
  act: BatchAct;
  devices: Device[];
  picked: Set<string>;
  /** Platforms left after the compliance filter. */
  platforms: Platform[];
  onClose: () => void;
  /** 确认后:交给进度窗口执行。 */
  onStart: (job: CommandJob) => void;
}

const platOf = (t: { platform?: string }): string => t.platform || 'tiktok';
const jobId = () => 'j' + Date.now().toString(36) + Math.random().toString(36).slice(2, 6);

const BatchDialog: React.FC<BatchDialogProps> = ({ act, devices, picked, platforms, onClose, onStart }) => {
  const live = platforms.filter((p) => p.live);
  const visibleIds = platforms.map((p) => p.id as string);
  const [pfSel, setPf] = useState<string>(act === 'new' ? (live[0]?.id || '') : OWN);
  const pf: string = act === 'new'
    ? (live.some((x) => x.id === pfSel) ? pfSel : (live[0]?.id || ''))
    : (pfSel === OWN || live.some((x) => x.id === pfSel) ? pfSel : OWN);
  const [pfs, setPfs] = useState<Set<string>>(() => new Set([OWN]));
  const [typeSel, setType] = useState<ScriptId | null>(null);
  // Task types follow the chosen platform; a type of another platform falls back to the platform's first type.
  const types = typesOf(pf);
  const type: ScriptId | undefined = typeSel && types.includes(typeSel) ? typeSel : types[0];
  const [step, setStep] = useState<1 | 2 | 3>(1);
  const [seed, setSeed] = useState<RawTask | null>(null);
  const [replaceOld, setReplaceOld] = useState(false);   // 已有任务的手机也替换
  const [allHave, setAllHave] = useState('');   // 选的手机都已有这个平台的任务 → 弹提示,不往下走

  const pickedPhones = useMemo(() => devices.filter((d) => picked.has(d.id) && selectable(d)), [devices, picked]);
  const pfObj = platforms.find((p) => p.id === pf);
  const pfName = pfObj ? pfObj.name() : '';

  // Escape closes (step 2 of create is the editor's own modal).
  const closeRef = useRef(onClose);
  closeRef.current = onClose;
  useEffect(() => {
    if (act === 'new' && step === 2) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeRef.current(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [act, step]);

  // Step 2 of 批量创建任务: the task editor in batch mode (its own modal).
  if (act === 'new' && step === 2 && type) {
    return (
      <PhoneTaskEditor initial={null} onCancel={onClose}
        batch={{ scriptId: type, platform: asPlatform(pf), seed, onBack: () => setStep(1), onNext: (t) => { setSeed(t); setStep(3); } }} />
    );
  }

  const cancelBtn = <button type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={onClose}>{L('取消', '取消', 'Cancel')}</button>;
  const lbl = (t: string) => <div className={`text-xs ${sub} -mb-1`}>{t}</div>;
  const stepn = (t: string) => <div className={`text-[11.5px] ${sub}`}>{t}</div>;
  const toggleMulti = (id: string) => setPfs((s) => {
    if (id === OWN) return new Set([OWN]);
    const n = new Set(s); n.delete(OWN);
    if (n.has(id)) n.delete(id); else n.add(id);
    return n.size ? n : new Set([OWN]);
  });
  const multiSel = [...pfs].filter((x) => x === OWN || visibleIds.includes(x));

  /** 每台手机:要做什么('' 之外的 skip = 跳过原因)。 */
  type Plan = { d: Device; skip: string; note: string; taskId?: string };
  let plans: Plan[] = [];
  let title = '';
  let picker: React.ReactNode = null;
  let confirmText = '';
  let danger = false;
  let run: (() => void) | null = null;

  if (act === 'run') {
    title = L('批量运行', '批量運行', 'Batch run');
    picker = (<>
      {lbl(L('运行哪个平台的任务', '運行哪個平台的任務', 'Run the task of which platform'))}
      <div className="flex gap-1.5 flex-wrap">
        <Opt on={pf === OWN} glyph={pf === OWN ? '◉' : '○'} label={L('各跑各的任务', '各跑各的任務', "Each phone's own task")} onClick={() => { setPf(OWN); setReplaceOld(false); }} />
        {live.map((x) => <Opt key={x.id} on={x.id === pf} glyph={x.id === pf ? '◉' : '○'} label={x.name()} onClick={() => { setPf(x.id); setReplaceOld(false); }} />)}
      </div>
    </>);
    plans = pickedPhones.map((d) => {
      if (pf !== OWN) {
        const why = runSkip(d, pf);
        return { d, skip: why, note: why ? '' : `${L('运行', '運行', 'Run')} · ${pfName}`, taskId: why ? undefined : taskOfPlatform(d, pf)?.id };
      }
      // 各跑各的:只有一个(可见平台的)任务就跑它;有多个平台任务的跳过,让用户选平台
      const own = d.tasks.filter((t) => live.some((x) => x.id === platOf(t)));
      if (!d.online) return { d, skip: L('离线', '離線', 'offline'), note: '' };
      if (!d.a11y) return { d, skip: L('缺权限', '缺權限', 'permission needed'), note: '' };
      if (d.running) return { d, skip: L('运行中', '運行中', 'running'), note: '' };
      if (!own.length) return { d, skip: L('没有任务', '沒有任務', 'no task'), note: '' };
      if (own.length > 1) return { d, skip: L('有多个平台任务,请选平台', '有多個平台任務,請選平台', 'several platform tasks — pick one'), note: '' };
      const pn = platforms.find((x) => x.id === platOf(own[0]))?.name() || '';
      return { d, skip: '', note: `${L('运行', '運行', 'Run')} · ${pn}`, taskId: own[0].id };
    });
    const ok = plans.filter((x) => !x.skip);
    confirmText = L(`运行 ${ok.length} 台`, `運行 ${ok.length} 台`, `Run ${ok.length}`);
    if (ok.length) {
      const ids: Record<string, string> = {};
      ok.forEach((x) => { ids[x.d.id] = x.taskId!; });
      run = () => onStart({ id: jobId(), title, kind: 'run', devices: ok.map((x) => x.d), runTaskIds: ids,
        send: (d) => sendCommand(d.id, 'run', ids[d.id]) });
    }
  } else if (act === 'stop') {
    title = L('批量停止', '批量停止', 'Batch stop');
    picker = (<>
      {lbl(L('停止哪些平台的任务(可多选)', '停止哪些平台的任務(可多選)', 'Stop the tasks of which platforms (multiple)'))}
      <div className="flex gap-1.5 flex-wrap">
        <Opt on={pfs.has(OWN)} glyph={pfs.has(OWN) ? '☑' : '☐'} label={L('全部任务', '全部任務', 'All tasks')} onClick={() => toggleMulti(OWN)} />
        {platforms.map((x) => <Opt key={x.id} on={pfs.has(x.id)} glyph={pfs.has(x.id) ? '☑' : '☐'} label={x.name()} onClick={() => toggleMulti(x.id)} />)}
      </div>
    </>);
    plans = pickedPhones.map((d) => {
      const rp = runningPlatform(d);
      // 跑的是合规隐藏平台的任务:界面上显示为没在运行,批量停止也不碰它(任务照常在后台跑)
      if (!canStop(d) || runHidden(d, platforms)) return { d, skip: L('没在运行', '沒在運行', 'not running'), note: '' };
      if (!pfs.has(OWN) && (rp === null || !pfs.has(rp))) return { d, skip: L('运行的不是所选平台', '運行的不是所選平台', 'running another platform'), note: '' };
      const pn = rp ? (platforms.find((x) => x.id === rp)?.name() || '') : '';
      return { d, skip: '', note: `${L('停止', '停止', 'Stop')}${pn ? ` · ${pn}` : ''}` };
    });
    const ok = plans.filter((x) => !x.skip);
    confirmText = L(`停止 ${ok.length} 台`, `停止 ${ok.length} 台`, `Stop ${ok.length}`);
    danger = true;
    if (ok.length) run = () => onStart({ id: jobId(), title, kind: 'stop', devices: ok.map((x) => x.d), send: batchStop });
  } else if (act === 'del') {
    title = L('批量删除任务', '批量刪除任務', 'Batch delete tasks');
    picker = (<>
      {lbl(L('删除哪些平台的任务(可多选)', '刪除哪些平台的任務(可多選)', 'Delete the tasks of which platforms (multiple)'))}
      <div className="flex gap-1.5 flex-wrap">
        <Opt on={pfs.has(OWN)} glyph={pfs.has(OWN) ? '☑' : '☐'} label={L('全部任务', '全部任務', 'All tasks')} onClick={() => toggleMulti(OWN)} />
        {platforms.map((x) => <Opt key={x.id} on={pfs.has(x.id)} glyph={pfs.has(x.id) ? '☑' : '☐'} label={x.name()} onClick={() => toggleMulti(x.id)} />)}
      </div>
    </>);
    const sel = pfs.has(OWN) ? visibleIds : multiSel.filter((x) => x !== OWN);
    plans = pickedPhones.map((d) => {
      const mine = d.tasks.filter((t) => sel.includes(platOf(t)));
      if (!mine.length) return { d, skip: pfs.has(OWN) ? L('没有任务', '沒有任務', 'no task') : L('没有所选平台任务', '沒有所選平台任務', 'no task of these platforms'), note: '' };
      return { d, skip: '', note: `${L('删除', '刪除', 'Delete')} ${mine.map((t) => taskName(t)).join('、')}` };
    });
    const ok = plans.filter((x) => !x.skip);
    confirmText = L(`删除 ${ok.length} 台的任务`, `刪除 ${ok.length} 台的任務`, `Delete on ${ok.length}`);
    danger = true;
    if (ok.length && sel.length) run = () => onStart({ id: jobId(), title, kind: 'tasks', devices: ok.map((x) => x.d), send: (d) => batchDelete(d, sel) });
  } else if (step === 1) {
    title = L('批量创建任务', '批量建立任務', 'Batch create task');
  } else {
    title = L('批量创建任务 · 确认手机', '批量建立任務 · 確認手機', 'Batch create task · Confirm phones');
    plans = pickedPhones.map((d) => {
      const bad = createBlock(d, asPlatform(pf), pfName);
      if (bad) return { d, skip: bad, note: '' };
      // 每个平台只能有 1 个云机任务:已经有这个平台任务的手机默认跳过;勾了「也替换」才覆盖原任务
      const old = taskOfPlatform(d, pf);
      if (old && !replaceOld) return { d, skip: L(`已有「${taskName(old)}」`, `已有「${taskName(old)}」`, `has “${taskName(old)}”`), note: '' };
      const stops = old && (runningPlatform(d) === pf || (d.online && d.running && runningPlatform(d) === null));
      return { d, skip: '', note: old
        ? L(`替换「${taskName(old)}」${stops ? '(先停止)' : ''}`, `替換「${taskName(old)}」${stops ? '(先停止)' : ''}`, `Replace “${taskName(old)}”${stops ? ' (stops first)' : ''}`)
        : L('新建', '新建', 'New') };
    });
    const ok = plans.filter((x) => !x.skip);
    confirmText = L(`创建到 ${ok.length} 台`, `建立到 ${ok.length} 台`, `Create on ${ok.length}`);
    if (ok.length && seed && pf) { const t = seed; const id = pf; run = () => onStart({ id: jobId(), title: L('批量创建任务', '批量建立任務', 'Batch create task'), kind: 'tasks', devices: ok.map((x) => x.d), send: (d) => batchCreate(d, id, t) }); }
  }

  const nOk = plans.filter((x) => !x.skip).length;
  const nSkip = plans.length - nOk;
  const list = (
    <ul className={`list-none m-0 p-0 flex flex-col border ${bd} rounded-xl max-h-[280px] overflow-auto`}>
      {plans.map(({ d, skip, note }) => {
        // Account of the chosen platform; with "each phone's own" / all platforms: the first visible platform with an account.
        const acct = (visibleIds.includes(pf) ? accountOf(d, pf) : null) || visibleIds.map((id) => accountOf(d, id)).find(Boolean) || null;
        return (
          <li key={d.id} className={`flex items-center gap-2 px-3 py-2 text-[12.5px] border-b last:border-b-0 ${bd} ${skip ? 'opacity-55' : ''}`}>
            <span className={`min-w-0 truncate ${txt}`}>{d.vendor || shortId(d.id)}</span>
            <span className={`font-mono text-[11px] ${sub}`} title={d.id}>{shortId(d.id)}</span>
            {acct && <span className={`text-[11px] truncate ${sub}`}>{acct.handle}</span>}
            <span className={`ml-auto text-right text-[11.5px] whitespace-nowrap ${skip ? 'text-amber-500 dark:text-amber-400' : 'text-green-600 dark:text-claude-accent'}`}>
              {skip ? `${L('跳过', '跳過', 'Skip')} · ${skip}` : note}
            </span>
          </li>
        );
      })}
    </ul>
  );
  const summary = (
    <p className={`m-0 text-[12.5px] leading-relaxed ${sub}`}>
      {act === 'run' ? L(`将运行 ${nOk} 台`, `將運行 ${nOk} 台`, `Runs ${nOk}`)
        : act === 'stop' ? L(`将停止 ${nOk} 台`, `將停止 ${nOk} 台`, `Stops ${nOk}`)
        : act === 'del' ? L(`将删除 ${nOk} 台手机上的任务`, `將刪除 ${nOk} 台手機上的任務`, `Deletes tasks on ${nOk}`)
        : L(`将创建到 ${nOk} 台`, `將建立到 ${nOk} 台`, `Creates on ${nOk}`)}
      {nSkip ? L(`;${nSkip} 台跳过`, `;${nSkip} 台跳過`, `; ${nSkip} skipped`) : ''}
      {act === 'del' ? L('。正在运行的会先停止,运行记录保留,删除后不能恢复。', '。正在運行的會先停止,運行記錄保留,刪除後不能恢復。', '. Running ones stop first; run history is kept; this can’t be undone.')
        : act === 'stop' ? L('。已完成的点赞、回复会保留。', '。已完成的點讚、回覆會保留。', '. Likes and replies already done are kept.') : L('。', '。', '.')}
    </p>
  );

  let body: React.ReactNode;
  let actions: React.ReactNode;
  if (act === 'new' && step === 1) {
    body = (<>
      {stepn(L(`第 1 步 / 共 3 步 · 已选 ${pickedPhones.length} 台 · 一次只能选一个平台、一种任务`, `第 1 步 / 共 3 步 · 已選 ${pickedPhones.length} 台 · 一次只能選一個平台、一種任務`, `Step 1 of 3 · ${pickedPhones.length} selected · one platform and task type at a time`))}
      {lbl(L('平台', '平台', 'Platform'))}
      <div className="flex gap-1.5 flex-wrap">{platforms.map((x) => x.live
        ? <Opt key={x.id} on={x.id === pf} glyph={x.id === pf ? '◉' : '○'} label={x.name()} onClick={() => { setPf(x.id); setReplaceOld(false); }} />
        : <Opt key={x.id} on={false} disabled glyph="○" label={`${x.name()} · ${L('即将推出', '即將推出', 'coming soon')}`} />)}</div>
      {lbl(L('任务类型', '任務類型', 'Task type'))}
      <div className="flex gap-1.5 flex-wrap">{types.map((t) => <Opt key={t} on={t === type} glyph={t === type ? '◉' : '○'} label={scriptName(t)} onClick={() => setType(t)} />)}</div>
    </>);
    actions = (<>{cancelBtn}<button type="button" className={`${btnPrimary} flex-1 py-2 text-[12.5px]`} disabled={!pf || !type}
      onClick={() => {
        // 全都已有任务:提示一下(最后一步可以勾「也替换」),确认后照常往下走
        if (pickedPhones.length && pickedPhones.every((d) => !!taskOfPlatform(d, pf))) {
          setAllHave(L(`已选的 ${pickedPhones.length} 台手机都已经有 ${pfName} 任务了。每个平台只能有 1 个云机任务,要覆盖的话在最后一步勾选「已有任务的手机也替换」。`,
            `已選的 ${pickedPhones.length} 台手機都已經有 ${pfName} 任務了。每個平台只能有 1 個雲機任務,要覆蓋的話在最後一步勾選「已有任務的手機也替換」。`,
            `All ${pickedPhones.length} selected phones already have a ${pfName} task. One cloud task per platform — tick “Also replace existing tasks” in the last step to overwrite.`));
          return;
        }
        setStep(2);
      }}>{L('下一步:配置任务', '下一步:設定任務', 'Next: set up the task')}</button></>);
  } else {
    body = (<>
      {act === 'new'
        ? stepn(`${L('第 3 步 / 共 3 步', '第 3 步 / 共 3 步', 'Step 3 of 3')} · ${pfName} · ${type ? scriptName(type) : ''}`)
        : <p className={`m-0 text-[12.5px] ${sub}`}>{L(`对已选的 ${pickedPhones.length} 台手机执行。`, `對已選的 ${pickedPhones.length} 台手機執行。`, `Applies to the ${pickedPhones.length} selected phone(s).`)}</p>}
      {picker}
      {act === 'new' && pickedPhones.some((d) => !!taskOfPlatform(d, pf)) && (
        <label className={`flex items-center gap-2 text-[12.5px] cursor-pointer select-none ${txt}`}>
          <span role="checkbox" aria-checked={replaceOld} tabIndex={0}
            onKeyDown={(e) => { if (e.key === ' ' || e.key === 'Enter') { e.preventDefault(); setReplaceOld((v) => !v); } }}
            className="w-[18px] h-[18px] rounded-[5px] border-2 grid place-items-center text-[12px] font-black leading-none"
            style={{ borderColor: replaceOld ? '#4D8DFF' : '#8B93B0', color: '#4D8DFF' }}>{replaceOld ? '✓' : ''}</span>
          <input type="checkbox" className="hidden" checked={replaceOld} onChange={(e) => setReplaceOld(e.target.checked)} />
          {L('已有任务的手机也替换(正在运行的会先停止)', '已有任務的手機也替換(正在運行的會先停止)', 'Also replace existing tasks (running ones stop first)')}
        </label>
      )}
      {list}
      {summary}
    </>);
    actions = (<>
      {act === 'new'
        ? <button type="button" className={`${btnGhost} flex-1 py-2 text-[12.5px]`} onClick={() => setStep(2)}>{L('上一步', '上一步', 'Back')}</button>
        : cancelBtn}
      <button type="button" className={`${danger ? dangerBtn : btnPrimary} flex-1 py-2 text-[12.5px]`} disabled={!run}
        onClick={() => { if (run) { run(); onClose(); } }}>{confirmText}</button>
    </>);
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4" role="dialog" aria-modal="true" aria-label={title}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className={`w-full max-w-[520px] max-h-[calc(100vh-32px)] overflow-auto rounded-2xl border ${bd} ${surface} p-5 flex flex-col gap-3 shadow-modal`}>
        <div className="flex items-start gap-2">
          <h2 className={`m-0 text-base font-bold ${txt}`}>{title}</h2>
          <button type="button" onClick={onClose} aria-label={L('关闭', '關閉', 'Close')}
            className={`ml-auto -mt-1 text-lg leading-none ${sub} hover:text-claude-text dark:hover:text-white`}>✕</button>
        </div>
        {body}
        <div className="flex gap-1.5 mt-1">{actions}</div>
      </div>
      {allHave && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/50 p-4" role="alertdialog" aria-modal="true" aria-label={allHave}
          onClick={(e) => { e.stopPropagation(); if (e.target === e.currentTarget) setAllHave(''); }}>
          <div className={`relative w-full max-w-[380px] rounded-2xl border ${bd} ${surface} px-5 pt-7 pb-5 flex flex-col items-center gap-3 text-center shadow-modal`}>
            <button type="button" onClick={() => setAllHave('')} aria-label={L('关闭', '關閉', 'Close')}
              className={`absolute right-4 top-3 text-lg leading-none ${sub} hover:text-claude-text dark:hover:text-white`}>✕</button>
            <p className={`m-0 text-[13.5px] leading-relaxed ${txt}`}>{allHave}</p>
            <button type="button" className={`${btnPrimary} px-6 py-2 text-[12.5px]`} onClick={() => { setAllHave(''); setStep(2); }}>{L('知道了,继续', '知道了,繼續', 'OK, continue')}</button>
          </div>
        </div>
      )}
    </div>
  );
};

export default BatchDialog;
