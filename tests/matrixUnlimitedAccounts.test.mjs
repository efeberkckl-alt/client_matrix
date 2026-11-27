import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';

const read = (path) => readFileSync(new URL(path, import.meta.url), 'utf8');
const view = read('../src/renderer/components/matrix/MatrixView.tsx');
const sidecar = read('../src/main/sidecar-server.ts');

// Execute the production handlers without starting the app, browsers or social actions.
function declaration(source, name) {
  const file = ts.createSourceFile('source.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let found;
  function visit(node) {
    if (ts.isVariableDeclaration(node) && node.name.getText(file) === name) found = node;
    ts.forEachChild(node, visit);
  }
  visit(file);
  assert.ok(found, `production declaration ${name} exists`);
  return { file, node: found };
}

function execute(source, context) {
  const { outputText } = ts.transpileModule(source, { compilerOptions: { target: ts.ScriptTarget.ES2022 } });
  return runInNewContext(outputText, context);
}

test('account creation opens beyond the server plan and 9999 accounts, preserving login/kernel guards', () => {
  const { file, node } = declaration(view, 'openAdd');
  const handler = node.initializer.getText(file);
  for (const count of [2, 10001]) {
    let opened = false;
    let name;
    const context = {
      platform: 'tiktok', ksScope: 'main', maxAccountsPerPlatform: 2,
      accounts: Array.from({ length: count }, (_, i) => ({ id: `tiktok_${i}`, platform: 'tiktok' })),
      requireLogin: () => true, requireKernel: () => true,
      i18nService: { t: () => 'Account {n}' }, uiDefaultContentLang: () => 'en',
      CRYPTO_TRACK_PLATFORMS: new Set(), trackPresets: [], DEFAULT_TRACK: '',
      resetLocale: () => {},
      setNewName: (value) => { name = value; },
      setShowAdd: (value) => { opened = value; },
      setConfirmDlg: () => assert.fail('account count must not show an upgrade gate'),
    };
    for (const setter of ['setEditId', 'setNewScope', 'setNewContentLang', 'setAddStep', 'setProxyForm',
      'setProxyMsg', 'setPendingProxySave', 'setProxyBusy', 'setTrackOpen', 'setNotice']) context[setter] = () => {};
    execute(`(${handler})();`, context);
    assert.equal(opened, true);
    assert.equal(name, `Account ${count + 1}`);
    for (const guard of ['requireLogin', 'requireKernel']) {
      opened = false;
      execute(`(${handler})();`, { ...context, [guard]: () => false });
      assert.equal(opened, false, `${guard} still protects creation`);
    }
  }
});

test('task selection keeps every selected valid account, excluding deleted, other-platform and mid-login accounts', () => {
  const first = declaration(sidecar, 'platformAccts');
  const last = declaration(sidecar, 'accN');
  const selection = sidecar.slice(first.node.parent.parent.getStart(first.file), last.node.parent.parent.getStart(last.file));
  for (const count of [3, 10001]) {
    const accounts = Array.from({ length: count }, (_, i) => ({ id: `tiktok_${i}`, platform: 'tiktok' }));
    const ids = execute(`${selection}\nrunIds;`, {
      platform: 'tiktok', loadAccounts: () => [...accounts, { id: 'douyin_1', platform: 'douyin' }],
      task: { accountIds: [...accounts.map((a) => a.id), 'deleted_account', 'douyin_1'] },
      matrixScanWatching: new Set(['tiktok_1']), coworkLog: () => {},
      planLimit: { maxAccountsPerPlatform: 2 },
    });
    assert.deepEqual(Array.from(ids), accounts.filter((a) => a.id !== 'tiktok_1').map((a) => a.id));
  }
});
