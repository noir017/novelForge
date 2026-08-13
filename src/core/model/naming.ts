/**
 * 称呼学：判断一个词是不是「某个人的专属称呼」。
 *
 * 这个模块存在的理由是一次实战事故：模型在摘要与角色卡里把正文中每一个指代
 * 都收进了 aliases——`她`、`姐姐`、`少女`、`这位小姐`、`满身血迹的少女`。
 * 这些词有两重危害：
 *
 * 1. **角色卡膨胀**。别名是并集累加的，一百章下来一张卡能挂三十多个称呼，
 *    而角色卡每次续写都要注入上下文。
 * 2. **把两个人认成一个**。别名是「谁是谁」的判据（[cast.ts](../cast.ts) 与
 *    [identity.ts](identity.ts) 都吃它）。`姐姐` 同时是三个女角色的称呼，
 *    照单全收就会把她们串成一个人。
 *
 * 判据分四类，命中任意一条即判定为**非专属**：代词泛指、指示代词开头、
 * 含虚词的描述短语、可被泛称词表完全拆解的词。
 *
 * **只用来过滤 aliases，绝不过滤 name。** 这条边界很重要：`店小二`、`家老`、
 * `房东` 这类以泛称当正式名的角色确实存在（`local/` 里就有三张这样的卡），
 * 把 name 也过一遍会让他们凭空消失。
 */

/** 代词与泛指——任何情况下都不是称呼。 */
const PRONOUNS = new Set(
  '他 她 它 他们 她们 它们 自己 本人 某人 此人 那人 众人 大家 对方 双方 两人 二人 三人 一行人 所有人'.split(' ')
);

/**
 * 泛称词表：可以指任何符合条件的人。
 *
 * 收词标准是「换一个人也照样能这么叫」——`少女` 谁都能当，`方老魔女` 不能。
 * 分四组只为可读，判定时合成一张表。
 */
const GENERIC_WORDS = new Set(
  [
    // 性别 / 年龄
    '少女 少年 姑娘 女子 男子 妇人 女人 男人 老者 老人 老头 老太 老太婆 老汉 老爷子 青年 中年 中年人 孩子 小孩 女孩 男孩 娃儿 婴儿 童子 幼童',
    // 亲属
    '爹 娘 父亲 母亲 爷爷 奶奶 外公 外婆 叔叔 婶婶 伯父 伯母 舅父 舅舅 舅母 姑姑 姨母 姐姐 妹妹 哥哥 弟弟 兄弟 姐妹 儿子 女儿 侄子 侄女 侄儿 孙子 孙女 孙儿 表哥 表姐 表弟 表妹 妻子 丈夫 夫君 娘子 相公 大哥 大姐 大嫂 小弟 小妹 妹子 孪生 双生',
    // 礼貌 / 身份泛称
    '小姐 公子 少爷 大小姐 姑奶奶 夫人 先生 大人 阁下 兄台 前辈 晚辈 后辈 师兄 师姐 师弟 师妹 师父 学长 学姐 学弟 学妹 同学 同门 主子 老爷 奴婢 老奴 属下 手下 心腹 下人 仆人 家奴 豪奴',
    // 贬称 / 泛泛的指称
    '丫头 崽子 狼崽子 小子 小鬼 家伙 东西 混蛋 新人 菜鸟 废物 蠢货 之人 之士 人物',
  ]
    .join(' ')
    .split(/\s+/)
    .filter(Boolean)
);

/**
 * 可剥离的修饰前缀。`小丫头` / `臭丫头` / `老丫头` 都还是 `丫头`。
 * 长的排前面，剥离时取最长匹配。
 */
const MODIFIERS = ['贴身', '年轻', '年老', '中年', '青年', '孪生', '亲', '小', '老', '臭', '大', '新', '好', '傻', '死', '众'];

/**
 * 强泛称后缀：以它结尾的基本不可能是某个人的专属称呼。
 *
 * 与 GENERIC_WORDS 分开是因为它们前面能挂任意修饰语（`小狼崽子`、`心腹之士`），
 * 穷举不完。刻意收得很窄——`公子`、`少爷` 之类**不**放进来：
 * `贾公子`、`赤城少爷` 带着专名，是能指到具体一个人的。
 */
const GENERIC_SUFFIXES = ['崽子', '丫头', '之人', '之士', '家伙', '东西'];

/** 人名/称呼里不会出现的虚词。与 model/project.ts 的 SENTENCE_MARKERS 同源。 */
const SENTENCE_MARKERS = /[的了是在不没和与也都而被把从向对为及则却就还很]/;

/** 称呼的长度上限。与 model/project.ts 的 isPlausibleName 保持一致。 */
const MAX_LENGTH = 8;

/**
 * 这个词是不是**泛称**（换个人也能这么叫）？
 *
 * 判 true 的东西不该进 aliases，也不该拿去做「是不是同一个人」的判据。
 */
