import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';
import ts from 'typescript';

const parse = file => ts.createSourceFile(file, fs.readFileSync(new URL(`../src/renderer/${file}`, import.meta.url), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('tsx') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
const service = parse('services/scenario.ts');
const list = parse('components/scenario/MyTasksPage.tsx');
const detail = parse('components/scenario/TaskDetailPage.tsx');
const view = parse('components/scenario/ScenarioView.tsx');
const funcs = (tree, names) => tree.statements.filter(n => ts.isFunctionDeclaration(n) && names.includes(n.name?.text)).map(n => n.getText(tree).replace(/^export /, '')).join('\n');
const compile = source => ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS } }).outputText;
const i18nService = { currentLanguage: 'zh', t: key => key };
function find(tree, predicate) {
  let result;
  const visit = node => { if (predicate(node)) result = node; ts.forEachChild(node, visit); };
  visit(tree); assert.ok(result); return result;
}
function adapter() {
  const ctx = vm.createContext({ hhmmss: () => '', mxRunScenarioSnapshot: () => ({}) });
  vm.runInContext(compile(funcs(service, ['mxTaskToScenario', 'mxRunStatusOf', 'mxRunToRecord'])), ctx);
  return ctx;
}

test('matrix scenario adapter preserves recovery fields and authoritative terminal state/reason', () => {
  const a = adapter();
  const task = a.mxTaskToScenario({ id: 'a', type: 'comment_like', platform: 'tiktok', frequency: '30min', enabled: true,
    retryCount: 2, lastError: 'network_error', recoveryPaused: true, nextPlannedRunAt: 123 });
  assert.equal(task.retry_count, 2); assert.equal(task.last_error, 'network_error');
  assert.equal(task.recovery_paused, true); assert.equal(task.next_planned_run_at, 123);
  for (const [state, expected, statsStatus] of [['stopped', 'stopped', 'skipped'], ['skipped', 'stopped', 'skipped'], ['failed', 'error', 'failed']]) {
    const record = { state, reason: 'terminal-reason', success: 1, failed: 0, items: [{ accountId: 'a', state: 'skipped', reason: 'aborted' }] };
    const mapped = a.mxRunToRecord(record);
    assert.equal(mapped.status, expected); assert.equal(mapped.error, 'terminal-reason');
    assert.match(mapped.summary, /terminal-reason/); assert.equal(mapped.step_logs[0].status, 'done');
    assert.equal(a.mxRunStatusOf(record), statsStatus);
    assert.equal(a.mxRunToRecord({ ...record, running: true }).status, 'running');
  }
});

test('comment tasks show explicit pause/disabled/unscheduled states and keep scheduled URL tasks visible', () => {
  const ctx = vm.createContext({ i18nService, MATRIX_EDITION: true });
  vm.runInContext(compile(funcs(list, ['nextRunLabel'])), ctx);
  const task = { id: 'a', track: 'comment_like', scenario_id: 'tiktok_comment_like', account_ids: ['a'], enabled: true, run_interval: '30min', urls: ['https://example.invalid/video'] };
  assert.match(ctx.nextRunLabel(task), /未安排/);
  assert.match(ctx.nextRunLabel({ ...task, recovery_paused: true }), /暂停/);
  assert.match(ctx.nextRunLabel({ ...task, enabled: false }), /停用/);
  const declaration = find(detail, n => ts.isVariableDeclaration(n) && n.name.getText(detail) === 'isLinkModeForStats');
  const linkMode = vm.runInContext(compile(`(task => (${declaration.initializer.getText(detail)}));`), ctx);
  assert.equal(linkMode(task), false);
  assert.equal(linkMode({ ...task, scenario_id: 'tiktok_video_download', track: 'video_download' }), true);
  const next = find(detail, n => ts.isArrowFunction(n) && n.body.getText(detail).includes('const planned') && n.body.getText(detail).includes('tdSoonCalc'));
  const detailLabel = vm.runInContext(compile(`(${next.getText(detail)});`), ctx);
  for (const [extra, expected] of [[{}, /未安排/], [{ recovery_paused: true }, /暂停/], [{ enabled: false }, /停用/], [{ next_planned_run_at: Date.now() - 1 }, /tdSoon/]]) {
    ctx.task = { ...task, ...extra };
    assert.match(detailLabel(), expected);
  }
});

test('all-runs adapter preserves skipped/running instead of declaring success', async () => {
  const method = find(service, n => ts.isMethodDeclaration(n) && n.name?.getText(service) === 'getAllRuns');
  const records = [{ state: 'stopped', reason: 'aborted' }, { state: 'failed', reason: 'network_error' }, { running: true }, { state: 'success' }];
  const ctx = vm.createContext({ MATRIX_EDITION: true, MX: () => ({ listRuns: async () => ({ ok: true, runs: records }) }) });
  vm.runInContext(compile(`${funcs(service, ['mxRunStatusOf'])}\nclass Service { ${method.getText(service)} }\nvar api = new Service();`), ctx);
  const runs = await ctx.api.getAllRuns();
  assert.deepEqual(Array.from(runs, r => r.status), ['skipped', 'failure', 'running', 'success']);
  assert.equal(runs[0].reason, 'aborted');
});

test('existing five-second polling refreshes mapped task data without navigation and stops after cleanup', async () => {
  const effect = find(view, n => ts.isCallExpression(n) && n.expression.getText(view) === 'useEffect'
    && n.arguments[0]?.getText(view).includes('setMatrixRunningPlatforms') && n.arguments[0].getText(view).includes('setTasks'));
  const updates = [], intervals = [];
  let retries = 1;
  const ctx = vm.createContext({ matrixMode: true, mxTaskToScenario: adapter().mxTaskToScenario,
    window: { electron: { matrix: { listTasks: async () => ({ ok: true, tasks: [{ id: 'a', type: 'comment_like', platform: 'tiktok', retryCount: retries }], runningPlatforms: [] }) } } },
    setTasks: tasks => updates.push(tasks), setMatrixRunningPlatforms() {}, setVideoRunningCount() {},
    videoTaskStore: { getTasks: () => [] }, setView: () => assert.fail('poll must not navigate'),
    setInterval: (callback, ms) => { assert.equal(ms, 5000); intervals.push(callback); return 1; }, clearInterval() {},
  });
  const runEffect = vm.runInContext(compile(`(${effect.arguments[0].getText(view)});`), ctx);
  const cleanup = runEffect();
  await new Promise(setImmediate);
  retries = 2; await intervals[0]();
  assert.equal(updates.length, 2); assert.equal(updates[0][0].id, updates[1][0].id);
  assert.equal(updates[1][0].retry_count, 2);
  cleanup(); await intervals[0](); assert.equal(updates.length, 2);
});
