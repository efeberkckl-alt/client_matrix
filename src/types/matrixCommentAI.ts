/** Independent of the chat/content-generation provider selection. */
export interface MatrixCommentAIConfig {
  source: 'noobclaw' | 'custom';
  baseUrl: string;
  apiKey: string;
  model: string;
  apiFormat: 'openai' | 'anthropic';
}
