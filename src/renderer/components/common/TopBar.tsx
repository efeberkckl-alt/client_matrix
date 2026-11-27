/**
 * 统一顶部横条(2026-11-01,简洁版 / 专业版共用,替代各页面自己的头部条)。
 *   左:当前页面名(简洁版是「首页 › 当前页」面包屑;专业版侧栏收起时前面多一个展开按钮)
 *   ☰ 里「切换版本」:点了弹「选择界面版本」弹窗(与首次安装同一个)
 *   右:账号胶囊(头像 · 名字 + 会员角标 · 💎 积分,点开账号下拉)+ ☰ 菜单
 *       ☰ = 指纹浏览器(点了左侧弹内核版本二级面板)· 全网热搜 · 订阅会员 · 邀请返佣 · 使用教程 · 活动与合作 · 联系我们
 *       简洁版没有左侧菜单,☰ 里额外放页面导航(首页 / 我的矩阵账号 / 我的任务 / 云手机 / 我的充值)。
 */
import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { openWallet } from '../../services/walletNav';
import KernelPicker from './KernelPicker';
import AccountMenu from './AccountMenu';
import SidebarToggleIcon from '../icons/SidebarToggleIcon';
import WindowTitleBar from '../window/WindowTitleBar';
import type { UiEdition } from '../../uiEdition';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};

export interface TopBarMenuItem { key: string; icon: string; label: string; onClick: () => void; badge?: number }

interface TopBarProps {
  edition: UiEdition;
  onSwitch: (e: UiEdition) => void;
  /** ☰ 里「切换版本」→ 弹出「选择界面版本」弹窗(与首次安装同一个) */
  onOpenEditionChooser: () => void;
  onShowSettings: () => void;
  onShowInvite: () => void;
  onShowHotSearch: () => void;
  onShowPartners: () => void;
  onShowContact: () => void;
  /** 简洁版:页面导航(收进 ☰) */
  menu?: TopBarMenuItem[];
  activeKey?: string;
  updateBadge?: React.ReactNode;
  /** 简洁版:不在菜单里的页面(如建任务向导),面包屑显示用 */
  subPage?: { icon: string; label: string };
  /** 专业版:当前页面名 */
  title?: { icon: string; label: string };
  /** 专业版:侧栏收起时,左侧给一个展开按钮 */
  sidebarCollapsed?: boolean;
  onExpandSidebar?: () => void;
  hideKernelPicker?: boolean;
}

