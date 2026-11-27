/** Local recovery delays, not platform-approved sending rates. */
export function recoveryDelay(attempt: number): number {
  return [60_000, 300_000, 900_000, 3_600_000][Math.min(3, Math.max(0, attempt - 1))];
}

/** Only known transport/read failures may recover automatically. Unknown failures stay visible. */
export function isRecoverableFailure(reason: string): boolean {
  if (/charge|billing|余额|insufficient|403|429|captcha|验证码|forbidden|rate.?limit|account_flag|login_wall|绑定冲突|出口变化/i.test(reason)) return false;
  return /^navigation:(?:connection|dns|tunnel|tls|proxy|timeout)$/.test(reason)
    || /login_unknown|network_error|fetch failed|ECONN|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|ERR_(?:PROXY|TUNNEL|CONNECTION|NETWORK)|timeout|timed out|超时|temporary offline|websocket|CDP|页面加载失败|页面检测失败|任务中断|process exited/i.test(reason);
}
