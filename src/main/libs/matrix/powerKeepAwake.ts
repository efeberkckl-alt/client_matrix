/**
 * 系统级「防休眠」—— 对齐旧客户端 chrome-extension 的 chrome.power.requestKeepAwake('system')
 * 与 scenarioManager 的 powerSaveBlocker('prevent-app-suspension')。
 *
 * 为什么不复用那两份:矩阵指纹内核是独立 fingerprint-chromium 进程、纯 CDP 控,既不走
 * chrome-extension(用不到 chrome.power),Electron 的 powerSaveBlocker 在 Tauri 出货里也基本是死的。
 * 所以照搬【语义】换实现:只防【系统空闲休眠】、不防屏幕变暗(省电,跟 'system' 一致)。
 *
 * 实现:跨平台靠一个【长驻子进程】持有保活断言(断言随持有它的线程/进程退出而自动解除,
 * 故必须长驻,不能一次性调用)。kernelPool 在【有内核存活】时 acquire、【全部关闭】后 release。
 *   · Windows:powershell P/Invoke SetThreadExecutionState(ES_CONTINUOUS|ES_SYSTEM_REQUIRED);
 *   · macOS:caffeinate -i(防空闲休眠、屏幕可灭) -w <pid>(本进程退出即自动解除,防孤儿);
 *   · Linux:不处理(矩阵目标平台 win/mac)。
 *
 * 边界(跟旧客户端注释一致,这些挡不住):用户显式点「睡眠」、合盖、电量极低 —— 都是硬件/用户驱动。
 */

import { spawn, type ChildProcess } from 'child_process';
import { coworkLog } from '../coworkLogger';

let holder: ChildProcess | null = null;
const owners = new Set<string>();
let startupTimer: ReturnType<typeof setTimeout> | null = null;
let retryTimer: ReturnType<typeof setTimeout> | null = null;
let retryMs = 5000;

function retryHolder(): void {
  if (!owners.size || retryTimer) return;
  retryTimer = setTimeout(() => { retryTimer = null; startHolder(); }, retryMs);
  retryMs = Math.min(retryMs * 2, 60_000);
}

function startHolder(): void {
  if (!owners.size || holder) return;
  try {
    let child: ChildProcess;
    if (process.platform === 'darwin') {
      // -i 防系统空闲休眠(不防屏幕灭);-w 本 sidecar 进程退出即自动解除(双保险防孤儿)。
      child = spawn('caffeinate', ['-i', '-w', String(process.pid)], { stdio: 'ignore', windowsHide: true });
    } else if (process.platform === 'win32') {
      // ES_CONTINUOUS(0x80000000)|ES_SYSTEM_REQUIRED(0x00000001)=防系统休眠、屏幕可灭。
      // assertion 随设置它的线程退出而解除 → ps 必须长驻:设置后无限循环(顺带每 30s 复设兜底),
      // 被 kill 时 finally 用单独 ES_CONTINUOUS 复位(即便被强杀,线程死亡也会自动解除)。
      const ps = [
        "$ErrorActionPreference='Stop';",
        "$sig='[DllImport(\"kernel32.dll\")] public static extern uint SetThreadExecutionState(uint esFlags);';",
        '$t=Add-Type -MemberDefinition $sig -Name Power -Namespace Win32 -PassThru;',
        // PowerShell treats 0x80000001 as negative Int32; decimal converts safely to uint.
        "try { if($t::SetThreadExecutionState([uint32]2147483649) -eq 0){ throw 'Power assertion failed' };",
        "Write-Output 'NOOBCLAW_POWER_READY';",
        `while(Get-Process -Id ${process.pid} -ErrorAction SilentlyContinue){ Start-Sleep -Seconds 30; if($t::SetThreadExecutionState([uint32]2147483649) -eq 0){ throw 'Power assertion failed' } } }`,
        'finally { $t::SetThreadExecutionState([uint32]2147483648) | Out-Null }',
      ].join(' ');
      child = spawn('powershell', ['-NoProfile', '-NonInteractive', '-Command', ps], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } else {
      return;
    }
    holder = child;
    let confirmed = false;
    const ready = () => {
      if (holder !== child || confirmed) return;
      confirmed = true;
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      retryMs = 5000;
      coworkLog('INFO', 'powerKeepAwake', `系统防休眠 ON (${process.platform})`);
    };
    const failed = (reason: string) => {
      if (holder !== child) return; // An old child's delayed exit must not clear its replacement.
      holder = null;
      if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
      try { child.kill(); } catch { /* ignore */ }
      coworkLog('WARN', 'powerKeepAwake', `系统防休眠失效，等待重试: ${reason}`);
      retryHolder();
    };
    child.on('error', (e) => failed(e.message));
    child.on('exit', (code) => failed(`holder exited (${code})`));
    if (process.platform === 'win32') {
      let output = '';
      child.stdout?.on('data', (chunk) => {
        output = (output + String(chunk)).slice(-1000);
        if (output.split(/\r?\n/).includes('NOOBCLAW_POWER_READY')) ready();
      });
      child.stderr?.resume(); // Drain errors; exit/timeout is reported without unbounded buffering.
    } else child.once('spawn', ready);
    startupTimer = setTimeout(() => failed('startup confirmation timeout'), 15_000);
  } catch (e: any) {
    coworkLog('WARN', 'powerKeepAwake', 'acquire failed: ' + String(e?.message || e));
    retryHolder();
  }
}

/** 每个 owner 幂等持有;默认 owner 保持已有 kernel 调用兼容。 */
export function acquireSystemKeepAwake(owner = 'kernel'): void {
  if (process.platform !== 'win32' && process.platform !== 'darwin') return;
  owners.add(owner);
  if (!retryTimer) startHolder();
}

/** 最后一个 owner 释放时才关闭保活,调度等待可用独立 owner。 */
export function releaseSystemKeepAwake(owner = 'kernel'): void {
  if (!owners.delete(owner) || owners.size) return;
  if (retryTimer) { clearTimeout(retryTimer); retryTimer = null; }
  if (startupTimer) { clearTimeout(startupTimer); startupTimer = null; }
  retryMs = 5000;
  const child = holder;
  holder = null;
  try { child?.kill(); } catch { /* ignore */ }
  coworkLog('INFO', 'powerKeepAwake', '系统防休眠 OFF');
}
