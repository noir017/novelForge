import * as vscode from 'vscode';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';

/**
 * 把当前编辑器的选区做成附件（插件专属能力，由 VsCodeHost 暴露给 core）。
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
  const rel = project.relPath(editor.document.uri.fsPath);
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

function baseName(relPath: string): string {
  const segs = relPath.split('/');
  return segs[segs.length - 1];
}
