/**
 * 重演检测：新写的这一章，开头是不是把上一章的结尾又演了一遍。
 *
 * 移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`generate-draft.command.ts`
 * 的 `hasSubstantialPreviousChapterReuse`（GD:276-317）与 `chapter-materials.ts` 的
 * `previousChapterEnding`（:88-97）。
 *
 * ## 为什么要查
 *
 * 模型拿到「上一章结尾原文」之后，最常见的失败不是接不上，而是**从那里重新演一遍**：
 * 同一场对话、同一个动作链换几个字再写一次。读者读到第二章开头就会觉得见过。
 * 提示词里说了「不可重演」（context/prompts.ts），这里是写完之后的那道核对。
 *
 * ## 判法
 *
 * 两边各自归一（NFKC、小写、去空白与标点），把上一章结尾切成 8 字一段的 n-gram，
 * 标出新稿前 1200 字里被这些 n-gram 覆盖的位置；**连续覆盖 ≥ 80 字**才算重演。
 * 零星撞上几个词组（人名 + 动词）凑不出 80 字的连续段，刻意呼应的一句台词通常也凑不出。
 *
 * ## 不在这里决定拒不拒收
 *
 * 上游命中就整份作废。这里只报「命中了、重合的是哪一段」，由卡片标红、让作者点两下
 * 再写入（总计划 §2.4）——有时重合的是作者要的呼应，判断得交给人。
 */

/** 上一章结尾取多少字。 */
export const PREVIOUS_ENDING_CHARS = 1000;
/** 新稿只看开头这么多字：重演只会出在开头。 */
export const REPLAY_HEAD_CHARS = 1200;
/** 中文按 8 字一段比对（上游 `CROSS_CHAPTER_REUSE_CJK_NGRAM_CHARS`）。 */
export const REPLAY_NGRAM = 8;
/** 连续覆盖这么多字才算重演（上游 `CROSS_CHAPTER_REUSE_LONG_RUN_CHARS`）。 */
export const REPLAY_RUN = 80;

/**
 * 上一章的结尾：最后约 {@link PREVIOUS_ENDING_CHARS} 字，开头对齐到段落或句子边界——
 * 从半句话开始比对，第一个 n-gram 就是残的。
 */
export function previousEnding(text: string, max = PREVIOUS_ENDING_CHARS): string {
  const trimmed = text.trim();
  if (trimmed.length <= max) {
    return trimmed;
  }
  const tail = trimmed.slice(-max);
  const boundary = /(?:\r?\n\s*\r?\n|[。！？!?][”’"'）)\]】」』]*|\.[”’"')\]]*(?=\s|$))/u.exec(tail);
  return boundary ? tail.slice(boundary.index + boundary[0].length).trim() || tail.trim() : tail.trim();
}

export interface ReplayVerdict {
  hit: boolean;
  /** 新稿里重合的那一段原文（带标点），给作者看。 */
  quote?: string;
  /** 那一段归一之后有多少字。 */
  run?: number;
}

/** 空白、标点、符号：归一时一律去掉。 */
const NOISE = /[\s\p{P}\p{S}]/u;

/** 逐个码点归一，记下每个留下来的字在原文里的位置——命中之后要把原文那一段摘出来。 */
function normalizeWithPositions(text: string): { chars: string[]; pos: number[] } {
  const chars: string[] = [];
  const pos: number[] = [];
  let index = 0;
  for (const cp of text) {
    for (const ch of cp.normalize('NFKC').toLowerCase()) {
      if (!NOISE.test(ch)) {
        chars.push(ch);
        pos.push(index);
      }
    }
    index += cp.length;
  }
  return { chars, pos };
}

/**
 * 新稿开头有没有大段重演上一章结尾。
 *
 * 任一边归一之后不到一个 n-gram 就不判（`hit: false`）——第 1 章、上一章只有几个字，
 * 都不是这道检查要管的事。
 */
export function detectReplay(prevEnding: string, draft: string): ReplayVerdict {
  const prev = normalizeWithPositions(prevEnding).chars.join('');
  const headText = draft.slice(0, REPLAY_HEAD_CHARS);
  const head = normalizeWithPositions(headText);
  const n = REPLAY_NGRAM;
  if (prev.length < n || head.chars.length < n) {
    return { hit: false };
  }

  const grams = new Set<string>();
  for (let i = 0; i <= prev.length - n; i++) {
    grams.add(prev.slice(i, i + n));
  }
  const line = head.chars.join('');
  const covered = new Uint8Array(head.chars.length);
  for (let i = 0; i <= line.length - n; i++) {
    if (grams.has(line.slice(i, i + n))) {
      covered.fill(1, i, i + n);
    }
  }

  // 找最长的一段连续覆盖：报给作者的是最刺眼的那一处。
  let best = { start: 0, length: 0 };
  let start = -1;
  for (let i = 0; i <= covered.length; i++) {
    if (i < covered.length && covered[i]) {
      if (start < 0) {
        start = i;
      }
      continue;
    }
    if (start >= 0 && i - start > best.length) {
      best = { start, length: i - start };
    }
    start = -1;
  }
  if (best.length < REPLAY_RUN) {
    return { hit: false };
  }
  const from = head.pos[best.start];
  const last = head.pos[best.start + best.length - 1];
  // 末字可能是一个代理对（生僻字），按码点取完整。
  const to = last + (headText.codePointAt(last)! > 0xffff ? 2 : 1);
  return { hit: true, quote: headText.slice(from, to), run: best.length };
}
