/**
 * 工作区卡的内容：**当前这一层的产物本身**。
 *
 * 与 [pipeline.ts](pipeline.ts) 同级同类——那边聚合「这一章走到哪一步了」，
 * 这边取出「我现在正在改的那份东西写了什么」。取数在这里，判断在纯函数层。
 *
 * ## 为什么需要它
 *
 * 改造前的创作页只有两样东西：一条四段进度条，和对话气泡。作者看不见自己
 * 正在改的剧情写了什么、这一场备了哪些素材——那些都在磁盘上，
 * 要看只能去开文件。于是流水线在界面上只剩下几个百分比，像个进度报表，
 * 而不是一个工作台。
 *
 * ## 正文层为什么不摊全文
 *
 * `manuscript` 只给统计（字数、写了几场、场景变没变过）。上万字塞进界面上
 * 那只浮窗，既读不下去，又把「这一层齐没齐」这个真正要看的信息埋掉了；
 * 真要读，「打开」按钮就在旁边。大纲同理只给预览——它可能有几千字。
 *
 * ## 卷借用 `outline` 这一档
 *
 * 卷不是独立的创作阶段（见 model/pipeline.ts 的文件头），所以卡片的 `stage`
 * 报 `outline`——界面上那条流水线条只有四层，凭空多一格会让四段进度错位。
 * 标题里写清是哪一卷，读的人不会混。
 */
import { scoped } from '../runtime/logger';
import { basename } from 'node:path';
import { hash } from '../model/fs';
import { NovelProject } from '../model/project';
import { PLOT_SECTION_KEYS, parsePlotFileName } from '../model/plotFile';
import { CreationTarget, STAGE_LABEL, plotLabel, stageOfTarget, volumeLabel } from '../model/pipeline';
import { VOLUME_SECTION_KEYS } from '../model/volumeFile';
import { SCENE_SECTION_KEYS } from '../model/sceneFile';
import { plotContentHash } from './pipeline';
import { WorkbenchSection, WorkbenchView } from '../protocol';

const log = scoped('工作区');

/** 大纲预览最多摊这么多字。再多就该去开文件了。 */
const OUTLINE_PREVIEW = 400;

/**
 * 当前目标那一层的产物。
 *
 * **绝不抛**：作者可能刚把某一章改名或删掉，而界面上的 target 还指着它。
 * 那种时候给一张「找不到」的卡，比让整条推送失败强。
 */
export async function buildWorkbench(
  project: NovelProject,
  target: CreationTarget
): Promise<WorkbenchView> {
  try {
    return await build(project, target);
  } catch (err) {
    log.warn('工作区卡取数失败', String(err));
    const stage = stageOfTarget(target);
    return { stage, title: STAGE_LABEL[stage], relPath: '', sections: [] };
  }
}

