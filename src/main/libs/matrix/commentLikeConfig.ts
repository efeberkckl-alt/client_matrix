type KeywordLimits = { commentVideoLimit?: number; commentRepliesPerVideo?: number };

export function commentLikeLimits(input: KeywordLimits): Required<KeywordLimits> {
  const commentVideoLimit = input.commentVideoLimit ?? 10;
  const commentRepliesPerVideo = input.commentRepliesPerVideo ?? 3;
  if (!Number.isInteger(commentVideoLimit) || commentVideoLimit < 1 || commentVideoLimit > 1000
    || !Number.isInteger(commentRepliesPerVideo) || commentRepliesPerVideo < 1 || commentRepliesPerVideo > 300) {
    throw new Error('comment_like_invalid_limits');
  }
  return { commentVideoLimit, commentRepliesPerVideo };
}

/** Remote scenarios own the DOM helpers; apply local keyword quotas before executing them. */
export function withTikTokKeywordLimits(code: string): string {
  const replacements = [
    ["if (MODE === 'keywords' && st.replyTurn % 2 === 0) return 'skip';", '// Keyword replies use the configured count instead of alternating.'],
    ['var c = list[ci];', "if (DO_REPLY && st.reply >= task.cl_replies_per_video) return false;\n    var c = list[ci];"],
    ['cl.on = await likeVisibleComments(cl, vurl);', `cl.on = await likeVisibleComments(cl, vurl);
    if (DO_REPLY && cl.reply >= task.cl_replies_per_video) {
      ctx.stepLog(1, 'running', '💬 已达到每个视频回复上限(' + task.cl_replies_per_video + '),切换下一个视频');
      break;
    }`],
    ['await likeWorkHere(kurl);', `await likeWorkHere(kurl);
      if (done.works + done.worksSkipped >= task.cl_video_limit) {
        ctx.stepLog(1, 'running', '⏹️ 已处理本次设置的 ' + task.cl_video_limit + ' 个视频,本次结束');
        break;
      }`],
  ];
  // ponytail: exact anchors cover the current server script; stop on drift until this adapter is updated.
  for (const [before, after] of replacements) {
    if (code.split(before).length !== 2) throw new Error('评论数量限制与服务器剧本不兼容,本次未执行,请更新客户端');
    code = code.replace(before, after);
  }
  return code.replaceAll('隔一条回一条', '按设置条数回复')
    .replaceAll('回复一半留言', '按设置条数回复')
    .replace('到时长上限为止', '达到设置的视频数量后结束');
}
