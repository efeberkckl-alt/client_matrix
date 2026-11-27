import path from 'node:path';

// Used by the older in-memory runner tests. The cross-process tests use
// actual child processes and the host filesystem, not this adapter.
export function virtualSafetyFs(files) {
  const dirs = new Set();
  let seq = 0;
  const problem = code => Object.assign(Error(code), { code });
  const key = p => path.normalize(p);
  const under = (entry, dir) => entry.startsWith(dir + path.sep);
  const exists = p => files.has(p) || dirs.has(p);
  return {
    existsSync: p => exists(key(p)),
    mkdirSync(p) { dirs.add(key(p)); },
    mkdtempSync(prefix) { const p = key(prefix + 'mem' + ++seq); dirs.add(p); return p; },
    readFileSync(p) { p = key(p); if (!files.has(p)) throw problem('ENOENT'); return files.get(p); },
    writeFileSync(p, v, opts) {
      p = key(p); if (opts?.flag === 'wx' && exists(p)) throw problem('EEXIST'); files.set(p, v);
    },
    openSync(p) { p = key(p); if (exists(p)) throw problem('EEXIST'); files.set(p, ''); return p; },
    closeSync() {},
    appendFileSync(p, v) { p = key(p); files.set(p, (files.get(p) || '') + v); },
    copyFileSync(from, to) { files.set(key(to), this.readFileSync(from)); },
    readdirSync(p) {
      p = key(p);
      if (!dirs.has(p)) throw problem('ENOENT');
      return [...files.keys(), ...dirs].filter(x => x !== p && path.dirname(x) === p).map(x => path.basename(x));
    },
    unlinkSync(p) { if (!files.delete(key(p))) throw problem('ENOENT'); },
    rmdirSync(p) { p = key(p); if (!dirs.has(p)) throw problem('ENOENT'); if (this.readdirSync(p).length) throw problem('ENOTEMPTY'); dirs.delete(p); },
    renameSync(from, to) {
      from = key(from); to = key(to);
      if (dirs.has(from)) {
        if (exists(to)) throw problem('EEXIST');
        dirs.delete(from);
        dirs.add(to);
        for (const src of [...dirs]) if (under(src, from)) { dirs.delete(src); dirs.add(to + src.slice(from.length)); }
        for (const src of [...files.keys()]) if (under(src, from)) { files.set(to + src.slice(from.length), files.get(src)); files.delete(src); }
      } else {
        if (!files.has(from)) throw problem('ENOENT');
        files.set(to, files.get(from));
        files.delete(from);
      }
    },
  };
}
