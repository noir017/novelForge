import * as vscode from 'vscode';
import { CreationSession } from '../../core/features/creation';
import { NovelProject } from '../../core/model/project';

/** 供命令面板走的极简续写（不开 Webview），结果流式写入新文档。 */
export async function quickContinue(project: NovelProject): Promise<void> {
  const outline = await vscode.window.showInputBox({
    title: 'Novel: 快速续写',
    prompt: '输入接下来的剧情纲要（详细的写作请用续写面板）',
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : '纲要不能为空'),
  });
  if (!outline) {
    return;
  }

  const order = await project.nextChapterOrder();
  const session = new CreationSession(project);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novel Forge：生成中', cancellable: true },
    async (_progress, token) => {
      token.onCancellationRequested(() => session.stop());
      await session.generate(
        {
          action: { stage: 'manuscript', capability: 'generate' },
          // 快速续写永远写「下一章」，那一章还不存在，relPath 留空。
          target: { kind: 'manuscript', chapterRelPath: '' },
          targetOrder: order,
          ask: outline,
        },
        {
          onDelta: (delta) => {
            void editor.edit(
              (b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, delta),
              { undoStopBefore: false, undoStopAfter: false }
            );
          },
          onDone: () => void vscode.window.showInformationMessage('Novel Forge：生成完成。'),
          onError: (msg) => void vscode.window.showErrorMessage(`Novel Forge：${msg}`),
          onCancelled: () => void vscode.window.showInformationMessage('Novel Forge：已取消。'),
        }
      );
    }
  );
}
