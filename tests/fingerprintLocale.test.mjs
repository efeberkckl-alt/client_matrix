import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'matrix-locale-'));
process.env.NOOBCLAW_MATRIX_DIR = directory;
const sourceDir = fileURLToPath(new URL('../src/main/libs/matrix/', import.meta.url));
const server = http.createServer((_req, res) => res.end(JSON.stringify({Browser:'fixture'})));
await new Promise(resolve => server.listen(0,'127.0.0.1',resolve));
const spawned = [];
globalThis.__localeFakeSpawn = (_binary, args) => {
  spawned.push(args);
  const profile = args.find(arg => arg.startsWith('--user-data-dir=')).slice('--user-data-dir='.length);
  assert.ok(path.resolve(profile).startsWith(directory + path.sep));
  fs.writeFileSync(path.join(profile, 'DevToolsActivePort'), String(server.address().port));
  const proc = new EventEmitter();
  proc.exitCode = null;
  proc.kill = () => { if (proc.exitCode === null) { proc.exitCode = 0; proc.emit('exit', 0); } };
  return proc;
};
const stubs = {
  coworkLogger: 'export const coworkLog = () => {};',
  kernelInstaller: 'export const installedKernelPath = () => process.execPath, ensureTabGroupExtension = () => null;',
  powerKeepAwake: 'export const acquireSystemKeepAwake = () => {}, releaseSystemKeepAwake = () => {};',
  child_process: 'export const execFileSync = () => "", spawn = (...args) => globalThis.__localeFakeSpawn(...args);',
};
const compiled = await build({ stdin: { contents: "export * from './accountManager'; export * from './kernelPool';", resolveDir: sourceDir },
  bundle: true, write: false, platform: 'node', packages: 'external', format: 'cjs', plugins: [{ name: 'locale-isolation', setup(builder) {
    builder.onResolve({filter:/^child_process$|\/(?:coworkLogger|kernelInstaller|powerKeepAwake)$/}, args => ({path:path.basename(args.path),namespace:'locale-stub'}));
    builder.onLoad({filter:/.*/,namespace:'locale-stub'}, args => ({contents:stubs[args.path]}));
  } }] });
function load(matrixDir) {
  const mod = {exports:{}};
  const fixtureProcess = matrixDir ? Object.create(process, {env:{value:{...process.env,NOOBCLAW_MATRIX_DIR:matrixDir}}}) : process;
  new Function('require','module','exports','process',compiled.outputFiles[0].text)(createRequire(import.meta.url),mod,mod.exports,fixtureProcess);
  return mod.exports;
}
const app = load();
test.after(async () => {
  delete globalThis.__localeFakeSpawn;
  await new Promise(resolve => server.close(resolve));
  fs.rmSync(directory, {recursive:true,force:true});
});
const fields = a => [a.fingerprint.lang, a.fingerprint.timezone];
const proxy = { protocol: 'http', host: 'proxy.invalid', port: 8080, geoCountryCode: 'CN' };
const observation = { ip: '203.0.113.20', observedAt: Date.now() - 1000, countryCode: 'US', timezone: 'America/Los_Angeles' };

test('creation uses actual observed data, explicit region/manual override, or content-language fallback', () => {
  const base = { platform:'tiktok', displayName:'synthetic', contentLang:'en' };
  const create = patch => app.createAccount({...base,...patch});
  const observed = create({proxy, exitObservation:observation});
  assert.deepEqual(fields(observed), ['en-US','America/Los_Angeles']);
  assert.deepEqual(fields(create({proxy})), ['en-US','America/New_York'], 'host country is not an observation');
  assert.deepEqual(fields(create({contentLang:'zh'})), ['zh-CN','Asia/Shanghai']);
  assert.deepEqual(fields(create({proxy,exitObservation:observation,fingerprintLocale:{region:'GB'}})), ['en-GB','Europe/London']);
  assert.deepEqual(fields(create({proxy,exitObservation:observation,fingerprintLocale:{lang:'es-MX',timezone:'America/Tijuana'}})), ['es-MX','America/Tijuana']);
  assert.throws(() => create({fingerprintLocale:{lang:'--flag',timezone:'bad-zone'}}), /无效/);
  console.log('new locale fixture', JSON.stringify({observed:fields(observed), hostIgnored: true, explicitOverride: true, invalidRejected: true}));
});

