/**
 * 合规隐藏平台(服务端 /api/matrix/config 按当前用户算好的 complianceHiddenPlatforms)。
 *
 * 给「视频创作 / 币安搬运 / 图文创作」这些不在 ScenarioView 平台 tab 体系里的地方用:
 * 下架的平台,对应的选项 / 卡片直接隐藏。拉不到就【不藏】(fail-open,和 ScenarioView 一致)。
 * 进程内缓存一份,登录态变化时重拉。
 */
import { useEffect, useState } from 'react';
import { getBackendApiUrl } from './endpoints';
import { noobClawAuth } from './noobclawAuth';

let hidden: string[] = [];
let inflight: Promise<void> | null = null;
let lastAuthKey = '';
const subs = new Set<(h: string[]) => void>();

function authKey(): string {
  const s: any = noobClawAuth.getState();
  return s?.isAuthenticated ? String(s?.user?.id ?? s?.user?.uid ?? 'auth') : 'anon';
}

export function loadComplianceHidden(force = false): Promise<void> {
  const key = authKey();
  if (!force && inflight && key === lastAuthKey) return inflight;
  lastAuthKey = key;
  inflight = (async () => {
    try {
      const res = await fetch(`${getBackendApiUrl()}/api/matrix/config`, { headers: noobClawAuth.getAuthHeaders() });
      if (!res.ok) return;
      const data = await res.json();
      if (!Array.isArray(data?.complianceHiddenPlatforms)) return;
      const next = data.complianceHiddenPlatforms.map(String);
      if (next.join(',') !== hidden.join(',')) {
        hidden = next;
        subs.forEach((fn) => { try { fn(hidden); } catch { /* ignore */ } });
      }
    } catch { /* 拉不到 → 不藏 */ }
  })();
  return inflight;
}

/** 同步判断(用缓存;首次调用会顺带触发拉取)。 */
export function isComplianceHidden(platform: string): boolean {
  if (!inflight) void loadComplianceHidden();
  return hidden.includes(platform);
}

/** React 用:返回当前隐藏列表,拉到后自动刷新。 */
export function useComplianceHidden(): string[] {
  const [h, setH] = useState<string[]>(hidden);
  useEffect(() => {
    subs.add(setH);
    void loadComplianceHidden();
    setH(hidden);
    return () => { subs.delete(setH); };
  }, []);
  return h;
}

// 登录 / 换号 → 重拉(不同用户白名单不同)
try {
  noobClawAuth.subscribe(() => { if (authKey() !== lastAuthKey) void loadComplianceHidden(true); });
} catch { /* ignore */ }
