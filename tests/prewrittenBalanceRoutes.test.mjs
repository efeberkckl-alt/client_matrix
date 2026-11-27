import fs from 'node:fs';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import test from 'node:test';
import ts from 'typescript';

function find(file, name, method=false) {
  const src = fs.readFileSync(new URL('../src/renderer/'+file, import.meta.url), 'utf8');
  const ast = ts.createSourceFile(file,src,ts.ScriptTarget.Latest,true);
  let text;
  function visit(node) {
    if (method ? ts.isMethodDeclaration(node)&&node.name.getText(ast)===name
      : ts.isVariableDeclaration(node)&&node.name.getText(ast)===name) {
      text = method ? node.getText(ast) : node.initializer.getText(ast);
    }
    if (!text) ts.forEachChild(node,visit);
  }
  visit(ast);
  assert.ok(text, name);
  return text;
}
const detail='components/scenario/TaskDetailPage.tsx';
const matrix='components/matrix/MatrixView.tsx';
const scope = ['handleRunNow','handleLoginConfirmed','isCustomCommentTask'];
const code = [
  'const scenarioService = ({'+find('services/scenario.ts','runTaskNow',true)+'});',
  ...scope.map(name=>'const '+name+' = '+find(detail,name)+';'),
  'const runTaskNow = '+find(matrix,'runTaskNow')+';',
  'const platformHasFreeCard = '+find('components/scenario/ScenarioView.tsx','platformHasFreeCard')+';',
  '({handleRunNow,runTaskNow,platformHasFreeCard});',
].join('\n');
const js=ts.transpileModule(code,{compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
function context(balance,mode,platform='tiktok',edition=true,authenticated=true) {
  const calls=[];
  let checks=0;
  const runTaskById = async input=>{calls.push(input.taskId); return {ok:true};};
  const runtime = vm.runInNewContext(js,{
    running:false, task:{id:'detail-task',comment_mode:mode,scenario_id:platform+'_comment_like',comment_do_reply:false}, Date,
    MATRIX_EDITION:edition, MATRIX_VIDEO_DOWNLOAD_PLATFORMS:new Set(), MATRIX_COMMENT_LIKE_PLATFORMS:new Set(['tiktok']),
    MATRIX_FOLDER_POST_PLATFORMS:new Set(),FOLDER_POST_CARD_HIDDEN:true,
    noobClawAuth: {getState:()=>({isAuthenticated:authenticated}),requireLoginUI(){},
      hasEnoughBalanceForTask(){checks++;return balance>=10000;},isActiveMember:()=>false},
    MX:()=>({runTaskById}), M:()=>({runTaskById}), ensureMatrixLogin:()=>authenticated, requireLogin:()=>authenticated,
    requireKernel:()=>true,runningPlatforms:[],kernelPath:undefined,
    setLoginModalOpen(){},setRunning(){},setProgress(){},justStartedAtRef:{},mountedRef:{current:true},
    setItems(){},setLogs(){},setDoneReport(){},setSelectedTaskId(){},
  });
  return {runtime,calls,checks:()=>checks,matrixTask:{id:'matrix-task',platform,type:'comment_like',commentMode:mode}};
}

test('actual detail and matrix handlers reach saved-run IPC at zero, low and normal balance',async()=>{
  for(const balance of [0,1,27000]){
    const state=context(balance,'custom');
    await state.runtime.handleRunNow();
    await state.runtime.runTaskNow(state.matrixTask);
    assert.deepEqual(state.calls,['detail-task','matrix-task']);
    assert.equal(state.checks(),0);
    assert.equal(state.runtime.platformHasFreeCard('tiktok'),true);
  }
});

test('paid and unsupported-platform modes still check balance and login remains mandatory',async()=>{
  for(const [mode,platform] of [['precise','tiktok'],['keywords','tiktok'],['custom','douyin']]){
    const state=context(0,mode,platform);
    await state.runtime.handleRunNow();
    await state.runtime.runTaskNow(state.matrixTask);
    assert.deepEqual(state.calls,[]);
    assert.equal(state.checks(),2);
  }
  const nonMatrix=context(0,'custom','tiktok',false);
  await nonMatrix.runtime.handleRunNow();
  assert.equal(nonMatrix.checks(),1);
  assert.deepEqual(nonMatrix.calls,[]);
  const unauth=context(50000,'custom','tiktok',true,false);
  await unauth.runtime.handleRunNow(); await unauth.runtime.runTaskNow(unauth.matrixTask);
  assert.deepEqual(unauth.calls,[]);
  const paid=context(30000,'precise');
  await paid.runtime.handleRunNow(); await paid.runtime.runTaskNow(paid.matrixTask);
  assert.deepEqual(paid.calls,['detail-task','matrix-task']);
  assert.equal(paid.checks(),2);
});
