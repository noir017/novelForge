import { getHost } from '../host';
import { ChatOptions, collectStream } from '../llm/provider';
import { resolveProvider } from '../llm/registry';
import { readConfig } from '../config';
import { NovelProject } from '../model/project';
import { takeHead } from '../context/tokenizer';
import { pickChaptersByInput } from './pickChapters';
import { stripCodeFence } from './summarize';

/**
 * 从样章提取文风指南，写入 .novelforge/style.md。
 * 覆盖前先确认——style.md 常被作者手工调过。
 */
export async function extractStyle(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    getHost().toast('还没有章节，无法提取文风。');
    return;
  }

  // 默认拿前两章当样章，用户可改成写得最顺手的章节。
  const picked = await pickChaptersByInput(
    chapters,
    '选取 1~3 章最能代表文风的样章',
    '输入章节序号，逗号分隔，如 1,2,3',
    chapters.slice(0, 2).map((c) => c.order)
  );
  if (!picked || picked.length === 0) {
    return;
  }
  if (picked.length > 3) {
    getHost().toast('最多选 3 章，只取前 3 章。');
  }

  const existing = await project.readStyleGuide();
  if (existing.trim() && !isTemplate(existing)) {
    const confirm = await getHost().confirm(
      '已存在文风指南，重新提取会覆盖当前内容（可用 Git 或撤销恢复）。',
      ['覆盖'],
      { modal: true }
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

  await getHost().progress('Novel Forge：提取文风指南', async (signal, report) => {
    report('读取样章');
    const parts: string[] = [];
    for (const chapter of picked.slice(0, 3)) {
      parts.push(`【样章：第${chapter.order}章 ${chapter.title}】\n${await project.readChapterText(chapter)}`);
    }
    const corpus = takeHead(parts.join('\n\n'), Math.max(3000, config.contextWindow - config.maxOutputTokens - 2000));

    report('分析文风特征');
    const options: ChatOptions = {
      maxOutputTokens: Math.min(config.maxOutputTokens, 2000),
      temperature: 0.3,
      timeoutMs: config.requestTimeoutMs,
      signal,
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
    if (signal.aborted) {
      return;
    }

    await project.writeStyleGuide(stripCodeFence(raw));
    getHost().toast('文风指南已生成，建议人工过一遍再用。');
    await getHost().openFile(project.relPath(project.stylePath));
  });
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
