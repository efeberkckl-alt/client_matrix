import fs from 'fs';
import path from 'path';

export type ProfileIdentity = { key: string; directory: string; exists: boolean };

/** Resolve existing aliases and pin a directory by filesystem identity. An unused path is only provisional. */
export function identifyProfile(directory: string): ProfileIdentity | undefined {
  if (!directory) return;
  let current = path.resolve(directory);
  const missing: string[] = [];
  for (;;) {
    try {
      const canonical = fs.realpathSync.native(current);
      const stat = fs.statSync(canonical, { bigint: true });
      if (!stat.isDirectory() || stat.ino === 0n) return;
      if (!missing.length) return { key: `dir:${stat.dev}:${stat.ino}:${stat.birthtimeNs}`, directory: canonical, exists: true };
      const target = path.join(canonical, ...missing);
      const comparable = process.platform === 'win32' ? target.toLowerCase() : target;
      return { key: 'absent:' + comparable, directory: target, exists: false };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return;
      // ENOENT from realpath can mean a dangling directory junction. Never treat it as a fresh path.
      try { fs.lstatSync(current); return; }
      catch (check) { if ((check as NodeJS.ErrnoException).code !== 'ENOENT') return; }
      const parent = path.dirname(current);
      if (parent === current) return;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}
