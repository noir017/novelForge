/**
 * 文风提取（从本工程正文，features/style.ts）与从参考书学文风（features/reference.ts）共用这一份：
 * 只有开头那一段不同——一份是「保证续写与原作一致」，一份是「让作者的书学参考书的写法」。
 * 任务边界与小节一字不差。
 */
import { StopSignal } from '../llm/provider';
import { stripCodeFence } from './parse';

const STYLE_INTRO =
  '你是文学编辑，需要从作者的样章中归纳出一份「文风指南」。这份指南会在每次 AI 续写时注入模型，用来保证续写内容与原作风格一致，因此必须**具体、可执行**，不能是「文笔优美」这类无法操作的空话。';

const REFERENCE_STYLE_INTRO =
  '你是文学编辑，需要从一本**参考书**的样章中归纳出一份「文风指南」。作者想让自己的书学这本书的写法：这份指南会在作者每次续写时注入模型，因此必须**具体、可执行**，不能是「文笔优美」这类无法操作的空话。参考书是别人的作品，你要拆的是它的技法，不是它的内容。';

const STYLE_BODY = `【任务边界】（来自 AI-Novel-Writer 的文风分析模板 analyze_writing_style，GPL-3.0，源自 AI_NovelGenerator）
- 只学习叙事技法、结构节奏、句式习惯、描写比例、场景推进方式和对白组织。
- 禁止复述样章的具体情节、角色名、地点名、专有设定或标志性桥段——这份指南要约束的是「怎么写」，不是「写什么」。
- 不要复制原文句子，不要输出长引文；词例只摘词，不摘句。
- 只提炼样章中有效且可迁移的技法；不要把样章的缺点或偶发模式当作写作要求。
- 不得把样章里剧情事件、动作或物件的出现次数、每幕配额或样章篇幅转成写作要求。

请按以下小节输出 Markdown，不要增删小节，不要输出任何前言后语：

## 叙事视角
人称、视角类型（限知/全知）、视角是否切换、时态。

## 句式节奏
平均句长、长短句配比、段落长度、不同场景（对话/动作/描写）下的节奏差异。请给出具体倾向，例如「动作段落多用 10 字以内短句连排」。

## 遣词特征
偏好的词汇色彩（书面/口语、雅/俗）、常见的动词与形容词习惯、是否使用文言词、方言或特定行业词汇。请从样章中摘 3-5 个典型词例。

## 对白风格
对白占比、提示语写法（「他说」还是动作代替）、不同人物的说话差异、是否使用大段独白。

## 描写偏好
环境描写的密度与切入方式、心理描写的处理、感官描写侧重（视觉/听觉/嗅觉）。

## 修辞习惯
比喻/排比等修辞的使用频率与偏好类型，是否克制。

## 禁用清单
从样章中反推出作者**明显回避**的写法，逐条列出（如「不使用『不禁』『顿时』」「不写上帝视角评论」「不用感叹号」）。这一节直接影响续写质量，请尽量列全。

要求：所有结论必须能从样章中找到依据，宁可少写也不要臆测。用简体中文。`;

export const STYLE_SYSTEM = `${STYLE_INTRO}\n\n${STYLE_BODY}`;

/** 从参考书学文风（拆书 B）。 */
export const REFERENCE_STYLE_SYSTEM = `${REFERENCE_STYLE_INTRO}\n\n${STYLE_BODY}`;

/**
 * 从参考书学写法（拆书 B）：结构与节奏层面的方法，写成一份「规划」阶段的写作技能
 * （`.novelforge/skills/<名>/SKILL.md`）。任务边界沿用上面那一份的口径；最后一节「规划时怎么用」是
 * 给排大纲与细纲的人直接照做的规则——技能正文会原样放在规划那几次生成的提示词最前面。
 *
 * 「不要提到工具、脚本、文件」：写作技能只收纯提示词（`model/writingSkill.ts` 的兼容规则），
 * 正文里写了「调用……工具」「运行脚本」会被判成不兼容、绑不上。
 */
