import type { MatrixCommentAIConfig } from '../../../types/matrixCommentAI';

const COMMENT_PROMPTS = new Set(['comment_composer', 'reply_composer', 'comment_intent', 'fan_reply_body', 'funnel_polish', 'funnel_rewrite', 'praise_reply']);
const COMMENT_TASKS = new Set(['rewrite_lead_phrase', 'reply_to_xhs_article_and_comments', 'compose_square_reply']);

/** Positive identification: keyword expansion, matching and unknown calls keep their old provider. */
export function isCommentAIRequest(pack: any, name: string, prompt: string, input: string, taskType?: string): boolean {
  if (!['engage', 'lead_engage', 'comment_like', 'reply_fan'].includes(taskType || 'engage')) return false;
  if (taskType === 'reply_fan') return true; // This scenario only generates/rephrases replies.
  if (name !== '__raw__') return COMMENT_PROMPTS.has(name);
  let data: any;
  try { data = JSON.parse(input); } catch { data = null; }
  if (COMMENT_TASKS.has(data?.task)) return true;
  return Object.entries(pack?.prompts || {}).some(([key, value]) => {
    if (!COMMENT_PROMPTS.has(key) || typeof value !== 'string' || !value.trim()) return false;
    // Templates can be filled or have a forced-language rule appended by the scenario.
    const prefix = value.split('{{')[0].trim();
    return prefix.length >= 20 && prompt.trimStart().startsWith(prefix);
  });
}

export async function requestCommentAI(config: MatrixCommentAIConfig, system: string, user: string, wantJson: boolean, signal?: AbortSignal): Promise<string> {
  if (!config.model?.trim() || !config.baseUrl?.trim()) throw new Error('评论 AI 未配置完整：请填写接口地址和模型');
  const url = new URL(config.baseUrl.trim());
  if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('评论 AI 接口地址无效');
  if (!config.apiKey?.trim() && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) throw new Error('评论 AI 未配置 API Key');
  const anthropic = config.apiFormat === 'anthropic';
  const pathname = url.pathname.replace(/\/+$/, '');
  if (anthropic) {
    url.pathname = pathname.endsWith('/messages') ? pathname : pathname + (pathname.endsWith('/v1') ? '/messages' : '/v1/messages');
  } else {
    url.pathname = pathname.endsWith('/chat/completions') ? pathname : pathname + (/\/v\d+(?:beta)?(?:\/openai)?$/.test(pathname) ? '/chat/completions' : '/v1/chat/completions');
  }
  const body: any = {
    model: config.model.trim(), stream: false, max_tokens: 8000,
    ...(anthropic ? { system, messages: [{ role: 'user', content: user }] }
      : { messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }),
  };
  if (!anthropic && wantJson && /json/i.test(system + user)) body.response_format = { type: 'json_object' };
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  if (anthropic) {
    headers['x-api-key'] = config.apiKey.trim();
    headers['anthropic-version'] = '2023-06-01';
  } else if (config.apiKey.trim()) headers.Authorization = `Bearer ${config.apiKey.trim()}`;
  for (let attempt = 1; attempt <= 3; attempt++) {
    signal?.throwIfAborted();
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST', headers, body: JSON.stringify(body),
        signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(90_000)]) : AbortSignal.timeout(90_000),
      });
    } catch {
      signal?.throwIfAborted();
      if (attempt === 3) throw new Error('自定义评论 AI 网络请求失败，未切换到 NoobClaw AI');
      await retryPause(attempt * 2000, signal);
      continue;
    }
    if ((response.status === 429 || response.status >= 500) && attempt < 3) {
      await response.body?.cancel();
      const retry = Number(response.headers.get('retry-after'));
      await retryPause(Number.isFinite(retry) && retry > 0 ? Math.max(retry * 1000, attempt * 2000) : attempt * 2000, signal);
      continue;
    }
    // Do not echo provider bodies: some gateways include request details or keys in errors.
    if (!response.ok) throw new Error(`自定义评论 AI 请求失败 (${response.status})，请检查接口、密钥、模型或余额`);
    let data: any;
    try { data = await response.json(); } catch { throw new Error('自定义评论 AI 返回的不是有效 JSON'); }
    if (data.error) throw new Error('自定义评论 AI 返回错误，请检查服务商配置');
    const content = anthropic
      ? data.content?.filter((block: any) => block.type === 'text').map((block: any) => block.text).join('\n')
      : data.choices?.[0]?.message?.content;
    if (typeof content !== 'string' || !content.trim()) throw new Error('自定义评论 AI 未返回评论正文');
    return content;
  }
  throw new Error('自定义评论 AI 请求失败');
}

function retryPause(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    const abort = () => { clearTimeout(timer); reject(signal?.reason); };
    const timer = setTimeout(() => { signal?.removeEventListener('abort', abort); resolve(); }, ms);
    signal?.addEventListener('abort', abort, { once: true });
  });
}