test('missing proxy region can use current-IP lookup, while a changed IP or route cannot inherit a stale locale', () => {
  const a = app.createAccount({platform:'tiktok',displayName:'synthetic',contentLang:'en',proxy,exitObservation:observation});
  app.recordAccountEgress(a.id,'203.0.113.23',observation.observedAt + 1,proxy);
  assert.equal(a.proxy.exitCountryCode,undefined);
  assert.equal(app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'align'}},{ip:observation.ip,locale:observation}),false);
  assert.deepEqual(fields(a),['en-US','America/Los_Angeles']);
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'align'}},{ip:'203.0.113.23',locale:{countryCode:'VN'}});
  assert.deepEqual(fields(a),['vi-VN','Asia/Ho_Chi_Minh']);
  app.setProxyHealth(a.id,'ok',{ip:'203.0.113.23',observedAt:observation.observedAt + 2,countryCode:'DE'});
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'align'}});
  assert.deepEqual(fields(a),['de-DE','Europe/Berlin']);
  app.setAccountProxy(a.id,{...proxy,port:8001});
  assert.equal(a.proxy.exitCountryCode,undefined);
  assert.equal(app.observedFingerprintExit(a),'');
  assert.deepEqual(fields(a),['de-DE','Europe/Berlin'],'route edit itself never silently rewrites saved locale');
});

test('existing locale edits persist across reload and the real launch forwards all three flags without changing profile or identity', async () => {
  const a = app.createAccount({platform:'tiktok',displayName:'synthetic',contentLang:'zh',proxy,exitObservation:observation,
    fingerprint:{seed:6958,brand:'Edge',hardwareConcurrency:4}});
  a.boundUid='isolated-binding'; a.nickname='isolated-name'; a.status='idle'; app.upsertAccount(a);
  fs.mkdirSync(a.userDataDir,{recursive:true});
  const marker=path.join(a.userDataDir,'LoginFixture');
  fs.writeFileSync(marker,'isolated-login-marker');
  const original={...a.fingerprint}, userDataDir=a.userDataDir;
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'align',region:'JP'}});
  assert.deepEqual(fields(a),['ja-JP','Asia/Tokyo']);
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'align'}});
  assert.deepEqual(fields(a),['en-US','America/Los_Angeles']);
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'manual',lang:'en-GB'}});
  assert.deepEqual(fields(a),['en-GB','America/Los_Angeles']);
  app.updateAccountMeta(a.id,{fingerprintLocale:{mode:'manual',timezone:'Europe/London'}});
  assert.throws(() => app.updateAccountMeta(a.id,{displayName:'must-not-persist',fingerprintLocale:{mode:'manual',timezone:'Asia/Fake'}}),/无效/);
  const newApp=load();
  const saved=newApp.getAccount(a.id);
  assert.deepEqual(saved.fingerprint,{...original,lang:'en-GB',timezone:'Europe/London'});
  assert.equal(saved.displayName,'synthetic'); assert.equal(saved.userDataDir,userDataDir);
  assert.equal(saved.boundUid,'isolated-binding'); assert.equal(saved.nickname,'isolated-name'); assert.equal(saved.status,'idle');
  const session=await newApp.launchKernel({accountId:saved.id,userDataDir:saved.userDataDir,fingerprint:saved.fingerprint,proxy:saved.proxy,manual:true,headless:true});
  try {
    const args=spawned.at(-1);
    const localeArgs=args.filter(x=>/^--(lang|accept-lang|timezone)=/.test(x));
    assert.deepEqual(localeArgs, ['--lang=en-GB','--accept-lang=en-GB','--timezone=Europe/London']);
    assert.ok(args.includes('--fingerprint=6958'));
    assert.equal(fs.readFileSync(marker,'utf8'),'isolated-login-marker');
    console.log('existing locale fixture',JSON.stringify({flags:localeArgs,seedPreserved:true,profilePreserved:true,bindingPreserved:true,persisted:true,loopbackSpawnBoundary:true}));
  } finally { session.process.kill(); newApp.closeAllKernels(); }
});

