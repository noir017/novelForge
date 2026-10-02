/**
 * `written` 层：已写正文（拆书 A）。从作者已经写成的章里整理设定、大纲、细纲时，模型要看的那几章。
 *
 * **只在 `BuildRequest.derive` 时有内容**：架构、大纲、细纲三张配方都挂着这一层，平时什么都不带。
 * 「这些章已经写成、是权威事实」那句话在 builder 的小标题与契约里说。
 *
 * | 阶段 | 带什么 | 预算 |
 * |---|---|---|
 * | 架构 | 第 1–N 章的梗概（一章一行），加均匀抽样 {@link SAMPLE_COUNT} 章的开头节选 | 节选按配方（强制）；梗概放不下就隔章抽，写明抽了几章 |
 * | 大纲 | 区间里各章的摘要（梗概、关键事件、状态变更、新增伏笔）；没有摘要的章退回正文头尾 | 按配方 |
 * | 细纲 | 区间里各章正文的开头 {@link PLOT_HEAD} 字 + 结尾 {@link PLOT_TAIL} 字（章末钩子在结尾） | 按配方 |
 *
 * 上游（AI-Novel-Writer 的 `import-novel.command.ts`）推演设定只看首末两章各 3000 字、反推蓝图每章取
 * 开头 6000 字——长书的中段与每章的结尾都丢了。这里设定看全书梗概加均匀抽样，细纲看头尾。
 */
import { plotLabel } from '../../model/pipeline';
import { evenSample, headOf, headTail } from '../../model/importText';
import { Chapter } from '../../model/types';
import { estimateTokens } from '../tokenizer';
import type { LayerFn } from './assembly';

/** 架构那几件抽几章的开头。 */
export const SAMPLE_COUNT = 5;
/** 首章的节选长一点：开篇交代的东西最多。 */
export const SAMPLE_HEAD_FIRST = 3000;
export const SAMPLE_HEAD = 2000;
/** 细纲那一层每章带的开头与结尾。 */
export const PLOT_HEAD = 3500;
export const PLOT_TAIL = 1500;
/** 大纲那一层，没有摘要的章退回正文头尾的长度。 */
const OUTLINE_FALLBACK_HEAD = 1500;
const OUTLINE_FALLBACK_TAIL = 500;

export const written: LayerFn = async (a, spec) => {
  const derive = a.request.derive;
  if (!derive) {
    return;
  }
  const chapters = (await a.project.listChapters()).filter((c) => c.wordCount > 0 && c.order <= derive.through);
  if (chapters.length === 0) {
    return;
  }
  const stage = a.request.action.stage;
  if (stage === 'setting') {
    await settingMaterial(a, spec, chapters);
    return;
  }
  const range = a.request.range ?? (a.request.targetNo !== undefined ? { from: a.request.targetNo, to: a.request.targetNo } : undefined);
  const inRange = range ? chapters.filter((c) => c.order >= range.from && c.order <= range.to) : [];
  if (stage === 'outline') {
    for (const chapter of inRange) {
      await admitSummary(a, spec, chapter);
    }
  } else if (stage === 'plot') {
    for (const chapter of inRange) {
      const text = await a.project.readChapterText(chapter);
      a.admit(
        {
          id: `written:${chapter.order}`,
          kind: 'written',
          priority: spec.priority,
          label: `${plotLabel(chapter.order, chapter.title)} · 正文（头尾）`,
          source: chapter.relPath,
          text: `【${plotLabel(chapter.order, chapter.title)}｜全章 ${chapter.wordCount} 字】\n${headTail(text, PLOT_HEAD, PLOT_TAIL)}`,
          note: text.length > PLOT_HEAD + PLOT_TAIL ? `开头 ${PLOT_HEAD} 字 + 结尾 ${PLOT_TAIL} 字，中间省略` : '整章',
        },
        { force: spec.force }
      );
    }
  }
};

