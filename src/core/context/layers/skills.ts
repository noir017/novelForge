/**
 * 写作方法层：把调用方点名的那几份技能正文放进创作上下文。
 *
 * ## 它与「技能」那一套的分工
 *
 * 技能有两种受众（`model/skillMode.ts` 的 `SkillAudience`）。`agent` 类由
 * agent 自己用 `skill` 工具读，与装配器无关；`generate` 类走这里——agent 调
 * `generate` 时填一串名字，工具层读好正文递进 `request.skills`，这一层只管
 * 把它们放进预算。
 *
 * **这一层不认识 `core/skills/`**，也就不知道有哪些技能、哪一份被禁用了。
 * 那些判断在工具层（`tools/novel/generate.ts`），因为名字错了要在**花钱之前**
 * 就回给 agent 一句话——到了这一层，这一次生成已经开始了。
 *
 * ## 装不下就整份丢，不截断
 *
 * 与作者呼出那条路（`controller/skills.ts` 的 `foldSkills`）同一个判断：
 * **截掉一半的方法比没有更糟**。一份「章尾钩子怎么选」被从中间切开，模型会
 * 照着前半套做完，还以为自己做全了；而被丢掉这件事会明明白白留在上下文明细
 * 里（第 2 条：不静默截断），作者看得见这一次没带上什么。
 *
 * 附件那一层的做法正相反（超了就截）——因为附件是**材料**，半份材料仍然是
 * 材料。方法论不是。
 */
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

export const skills: LayerFn = async (a, spec) => {
  const list = a.request.skills ?? [];
  if (list.length === 0) {
    return;
  }
  // 这一层最多吃掉预算的多少。没有 cap 时不单独封顶，只受全局余额约束。
  const cap = Math.floor(a.budget * (spec.cap ?? 1));
  let spent = 0;

  for (const s of list) {
    const id = `skill:${s.name}`;
    const base = {
      id,
      kind: 'skill' as const,
      priority: spec.priority,
      label: `写作方法 · ${s.name}`,
      source: s.source,
    };
    if (a.excluded.has(id)) {
      a.admit({ ...base, text: '' });
      continue;
    }
    const body = s.text.trim();
    if (!body) {
      a.reject({ ...base, text: '' }, 'dropped', '这份技能的正文是空的');
      continue;
    }

    // 标题带上名字：一次可以带好几份，模型要分得清哪条要求出自哪一套方法。
    const text = `【写作方法 · ${s.name}】\n${body}`;
    const tokens = estimateTokens(text);
    const room = Math.min(cap - spent, Math.max(0, a.remaining));
    if (tokens > room) {
      a.reject(
        { ...base, text: '' },
        'dropped',
        `需 ${tokens} token，可用 ${Math.max(0, room)}——方法论不截断（照着半套流程写完` +
          `比没有更糟），整份丢弃`
      );
      continue;
    }
    a.accept({ ...base, text, status: 'included' }, tokens);
    spent += tokens;
  }
};