test('stale exit or geo, and a future observation, cannot overwrite a stored manual locale', () => {
  const app=load();
  const oldAt = Date.now() - app.FINGERPRINT_EXIT_FRESHNESS_MS - 60_000;
  const create = observedAt => app.createAccount({platform:'tiktok', displayName:'keep', contentLang:'en', proxy,
    exitObservation:{...observation, observedAt}, fingerprintLocale:{region:'JP'}});
  const old = create(oldAt), future = create(Date.now() + 60_000);
  const store = path.join(directory,'accounts.json');
  const before = fs.readFileSync(store,'utf8');
  for (const a of [old,future]) {
    assert.equal(app.observedFingerprintExit(a),'');
    assert.equal(app.updateAccountMeta(a.id,{displayName:'reject together', fingerprintLocale:{mode:'align'}}),false);
    assert.deepEqual(fields(a),['ja-JP','Asia/Tokyo']);
  }
  assert.equal(fs.readFileSync(store,'utf8'),before);
  app.recordAccountEgress(old.id,observation.ip,Date.now(),proxy);
  assert.equal(app.observedFingerprintExit(old),observation.ip);
  assert.equal(app.observedFingerprintLocale(old),undefined,'IP-only refresh cannot update geo age');
  assert.equal(app.updateAccountMeta(old.id,{fingerprintLocale:{mode:'align'}}),false);
  assert.deepEqual(fields(old),['ja-JP','Asia/Tokyo']);
  assert.equal(app.updateAccountMeta(old.id,{fingerprintLocale:{mode:'align'}},{ip:observation.ip,locale:{countryCode:'GB'}}),true);
  assert.deepEqual(fields(old),['en-GB','Europe/London']);
  app.setAccountProxy(old.id,{...proxy,host:'different-route.invalid'});
  assert.equal(app.observedFingerprintExit(old),'');
  assert.equal(app.updateAccountMeta(old.id,{fingerprintLocale:{mode:'align'}},{ip:observation.ip,locale:{countryCode:'VN'}}),false);
  assert.deepEqual(fields(old),['en-GB','Europe/London']);
  console.log('locale freshness fixture', JSON.stringify({minutes:15,expiredRejected:true,futureRejected:true,ipOnlyGeoStaysExpired:true,newGeoApplied:true,routeChangeDoesNotReuseIp:true}));
});

