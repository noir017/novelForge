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
  '这一次只管一条设定：把它往前想细，让已经排好的情节撑得住；定稿里已经写进正文的一个字都不推翻，作者写过的只补、只细化。';

/** 输出合同：要求 1–6 条与 JSON 形状（{@link loreExpandJsonContract}）。 */
export function loreExpandContract(): string {
  const L = LORE_ENTRY_LIMITS;
  return [
    '请把上面「当前这一条设定」往前想细：照「已排细纲里用到它的地方」要它做的事，补全它是什么、怎么运转、现在是什么样子，以及读者还不知道的那一面。',
    '',
    '【要求】',
    '1. 为已排的情节服务：细纲里打算让它做什么，它就得撑得住；和剧情无关的百科不写。',
    '2. 「定稿过的记录」里已经确立的不许改；「当前这一条设定」里作者现有的内容是作者认过的，没有理由不删，只补、只细化。',
    `3. 字数：${LORE_BODY_KEYS.map((k) => `${k} ≤ ${L[k]} 字`).join('、')}，三节合计 ≤ ${L.body} 字；${LORE_HIDDEN_KEY} ≤ ${L[LORE_HIDDEN_KEY]} 字，不算进那 ${L.body} 字，没有就给空字符串。做减法，不写逐章经过。`,
    `4. keywords 3–${LORE_EXPAND_LIMITS.keywords} 个，只放读者在正文里会看到的叫法（别称、简称）；人名不算。${LORE_HIDDEN_KEY}里的东西不进关键词，也不进一句话（brief）。`,
    `5. children：写不下、值得单独立一条的部分，≤ ${LORE_EXPAND_LIMITS.children} 条，只给名字、分类、一句话；已有的设定、人物不要拆。没有就给 []。`,
    `6. questions：2–${LORE_EXPAND_LIMITS.questions} 条还没定、要作者拍板的问题（如「阁规是成文的还是口传的？」），每条 ≤ ${LORE_EXPAND_LIMITS.question} 字；不问已经定了的。`,
    '',
    loreExpandJsonContract(),
  ].join('\n');
}

/** 展开的 JSON 合同本身。语法修复那一步也拿它当「不可变合同」（generation/structured.ts）。 */
export function loreExpandJsonContract(): string {
  return [
    '【不可变设定展开 JSON 合同】',
    `只输出 {"brief":"…","keywords":["…"],"body":{"概要":"…","规则与边界":"…","现状":"…","${LORE_HIDDEN_KEY}":"…"},"children":[{"name":"…","category":"…","brief":"…"}],"questions":["…"]}。`,
    `- brief：一句话说清它是什么（≤ ${LORE_ENTRY_LIMITS.brief} 字），只写读者看得到的那一面；`,
    `- body 四个键名一字不改：概要（它是什么、在哪、归谁）、规则与边界（怎么运转，能做到什么、做不到什么，代价与禁忌）、现状（以章号最大的定稿记录与已排的细纲为准，它现在的样子）、${LORE_HIDDEN_KEY}（读者还不知道的真相：真实身份、来历、规则背后的真正原因）；明面三节还没交代的写「（未交代）」；`,
    `- children 每项的 name ≤ ${LORE_LINE_LIMITS.name} 字，category 从本书的设定分类里挑（可以写子分类，如「宗门/正道」），brief ≤ ${LORE_ENTRY_LIMITS.brief} 字；`,
    '只输出一个可由 JSON.parse 读取的对象，不得输出 Markdown 代码围栏、解释或思考过程。',
  ].join('\n');
}
