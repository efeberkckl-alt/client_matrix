import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';

/** Logged in? Re-renders on login / logout. */
export function useLoggedIn(): boolean {
  const [ok, setOk] = useState(!!noobClawAuth.getState().isAuthenticated);
  useEffect(() => noobClawAuth.subscribe((s: any) => setOk(!!s?.isAuthenticated)), []);
  return ok;
}

/**
 * 未登录时代替列表 / 本地数据的登录提示(和钱包页同款:锁 + 标题 + 说明 + 登录按钮)。
 * 2026-11-02:未登录时任务、账号窗口、运行记录、云手机都不显示本地数据。
 */
export const LoginGate: React.FC<{ title?: string; desc?: string; className?: string }> = ({ title, desc, className }) => {
  const L = (zh: string, tw: string, en: string) => (i18nService.currentLanguage === 'zh' ? zh : i18nService.currentLanguage === 'zh-TW' ? tw : en);
  return (
    <div className={`flex-1 flex flex-col items-center justify-center p-8 text-center min-h-[320px] ${className || ''}`}>
      <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mb-4">
        <svg className="w-8 h-8 text-primary" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path strokeLinecap="round" strokeLinejoin="round" strokeWidth={1.5} d="M12 15v2m-6 4h12a2 2 0 002-2v-6a2 2 0 00-2-2H6a2 2 0 00-2 2v6a2 2 0 002 2zm10-10V7a4 4 0 00-8 0v4h8z" /></svg>
      </div>
      <h2 className="text-lg font-bold dark:text-claude-darkText text-claude-text mb-2">{title || L('登录账号，查看你的数据', '登入帳號，查看你的資料', 'Log in to see your data')}</h2>
      <p className="dark:text-claude-darkTextSecondary text-claude-textSecondary text-sm mb-6">{desc || L('暂无数据 · 登录后显示你的任务、账号窗口和运行记录', '暫無資料 · 登入後顯示你的任務、帳號窗口和運行記錄', 'Nothing to show yet · log in to see your tasks, account windows and run records')}</p>
      <button type="button" onClick={() => noobClawAuth.requireLoginUI()}
        className="px-6 py-2.5 bg-primary hover:bg-primary-hover text-black rounded-lg font-medium transition-all">
        {L('登录 →', '登入 →', 'Log in →')}
      </button>
    </div>
  );
};