test('locale IPC rejects malformed input before any change, and allows one-field updates', async () => {
  const app=load();
  const source = fs.readFileSync(new URL('../src/main/sidecar-server.ts',import.meta.url),'utf8');
  const start = "case 'matrix:updateAccountMeta': {";
  const branch = source.split(start)[1].split("case 'matrix:kernelStatus': {")[0].trim().slice(0,-1)
    .replace("await import('./libs/matrix/accountManager')",'app')
    .replace("await import('./libs/matrix/proxyBridge')",'bridge');
  const ts=createRequire(import.meta.url)('typescript');
  const {outputText}=ts.transpileModule(branch,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const call=new AsyncFunction('args','app','bridge','res','writeJSON',outputText);
  const a=app.createAccount({platform:'tiktok',displayName:'unchanged',contentLang:'en'});
  const run=(payload,bridge={})=>call([{id:a.id,...payload}],app,bridge,null,(_res,status,body)=>({status,...body}));
  const invalid=[false,0,[],null,{}, {mode:'unknown',lang:'en-GB'}, {mode:'align',region:''},
    {mode:'align',region:'ZZ'}, {mode:'manual',lang:false,timezone:'Europe/Paris'}, {mode:'manual',lang:' '},
    {mode:'manual',lang:42}, {mode:'manual',timezone:null,lang:'en-GB'}, {mode:'manual',timezone:{}},
    {mode:'manual',timezone:'Invalid/Zone'}, {mode:'manual'}];
  const store=path.join(directory,'accounts.json');
  const before=fs.readFileSync(store,'utf8');
  for(const fingerprintLocale of invalid) {
    const result=await run({displayName:'must not change',fingerprintLocale});
    assert.equal(result.ok,false);
    assert.ok(result.error);
  }
  const stale=await run({fingerprintLocale:{mode:'align'}},{lookupIpGeo:()=>assert.fail('unknown IP cannot be refreshed by geolocating it')});
  assert.equal(stale.ok,false);
  assert.match(stale.error,/现有设置未改/);
  assert.equal(fs.readFileSync(store,'utf8'),before);
  assert.equal((await run({fingerprintLocale:{mode:'manual',lang:'en-GB'}})).ok,true);
  assert.deepEqual(fields(a),['en-GB','America/New_York']);
  assert.equal((await run({fingerprintLocale:{mode:'manual',timezone:'Europe/London'}})).ok,true);
  assert.deepEqual(fields(a),['en-GB','Europe/London']);

  app.setAccountProxy(a.id,proxy,{ip:observation.ip,observedAt:Date.now()});
  const unsupported=await run({fingerprintLocale:{mode:'align'}},{lookupIpGeo:async ip=>({ip,countryCode:'ZZ'})});
  assert.equal(unsupported.ok,false); assert.deepEqual(fields(a),['en-GB','Europe/London']);
  const refreshed=await run({fingerprintLocale:{mode:'align'}},{lookupIpGeo:async ip=>({ip,countryCode:'JP'})});
  assert.equal(refreshed.ok,true); assert.deepEqual(fields(a),['ja-JP','Asia/Tokyo']);
  const race=await run({fingerprintLocale:{mode:'align'}},{lookupIpGeo:async ip=>{
    app.setAccountProxy(a.id,{...proxy,port:8081});
    return {ip,countryCode:'US'};
  }});
  assert.equal(race.ok,false);
  assert.match(race.error,/出口配置已变/);
  assert.deepEqual(fields(a),['ja-JP','Asia/Tokyo']);
  console.log('locale IPC fixture', JSON.stringify({invalidRejected:invalid.length,metadataUnchanged:true,partialValid:true,freshGeoValid:true,routeRaceRejected:true}));
});


const r1Fields = proxy => [proxy.exitIp,proxy.exitIpObservedAt,proxy.exitCountryCode,proxy.exitTimezone,proxy.exitLocaleObservedAt];
const fixtureStore = (suffix) => path.join(fs.mkdtempSync(path.join(directory,suffix)), 'matrix');
const sampleDefaults = { platform:'tiktok', displayName:'R1/R2 synthetic', contentLang:'en' };
const r1Observation = (ip,observedAt,countryCode,timezone) => ({ip,observedAt,countryCode,timezone});

test('R1: a future sample cannot change either existing clock or data, and a valid changed IP clears old geo without changing manual locale', () => {
  const matrix=fixtureStore('r1-future-'), mgr=load(matrix);
  const realNow=Date.now, now=realNow();
  Date.now=()=>now;
  try {
    const ip='203.0.113.31', next='203.0.113.32', t=now-2;
    const a=mgr.createAccount({...sampleDefaults,proxy,exitObservation:r1Observation(ip,t,'GB','Europe/London')});
    const manual=['en-CA','America/Toronto'];
    assert.equal(mgr.updateAccountMeta(a.id,{fingerprintLocale:{mode:'manual',lang:manual[0],timezone:manual[1]}}),true);
    assert.deepEqual(fields(a),manual);
    const saved=r1Fields(a.proxy);
    for (const futureAt of [now+1, now+3600000]) {
      mgr.setProxyHealth(a.id,'ok',r1Observation(next,futureAt,'JP','Asia/Tokyo'));
      assert.deepEqual(r1Fields(a.proxy),saved);
      mgr.setAccountProxy(a.id,proxy,r1Observation(ip,futureAt,'FR','Europe/Paris'));
      assert.deepEqual(r1Fields(a.proxy),saved);
      const disk=path.join(matrix,'accounts.json'), before=fs.readFileSync(disk);
      assert.throws(()=>mgr.recordAccountEgress(a.id,next,futureAt,proxy),/出口观测无效/);
      assert.deepEqual(fs.readFileSync(disk),before);
    }
    assert.equal(mgr.recordAccountEgress(a.id,next,now,proxy),'ok');
    assert.deepEqual(r1Fields(a.proxy),[next,now,undefined,undefined,undefined]);
    assert.deepEqual(fields(a),manual,'observations do not rewrite manual locale');
    const persisted=load(matrix).getAccount(a.id);
    assert.deepEqual(r1Fields(persisted.proxy),r1Fields(a.proxy));
    assert.deepEqual(fields(persisted),manual);
    console.log('R1 future write fixture',JSON.stringify({offsetsMs:[1,3600000],futureRejected:true,validChangeClearedGeo:true,manualLocalePreserved:true,persisted:true}));
  } finally { Date.now=realNow; }
});

test('R1: disk-poisoned IP and geo watermarks recover independently with legal matching samples', () => {
  const matrix=fixtureStore('r1-watermarks-'), mgr=load(matrix);
  const realNow=Date.now, now=realNow();
  Date.now=()=>now;
  try {
    const ip='203.0.113.33', earlier=now-10, later=now-5;
    const create=()=>mgr.createAccount({...sampleDefaults,proxy,exitObservation:r1Observation(ip,earlier,'GB','Europe/London')});
    const poisonIp=create(), poisonGeo=create(), poisonBoth=create();
    const f=path.join(matrix,'accounts.json'), state=JSON.parse(fs.readFileSync(f,'utf8'));
    const entry=id=>state.accounts.find(row=>row.id===id).proxy;
    entry(poisonIp.id).exitIpObservedAt=now+50000;
    entry(poisonGeo.id).exitLocaleObservedAt=now+50000;
    entry(poisonGeo.id).exitIpObservedAt=now-1;
    entry(poisonBoth.id).exitIpObservedAt=now+50000;
    entry(poisonBoth.id).exitLocaleObservedAt=now+50001;
    fs.writeFileSync(f,JSON.stringify(state));
    const recovered=load(matrix);
    const i=recovered.getAccount(poisonIp.id), g=recovered.getAccount(poisonGeo.id), both=recovered.getAccount(poisonBoth.id);
    assert.equal(recovered.observedFingerprintExit(i),'');
    assert.equal(recovered.observedFingerprintLocale(g),undefined);
    // IP-only sample repairs the IP watermark without changing an already valid geo mark.
    recovered.setProxyHealth(i.id,'ok',r1Observation(ip,later));
    assert.deepEqual(r1Fields(i.proxy),[ip,later,'GB','Europe/London',earlier]);
    // An older IP event may still repair invalid geography for the very same IP.
    recovered.setProxyHealth(g.id,'ok',r1Observation(ip,later,'JP','Asia/Tokyo'));
    assert.deepEqual(r1Fields(g.proxy),[ip,now-1,'JP','Asia/Tokyo',later]);
    recovered.setProxyHealth(both.id,'ok',r1Observation(ip,later,'FR','Europe/Paris'));
    assert.deepEqual(r1Fields(both.proxy),[ip,later,'FR','Europe/Paris',later]);
    const again=load(matrix);
    for (const a of [i,g,both]) assert.deepEqual(r1Fields(again.getAccount(a.id).proxy),r1Fields(a.proxy));
    console.log('R1 watermark fixture',JSON.stringify({ip:true,geography:true,both:true,oldGeoUnchanged:true,stored:true}));
  } finally { Date.now=realNow; }
});

test('R1: lawful reordered IP and geo samples never roll back valid watermarks', () => {
  const matrix=fixtureStore('r1-reorder-'), mgr=load(matrix);
  const realNow=Date.now, now=realNow();
  Date.now=()=>now;
  try {
    const ip='203.0.113.34', next='203.0.113.35';
    const a=mgr.createAccount({...sampleDefaults,proxy,exitObservation:r1Observation(ip,now-10,'GB','Europe/London')});
    mgr.setProxyHealth(a.id,'ok',r1Observation(ip,now-2));
    // Geo can advance while preserving a newer IP-only clock.
    mgr.setProxyHealth(a.id,'ok',r1Observation(ip,now-5,'JP','Asia/Tokyo'));
    const saved=[ip,now-2,'JP','Asia/Tokyo',now-5];
    assert.deepEqual(r1Fields(a.proxy),saved);
    mgr.setProxyHealth(a.id,'ok',r1Observation(ip,now-6,'DE','Europe/Berlin'));
    mgr.setProxyHealth(a.id,'ok',r1Observation(next,now-3,'FR','Europe/Paris'));
    assert.deepEqual(r1Fields(a.proxy),saved);
    mgr.recordAccountEgress(a.id,ip,now-1,proxy);
    mgr.recordAccountEgress(a.id,next,now-2,proxy);
    assert.equal(a.egress.ip,ip);
    assert.equal(a.egress.observedAt,now-1);
    assert.deepEqual(r1Fields(a.proxy),[ip,now-1,'JP','Asia/Tokyo',now-5]);
    // Expired samples can still establish order, but are never read as current.
    const expired=mgr.createAccount({...sampleDefaults,proxy,exitObservation:r1Observation(ip,now-2*mgr.FINGERPRINT_EXIT_FRESHNESS_MS,'JP')});
    mgr.setProxyHealth(expired.id,'ok',r1Observation(next,now-3*mgr.FINGERPRINT_EXIT_FRESHNESS_MS,'GB'));
    assert.equal(expired.proxy.exitIp,ip);
    assert.equal(mgr.observedFingerprintExit(expired),'');
    assert.equal(mgr.observedFingerprintLocale(expired),undefined);
    console.log('R1 order fixture',JSON.stringify({geoIndependentlyAdvanced:true,outOfOrderRejected:true,expiredStillUnusable:true}));
  } finally { Date.now=realNow; }
});

function createIpc(mgr) {
  const source=fs.readFileSync(new URL('../src/main/sidecar-server.ts',import.meta.url),'utf8');
  const body=source.split("case 'matrix:createAccount': {")[1].split("case 'matrix:setAccountProxy': {")[0].trim().slice(0,-1)
    .replace("await import('./libs/matrix/accountManager')",'mgr');
  const ts=createRequire(import.meta.url)('typescript');
  const {outputText}=ts.transpileModule(body,{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.ESNext}});
  const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
  const f=new AsyncFunction('args','mgr','res','writeJSON',outputText);
  return input=>f([input],mgr,null,(_res,status,value)=>({status,...value}));
}
test('R2: malformed and conflicting locale creation is atomic on cold and existing stores',async () => {
  const matrix=fixtureStore('r2-invalid-'), mgr=load(matrix);
  const call=createIpc(mgr);
  const invalid=[null,[],false,0,'',{mode:undefined,region:'GB'},{mode:'unknown',region:'GB'},
    {mode:'align',region:'GB',timezone:'Asia/Tokyo'},{mode:'align',lang:'en-GB'},{mode:'manual',region:'GB',lang:'en-GB'},
    {mode:'manual',lang:''},{mode:'manual',lang:false,timezone:'Europe/Paris'},
    {mode:'manual',timezone:'invalid/region'},{mode:'manual'},{mode:'align',region:['JP']},{lang:'bad tag'},{region:0},{timezone:{}}];
  const run=async ()=> {
    for (const fingerprintLocale of invalid) {
      const request={...sampleDefaults,fingerprintLocale};
      assert.throws(()=>mgr.createAccount(request));
      const r=await call(request);
      assert.equal(r.ok,false); assert.ok(r.error);
    }
  };
  assert.equal(fs.existsSync(matrix),false);
  await run();
  assert.equal(fs.existsSync(matrix),false,'validation cannot create the store or profiles directory');
  const a=mgr.createAccount(sampleDefaults);
  fs.mkdirSync(a.userDataDir,{recursive:true});
  const f=path.join(matrix,'accounts.json'), before=fs.readFileSync(f), dirs=fs.readdirSync(path.join(matrix,'profiles'));
  await run();
  assert.deepEqual(fs.readFileSync(f),before);
  assert.deepEqual(fs.readdirSync(path.join(matrix,'profiles')),dirs);
  console.log('R2 invalid creation fixture',JSON.stringify({invalid:invalid.length,checkedDirectAndIpc:true,coldDirectoryUntouched:true,existingStoreUntouched:true}));
});

