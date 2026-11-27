import { tikTokCommentPostUrl, validatedCommentPosts, type CommentPost } from '../../types/matrixCommentPosts';

export async function readTikTokCommentWorkbook(buffer: ArrayBuffer) {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook();
  await book.xlsx.load(buffer);
  const posts: CommentPost[] = [];
  const issues: Array<{ sheet: string; row: number; reason: 'url' | 'text' | 'headers' }> = [];
  const sheets: Array<{ name: string; videos: number; comments: number; issues: number }> = [];

  book.eachSheet((sheet) => {
    const sheetPosts: CommentPost[] = [];
    const previousIssues = issues.length;
    let urlCol = 0;
    let textCol = 0;
    sheet.eachRow((row, number) => {
      if (!urlCol || !textCol) {
        row.eachCell((cell, col) => {
          const header = cell.text.trim();
          if (header === '视频链接' || header === '影片連結') urlCol = col;
          if (header === '自评话术' || header === '自評話術' || header === '评论内容') textCol = col;
        });
        if (!urlCol || !textCol) urlCol = textCol = 0;
        return;
      }
      const urlCell = row.getCell(urlCol);
      const textCell = row.getCell(textCol);
      if (!urlCell.value && !textCell.value) return;
      const formulaUrl = /^HYPERLINK\(\s*"([^"]+)"/i.exec(urlCell.formula || '')?.[1];
      const url = tikTokCommentPostUrl(urlCell.hyperlink || formulaUrl || urlCell.text);
      const texts = textCell.text.split(/\r\n?|\n/).map((line) => line.replace(/^\s*\d+[.．、)）]\s*/, '').trim()).filter(Boolean);
      if (!url || !texts.length || texts.some((text) => text.includes('\0'))) {
        issues.push({ sheet: sheet.name, row: number, reason: url ? 'text' : 'url' });
        return;
      }
      texts.forEach((text, index) => sheetPosts.push({ url, text, sources: [{ sheet: sheet.name, row: number, column: textCol, comment: index + 1 }] }));
    });
    if (!urlCol || !textCol) issues.push({ sheet: sheet.name, row: 1, reason: 'headers' });
    const imported = sheetPosts.length ? validatedCommentPosts(sheetPosts) : [];
    sheets.push({ name: sheet.name, videos: new Set(imported.map(post => post.url.slice(post.url.lastIndexOf('/') + 1))).size, comments: imported.length, issues: issues.length - previousIssues });
    posts.push(...imported);
  });

  return { posts: posts.length ? validatedCommentPosts(posts) : [], issues, sheets };
}
