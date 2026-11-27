import React, { useEffect, useState, useCallback } from 'react';
import { useSelector } from 'react-redux';
import { RootState } from '../store';
import { coworkService } from '../services/cowork';
import { i18nService } from '../services/i18n';
import CoworkSessionList from './cowork/CoworkSessionList';
import CoworkSearchModal from './cowork/CoworkSearchModal';
import ComposeIcon from './icons/ComposeIcon';
import SidebarToggleIcon from './icons/SidebarToggleIcon';
import TrashIcon from './icons/TrashIcon';
import { ExclamationTriangleIcon } from '@heroicons/react/24/outline';
import { MATRIX_EDITION } from '../matrixEdition';

interface SidebarProps {
  onShowSettings: () => void;
  onShowLogin?: () => void;
  activeView: 'home' | 'cowork' | 'coworkHistory' | 'skills' | 'scheduledTasks' | 'mcp' | 'wallet' | 'invite' | 'quickuse' | 'scenarioCreate' | 'scenarioRuns' | 'web3news' | 'hotsearch' | 'partners' | 'personality' | 'contact' | 'matrix' | 'matrixTaskNew' | 'matrixTasks' | 'matrixRuns' | 'cloudPhone';
  onShowHome: () => void;
  onShowSkills: () => void;
  onShowCowork: () => void;
  onShowCoworkHistory?: () => void;
  onShowScheduledTasks: () => void;
  onShowMcp: () => void;
  onShowWallet: () => void;
  onShowInvite: () => void;
  onShowQuickUse: () => void;
  onShowScenarioRuns: () => void;
  onShowScenarioCreate: () => void;
  onShowWeb3News: () => void;
  onShowHotSearch: () => void;
  onShowPersonality: () => void;
  onShowPartners: () => void;
  onShowContact?: () => void;
  onShowMatrix: () => void;
  matrixExpiredCount?: number;
  onShowMatrixTaskNew?: () => void;
  onShowMatrixTasks?: () => void;
  onShowMatrixRuns?: () => void;
  onShowCloudPhone?: () => void;
  /** 简洁版(2026-10-28):侧栏只留 首页 / 我的矩阵账号 / 我的任务 / 我的充值 / 邀请返佣 / 联系我们 */
  simple?: boolean;
  /** 专业版:左下角的「简洁版 | 专业版」切换(简洁版的切换在顶部横条) */
  onSwitchEdition?: (e: 'simple' | 'pro') => void;
  onNewChat: () => void;
  isCollapsed: boolean;
  onToggleCollapse: () => void;
  updateBadge?: React.ReactNode;
}

