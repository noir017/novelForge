/**
 * 从参考书学写法（拆书 B）：放一本别人的书进工程，**只学怎么写**——
 *
 * - 文风 → `.novelforge/style.md`（与「从正文提取文风」同一份提示词，开头那段换成「这是参考书」）；
 * - 结构与节奏 → 一份「规划」阶段的写作技能 `.novelforge/skills/<书名>-写法/SKILL.md`，写完问绑不绑。
 *
 * 借鉴 AI-Novel-Writer 的「拆解文风与仿写指南」（`analyze-style.command.ts`：5 章样本、每章前 2000 字、
 * 3–6 条建议整段写进 `writingStyle`）。**不借**它的另外两步：原文进向量库、反推原书的设定与蓝图后
 * 从第 1 章同人名同情节重写（作者拍板：只学写法；换皮重写以后另说）。所以这里原文一个字都不写进工程，
 * 两次调用的提示词都带「不复述情节、人名、地名」的任务边界。
 *
 * 各 1 次调用，走「提取文风」那一档（`extractStyle`），不带思考深度（第 26 条）。
 */
import { readConfig } from '../config';
import { getHost } from '../host';
import { collect } from '../llm/collect';
import { createModelPool } from '../llm/pool';
import { NovelProject } from '../model/project';
import {
  ENCODING_LABEL,
  SplitChapter,
  describeShape,
  evenSample,
  headOf,
  headTail,
  referenceSkillName,
  renderReferenceSkill,
  shapeStats,
  splitBySize,
  splitChapters,
  structureSample,
} from '../model/importText';
import { CallEstimate, describeCalls } from '../model/pipeline';
import { describeTaskModels } from '../model/tiers';
import { SKILL_STAGE_LABEL, describeIncompat, skillId, skillLabel } from '../model/writingSkill';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { listSkills, loadSkill, readSkillBindings, saveSkillBinding } from '../skills';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { Workspace } from '../workspace';
import { formatWordCount, pickBookText, readBookText } from './bookText';
import { INCOMPLETE_RETRIES, REFERENCE_SKILL_SYSTEM, REFERENCE_STYLE_SYSTEM, collectComplete } from './stylePrompt';

const log = scoped('学写法');

export type ReferenceLearn = 'both' | 'style' | 'skill';

/** 文风看几章、每章看多少。 */
export const STYLE_SAMPLES = 5;
export const STYLE_HEAD = 2500;
/** 写法看的那几章：开头与结尾各看多少（章末钩子在结尾）。 */
export const SKILL_HEAD = 2500;
export const SKILL_TAIL = 800;

const LEARN_LABEL: Record<ReferenceLearn, string> = {
  both: '文风与写法',
  style: '文风',
  skill: '写法',
};

export interface ReferenceOutcome {
  calls: number;
  /** 写好的文风指南、写法技能（没写成就缺席）。 */
  style?: string;
  skill?: { id: string; relPath: string; bound: boolean };
}

