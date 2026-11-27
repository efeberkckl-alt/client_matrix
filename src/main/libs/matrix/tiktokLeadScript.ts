/** Adapt the downloaded lead script before execution; never silently run an unpatched version. */
export function patchTikTokLeadScript(source: string): string {
  let script = source.replace(/\r\n/g, '\n');
  // ponytail: exact replacements for the current server script; remove when upstream owns these fixes.
  const replacements: Array<[string, string]> = [
    [
      `  try { await _b('cdp_click', { x: p.x, y: p.y }); return true; } catch (e) { return false; }`,
      `  try {
    if (ctx.aborted && ctx.aborted()) return false;
    var result = await _b('cdp_click', { x: p.x, y: p.y });
    if (!result || result.ok !== true || result.error) throw new Error(result && result.error || '点击未确认成功');
    return true;
  } catch (e) {
    ctx.report('⚠️ 点击未执行：' + String(e && e.message || e).slice(0, 120));
    return false;
  }`,
    ],
    [
      `async function openCardOnProfile(wurl) {
  var vid = videoIdOf(wurl);
  if (!vid) return false;`,
      `async function openCardOnProfile(wurl) {
  var vid = videoIdOf(wurl);
  if (!vid || (ctx.aborted && ctx.aborted())) return false;
  if (videoIdOf(await getUrl()) === vid) return true;`,
    ],
    [
      `  if (mk !== 1) return false;
  await ctx.sleep(300);`,
      `  if (mk !== 1) { ctx.report('⚠️ 卡片未打开：目标作品卡片不存在或不可见'); return false; }
  await ctx.sleep(300);`,
    ],
    [
      `  for (var w = 0; w < 32; w++) { await ctx.sleep(250); if (videoIdOf(await getUrl()) === vid) return true; }
  return false;`,
      `  for (var w = 0; w < 32; w++) {
    if (ctx.aborted && ctx.aborted()) return false;
    await ctx.sleep(250);
    if (videoIdOf(await getUrl()) === vid) return true;
  }
  ctx.report('⚠️ 卡片未打开：点击后未检测到目标作品地址');
  return false;`,
    ],
    [
      `      if (!_clicked) {
        try { await _navigate(wurl); } catch (e) { _opened = false; done.skipped++; row.note = '作品打不开'; }
        if (_opened && await isTk403()) {
          ctx.stepLog(2, 'warn', '   ⚠️ 直接打开作品被 TikTok 拒绝(403),回主页从卡片点进去');
          try { await _navigate('https://www.tiktok.com/@' + handle); } catch (_) {}
          await waitReady('profile', 10000, handle);
          _clicked = await openCardOnProfile(wurl);
          if (!_clicked) { _opened = false; done.skipped++; row.note = '作品打不开(403)'; ctx.stepLog(2, 'warn', '   ⚠️ 作品还是打不开,跳过这位'); }
        }
      }`,
      `      if (!_clicked) {
        _opened = false;
        done.skipped++;
        row.note = '作品卡片未打开，本轮跳过';
        ctx.report('⏭️ 两次卡片打开均未成功，本轮跳过该作品，不直接访问视频网址');
      }`,
    ],
    [
      `  await cdpClickSel(SEL_COMMENT_INPUT_CE);          // 可信聚焦`,
      `  if (!(await cdpClickSel(SEL_COMMENT_INPUT_CE))) return { ok: false, warn: true, msg: '   ⚠️ 评论框聚焦失败，本条不输入、不发送' };`,
    ],
    [
      `    pushOrMerge(handle, row);
  
    await flushOutputs(2, true);`,
      `    pushOrMerge(handle, row, !(row.like || row.comment || row.followed));
  
    await flushOutputs(2, true);`,
    ],
  ];
  for (const [before, after] of replacements) {
    if (script.split(before).length !== 2) throw new Error('TikTok 获客脚本版本已变化，无法应用卡片打开修正；本次未启动，请更新客户端适配');
    script = script.replace(before, after);
  }
  return script;
}
