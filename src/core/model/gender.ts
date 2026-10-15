/**
 * 角色卡的「性别」（frontmatter 的 `gender`）。
 *
 * 名字看不出性别时，写正文的模型只能猜，「陆清河」一猜就是男的；新角色也容易一路默认成男的。
 * 所以角色图谱、细纲带出的新角色、从正文建卡 / 更新角色卡几条路都让模型写上它，装配时跟着
 * 名字一起进上下文。**纯函数、绝不抛**（第 1 条）。
 */

/**
 * 规范写法：`male`、`女性` 这类同义写法收成「男」「女」，「未知」「不详」与空当没写。
 * 认不出的（「无性别」「雌雄同体」）照原样留着，截到 8 个字——那是有意写的。
 */
export function normalizeGender(value: unknown): string | undefined {
  if (typeof value !== 'string') {
    return undefined;
  }
  const s = value.trim();
  if (/^(男|男性|male|m|man)$/i.test(s)) {
    return '男';
  }
  if (/^(女|女性|female|f|woman)$/i.test(s)) {
    return '女';
  }
  if (!s || /^(未知|不详|不明|无|待定|（待补充）|unknown|n\/a)$/i.test(s)) {
    return undefined;
  }
  return Array.from(s).slice(0, 8).join('');
}

/** 卡上已经写了的不动（作者写的、先前机器写的都算），没写才用新给的。 */
export function keepGender(current: string | undefined, proposed: unknown): string | undefined {
  return current || normalizeGender(proposed);
}
