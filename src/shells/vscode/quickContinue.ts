import * as vscode from 'vscode';
import { generate } from '../../core/generation/generate';
import { NovelProject } from '../../core/model/project';
import { buildBookFacts } from '../../core/views/pipeline';

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

  // 写的是**下一可写章**：从第 1 章起连续有正文的最大章号 + 1，与主按钮同一个判据
  // （第 20 条）。从前用「细纲号与章号里最大的 + 1」，排了十章细纲只写了三章时，
  // 快速续写会跳到第 11 章去。
  const no = (await buildBookFacts(project)).nextChapterNo;
  const plot = await project.getPlot(no);
  const doc = await vscode.workspace.openTextDocument({ language: 'markdown', content: '' });
  const editor = await vscode.window.showTextDocument(doc, { preview: false });
  // 这条路不开面板，也就没有 controller 替它管并发——自带一个 abort 即可。
  const abort = new AbortController();

  /** 整份换掉：续写丢弃过的那一轮、以及收尾时的去重，都要反映到文档里。 */
  const replaceAll = (text: string) =>
    editor.edit((b) => b.replace(new vscode.Range(doc.positionAt(0), doc.positionAt(doc.getText().length)), text));

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novel Forge：生成中', cancellable: true },
    async (progress, token) => {
      token.onCancellationRequested(() => abort.abort());
      await generate(
        project,
        {
          action: { stage: 'manuscript', capability: 'generate' },
          // 那一章的细纲多半还不存在，target 指向它**应该**在的位置（细纲号 = 章号），
          // 装配器按这个号定位前文。目标字数由生成层兜底（细纲 → 配置的每章字数）。
          target: { kind: 'manuscript', plotRelPath: plot?.relPath ?? project.plotPathForNo(no, '') },
          targetNo: no,
          ask: outline,
          // 这一章已经写了一半时从末尾接着写；还没有正文时生成层会按新写处理。
          writeMode: 'continue',
        },
        {
          onDelta: (delta) => {
            void editor.edit(
              (b) => b.insert(doc.lineAt(doc.lineCount - 1).range.end, delta),
              { undoStopBefore: false, undoStopAfter: false }
            );
          },
          onReset: (full) => void replaceAll(full),
          onProgress: (p) =>
            progress.report({
              message: `${p.round > 0 ? `续写第 ${p.round} 轮 · ` : ''}${p.words}${p.target ? ` / ${p.target}` : ''} 字`,
            }),
          onDone: (full) => {
            void replaceAll(full);
            void vscode.window.showInformationMessage('Novel Forge：生成完成。');
          },
          onError: (msg) => void vscode.window.showErrorMessage(`Novel Forge：${msg}`),
          onCancelled: () => void vscode.window.showInformationMessage('Novel Forge：已取消。'),
        },
        { signal: abort.signal }
      );
    }
  );
}