test('R2: valid align/manual and legacy creation preserve the expected locale defaults and overrides',async () => {
  const matrix=fixtureStore('r2-valid-'), mgr=load(matrix);
  const call=createIpc(mgr);
  const observed=r1Observation('203.0.113.36',Date.now()-1,'VN','Asia/Ho_Chi_Minh');
  for(const [input,expected] of [
    [{fingerprintLocale:{mode:'align',region:'GB'}},['en-GB','Europe/London']],
    [{fingerprintLocale:{mode:'align'},proxy,exitObservation:observed},['vi-VN','Asia/Ho_Chi_Minh']],
    [{fingerprintLocale:{mode:'manual',lang:'en-GB'}},['en-GB','America/New_York']],
    [{fingerprintLocale:{mode:'manual',timezone:'Europe/London'}},['en-US','Europe/London']],
    [{fingerprintLocale:{region:'JP'}},['ja-JP','Asia/Tokyo']],
    [{fingerprintLocale:{lang:'en-AU',timezone:'Australia/Sydney'}},['en-AU','Australia/Sydney']],
    [{},['en-US','America/New_York']],
    [{contentLang:'zh'},['zh-CN','Asia/Shanghai']],
    [{fingerprint:{lang:'en-CA',timezone:'America/Toronto'}},['en-CA','America/Toronto']],
  ]) {
    const result=await call({...sampleDefaults,...input});
    assert.equal(result.ok,true);
    assert.deepEqual(fields(result.account),expected);
    assert.deepEqual(fields(load(matrix).getAccount(result.account.id)),expected);
  }
  console.log('R2 valid creation fixture',JSON.stringify({modeAndLegacyCases:9,allPersisted:true}));
});
