/** Pacing for prewritten workbook comments only. Existing tasks get these defaults. */
export interface CustomCommentPolicy {
  homeWarmup: 'once' | 'per_video';
  accountLimit: number;
  restEvery: number;
  restMinMinutes: number;
  restMaxMinutes: number;
}

export function normalizeCustomCommentPolicy(value?: Partial<CustomCommentPolicy>): CustomCommentPolicy {
  const int = (v: unknown, min: number, max: number, fallback: number) =>
    typeof v === 'number' && Number.isInteger(v) && v >= min && v <= max ? v : fallback;
  const restMinMinutes = int(value?.restMinMinutes, 1, 30, 2);
  return {
    homeWarmup: value?.homeWarmup === 'per_video' ? 'per_video' : 'once',
    accountLimit: int(value?.accountLimit, 1, 300, 20),
    restEvery: int(value?.restEvery, 1, 300, 6),
    restMinMinutes,
    restMaxMinutes: Math.max(restMinMinutes, int(value?.restMaxMinutes, 1, 30, 4)),
  };
}
