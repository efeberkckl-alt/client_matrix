import type { AssociationFence } from './accountManager';
import { clearManuallyReviewedForbidden, commitInteractiveFirstBinding, findAccountByUid, getAccount, isCurrentAssociation, platformKey } from './accountManager';
import { AUTOMATION_RESTRICTION_EXPR, automationSafety } from './automationSafety';
import { checkKernelLogin, kernelEval, kernelReadIdentity, navigateForAccountReview } from './kernelPool';

// Server-owned normal destinations. A renderer-supplied login URL or a 200 on
// a login/verification redirect is never evidence of recovery.
const reviewHomes: Record<string, string> = {
  tiktok: 'https://www.tiktok.com/', douyin: 'https://www.douyin.com/', xhs: 'https://www.xiaohongshu.com/',
  bilibili: 'https://www.bilibili.com/', kuaishou: 'https://www.kuaishou.com/',
  kuaishou_creator: 'https://cp.kuaishou.com/profile', x: 'https://x.com/home',
  binance: 'https://www.binance.com/zh-CN/square', youtube: 'https://www.youtube.com/',
  shipinhao: 'https://channels.weixin.qq.com/', toutiao: 'https://mp.toutiao.com/',
  instagram: 'https://www.instagram.com/', facebook: 'https://www.facebook.com/', reddit: 'https://www.reddit.com/',
  gate: 'https://www.gate.com/post', bitget: 'https://www.bitget.com/insights',
  bybit: 'https://www.bybit.com/social/', okx: 'https://www.okx.com/orbit',
};

const labels: Record<string, string> = {
  forbidden: '页面仍提示平台拒绝访问', captcha: '页面仍要求验证码',
  login_wall: '页面仍要求登录或验证', account_flag: '页面仍提示账号操作受限',
  rate_limited: '页面仍提示访问频率受限',
};

function normalPage(home: string, href: string | undefined): boolean {
  if (!href) return false;
  try {
    const target = new URL(home), actual = new URL(href);
    const normalize = (p: string) => p.replace(/\/$/, '');
    return !actual.username && !actual.password && actual.origin === target.origin
      && normalize(actual.pathname) === normalize(target.pathname);
  } catch { return false; }
}

export async function reviewMatrixAccount(fence: AssociationFence, mode: 'forbidden' | 'first_binding') {
  const acc = getAccount(fence.accountId);
  if (!acc?.authority || !isCurrentAssociation(fence) || fence.attemptId) throw Error('navigation:cancelled');
  const { id } = acc;
  const platform = platformKey(acc);
  if (!Object.hasOwn(reviewHomes, platform)) throw Error('此平台没有可安全复核的正常页面');
  const home = reviewHomes[platform];
  const revision = acc.authority.revision;
  const forbiddenEvidence = mode === 'forbidden' ? automationSafety.captureForbiddenReviewEvidence() : undefined;
  let document = await navigateForAccountReview(id, home);
  const current = () => {
    if (!isCurrentAssociation(fence) || getAccount(id)?.authority?.revision !== revision) throw Error('navigation:cancelled');
    document.assertCurrent();
  };
  current();
  if (!normalPage(home, document.url)) throw Error('平台未打开指定的正常页面，无法确认访问恢复');
  const checkRestriction = async () => {
    const restriction = await kernelEval(id, AUTOMATION_RESTRICTION_EXPR, 5000);
    current();
    if (restriction !== '') throw Error(typeof restriction === 'string' && Object.hasOwn(labels, restriction)
      ? labels[restriction] : '无法确定页面没有限制，请检查页面后重试');
  };
  await checkRestriction();
  const loggedIn = await checkKernelLogin(id, platform);
  current();
  if (loggedIn !== true) throw Error(loggedIn === false ? '未检测到登录，请先在窗口中完成登录' : '登录检测未完成，请检查页面后重试');
  // The existing identity reader may need one same-site, read-only self-profile hop.
  // Prove that hop separately and never reuse the homepage login result for a new document.
  const originalGeneration = document.generation;
  let identityFailure: unknown;
  const identity = await kernelReadIdentity(id, platform, async target => {
    try {
      current();
      if (new URL(target).origin !== new URL(home).origin) throw Error('身份页面跳转到非预期站点');
      document = await navigateForAccountReview(id, target);
      current();
      if (!normalPage(target, document.url) || new URL(document.url!).search !== new URL(target).search) {
        throw Error('未打开本人的身份页面');
      }
    } catch (error) { identityFailure = error; throw error; }
  });
  if (identityFailure) throw identityFailure;
  if (document.generation !== originalGeneration) {
    await checkRestriction();
    const finalLogin = await checkKernelLogin(id, platform);
    current();
    if (finalLogin !== true) throw Error('无法在身份页面确认仍登录，请重新复核');
  }
  current();
  const uid = typeof identity.uid === 'string' ? identity.uid.trim() : '';
  if (!uid || identity.observed?.generation !== document.generation || identity.observed?.connectionEpoch !== document.connectionEpoch) {
    throw Error('未能在本次页面确认唯一账号身份');
  }
  if (findAccountByUid(platform, uid, id)) throw Error('该身份已绑定其他窗口，原限制保留');
  await checkRestriction();
  const result = mode === 'forbidden'
    ? clearManuallyReviewedForbidden(fence, revision, uid, current, forbiddenEvidence!)
    : commitInteractiveFirstBinding(fence, { nickname: identity.nickname, displayId: identity.displayId, avatar: identity.avatar, boundUid: uid });
  if (!result) throw Error('navigation:cancelled');
  const saved = getAccount(id);
  return { ok: true, loggedIn: true, available: result.available === true, status: result.status ?? saved?.status,
    statusReason: saved?.statusReason, nickname: saved?.nickname, displayId: saved?.displayId, avatar: saved?.avatar };
}