export const REFERENCE_SKILL_SYSTEM = `你是一位资深网文编辑，需要从一本参考书的样章里拆出它的「写法」——章节怎么搭、场景怎么推进、钩子怎么下、节奏与爽点怎么排、信息怎么投放——写成一份写作技能。这份技能会在另一本书**规划情节大纲与细纲**时放在提示词最前面，帮它学到这本书的排法。

【任务边界】（与文风分析同一口径，来自 AI-Novel-Writer 的 analyze_writing_style，GPL-3.0，源自 AI_NovelGenerator）
- 只学结构与节奏层面的方法：一章几个场景、场景之间怎么切、冲突怎么升级、钩子落在哪、多久一个小高潮、信息什么时候给。
- 禁止复述参考书的具体情节、角色名、地点名、专有设定或标志性桥段——技能约束的是「怎么排」，不是「排什么」。
- 不要复制原文句子，不要输出引文。
- 只提炼有效且可迁移的方法；不要把样章的缺点或偶发模式当作要求。
- 「篇幅统计」是程序数出来的，可以引用其中的数；其他数字（几章一个高潮之类）只写样章里看得出来的。
- 不写文风（句式、遣词、修辞）：那由文风指南管。
- 这是一份纯提示词：不要提到工具、脚本、文件或附件。

请按以下小节输出 Markdown，不要增删小节，不要输出任何前言后语，总长 800–1500 字：

## 章节结构
一章通常由几个场景组成、开头怎么进入、结尾停在哪里；章与章之间怎么衔接。

## 场景推进
一个场景内部怎么起、怎么升级、怎么转；动作、对白、信息在场景里的比例。

## 钩子与悬念
章末钩子的常见类型与落点；长线悬念怎么埋、隔多久回应一次。

## 节奏与爽点
小高潮与日常推进怎么交替；爽点（打脸、升级、收获、反转）的密度与铺垫长度。

## 信息投放
设定、背景、人物过往什么时候讲、讲多少、借谁的口讲。

## 开篇写法
开头几章怎么抛出困境、亮出核心变量、完成第一次小破局。

## 规划时怎么用
5–8 条排大纲与细纲时可以直接照做的规则（如「每章至少一次局面变化，章末停在未决的选择上」）。

要求：所有结论必须能从样章中找到依据，宁可少写也不要臆测。用简体中文。`;

/**
 * 提示词规定了哪些 `## 小节`，回答里少了哪几个。被截断的回答尾巴上的小节必然缺席；
 * 有的网关不报收尾原因，只靠 `stopReason` 拦不住，所以按小节再核一遍。
 */
export function missingSections(system: string, output: string): string[] {
  const has = new Set(output.split('\n').map((l) => l.trim()).filter((l) => l.startsWith('## ')).map((l) => l.slice(3).trim()));
  return system
    .split('\n')
    .filter((l) => l.startsWith('## '))
    .map((l) => l.slice(3).trim())
    .filter((h) => !has.has(h));
}

/** 截断或缺小节就抛错：半份文风指南、半份技能写进工程比没写更糟——它会被当成完整的照做。 */
export function assertComplete(system: string, output: string, stopReason: StopSignal | undefined, maxOut: number): void {
  if (stopReason === 'maxTokens') {
    throw new Error(`回答撞到输出上限（${maxOut} token）被截断了`);
  }
  const missing = missingSections(system, output);
  if (missing.length > 0) {
    throw new Error(missing.length === missingSections(system, '').length ? '回答是空的或没按小节写' : `回答缺了「${missing.join('」「')}」${missing.length} 节，多半是被截断了`);
  }
}

/** 没撞上限却缺小节时，同一个模型再问几次。 */
export const INCOMPLETE_RETRIES = 2;

/**
 * 调一次、去掉代码围栏、核小节；没撞上限却缺小节就重问。
 *
 * 有的网关会在上游半路断流时照常发 `[DONE]`、不给收尾原因（实测 newapi 转 gemini-3-flash
 * 时有发生），回答停在第一二节。这种断流是偶发的，再问一次多半就全了；撞了输出上限
 * 则是稳定复现的，重问只是白烧 token，直接报错。放在 `pool.run` 里面调：重试用完还缺，
 * 抛出去由池子换模型。
 */
export async function collectComplete(
  system: string,
  call: () => Promise<{ text: string; stopReason?: StopSignal }>,
  opts: { maxOut: number; signal?: AbortSignal; onRetry?: (attempt: number, reason: string) => void }
): Promise<string> {
  for (let attempt = 0; ; attempt++) {
    const r = await call();
    const text = stripCodeFence(r.text).trim();
    if (opts.signal?.aborted) {
      return text;
    }
    try {
      assertComplete(system, text, r.stopReason, opts.maxOut);
      return text;
    } catch (err) {
      const reason = (err as Error).message;
      if (r.stopReason === 'maxTokens') {
        throw err;
      }
      if (attempt >= INCOMPLETE_RETRIES) {
        throw new Error(`${reason}（连问 ${attempt + 1} 次都不完整，多半是服务商半路断了流：过会儿再试，或给这一档多配一个模型）`);
      }
      opts.onRetry?.(attempt + 1, reason);
    }
  }
}
