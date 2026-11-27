/**
 * 会员档名展示(2026-11-01):中文界面把后端下发的「XX版」统一显示成「XX会员」
 * (免费版 → 免费会员、进阶版 → 进阶会员、至尊版 → 至尊会员…)。只改展示,不改任何判定。
 */
import { i18nService } from './i18n';

export function memberTierLabel(name: string | null | undefined): string {
  const n = String(name || '');
  const lang = i18nService.currentLanguage;
  if (lang === 'zh') return n.replace(/版$/, '会员');
  if (lang === 'zh-TW') return n.replace(/版$/, '會員');
  return n;
}
