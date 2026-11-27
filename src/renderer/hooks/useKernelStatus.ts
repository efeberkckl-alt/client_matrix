import { useCallback, useEffect, useRef, useState } from 'react';

export type KernelVersion = { version: string; label: string; recommended: boolean; installed: boolean; sizeMb: number; note: string };
export type KernelState = {
  installed?: boolean; installedVersion?: string; installedVersions?: string[];
  configuredVersion?: string; selectedVersion?: string; needsUpdate?: boolean;
  available?: KernelVersion[]; local?: boolean; listError?: string;
};

/** Local installations stay visible even if the catalog is unavailable. Local reads cannot erase the catalog. */
export function mergeKernelStatus(previous: KernelState, incoming: KernelState): KernelState {
  const installed = incoming.installedVersions || previous.installedVersions || [];
  const catalog = incoming.local ? previous.available || [] : incoming.available || [];
  const available = catalog.map((entry) => ({ ...entry, installed: installed.includes(entry.version) }));
  for (const version of installed) {
    if (!available.some((entry) => entry.version === version)) available.push({ version, label: `Chrome v${version}`, recommended: false, installed: true, sizeMb: 0, note: '' });
  }
  return { ...previous, ...incoming, installed: installed.length > 0, installedVersions: installed, available };
}

function timedReply(call: (() => Promise<any>) | undefined, signal: AbortSignal, timeout: number): Promise<KernelState> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error('cancelled'));
    const cleanup = () => { clearTimeout(timer); signal.removeEventListener('abort', abort); };
    const abort = () => { cleanup(); reject(new Error('cancelled')); };
    const timer = setTimeout(() => { cleanup(); reject(new Error('读取内核状态超时，请重试')); }, timeout);
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve().then(() => call?.()).then((reply) => {
      cleanup();
      if (!reply || reply.ok === false || !Array.isArray(reply.installedVersions)) reject(new Error('无法连接本地后台，正在等待后台就绪'));
      else resolve(reply);
    }, () => { cleanup(); reject(new Error('无法连接本地后台，请重试')); });
  });
}

/** Both pickers share bounded startup retries; abort also cancels pending waits on unmount. */
export async function loadKernelStatus(matrix: any, update: (data: { kernel?: KernelState; loading: boolean; error: string }) => void, signal: AbortSignal): Promise<void> {
  let error = '';
  update({ loading: true, error });
  for (let attempt = 0; attempt < 3 && !signal.aborted; attempt++) {
    try {
      try {
        const local = await timedReply(matrix?.kernelLocalStatus?.bind(matrix), signal, 3000);
        if (!signal.aborted) update({ kernel: { ...local, local: true }, loading: true, error });
      } catch { if (signal.aborted) return; }
      const full = await timedReply(matrix?.kernelStatus?.bind(matrix), signal, 12000);
      if (signal.aborted) return;
      update({ kernel: full, loading: true, error: full.listError || '' });
      if (full.listError) throw new Error(full.listError);
      update({ loading: false, error: '' });
      return;
    } catch (failure) {
      if (signal.aborted) return;
      error = failure instanceof Error ? failure.message : '读取内核版本失败，请重试';
      update({ loading: attempt < 2, error });
      if (attempt < 2) {
        await new Promise<void>((resolve) => {
          const finish = () => { clearTimeout(timer); signal.removeEventListener('abort', finish); resolve(); };
          const timer = setTimeout(finish, (attempt + 1) * 1500);
          signal.addEventListener('abort', finish, { once: true });
        });
      }
    }
  }
}

export function useKernelStatus() {
  const [kernel, setKernel] = useState<KernelState>({});
  const [selectedVersion, setSelectedVersion] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const active = useRef<AbortController | null>(null);
  const queued = useRef(false);
  const loadKernel = useCallback((): void => {
    if (active.current && !active.current.signal.aborted) { queued.current = true; return; }
    const controller = new AbortController();
    active.current = controller;
    void loadKernelStatus((window as any).electron?.matrix, (state) => {
      if (controller.signal.aborted) return;
      if (state.kernel) {
        const data = state.kernel;
        setKernel((previous) => mergeKernelStatus(previous, data));
        setSelectedVersion((previous) => previous || data.selectedVersion || data.installedVersion || data.configuredVersion || '');
      }
      setLoading(state.loading);
      setError(state.error);
    }, controller.signal).finally(() => {
      if (active.current !== controller) return;
      active.current = null;
      if (queued.current) { queued.current = false; loadKernel(); }
    });
  }, []);
  useEffect(() => {
    window.addEventListener('noobclaw:backend-ready', loadKernel);
    loadKernel();
    return () => { window.removeEventListener('noobclaw:backend-ready', loadKernel); queued.current = false; active.current?.abort(); };
  }, [loadKernel]);
  return { kernel, selectedVersion, setSelectedVersion, loadKernel, loading, error };
}