export async function learnFromReference(
  project: NovelProject,
  opts: { path?: string; what?: ReferenceLearn } = {}
): Promise<ReferenceOutcome> {
  const where = await pickBookText(project, '从参考书学写法：选一本 txt', opts.path);
  if (!where) {
    return { calls: 0 };
  }
  let book;
  try {
    book = await readBookText(project, where);
  } catch (err) {
    getHost().toast(describeError(err), 'error');
    return { calls: 0 };
  }
  let chapters: SplitChapter[] = splitChapters(book.text).chapters;
  const bySize = chapters.length === 0;
  if (bySize) {
    chapters = splitBySize(book.text);
  }
  if (chapters.length === 0) {
    getHost().toast(`《${book.title}》里没有正文。`, 'error');
    return { calls: 0 };
  }

  const what =
    opts.what ??
    (await getHost().pick<ReferenceLearn>(
      [
        { label: '两样都学', description: '文风写进 style.md，结构与节奏写成一份「规划」阶段的写作技能', value: 'both' },
        { label: '只学文风', description: '视角、句式、遣词、对白、描写、修辞，写进 style.md', value: 'style' },
        { label: '只学写法', description: '章节结构、场景推进、钩子、节奏与爽点，写成「规划」阶段的写作技能', value: 'skill' },
      ],
      `从《${book.title}》学什么？`
    ));
  if (!what) {
    return { calls: 0 };
  }
  const doStyle = what !== 'skill';
  const doSkill = what !== 'style';
  const styleIdx = evenSample(chapters.length, STYLE_SAMPLES);
  const skillIdx = structureSample(chapters.length);
  const styleTouched = doStyle && !(await project.styleGuideUntouched());
  const taken = new Set((await listSkills(project)).filter((s) => s.source === 'project').map((s) => s.name));
  const skillName = referenceSkillName(book.title, taken);
  const skillRel = `${project.relPath(project.skillsDir)}/${skillName}/SKILL.md`;
  const n = (doStyle ? 1 : 0) + (doSkill ? 1 : 0);
  const estimate: CallEstimate = { low: n, high: n, max: n };
  const unit = bySize ? '段' : '章';
  const nos = (idx: number[]) => idx.map((i) => i + 1).join('、');

  const config = readConfig();
  const button = styleTouched ? '覆盖 style.md 并开始' : '开始学';
  const pick = await getHost().confirm(
    `从《${book.title}》学${LEARN_LABEL[what]}，${describeCalls(estimate)}。现在开始？`,
    [button],
    {
      modal: true,
      detail: [
        `文件：${book.shown}（${ENCODING_LABEL[book.encoding]}）；${bySize ? `认不出章节标题，按约 3000 字一段切成 ${chapters.length} 段` : `认出 ${chapters.length} 章`}，共 ${formatWordCount(chapters.reduce((s, c) => s + c.words, 0))}。`,
        describeTaskModels(config, 'extractStyle'),
        doStyle
          ? `文风：看第 ${nos(styleIdx)} ${unit}（首尾与中间均匀抽），各取开头 ${STYLE_HEAD} 字，归纳成文风指南写进 ${project.relPath(project.stylePath)}` +
            (styleTouched ? '——它已经有内容，会被覆盖（可用 Git 或撤销恢复）。' : '。')
          : '',
        doSkill
          ? `写法：看第 ${nos(skillIdx)} ${unit}（开篇与全书 30% 处的连续几${unit}），各取开头 ${SKILL_HEAD} 字与结尾 ${SKILL_TAIL} 字，加上全书的篇幅统计，写成写作技能 ${skillRel}；写完问你要不要绑到「${SKILL_STAGE_LABEL.planning}」阶段。`
          : '',
        '只学怎么写：不复述它的情节、人名、地名与设定，原文不写进工程的任何文件。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  );
  if (pick !== button) {
    log.info('作者取消了从参考书学写法');
    return { calls: 0 };
  }
  const pool = await createModelPool({ task: 'extractStyle', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，从参考书学写法中止');
    return { calls: 0 };
  }

  const outcome: ReferenceOutcome = { calls: 0 };
  const failures: string[] = [];
  const budget = Math.max(3000, pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000);
  const maxOut = pool.primaryBudget.maxOutputTokens;
  const ask = async (system: string, user: string, label: string, signal: AbortSignal): Promise<string> => {
    const corpus = takeHead(user, budget);
    if (corpus.length < user.length) {
      log.warn(`${label}的样章超出输入预算，已截断`, `${user.length} 字 → ${corpus.length} 字（预算 ${budget} token）`);
    }
    log.debug(`${label}：样章已备好`, `${corpus.length} 字（约 ${estimateTokens(corpus)} token）`);
    outcome.calls++;
    return pool.run(label, (llm) =>
      collectComplete(
        system,
        () =>
          collect(
            llm.stream(
              [
                { role: 'system', content: system },
                { role: 'user', content: corpus },
              ],
              { maxOutputTokens: maxOut, temperature: 0.3, timeoutMs: config.requestTimeoutMs, signal }
            )
          ),
        {
          maxOut,
          signal,
          onRetry: (attempt, reason) => {
            outcome.calls++;
            log.warn(`${label}：回答不完整，重问（第 ${attempt}/${INCOMPLETE_RETRIES} 次）`, reason);
          },
        }
      )
    );
  };

  const ws = new Workspace(project);
  await runTask(
    '从参考书学写法',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      let step = 0;
      if (doStyle) {
        report({ message: '学文风', current: step, total: n });
        try {
          const samples = styleIdx.map((i) => `【样章：第 ${i + 1} ${unit}】\n${headOf(chapters[i].body, STYLE_HEAD)}`).join('\n\n');
          const text = await ask(REFERENCE_STYLE_SYSTEM, `以下是参考书的样章。\n\n${samples}`, '学文风', signal);
          if (signal.aborted) {
            return;
          }
          if (!text) {
            throw new Error('模型返回的文风指南是空的');
          }
          outcome.style = await ws.writeStyleGuide(text);
          log.info('参考书的文风已写进文风指南', outcome.style);
        } catch (err) {
          if (signal.aborted) {
            return;
          }
          failures.push(`文风没学成（${describeError(err)}）`);
          log.error(`从《${book.title}》学文风失败`, err);
        }
        step++;
      }
      if (doSkill) {
        report({ message: '学写法', current: step, total: n });
        try {
          const samples = skillIdx
            .map((i) => `【样章：第 ${i + 1} ${unit}｜${chapters[i].words} 字】\n${headTail(chapters[i].body, SKILL_HEAD, SKILL_TAIL)}`)
            .join('\n\n');
          const user = `# 参考书的篇幅统计（程序数的）\n\n${describeShape(shapeStats(chapters))}\n\n# 样章\n\n${samples}`;
          const body = await ask(REFERENCE_SKILL_SYSTEM, user, '学写法', signal);
          if (signal.aborted) {
            return;
          }
          if (!body) {
            throw new Error('模型返回的写法是空的');
          }
          const raw = renderReferenceSkill({ name: skillName, bookTitle: book.title, body });
          await ws.write(skillRel, { text: raw }, { mode: 'create' });
          outcome.skill = { id: skillId('project', skillName), relPath: skillRel, bound: false };
          log.info(`参考书的写法已写成技能「${skillName}」`, skillRel);
        } catch (err) {
          if (signal.aborted) {
            return;
          }
          failures.push(`写法没学成（${describeError(err)}）`);
          log.error(`从《${book.title}》学写法失败`, err);
        }
      }
      report({ message: '收尾', current: n, total: n });
      log.info(`从《${book.title}》学写法结束`, `调用 ${outcome.calls} 次，用时 ${elapsed(startedAt)}`);
    },
    { scope: '学写法' }
  );

  const made = [outcome.style ? `文风写进了 ${outcome.style}` : '', outcome.skill ? `写法写成了 ${outcome.skill.relPath}` : ''].filter(Boolean);
  if (failures.length > 0) {
    getHost().toast([...made, ...failures].join('；') + '。', 'error');
  } else if (made.length > 0 && !outcome.skill) {
    getHost().toast(`${made.join('；')}。建议人工过一遍再用。`);
  }
  if (outcome.skill) {
    outcome.skill.bound = await offerBinding(project, ws, outcome.skill.id, made);
  }
  if (outcome.style && !outcome.skill) {
    await getHost().openFile(project.relPath(project.stylePath));
  }
  return outcome;
}

/** 写好的写法技能：问一句绑不绑到「规划」阶段；那个阶段已经绑了别的就写明会换掉。 */
async function offerBinding(project: NovelProject, ws: Workspace, id: string, made: string[]): Promise<boolean> {
  const skill = await loadSkill(id, project);
  if (!skill) {
    return false;
  }
  if (!skill.inspection.compatible) {
    getHost().toast(
      `${made.join('；')}。但它现在不兼容（${describeIncompat(skill.inspection.reasons)}），绑不上——打开改掉那几处再到设置页「技能」里绑。`,
      'error'
    );
    return false;
  }
  const { bindings } = await readSkillBindings(project);
  const current = bindings.planning;
  const replacing = current && current !== id ? await loadSkill(current, project) : undefined;
  const label = skillLabel(skill.inspection);
  const pick = await getHost().confirm(
    `${made.join('；')}。把「${label}」绑到「${SKILL_STAGE_LABEL.planning}」阶段吗？`,
    ['绑到规划'],
    {
      detail: [
        '绑上之后，本工程架构、情节大纲与细纲的每一次生成都会把它放在提示词最前面（对话页、agent、工程页批量都带）。',
        current ? `「${SKILL_STAGE_LABEL.planning}」现在绑的是「${replacing ? skillLabel(replacing.inspection) : current}」，会被换掉。` : '',
        '不绑也可以：以后在设置页「技能」里绑。建议先打开看一遍。',
      ]
        .filter(Boolean)
        .join('\n'),
    }
  );
  if (pick !== '绑到规划') {
    if (skill.relPath) {
      await getHost().openFile(skill.relPath);
    }
    return false;
  }
  try {
    await saveSkillBinding(project, ws, 'planning', id);
    getHost().toast(`已把「${label}」绑到「${SKILL_STAGE_LABEL.planning}」阶段。`);
    return true;
  } catch (err) {
    getHost().toast(`没绑上：${describeError(err)}`, 'error');
    return false;
  }
}
