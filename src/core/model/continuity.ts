/**
 * 摘要里的「连续性事实」：后面各章必须保持一致的事实，每条挂一句正文里的证据原文（D18）。
 *
 * ```markdown
 * ## 连续性事实
 * - 林昭左臂被青鳞划伤，未愈 〔证据：「血顺着左臂往下淌，他把袖子扎紧了」〕
 * ```
 *
 * 两头都是**确定性**的，不调模型：
 *
 * - 定稿时（{@link attachEvidence}）：模型只给事实陈述，证据句用 bigram 在正文里找。
 *   移植自 AI-Novel-Writer（GPL-3.0，源自 AI_NovelGenerator）`finalize-chapter.command.ts`
 *   的 `textBigrams` / `evidenceExcerpt` / `buildFinalizedContinuityFacts`（FC:161-230）。
 * - 写正文时（{@link locateEvidence}）：拿证据原句回到那一章的正文里逐字定位，取所在段落
 *   与前后各一段。移植自 `chapter-materials.ts` 的 `adjacentEvidencePassages`（CM:47-86）。
 *
 * 为什么绕这一圈而不是直接把事实塞给模型：事实是模型对正文的**转述**，转述会走样；
 * 原文段落才是作者认可过的那一版（上游 CM:225：「索引、摘要和 currentState 都不是作者事实」）。
 */

/** 一条连续性事实。`evidence` 是正文里的一句原文；手改的摘要里可能没有。 */
export interface ContinuityFact {
  statement: string;
  evidence?: string;
}

/** 一章最多留几条（上游 `CONTINUITY_FACT_LIMIT`）。 */
export const CONTINUITY_FACT_LIMIT = 12;
/** 一条事实最长多少字（上游 `CONTINUITY_STATEMENT_LIMIT`）。 */
const STATEMENT_LIMIT = 280;
/** 证据句最长多少字（上游 `CONTINUITY_EVIDENCE_LIMIT`）。 */
const EVIDENCE_LIMIT = 240;

// ---------------------------------------------------------------- 渲染与解析

/** `- 陈述 〔证据：「原文」〕`，没有证据就只有陈述。 */
export function renderContinuityFacts(facts: readonly ContinuityFact[]): string {
  return facts
    .map((f) => `- ${f.statement.trim()}${f.evidence?.trim() ? ` 〔证据：「${f.evidence.trim()}」〕` : ''}`)
    .join('\n');
}

const EVIDENCE_TAIL = /\s*[〔\[【(（]\s*证据\s*[:：]\s*(.*?)\s*[〕\]】)）]\s*$/u;
const BULLET = /^\s*(?:[-*•·]|\d+[.)、])\s*/u;

/**
 * 读回「连续性事实」这一节。作者会手改（第 1 条），这几种写法都认：`〔证据：…〕` 用了半角或
 * 别的括号、证据没带引号、整行没写 `- `。认不出证据的行照样是一条事实，只是没有证据——
 * 写正文时降级成事实原句。空行与占位文字（`（待补充）`）跳过。
 */