const Sidebar: React.FC<SidebarProps> = ({
  activeView,
  onShowHome,
  onShowSkills,
  onShowCowork,
  onShowCoworkHistory,
  onShowScheduledTasks,
  onShowMcp,
  onShowWallet,
  onShowInvite,
  onShowQuickUse,
  onShowScenarioRuns,
  onShowScenarioCreate,
  onShowWeb3News,
  onShowPersonality,
  onShowMatrix,
  matrixExpiredCount = 0,
  onShowMatrixTaskNew,
  onShowMatrixTasks,
  onShowMatrixRuns,
  onShowCloudPhone,
  simple,
  onNewChat,
  isCollapsed,
  onToggleCollapse,
  updateBadge,
}) => {
  const sessions = useSelector((state: RootState) => state.cowork.sessions);
  const currentSessionId = useSelector((state: RootState) => state.cowork.currentSessionId);
  const [isSearchOpen, setIsSearchOpen] = useState(false);
  // v6.x:「AI对话」二级折叠组(新建对话 / web3连接 / 行业热点)。默认收起;
  //   当组内某子项激活时强制展开,避免高亮项被折叠藏起来。
  const [aiChatOpen, setAiChatOpen] = useState(false);
  // 「浏览器窗口」二级组(我的矩阵账号 / 新建任务 / 我的任务 / 任务运行记录),默认展开(2026-10-31)。仅专业版。
  const [browserOpen, setBrowserOpen] = useState(true);
  // 「云手机环境」二级组(我的云手机),默认展开。仅专业版。
  const [phoneOpen, setPhoneOpen] = useState(true);
  const aiChildActive = activeView === 'cowork' || activeView === 'coworkHistory' || activeView === 'mcp' || activeView === 'web3news' || activeView === 'scheduledTasks' || activeView === 'skills';
  useEffect(() => { if (aiChildActive) setAiChatOpen(true); }, [aiChildActive]);
  const [isBatchMode, setIsBatchMode] = useState(false);
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [showBatchDeleteConfirm, setShowBatchDeleteConfirm] = useState(false);
  const isMac = window.electron.platform === 'darwin';

  useEffect(() => {
    const handleSearch = () => {
      onShowCowork();
      setIsSearchOpen(true);
    };
    window.addEventListener('cowork:shortcut:search', handleSearch);
    return () => {
      window.removeEventListener('cowork:shortcut:search', handleSearch);
    };
  }, [onShowCowork]);

  useEffect(() => {
    if (!isCollapsed) return;
    setIsSearchOpen(false);
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, [isCollapsed]);

  const handleSelectSession = async (sessionId: string) => {
    onShowCowork();
    await coworkService.loadSession(sessionId);
  };

  const handleDeleteSession = async (sessionId: string) => {
    await coworkService.deleteSession(sessionId);
  };

  const handleTogglePin = async (sessionId: string, pinned: boolean) => {
    await coworkService.setSessionPinned(sessionId, pinned);
  };

  const handleRenameSession = async (sessionId: string, title: string) => {
    await coworkService.renameSession(sessionId, title);
  };

  const handleEnterBatchMode = useCallback((sessionId: string) => {
    setIsBatchMode(true);
    setSelectedIds(new Set([sessionId]));
  }, []);

  const handleExitBatchMode = useCallback(() => {
    setIsBatchMode(false);
    setSelectedIds(new Set());
    setShowBatchDeleteConfirm(false);
  }, []);

  const handleToggleSelection = useCallback((sessionId: string) => {
    setSelectedIds(prev => {
      const next = new Set(prev);
      if (next.has(sessionId)) {
        next.delete(sessionId);
      } else {
        next.add(sessionId);
      }
      return next;
    });
  }, []);

  const handleSelectAll = useCallback(() => {
    setSelectedIds(prev => {
      if (prev.size === sessions.length) {
        return new Set();
      }
      return new Set(sessions.map(s => s.id));
    });
  }, [sessions]);

  const handleBatchDeleteClick = useCallback(() => {
    if (selectedIds.size === 0) return;
    setShowBatchDeleteConfirm(true);
  }, [selectedIds.size]);

  const handleBatchDelete = useCallback(async () => {
    if (selectedIds.size === 0) return;
    const ids = Array.from(selectedIds);
    await coworkService.deleteSessions(ids);
    handleExitBatchMode();
  }, [selectedIds, handleExitBatchMode]);

  // 有二级子菜单的一级菜单:不选中、不加底色;当前页在它下面时文字转主题色,提示「在这一组里」(收起时也看得出)
  const groupCls = (keys: string[]) => (keys.includes(activeView as string)
    ? 'nc-nav-has hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover');

  return (
    <aside
      className={`shrink-0 dark:bg-claude-darkSurfaceMuted bg-claude-surfaceMuted flex flex-col sidebar-transition overflow-hidden ${
        isCollapsed ? 'w-0' : 'w-60'
      }`}
    >
      <div className="pt-3 pb-3">
        {/* Logo + App Name + Collapse Button */}
        {/* macOS:顶部留一条拖拽区给红绿灯窗控,logo 行下移 → 与下方菜单一样左对齐(不再 pl-68 居中) */}
        {/* 简洁版:不要 logo / 品牌名 / 收起按钮 */}
        {!simple && (<>
        {isMac && <div className="draggable h-5" />}
        <div className="draggable sidebar-header-drag h-10 flex items-center justify-between px-3">
          <div className="non-draggable flex items-center gap-2">
            <img src="logo.png" alt="logo" className="w-6 h-6 rounded-lg" />
            <span className="font-bold text-sm dark:text-claude-darkText text-claude-text tracking-wide">{i18nService.t('appBrand')}</span>
            {updateBadge}
          </div>
          <button
            type="button"
            onClick={onToggleCollapse}
            className="non-draggable h-8 w-8 inline-flex items-center justify-center rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            aria-label={isCollapsed ? i18nService.t('expand') : i18nService.t('collapse')}
          >
            <SidebarToggleIcon className="h-4 w-4" isCollapsed={isCollapsed} />
          </button>
        </div>
        </>)}
        <div className="mt-3 space-y-1 px-3">
          {/* 首页 — 置顶,默认进入。产品定位 + 三步使用流程 + 涨粉教程 + 开源提示 */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowHome(); }}
            aria-current={activeView === 'home' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'home'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'🏠'}</span>
            {i18nService.t('home')}
          </button>

          {!MATRIX_EDITION && (<>
          {/* 1. 新建涨粉任务 — 新建页提升为一级菜单 (create 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowScenarioCreate(); }}
            aria-current={activeView === 'scenarioCreate' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scenarioCreate'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'✨'}</span>
            {i18nService.t('quickUse')}
          </button>

          {/* 2. 我的涨粉任务 — 原"一键涨粉" (manage 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowQuickUse(); }}
            aria-current={activeView === 'quickuse' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'quickuse'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'📋'}</span>
            {i18nService.t('myFanTasks')}
          </button>

          {/* 3. 涨粉运行记录 — 原 manage 内「运行记录」L1 段拆成独立菜单 (runs 模式) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowScenarioRuns(); }}
            aria-current={activeView === 'scenarioRuns' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'scenarioRuns'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">{'📊'}</span>
            {i18nService.t('fanRunHistory')}
          </button>
          </>)}

          {/* 矩阵号导航:专业版收进「浏览器」二级组(默认展开);云手机在组外。简洁版仍平铺(只留 我的矩阵账号 / 我的任务)。 */}
          {(() => {
            const zh = i18nService.currentLanguage === 'zh', tw = i18nService.currentLanguage === 'zh-TW';
            const browserItems = ([
              // 专业版是二级菜单 → 不带图标(和一级菜单区分开);简洁版平铺,保留图标
              ['matrix', (simple ? '👥 ' : '') + i18nService.t('matrixMyAccounts'), onShowMatrix],
              ['matrixTaskNew', (simple ? '✨ ' : '') + i18nService.t('matrixNewFanTask'), onShowMatrixTaskNew],
              ['matrixTasks', (simple ? '📋 ' : '') + (simple ? (zh ? '我的任务' : tw ? '我的任務' : 'My Tasks') : i18nService.t('matrixMyFanTasks')), onShowMatrixTasks],
              ['matrixRuns', (simple ? '📊 ' : '') + i18nService.t('matrixRunHistory'), onShowMatrixRuns],
            ] as const).filter(([key]) => (simple ? (key === 'matrix' || key === 'matrixTasks') : key !== 'matrixTaskNew'));   // 专业版不再放「新建任务」菜单(在「窗口任务」页右上角新建)
            const navBtn = (key: string, label: string, handler: (() => void) | undefined) => (
              <button
                key={key}
                type="button"
                onClick={() => { setIsSearchOpen(false); (handler || onShowMatrix)(); }}
                aria-current={activeView === key ? 'page' : undefined}
                className={`relative w-full inline-flex items-center gap-2 rounded-lg px-3 py-2 text-sm font-medium transition-colors ${
                  activeView === key
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                {label}
                {/* 「我的矩阵账号」菜单:全平台登录过期账号总数红圈角标(与账号页各平台 tab 角标一致),提醒去重连 */}
                {key === 'matrix' && matrixExpiredCount > 0 && (
                  <span className="absolute top-1 right-1.5 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{matrixExpiredCount}</span>
                )}
              </button>
            );
            if (simple) return <div className="space-y-1">{browserItems.map(([k, l, h]) => navBtn(k, l, h))}</div>;
            return (
              <div className="space-y-1">
                <button
                  type="button"
                  onClick={() => setBrowserOpen(o => !o)}
                  className={`relative w-full inline-flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${groupCls(['matrix', 'matrixTaskNew', 'matrixTasks', 'matrixRuns'])}`}
                >
                  <span className="inline-flex items-center gap-2">
                    <span className="text-sm">{'🌐'}</span>
                    {zh ? '浏览器窗口' : tw ? '瀏覽器窗口' : 'Browser Windows'}
                  </span>
                  <span className={`text-xs transition-transform ${browserOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
                  {/* 收起时把「过期账号」角标挂到组头上,别藏起来 */}
                  {!browserOpen && matrixExpiredCount > 0 && (
                    <span className="absolute top-1 right-6 min-w-[18px] h-[18px] px-1 flex items-center justify-center rounded-full bg-red-500 text-white text-[10px] font-bold leading-none">{matrixExpiredCount}</span>
                  )}
                </button>
                {browserOpen && <div className="space-y-1 pl-9">{browserItems.map(([k, l, h]) => navBtn(k, l, h))}</div>}
                {/* 云手机环境:安卓手机上的 NoobClaw Mobile(简洁版在顶部菜单) */}
                {onShowCloudPhone && (<>
                  <button
                    type="button"
                    onClick={() => setPhoneOpen(o => !o)}
                    className={`w-full inline-flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${groupCls(['cloudPhone'])}`}
                  >
                    <span className="inline-flex items-center gap-2">
                      <span className="text-sm">{'📱'}</span>
                      {zh ? '云手机环境' : tw ? '雲手機環境' : 'Cloud Phones'}
                    </span>
                    <span className={`text-xs transition-transform ${phoneOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
                  </button>
                  {phoneOpen && <div className="space-y-1 pl-9">{navBtn('cloudPhone', (zh ? '我的云手机' : tw ? '我的雲手機' : 'My Cloud Phones'), onShowCloudPhone)}</div>}
                </>)}
              </div>
            );
          })()}

          {!simple && (<>
          {/* 4. AI对话 — 折叠二级菜单：新建对话 / web3连接 / 行业热点 */}
          <button
            type="button"
            onClick={() => setAiChatOpen(o => !o)}
            className={`w-full inline-flex items-center justify-between rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${groupCls(['cowork', 'coworkHistory', 'scheduledTasks', 'mcp', 'web3news', 'skills'])}`}
          >
            <span className="inline-flex items-center gap-2">
              <span className="text-sm">{'💬'}</span>
              {i18nService.t('aiChat')}
            </span>
            <span className={`text-xs transition-transform ${aiChatOpen ? 'rotate-90' : ''}`}>{'▸'}</span>
          </button>

          {aiChatOpen && (
            <div className="space-y-1 pl-9">
              {/* 新建对话 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onNewChat(); }}
                aria-current={activeView === 'cowork' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'cowork'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <ComposeIcon className="h-4 w-4" />
                {i18nService.t('newChat')}
              </button>

              {/* 所有AI对话 — 矩阵版没有常驻对话历史列表,点开在主区域展示对话列表页(空状态/删除/点击进对话) */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowCoworkHistory?.(); }}
                aria-current={activeView === 'coworkHistory' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'coworkHistory'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'📚'}</span>
                {i18nService.t('coworkHistory')}
              </button>

              {/* AI定时任务 — 原顶级"自建定时任务",收进 AI对话组,排在新建对话下面 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowScheduledTasks(); }}
                aria-current={activeView === 'scheduledTasks' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'scheduledTasks'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'⏰'}</span>
                {i18nService.t('scheduledTasks')}
              </button>

              {/* web3连接 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowMcp(); }}
                aria-current={activeView === 'mcp' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'mcp'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'🌐'}</span>
                {i18nService.t('mcpServers')}
              </button>

              {/* 行业热点 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowWeb3News(); }}
                aria-current={activeView === 'web3news' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'web3news'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">{'🔥'}</span>
                {i18nService.t('hotTopics')}
              </button>

              {/* AI技能商店 — 原顶级「技能商店」收进 AI对话组并改名 */}
              <button
                type="button"
                onClick={() => { setIsSearchOpen(false); onShowSkills(); }}
                aria-current={activeView === 'skills' ? 'page' : undefined}
                className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
                  activeView === 'skills'
                    ? 'nc-nav-on'
                    : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
                }`}
              >
                <span className="text-sm">🧩</span>
                {i18nService.t('aiSkillStore')}
              </button>
            </div>
          )}

          </>)}

          {/* My Wallet */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowWallet(); }}
            aria-current={activeView === 'wallet' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'wallet'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">💰</span>
            {i18nService.t('myWallet')}
          </button>

          {/* Invite Rebate (v1.x: 文案统一为"邀请返佣",跟官网 nav 对齐) */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowInvite(); }}
            aria-current={activeView === 'invite' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'invite'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">🎁</span>
            {i18nService.t('inviteRebateMenu')}
          </button>

          {!MATRIX_EDITION && (<>
          {/* Personality Tests */}
          <button
            type="button"
            onClick={() => { setIsSearchOpen(false); onShowPersonality(); }}
            aria-current={activeView === 'personality' ? 'page' : undefined}
            className={`w-full inline-flex items-center gap-2 rounded-lg px-2.5 py-2 text-sm font-medium transition-colors ${
              activeView === 'personality'
                ? 'nc-nav-on'
                : 'dark:text-claude-darkText text-claude-text hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover'
            }`}
          >
            <span className="text-sm">🧠</span>
            {i18nService.t('personalityTests')}
          </button>
          </>)}

          {/* 热搜 / 活动与合作 / 联系我们 / 设置 / 版本切换:统一挪到顶部横条(☰ 菜单 + 账号下拉 + 正中切换) */}
        </div>
      </div>
      {!MATRIX_EDITION && (
      <div className="flex-1 overflow-y-auto px-2.5 pb-4">
        <div className="px-3 pb-2 text-sm font-medium dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {i18nService.t('coworkHistory')}
        </div>
        <CoworkSessionList
          sessions={sessions}
          currentSessionId={currentSessionId}
          isBatchMode={isBatchMode}
          selectedIds={selectedIds}
          onSelectSession={handleSelectSession}
          onDeleteSession={handleDeleteSession}
          onTogglePin={handleTogglePin}
          onRenameSession={handleRenameSession}
          onToggleSelection={handleToggleSelection}
          onEnterBatchMode={handleEnterBatchMode}
        />
      </div>
      )}
      <CoworkSearchModal
        isOpen={isSearchOpen}
        onClose={() => setIsSearchOpen(false)}
        sessions={sessions}
        currentSessionId={currentSessionId}
        onSelectSession={handleSelectSession}
        onDeleteSession={handleDeleteSession}
        onTogglePin={handleTogglePin}
        onRenameSession={handleRenameSession}
      />
      {isBatchMode ? (
        <div className="px-3 pb-3 pt-1 flex items-center justify-between">
          <label className="flex items-center gap-2 cursor-pointer text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
            <input
              type="checkbox"
              checked={selectedIds.size === sessions.length && sessions.length > 0}
              onChange={handleSelectAll}
              className="h-4 w-4 rounded border-gray-300 dark:border-gray-600 accent-claude-accent cursor-pointer"
            />
            {i18nService.t('batchSelectAll')}
          </label>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleBatchDeleteClick}
              disabled={selectedIds.size === 0}
              className={`inline-flex items-center gap-1 px-3 py-1.5 text-sm font-medium rounded-lg transition-colors ${
                selectedIds.size > 0
                  ? 'bg-red-500 hover:bg-red-600 text-white'
                  : 'bg-gray-200 dark:bg-gray-700 text-gray-400 dark:text-gray-500 cursor-not-allowed'
              }`}
            >
              <TrashIcon className="h-3.5 w-3.5" />
              {selectedIds.size > 0 ? `${selectedIds.size}` : ''}
            </button>
            <button
              type="button"
              onClick={handleExitBatchMode}
              className="px-3 py-1.5 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary hover:bg-claude-surfaceHover dark:hover:bg-claude-darkSurfaceHover transition-colors"
            >
              {i18nService.t('batchCancel')}
            </button>
          </div>
        </div>
      ) : null}
      {/* Batch Delete Confirmation Modal */}
      {showBatchDeleteConfirm && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/50"
          
        >
          <div
            className="w-full max-w-sm mx-4 dark:bg-claude-darkSurface bg-claude-surface rounded-2xl shadow-xl overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center gap-3 px-5 py-4">
              <div className="p-2 rounded-full bg-red-100 dark:bg-red-900/30">
                <ExclamationTriangleIcon className="h-5 w-5 text-red-600 dark:text-red-500" />
              </div>
              <h2 className="text-base font-semibold dark:text-claude-darkText text-claude-text">
                {i18nService.t('batchDeleteConfirmTitle')}
              </h2>
            </div>
            <div className="px-5 pb-4">
              <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
                {i18nService.t('batchDeleteConfirmMessage').replace('{count}', String(selectedIds.size))}
              </p>
            </div>
            <div className="flex items-center justify-end gap-3 px-5 py-4 border-t dark:border-claude-darkBorder border-claude-border">
              <button
                onClick={() => setShowBatchDeleteConfirm(false)}
                className="px-4 py-2 text-sm font-medium rounded-lg dark:text-claude-darkTextSecondary text-claude-textSecondary dark:hover:bg-claude-darkSurfaceHover hover:bg-claude-surfaceHover transition-colors"
              >
                {i18nService.t('cancel')}
              </button>
              <button
                onClick={handleBatchDelete}
                className="px-4 py-2 text-sm font-medium rounded-lg bg-red-500 hover:bg-red-600 text-white transition-colors"
              >
                {i18nService.t('batchDelete')} ({selectedIds.size})
              </button>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
};

export default Sidebar;
