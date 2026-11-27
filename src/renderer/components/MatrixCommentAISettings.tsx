import type { AppConfig } from '../config';
import type { MatrixCommentAIConfig } from '../../types/matrixCommentAI';

export const defaultCommentAI: MatrixCommentAIConfig = {
  source: 'noobclaw', baseUrl: 'https://api.deepseek.com', apiKey: '', model: 'deepseek-chat', apiFormat: 'openai',
};

export default function MatrixCommentAISettings({ value, onChange, providers, isEn }: {
  value: MatrixCommentAIConfig;
  onChange: (value: MatrixCommentAIConfig) => void;
  providers: AppConfig['providers'];
  isEn: boolean;
}) {
  const text = (zh: string, en: string) => isEn ? en : zh;
  const field = 'w-full rounded-lg border dark:border-claude-darkBorder border-claude-border dark:bg-claude-darkSurface bg-claude-surface px-3 py-2 text-sm dark:text-claude-darkText text-claude-text';
  const update = (patch: Partial<MatrixCommentAIConfig>) => onChange({ ...value, ...patch });
  const savedProviders = Object.entries(providers || {}).filter(([key, provider]) => !key.startsWith('noobclaw') && provider.apiKey?.trim());
  return (
    <div className="space-y-5 dark:text-claude-darkText text-claude-text">
      <p className="text-sm dark:text-claude-darkTextSecondary text-claude-textSecondary">
        {text('仅用于浏览器矩阵的评论、回复及相关改写。AI 对话、内容创作、关键词扩展、云手机等保持原设置。保存后从下一次账号运行开始生效。', 'Only browser-matrix comments, replies and their rewrites use this setting. Chat, content creation, keyword expansion and cloud phones keep their existing settings. Applies to the next account run.')}
      </p>
      <label className="block space-y-2" htmlFor="comment-ai-source">
        <span className="text-sm font-medium">{text('评论 AI 来源', 'Comment AI source')}</span>
        <select id="comment-ai-source" className={field} value={value.source} onChange={(e) => update({ source: e.target.value as MatrixCommentAIConfig['source'] })}>
          <option value="noobclaw">{text('使用 NoobClaw 服务器的 AI（默认）', 'Use NoobClaw AI (default)')}</option>
          <option value="custom">{text('使用我配置的 AI', 'Use my configured AI')}</option>
        </select>
      </label>
      {value.source === 'custom' && <>
        {savedProviders.length > 0 && <label className="block space-y-2" htmlFor="comment-ai-load-provider">
          <span className="text-sm font-medium">{text('从已有 AI 配置载入（可选）', 'Load a saved AI configuration (optional)')}</span>
          <select id="comment-ai-load-provider" className={field} value="" onChange={(e) => {
            const provider = providers?.[e.target.value];
            if (provider) update({ baseUrl: provider.baseUrl, apiKey: provider.apiKey, apiFormat: provider.apiFormat === 'openai' ? 'openai' : 'anthropic', model: provider.models?.[0]?.id || '' });
          }}>
            <option value="">{text('选择已有配置，或直接填写下面的信息', 'Select a saved provider, or fill in the fields below')}</option>
            {savedProviders.map(([key]) => <option key={key} value={key}>{key}</option>)}
          </select>
        </label>}
        <label className="block space-y-2" htmlFor="comment-ai-url">
          <span className="text-sm font-medium">{text('接口地址', 'API base URL')}</span>
          <input id="comment-ai-url" className={field} type="url" required value={value.baseUrl} onChange={(e) => update({ baseUrl: e.target.value })} placeholder="https://api.deepseek.com" />
        </label>
        <label className="block space-y-2" htmlFor="comment-ai-format">
          <span className="text-sm font-medium">{text('接口格式', 'API format')}</span>
          <select id="comment-ai-format" className={field} value={value.apiFormat} onChange={(e) => update({ apiFormat: e.target.value as MatrixCommentAIConfig['apiFormat'] })}>
            <option value="openai">OpenAI Chat Completions</option>
            <option value="anthropic">Anthropic Messages</option>
          </select>
        </label>
        <label className="block space-y-2" htmlFor="comment-ai-key">
          <span className="text-sm font-medium">API Key</span>
          <input id="comment-ai-key" className={field} type="password" autoComplete="new-password" value={value.apiKey} onChange={(e) => update({ apiKey: e.target.value })} />
        </label>
        <label className="block space-y-2" htmlFor="comment-ai-model">
          <span className="text-sm font-medium">{text('模型名称', 'Model name')}</span>
          <input id="comment-ai-model" className={field} required value={value.model} onChange={(e) => update({ model: e.target.value })} placeholder="deepseek-chat" />
        </label>
        <p className="text-xs dark:text-claude-darkTextSecondary text-claude-textSecondary">
          {text('这里的配置独立保存，不会修改其他功能的 AI。评论上下文和提示词将直接发送至上述接口；失败时不会自动切回 NoobClaw。模型费用由服务商收取，原有动作扣费保持不变。', 'Saved separately from other AI settings. Comment context and prompts go directly to this API, with no fallback to NoobClaw. Your provider bills model usage; existing action charges still apply.')}
        </p>
      </>}
    </div>
  );
}
