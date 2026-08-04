import * as vscode from 'vscode';
import { CancelledError, ChatOptions, collectStream } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { readConfig } from '../config';
import { NovelProject } from '../model/project';
import { takeHead } from '../context/tokenizer';
import { stripCodeFence } from './summarize';

/**
 * 从样章提取文风指南，写入 .novelforge/style.md。
 * 覆盖前先确认——style.md 常被作者手工调过。
 */
export async function extractStyle(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    void vscode.window.showWarningMessage('Novel Forge：还没有章节，无法提取文风。');
    return;
  }

  const picked = await vscode.window.showQuickPick(
    chapters.map((c) => ({
      label: `${String(c.order).padStart(3, '0')} ${c.title}`,
      description: `${c.wordCount} 字`,
      chapter: c,
      picked: c.order <= 2,
    })),
    {
      title: '选取 1~3 章最能代表文风的样章',
      canPickMany: true,
      placeHolder: '建议选写得最顺手的章节，模型会以此为准归纳文风。',
    }
  );
  if (!picked || picked.length === 0) {
    return;
  }
  if (picked.length > 3) {
    void vscode.window.showWarningMessage('Novel Forge：最多选 3 章，只取前 3 章。');
  }

  const existing = await project.readStyleGuide();
  if (existing.trim() && !isTemplate(existing)) {
    const confirm = await vscode.window.showWarningMessage(
      '已存在文风指南，重新提取会覆盖当前内容（可用 Git 或撤销恢复）。',
      { modal: true },
      '覆盖'
    );
    if (confirm !== '覆盖') {
      return;
    }
  }

  const provider = await resolveProvider();
  if (!provider) {
    return;
  }
  const config = readConfig();

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: 'Novel Forge：提取文风指南', cancellable: true },
    async (progress, token) => {
      // TODO(Task 5): 换成 getHost().progress(signal, report) 后删掉此桥接
      const abort = new AbortController();
      token.onCancellationRequested(() => abort.abort(new CancelledError()));
      progress.report({ message: '读取样章' });
      const parts: string[] = [];
      for (const p of picked.slice(0, 3)) {
        parts.push(`【样章：第${p.chapter.order}章 ${p.chapter.title}】\n${await project.readChapterText(p.chapter)}`);
      }
      const corpus = takeHead(parts.join('\n\n'), Math.max(3000, config.contextWindow - config.maxOutputTokens - 2000));

      progress.report({ message: '分析文风特征' });
      const options: ChatOptions = {
        maxOutputTokens: Math.min(config.maxOutputTokens, 2000),
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal: abort.signal,
      };
      const raw = await collectStream(
        provider.chatStream(
          [
            { role: 'system', content: STYLE_SYSTEM },
            { role: 'user', content: corpus },
          ],
          options
        )
      );
      if (abort.signal.aborted) {
        return;
      }

      const uri = await project.writeStyleGuide(stripCodeFence(raw));
      void vscode.window.showInformationMessage('Novel Forge：文风指南已生成，建议人工过一遍再用。');
      await vscode.window.showTextDocument(await vscode.workspace.openTextDocument(uri));
    }
  );
}

function isTemplate(text: string): boolean {
  return text.includes('这份文件会在每次续写时注入 LLM');
}

const STYLE_SYSTEM = `你是文学编辑，需要从作者的样章中归纳出一份「文风指南」。这份指南会在每次 AI 续写时注入模型，用来保证续写内容与原作风格一致，因此必须**具体、可执行**，不能是「文笔优美」这类无法操作的空话。

请按以下小节输出 Markdown，不要增删小节，不要输出任何前言后语：

## 叙事视角
人称、视角类型（限知/全知）、视角是否切换、时态。

## 句式节奏
平均句长、长短句配比、段落长度、不同场景（对话/动作/描写）下的节奏差异。请给出具体倾向，例如「动作段落多用 10 字以内短句连排」。

## 遣词特征
偏好的词汇色彩（书面/口语、雅/俗）、常见的动词与形容词习惯、是否使用文言词、方言或特定行业词汇。请从样章中摘 3-5 个典型词例。

## 对白风格
对白占比、提示语写法（「他说」还是动作代替）、不同人物的说话差异、是否使用大段独白。

## 描写偏好
环境描写的密度与切入方式、心理描写的处理、感官描写侧重（视觉/听觉/嗅觉）。

## 修辞习惯
比喻/排比等修辞的使用频率与偏好类型，是否克制。

## 禁用清单
从样章中反推出作者**明显回避**的写法，逐条列出（如「不使用『不禁』『顿时』」「不写上帝视角评论」「不用感叹号」）。这一节直接影响续写质量，请尽量列全。

要求：所有结论必须能从样章中找到依据，宁可少写也不要臆测。用简体中文。`;
