/**
 * youtubeDownloadRunner — 「YouTube 无水印下载」独立任务(matrix type='video_download' + platform='youtube')。
 *
 * 与其它平台的视频下载不同:不开指纹内核、不要账号、不走服务端剧本 —— 复用翻译搬运那条
 * yt-dlp 腿(服务端下发二进制 + --ffmpeg-location 合流 + 系统代理探测),逐条下载到
 * <matrixDir>/downloads/youtube/。请求/下载有等待,403/429/验证提示停止,不换播放端绕行。回调签名对齐 EngageReport,
 * sidecar 的进度聚合/运行记录闭包零改动复用(item.accountId 恒 'local')。
 *
 * 计费:与其它平台视频下载同口径 —— 每成功一条 POST /api/charge/action(video_download/youtube),
 * 失败静默不阻塞(后端未配该类型则不收,行为同 orchestrator 里的 chargeAction)。
 */

import fs from 'fs';
import os from 'os';
import path from 'path';
import { spawn } from 'child_process';
import { coworkLog } from '../coworkLogger';
import { getYtdlpPath, detectSystemProxy } from '../video/ytdlpRuntime';
import { getFfmpegPath } from '../video/ffmpegRuntime';
import { getVideoConfig } from '../video/videoConfig';
import { getNoobClawAuthToken } from '../claudeSettings';
import type { EngageItemResult, EngageReport } from './engageRunner';
import { automationSafety } from './automationSafety';
import { getLocalEgressIp } from './accountManager';

const DEFAULT_BASE_URL = 'https://api.noobclaw.com';
function baseUrl(): string { return process.env.NOOBCLAW_API_BASE_URL || DEFAULT_BASE_URL; }

export interface YoutubeDownloadTaskOptions {
  taskId: string;
  urls: string[];
  signal?: AbortSignal;
  onLog?: (accountId: string, msg: string) => void;
  onItem?: (item: EngageItemResult) => void;
}

// 2026-08-29 计费加固:带失败原因返回,调用方重试/熔断(文件都给用户了,扣费挂了绝不能静默白送)。
async function chargeOne(): Promise<{ ok: boolean; credits: number; usd: number; reason?: string }> {
  try {
    const token = getNoobClawAuthToken();
    if (!token) return { ok: false, credits: 0, usd: 0, reason: 'auth_missing' };
    const resp = await fetch(`${baseUrl()}/api/charge/action`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action_type: 'video_download', platform: 'youtube' }),
    });
    const j: any = await resp.json().catch(() => ({}));
    if (resp.ok && j?.ok) return { ok: true, credits: Number(j.charged) || 0, usd: Number(j.charged_usd) || 0 };
    return { ok: false, credits: 0, usd: 0, reason: String(j?.error || `http_${resp.status}`) };
  } catch { return { ok: false, credits: 0, usd: 0, reason: 'network_error' }; }
}