const TopBar: React.FC<TopBarProps> = ({
  edition, onOpenEditionChooser, onShowSettings, onShowInvite, onShowHotSearch, onShowPartners, onShowContact,
  menu, activeKey, updateBadge, subPage, title, sidebarCollapsed, onExpandSidebar, hideKernelPicker,
}) => {
  const [menuOpen, setMenuOpen] = useState(false);
  const [closeSignal, setCloseSignal] = useState(0);       // ☰ 关掉时一起收起指纹浏览器二级面板
  const [acctSignal, setAcctSignal] = useState(0);         // 打开 ☰ 时收起账号下拉(两个菜单互斥)
  const [kernel, setKernel] = useState({ ready: true, busy: false });
  const simple = edition === 'simple';
  const zhLike = i18nService.currentLanguage === 'zh' || i18nService.currentLanguage === 'zh-TW';
  const active = (menu || []).find((m) => m.key === activeKey);
  // 简洁版 ☰ 里的导航:首页不放进 ☰(左上角面包屑可回首页),充值 / 邀请 / 联系放到下面通用区按顺序排
  const navItems = simple ? (menu || []).filter((m) => m.key !== 'home' && m.key !== 'wallet' && m.key !== 'invite' && m.key !== 'contact') : [];
  const badgeTotal = navItems.reduce((n, m) => n + (m.badge || 0), 0);

  const closeMenu = () => { setMenuOpen(false); setCloseSignal((n) => n + 1); };
  const toggleMenu = () => {
    if (menuOpen) { closeMenu(); return; }
    setAcctSignal((n) => n + 1);
    setMenuOpen(true);
  };
  const pick = (fn: () => void) => () => { closeMenu(); fn(); };
  // Esc 关闭 ☰
  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') closeMenu(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen]);
  const openTutorial = () => {
    const url = i18nService.currentLanguage === 'zh' ? 'https://docs.noobclaw.com/zhong-wen-ban' : 'https://docs.noobclaw.com/english';
    try { window.electron?.shell?.openExternal(url); } catch { /* sandbox / 无浏览器时静默 */ }
  };
  const walletItem = simple ? (menu || []).find((m) => m.key === 'wallet') : undefined;
  // 简洁版顺序:全网热搜 → 我的充值 → 邀请返佣 → 使用教程 → 活动与合作 → 联系我们(不放订阅会员)
  const general: TopBarMenuItem[] = [
    ...(zhLike ? [{ key: 'hotsearch', icon: '🔥', label: i18nService.t('globalHotSearch'), onClick: onShowHotSearch }] : []),
    ...(simple ? (walletItem ? [walletItem] : []) : [{ key: 'subscribe', icon: '👑', label: L('订阅会员', '訂閱會員', 'Membership'), onClick: () => openWallet('subscription') }]),
    { key: 'invite', icon: '🎁', label: i18nService.t('inviteRebateMenu'), onClick: onShowInvite },
    { key: 'tutorial', icon: '📖', label: L('使用教程', '使用教程', 'User guide'), onClick: openTutorial },
    { key: 'partners', icon: '🎉', label: i18nService.t('eventsPartners'), onClick: onShowPartners },
    { key: 'contact', icon: '💬', label: i18nService.t('contactUsMenu'), onClick: onShowContact },
  ];
  // 没登录时账号下拉不出现,「设置」放进 ☰(语言等通用设置仍要能进)
  const [loggedIn, setLoggedIn] = useState(noobClawAuth.getState().isAuthenticated);
  useEffect(() => noobClawAuth.subscribe((s) => setLoggedIn(s.isAuthenticated)), []);

  const row = (m: TopBarMenuItem, on: boolean) => (
    <button key={m.key} type="button" role="menuitem" onClick={pick(m.onClick)} aria-current={on ? 'page' : undefined}
      style={on ? { background: 'rgba(0,255,136,0.10)' } : undefined /* 别用 bg-claude-accent 类:暗色主题会把它刷成实心绿 */}
      className={`w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left ${on ? 'text-claude-accent font-semibold' : 'dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5'}`}>
      <span className="w-5 text-center">{m.icon}</span>
      <span className="flex-1 truncate">{m.label}</span>
      {!!m.badge && <span className="min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold">{m.badge}</span>}
    </button>
  );

  return (
    // 两栏:左(页面名)/ 右(账号 + ☰)。右栏按内容宽,左侧标题自己截断
    <div className="draggable grid grid-cols-[minmax(0,1fr)_auto] h-[52px] items-center gap-3 px-4 shrink-0 border-b dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted">
      <div className="min-w-0 flex items-center gap-2">
        {!simple && sidebarCollapsed && onExpandSidebar && (
          <button type="button" onClick={onExpandSidebar} aria-label={i18nService.t('expand')}
            className="non-draggable shrink-0 h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover">
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={true} />
          </button>
        )}
        {simple && active && (() => {
          const home = (menu || []).find((m) => m.key === 'home');
          const cur = active.key === 'home' && subPage ? { key: 'sub', ...subPage } : active;
          if (!home || cur.key === 'home') return <span className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">{active.icon} {active.label}</span>;
          return (
            <nav aria-label={L('当前位置', '目前位置', 'Breadcrumb')} className="non-draggable min-w-0 flex items-center gap-1.5 text-base">
              <button type="button" onClick={home.onClick} title={L('返回首页', '返回首頁', 'Back to Home')}
                className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary hover:text-claude-accent dark:hover:text-claude-accent hover:underline underline-offset-2">{home.icon} {home.label}</button>
              <span className="shrink-0 dark:text-claude-darkTextSecondary text-claude-textSecondary">›</span>
              <span className="font-semibold dark:text-claude-darkText text-claude-text truncate">{cur.icon} {cur.label}</span>
            </nav>
          );
        })()}
        {(!simple || !active) && title && title.label && <span className="text-base font-semibold dark:text-claude-darkText text-claude-text truncate">{title.icon} {title.label}</span>}
        {updateBadge && <span className="non-draggable shrink-0">{updateBadge}</span>}
      </div>

      {/* 右侧:账号胶囊 + ☰ */}
      <div className="flex items-center justify-end gap-3">
        <AccountMenu onShowSettings={onShowSettings} onShowInvite={onShowInvite} closeSignal={acctSignal} onOpen={() => { if (menuOpen) closeMenu(); }} />
        <div className="relative non-draggable shrink-0">
          <button type="button" onClick={toggleMenu} aria-label={L('菜单', '選單', 'Menu')} aria-expanded={menuOpen} aria-haspopup="menu"
            className={`relative h-10 w-10 inline-flex items-center justify-center rounded-xl border dark:bg-claude-darkSurface bg-white transition-colors ${menuOpen ? 'dark:text-claude-darkText text-claude-text dark:border-white/25 border-black/25' : 'dark:text-claude-darkTextSecondary text-claude-textSecondary dark:border-claude-darkBorder border-claude-border hover:dark:text-claude-darkText hover:text-claude-text'}`}>
            <svg width="18" height="18" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" aria-hidden="true"><path d="M3 4.5h10M3 8h10M3 11.5h10" /></svg>
            {badgeTotal > 0 ? <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-red-500" />
              : (!hideKernelPicker && (!kernel.ready || kernel.busy)) ? <span className="absolute top-1.5 right-1.5 w-2 h-2 rounded-full bg-amber-500" /> : null}
          </button>
          {menuOpen && <div className="fixed inset-0 z-40" onClick={closeMenu} />}
          {/* 菜单一直挂着、关掉时只是隐藏:KernelPicker 必须保持挂载(下载完成后的落盘选中 / noobclaw:kernel-changed 广播都在它里面) */}
          <div role="menu" className={`${menuOpen ? '' : 'hidden '}absolute right-0 top-[calc(100%+8px)] z-50 w-56 rounded-xl py-1.5 shadow-xl dark:bg-claude-darkSurface bg-white border dark:border-white/10 border-black/10`}>
            {/* 第一行:当前界面版本,右侧「切换 ›」,点了弹「选择界面版本」弹窗(与首次安装同一个) */}
            <button type="button" role="menuitem" onClick={pick(onOpenEditionChooser)}
              className="w-full flex items-center gap-2.5 px-3.5 py-2 text-sm text-left dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5">
              <span className="w-5 text-center">{simple ? '🌱' : '🚀'}</span>
              <span className="flex-1 truncate">{simple ? L('当前为简洁版', '當前為簡潔版', 'Simple layout') : L('当前为专业版', '當前為專業版', 'Pro layout')}</span>
              <span className="shrink-0 text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">{L('切换', '切換', 'Switch')}</span>
              <span className="shrink-0 opacity-50">›</span>
            </button>
            <div className="my-1 border-t dark:border-white/10 border-black/10" />
            {/* 云手机页不显示指纹浏览器入口:只隐藏,不卸载 */}
            <div className={hideKernelPicker ? 'hidden' : ''}><KernelPicker variant="row" closeSignal={closeSignal} onStatus={setKernel} />
              <div className="my-1 border-t dark:border-white/10 border-black/10" />
            </div>
            {navItems.length > 0 && (
              <>
                {navItems.map((m) => row(m, m.key === activeKey))}
              </>
            )}
            {general.map((m) => row(m, m.key === activeKey))}
            {!loggedIn && (
              <>
                <div className="my-1 border-t dark:border-white/10 border-black/10" />
                {row({ key: 'settings', icon: '⚙️', label: i18nService.t('settings'), onClick: onShowSettings }, false)}
              </>
            )}
          </div>
        </div>
        {/* Electron(Windows 无边框)窗口按钮;Tauri 下返回 null */}
        <WindowTitleBar inline />
      </div>
    </div>
  );
};

export default TopBar;