export function isGenericAppellation(word: string): boolean {
  const w = word.trim();
  if (!w || w.length > MAX_LENGTH) {
    return true;
  }
  if (PRONOUNS.has(w)) {
    return true;
  }
  // 「这位小姐」「此女」「本届状元」「该女子」——指示代词开头的是**指认**不是称呼。
  if (/^[这那此该本其]/.test(w)) {
    return true;
  }
  // 「满身血迹的少女」「好运的小丫头」——带虚词的是描述短语。
  if (SENTENCE_MARKERS.test(w)) {
    return true;
  }
  if (GENERIC_SUFFIXES.some((s) => w.endsWith(s))) {
    return true;
  }
  // 「少女新人」「中年男人」「小丫头」——能被泛称词与修饰语完全拆掉的，整体也是泛称。
  return isFullyGeneric(w);
}

/**
 * 拆解：反复剥修饰前缀、吃泛称词，能把整个词吃光就是泛称。
 *
 * **必须回溯，贪心会漏。** `小妹妹` 从长到短匹配会先吃掉 `小妹`，剩一个 `妹`
 * 吃不动就判成非泛称；而先剥修饰语 `小` 再吃 `妹妹` 才对。反过来 `小姐` 又
 * 必须先当整词吃掉——剥了 `小` 就只剩一个 `姐`。两条切法都要试。
 */
function isFullyGeneric(word: string): boolean {
  const failed = new Set<string>();

  const consume = (rest: string, ate: boolean): boolean => {
    if (rest.length === 0) {
      // 全靠修饰语吃光（如单独一个 `小`）不算泛称，至少要命中一个泛称词。
      return ate;
    }
    if (failed.has(rest)) {
      return false;
    }
    // 泛称词最长 4 字（`中年人`/`老太婆`/`大小姐`），从长到短试。
    for (let len = Math.min(4, rest.length); len >= 1; len--) {
      if (GENERIC_WORDS.has(rest.slice(0, len)) && consume(rest.slice(len), true)) {
        return true;
      }
    }
    for (const modifier of MODIFIERS) {
      if (rest.startsWith(modifier) && rest.length > modifier.length && consume(rest.slice(modifier.length), ate)) {
        return true;
      }
    }
    failed.add(rest);
    return false;
  };

  return consume(word, false);
}

/**
 * 过滤一组别名：去掉泛称、与本名相同的、空白与重复。顺序保持稳定。
 *
 * @param selfName 这张卡/这条 cast 的正式名。它自己不该再出现在别名里。
 */
export function sanitizeAliases(aliases: readonly string[], selfName?: string): string[] {
  const self = selfName?.trim();
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias || alias === self || seen.has(alias) || isGenericAppellation(alias)) {
      continue;
    }
    seen.add(alias);
    out.push(alias);
  }
  return out;
}

/** 一个被丢弃的别名及原因。 */
export interface DroppedAlias {
  alias: string;
  reason: string;
}

/**
 * 被丢掉的别名与原因，供日志说明。
 *
 * 「不静默截断」在本模块的落法：删别名是对作者可见内容的删减，
 * 哪怕删得对，也得说得出删了什么、为什么。
 */
export function explainDroppedAliases(aliases: readonly string[], selfName?: string): DroppedAlias[] {
  const self = selfName?.trim();
  const out: DroppedAlias[] = [];
  const seen = new Set<string>();
  for (const raw of aliases) {
    const alias = raw.trim();
    if (!alias) {
      continue;
    }
    if (alias === self) {
      out.push({ alias, reason: '与正式名相同' });
      continue;
    }
    if (seen.has(alias)) {
      out.push({ alias, reason: '重复' });
      continue;
    }
    seen.add(alias);
    if (!isGenericAppellation(alias)) {
      continue;
    }
    out.push({ alias, reason: reasonFor(alias) });
  }
  return out;
}

function reasonFor(alias: string): string {
  if (alias.length > MAX_LENGTH) {
    return '过长，不像称呼';
  }
  if (PRONOUNS.has(alias)) {
    return '代词';
  }
  if (/^[这那此该本其]/.test(alias)) {
    return '指示代词开头';
  }
  if (SENTENCE_MARKERS.test(alias)) {
    return '描述短语，不是称呼';
  }
  return '泛称，换个人也能这么叫';
}

/**
 * 名字规范化：去掉空白与引号后比较大小写无关。
 *
 * 比的是人名，所以比 markdown.ts 的 `normalizeKey` 保守——把中点也抹掉会让
 * `甘德·奥塔` 与 `甘德奥塔` 混为一谈，这在译名里恰恰是有意义的区别；只抹空白与引号。
 */
export function normalizeName(name: string): string {
  return name.replace(/[\s"'「」『』]/g, '').toLowerCase();
}
