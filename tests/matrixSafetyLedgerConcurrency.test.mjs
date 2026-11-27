import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require = createRequire(import.meta.url);
const code = ts.transpileModule(fs.readFileSync(new URL('../src/main/libs/matrix/automationSafety.ts', import.meta.url),'utf8'),
  {compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
function runtime(adapter = fs) {
  const m = { exports: {} };
  new Function('require','module','exports',code)(n => n === 'fs' ? adapter : require(n),m,m.exports);
  return m.exports;
}
const names = { account:'account:reviewed', local:'group:local:unknown', preserve:'group:existing' };
const writeJSON = (file,obj) => fs.writeFileSync(file, JSON.stringify(obj, null, 2));
const readJSON = file => JSON.parse(fs.readFileSync(file,'utf8'));
const setup = t => {
  const root=fs.mkdtempSync(path.join(process.env.NOOBCLAW_MATRIX_DIR,'ledger-cross-'));
  const file=path.join(root,'automation-safety.json');
  const old={until:Date.now()+3_600_000,reason:'fixture 403',code:'forbidden'};
  const group={until:Date.now()+7_200_000,reason:'strong prior hold'};
  writeJSON(file,{formatVersion:1,importAcks:[],pauses:{[names.account]:old,[names.preserve]:group}});
  return { file, old, group, root };
};
const ownProcess = (...args) => spawnSync(process.execPath,
  ['--require',fileURLToPath(new URL('../../evidence/offline.cjs',import.meta.url)),fileURLToPath(import.meta.url),...args],
  {env:process.env,encoding:'utf8',windowsHide:true,timeout:8500});
function child(...args) {
  const out=ownProcess(...args);
  assert.equal(out.status,0,out.error?.message || out.stderr);
  return JSON.parse(out.stdout);
}
function forChild(file) {
  const root=path.resolve(process.env.NOOBCLAW_MATRIX_DIR);
  assert.ok(path.resolve(file).startsWith(root+path.sep));
  assert.equal(path.basename(file),'automation-safety.json');
}
function formGroup(app, file, group) {
  const s=new app.AutomationSafety(file);
  for (const id of ['ordinary-b','ordinary-c']) {
    s.begin(id,id,group,()=>{});
    s.halt(id,'rate_limited',120000);
    s.end(id);
  }
}
if (process.argv[2]==='--protect') {
  const [, , , file, group]=process.argv;
  forChild(file);
  formGroup(runtime(),file,group);
  const pause=readJSON(file).pauses['group:'+group];
  assert.ok(pause.until>Date.now());
  console.log(JSON.stringify({pid:process.pid,pause}));
  process.exit(0);
}
if (process.argv[2]==='--exit-while-owning') {
  const file=process.argv[3];
  forChild(file);
  runtime().withSafetyLedgerWriter(file,'exclusive',() => process.exit(71));
}
if (process.argv[2]==='--exit-in-gate') {
  const file=process.argv[3];
  forChild(file);
  const fsView={...fs,renameSync(from,to){
    fs.renameSync(from,to);
    if (to===file+'.writer-gate') process.exit(72);
  }};
  runtime(fsView).withSafetyLedgerWriter(file,'exclusive',()=>{});
  process.exit(1);
}

test('F1-02B ordinary cross-process protection fences an unpublished review without losing the latest disk state', t => {
  const a=setup(t);
  let competing;
  const fsView={...fs,renameSync(from,to) {
    if (to===a.file && !competing) {
      assert.ok(fs.existsSync(a.file+'.writer'));
      const pointer=readJSON(a.file+'.writer');
      assert.equal(pointer.kind,'review');
      assert.equal(pointer.pid,process.pid);
      competing=child('--protect',a.file,'local:unknown');
      assert.notEqual(competing.pid,process.pid);
      assert.deepEqual(readJSON(a.file).pauses[names.local],competing.pause);
      assert.ok(!fs.existsSync(from),'the old prepared source was fenced before the other writer published');
    }
    return fs.renameSync(from,to);
  }};
  const {AutomationSafety}=runtime(fsView), s=new AutomationSafety(a.file);
  assert.throws(()=>s.clearReviewedForbidden('reviewed',['reviewed'],fs.readFileSync(a.file,'utf8')),/暂停记录已变化/);
  assert.deepEqual(readJSON(a.file).pauses[names.local],competing.pause);
  assert.deepEqual(readJSON(a.file).pauses[names.account],a.old,'aborted review never changes its own protection either');
  assert.equal(fs.existsSync(a.file+'.writer'),false);
  assert.equal(fs.existsSync(a.file+'.writer-gate'),false);
});

test('F1-02B write after replacement is observed, rollback merges just deleted 403 keys under the same writer protocol', t => {
  const a=setup(t);
  const {AutomationSafety}=runtime(), s=new AutomationSafety(a.file);
  const receipt=s.clearReviewedForbidden('reviewed',['reviewed'],fs.readFileSync(a.file,'utf8'));
  assert.equal(readJSON(a.file).pauses[names.account],undefined);
  const competing=child('--protect',a.file,'local:unknown');
  let accountWrite=false;
  assert.throws(()=>receipt.holdForAccountCommit(()=>{accountWrite=true;}), /暂停记录已变化/);
  assert.equal(accountWrite,false);
  receipt.rollback();
  const {pauses}=readJSON(a.file);
  assert.deepEqual(pauses[names.account],a.old);
  assert.deepEqual(pauses[names.local],competing.pause);
  assert.deepEqual(pauses[names.preserve],a.group);
  const view=s.accountAndGroupPauses(['reviewed'],['local:unknown']);
  assert.equal(view.groupUntil,competing.pause.until);
  assert.equal(view.account.code,'forbidden');
});

test('F1-02B a protection writer with stale memory merges fresh disk and does not shorten prior group protection', t => {
  const a=setup(t);
  const {AutomationSafety}=runtime(), stale=new AutomationSafety(a.file);
  stale.begin('cached-a','cached-a','next',()=>{});
  stale.begin('cached-b','cached-b','next',()=>{});
  const competing=child('--protect',a.file,'local:unknown');
  stale.halt('cached-a','rate_limited',120000);
  stale.halt('cached-b','rate_limited',120000);
  let {pauses}=readJSON(a.file);
  assert.deepEqual(pauses[names.local],competing.pause);
  assert.deepEqual(pauses[names.preserve],a.group);
  assert.ok(pauses['group:next'].until>Date.now());
  const {withSafetyLedgerWriter}=runtime();
  stale.begin('older-a','older-a','longer',()=>{});
  stale.begin('older-b','older-b','longer',()=>{});
  withSafetyLedgerWriter(a.file,'exclusive',writer=>{
    const latest=writer.read();
    latest.pauses['group:longer']={until:Date.now()+12*3_600_000,reason:'fixture high deadline'};
    writer.replace(latest,JSON.stringify({...latest.envelope,pauses:latest.pauses},null,2));
  });
  const longer=readJSON(a.file).pauses['group:longer'].until;
  stale.halt('older-a','rate_limited',120000);
  stale.halt('older-b','rate_limited',120000);
  assert.equal(readJSON(a.file).pauses['group:longer'].until,longer);
  assert.equal(stale.accountAndGroupPauses([],['longer']).groupUntil,longer);
});

for (const [arg,exitCode] of [['--exit-while-owning',71],['--exit-in-gate',72]]) {
  test('F1-02B actual dead-process ' + arg + ' is recovered without deleting an unrelated hold', t => {
    const a=setup(t);
    const dead=ownProcess(arg,a.file);
    assert.equal(dead.status,exitCode,dead.error?.message || dead.stderr);
    assert.ok(fs.existsSync(a.file + (exitCode===71 ? '.writer' : '.writer-gate')));
    const writer=child('--protect',a.file,'local:unknown');
    const {pauses}=readJSON(a.file);
    assert.deepEqual(pauses[names.local],writer.pause);
    assert.deepEqual(pauses[names.account],a.old);
    assert.deepEqual(pauses[names.preserve],a.group);
    assert.equal(fs.existsSync(a.file+'.writer'),false);
    assert.equal(fs.existsSync(a.file+'.writer-gate'),false);
  });
}


test('a protective stop is still applied in memory and reported if an exclusive final writer cannot be entered', t => {
  const a=setup(t);
  const app=runtime(), safety=new app.AutomationSafety(a.file);
  const messages=[];
  safety.begin('target','target','separate',text=>messages.push(text));
  const original=fs.readFileSync(a.file,'utf8');
  app.withSafetyLedgerWriter(a.file,'exclusive',()=>{
    assert.throws(()=>safety.halt('target','forbidden'),/暂停记录暂不可更新/);
  });
  assert.equal(safety.signal('target').aborted,true);
  assert.equal(safety.accountPause('target').code,'forbidden');
  assert.match(messages.at(-1),/平台拒绝访问/);
  assert.equal(fs.readFileSync(a.file,'utf8'),original);
});
