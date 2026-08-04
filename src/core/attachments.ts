import { PickChoice } from './host';
import { NovelProject } from './model/project';
import { Attachment, AttachmentKind } from './model/session';

/**
 * 构建 @ 引用的候选列表；展示与选择交给 Host.pick。
 * 「浏览工作区」入口只存在于插件的 QuickPick 实现里（Host.browseFile）。
 */
export async function listAttachmentChoices(project: NovelProject): Promise<PickChoice<Attachment>[]> {
  const choices: PickChoice<Attachment>[] = [];

  const chapters = await project.listChapters();
  for (const c of [...chapters].reverse()) {
    choices.push({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      detail: c.relPath,
      group: '章节',
      value: fileAttachment('chapter', `第${c.order}章 ${c.title}`, c.relPath),
    });
  }

  for (const card of await project.listCharacters()) {
    choices.push({
      label: card.name,
      description: card.tags.join(' · '),
      detail: card.relPath,
      group: '角色',
      value: fileAttachment('character', `角色 ${card.name}`, card.relPath),
    });
  }

  for (const entry of await project.listLore()) {
    choices.push({
      label: entry.title,
      description: entry.keywords.join('/'),
      detail: entry.relPath,
      group: '设定',
      value: fileAttachment('lore', `设定 ${entry.title}`, entry.relPath),
    });
  }

  const outlineRel = project.relPath(project.outlinePath);
  choices.push({
    label: '全书大纲',
    detail: outlineRel,
    group: '其他',
    value: fileAttachment('file', '全书大纲', outlineRel),
  });
  const styleRel = project.relPath(project.stylePath);
  choices.push({
    label: '文风指南',
    detail: styleRel,
    group: '其他',
    value: fileAttachment('file', '文风指南', styleRel),
  });

  return choices;
}

function fileAttachment(kind: AttachmentKind, label: string, relPath: string): Attachment {
  return { id: `${kind}:${relPath}`, kind, label, relPath };
}
