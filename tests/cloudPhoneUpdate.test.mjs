import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { runInNewContext } from 'node:vm';
import { transform } from 'esbuild';

const compile = async (name) => (await transform(readFileSync(new URL(`../src/renderer/components/mobile/${name}.ts`, import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs' })).code;
const sharedCode = await compile('cloudPhoneShared');
const batchCode = await compile('cloudPhoneBatch');

// All API requests go to this in-memory responder; no phone or remote task is touched.
function harness(respond = () => { throw new Error('Unexpected API request'); }) {
  const shared = { exports: {} };
  runInNewContext(sharedCode, {
    module: shared, exports: shared.exports, AbortController, setTimeout, clearTimeout,
    fetch: async (url, init) => {
      assert.ok(url.startsWith('https://offline.invalid/api/mobile-console/'));
      return { ok: true, status: 200, json: async () => respond(url, init) };
    },
    require: (id) => ({
      '../../services/i18n': { i18nService: { currentLanguage: 'en' } },
      '../../services/endpoints': { getBackendApiUrl: () => 'https://offline.invalid' },
      '../../services/noobclawAuth': { noobClawAuth: { getAuthHeaders: () => ({}) } },
    })[id],
  });
  const batch = { exports: {} };
  runInNewContext(batchCode, { module: batch, exports: batch.exports, require: (id) => {
    assert.equal(id, './cloudPhoneShared');
    return shared.exports;
  } });
  return { ...shared.exports, ...batch.exports };
}

test('cloud phone platforms, platform-specific eligibility and random schedule work together', () => {
  const api = harness();
  assert.deepEqual(Array.from(api.visiblePlatforms([]), (p) => p.id), ['tiktok', 'douyin', 'xhs']);
  assert.deepEqual(Array.from(api.scriptsFor('douyin')), ['douyin_auto_engage', 'douyin_lead_engage']);
  assert.deepEqual(Array.from(api.scriptsFor('xhs')), ['xhs_auto_engage', 'xhs_lead_engage']);
  const phone = { online: true, a11y: true, apps: { tiktok: false, douyin: true, xhs: true }, accounts: { douyin: { handle: 'dy' }, xhs: { handle: 'red' } } };
  assert.equal(api.createBlock(phone, 'douyin', 'Douyin'), '');
  assert.equal(api.createBlock(phone, 'xhs', 'RedNote'), '');
  assert.equal(api.createBlock(phone, 'tiktok', 'TikTok'), 'TikTok not installed');
  assert.match(api.scheduleText({ kind: 'random', from: '09:00', to: '22:00' }), /09:00.*22:00/);
});

test('batch creation uses fresh data, preserves other platforms, and refuses incomplete task lists', async () => {
  const writes = [];
  let complete = true;
  const originals = [
    { id: 'tt', platform: 'tiktok', script_id: 'tiktok_comment_like', config: { keep: 'TikTok' } },
    { id: 'dy', platform: 'douyin', script_id: 'douyin_auto_engage' },
    { id: 'red', platform: 'xhs', script_id: 'xhs_auto_engage', config: { keep: 'RedNote' } },
  ];
  const api = harness((url, init) => {
    if (init?.method === 'PUT') { writes.push(JSON.parse(init.body).tasks); return {}; }
    assert.ok(!init?.method);
    return { device: { id: 'phone', online: true, running: false, tasks: originals.map((raw) => complete ? { ...raw, raw } : { ...raw }) } };
  });
  const stalePhone = { id: 'phone', online: true, tasks: [] };
  await api.batchCreate(stalePhone, 'douyin', { id: 'template', script_id: 'douyin_lead_engage' });
  assert.equal(writes.length, 1);
  assert.deepEqual(writes[0].filter((t) => t.platform !== 'douyin'), [originals[0], originals[2]]);
  assert.equal(writes[0].filter((t) => t.platform === 'douyin').length, 1);
  assert.equal(writes[0].at(-1).script_id, 'douyin_lead_engage');
  complete = false;
  await assert.rejects(api.batchCreate(stalePhone, 'douyin', { id: 'template' }), /server_outdated/);
  assert.equal(writes.length, 1, 'incomplete server data must never overwrite tasks');
});
