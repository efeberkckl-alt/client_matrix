import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { transform } from 'esbuild';

const moduleSource = await readFile(new URL('../src/main/libs/matrix/leadEngageConfig.ts', import.meta.url), 'utf8');
const { code } = await transform(moduleSource, { loader: 'ts', format: 'esm' });
const { leadEngageConfig } = await import(`data:text/javascript;base64,${Buffer.from(code).toString('base64')}`);

// Snapshot of the real server orchestrator retrieved on 2026-11-01.
// Only browser/UI helpers are replaced; collection, batching, queues and quotas run unchanged.
const script = await readFile(new URL('fixtures/tiktok-lead-engage.js', import.meta.url), 'utf8');
const marker = "await ensureTaskTabOpenedOnce('tiktok', 'main', 'https://www.tiktok.com/');";
assert.equal(script.split(marker).length, 2);
const simulatedBrowser = `
var testPage = 0, testUrl = '';
ensureTaskTabOpenedOnce = async function () {};
_navigate = async function (url) { testUrl = url; };
getUrl = async function () { return testUrl; };
jsleep = async function () {};
sleepWithHeartbeat = async function () {};
waitWithHold = async function () {};
captchaGate = async function () { return true; };
ensureCommentsOpen = async function () { return true; };
holdVideo = async function () {};
driftedFrom = async function () { return false; };
getText = async function () { return 'A product demonstration'; };
getTexts = async function () { return []; };
collectVideoLinksOnPage = async function () { return ['https://www.tiktok.com/@source/video/1']; };
harvestCommentHandles = async function () {
  return ctx.candidates.slice(testPage * 100, (testPage + 1) * 100);
};
commentPanelState = async function () {
  return { top: testPage * 100, bottom: (testPage + 1) * 100 >= ctx.candidates.length };
};
scrollCommentPanel = async function () { testPage++; return true; };
waitReady = async function (kind, maxMs, owner) {
  return kind === 'profile' ? 'v:https://www.tiktok.com/@' + owner + '/video/123' : true;
};
probeUserGone = async function () { return false; };
openCardOnProfile = async function (url) { testUrl = url; return true; };
tryLike = async function () { return { ok: true }; };
tryFollowOnProfile = async function () { return { ok: true }; };
tryComment = async function () { return { ok: true }; };
goNextInModal = async function () { return false; };
reenterAt = async function (entry, vid) {
  testUrl = 'https://www.tiktok.com/@source/video/' + vid;
  return true;
};
`;
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runScript = new AsyncFunction('ctx', script.replace(marker, simulatedBrowser + '\n' + marker));

async function simulate(limit, comments, candidates = 650, saved = {}, adapt = true, mode = 'accounts', likes = true) {
  const counts = {};
  const states = structuredClone(saved);
  const config = { behavior: {
    lead_unlimited: true, lead_batch_size: 200, work_link_then_author: false,
    harvest_comment_like: false, cmt_topup: false,
  } };
  const ctx = {
    task: {
      mode, seed_accounts: ['https://www.tiktok.com/@source/video/1'], keywords: ['skincare'],
      max_leads: limit, leads_per_run: limit,
      max_likes: likes ? 5000 : 0, max_follows: 0, max_comments: comments,
      lead_do_like: likes, lead_do_follow: false, lead_do_comment: comments > 0,
    },
    config: adapt ? leadEngageConfig(config) : config,
    manifest: { default_config: {}, risk_caps: {} },
    candidates: Array.from({ length: candidates }, (_, i) => ({ h: `lead_${i}`, n: `Lead ${i}` })),
    browser: async () => ({}), navigate: async () => {}, sleep: async () => {},
    aborted: () => false, report() {}, stepStart() {}, stepLog() {}, stepDone() {}, finish() {},
    setActionTargets() {},
    addActionCount(key, n) { counts[key] = (counts[key] || 0) + n; },
    readState(key) { return structuredClone(states[key] || null); },
    writeState(key, value) { states[key] = structuredClone(value); return { ok: true }; },
    chargeAction: async () => ({ ok: true, charged: 0 }),
    writeReport: async () => ({ ok: true, path: 'simulated-report' }),
  };
  await runScript(ctx);
  const leads = Object.values(states.lead_ledger?.leads || {});
  return { counts, states, collected: leads.length, reached: leads.filter((lead) => lead.engagedDone).length };
}

test('real orchestrator caps each account at the chosen lead count; comments retain a separate quota', async () => {
  // Prove this check catches the original remote lead_unlimited bug.
  const before = await simulate(500, 50, 650, {}, false);
  assert.equal(before.collected, 650);
  const after = await simulate(500, 50);
  assert.equal(after.collected, 500);
  assert.equal(after.counts.lead_new, 500);
  assert.equal(after.reached, 500);
  assert.equal(after.counts.comment, 50); // Includes multiple collect/reach batches.
  const keywordRun = await simulate(500, 50, 650, {}, true, 'keywords');
  assert.equal(keywordRun.collected, 500);
  assert.equal(keywordRun.reached, 500);
  assert.equal(keywordRun.counts.comment, 50);
  const commentOnly = await simulate(500, 50, 650, {}, true, 'accounts', false);
  assert.equal(commentOnly.collected, 500);
  assert.equal(commentOnly.reached, 50);
  assert.equal(commentOnly.counts.comment, 50);
  const otherAccount = await simulate(500, 50);
  assert.equal(otherAccount.reached, 500); // Separate per-account allowance.
  const rerun = await simulate(500, 50, 650, after.states);
  assert.equal(rerun.counts.lead_new, 150); // Historical leads do not spend the new-run cap.
  assert.equal(rerun.reached, 650);
  assert.equal(rerun.counts.comment, 50);
});

test('small limits, missing leads and disabled comments finish without exceeding quotas', async () => {
  for (const [limit, comments, available] of [[1, 50, 650], [3, 50, 650], [501, 0, 650], [500, 50, 12], [500, 50, 0]]) {
    const result = await simulate(limit, comments, available);
    assert.equal(result.collected, Math.min(limit, available));
    assert.equal(result.reached, Math.min(limit, available));
    assert.equal(result.counts.comment || 0, Math.min(limit, comments, available));
  }
  const original = { behavior: { lead_unlimited: true, lead_batch_size: 200 }, language_modes: { en: {} } };
  const changed = leadEngageConfig(original);
  assert.equal(original.behavior.lead_unlimited, true);
  assert.equal(changed.behavior.lead_unlimited, false);
  assert.equal(changed.behavior.lead_batch_size, 200);
  assert.equal(changed.language_modes, original.language_modes);
});
