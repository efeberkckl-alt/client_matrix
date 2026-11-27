/**
 * 顶部横条右侧的账号胶囊 + 下拉菜单(2026-11-01,替代各页头部的 WalletBadge)。
 *   胶囊:头像 · 名字 + 会员角标 · 💎 积分。点开下拉:
 *     头部  大头像 / 名字 / UID(可复制)/ 💎 积分
 *     两张卡 会员情况(剩余天数 / 到期日 / 续费·升级) · 当前邀请返佣比例(邀请好友 / 申请合伙人)
 *     列表  个人设置 · 退出登录
 * 会员口径与 WalletBadge 一致:以整周期到期日 subPeriodEnd 为准;买过但过期 = 已过期,没买过 = 免费版。
 * 返佣比例走 profitSharePct 展示口径(非合伙人 50%,合伙人按档 75/85/90/95)。
 */
import React, { useEffect, useState } from 'react';
import { i18nService } from '../../services/i18n';
import { noobClawAuth } from '../../services/noobclawAuth';
import { noobClawApi } from '../../services/noobclawApi';
import { readCachedProfile, writeCachedProfile } from '../../services/profileCache';
import { profitSharePct } from '../../services/profitShare';
import { openWallet } from '../../services/walletNav';
import { memberTierLabel } from '../../services/planName';

const L = (zh: string, tw: string, en: string): string => {
  const lang = i18nService.currentLanguage;
  return lang === 'zh' ? zh : lang === 'zh-TW' ? tw : en;
};
const PLAN_KEYS: Record<string, string> = { free: 'planTierFree', basic: 'planTierBasic', pro: 'planTierPro', max: 'planTierMax', '免费版': 'planTierFree', '基础版': 'planTierBasic', '进阶版': 'planTierPro', '旗舰版': 'planTierMax', '免费会员': 'planTierFree', '基础会员': 'planTierBasic', '进阶会员': 'planTierPro', '旗舰会员': 'planTierMax' };

const Avatar: React.FC<{ url?: string | null; text: string; size: number }> = ({ url, text, size }) => (
  url
    ? <img src={url} alt="" className="rounded-full object-cover shrink-0" style={{ width: size, height: size }} />
    : <span className="rounded-full shrink-0 grid place-items-center font-extrabold text-white" style={{ width: size, height: size, fontSize: Math.round(size * 0.36), background: 'linear-gradient(135deg,#5b7cfa,#4f46e5)' }}>{text}</span>
);

