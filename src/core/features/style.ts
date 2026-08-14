import { getHost } from '../host';
import { ChatOptions, collectStream } from '../llm/provider';
import { createModelPool } from '../llm/pool';
import { readConfig } from '../config';
import { elapsed, scoped } from '../runtime/logger';
import { runTask } from '../runtime/progress';
import { NovelProject } from '../model/project';
import { Plot } from '../model/plotFile';
import { estimateTokens, takeHead } from '../context/tokenizer';
import { stripCodeFence } from './parse';
import { pickPlotsByInput } from './pickPlots';
import { STYLE_SYSTEM } from './stylePrompt';

const log = scoped('文风');

/**
 * 从样章提取文风指南，写入 .novelforge/style.md。
 * 覆盖前先确认——style.md 常被作者手工调过。
 */
export async function extractStyle(project: NovelProject): Promise<void> {
  // 只有写过正文的段才当得了样章——文风是从成稿里看出来的。
  const written: Plot[] = [];
  for (const plot of await project.listPlots()) {
    if ((await project.readManuscriptText(plot.relPath)).trim()) {
      written.push(plot);
    }
  }
  if (written.length === 0) {
    log.warn('还没有写过正文，无法提取文风');
    getHost().toast('还没有写过正文，无法提取文风。');
    return;
  }

  // 默认拿前两段当样章，用户可改成写得最顺手的那几段。
  const picked = await pickPlotsByInput(
    written,
    '选取 1~3 段最能代表文风的样章',
    '输入段号，逗号分隔，如 1,2,3',
    written.slice(0, 2).map((p) => p.no)
  );
  if (!picked || picked.length === 0) {
    log.info('用户取消了样章选择');
    return;
  }
  if (picked.length > 3) {
    log.warn(`选了 ${picked.length} 段，只取前 3 段`);
    getHost().toast('最多选 3 段，只取前 3 段。');
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
    `准备从 ${samples.length} 段样章提取文风`,
    `段落 ${samples.map((p) => p.no).join('、')}｜模型 ${pool.label}`
  );

  await runTask(
    '提取文风指南',
    async ({ signal, report }) => {
      const startedAt = Date.now();
      report({ message: '读取样章', current: 0, total: 2 });
      const parts: string[] = [];
      for (const plot of samples) {
        parts.push(
          `【样章：第${plot.no}段 ${plot.title}】\n${await project.readManuscriptText(plot.relPath)}`
        );
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
          `${joined.length} 字 → ${corpus.length} 字（预算 ${budget} token）。少选一段可让归纳更完整。`
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
