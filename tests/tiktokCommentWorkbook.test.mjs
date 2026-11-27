import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import ExcelJS from 'exceljs';
import { build } from 'esbuild';

async function load(file) {
  const built = await build({ entryPoints: [fileURLToPath(new URL(file, import.meta.url))], bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false });
  const module = { exports: {} };
  new Function('require', 'module', 'exports', built.outputFiles[0].text)(createRequire(import.meta.url), module, module.exports);
  return module.exports;
}
const { readTikTokCommentWorkbook } = await load('../src/renderer/services/tiktokCommentWorkbook.ts');
const { validatedCommentPosts } = await load('../src/types/matrixCommentPosts.ts');
const { commentWorkbookContent } = await load('../src/types/matrixCommentPlan.ts');
const url = 'https://www.tiktok.com/@user/video/123';

test('every sheet is reported, header positions vary, and missing headers are never silently omitted', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('First').addRows([['视频链接', '自评话术'], [url, '1. first\n2. second']]);
  book.addWorksheet('Second').addRows([['视频链接', '国家', '类型', '其他', '评论内容'], [url, 'US', 'self', '', '1. third']]);
  book.addWorksheet('Wrong headers').addRows([['地址', '文字'], [url, 'missing']]);
  book.addWorksheet('Empty');
  const result = await readTikTokCommentWorkbook(await book.xlsx.writeBuffer());
  assert.deepEqual(result.sheets, [
    { name: 'First', videos: 1, comments: 2, issues: 0 },
    { name: 'Second', videos: 1, comments: 1, issues: 0 },
    { name: 'Wrong headers', videos: 0, comments: 0, issues: 1 },
    { name: 'Empty', videos: 0, comments: 0, issues: 1 },
  ]);
  assert.equal(result.posts.length, 3);
  assert.deepEqual(result.posts[2].sources, [{ sheet: 'Second', row: 2, column: 5, comment: 1 }]);
  assert.deepEqual(result.issues.map(issue => issue.reason), ['headers', 'headers']);
});

test('cross-sheet duplicates merge their provenance while different videos retain the same text', async () => {
  const book = new ExcelJS.Workbook();
  book.addWorksheet('One').addRows([['视频链接', '自评话术'], [url, '1. shared']]);
  book.addWorksheet('Two').addRows([['视频链接', '自评话术'], ['https://m.tiktok.com/@other/video/123?lang=en', '1. shared'], ['https://www.tiktok.com/@user/video/456', '1. shared']]);
  const { posts } = await readTikTokCommentWorkbook(await book.xlsx.writeBuffer());
  assert.equal(posts.length, 2);
  assert.deepEqual(posts[0].sources.map(source => source.sheet), ['One', 'Two']);
  const copied = validatedCommentPosts(JSON.parse(JSON.stringify([...posts, posts[0]])));
  assert.equal(copied[0].sources.length, 2);
  assert.equal(commentWorkbookContent(posts), commentWorkbookContent(posts.map(({ url, text }) => ({ url, text }))));
  assert.throws(() => validatedCommentPosts([{ url, text: 'valid', sources: [{ sheet: 'One', row: -1, column: 2, comment: 1 }] }]), /invalid_posts/);
});
