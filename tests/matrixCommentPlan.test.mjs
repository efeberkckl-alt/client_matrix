import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { build } from 'esbuild';

const built = await build({
  entryPoints: [fileURLToPath(new URL('../src/types/matrixCommentPlan.ts', import.meta.url))],
  bundle: true, platform: 'node', format: 'esm', write: false,
});
const { planCommentAssignments, commentPostKey, commentVideoId, commentWorkbookContent, commentAssignmentRandom } = await import(
  `data:text/javascript;base64,${Buffer.from(built.outputFiles[0].text).toString('base64')}`
);
const post = (video, text) => ({ url: `https://www.tiktok.com/@creator/video/${video}`, text });

test('five comments are split 3/2 with varying text and extra account, and preserve workbook execution order', () => {
  const posts = ['a', 'b', 'c', 'd', 'e'].map(text => post(1, text));
  const extras = new Set();
  const selections = new Set();
  for (let index = 0; index < 32; index++) {
    const random = commentAssignmentRandom(String(index));
    const plan = planCommentAssignments({ posts, accountIds: ['b', 'a', 'b'], random });
    const a = plan.assignments.get('a'), b = plan.assignments.get('b');
    assert.deepEqual([a.length, b.length].sort(), [2, 3]);
    assert.deepEqual(a, posts.filter(item => plan.owners.get(commentPostKey(item)) === 'a'));
    assert.equal(new Set([...a, ...b]).size, posts.length);
    extras.add(a.length === 3 ? 'a' : 'b');
    selections.add(a.map(item => item.text).join(''));
  }
  assert.equal(extras.size, 2);
  assert.ok(selections.size > 8);
});

test('account order and resume preserve owners; only an unavailable account’s unrecorded comments move', () => {
  const posts = ['a', 'b', 'c', 'd', 'e', 'f'].map(text => post(1, text));
  const initial = planCommentAssignments({ posts, accountIds: ['a', 'b', 'c'], random: commentAssignmentRandom('draft') });
  const resumed = planCommentAssignments({ posts, accountIds: ['c', 'b', 'a'], previousOwners: initial.owners });
  assert.deepEqual(resumed.owners, initial.owners);
  const [pending, move] = initial.assignments.get('a').map(commentPostKey);
  const takeover = planCommentAssignments({
    posts, accountIds: ['b', 'c'], previousOwners: initial.owners, recordedOwners: new Map([[pending, 'a']]),
  });
  for (const [key, owner] of initial.owners) {
    if (key !== move) assert.equal(takeover.owners.get(key), owner);
  }
  assert.ok(['b', 'c'].includes(takeover.owners.get(move)));
  assert.equal([...takeover.assignments.values()].flat().length, 5);
});

test('more accounts than comments select different subsets without copying; single and zero accounts are explicit', () => {
  const posts = [post(1, 'first'), post(1, 'second')];
  const subsets = new Set();
  for (let index = 0; index < 16; index++) {
    const plan = planCommentAssignments({ posts, accountIds: ['a', 'b', 'c', 'd'], random: commentAssignmentRandom(String(index)) });
    assert.deepEqual([...plan.assignments.values()].map(items => items.length).sort(), [0, 0, 1, 1]);
    assert.equal(new Set([...plan.assignments.values()].flat()).size, 2);
    subsets.add([...plan.assignments].filter(([, items]) => items.length).map(([id]) => id).join(''));
  }
  assert.ok(subsets.size > 1);
  const single = planCommentAssignments({ posts, accountIds: ['a'] });
  assert.deepEqual(single.assignments.get('a'), posts);
  const unavailable = planCommentAssignments({ posts, accountIds: [] });
  assert.deepEqual(unavailable.unassigned, posts);
  assert.equal(unavailable.owners.size, 0);
});

test('same workbook content has one identity after reordering, URL normalization, and duplicate rows', () => {
  const original = [post(1, 'hello'), post(2, 'hello')];
  const reimported = [
    post(2, 'hello'),
    { url: 'https://m.tiktok.com/@renamed/video/1?source=sheet', text: ' hello ' },
    post(1, 'hello'),
  ];
  assert.equal(commentWorkbookContent(original), commentWorkbookContent(reimported));
  assert.notEqual(commentWorkbookContent(original), commentWorkbookContent([post(1, 'changed'), post(2, 'hello')]));
  assert.notEqual(commentPostKey(post(1, 'hello')), commentPostKey(post(2, 'hello')));
  assert.throws(() => commentWorkbookContent([{ url: 'not a video', text: 'hello' }]), /invalid_posts/);
});

test('the supplied four-sheet workbook is evenly distributed per video and across the workbook', async (t) => {
  const filename = process.env.TIKTOK_COMMENT_TEST_WORKBOOK;
  if (!filename) { t.skip('Set TIKTOK_COMMENT_TEST_WORKBOOK to run the user workbook check'); return; }
  const workbookBuild = await build({
    entryPoints: [fileURLToPath(new URL('../src/renderer/services/tiktokCommentWorkbook.ts', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false,
  });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', workbookBuild.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  const bytes = await readFile(filename);
  const imported = await module.exports.readTikTokCommentWorkbook(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength));
  assert.equal(imported.posts.length, 250);
  assert.equal(imported.issues.length, 8);
  assert.equal(imported.sheets.length, 4);
  assert.deepEqual(imported.sheets.map(sheet => [sheet.videos, sheet.comments, sheet.issues]), [[28, 140, 0], [16, 80, 3], [1, 5, 5], [5, 25, 0]]);
  assert.deepEqual(imported.sheets.map(sheet => [...new Set(imported.posts.flatMap(post => (post.sources || []).filter(source => source.sheet === sheet.name).map(source => source.column)))]), [[2], [2], [6], [5]]);
  const videos = [...new Set(imported.posts.map(commentVideoId))];
  assert.equal(videos.length, 50);
  for (const accountIds of [['one'], ['one', 'two'], ['one', 'two', 'three'], ['a', 'b', 'c', 'd', 'e', 'f']]) {
    const plan = planCommentAssignments({ posts: imported.posts, accountIds, random: commentAssignmentRandom('sample') });
    const assigned = [...plan.assignments.values()];
    const totals = assigned.map(items => items.length);
    assert.ok(Math.max(...totals) - Math.min(...totals) <= 1);
    for (const video of videos) {
      const counts = assigned.map(items => items.filter(post => commentVideoId(post) === video).length);
      assert.ok(Math.max(...counts) - Math.min(...counts) <= 1);
      assert.equal(counts.reduce((sum, count) => sum + count, 0), 5);
    }
    const all = assigned.flat();
    assert.equal(plan.owners.size, 250);
    assert.deepEqual(all.map(commentPostKey).sort(), imported.posts.map(commentPostKey).sort());
    assert.ok(all.every(post => post.sources?.length));
  }
});