/** 架构那几件：全书梗概 + 抽样节选。 */
async function settingMaterial(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], chapters: Chapter[]): Promise<void> {
  // 节选先进（强制）：它们是「这本书读起来什么样」的唯一证据，梗概再长也替不了。
  for (const i of evenSample(chapters.length, SAMPLE_COUNT)) {
    const chapter = chapters[i];
    const text = await a.project.readChapterText(chapter);
    const head = i === 0 ? SAMPLE_HEAD_FIRST : SAMPLE_HEAD;
    a.admit(
      {
        id: `written:${chapter.order}`,
        kind: 'written',
        priority: spec.priority,
        label: `${plotLabel(chapter.order, chapter.title)} · 开头节选`,
        source: chapter.relPath,
        text: `【${plotLabel(chapter.order, chapter.title)} · 开头节选】\n${headOf(text, head)}`,
        note: `均匀抽样 ${SAMPLE_COUNT} 章之一，开头 ${head} 字`,
      },
      { force: spec.force }
    );
  }

  const lines: { no: number; line: string }[] = [];
  let missing = 0;
  for (const chapter of chapters) {
    const synopsis = (await a.project.readSummary(chapter.relPath))?.sections.梗概?.trim();
    if (synopsis) {
      lines.push({ no: chapter.order, line: `${plotLabel(chapter.order, chapter.title)}：${synopsis.replace(/\s+/g, ' ')}` });
    } else {
      missing++;
    }
  }
  if (lines.length === 0) {
    return;
  }
  const last = chapters[chapters.length - 1].order;
  const base = {
    id: 'written:synopsis',
    kind: 'written' as const,
    priority: spec.priority,
    label: `第 1–${last} 章梗概`,
  };
  const all = `【第 1–${last} 章梗概（一章一行）】\n${lines.map((l) => l.line).join('\n')}`;
  const missingNote = missing > 0 ? `；${missing} 章还没有摘要，没有梗概可带` : '';
  if (estimateTokens(all) <= a.remaining) {
    a.admit({ ...base, text: all, note: `${lines.length} 章${missingNote}` });
    return;
  }
  // 放不下就隔章抽：每 k 章留一章，首尾都在。宁可稀一点，也不要只剩前半本。
  for (let stride = 2; stride <= lines.length; stride++) {
    const kept = lines.filter((_, i) => i % stride === 0 || i === lines.length - 1);
    const text = `【第 1–${last} 章梗概（每 ${stride} 章取一章）】\n${kept.map((l) => l.line).join('\n')}`;
    const tokens = estimateTokens(text);
    if (tokens <= a.remaining) {
      a.accept({ ...base, text, status: 'degraded', note: `预算不足，${lines.length} 章里每 ${stride} 章取一章，带了 ${kept.length} 章${missingNote}` }, tokens);
      return;
    }
  }
  a.reject({ ...base, text: '' }, 'dropped', `预算不足，梗概一章都放不下${missingNote}`);
}

/** 大纲那一层的一章：摘要里管走向的那几节；还没有摘要就退回正文头尾。 */
async function admitSummary(a: Parameters<LayerFn>[0], spec: Parameters<LayerFn>[1], chapter: Chapter): Promise<void> {
  const label = plotLabel(chapter.order, chapter.title);
  const summary = await a.project.readSummary(chapter.relPath);
  const s = summary?.sections;
  const parts = s
    ? [
        ['梗概', s.梗概],
        ['关键事件', s.关键事件],
        ['状态变更', s.状态变更],
        ['新增伏笔', s.新增伏笔],
      ].filter(([, v]) => v?.trim())
    : [];
  if (parts.length > 0) {
    a.admit(
      {
        id: `written:${chapter.order}`,
        kind: 'written',
        priority: spec.priority,
        label: `${label} · 摘要`,
        source: summary!.relPath,
        text: `【${label}】\n${parts.map(([k, v]) => `${k}：${v!.trim()}`).join('\n')}`,
      },
      { force: spec.force }
    );
    return;
  }
  const text = await a.project.readChapterText(chapter);
  a.admit(
    {
      id: `written:${chapter.order}`,
      kind: 'written',
      priority: spec.priority,
      label: `${label} · 正文（头尾）`,
      source: chapter.relPath,
      text: `【${label}｜全章 ${chapter.wordCount} 字】\n${headTail(text, OUTLINE_FALLBACK_HEAD, OUTLINE_FALLBACK_TAIL)}`,
      note: '这一章还没有摘要，带正文的开头与结尾',
    },
    { force: spec.force }
  );
}
