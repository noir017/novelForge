import * as vscode from 'vscode';
import { NovelProject } from '../core/model/project';
import { Attachment, AttachmentKind } from '../core/model/session';

/**
 * Cursor 式的上下文引用。
 *
 * 两个入口：`@` 打开 QuickPick 选文件，或者把编辑器里的选区一键加进来。
 */

interface PickItem extends vscode.QuickPickItem {
  attachment?: Attachment;
  browse?: boolean;
}

/** 打开引用选择器，列出工程内常用文件，末尾提供「浏览工作区」。 */
export async function pickAttachment(project: NovelProject): Promise<Attachment | undefined> {
  const items: PickItem[] = [];

  const chapters = await project.listChapters();
  if (chapters.length > 0) {
    items.push({ label: '章节', kind: vscode.QuickPickItemKind.Separator });
    for (const c of [...chapters].reverse()) {
      items.push({
        label: `$(book) ${String(c.order).padStart(3, '0')} ${c.title}`,
        description: `${c.wordCount} 字`,
        detail: c.relPath,
        attachment: fileAttachment('chapter', `第${c.order}章 ${c.title}`, c.relPath),
      });
    }
  }

  const characters = await project.listCharacters();
  if (characters.length > 0) {
    items.push({ label: '角色', kind: vscode.QuickPickItemKind.Separator });
    for (const card of characters) {
      items.push({
        label: `$(person) ${card.name}`,
        description: card.tags.join(' · '),
        detail: card.relPath,
        attachment: fileAttachment('character', `角色 ${card.name}`, card.relPath),
      });
    }
  }

  const lore = await project.listLore();
  if (lore.length > 0) {
    items.push({ label: '设定', kind: vscode.QuickPickItemKind.Separator });
    for (const entry of lore) {
      items.push({
        label: `$(globe) ${entry.title}`,
        description: entry.keywords.join('/'),
        detail: entry.relPath,
        attachment: fileAttachment('lore', `设定 ${entry.title}`, entry.relPath),
      });
    }
  }

  items.push({ label: '其他', kind: vscode.QuickPickItemKind.Separator });
  const outlineRel = project.relPath(project.outlineUri);
  items.push({
    label: '$(list-tree) 全书大纲',
    detail: outlineRel,
    attachment: fileAttachment('file', '全书大纲', outlineRel),
  });
  const styleRel = project.relPath(project.styleUri);
  items.push({
    label: '$(symbol-color) 文风指南',
    detail: styleRel,
    attachment: fileAttachment('file', '文风指南', styleRel),
  });
  items.push({ label: '$(folder-opened) 浏览工作区文件…', browse: true, alwaysShow: true });

  const picked = await vscode.window.showQuickPick(items, {
    title: '引用到上下文',
    placeHolder: '选择要加入本轮对话的内容',
    matchOnDetail: true,
  });
  if (!picked) {
    return undefined;
  }
  if (picked.browse) {
    return browseWorkspace(project);
  }
  return picked.attachment;
}

async function browseWorkspace(project: NovelProject): Promise<Attachment | undefined> {
  const uris = await vscode.window.showOpenDialog({
    title: '选择要引用的文件',
    canSelectMany: false,
    defaultUri: project.root,
    openLabel: '引用',
  });
  const uri = uris?.[0];
  if (!uri) {
    return undefined;
  }
  const rel = project.relPath(uri);
  return fileAttachment('file', baseName(rel), rel);
}

/**
 * 把当前编辑器的选区做成附件。
 *
 * 存快照而非路径+行号：用户选的时候是那个样子，之后文件改了
 * 不该让历史对话里的引用跟着变。
 */
export function selectionAttachment(project: NovelProject): Attachment | undefined {
  const editor = vscode.window.activeTextEditor;
  if (!editor || editor.selection.isEmpty) {
    return undefined;
  }
  const text = editor.document.getText(editor.selection).trim();
  if (!text) {
    return undefined;
  }
  const start = editor.selection.start.line + 1;
  const end = editor.selection.end.line + 1;
  const rel = project.relPath(editor.document.uri);
  const name = baseName(rel);
  return {
    // 同一处选区重复添加时 id 相同，前端会去重。
    id: `sel:${rel}:${start}-${end}`,
    kind: 'selection',
    label: `${name}:${start}-${end}`,
    relPath: rel,
    range: { start, end },
    text,
  };
}

function fileAttachment(kind: AttachmentKind, label: string, relPath: string): Attachment {
  return { id: `${kind}:${relPath}`, kind, label, relPath };
}

function baseName(relPath: string): string {
  const segs = relPath.split('/');
  return segs[segs.length - 1];
}
