/** 本轮人数与非零等待由客户端保底,远程脚本不能把额外停顿覆盖成 0。 */
export function leadEngageConfig(config: Record<string, any> = {}): Record<string, any> {
  const minimum = (name: string, low: number, high: number): number[] => {
    const value = config.behavior?.[name];
    if (!Array.isArray(value) || value.length !== 2 || !value.every(Number.isFinite) || value[0] < 0 || value[1] < value[0]) return [low, high];
    return [Math.max(low, value[0]), Math.max(high, value[1])];
  };
  return { ...config, behavior: {
    ...config.behavior,
    lead_unlimited: false,
    lead_watch_ms: minimum('lead_watch_ms', 3000, 6000),
    lead_between_leads_pause: minimum('lead_between_leads_pause', 15000, 30000),
    before_like_pause: minimum('before_like_pause', 2000, 4000),
    harvest_scroll_pause: minimum('harvest_scroll_pause', 3000, 6000),
  } };
}