const AccountMenu: React.FC<{ onShowSettings: () => void; onShowInvite: () => void; closeSignal?: number; onOpen?: () => void }> = ({ onShowSettings, onShowInvite, closeSignal, onOpen }) => {
  const [auth, setAuth] = useState(noobClawAuth.getState());
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const [confirmLogout, setConfirmLogout] = useState(false);
  const [profile, setProfile] = useState<any>(() => readCachedProfile(noobClawAuth.getState().walletAddress));
  useEffect(() => noobClawAuth.subscribe(setAuth), []);
  useEffect(() => { setOpen(false); }, [closeSignal]);
  // 返佣比例要 /me/profile 里的 partner 块:先读缓存,再后台拉新(与 Cowork/Invite 页同一套缓存)
  useEffect(() => {
    if (!auth.isAuthenticated) { setProfile(null); return; }
    const cached = readCachedProfile(auth.walletAddress);
    if (cached) setProfile(cached);
    noobClawApi.getUserProfile().then((fresh: any) => {
      if (fresh) { setProfile(fresh); writeCachedProfile(auth.walletAddress, fresh); }
    }).catch(() => { /* 拉不到就用缓存 / 默认值 */ });
  }, [auth.isAuthenticated, auth.walletAddress]);
  // 每次打开下拉再刷一次(合伙人审核通过 / 档位变化后能及时看到新比例)
  useEffect(() => {
    if (!open || !auth.isAuthenticated) return;
    noobClawApi.getUserProfile().then((fresh: any) => {
      if (fresh) { setProfile(fresh); writeCachedProfile(auth.walletAddress, fresh); }
    }).catch(() => { /* ignore */ });
  }, [open, auth.isAuthenticated, auth.walletAddress]);
  // 外部登出(token 失效等)时收起下拉,免得下次登录自动弹开
  useEffect(() => { if (!auth.isAuthenticated) setOpen(false); }, [auth.isAuthenticated]);
  // Esc 关闭
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!auth.isAuthenticated) {
    return (
      <button type="button" onClick={() => noobClawAuth.requireLoginUI()}
        className="non-draggable shrink-0 text-xs font-semibold px-3 py-1.5 rounded-lg bg-claude-accent text-[#04130B]">{i18nService.t('coworkConnectWallet')}</button>
    );
  }

  const uid = auth.walletAddress || '';
  const name = auth.socialEmail || (uid.length > 12 ? `${uid.slice(0, 6)}…${uid.slice(-4)}` : uid) || '—';
  const initials = (name.replace(/[^A-Za-z0-9一-龥]/g, '').slice(0, 2) || 'U').toUpperCase();
  const balance = Number(auth.tokenBalance || 0).toLocaleString();

  const periodEndMs = auth.subPeriodEnd ? new Date(auth.subPeriodEnd).getTime() : 0;
  const memberActive = periodEndMs > Date.now();
  const expired = !!auth.subStatus && !memberActive;
  const rawPlan = auth.subPlanName || auth.planName || '';
  const planName = PLAN_KEYS[rawPlan] ? i18nService.t(PLAN_KEYS[rawPlan]) : memberTierLabel(rawPlan || i18nService.t('wbPlanFree'));
  const freeName = i18nService.t('planTierFree');
  const daysLeft = memberActive ? Math.max(0, Math.ceil((periodEndMs - Date.now()) / 86_400_000)) : 0;
  const endD = periodEndMs ? new Date(periodEndMs) : null;
  const endLabel = endD ? `${endD.getFullYear()}/${String(endD.getMonth() + 1).padStart(2, '0')}/${String(endD.getDate()).padStart(2, '0')}` : '';

  const partner = profile?.partner?.is_partner ? profile.partner : null;
  const rebatePct = profitSharePct(partner ? partner.rate_pct : null);

  // 胶囊角标:有效 = 金色档名;过期 = 红色「~~档名~~ · 已过期」;没买过 = 灰色免费版
  const tag = memberActive
    ? <span className="shrink-0 text-[10px] font-bold px-1.5 rounded-[5px] leading-[1.6]" style={{ background: 'rgba(245,185,66,.14)', color: '#f5b942' }}>{planName}</span>
    : expired
      ? <span className="shrink-0 text-[10px] font-bold px-1.5 rounded-[5px] leading-[1.6]" style={{ background: 'rgba(255,92,122,.14)', color: '#ff5c7a' }}><s style={{ textDecorationThickness: 1.5 }}>{planName}</s> · {L('已过期', '已過期', 'Expired')}</span>
      : <span className="shrink-0 text-[10px] font-bold px-1.5 rounded-[5px] leading-[1.6] bg-black/5 dark:bg-white/10 dark:text-claude-darkTextSecondary text-claude-textSecondary">{freeName}</span>;

  const vip = memberActive
    ? { big: L(`剩 ${daysLeft} 天`, `剩 ${daysLeft} 天`, `${daysLeft} days left`), color: daysLeft <= 7 ? '#ffb020' : '#f5b942', meta: L(`${endLabel} 到期`, `${endLabel} 到期`, `Expires ${endLabel}`), btn: L('续费', '續費', 'Renew'), title: planName }
    : expired
      ? { big: L('已过期', '已過期', 'Expired'), color: '#ff5c7a', meta: L('续费后恢复会员能力', '續費後恢復會員能力', 'Renew to restore member features'), btn: L('立即续费', '立即續費', 'Renew now'), title: planName }
      : { big: freeName, color: '', meta: L('升级解锁更多能力', '升級解鎖更多能力', 'Upgrade to unlock more'), btn: L('升级会员', '升級會員', 'Upgrade'), title: freeName };

  const close = () => setOpen(false);
  const go = (fn: () => void) => () => { close(); fn(); };
  const copyUid = () => {
    try { navigator.clipboard.writeText(uid).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); }).catch(() => { /* ignore */ }); } catch { /* ignore */ }
  };
  // 退出登录先二次确认;确认后再作废服务端会话 + 清本地(与设置页一致)
  const askLogout = () => { close(); setConfirmLogout(true); };
  const doLogout = () => { setConfirmLogout(false); noobClawApi.serverLogout(); noobClawAuth.logout(); };
  // 卡片按钮:统一绿色实心小按钮(不用 bg-claude-accent 类,免得被暗色主题的全局按钮光晕规则放大)
  const cardBtn = 'mt-auto self-start w-[84px] text-center text-[11.5px] font-bold py-[3px] rounded-[7px]';
  const cardBtnStyle: React.CSSProperties = { background: '#00FF88', color: '#04130B' };

  return (
    <div className="relative non-draggable shrink-0">
      {confirmLogout && (
        <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/50 p-4" onClick={() => setConfirmLogout(false)}>
          <div role="dialog" aria-modal="true" className="w-full max-w-sm rounded-2xl p-5 dark:bg-claude-darkSurface bg-white border dark:border-claude-darkBorder border-claude-border shadow-2xl" onClick={(e) => e.stopPropagation()}>
            <div className="text-base font-semibold dark:text-claude-darkText text-claude-text mb-2">{L('退出登录', '登出', 'Log out')}</div>
            <div className="text-sm leading-relaxed dark:text-claude-darkTextSecondary text-claude-textSecondary mb-5">{L('确定要退出当前账号吗?', '確定要登出目前帳號嗎?', 'Log out of this account?')}</div>
            <div className="flex gap-3">
              <button type="button" onClick={() => setConfirmLogout(false)} className="flex-1 py-2 rounded-xl text-sm font-semibold border dark:border-white/15 border-black/15 dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5">{L('取消', '取消', 'Cancel')}</button>
              <button type="button" onClick={doLogout} className="flex-1 py-2 rounded-xl text-sm font-semibold text-white" style={{ background: '#ef4444' }}>{L('退出登录', '登出', 'Log out')}</button>
            </div>
          </div>
        </div>
      )}
      <button type="button" onClick={() => { if (!open) onOpen?.(); setOpen(!open); }} aria-expanded={open} aria-haspopup="menu"
        className={`flex items-center gap-2 h-10 pl-[3px] pr-2.5 rounded-xl border dark:bg-claude-darkSurface bg-white transition-colors ${open ? 'dark:border-white/25 border-black/25' : 'dark:border-claude-darkBorder border-claude-border hover:dark:border-white/20 hover:border-black/20'}`}>
        <Avatar url={auth.avatarUrl} text={initials} size={30} />
        <span className="flex flex-col items-start leading-tight gap-0.5 min-w-0">
          <span className="flex items-center gap-1.5 text-[12.5px] font-semibold dark:text-claude-darkText text-claude-text whitespace-nowrap">
            <span className="truncate max-w-[140px]">{name}</span>{tag}
          </span>
          <span className="text-[11.5px] whitespace-nowrap dark:text-claude-darkTextSecondary text-claude-textSecondary">💎 <b className="dark:text-claude-darkText text-claude-text tabular-nums">{balance}</b></span>
        </span>
        <span className={`ml-1 text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary transition-transform ${open ? 'rotate-180' : ''}`}>▾</span>
      </button>
      {open && (
        <>
          <div className="fixed inset-0 z-40" onClick={close} />
          <div role="menu" className="absolute right-0 top-[calc(100%+8px)] z-50 w-[360px] rounded-2xl shadow-2xl dark:bg-claude-darkSurface bg-white border dark:border-white/10 border-black/10">
            <div className="flex items-center gap-4 px-[18px] pt-5 pb-4">
              <Avatar url={auth.avatarUrl} text={initials} size={64} />
              <div className="flex-1 min-w-0 flex flex-col gap-1.5">
                <div className="text-lg font-bold dark:text-claude-darkText text-claude-text truncate">{name}</div>
                <div className="flex items-center gap-2 text-[13px] dark:text-claude-darkTextSecondary text-claude-textSecondary min-w-0">
                  <span className="shrink-0">{/^0x/i.test(uid) ? i18nService.t('walletMyWalletBsc') : 'UID'}</span>
                  <span className="font-mono dark:text-claude-darkText text-claude-text truncate" title={uid}>{/^0x/i.test(uid) ? `${uid.slice(0, 8)}…${uid.slice(-6)}` : uid}</span>
                  <button type="button" onClick={copyUid}
                    className="shrink-0 text-xs px-2 py-0.5 rounded-lg border dark:border-white/10 border-black/10 hover:bg-black/5 dark:hover:bg-white/5">{copied ? L('已复制', '已複製', 'Copied') : L('复制', '複製', 'Copy')}</button>
                </div>
                <div className="text-[13px] dark:text-claude-darkTextSecondary text-claude-textSecondary">💎 <b className="dark:text-claude-darkText text-claude-text tabular-nums">{balance}</b></div>
              </div>
            </div>
            <div className="grid grid-cols-2 gap-2.5 px-3.5 pb-3.5">
              <div className="flex flex-col rounded-xl px-3 py-2.5 border"
                style={expired ? { background: 'rgba(255,92,122,.07)', borderColor: 'rgba(255,92,122,.4)' } : undefined}>
                <small className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">👑 {vip.title}</small>
                <div className="text-[15px] font-bold tabular-nums mt-0.5 dark:text-claude-darkText text-claude-text" style={vip.color ? { color: vip.color } : undefined}>{vip.big}</div>
                <div className="text-[11px] mb-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">{vip.meta}</div>
                <button type="button" onClick={go(() => openWallet('subscription'))} className={cardBtn} style={cardBtnStyle}>{vip.btn}</button>
              </div>
              <div className="flex flex-col rounded-xl px-3 py-2.5 border dark:border-white/10 border-black/10">
                <small className="text-[11px] dark:text-claude-darkTextSecondary text-claude-textSecondary">🎁 {L('当前邀请返佣比例', '當前邀請返傭比例', 'Your referral share')}</small>
                <div className="text-[15px] font-bold tabular-nums mt-0.5" style={{ color: '#00C46A' }}>{rebatePct}%</div>
                <div className="text-[11px] mb-2 dark:text-claude-darkTextSecondary text-claude-textSecondary">{partner ? L('邀请越多奖励越多', '邀請越多獎勵越多', 'Invite more, earn more') : L('合伙人最高 95%', '合夥人最高 95%', 'Partners up to 95%')}</div>
                <button type="button" onClick={go(onShowInvite)} className={cardBtn} style={cardBtnStyle}>{partner ? L('邀请好友', '邀請好友', 'Invite friends') : L('申请合伙人', '申請合夥人', 'Become a partner')}</button>
              </div>
            </div>
            <div className="border-t dark:border-white/10 border-black/10 p-1.5">
              <button type="button" role="menuitem" onClick={go(onShowSettings)}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[13.5px] text-left dark:text-claude-darkText text-claude-text hover:bg-black/5 dark:hover:bg-white/5">⚙️ {L('个人设置', '個人設定', 'Settings')}</button>
              <button type="button" role="menuitem" onClick={askLogout}
                className="w-full flex items-center gap-2.5 px-3 py-2.5 rounded-[10px] text-[13.5px] text-left text-red-500 hover:bg-black/5 dark:hover:bg-white/5">↪ {L('退出登录', '登出', 'Log out')}</button>
            </div>
          </div>
        </>
      )}
    </div>
  );
};

export default AccountMenu;