export function parseContinuityFacts(text: string): ContinuityFact[] {
  const out: ContinuityFact[] = [];
  for (const raw of (text ?? '').split(/\r?\n/)) {
    const line = raw.replace(BULLET, '').trim();
    if (!line || /^[（(]待补充[）)]$/.test(line)) {
      continue;
    }
    const m = EVIDENCE_TAIL.exec(line);
    const statement = (m ? line.slice(0, m.index) : line).trim();
    const evidence = m ? unquote(m[1]) : '';
    if (!statement) {
      continue;
    }
    out.push(evidence ? { statement, evidence } : { statement });
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  const pairs: [string, string][] = [['「', '」'], ['“', '”'], ['"', '"'], ["'", "'"], ['『', '』']];
  for (const [a, b] of pairs) {
    if (t.length >= 2 && t.startsWith(a) && t.endsWith(b)) {
      return t.slice(a.length, -b.length).trim();
    }
  }
  return t;
}

// ---------------------------------------------------------------- 定稿：挂证据

/** 一段文字的 bigram 集合（只看字母与数字，标点与空白切开）。model/manuscriptCheck.ts 找钩子落在哪一段也用它。 */
export function textBigrams(value: string): Set<string> {
  const groups = value.toLocaleLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return new Set(
    groups.flatMap((group) => {
      const chars = [...group];
      return chars.length < 2 ? chars : chars.slice(0, -1).map((c, i) => c + chars[i + 1]);
    })
  );
}

function sentencesOf(content: string): string[] {
  return content
    .split(/(?<=[。！？.!?])|\n+/u)
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * 给一条事实在正文里找一句证据。找不到返回空串。
 *
 * 事实里提到了出场人物时先只在含那个人名的句子里找，而且算 bigram 之前先把人名去掉——
 * 不然「林昭」两个字就能让任何一句提到林昭的话「命中」。命中还要**有独立支撑**：要么
 * 事实的 bigram 全中，要么命中的 bigram 在事实里不是挨着的（挨着的只是同一个词）。
 *
 * **比上游多一步**：含人名的句子里找不到时，再在全部句子里按「没有人名」的门槛（至少两处
 * 命中）找一遍。中文正文里人名出现一次之后多半就换成「他」「她」了——上游只在含人名的句子
 * 里找，「血顺着左臂往下淌」这种最该当证据的句子反而永远找不到。
 */
function evidenceExcerpt(content: string, statement: string, entities: readonly string[]): string {
  const sentences = sentencesOf(content);
  const factEntities = entities.filter((e) => statement.includes(e));
  const withoutEntities = [...factEntities]
    .sort((a, b) => b.length - a.length)
    .reduce((text, e) => text.split(e).join(' '), statement);
  const signalList = [...textBigrams(withoutEntities)];
  const best = (candidates: string[], minimum: number): string | undefined =>
    candidates
      .map((sentence) => {
        const own = textBigrams(sentence);
        const matched = signalList.map((sig, i) => (own.has(sig) ? i : -1)).filter((i) => i >= 0);
        const independent = matched.some((index, k) => k > 0 && index - matched[k - 1] > 1);
        return {
          sentence,
          score: matched.length,
          supported: signalList.length > 0 && (matched.length === signalList.length || independent),
        };
      })
      .sort((a, b) => b.score - a.score)
      .find((c) => c.score >= minimum && c.supported)?.sentence;
  const hit =
    factEntities.length > 0
      ? (best(sentences.filter((s) => factEntities.some((e) => s.includes(e))), 1) ?? best(sentences, 2))
      : best(sentences, 2);
  return (hit ?? '').slice(0, EVIDENCE_LIMIT).trim();
}

/**
 * 定稿时给每条事实挂证据。**找不到证据的事实丢掉**（与上游同）：没有原文撑着的「事实」
 * 多半是模型编的，留在摘要里会被后面几章当真。丢了哪几条交给调用方写进日志（第 2 条）。
 *
 * `entities` 是本章出场人物的名字与别名（摘要的「出场人物」）。
 */
export function attachEvidence(
  statements: readonly string[],
  content: string,
  entities: readonly string[] = []
): { facts: ContinuityFact[]; dropped: string[] } {
  const names = [...new Set(entities.map((e) => e.trim()).filter((e) => e.length >= 2))].slice(0, 8);
  const facts: ContinuityFact[] = [];
  const dropped: string[] = [];
  for (const raw of statements) {
    const statement = raw.replace(BULLET, '').trim().slice(0, STATEMENT_LIMIT);
    if (!statement) {
      continue;
    }
    const evidence = evidenceExcerpt(content, statement, names);
    if (!evidence) {
      dropped.push(statement);
      continue;
    }
    if (facts.length < CONTINUITY_FACT_LIMIT) {
      facts.push({ statement, evidence });
    } else {
      dropped.push(statement);
    }
  }
  return { facts, dropped };
}

// ---------------------------------------------------------------- 写正文：定位原文

function paragraphsOf(content: string): string[] {
  return content
    .split(/\r?\n\s*\r?\n/u)
    .map((p) => p.trim())
    .filter(Boolean);
}

const squash = (s: string): string => s.replace(/\s+/g, '');

/**
 * 拿证据原句回到正文里逐字定位（空白不计），取命中那一段与前后各一段，相邻的窗口合并。
 *
 * `hits[i]` 说第 i 句找没找到——找不到多半是作者改过正文，调用方把那一条降级成事实原句
 * 并写进明细（D18、第 2 条）。
 */
export function locateEvidence(
  content: string,
  quotes: readonly string[]
): { passages: string[]; hits: boolean[] } {
  const paragraphs = paragraphsOf(content);
  const squashed = paragraphs.map(squash);
  const windows: [number, number][] = [];
  const hits = quotes.map((quote) => {
    const q = squash(quote);
    if (!q) {
      return false;
    }
    const index = squashed.findIndex((p) => p.includes(q));
    if (index < 0) {
      return false;
    }
    windows.push([Math.max(0, index - 1), Math.min(paragraphs.length - 1, index + 1)]);
    return true;
  });
  const merged: [number, number][] = [];
  for (const w of windows.sort((a, b) => a[0] - b[0])) {
    const last = merged[merged.length - 1];
    if (!last || w[0] > last[1] + 1) {
      merged.push([w[0], w[1]]);
    } else {
      last[1] = Math.max(last[1], w[1]);
    }
  }
  return { passages: merged.map(([a, b]) => paragraphs.slice(a, b + 1).join('\n\n')), hits };
}