async function build(project: NovelProject, target: CreationTarget): Promise<WorkbenchView> {
  if (target.kind === 'outline') {
    const text = await project.readOutline();
    return {
      stage: 'outline',
      title: '全书大纲',
      relPath: project.relPath(project.outlinePath),
      sections: text.trim() ? [{ key: '大纲', text: clip(text, OUTLINE_PREVIEW) }] : [],
      empty: text.trim() ? undefined : '这部书还没有大纲。先定下故事讲什么，后面几层都从它展开。',
    };
  }

  if (target.kind === 'volume') {
    const volume = await project.readVolume(target.volumeRelPath);
    if (!volume) {
      return {
        stage: 'outline',
        title: '卷纲',
        relPath: '',
        sections: [],
        empty: `找不到卷纲 ${target.volumeRelPath}，它可能刚被改名或删除。`,
      };
    }
    const sections = sectionsOf(volume.sections, VOLUME_SECTION_KEYS);
    const segments = await project.listPlotsOfVolume(volume.relPath);
    return {
      stage: 'outline',
      title: `卷纲 · ${volumeLabel(volume.no, volume.title)}`,
      relPath: volume.relPath,
      sections: [
        ...sections,
        { key: '已拆出', text: segments.length > 0 ? `${segments.length} 个剧情段` : '还没拆出剧情段' },
      ],
      // 与细纲那一侧同一条判据：记录过上游指纹、且现在对不上，才算脏。
      warning:
        volume.upstreamHash && hash(await project.readOutline()) !== volume.upstreamHash
          ? '全书大纲在这一卷之后改过，两者可能已经对不上。'
          : undefined,
      empty: sections.length > 0 ? undefined : '这一卷还没排走向。先把这一卷讲什么写出来，剧情段从它拆。',
    };
  }

  const plot = await project.readPlot(target.plotRelPath);
  if (!plot) {
    // 细纲不在有两种情况，说法必须分开：
    //
    // - **成品在**（老工程的章、拆分出来的章）：这一章好好地躺在 `chapters/` 里，
    //   只是从没经过流水线。说它「可能刚被改名或删除」是撒谎，作者会去找一个
    //   根本没丢的东西。它真正的状态是「还没排剧情」。
    // - **两边都没有**：那才是刚被改名或删掉。
    const no = parsePlotFileName(basename(target.plotRelPath))?.no ?? 0;
    const chapter = no > 0 ? (await project.listChapters()).find((c) => c.order === no) : undefined;
    const stage = stageOfTarget(target);
    return {
      stage,
      title: chapter ? `${STAGE_LABEL[stage]} · ${plotLabel(chapter.order, chapter.title)}` : STAGE_LABEL[stage],
      relPath: chapter?.relPath ?? '',
      sections: [],
      empty: chapter
        ? '这一章已经有正文了，但没有经过流水线——还没排剧情。'
        : `找不到细纲 ${target.plotRelPath}，它可能刚被改名或删除。`,
    };
  }
  const head = plotLabel(plot.no, plot.title);

  switch (target.kind) {
    case 'plot': {
      const sections = sectionsOf(plot.sections, PLOT_SECTION_KEYS);
      return {
        stage: 'plot',
        title: `剧情 · ${head}`,
        relPath: plot.relPath,
        sections,
        // 上游变更在这里是一句人话，不只是流水线条上那个 ⟳。作者正在看这一章，
        // 此刻正是告诉他「它依据的大纲已经改了」最有用的时机。
        warning:
          plot.upstreamHash && hash(await project.readOutline()) !== plot.upstreamHash
            ? '全书大纲在这一章之后改过，两者可能已经对不上。'
            : undefined,
        // 「文件在但一节都没填」与「文件不在」对作者是同一件事：这一层还没做。
        // 只判文件存在的话，一份只有目标的骨架会渲染成一张几乎空的卡。
        empty: sections.length > 0 ? undefined : '这一章还没排剧情。',
      };
    }

    case 'scene': {
      const scene = await project.readScene(plot.relPath, target.sceneNo);
      if (!scene) {
        return {
          stage: 'scene',
          title: `场景 ${target.sceneNo} · ${head}`,
          relPath: '',
          sections: [],
          empty: `第 ${target.sceneNo} 场还不存在。先把这一章拆成场景。`,
        };
      }
      const meta = [scene.place, scene.time, scene.characters.join('、')].filter(Boolean).join(' · ');
      // 与 pipeline.ts 同一条判据：记录过上游指纹、且现在对不上，才算脏。
      // 没记录过（作者手写的场景）不标脏——凭空的过期标记比不标更糟。
      const stale = !!scene.upstreamHash && plotContentHash(plot) !== scene.upstreamHash;

      const designed = sectionsOf(scene.sections, SCENE_SECTION_KEYS);
      return {
        stage: 'scene',
        title: `场景 ${scene.no}${scene.title ? ` ${scene.title}` : ''} · ${head}`,
        relPath: scene.relPath,
        sections: [...(meta ? [{ key: '这一幕', text: meta }] : []), ...designed],
        // 刚拆出来的场景只有 frontmatter 里那点元信息，小节全是占位符。
        // 这时的 warning 说清它还没准备过素材——**不用 `empty`**：那会连
        // 「这一幕」一起藏掉，而地点时间人物恰恰是这时候唯一有的东西。
        warning: stale
          ? '本章细纲在这一场之后改过，这里的素材可能已经用不上了。'
          : designed.length === 0
            ? '这一场还只是个壳，没有素材——写正文之前先把环境、动作、对话想出来。'
            : undefined,
      };
    }

    case 'manuscript': {
      const scenes = await project.listScenes(plot.relPath);
      const written = scenes.filter((s) => s.status === 'written').length;
      const manuscript = await project.readManuscript(plot.relPath);
      const beatsHash = await project.beatsHashFor(plot.relPath);
      const beatsStale = !!manuscript?.beatsHash && !!beatsHash && manuscript.beatsHash !== beatsHash;
      const words = manuscript?.wordCount ?? 0;

      return {
        stage: 'manuscript',
        title: `正文 · ${head}`,
        relPath: manuscript?.relPath ?? project.manuscriptMirrorRelPath(plot.relPath),
        // 不摊正文，只给「够不够写、写到哪了」——那才是这一层要盯的。
        sections: [
          { key: '篇幅', text: words > 0 ? `${words} 字` : '还没有正文' },
          ...(scenes.length > 0
            ? [{ key: '场景', text: `${written}/${scenes.length} 场已写入` }]
            : [{ key: '场景', text: '这一章没有拆过场景，正文将整章生成' }]),
        ],
        warning: beatsStale ? '场景在正文写完之后改过，现有正文可能已经与细节对不上。' : undefined,
      };
    }
  }
}

/** 非空小节 → 卡片条目。空小节与占位文字都不显示：卡片是给人看的，不是表单。 */
function sectionsOf(
  sections: Record<string, string>,
  keys: readonly string[]
): WorkbenchSection[] {
  const out: WorkbenchSection[] = [];
  for (const key of keys) {
    const text = (sections[key] ?? '').trim();
    if (text && text !== '（待补充）' && text !== '(待补充)') {
      out.push({ key, text });
    }
  }
  return out;
}

function clip(text: string, max: number): string {
  const t = text.trim();
  return t.length <= max ? t : `${t.slice(0, max)}…`;
}
