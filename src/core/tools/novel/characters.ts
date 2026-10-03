/**
 * `characters` —— 角色卡：提取、建卡、增量更新 / 重写、清理别名、合并重复、对比「当前状态」。
 *
 * 每个动作都是工程页角色卡那几颗按钮背后的同一个函数，确认框、提示条都在 feature 自己那里。
 * 这几个 feature 不报调用次数，回给模型的只有一句「交出去了」（`handed`），次数以确认框为准。
 *
 * 出场人物的唯一真相是摘要（第 14 条）：建卡认的是摘要里出场、还没有卡的人，`name` 要与摘要
 * 里的写法一致。
 */
import { str } from '../schema';
import { defineActionTool, handed } from './actions';
import {
  createCardForCast,
  createCardsForAllCast,
  updateAllCharacterCards,
  updateCharacterCard,
} from '../../features/characterCard';
import { cleanCharacterAliases, mergeDuplicateCharacterCards } from '../../features/characterMaintenance';
import { reviewCharacterState } from '../../features/characterState';
import { extractCharacters } from '../../features/characters';

const CARD = ['path'];

export const charactersTool = defineActionTool({
  name: 'characters',
  summary: '角色卡。出场人物以各章摘要为准：先定稿（summary finalize）再建卡、更新卡。',

  params: {
    path: str('那张角色卡的工程内相对路径。'),
    name: str('出场人物的名字，与摘要里的写法一致。'),
  },

  actions: {
    extract: {
      label: '通读已写正文，提取主要角色写成角色卡',
      costly: true,
      async run(ctx) {
        await extractCharacters(ctx.project);
        return handed('提取角色');
      },
    },
    create: {
      label: '给一位还没有卡的出场人物建卡',
      costly: true,
      uses: ['name'],
      requires: ['name'],
      async run(ctx, args) {
        const name = String(args.name).trim();
        await createCardForCast(ctx.project, name);
        return handed(`「${name}」建卡`);
      },
    },
    createAll: {
      label: '给摘要里所有还没有卡的出场人物建卡',
      costly: true,
      async run(ctx) {
        await createCardsForAllCast(ctx.project);
        return handed('批量建卡');
      },
    },
    update: {
      label: '按新出场的章增量更新一张角色卡',
      costly: true,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await updateCharacterCard(ctx.project, String(args.path).trim(), 'incremental');
        return handed(`角色卡 ${args.path} 增量更新`);
      },
    },
    rebuild: {
      label: '按全部出场章重写一张角色卡',
      costly: true,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await updateCharacterCard(ctx.project, String(args.path).trim(), 'full');
        return handed(`角色卡 ${args.path} 重写`);
      },
    },
    updateAll: {
      label: '把所有角色卡按新出场的章增量更新一遍',
      costly: true,
      async run(ctx) {
        await updateAllCharacterCards(ctx.project, 'incremental');
        return handed('全部角色卡增量更新');
      },
    },
    rebuildAll: {
      label: '按全部出场章重写所有角色卡',
      costly: true,
      async run(ctx) {
        await updateAllCharacterCards(ctx.project, 'full');
        return handed('全部角色卡重写');
      },
    },
    cleanAliases: {
      label: '清理角色卡别名里的泛称与别人的名字（只改 aliases，正文不动）',
      costly: false,
      async run(ctx) {
        await cleanCharacterAliases(ctx.project);
        return handed('别名清理');
      },
    },
    mergeDuplicates: {
      label: '找出指向同一个人的重复角色卡并合并（合并哪几组由作者确认）',
      costly: false,
      async run(ctx) {
        await mergeDuplicateCharacterCards(ctx.project);
        return handed('重复角色卡合并');
      },
    },
    reviewState: {
      label: '定稿时作者改过、机器没覆盖的那张卡的「当前状态」：拿出机器那一版请作者对比决定换不换',
      costly: false,
      uses: CARD,
      requires: CARD,
      async run(ctx, args) {
        await reviewCharacterState(ctx.project, String(args.path).trim());
        return handed(`角色卡 ${args.path} 的当前状态对比`);
      },
    },
  },
});
