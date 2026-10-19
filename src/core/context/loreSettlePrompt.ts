import {
  LORE_BODY_KEYS,
  LORE_ENTRY_LIMITS,
  LORE_EXPAND_LIMITS,
  LORE_HIDDEN_KEY,
  LORE_HIDDEN_MARK,
  LORE_LINE_LIMITS,
  LORE_SETTLE_LIMITS,
} from '../model/loreFile';

/**
 * 落定设定（完善设定二期）：把一段讨论里已经定下来的设定写成一批条目。系统提示里那一句做事原则与任务、附在
 * 用户消息末尾的输出合同。
 *
 * 与落定细纲同一个能力（`settle`），任务却不能借 `CAPABILITY_TASK.settle`：那一句说的是「这一章」，还要模型
 * 「在产物之外用一两句话说明哪几处还没定」——可 JSON 合同又不许多写一个字，两头打架。这里统一放进
 * `questions` 字段，只上卡片、不落盘（同展开）。
 *
 * 放在 context/ 而不是 features/：装配器（prompts.ts）要拼它，而 context/ 不依赖 features/（同 loreExpandPrompt.ts）。
 * 解码在 features/loreSettle.ts，两边共用 `LORE_ENTRY_LIMITS`、`LORE_EXPAND_LIMITS` 与 `LORE_SETTLE_LIMITS`
 * （第 27 条：字数上限是锚点，改提示词时别抹掉）。
 */

/** 产出时那一句做事原则。 */
export const LORE_SETTLE_ETHOS =
  '这一次只把讨论里已经定下来的设定落成条目：作者拍了板的照写，没拍板的不替他拍；已有条目里讨论没碰的内容一处都不丢。';

/** 系统提示里的任务（替掉 `CAPABILITY_TASK.settle`，那一句说的是「这一章」）。 */
export const LORE_SETTLE_TASK =
  '你和作者刚讨论过一些设定（完整对话就在上面）。把讨论中**已经定下来的设定**整理成一批设定条目：新提出来的建新条目，' +
  '改动了已有设定的给出合并后的完整版。\n' +
  '以讨论里定下的为准：**不要塞进讨论中被否掉的方案**，也不要临时发明谁都没提过的设定。' +
  '讨论中悬而未决的地方不要替作者定，写进 questions 字段——那正是作者接下来要接着聊的东西。' +
  '一样东西只是某几处没定（来源、代价、来历……）时，照样把定了的部分写成条目，没定的那几处不写，问题放进 questions；不要因为有一处没定就整条不写。';

/** 输出合同：要求与 JSON 形状（{@link loreSettleJsonContract}）。 */
export function loreSettleContract(): string {
  const L = LORE_ENTRY_LIMITS;
  return [
    '请把上面这段讨论里已经定下来的设定写成条目：地点、势力、能力体系、关键物品、制度与概念，一样一条。',
    '',
    '【要求】',
    `1. 只写讨论里定下来的：新提出来的，和讨论改动、补充了的已有条目；讨论里只是提到、没有改动的已有条目不要列。最多 ${LORE_SETTLE_LIMITS.entries} 条。只有一部分定下来的照样列，定了的写进去，没定的那几处写进 questions。`,
    '2. **人不是设定**：人物都在角色卡里，人名、外号、称谓一律不列（门派、家族这类势力可以列）。',
    '3. 讨论改动或补充了已有设定（上面「相关世界观设定」里列着的）时：title 一字不改照抄那一条的名字，body 给**合并后的完整版**——' +
      '讨论没碰的部分照抄原文，一处都不许丢；讨论改了的照讨论改；「定稿」「已经写进正文」的事实不许推翻。',
    `4. 字数：${LORE_BODY_KEYS.map((k) => `${k} ≤ ${L[k]} 字`).join('、')}，三节合计 ≤ ${L.body} 字；${LORE_HIDDEN_KEY} ≤ ${L[LORE_HIDDEN_KEY]} 字，不算进那 ${L.body} 字。做减法，写不下的说明它值得另立一条。`,
    `5. ${LORE_HIDDEN_KEY}：讨论里定下的、读者暂时还不知道的真相（真实身份、来历、规则背后的真正原因）写在这里；已有条目里标着「${LORE_HIDDEN_MARK}」的那一节是它原来的暗设，没被讨论推翻的照抄。没有就给空字符串。`,
    `6. keywords：只放读者在正文里会看到的、专指这样东西的别称、简称（不含 title 本身，不含人名，≤ ${LORE_EXPAND_LIMITS.keywords} 个，没有就给 []）；` +
      `不放别的东西也叫得上的泛称（如「法器」「防线」「硬通货」「庙宇」）——正文里一出现这个词，这一条就会整条带进上下文。${LORE_HIDDEN_KEY}里的东西不进关键词，也不进一句话（brief）。`,
    `7. questions：讨论里提到了、还没定下来、要作者拍板的问题，0–${LORE_EXPAND_LIMITS.questions} 条，每条 ≤ ${LORE_EXPAND_LIMITS.question} 字；不问已经定了的。没定的事不写进条目的任何一节——${LORE_HIDDEN_KEY}放的是已经定下、只是读者还不知道的事，不是还没想好的事。`,
    '',
    loreSettleJsonContract(),
  ].join('\n');
}

/** 落定设定的 JSON 合同本身。语法修复那一步也拿它当「不可变合同」（generation/structured.ts）。 */
export function loreSettleJsonContract(): string {
  return [
    '【不可变落定设定 JSON 合同】',
    `只输出 {"entries":[{"title":"…","category":"…","keywords":["…"],"brief":"…","body":{"概要":"…","规则与边界":"…","现状":"…","${LORE_HIDDEN_KEY}":"…"}}],"questions":["…"]}。`,
    `- title：这样东西在正文里的叫法（≤ ${LORE_LINE_LIMITS.name} 字），同一批里不得重复；`,
    '- category：从本书的设定分类里挑（可以是二级，如「宗门/正道」）；已有条目照写它原来的分类；',
    `- brief：一句话说清它是什么（≤ ${LORE_ENTRY_LIMITS.brief} 字），只写读者看得到的那一面；`,
    `- body 四个键名一字不改：概要（它是什么、在哪、归谁）、规则与边界（怎么运转，能做到什么、做不到什么，代价与禁忌）、现状（它现在的样子）、${LORE_HIDDEN_KEY}；明面三节讨论没交代、原来也没有的写「（未交代）」；`,
    '- 讨论里一条设定都没定下来时 entries 给 []，把要作者拍板的写进 questions；',
    '只输出一个可由 JSON.parse 读取的对象，不得输出 Markdown 代码围栏、解释或思考过程。',
  ].join('\n');
}