export async function runYoutubeDownloadTask(opts: YoutubeDownloadTaskOptions): Promise<EngageReport> {
  const ACC = 'local'; // 无账号任务:进度聚合用固定 id
  const log = (m: string) => { try { opts.onLog?.(ACC, m); } catch { /* ignore */ } };
  const counts = { like: 0, follow: 0, comment: 0, download: 0 };
  let chargedCredits = 0, chargedUsd = 0;
  const emit = (state: EngageItemResult['state'], reason?: string) => {
    try { opts.onItem?.({ accountId: ACC, state, reason, counts: { ...counts }, chargedCredits, chargedUsd } as EngageItemResult); } catch { /* ignore */ }
  };

  const urls = (opts.urls || []).map((u) => String(u || '').trim()).filter((u) => /^https?:\/\//i.test(u));
  if (urls.length === 0) {
    log('❌ 没有可下载的链接');
    emit('failed', 'no_urls');
    return { platform: 'youtube', total: 0, success: 0, failed: 1, skipped: 0, items: [{ accountId: ACC, state: 'failed', reason: 'no_urls', counts }] };
  }

  log('⬇️ 正在准备下载器(yt-dlp,首次约 35MB)…');
  const vcfg: any = await getVideoConfig().catch((): null => null);
  const ytdlpUrl = process.platform === 'win32' ? vcfg?.threadYtdlpUrlWin : vcfg?.threadYtdlpUrlMac;
  const ytdlp = await getYtdlpPath(ytdlpUrl, (m): void => log(m));
  if (!ytdlp) {
    log('❌ 下载器(yt-dlp)不可用,请检查网络后重试');
    emit('failed', 'ytdlp_unavailable');
    return { platform: 'youtube', total: urls.length, success: 0, failed: 1, skipped: 0, items: [{ accountId: ACC, state: 'failed', reason: 'ytdlp_unavailable', counts }] };
  }

  const base = process.env.NOOBCLAW_MATRIX_DIR || path.join(os.homedir(), 'NoobClaw', 'matrix');
  const outDir = path.join(base, 'downloads', 'youtube');
  fs.mkdirSync(outDir, { recursive: true });
  const proxy = process.env.HTTPS_PROXY || process.env.https_proxy || detectSystemProxy();
  const fmt = (typeof vcfg?.repostYtdlpFormat === 'string' && vcfg.repostYtdlpFormat.trim()) ? vcfg.repostYtdlpFormat.trim() : 'bv*+ba/b';
  const scope = 'youtube-download:local';
  let group = `local:${getLocalEgressIp() || 'unknown'}`;
  if (proxy) { try { const p = new URL(proxy); group = `proxy:${p.protocol.replace(':', '')}:${p.hostname}:${p.port}`; } catch { group = 'download-proxy:unknown'; } }
  automationSafety.begin(scope, scope, group, log);
  const stopWait = () => automationSafety.end(scope);
  opts.signal?.addEventListener('abort', stopWait, { once: true });

  const runYtdlp = (args: string[]): Promise<{ ok: boolean; err: string }> => new Promise((resolve) => {
    const child = spawn(ytdlp, args, { windowsHide: true });
    let err = '';
    child.stderr?.on('data', (d) => {
      err += String(d);
      if (/HTTP (?:Error|error) (403|429)|too many requests|sign in to confirm.*not a bot|captcha/i.test(err)) {
        try { automationSafety.halt(scope, /429|too many/i.test(err) ? 'rate_limited' : /captcha|not a bot/i.test(err) ? 'captcha' : 'forbidden'); }
        catch (e) { log(String(e)); }
        try { child.kill('SIGKILL'); } catch { /* already exited */ }
      }
    });
    const abort = () => { try { child.kill('SIGKILL'); } catch { /* ignore */ } resolve({ ok: false, err: 'aborted' }); };
    const cleanup = () => opts.signal?.removeEventListener('abort', abort);
    child.on('error', (e) => { cleanup(); resolve({ ok: false, err: String(e) }); });
    child.on('close', (code) => { cleanup(); resolve({ ok: code === 0, err }); });
    opts.signal?.addEventListener('abort', abort, { once: true });
  });

  let okCount = 0;
  let stopReason: string | undefined;
  try {
  for (let i = 0; i < urls.length; i++) {
    if (opts.signal?.aborted) { log('⏹ 已停止'); break; }
    try { await automationSafety.before(scope, 'navigate'); }
    catch (e) { stopReason = opts.signal?.aborted ? 'aborted' : String(e); log(stopReason); break; }
    const url = urls[i];
    log(`⬇️ [${i + 1}/${urls.length}] 下载:${url.slice(0, 80)}`);
    const outTpl = path.join(outDir, '%(title).80s_%(id)s.%(ext)s');
    const baseArgs = ['-f', fmt, '--no-playlist', '--retries', '0', '--fragment-retries', '0', '--concurrent-fragments', '1', '--sleep-requests', '3', '--sleep-interval', '10', '--max-sleep-interval', '20', '--no-progress', '--merge-output-format', 'mp4', '-o', outTpl, url];
    try { const ff = getFfmpegPath(); if (ff && ff !== 'ffmpeg') baseArgs.push('--ffmpeg-location', ff); } catch { /* PATH 上有就不传 */ }
    if (proxy) baseArgs.push('--proxy', proxy);

    const r = await runYtdlp(baseArgs);
    if (automationSafety.blocked(scope)) { stopReason = 'platform_restricted'; emit('failed', stopReason); break; }
    if (r.ok) {
      okCount++;
      counts.download = okCount; // 完成维度 = 下载条数
      let c = await chargeOne();
      for (let ci = 1; ci < 4 && !c.ok && !/insufficient|余额/i.test(String(c.reason || '')); ci++) { await new Promise((rs) => setTimeout(rs, 3000 * ci)); c = await chargeOne(); }
      chargedCredits += c.credits; chargedUsd += c.usd;
      if (!c.ok) {
        const why = String(c.reason || 'unknown');
        log(/insufficient|余额/i.test(why) ? '⛔ 任务已暂停,请充值后继续' : '⛔ 任务已停止,请稍后重试');
        emit('failed', 'charge_failed:' + why);
        coworkLog('WARN', 'ytdl', `charge failed: ${why}`);
        break;
      }
      log(`   ✅ 第 ${i + 1} 条下载完成 → ${outDir}`);
      emit('success');
    } else {
      if (r.err && r.err !== 'aborted') log(`   ❌ 第 ${i + 1} 条失败:${r.err.slice(-160)}`);
      emit(okCount > 0 ? 'success' : 'failed', 'download_failed');
    }
  }

  const state: EngageItemResult['state'] = stopReason ? 'failed' : okCount > 0 ? 'success' : 'failed';
  log(stopReason ? `⏸ 已停止，已完成 ${okCount}/${urls.length} 条：${stopReason}` : okCount > 0 ? `🎉 完成:${okCount}/${urls.length} 条已保存到 ${outDir}` : '❌ 全部下载失败');
  emit(state, stopReason || (okCount > 0 ? undefined : 'all_failed'));
  coworkLog('INFO', 'ytdl', `youtube download task ${opts.taskId}: ${okCount}/${urls.length}`);
  return { platform: 'youtube', total: urls.length, success: okCount, failed: urls.length - okCount, skipped: 0, items: [{ accountId: ACC, state, reason: stopReason, counts, chargedCredits, chargedUsd }] };
  } finally {
    opts.signal?.removeEventListener('abort', stopWait);
    automationSafety.end(scope);
  }
}
