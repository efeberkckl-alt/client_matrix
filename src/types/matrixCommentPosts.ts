import { z } from 'zod';

export type CommentLikeMode = 'precise' | 'keywords' | 'custom';

const sourceSchema = z.object({ sheet: z.string().min(1), row: z.number().int().positive(), column: z.number().int().positive(), comment: z.number().int().positive() });
const postSchema = z.object({
  url: z.string().transform(tikTokCommentPostUrl).pipe(z.string()),
  text: z.string().trim().min(1).refine(text => !/[\r\n\u0000]/.test(text)),
  sources: z.array(sourceSchema).optional(),
});
export type CommentPost = z.infer<typeof postSchema>;

export function tikTokCommentPostUrl(value: string): string | undefined {
  const match = /^https:\/\/(?:(?:www|m)\.)?tiktok\.com\/@([\w.-]+)\/(video|photo)\/(\d+)\/?(?:[?#][^\s]*)?$/i.exec(value.trim());
  return match ? ['https://www.tiktok.com/@' + match[1], match[2].toLowerCase(), match[3]].join('/') : undefined;
}

export function validatedCommentPosts(input: unknown): CommentPost[] {
  const parsed = z.array(postSchema).min(1).safeParse(input);
  if (!parsed.success) throw new Error('comment_like_invalid_posts');
  const posts = new Map<string, CommentPost>();
  for (const item of parsed.data) {
    const { url, text } = item;
    const id = url.slice(url.lastIndexOf('/') + 1);
    const key = JSON.stringify([id, text]);
    const previous = posts.get(key);
    if (!previous) posts.set(key, item);
    else if (item.sources?.length) {
      const sources = new Map((previous.sources || []).map(source => [JSON.stringify(source), source]));
      for (const source of item.sources) sources.set(JSON.stringify(source), source);
      previous.sources = [...sources.values()];
    }
  }
  return [...posts.values()];
}
