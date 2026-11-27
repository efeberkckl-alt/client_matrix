import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import { EventEmitter } from 'node:events';
import { spawnSync } from 'node:child_process';
import ts from 'typescript';

const source = fs.readFileSync(new URL('../src/main/libs/matrix/powerKeepAwake.ts', import.meta.url), 'utf8');
const code = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
function harness(platform = 'win32') {
  const children = [], logs = [], timers = new Map();
  let nextId = 0, spawnError;
  const module = { exports: {} };
  vm.runInNewContext(code, {
    module, exports: module.exports, process: { platform, pid: 123 },
    setTimeout: (fn, ms) => { const id = ++nextId; timers.set(id, { fn, ms }); return id; },
    clearTimeout: (id) => timers.delete(id),
    require: (name) => name === 'child_process' ? { spawn: (command, args, options) => {
      if (spawnError) throw spawnError;
      const child = new EventEmitter();
      Object.assign(child, { command, args, options, kills: 0, stdout: new EventEmitter(), stderr: { resume() {} } });
      child.kill = () => { child.kills++; };
      children.push(child);
      return child;
    } } : { coworkLog: (...args) => logs.push(args) },
  });
  return {
    ...module.exports, children, logs, timers,
    failSpawn: (error) => { spawnError = error; },
    fire(ms) {
      const item = [...timers].find(([, t]) => t.ms === ms);
      assert.ok(item, `timer ${ms} exists`);
      timers.delete(item[0]); item[1].fn();
    },
    ready(child = children.at(-1)) { child.stdout.emit('data', 'NOOBCLAW_POWER_READY\r\n'); },
    ons: () => logs.filter(([, , message]) => message.includes(' ON ')),
  };
}

test('Windows uses unsigned values and logs ON only after a complete success marker', () => {
  const h = harness();
  h.acquireSystemKeepAwake();
  const child = h.children[0], script = child.args.at(-1);
  assert.equal(child.options.windowsHide, true);
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483649\) -eq 0/);
  assert.match(script, /SetThreadExecutionState\(\[uint32\]2147483648\)/);
  assert.doesNotMatch(script, /SetThreadExecutionState\(0x/);
  assert.ok(script.indexOf("throw 'Power assertion failed'") < script.indexOf('NOOBCLAW_POWER_READY'));
  assert.match(script, /Get-Process -Id 123/);
  assert.equal(h.ons().length, 0);
  child.emit('spawn');
  child.stdout.emit('data', 'NOOBCLAW_POWER_');
  assert.equal(h.ons().length, 0);
  child.stdout.emit('data', 'READY\r\n');
  h.ready();
  assert.equal(h.ons().length, 1);
  assert.equal(h.timers.size, 0);
  h.releaseSystemKeepAwake();
  assert.equal(child.kills, 1);
});

test('generated PowerShell binds uint values and emits READY only on success without invoking WinAPI', { skip: process.platform !== 'win32' }, () => {
  const h = harness();
  h.acquireSystemKeepAwake();
  const original = h.children[0].args.at(-1);
  for (const succeeds of [true, false]) {
    // Replace only the native method with pure C#, and disable the long-lived loop.
    const script = original.replace(/\$sig='[^']+';/,
      `$sig='public static uint SetThreadExecutionState(uint flags) { return ${succeeds ? 'flags' : '0u'}; }';`)
      .replace(/while\(Get-Process -Id 123 -ErrorAction SilentlyContinue\)/, 'while($false)');
    assert.doesNotMatch(script, /DllImport|kernel32/);
    assert.match(script, /while\(\$false\)/);
    const result = spawnSync('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8', windowsHide: true, timeout: 15_000 });
    assert.ifError(result.error);
    assert.equal(result.status, succeeds ? 0 : 1, result.stderr);
    assert.equal(result.stdout.includes('NOOBCLAW_POWER_READY'), succeeds);
    if (!succeeds) assert.match(result.stderr, /Power assertion failed/);
  }
  h.releaseSystemKeepAwake();
});

test('owners retain the holder until the last release; old exit/error cannot lose the replacement', () => {
  const h = harness();
  h.acquireSystemKeepAwake(); h.acquireSystemKeepAwake(); h.acquireSystemKeepAwake('scheduler');
  assert.equal(h.children.length, 1);
  const old = h.children[0];
  h.releaseSystemKeepAwake();
  assert.equal(old.kills, 0);
  h.releaseSystemKeepAwake('scheduler');
  assert.equal(old.kills, 1);
  h.acquireSystemKeepAwake('scheduler');
  const current = h.children[1];
  old.emit('exit', 0); old.emit('error', Error('late error')); h.ready(old);
  assert.equal(h.ons().length, 0);
  h.ready(current);
  h.releaseSystemKeepAwake('missing');
  assert.equal(current.kills, 0);
  h.releaseSystemKeepAwake('scheduler');
  assert.equal(current.kills, 1);
  assert.equal(h.timers.size, 0);
});

test('failed holders retry with capped backoff; confirmation resets delay and release cancels retry', () => {
  const h = harness();
  h.acquireSystemKeepAwake();
  for (const delay of [5000, 10000, 20000, 40000, 60000, 60000]) {
    const child = h.children.at(-1);
    child.emit('exit', 1);
    child.emit('error', Error('same failure'));
    assert.equal(h.timers.size, 1);
    const before = h.children.length;
    h.acquireSystemKeepAwake();
    assert.equal(h.children.length, before, 'duplicate acquisition does not bypass backoff');
    h.fire(delay);
  }
  assert.equal(h.ons().length, 0);
  h.ready();
  h.children.at(-1).emit('exit', 1);
  h.fire(5000);
  h.children.at(-1).emit('error', Error('spawn failed'));
  h.releaseSystemKeepAwake();
  assert.equal(h.timers.size, 0);
});

test('startup timeout and synchronous spawn failure recover; macOS and unsupported systems preserve behavior', () => {
  const h = harness();
  h.acquireSystemKeepAwake();
  h.fire(15000);
  assert.equal(h.children[0].kills, 1);
  assert.equal(h.ons().length, 0);
  h.failSpawn(Error('unavailable'));
  h.fire(5000);
  h.failSpawn(undefined);
  h.fire(10000);
  h.ready();
  assert.equal(h.ons().length, 1);
  h.releaseSystemKeepAwake();
  const mac = harness('darwin');
  mac.acquireSystemKeepAwake();
  assert.equal(mac.children[0].command, 'caffeinate');
  assert.equal(mac.children[0].args.join(' '), '-i -w 123');
  assert.equal(mac.ons().length, 0);
  mac.children[0].emit('spawn');
  assert.equal(mac.ons().length, 1);
  assert.equal(mac.timers.size, 0);
  mac.releaseSystemKeepAwake();
  const linux = harness('linux');
  linux.acquireSystemKeepAwake(); linux.releaseSystemKeepAwake();
  assert.equal(linux.children.length, 0);
  assert.equal(linux.timers.size, 0);
});
