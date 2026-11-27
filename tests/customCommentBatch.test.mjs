import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const built = await build({ entryPoints: [fileURLToPath(new URL('../src/main/libs/matrix/customCommentBatch.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
const module = { exports: {} };
new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
const { CustomCommentBatch, withCustomCommentBatch } = module.exports;
const post = (id, text) => ({ url: `https://www.tiktok.com/@source/video/${id}`, text });
const key = (id, text) => JSON.stringify([String(id), text]);
const before = { author: 'runner', count: 0, ids: [] };
const after = { author: 'runner', count: 1, ids: ['12345'] };
function directory(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'comment-batch-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

test('reimport and rebuilt tasks retain confirmed and uncertain comments; only never-sent entries are assigned', async t => {
  const root = directory(t), posts = [post(1, 'a'), post(1, 'b'), post(2, 'c')];
  await withCustomCommentBatch(root, posts, async batch => {
    const plan = batch.plan(['one']);
    assert.equal(plan.owners.get(key(1, 'a')), 'one');
    batch.prepare(key(1, 'a'), 'one', before);
    batch.confirm(key(1, 'a'), 'one', after, 'same_page');
    batch.prepare(key(1, 'b'), 'one', before);
  });
  await withCustomCommentBatch(root, posts.toReversed(), async batch => {
    assert.deepEqual(batch.summary(), { total: 3, confirmed: 1, pending: 1, remaining: 1 });
    const plan = batch.plan(['three']);
    assert.deepEqual(plan.assignments.get('three'), [post(2, 'c')]);
  });
  await withCustomCommentBatch(root, [...posts, post(3, 'd')], async batch => {
    assert.deepEqual(batch.summary(), { total: 4, confirmed: 1, pending: 1, remaining: 2 });
  });
});

test('old task ledgers migrate without changing old files and do not import unrelated comments', t => {
  const root = directory(t), legacyDir = path.join(root, 'state', 'tiktok', 'tasks', 'deleted-task');
  fs.mkdirSync(legacyDir, { recursive: true });
  const original = JSON.stringify({ [key(1, 'a')]: 'confirmed', [key(1, 'b')]: 'pending', [key(9, 'unrelated')]: 'confirmed' });
  const legacy = path.join(legacyDir, 'custom_video_comments.json');
  fs.writeFileSync(legacy, original);
  const batch = new CustomCommentBatch(root, [post(1, 'a'), post(1, 'b'), post(2, 'c')]);
  assert.deepEqual(batch.readLedger(), { [key(1, 'a')]: 'confirmed', [key(1, 'b')]: 'pending' });
  assert.deepEqual(batch.pendingFor('one'), []);
  assert.throws(() => batch.confirm(key(1, 'b'), 'one', after, 'reopened'), /原执行账号/);
  assert.equal(fs.readFileSync(legacy, 'utf8'), original);
});

test('overlapping workbook runs are rejected before execution and the guard releases on failure', async t => {
  const root = directory(t), posts = [post(1, 'a')];
  await withCustomCommentBatch(root, posts, async () => {
    let called = false;
    await assert.rejects(withCustomCommentBatch(root, [post(2, 'b')], async () => { called = true; }), /已有表格评论任务/);
    assert.equal(called, false);
  });
  await assert.rejects(withCustomCommentBatch(root, posts, async () => { throw Error('interrupted'); }), /interrupted/);
  await withCustomCommentBatch(root, posts, async batch => assert.equal(batch.summary().remaining, 1));
});

test('damaged records fail closed, confirmed cannot regress, and confirmation requires prior send intent', async t => {
  const root = directory(t), posts = [post(1, 'a')];
  const batch = new CustomCommentBatch(root, posts);
  assert.throws(() => batch.confirm(key(1, 'a'), 'one', after, 'same_page'), /发送意图/);
  batch.prepare(key(1, 'a'), 'one', before);
  batch.confirm(key(1, 'a'), 'one', after, 'same_page');
  assert.throws(() => batch.prepare(key(1, 'a'), 'one', before), /重复发送/);
  assert.throws(() => batch.prepare(key(9, 'b'), 'one', before), /不属于/);
  fs.writeFileSync(batch.file, '{bad json');
  let called = false;
  await assert.rejects(withCustomCommentBatch(root, posts, async () => { called = true; }));
  assert.equal(called, false);
});

test('remaining comment ownership is retained and an absent account can transfer only never-sent work', t => {
  const root = directory(t), posts = [post(1, 'a'), post(1, 'b'), post(2, 'c')];
  const batch = new CustomCommentBatch(root, posts);
  const saved = { version: 2, owners: { [key(1, 'a')]: 'one', [key(1, 'b')]: 'one', [key(2, 'c')]: 'two' } };
  batch.prepare(key(1, 'a'), 'one', before);
  const resumed = new CustomCommentBatch(root, posts);
  const plan = resumed.plan(['two', 'three'], saved, undefined, () => 0);
  assert.equal(plan.owners.get(key(1, 'a')), 'one');
  assert.deepEqual(plan.assignments.get('three'), [post(1, 'b')]);
  assert.deepEqual(plan.assignments.get('two'), [post(2, 'c')]);
  assert.equal(resumed.summary().pending, 1);
});

test('version-one exclusive video plans redistribute only never-sent comments and retain the original ledger intact', t => {
  const root = directory(t), posts = ['sent', 'uncertain', 'a', 'b', 'c', 'd'].map(text => post(1, text));
  const batch = new CustomCommentBatch(root, posts);
  batch.prepare(key(1, 'sent'), 'one', before);
  batch.confirm(key(1, 'sent'), 'one', after, 'same_page');
  batch.prepare(key(1, 'uncertain'), 'one', before);
  const old = JSON.parse(fs.readFileSync(batch.file, 'utf8'));
  old.owners = { '1': 'one' };
  const oldText = JSON.stringify(old);
  fs.writeFileSync(batch.file, oldText);
  const migrated = new CustomCommentBatch(root, posts, { readOnly: true });
  const plan = migrated.plan(['one', 'two']);
  assert.equal(plan.owners.get(key(1, 'sent')), 'one');
  assert.equal(plan.owners.get(key(1, 'uncertain')), 'one');
  assert.equal(plan.assignments.get('one').length, 2);
  assert.equal(plan.assignments.get('two').length, 2);
  assert.equal(migrated.pendingFor('one').length, 1);
  assert.equal(migrated.pendingFor('two').length, 0);
  assert.equal(fs.readFileSync(batch.file, 'utf8'), oldText);
});

test('pending recovery requires the original account and new evidence; legacy records stay unresolved', t => {
  const root = directory(t), posts = [post(1, 'a')];
  const batch = new CustomCommentBatch(root, posts);
  batch.prepare(key(1, 'a'), 'one', before);
  const reopened = new CustomCommentBatch(root, posts);
  assert.equal(reopened.pendingFor('two').length, 0);
  assert.deepEqual(reopened.pendingFor('one'), [{ ...posts[0], before }]);
  assert.throws(() => reopened.confirm(key(1, 'a'), 'two', after, 'reopened'), /原执行账号/);
  assert.throws(() => reopened.confirm(key(1, 'a'), 'one', before, 'reopened'), /新评论证据/);
  assert.throws(() => reopened.confirm(key(1, 'a'), 'one', { ...after, author: 'someone_else' }, 'reopened'), /新评论证据/);
  assert.equal(reopened.summary().pending, 1);
  reopened.confirm(key(1, 'a'), 'one', after, 'reopened');
  assert.equal(new CustomCommentBatch(root, posts).summary().confirmed, 1);
  const saved = JSON.parse(fs.readFileSync(batch.file, 'utf8'));
  assert.equal(saved.entries[key(1, 'a')].verification.source, 'reopened');
});

test('disk replacement failure cannot advance in-memory send or confirmation state', t => {
  const root = directory(t), posts = [post(1, 'a')];
  const batch = new CustomCommentBatch(root, posts);
  const rename = fs.renameSync;
  const failWrite = operation => {
    fs.renameSync = () => { throw Error('simulated disk replacement failure'); };
    try { assert.throws(operation, /disk replacement failure/); }
    finally { fs.renameSync = rename; }
  };
  failWrite(() => batch.prepare(key(1, 'a'), 'one', before));
  assert.equal(batch.summary().remaining, 1);
  assert.equal(new CustomCommentBatch(root, posts).summary().remaining, 1);
  batch.prepare(key(1, 'a'), 'one', before);
  failWrite(() => batch.confirm(key(1, 'a'), 'one', after, 'same_page'));
  assert.equal(batch.summary().confirmed, 0);
  assert.equal(batch.summary().pending, 1);
  assert.equal(new CustomCommentBatch(root, posts).summary().pending, 1);
  assert.equal(fs.readdirSync(path.dirname(batch.file)).filter(name => name.endsWith('.tmp')).length, 0);
});
