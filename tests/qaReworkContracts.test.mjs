import assert from 'node:assert/strict';
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import test from 'node:test';
import ts from 'typescript';
import { build, transformSync } from 'esbuild';

const require = createRequire(import.meta.url);
const root = process.env.REWORK_SOURCE_ROOT || fileURLToPath(new URL('..', import.meta.url));
const matrix = path.join(root, 'src/main/libs/matrix');
const read = file => fs.readFileSync(file, 'utf8');
const compiled = (await build({
  stdin: { contents: "export * from './accountManager'; export * from './customCommentBatch'; export * from './kernelNavigation';", resolveDir: matrix },
  nodePaths: [fileURLToPath(new URL('../node_modules', import.meta.url))],
  bundle: true, write: false, format: 'cjs', platform: 'node',
  plugins: [{ name: 'isolation', setup(b) {
    b.onResolve({ filter: /coworkLogger|taskStore/ }, args => ({path:args.path,namespace:'test'}));
    b.onLoad({ filter: /.*/, namespace:'test'}, () => ({contents:'export const coworkLog=()=>{}; export const pruneAccountFromTasks=()=>{};'}));
  } }],
})).outputFiles[0].text;
function boot(dir, kill = () => assert.fail('no real process observation'), failOnRename) {
  const module = { exports: {} };
  runInNewContext(compiled,{
    module,exports:module.exports,URL,AbortSignal,AbortController,Buffer,setTimeout,clearTimeout,
    require: name => name === 'fs' && failOnRename ? {...fs,renameSync(from,to) {
      if (failOnRename(to)) throw Error('test-write-failure');
      fs.renameSync(from,to);
    }} : require(name),
    process: { env:{NOOBCLAW_MATRIX_DIR:dir}, pid:process.pid, platform:process.platform, kill },
  });
  return module.exports;
}
function fixture(t, sameProfile = false) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(),'matrix-qa-rework-'));
  const file = path.join(dir,'accounts.json');
  fs.writeFileSync(file, JSON.stringify(['a','b'].map(id => ({ id, status:'idle', platform:'tiktok', boundUid:id,
    userDataDir:path.join(dir, 'fixture-profile-' + (sameProfile ? 'a' : id)) }))));
  t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
  return {dir,file,saved:()=>JSON.parse(read(file))};
}
function extract(mapping, context) {
  const declarations = [], names = [];
  for (const [file, selections] of mapping) {
    const ast = ts.createSourceFile(file,read(path.join(matrix,file)) ,ts.ScriptTarget.ES2022,true);
    for (const name of selections) {
      const decl = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === name);
      assert.ok(decl,name);
      declarations.push(decl.getText(ast).replace(/^export /,''));
      names.push(name);
    }
  }
  return runInNewContext(ts.transpileModule(declarations.join('\n')+'\n({ '+names.join(', ')+' })',
    {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText, context);
}
const video='https://fixture.invalid/@demo/video/100';
const login='https://fixture.invalid/login';

test('R1 replay admits the exact buffered root, retains Retry-After, and ignores conflict, child and retired traffic', async t=>{
  for (const scenario of ['403','429','200','wrong_loader','wrong_frame','unknown','iframe','old_root']) {
    const f=fixture(t), store=boot(f.dir), events=[];
    const expires = Date.now()+3600_000;
    const trace=new store.NavigationTrace('a','fixture-instance',e=>events.push(e),(params,main,_write,receipt)=>{
      if (!main) return;
      if (params.response.status===403) store.recordRootProtection(receipt,'forbidden');
      if (params.response.status===429) { store.recordRootProtection(receipt,'rate_limited',expires); return expires; }
    },(connection,generation)=>store.observeRoot('a','fixture-instance',connection,generation));
    trace.seed({id:'root',loaderId:'old',url:video});
    const request=(requestId,loaderId,frameId,timestamp)=>trace.observe('Network.requestWillBeSent',{
      requestId,loaderId,frameId,type:'Document',timestamp,request:{method:'GET',url:login}
    });
    const commit=(loaderId)=>{ trace.observe('Page.frameNavigated',{frame:{id:'root',loaderId,url:login}});
      trace.observe('Page.lifecycleEvent',{frameId:'root',loaderId,name:'DOMContentLoaded'}); };
    trace.begin(video);
    request('b','new','root',10);
    if (scenario==='iframe') request('child','child','iframe',11);
    const status = scenario==='429'?429:scenario==='200'?200:403;
    trace.observe('Network.responseReceived',{
      requestId:scenario==='unknown'?'unknown':scenario==='iframe'?'child':'b',
      loaderId:scenario==='wrong_loader'?'alien':scenario==='iframe'?'child':'new',
      ...(scenario==='wrong_frame'?{frameId:'iframe'}:{}),type:'Document',timestamp:12,
      response:{status,url:login,headers:{'Retry-After':'3600'}},
    });
    commit('new');
    if (scenario==='old_root') {
      // The previous loader is retired after the replacement commits.
      trace.observe('Network.responseReceived',{requestId:'old',loaderId:'old',frameId:'root',
        type:'Document',timestamp:13,response:{status:403,url:video}});
    }
    trace.acknowledge({frameId:'root',loaderId:'never-requested',errorText:'net::ERR_ABORTED'});
    const outcome=await trace.waitForDocument(AbortSignal.timeout(250));
    if(scenario==='403'||scenario==='429'||scenario==='old_root'){
      assert.equal(outcome,scenario==='429'?'http_429':'http_403');
      assert.ok(store.selectAvailability('a').reasons.includes(scenario==='429'?'rate_limited':'forbidden'));
      if(scenario==='429') assert.equal(f.saved().accounts[0].recovery.nextCheckAt,expires);
      if(scenario==='old_root') assert.equal(events.filter(e=>e.status===403&&e.kind==='document').length,1);
    } else {
      assert.equal(outcome,'ready',scenario);
      assert.equal(store.selectAvailability('a').available,true);
    }
  }
});

test('R2 a copied ledger cannot certify the original transaction, and a verified cross-batch observation is saved at its origin', t=>{
  const f=fixture(t); let store=boot(f.dir);
  const post={url:'https://www.tiktok.com/@fixture/video/7462100000000000170',text:'fixture only'};
  const other={url:'https://www.tiktok.com/@fixture/video/7462100000000000171',text:'other fixture'};
  const key=JSON.stringify(['7462100000000000170',post.text]);
  const origin=new store.CustomCommentBatch(f.dir,[post],{reconcile:true});
  const receipt=store.registerDispatch('a','comment',{action:'comment',platform:'tiktok',ledgerKey:key,ledgerId:origin.ledgerId,at:Date.now()});
  const before={author:'fixture-account',count:1,ids:['prior']};
  origin.prepare(key,'a',before,receipt.id);
  const related=new store.CustomCommentBatch(f.dir,[post,other],{reconcile:true});
  assert.equal(related.pendingFor('a').length,1);
  const copied=JSON.parse(read(related.file));
  copied.entries[key]={...copied.entries[key],status:'confirmed',verification:{kind:'observed',source:'same_page',
    after:{...before,count:2,ids:['prior','copied-only']}}};
  fs.writeFileSync(related.file,JSON.stringify(copied));
  store=boot(f.dir);
  assert.equal(store.reconcileStoredCommentTransactions(f.dir),0);
  assert.equal(store.getDispatchedReceipt(receipt.id).result,'comment_pending');
  const next=new store.CustomCommentBatch(f.dir,[post,other],{reconcile:true});
  assert.equal(next.readLedger()[key],'pending');
  assert.throws(()=>next.confirm(key,'a',{...before,author:'different',count:2},'reopened'),/没有原执行账号/);
  assert.equal(next.confirm(key,'a',{...before,count:2,ids:['prior','verified']},'reopened'),receipt.id);
  assert.equal(JSON.parse(read(origin.file)).entries[key].verification.after.ids.at(-1),'verified');
  assert.equal(boot(f.dir).reconcileStoredCommentTransactions(f.dir),0);
  assert.equal(boot(f.dir).getDispatchedReceipt(receipt.id).result,'confirmed');
});

test('R2 both reconciliation paths keep a wrong subject, zero delta and failed original write pending', t=>{
  for (const scenario of ['wrong-subject','zero-delta','write-failed']) {
    const f=fixture(t); let store=boot(f.dir);
    const post={url:'https://www.tiktok.com/@fixture/video/7462100000000000180',text:'fixture evidence'};
    const key=JSON.stringify(['7462100000000000180',post.text]);
    const first=new store.CustomCommentBatch(f.dir,[post],{reconcile:true});
    const receipt=store.registerDispatch('a','comment',{action:'comment',platform:'tiktok',ledgerKey:key,ledgerId:first.ledgerId,at:Date.now()});
    const before={author:'fixture-account',count:1,ids:['prior']};
    first.prepare(key,'a',before,receipt.id);
    if (scenario==='write-failed') {
      let fail=false;
      store=boot(f.dir,undefined,to=>fail&&to===first.file);
      const batch=new store.CustomCommentBatch(f.dir,[post],{reconcile:true});
      fail=true;
      assert.throws(()=>batch.confirm(key,'a',{...before,count:2},'reopened'),/test-write-failure/);
    } else {
      const state=JSON.parse(read(first.file));
      const entry=state.entries[key];
      state.entries[key]={...entry,status:'confirmed',verification:{kind:'observed',source:'same_page',
        after:{...before,count:scenario==='zero-delta'?1:2}}};
      if (scenario==='wrong-subject') state.entries[key].dispatchSubject='tiktok:b';
      fs.writeFileSync(first.file,JSON.stringify(state));
    }
    store=boot(f.dir);
    store.reconcileStoredCommentTransactions(f.dir);
    assert.equal(store.getDispatchedReceipt(receipt.id).result,'comment_pending');
    const reopened=new store.CustomCommentBatch(f.dir,[post],{reconcile:true});
    assert.equal(reopened.readLedger()[key],'pending');
    assert.throws(()=>reopened.prepare(key,'a',before),/\u5df2\u6709\u53d1\u9001\u8bb0\u5f55/);
    assert.equal(f.saved().dispatchRecords[receipt.id].result,'comment_pending');
  }
});

test('R3 process-less restart with live prior owner blocks cleanup launch and aliased accounts remain fenced',async t=>{
  const f=fixture(t,true); let store=boot(f.dir);
  let a=store.getAccount('a');
  assert.equal(store.selectAvailability('b').available,true);
  let original=store.bindAssociation(store.reserveAssociation('a','first-scan'),'incumbent');
  store.trackProfileProcess('b',a.userDataDir,'other-previous',88002);
  store.noteProfileProcessExit('b','other-previous');
  store.trackProfileProcess('a',a.userDataDir,'incumbent',88001);
  const cookie=store.recordCookieMutation('a','incumbent','fixture-wire',false,original,true);
  assert.equal(store.selectAvailability('b').available,false);
  assert.throws(()=>store.reserveAssociation('b','other-scan'),/profile_cleanup_unconfirmed/);
  store.settleCookieMutation(cookie,'completed');
  assert.equal(store.selectAvailability('b').available,true);
  store.recordCookieMutation('a','incumbent','fixture-wire',false,original,true);
  let probes=0; store=boot(f.dir,(pid,signal)=>{assert.equal(pid,88001);assert.equal(signal,0);++probes;});
  a=store.getAccount('a');
  assert.ok(a.authority.cleanup);
  let launches=0;
  const { cleanupProfileCookies }=extract([['kernelPool.ts',['cleanupProfileCookies']]],{
    accountAuthority:store,getAccount:store.getAccount,profileKey:x=>x,profileCleanupOwners:new Map(),profileReservations:new Map(),
    sessions:new Map(),closingProcs:new Map(),launching:new Map(), AbortSignal,
    acquireKernel:async()=>{launches++;throw Error('unexpected release of profile hold');},
  });
  assert.equal(await cleanupProfileCookies({accountId:'a',userDataDir:a.userDataDir}),false);
  assert.equal(probes,1);assert.equal(launches,0);
  assert.equal(store.selectAvailability('a').available,false);
  assert.equal(store.selectAvailability('b').available,false);
  assert.equal(f.saved().accounts[0].authority.mutations[Object.keys(f.saved().accounts[0].authority.mutations)[0]].state,'dispatched');
});

test('R3 the actual Cookie send keeps its durable fence until a current acknowledgement',async t=>{
  for (const outcome of ['ack','cancel','revoked']) {
    const f=fixture(t),store=boot(f.dir),activeCookieWrites=new WeakMap(),queue=new Map();
    const userDataDir=store.getAccount('a').userDataDir;
    let reachedWire,ack,packets=0;
    const sent=new Promise(resolve=>{reachedWire=resolve;});
    const session={accountId:'a',authoritativeAccount:true,diagnosticsId:'instance',userDataDir,msgId:0,pending:new Map(),
      navigation:{snapshot:()=>({connectionEpoch:'connection',generation:1,state:'confirmed'})}};
    session.pageWs={readyState:1,send(raw){const {id,method}=JSON.parse(raw);++packets;
      assert.equal(method,'Network.setCookie');ack=()=>session.pending.get(id).resolve({success:true});reachedWire();}};
    const sessions=new Map([['a',session]]);
    const api=extract([['kernelPool.ts',['cookieMutation','send','waitForKernel']]],{
      profileKey:x=>x,profileCookieQueue:queue,sessions,activeCookieWrites,
      accountAuthority:store,getAccount:store.getAccount,loginReadCapabilities:new WeakMap(),localControlPermits:new WeakMap(),
      kernelSignal:()=>undefined,WebSocket:{OPEN:1},setTimeout,clearTimeout,
    });
    const controller=new AbortController();
    const fence=store.bindAssociation(store.reserveAssociation('a','fixture-scan'),'instance');
    const mutation=api.cookieMutation(session,'Network.setCookie',{name:'fixture',value:'fixture'},controller.signal,fence);
    const settled=mutation.then(()=>true,()=>false);
    await sent;
    assert.equal(packets,1);
    assert.match(store.selectAvailability('a').reasons.join(','),/profile_cookie_in_flight/);
    assert.equal(store.selectAvailability('b').available,true);
    assert.throws(()=>store.reserveAssociation('a','replacement'),/profile_cleanup_unconfirmed/);
    if (outcome==='cancel') { controller.abort(); assert.equal(await settled,false); }
    if (outcome==='revoked') store.beginProfileDisconnect('a');
    ack();
    await new Promise(resolve=>setImmediate(resolve));
    assert.equal(await settled,outcome==='ack');
    const saved=f.saved().accounts[0].authority;
    assert.deepEqual(Object.values(saved.mutations||{}).map(x=>x.state),outcome==='ack'?[]:['unknown']);
    assert.equal(!!saved.cleanup,outcome!=='ack');
  }
});

test('R4 the real material command path carries its exact lease through asynchronous page selection',async t=>{
  const f=fixture(t),store=boot(f.dir),scope=new AsyncLocalStorage(), leases=new WeakMap(),sessions=new Map();
  const wire=[];
  const make=(id,diagnosticsId)=>{const s={accountId:id,diagnosticsId,authoritativeAccount:true,msgId:1,pending:new Map(),
    navigation:{assertBusinessReady(){},snapshot:()=>({state:'confirmed',connectionEpoch:'fixture-wire',generation:1})}};
    s.pageWs={readyState:1,send(raw){const c=JSON.parse(raw);wire.push([id,diagnosticsId,c.method]);
      queueMicrotask(()=>s.pending.get(c.id)?.resolve({result:{value:'{"ok":true,"body":"fixture"}'}}));}};
    return s;};
  const first=make('a','la'),next=make('a','new'),other=make('b','lb');
  sessions.set('a',first);sessions.set('b',other);
  const issue=(s,signal)=>{const stamp=store.captureAssociation(s.accountId);const receipt={accountId:s.accountId,sessionInstanceId:s.diagnosticsId,
    epoch:stamp.epoch,incarnation:stamp.incarnation,storeId:stamp.storeId};leases.set(receipt,{session:s,signal});return receipt;};
  const abort=new AbortController();
  const ar=issue(first), second=issue(first,abort.signal), br=issue(other);
  let switchDuringLookup=false;
  const api=extract([['kernelPool.ts',['withKernelLease','isKernelLeaseCurrent','kernelEval','send']],['cdpCommands.ts',['matrixCmd']]],{
    kernelLeaseScope:scope,kernelLeases:leases,sessions,accountAuthority:store,getAccount:store.getAccount,
    getPage:async id=>{await Promise.resolve();if(switchDuringLookup&&id==='a')sessions.set('a',next);return sessions.get(id);},
    kernelSignal:()=>undefined, AUTOMATION_RESTRICTION_EXPR:'fixture-restriction', ROOT_PROOF_EXPRESSION:'fixture-proof',
    operationForScript:()=>undefined,automationOperationContext:{getStore:()=>undefined}, localControlPermits:new WeakMap(),
    loginReadCapabilities:new WeakMap(),activeCookieWrites:new WeakMap(),KernelNavigationError:Error,
    WebSocket:{OPEN:1},setTimeout,clearTimeout,
  });
  const download=(id,receipt)=>api.matrixCmd(id,'main_world_fetch_api',{url:'https://fixture.invalid/material',responseType:'base64'},undefined,receipt);
  assert.equal((await download('a')).ok,false);
  assert.throws(()=>api.send(first,'Page.captureScreenshot',{}),/ownership_unconfirmed/);
  assert.equal(wire.length,0);
  const results=await Promise.all([download('a',ar),download('b',br)]);
  assert.deepEqual(results.map(x=>x.ok),[true,true]);
  abort.abort();
  await assert.rejects(download('a',second),/cancelled/);
  assert.equal(wire.length,2);
  switchDuringLookup=true;
  assert.equal((await download('a',ar)).ok,false);
  assert.equal(wire.length,2);
  assert.equal((await download('a',issue(next))).ok,true);
  assert.equal(wire.at(-1)[1],'new');
  const imageText=read(path.join(matrix,'imageTextRunner.ts'));
  const start=imageText.indexOf('const downloadTab:');
  const end=imageText.indexOf('} : null;',start)+'} : null;'.length;
  const nested=runInNewContext(transformSync(imageText.slice(start,end)+'\ndownloadTab',{loader:'ts'}).code,{
    downloadAccountId:'b',downloadReceipt:br,withKernelLease:api.withKernelLease,matrixCmd:api.matrixCmd,
    kernelNavigate:async (accountId,url)=>{assert.equal(scope.getStore(),br);assert.equal(accountId,'b');assert.equal(url,login);},
  });
  await api.withKernelLease(issue(next),()=>nested.navigate(login));
});

for (const legacy of [false,true]) {
test(`R5 ${legacy?'missing ID is rejected and prepared':'keyed'} task runner resumes billing without rerunning publish`,async t=>{
  const f=fixture(t); let store=boot(f.dir), posts=0;
  const requests=[];
  const server=http.createServer(async(req,res)=>{
    let body='';for await(const part of req) body+=part;requests.push(JSON.parse(body));
    if(requests.length===1){req.socket.destroy();return;}
    res.setHeader('Content-Type','application/json');res.end('{"ok":true,"charged":1}');
  });
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  t.after(()=>{server.closeAllConnections();server.close();});
  const runtime=(kernelAvailable=true)=>{
    const publishedSubjects=new WeakMap();
    return extract([['taskRunner.ts',['runMatrixTask','completeMatrixPublish','chargeSuccess']]],{
      ...store,publishedSubjects, installedKernelPath:()=>kernelAvailable?'/synthetic':undefined,NO_KERNEL_ERROR:'NO_KERNEL',fetch,AbortSignal,
      coworkLog(){},baseUrl:()=>`http://127.0.0.1:${server.address().port}`,
      runPool:async ([id])=>{++posts;const item={accountId:id,state:'success'};
        publishedSubjects.set(item,store.captureDispatchSubject(id,{instance:'fixture',connection:'fixture',generation:1}));
        return [item];},
    });
  };
  const started=[];
  const opts={platform:'tiktok',taskId:'fixture-saved-task',accountIds:['a'],authToken:'offline',
    runOperationId:'fixture-run-first',getInput:()=>({videoPath:'synthetic'}),onOperation:id=>started.push(id)};
  if (legacy) {
    await assert.rejects(runtime().runMatrixTask({...opts,runOperationId:undefined}),/matrix_operation_id_required/);
    const request=store.bindPublishRequest(opts.platform,opts.taskId,opts.accountIds,true,opts.getInput);
    const {operation}=store.beginMatrixPublishOperation(request,undefined,'prepare');
    opts.runOperationId=operation.id;
  }
  const first=await runtime().runMatrixTask(opts);
  assert.equal(first.charged,undefined);assert.equal(posts,1);
  assert.equal(f.saved().publishRuns[first.runOperationId].outcome.items.length,1);
  store=boot(f.dir);
  const replay=await Promise.all([runtime(false).runMatrixTask(opts),runtime(false).runMatrixTask(opts)]);
  assert.equal(posts,1);assert.equal(requests.length,1);
  assert.ok(replay.every(r=>r.charged===undefined&&r.runOperationId===first.runOperationId));
  assert.deepEqual(started,[first.runOperationId,first.runOperationId,first.runOperationId]);
  const next=await runtime().runMatrixTask({...opts,accountIds:['b'],runOperationId:'fixture-run-second'});
  assert.equal(next.charged.charged,1);assert.equal(posts,2);
  assert.deepEqual(requests,[{platform:'tiktok',count:1},{platform:'tiktok',count:1}]);
  assert.deepEqual(Object.values(f.saved().dispatchRecords).map(r=>r.result),['charge_uncertain','confirmed']);
});
}

test('R6 durable same-store snapshots clear only a completed or vanished scan and a later UI click uses a new ID',async t=>{
  const f=fixture(t), original=boot(f.dir);
  const first=original.reserveAssociation('a','durable-first');
  const active=original.accountEventVersion('a');
  assert.equal(active.activeScanId,'durable-first');
  original.finishAssociation(first);
  const finished=original.accountEventVersion('a');
  assert.equal(finished.lastScanId,'durable-first');
  assert.equal(finished.activeScanId,undefined);
  original.reserveAssociation('a','durable-in-flight');
  const restarted=boot(f.dir).accountEventVersion('a');
  assert.equal(restarted.lastScanId,'durable-in-flight');
  assert.equal(restarted.activeScanId,undefined);
  assert.equal(restarted.storeId,active.storeId);
  const file=path.join(root,'src/renderer/components/matrix/matrixAccountVersions.ts');
  const module={exports:{}};
  runInNewContext(ts.transpileModule(read(file),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS}}).outputText,{module,exports:module.exports});
  const {endedScans,rememberScanAcceptance}=module.exports;
  assert.equal(typeof endedScans,'function');
  const source=read(path.join(root,'src/renderer/components/matrix/MatrixView.tsx'));
  const start=source.indexOf('const promptScanLogin = async');
  const end=source.indexOf('const openWindow = async',start);
  const eventStart=source.indexOf('onAccount?.((p: any) => {')+'onAccount?.('.length;
  const eventEnd=source.indexOf('\n    });',eventStart);
  const scans=new Map(),notices=[],successes=[],submitted=[];
  let release,serial=0;
  const ui=runInNewContext(transformSync(source.slice(start,end)+'\n({ start:promptScanLogin, event: ('+
    source.slice(eventStart,eventEnd)+'}) })',{loader:'ts'}).code,{
    scanningRef:{current:scans},rememberScanAcceptance, setConnectedPopup:x=>successes.push(x),setNotice:x=>notices.push(x),
    M:()=>({openLogin:args=>{submitted.push(args.scanId);return new Promise(resolve=>{release=resolve;});}}),
    requireLogin:()=>true,requireKernel:()=>true,kernelPath:'synthetic',loginUrlFor:()=>login,
    crypto:{randomUUID:()=> 'fixture-scan-'+ ++serial}, i18nService:{t:()=>'{name}'},reload(){},
  });
  const initial=ui.start('a','tiktok','fixture');
  ui.event({id:'a',scanId:submitted[0],loginVerified:true,available:true,status:'idle'});
  release({ok:true,storeId:'store',storeRevision:'10'});await initial;
  assert.equal(successes.length,1);assert.equal(scans.size,0);
  const next=ui.start('a','tiktok','fixture');
  assert.deepEqual([...endedScans(scans,{storeId:'store',storeRevision:'10'},[])],[]);
  release({ok:true,storeId:'store',storeRevision:'11'});await next;
  assert.deepEqual([...endedScans(scans,{storeId:'store',storeRevision:'10'},[])],[]);
  assert.deepEqual([...endedScans(scans,{storeId:'store',storeRevision:'11'},[{id:'a',activeScanId:submitted[1]}])],[]);
  assert.deepEqual([...endedScans(scans,{storeId:'store',storeRevision:'12'},[])],['a']);
  assert.deepEqual([...endedScans(scans,{storeId:'other-store',storeRevision:'12'},[])],[]);
  const closed=endedScans(scans,{storeId:'store',storeRevision:'12'},[{id:'a',lastScanId:submitted[1]}]);
  assert.deepEqual([...closed],['a']);
  for(const id of closed)scans.delete(id);
  ui.event({id:'a',scanId:submitted[1],error:'late stale failure'});
  assert.ok(!notices.some(x=>x.includes('late stale failure')));
  const reopened=ui.start('a','tiktok','fixture');
  assert.equal(new Set(submitted).size,3);
  ui.event({id:'a',manualDisconnect:true});
  release({ok:true,storeId:'store',storeRevision:'13'});await reopened;
  assert.equal(scans.size,0);assert.equal(successes.length,1);
});
