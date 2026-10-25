import { LORE_BODY_KEYS, LORE_ENTRY_LIMITS, LORE_EXPAND_LIMITS, LORE_HIDDEN_KEY, LORE_LINE_LIMITS } from '../model/loreFile';

/**
 * 展开一条设定（完善设定，2026-10-19）：往前想细。系统提示里那一句做事原则与附在用户消息末尾的输出合同。
 *
 * **不借 `LORE_ENTRY_SYSTEM`**（features/lorePrompt.ts）：那一份是往回记的规矩，第 1 条就是「只写给出的记录里
 * 明确有的，不补完、不推测」。展开反过来——要为已排的情节补完、推想；只是定稿里写过的不推翻、作者写过的不删。
 *
 * 放在 context/ 而不是 features/：装配器（prompts.ts）要拼它，而 context/ 不依赖 features/（context/README.md）。
 * 解码在 features/loreExpand.ts，两边共用 `LORE_ENTRY_LIMITS` 与 `LORE_EXPAND_LIMITS`（第 27 条：字数上限
 * 是锚点，改提示词时别抹掉）。
 */

/** 产出时那一句做事原则（`ethosOf` 在单条设定目标上接它）。 */
export const LORE_EXPAND_ETHOS =
  '这一次只管一条设定：把它往前想细，让已经排好的情节撑得住；定稿里已经写进正文的一个字都不推翻，这一条现有的具体内容一处都不丢，只补、只细化。';

/**
 * 输出合同：要求 1–6 条与输出格式。2026-10-25 起改成转写：按小标题写自然语言（{@link loreExpandFormat}），JSON 由转写模型
 * 照抄（{@link loreExpandJsonContract}，generation/structured.ts 的 `completeLoreExpand`）。
 */
export function loreExpandContract(): string {
  const L = LORE_ENTRY_LIMITS;
  return [
    '请把上面「当前这一条设定」往前想细：照「已排细纲里用到它的地方」要它做的事，补全它是什么、怎么运转、现在是什么样子，以及读者还不知道的那一面。',
    '',
    '【要求】',
    '1. 为已排的情节服务：细纲里打算让它做什么，它就得撑得住；和剧情无关的百科不写。',
    '2. 「定稿过的记录」里已经确立的不许改。「当前这一条设定」里现有的每一处具体内容（名字、规则、做得到与做不到的、已经发生的事）' +
      '都是作者认过的，一处都不许丢：可以换说法、并句子；字数放不下先压缩措辞，再放不下就把整块拆进子条目。只补、只细化。',
    `3. 字数：${LORE_BODY_KEYS.map((k) => `${k} ≤ ${L[k]} 字`).join('、')}，三节合计 ≤ ${L.body} 字；${LORE_HIDDEN_KEY} ≤ ${L[LORE_HIDDEN_KEY]} 字，不算进那 ${L.body} 字，没有就写「无」。做减法，不写逐章经过。`,
    `4. 关键词 3–${LORE_EXPAND_LIMITS.keywords} 个，只放读者在正文里会看到的叫法（别称、简称）；人名不算。${LORE_HIDDEN_KEY}里的东西不进关键词，也不进一句话。`,
    `5. 子条目：写不下、值得单独立一条的部分，≤ ${LORE_EXPAND_LIMITS.children} 条，只给名字、分类、一句话；已有的设定、人物不要拆。没有就写「无」。`,
    `6. 还没定的问题：2–${LORE_EXPAND_LIMITS.questions} 条还没定、要作者拍板的问题（如「阁规是成文的还是口传的？」），每条 ≤ ${LORE_EXPAND_LIMITS.question} 字；不问已经定了的。`,
    '',
    loreExpandFormat(),
  ].join('\n');
}

/** 展开的输出格式（2026-10-25 起改成转写）：八个小标题，各节写什么照原来的 JSON 合同搬过来。 */
function loreExpandFormat(): string {
  return [
    '【展开格式】',
    '按下面八个小标题依次写，一节以「## 小标题」开头，小标题一字不改，哪一节没有内容就写「无」：',
    `- 一句话：说清它是什么（≤ ${LORE_ENTRY_LIMITS.brief} 字），只写读者看得到的那一面；`,
    '- 关键词：写在一行里，用顿号隔开；',
    '- 概要：它是什么、在哪、归谁；',
    '- 规则与边界：怎么运转，能做到什么、做不到什么，代价与禁忌；',
    '- 现状：以章号最大的定稿记录与已排的细纲为准，它现在的样子；',
    `- ${LORE_HIDDEN_KEY}：读者还不知道的真相（真实身份、来历、规则背后的真正原因）；`,
    `- 子条目：一条一行，写成「- 名字（分类）：一句话」；名字 ≤ ${LORE_LINE_LIMITS.name} 字，分类从本书的设定分类里挑（可以写子分类，如「宗门/正道」），一句话 ≤ ${LORE_ENTRY_LIMITS.brief} 字；`,
    '- 还没定的问题：一条一行，行首写「- 」。',
    '明面三节（概要、规则与边界、现状）还没交代的写「（未交代）」。',
    '只写这一条的展开：不要开场白和解释，不用代码围栏，不写 JSON。',
    '【格式示例】',
    '## 一句话',
    '……',
    '## 关键词',
    '〈别称〉、〈简称〉',
    '## 概要',
    '……',
    '## 规则与边界',
    '……',
    '## 现状',
    '……',
    `## ${LORE_HIDDEN_KEY}`,
    '……',
    '## 子条目',
    '- 〈名字〉（〈分类〉）：……',
    '## 还没定的问题',
    '- ……',
  ].join('\n');
}

/**
 * 展开转写那一步的 JSON 合同（2026-10-25 起改成转写）：形状是 features/loreExpand.ts 的 `decodeLoreExpansion` 认的那一份，
 * 也是气泡里放的规范化结果的形状。
 */
export function loreExpandJsonContract(): string {
  return [
    '【设定展开 JSON 合同】',
    `只输出 {"brief":"…","keywords":["…"],"body":{"概要":"…","规则与边界":"…","现状":"…","${LORE_HIDDEN_KEY}":"…"},"children":[{"name":"…","category":"…","brief":"…"}],"questions":["…"]}：`,
    '- brief：「一句话」一节；keywords：「关键词」一节，一个一项；',
    `- body 的四个键（概要、规则与边界、现状、${LORE_HIDDEN_KEY}）：原文里同名的那四节，整节照抄（保留换行）；`,
    '- children：「子条目」一节，一条一项：name 是名字，category 是括号里的分类，brief 是冒号后面那一句；',
    '- questions：「还没定的问题」一节，一条一项，去掉行首的「- 」；',
    '- 写「无」或没有这一节的：文字给 ""，列表给 []。',
    '- 文字一律从原文照抄：不改写、不总结、不润色，不补原文没有的，也不删原文写了的。',
    '只输出一个可由 JSON.parse 读取的 JSON 对象，不要解释、Markdown 或代码围栏。',
  ].join('\n');
}
