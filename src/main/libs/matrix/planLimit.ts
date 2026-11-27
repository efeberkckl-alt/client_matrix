/**
 * 服务端套餐信息的本地镜像,保留同步接口兼容性。
 * 矩阵账号创建和任务执行不使用套餐号数限制。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { coworkLog } from '../coworkLogger';

export interface PlanLimit {
  maxAccountsPerPlatform: number;
  planCode: string;
  subExpireAt: string | null;
  updatedAt: number;
}

const DEFAULT: PlanLimit = { maxAccountsPerPlatform: 9999, planCode: 'free', subExpireAt: null, updatedAt: 0 };

function baseDir(): string {
  return process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
}
function storeFile(): string { return path.join(baseDir(), 'plan-limit.json'); }

let cache: PlanLimit | null = null;

export function getPlanLimit(): PlanLimit {
  if (cache) return cache;
  try {
    const f = storeFile();
    if (fs.existsSync(f)) {
      const obj = JSON.parse(fs.readFileSync(f, 'utf8'));
      if (obj && typeof obj.maxAccountsPerPlatform === 'number' && obj.maxAccountsPerPlatform > 0) {
        cache = { ...DEFAULT, ...obj };
        return cache;
      }
    }
  } catch (e) {
    coworkLog('WARN', 'planLimit', `read failed, using default: ${String(e)}`);
  }
  cache = { ...DEFAULT };
  return cache;
}

export function setPlanLimit(v: Partial<PlanLimit>): PlanLimit {
  const next: PlanLimit = {
    maxAccountsPerPlatform: typeof v.maxAccountsPerPlatform === 'number' && v.maxAccountsPerPlatform > 0 ? v.maxAccountsPerPlatform : DEFAULT.maxAccountsPerPlatform,
    planCode: v.planCode || DEFAULT.planCode,
    subExpireAt: v.subExpireAt ?? null,
    updatedAt: Date.now(),
  };
  cache = next;
  try {
    fs.mkdirSync(baseDir(), { recursive: true });
    const f = storeFile();
    const tmp = `${f}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2), 'utf8');
    fs.renameSync(tmp, f);
  } catch (e) {
    coworkLog('WARN', 'planLimit', `persist failed: ${String(e)}`);
  }
  return next;
}
