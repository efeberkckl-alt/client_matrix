import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import test from 'node:test';
import ts from 'typescript';

const require=createRequire(import.meta.url);
const folder=new URL('../src/main/libs/matrix/',import.meta.url);
const load=(name,adapter=fs)=>{
  const raw=fs.readFileSync(new URL(name+'.ts',folder),'utf8');
  const js=ts.transpileModule(raw,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
  const m={exports:{}};
  new Function('require','module','exports',js)(spec=>spec==='fs'?adapter:require(spec),m,m.exports);
  return m.exports;
};
const a='review-a', b='bound-b', aKey='account:'+a, bKey='account:tiktok:b';
const json=file=>JSON.parse(fs.readFileSync(file,'utf8'));
const dump=(file,body)=>fs.writeFileSync(file,JSON.stringify(body,null,2));
const now=Date.now;
function setup(){
  const dir=fs.mkdtempSync(path.join(process.env.NOOBCLAW_MATRIX_DIR,'single-stop-'));
  const file=path.join(dir,'automation-safety.json');
  const store=path.join(dir,'accounts.json');
  const row=(id,uid)=>({id,platform:'tiktok',boundUid:uid,status:'idle',
    authority:{incarnation:id,epoch:'0',revision:'0',verified:true,constraints:[]}});
  dump(store,{formatVersion:1,storeId:'round-3',storeRevision:'0',accounts:[row(a,'a'),row(b,'b'),row('bound-c','c')],archivedSubjects:{},importReceipts:{},dispatchRecords:{}});
  dump(file,{formatVersion:1,importAcks:[],pauses:{}});
  return {dir,file,store,accountLock:path.join(dir,'accounts.writer')};
}
function launch(...args){
  const run=spawnSync(process.execPath,['--require',fileURLToPath(new URL('../../evidence/offline.cjs',import.meta.url)),
    fileURLToPath(import.meta.url),...args],{env:process.env,encoding:'utf8',windowsHide:true,timeout:10000});
  assert.equal(run.status,0,run.stderr || run.error?.message);
  return JSON.parse(run.stdout);
}
const scope=dir=>{
  const root=path.resolve(process.env.NOOBCLAW_MATRIX_DIR);
  assert.ok(path.resolve(dir).startsWith(root+path.sep));
};
function view(dir,clock){
  const {AutomationSafety}=load('automationSafety');
  const {legacyPausePlan,availabilityOf}=load('accountProtection');
  const file=path.join(dir,'automation-safety.json');
  const state=json(path.join(dir,'accounts.json'));
  const snapshot=fs.readFileSync(file,'utf8');
  legacyPausePlan(state,snapshot);
  const selected=state.accounts.find(row=>row.id===b);
  const current=new AutomationSafety(file,()=>clock).accountAndGroupPauses([b,'tiktok:b'],[],clock);
  return availabilityOf(selected,clock,current.groupUntil,false,false,false,current.accountPauses);
}
if(process.argv[2]==='--write-and-exit'){
  const d=process.argv[3];scope(d);
  const file=path.join(d,'automation-safety.json'), writer=path.join(d,'accounts.writer');
  const {AutomationSafety}=load('automationSafety');
  const safety=new AutomationSafety(file);
  let callback=false;
  const uid=process.argv[5]||'b', id='bound-'+uid, key='account:tiktok:'+uid;
  assert.ok(['b','c'].includes(uid));
  safety.begin(id,'tiktok:'+uid,'fixture',()=>{
    callback=true;
    assert.ok(!fs.existsSync(file+'.writer'));
    assert.equal(json(file).pauses[key].code,'rate_limited');
    assert.throws(()=>fs.openSync(writer,'wx'),{code:'EEXIST'});
  });
  safety.halt(id,'rate_limited',Number(process.argv[4]));
  console.log(JSON.stringify({pid:process.pid,callback,aborted:safety.signal(id).aborted,entry:json(file).pauses[key]}));
  process.exit(0);
}
if(process.argv[2]==='--read'){
  const d=process.argv[3];scope(d);
  console.log(JSON.stringify({pid:process.pid,view:view(d,Number(process.argv[4]))}));
  process.exit(0);
}

test('managed ordinary 429 is durable before the callback even during accounts.writer contention and expires naturally after restart',()=>{
  const f=setup();
  fs.writeFileSync(f.accountLock,String(process.pid),{flag:'wx'});
  const oldStore=fs.readFileSync(f.store,'utf8');
  const written=launch('--write-and-exit',f.dir,'7200000');
  assert.equal(written.callback,true);
  assert.equal(written.aborted,true);
  assert.equal(written.entry.runtime,true);
  assert.equal(fs.readFileSync(f.store,'utf8'),oldStore);
  const reopened=launch('--read',f.dir,String(now()));
  assert.notEqual(reopened.pid,written.pid);
  assert.equal(reopened.view.available,false);
  assert.equal(reopened.view.status,'limited');
  assert.deepEqual(reopened.view.reasons,['rate_limited']);
  assert.equal(reopened.view.retryAt,written.entry.until);
  const expired=launch('--read',f.dir,String(written.entry.until+1)).view;
  assert.equal(expired.available,true);
  assert.equal(expired.status,'idle');
  assert.deepEqual(expired.reasons,[]);
});

test('ordinary pause before review survives, and a second process after stage does not lose its longer pause to rollback',()=>{
  const f=setup(), lock=String(process.pid);
  fs.writeFileSync(f.accountLock,lock,{flag:'wx'});
  const a403={until:now()+3_600_000,code:'forbidden',reason:'fixture 403'};
  const seed=json(f.file);seed.pauses[aKey]=a403;dump(f.file,seed);
  const first=launch('--write-and-exit',f.dir,'7200000').entry;
  const s=new (load('automationSafety').AutomationSafety)(f.file);
  const receipt=s.clearReviewedForbidden(a,[a],fs.readFileSync(f.file,'utf8'));
  assert.deepEqual(json(f.file).pauses[bKey],first);
  const second=launch('--write-and-exit',f.dir,'10800000','c').entry;
  assert.ok(second.until>first.until);
  assert.throws(()=>receipt.holdForAccountCommit(()=>assert.fail('405 fixture must not commit')));
  receipt.rollback();
  assert.deepEqual(json(f.file).pauses,{[aKey]:a403,[bKey]:first,'account:tiktok:c':second});
  assert.equal(launch('--read',f.dir,String(now())).view.available,false);
});

test('new 429 and older 403 on the same identity keep separate deadlines and review clears only 403',()=>{
  const f=setup(), {AutomationSafety}=load('automationSafety');
  const stoppedAt=now();
  const first=new AutomationSafety(f.file,()=>stoppedAt);
  const second=new AutomationSafety(f.file,()=>stoppedAt+1000);
  const third=new AutomationSafety(f.file,()=>stoppedAt+1500);
  for(const x of [first,second,third]) x.begin(b,'tiktok:b','own-scope',()=>{});
  first.halt(b,'forbidden',7200000);
  const hard=json(f.file).pauses[bKey];
  second.halt(b,'rate_limited',150000);
  const pair=json(f.file).pauses[bKey];
  assert.equal(pair.code,'forbidden');
  assert.equal(pair.until,hard.until);
  assert.equal(pair.other[0].code,'rate_limited');
  assert.ok(pair.other[0].until<hard.until);
  third.halt(b,'rate_limited',1);
  assert.deepEqual(json(f.file).pauses[bKey],pair);
  const review=new AutomationSafety(f.file,()=>stoppedAt+2000);
  const receipt=review.clearReviewedForbidden(b,[b,'tiktok:b'],fs.readFileSync(f.file,'utf8'));
  receipt.holdForAccountCommit(()=>{});
  assert.deepEqual(json(f.file).pauses[bKey],pair.other[0]);
  assert.equal(view(f.dir,stoppedAt+2500).available,false);
  assert.deepEqual(view(f.dir,stoppedAt+2500).reasons,['rate_limited']);
  assert.equal(view(f.dir,pair.other[0].until+1).available,true);
});

test('single atomic replacement failure is retried under the safety lock before the account callback',()=>{
  const f=setup();
  let attempted=0,observed=0;
  const adapter={...fs,renameSync(from,to){
    if(to===f.file && ++attempted===1) throw Object.assign(Error('first replace denied'),{code:'EACCES'});
    fs.renameSync(from,to);
  }};
  const s=new (load('automationSafety',adapter).AutomationSafety)(f.file);
  s.begin(b,'tiktok:b','fixture',()=>{
    observed++;
    assert.equal(fs.existsSync(f.file+'.writer'),false);
    assert.equal(json(f.file).pauses[bKey].code,'rate_limited');
  });
  s.halt(b,'rate_limited',120000);
  assert.equal(attempted,2);
  assert.equal(observed,1);
  assert.equal(s.signal(b).aborted,true);
  assert.equal(view(f.dir,now()).available,false);
});
