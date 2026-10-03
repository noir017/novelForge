/**
 * `book` —— 拆书：导入原稿、从已写正文补齐、从参考书学写法。
 *
 * 都是工程页那几颗按钮背后的同一个函数。`import` 会新建章节文件——建的是作者自己那本 txt 里的章，
 * 切分结果先在确认框里给作者看，同名一律不覆盖。要 `path` 的两个只认工程里的 txt
 * （`features/bookText.ts` 的那张清单），不认章节文件、隐藏目录与工程外的路径。
 */
import { str } from '../schema';
import { countedBy, defineActionTool } from './actions';
import { importManuscript } from '../../features/importManuscript';
import { deriveFromText } from '../../features/derive';
import { learnFromReference } from '../../features/reference';

const TXT = ['path'];

export const bookTool = defineActionTool({
  name: 'book',
  summary:
    '拆书：作者有写好的稿子要接上来，或想学别人的书怎么写。txt 要先放在工程里。' +
    '典型顺序：import 导入原稿 → derive 从已写正文补齐架构、大纲、细纲、摘要与角色卡。',

  params: {
    path: str('工程里那本 txt 的相对路径。'),
  },

  actions: {
    import: {
      label: '导入原稿：把一本 txt 按章标题切成章节，接在已有章节之后（切分结果先给作者看；导入本身不调模型，导入完作者可以选择接着补齐）',
      costly: true,
      uses: TXT,
      requires: TXT,
      async run(ctx, args) {
        const r = await importManuscript(ctx.project, { path: String(args.path).trim() });
        if (r.imported === 0) {
          return {
            text: '这一次没有导入：要么作者取消了，要么认不出章节标题（每章开头要有单独一行「第一章 xxx」）。不要重试同一个动作——先问作者。',
            calls: 0,
          };
        }
        return {
          text:
            `已导入 ${r.imported} 章。` +
            (r.calls > 0 ? `作者接着从已写正文补齐了，调用模型 ${r.calls} 次，结果见工程页。` : '作者没有接着补齐；需要时用 derive。'),
          calls: r.calls,
        };
      },
    },
    derive: {
      label: '从已写正文补齐：照第 1 章起连续写成的正文，补上缺的摘要、角色卡、架构四件、情节大纲、细纲与全书摘要（只补空白，已有的不动；动手前报调用次数）',
      costly: true,
      async run(ctx) {
        return countedBy(await deriveFromText(ctx.project), '从已写正文补齐', '那几样都已经有了，或者还没有正文');
      },
    },
    learn: {
      label: '从一本参考书学写法：文风写进 style.md，结构与节奏写成一份「规划」阶段的写作技能（只学怎么写，不复述原书的情节与人名，原文不进工程）',
      costly: true,
      uses: TXT,
      requires: TXT,
      async run(ctx, args) {
        const r = await learnFromReference(ctx.project, { path: String(args.path).trim() });
        const made = [
          r.style ? `文风写进了 ${r.style}` : '',
          r.skill ? `写法写成了技能 ${r.skill.id}${r.skill.bound ? '，已绑到规划阶段' : '，没有绑'}` : '',
        ]
          .filter(Boolean)
          .join('；');
        return made
          ? { text: `${made}。`, calls: r.calls }
          : { text: '这一次什么都没写：要么作者取消了，要么没学成（见工程页提示）。不要重试同一个动作——先问作者。', calls: r.calls };
      },
    },
  },
});
