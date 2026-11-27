/**
 * 指纹浏览器内核选择器(顶部横条用,2026-10-28)。逻辑与「我的矩阵账号」页头那份一致:
 *   列服务端可用版本,已装打勾可选中(落盘成所有任务用的版本),未装给下载按钮,下载进度走 matrix:kernel 事件。
 * 选中 / 下载完成后广播 'noobclaw:kernel-changed',账号页那份据此同步,两处显示一致。
 */
import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { useKernelStatus } from '../../hooks/useKernelStatus';

const M = () => (window as any).electron?.matrix;

/**
 * variant:
 *   'button'(默认)= 顶部横条里的独立按钮,下拉在按钮正下方;
 *   'row'          = 顶部「☰」菜单里的第一行,点了在菜单左侧弹出二级面板。
 * closeSignal:父级菜单关闭时 +1,把二级面板一起收起(组件本身保持挂载,下载完成的落盘 / 广播逻辑不能断)。
 */
const KernelPicker: React.FC<{ variant?: 'button' | 'row'; closeSignal?: number; onStatus?: (s: { ready: boolean; busy: boolean }) => void }> = ({ variant = 'button', closeSignal, onStatus }) => {
  const { kernel, selectedVersion, setSelectedVersion, loadKernel: load, loading, error } = useKernelStatus();
  const [busy, setBusy] = useState(false);
  const [pct, setPct] = useState(0);
  const [msg, setMsg] = useState('');
  const [open, setOpen] = useState(false);
  useEffect(() => { setOpen(false); }, [closeSignal]);

  useEffect(() => { if (open) load(); }, [open, load]);
  useEffect(() => {
    const off = M()?.onKernel?.((p: any) => {
      if (typeof p?.pct === 'number') setPct(p.pct);
      setMsg(p?.msg || '');
      if (p?.done) {
        setBusy(false);
        // 下载完成 → 选中并【落盘】刚下好的版本(与账号页一致;只改界面上的显示会导致任务实际还用旧版本)
        if (p?.path && p?.version) {
          setSelectedVersion(String(p.version));
          Promise.resolve(M()?.setSelectedKernel?.({ version: String(p.version) })).catch(() => {}).finally(() => {
            try { window.dispatchEvent(new CustomEvent('noobclaw:kernel-changed', { detail: { version: String(p.version) } })); } catch { /* ignore */ }
          });
        }
        load();
      }
    });
    const onChanged = (e: Event) => { const v = (e as CustomEvent)?.detail?.version; if (v) setSelectedVersion(String(v)); load(); };
    window.addEventListener('noobclaw:kernel-changed', onChanged);
    return () => { if (typeof off === 'function') off(); window.removeEventListener('noobclaw:kernel-changed', onChanged); };
  }, [load]);

  const choose = async (v: string) => {
    setSelectedVersion(v);
    await M()?.setSelectedKernel?.({ version: v });
    setOpen(false);
    try { window.dispatchEvent(new CustomEvent('noobclaw:kernel-changed', { detail: { version: v } })); } catch { /* ignore */ }
  };
  const download = async (v: string) => {
    setBusy(true); setPct(0); setMsg(i18nService.t('mvPreparingDownload'));
    await M()?.ensureKernel?.({ version: v });
  };
  const ready = !!selectedVersion && (kernel.installedVersions || []).includes(selectedVersion);
  // 上报给 ☰ 按钮:没就绪 / 正在下载时按钮上亮个小点,别让用户不知道要先下内核
  useEffect(() => { onStatus?.({ ready, busy }); }, [ready, busy]);

  const row = variant === 'row';
  return (
    <div className={row ? 'relative' : 'relative non-draggable shrink-0'}>
      {row ? (
        <button type="button" onClick={() => setOpen((o) => !o)} aria-expanded={open}
          className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left dark:text-claude-darkText text-claude-text ${open ? 'bg-black/5 dark:bg-white/5' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
          <span className="w-5 text-center">🧬</span>
          <span className="flex-1 min-w-0 truncate">{i18nService.t('mvFingerprintBrowser')}</span>
          <span className={`shrink-0 text-xs ${ready ? 'text-green-500' : 'text-amber-500'}`}>
            {selectedVersion ? `v${selectedVersion} ` : ''}{ready ? '✓' : i18nService.t('mvNotReady')}{busy ? ` · ${pct}%` : ''}
          </span>
          <span className="shrink-0 opacity-50">›</span>
        </button>
      ) : (
      <button type="button" onClick={() => setOpen((o) => !o)}
        className={`inline-flex items-center gap-1 text-xs px-2.5 py-1 rounded-lg border whitespace-nowrap ${ready ? 'bg-green-500/15 text-green-500 border-green-500/30' : 'bg-amber-500/15 text-amber-500 border-amber-500/30'}`}>
        🧬 {i18nService.t('mvFingerprintBrowser')} {selectedVersion ? `v${selectedVersion}` : ''} {ready ? '✓' : i18nService.t('mvNotReady')}
        {busy && !open && <span className="opacity-70"> · {pct}%</span>}
        <span className="opacity-60">▾</span>
      </button>
      )}
      {open && (
        <>
          {/* row 模式:外层 ☰ 菜单自己有点空白关闭的遮罩,这里不再叠一层(否则第一下点击只关二级面板) */}
          {!row && <div className="fixed inset-0 z-40" onClick={() => setOpen(false)} />}
          <div className={`absolute z-50 w-64 rounded-xl py-1 shadow-xl dark:bg-claude-darkBg bg-white border dark:border-white/10 border-black/10 ${row ? 'right-full top-0 mr-2' : 'right-0 mt-1'}`}>
            <div className="px-3 py-1.5 text-[11px] opacity-50">{i18nService.t('mvSelectKernelVersion')}</div>
            {window.electron?.platform === 'win32' && (kernel.available || []).some((a) => !a.installed) && (
              <div className="mx-3 mb-1 text-[10px] leading-snug rounded-md px-2 py-1.5 border border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400">⚠️ {i18nService.t('kernelWinAvTip')}</div>
            )}
            {(kernel.available && kernel.available.length) ? kernel.available.map((a) => {
              const isSel = a.version === selectedVersion;
              return (
                <div key={a.version} className={`flex items-center justify-between gap-2 px-3 py-1.5 ${isSel ? 'bg-green-500/10' : 'hover:bg-black/5 dark:hover:bg-white/5'}`}>
                  <button type="button" disabled={!a.installed} onClick={() => a.installed && choose(a.version)}
                    className={`flex-1 min-w-0 text-left flex items-center gap-1.5 ${a.installed ? 'cursor-pointer' : 'cursor-default opacity-70'}`}>
                    <span className="text-xs font-medium truncate">{a.label || `v${a.version}`}</span>
                    {a.sizeMb ? <span className="text-[10px] opacity-40 shrink-0">{a.sizeMb}MB</span> : null}
                    {a.recommended && <span className="text-[10px] px-1 rounded bg-violet-500/20 text-violet-500 shrink-0">{i18nService.t('mvRecommended')}</span>}
                    {isSel && a.installed && <span className="text-[10px] text-green-500 shrink-0">{i18nService.t('mvInUse')}</span>}
                  </button>
                  {a.installed
                    ? <span className="text-green-500 text-sm shrink-0">✓</span>
                    : <button type="button" disabled={busy} onClick={() => download(a.version)}
                        className="shrink-0 text-[11px] px-2 py-1 rounded-lg bg-violet-500 text-white hover:bg-violet-600 disabled:opacity-50">{busy ? i18nService.t('mvDownloading') : i18nService.t('mvDownload')}</button>}
                </div>
              );
            }) : (
              <div className="px-3 py-3 text-xs opacity-60">{loading ? i18nService.t('mvFetchingVersions') : error ? '暂时无法读取版本列表' : '当前系统暂无可用版本'}</div>
            )}
            {error && <div role="status" className="px-3 py-2 text-xs text-amber-500">{error}{loading && '，正在重试…'}</div>}
            <button type="button" disabled={loading} onClick={load} className="mx-3 my-1 text-xs text-claude-accent disabled:opacity-50">{loading ? '正在刷新…' : error ? '重试' : '刷新版本列表'}</button>
            {busy && (
              <div className="px-3 pt-1.5 pb-1 border-t dark:border-white/10 border-black/10">
                <div className="h-1.5 rounded-full bg-black/10 dark:bg-white/10 overflow-hidden"><div className="h-full bg-violet-500 transition-all" style={{ width: `${Math.max(2, pct)}%` }} /></div>
                <div className="text-[10px] opacity-60 mt-1 truncate">{msg} · {pct}%</div>
              </div>
            )}
          </div>
        </>
      )}
    </div>
  );
};

export default KernelPicker;
