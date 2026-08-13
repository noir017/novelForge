import { getHost } from '../host';
import { ChatOptions, collectStream } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { stripCodeFence } from './parse';
import { pickChaptersByInput } from './pickChapters';
import { STYLE_SYSTEM } from './stylePrompt';

const log = scoped('文风');

/**
 * 从样章提取文风指南，写入 .novelforge/style.md。
 * 覆盖前先确认——style.md 常被作者手工调过。
 */
export async function extractStyle(project: NovelProject): Promise<void> {
  const chapters = await project.listChapters();
  if (chapters.length === 0) {
    log.warn('还没有章节，无法提取文风');
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
    log.info('用户取消了样章选择');
    return;
  }
  if (picked.length > 3) {
    log.warn(`选了 ${picked.length} 章，只取前 3 章`);
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
      log.info('用户拒绝覆盖已有文风指南');
      return;
    }
    log.warn('用户确认覆盖已有文风指南', `原内容 ${existing.length} 字`);
  }

  // 只有一次调用，谈不上并发；走池是为了拿到「首选失败就换模型」。
  const pool = await createModelPool({ task: 'extractStyle', concurrent: false });
  if (!pool) {
    log.error('没有可用的模型，提取中止');
    return;
  }
  const config = readConfig();
  const samples = picked.slice(0, 3);
  log.info(
    `准备从 ${samples.length} 章样章提取文风`,
    `章节 ${samples.map((c) => c.order).join('、')}｜模型 ${pool.label}`
  );

  await runTask(
    '提取文风指南',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      report({ message: '读取样章', current: 0, total: 2 });
      const parts: string[] = [];
      for (const chapter of samples) {
        parts.push(`【样章：第${chapter.order}章 ${chapter.title}】\n${await project.readChapterText(chapter)}`);
      }
      const joined = parts.join('\n\n');
      const budget = Math.max(
        3000,
        pool.primaryBudget.contextWindow - pool.primaryBudget.maxOutputTokens - 2000
      );
      const corpus = takeHead(joined, budget);
      if (corpus.length < joined.length) {
        log.warn(
          '样章正文超出输入预算，已截断',
          `${joined.length} 字 → ${corpus.length} 字（预算 ${budget} token）。少选一章可让归纳更完整。`
        );
      }
      log.debug('样章已读取', `${corpus.length} 字（约 ${estimateTokens(corpus)} token）`);

      report({ message: '分析文风特征', current: 1, total: 2 });
      const options: ChatOptions = {
        maxOutputTokens: Math.min(pool.primaryBudget.maxOutputTokens, 2000),
        temperature: 0.3,
        timeoutMs: config.requestTimeoutMs,
        signal,
      };
      const modelStart = Date.now();
      const raw = await pool.run('提取文风', (llm) =>
        collectStream(
          llm.chatStream(
            [
              { role: 'system', content: STYLE_SYSTEM },
              { role: 'user', content: corpus },
            ],
            options
          )
        )
      );
      log.info('模型已返回', `${raw.length} 字，用时 ${elapsed(modelStart)}`);
      if (signal.aborted) {
        log.warn('提取被取消，未写盘');
        return;
      }

      const relPath = await project.writeStyleGuide(stripCodeFence(raw));
      report({ message: '完成', current: 2, total: 2 });
      log.info('文风指南已写入', `${relPath}｜总耗时 ${elapsed(startedAt)}`);
      getHost().toast('文风指南已生成，建议人工过一遍再用。');
      await getHost().openFile(project.relPath(project.stylePath));
    },
    { scope: '文风' }
  );
}

function isTemplate(text: string): boolean {
  return text.includes('这份文件会在每次续写时注入 LLM');
}
