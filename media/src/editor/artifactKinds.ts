/**
 * 一份文件是哪一类（后端 `kindOfPath` 给的种类）怎么叫：存档点弹窗（`view/checkpoints.ts`）与「版本」侧栏的全书改动
 * （`versions.ts`）共用这一张表——同一份文件不许在两处叫两个名字。路径就在旁边，这里只要一眼分得出是正文还是设定；
 * 架构三件（小说配置、故事前提、世界观）合称「架构」，同「转到…」面板上的标记。纯数据、零 DOM，view.js 也打包它。
 */
import type { ArtifactKind } from '../protocol';

export const KIND_LABEL: Record<ArtifactKind, string> = {
  chapter: '章节',
  plot: '细纲',
  character: '角色卡',
  lore: '设定',
  draft: '草稿',
  setting: '架构',
  outline: '大纲',
  style: '文风',
  threads: '叙事线',
  globalSummary: '全文大纲',
  skill: '技能',
  sensitive: '敏感词表',
  other: '其他',
};

/** 全书改动里各组的先后：正文那一串在前，设定类在后。 */
export const KIND_ORDER: readonly ArtifactKind[] = [
  'chapter',
  'plot',
  'draft',
  'character',
  'lore',
  'setting',
  'outline',
  'style',
  'threads',
  'globalSummary',
  'skill',
  'sensitive',
  'other',
];
