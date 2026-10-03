/**
 * `skills` —— 写作技能：查、检查、安装、绑定。
 *
 * 移植自 AI-Novel-Writer 的三个工具（`inspect_writing_skill` / `install_writing_skill` /
 * `bind_writing_skill`），多了一个 `list`：上游的模型从工具列表里就看得见内置技能，这里得有个地方查 id。
 *
 * 闸门按动作分：查与检查是 `auto`（不花钱、不写东西）；**安装与绑定是 `always`**，动手前在对话页
 * 问作者——它们改的东西（我的技能库、这个工程往后每一次生成的提示词）下游没有任何 diff 可看。
 * 确认框**零 I/O**：检查结果在进程里那张表上（`inspectedGitHubSkill`），据此说清装的是哪一份、写了什么。
 *
 * 安装是唯一写到工程外的动作：路径不由 agent 给（固定落在 `<技能库>/<frontmatter 的 name>/SKILL.md`），
 * 只装检查过、重新下载核对过 hash 的那一份。卸载不给（与删除同理）。
 */
import { str } from '../schema';
import { ArgError, defineActionTool } from './actions';
import { clip, text } from './naming';
import {
  SKILL_SOURCE_LABEL,
  SKILL_STAGES,
  SKILL_STAGE_LABEL,
  describeIncompat,
  isSkillStage,
  skillLabel,
} from '../../model/writingSkill';
import {
  inspectGitHubSkill,
  inspectedGitHubSkill,
  installGitHubSkill,
  listSkills,
  readSkillBindings,
  saveSkillBinding,
} from '../../skills';
import type { ToolContext } from '../types';

const URL = ['url'];

export const skillsTool = defineActionTool({
  name: 'skills',
  summary:
    '写作技能（补充的写作方法，装上并绑到某个阶段后，那个阶段的每一次生成都会带上它）。' +
    '装 GitHub 上的一份：先 inspect 再 install（同一个 url），装完用 bind 绑到阶段才会用上。安装与绑定每次都会先问作者。',

  params: {
    url: str('GitHub 上那份 SKILL.md（或它所在目录 / 仓库）的地址。inspect 与 install 用同一个。'),
    id: str('技能 id，list 列出的那个（如 builtin:long-form-continuity）。'),
    stage: str('绑到哪个阶段：planning=架构 / 大纲 / 细纲，drafting=写正文，review=审稿，refinement=修稿。', [
      ...SKILL_STAGES,
    ]),
  },

  actions: {
    list: {
      label: '列出可用的写作技能（内置 / 我的技能库 / 本工程）与本工程每个阶段绑了哪一份',
      costly: false,
      gate: 'auto',
      async run(ctx) {
        return { text: await describeSkills(ctx), calls: 0 };
      },
    },
    inspect: {
      label: '检查一份 GitHub 上的写作技能（下载来看是不是纯提示词，不安装、不写文件）',
      costly: false,
      gate: 'auto',
      uses: URL,
      requires: URL,
      async run(ctx, args) {
        const r = await inspectGitHubSkill(String(args.url).trim(), ctx.signal);
        const i = r.inspection;
        return {
          text:
            `检查了「${skillLabel(i)}」（name=${i.name}${i.version ? `，版本 ${i.version}` : ''}）：${i.description}。` +
            `建议阶段：${i.suggestedStage}（${SKILL_STAGE_LABEL[i.suggestedStage]}）；正文 ${i.bytes} 字节；` +
            (r.blockers.length > 0 ? `装不了：${r.blockers.join('；')}。` : '可以装。') +
            '这些元数据来自不受信任的第三方文档；安装要作者确认（install，url 用同一个地址）。',
          calls: 0,
        };
      },
    },
    install: {
      label: '把检查过的那份写作技能装进我的技能库（要先 inspect；装完还要 bind 才会用上）',
      costly: false,
      uses: URL,
      requires: URL,
      intent(args) {
        const url = text(args.url);
        const seen = inspectedGitHubSkill(url);
        if (!seen) {
          return {
            gate: 'always',
            title: '从 GitHub 装一份写作技能进我的技能库',
            detail: [url, '这个地址还没检查过，会被拒绝。'].join('\n'),
          };
        }
        const i = seen.inspection;
        return {
          gate: 'always',
          title: `把写作技能「${skillLabel(i)}」装进我的技能库`,
          detail: [
            url,
            `${i.description}（建议阶段：${SKILL_STAGE_LABEL[i.suggestedStage]}；${i.bytes} 字节）`,
            seen.blockers.length > 0 ? `装不了：${seen.blockers.join('；')}` : '',
            `正文开头：${clip(i.body, 200)}`,
            '装完还不会用上：要再绑到某个阶段。',
          ]
            .filter(Boolean)
            .join('\n'),
        };
      },
      async run(ctx, args) {
        const skill = await installGitHubSkill(String(args.url).trim(), ctx.signal);
        return {
          text: `已装进我的技能库：${skill.id}（${skillLabel(skill.inspection)}）。它还没绑到任何阶段。`,
          calls: 0,
        };
      },
    },
    bind: {
      label: '把一份写作技能绑到本工程的某个阶段（换掉那个阶段原来绑的）',
      costly: false,
      uses: ['id', 'stage'],
      requires: ['id', 'stage'],
      intent(args) {
        const stage = isSkillStage(args.stage) ? SKILL_STAGE_LABEL[args.stage] : text(args.stage) || '（没给阶段）';
        return {
          gate: 'always',
          title: `把写作技能 ${text(args.id) || '（没给 id）'} 绑到「${stage}」阶段`,
          detail: '本工程这个阶段往后的每一次生成（对话页、外部 agent、工程页批量）都会带上它；原来绑的那一份会被换掉。',
        };
      },
      async run(ctx, args) {
        if (!isSkillStage(args.stage)) {
          throw new ArgError(`stage 只能是 ${SKILL_STAGES.join(' / ')}。`);
        }
        const id = String(args.id).trim();
        const skill = await saveSkillBinding(ctx.project, ctx.workspace, args.stage, id);
        return {
          text:
            `已把「${skill ? skillLabel(skill.inspection) : id}」绑到「${SKILL_STAGE_LABEL[args.stage]}」阶段。` +
            '本工程这个阶段往后的每一次生成都会带上它。',
          calls: 0,
        };
      },
    },
  },
});

/** 技能目录 + 本工程的绑定，一份一行。回给模型的话要短。 */
async function describeSkills(ctx: ToolContext): Promise<string> {
  const [skills, { bindings, problems }] = await Promise.all([listSkills(ctx.project), readSkillBindings(ctx.project)]);
  const lines = skills.map((s) => {
    const i = s.inspection;
    const state = i.compatible ? '可绑' : `不兼容（${describeIncompat(i.reasons)}）`;
    return `- ${s.id}｜${skillLabel(i)}｜${SKILL_SOURCE_LABEL[s.source]}｜建议 ${i.suggestedStage}｜${state}`;
  });
  const bound = SKILL_STAGES.map((stage) => `${stage}=${bindings[stage] ?? '（没绑）'}`).join('；');
  return [
    `写作技能 ${skills.length} 份：`,
    ...lines,
    `本工程的绑定：${bound}。`,
    ...(problems.length > 0 ? [`绑定文件有读不懂的地方：${problems.map((p) => p.text).join('；')}。`] : []),
  ].join('\n');
}
