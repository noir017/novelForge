/**
 * 创作编排：装配上下文 → 流式生成 → 解析产物 → 由用户点了采纳才落盘。
 *
 * 这是 `continueWriting.ts` 的替代者。那边的世界只有一件事——「把纲要写成
 * 正文，追加到某一章」；这里的世界有四层产物，每一层都可能被生成、被改写、
 * 被拆成下一层。
 *
 * ## 三条不变的约定
 *
 * 1. **生成与落盘分开**。`generate` 只把文本交给调用方，一个字都不写磁盘；
 *    `acceptArtifact` 才写，且只在用户点了采纳之后。中间那一步是用户看着
 *    产物决定要不要的机会——少了它，「不静默覆盖」无从谈起。
 * 2. **覆盖已有产物前必须审阅**。改写一份写了三天的剧情和写一份新的，
 *    在界面上是同一个按钮，差别只有磁盘上有没有东西。所以 `acceptArtifact`
 *    在目标已存在且内容不同时走 `reviewReplace`（插件开 diff，独立版弹确认），
 *    与角色卡更新同一套。
 * 3. **失败留在出错的东西身上**。生成失败往 `errorLog` 记一条挂在目标
 *    细纲上，成功时清掉。只有一条 toast 的话，用户扭头就看不见了。
 */
import { BuildRequest, BuiltContext } from '../context/builder';
import { CancelledError } from '../llm/provider';
import { buildProvider } from '../llm/registry';
import { readConfig } from '../config';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { hash, sanitizeFileName } from '../model/fs';
import { NovelProject } from '../model/project';
import { Plot, PlotSections, emptyPlotSections } from '../model/plotFile';
import { emptySceneSections } from '../model/sceneFile';
import type { PlotOutlineItem, SceneOutlineItem } from './artifact';
import {
  CreationAction,
  CreationTarget,
  plotOfTarget,
} from '../model/pipeline';
import {
  describeModelIssue,
  ProviderProfile,
  providerLabel,
  resolveModelRef,
  withDraftProvider,
} from '../model/providers';
import { Artifact, describeArtifact, isArtifactEmpty } from './artifact';
import {
  GenerateHandlers,
  generate as generateDraft,
  parseDraftArtifact,
  previewContext,
} from '../generation/generate';
import { plotContentHash } from '../views/pipeline';
import { Workspace, pathOfTarget } from '../workspace';

const log = scoped('创作');

export type { GenerateHandlers };

/** 采纳的结果。`relPath` 是落盘位置，`skipped` 表示用户在审阅时放弃了。 */
export interface AcceptResult {
  relPath?: string;
  skipped?: boolean;
  /** 一句人话，直接进 toast。 */
  message: string;
}

export class CreationSession {
  private currentAbort: AbortController | undefined;
  /** 落盘一律经网关：守卫、渲染、记账、伴生搬迁都在那一层做一次。 */
  private readonly ws: Workspace;

  constructor(private readonly project: NovelProject) {
    this.ws = new Workspace(project);
  }

  get isGenerating(): boolean {
    return this.currentAbort !== undefined;
  }

  /** 只装配上下文，不调用模型——用于面板里的「预览上下文」。 */
  async preview(request: Omit<BuildRequest, 'providerMaxInputTokens'>): Promise<BuiltContext> {
    return previewContext(this.project, request);
  }

  async generate(
    request: Omit<BuildRequest, 'providerMaxInputTokens'>,
    handlers: GenerateHandlers
  ): Promise<BuiltContext | undefined> {
    if (this.currentAbort) {
      log.warn('已有一个生成任务在进行中，本次请求被拒');
      handlers.onError('已有一个生成任务在进行中。');
      return undefined;
    }
    const abort = new AbortController();
    this.currentAbort = abort;
    try {
      const { built } = await generateDraft(this.project, request, handlers, { signal: abort.signal });
      return built;
    } finally {
      this.currentAbort = undefined;
    }
  }

  stop(): void {
    if (this.currentAbort) {
      log.info('用户点了停止');
    }
    this.currentAbort?.abort(new CancelledError());
  }

  dispose(): void {
    this.currentAbort?.abort(new CancelledError());
  }

  // ---------------------------------------------------------------- 采纳

  /**
   * 把一次生成的结果解析成产物。不写盘。
   *
   * 与 `acceptArtifact` 分成两步，是为了让前端能先摊开给用户看：
   * 「拆出了 4 场，第 3 场的标题我改一下再采纳」。
   */
  parse(action: CreationAction, raw: string): Artifact | undefined {
    return parseDraftArtifact(action, raw);
  }

  /**
   * 采纳产物，写进磁盘。按 target 分派到六条落盘路径。
   *
   * **每一条覆盖已有内容的路径都先走 confirmOverwrite。** 唯一的例外是
   * 正文追加（append）——那本来就是往后加，不覆盖任何东西。
   */
  async acceptArtifact(target: CreationTarget, artifact: Artifact): Promise<AcceptResult> {
    switch (artifact.kind) {
      case 'outlineDoc':
        return this.acceptOutline(artifact.text);
      case 'plotList':
        return this.acceptPlotList(artifact.plots);
      case 'plot':
        return this.acceptPlot(target, artifact.sections);
      case 'sceneList':
        return this.acceptSceneList(target, artifact.scenes);
      case 'scene':
        return this.acceptScene(target, artifact);
      case 'manuscript':
        return this.acceptManuscript(target, artifact.text);
    }
  }

  /** 全书大纲：整篇替换，覆盖前审阅。 */
  private async acceptOutline(text: string): Promise<AcceptResult> {
    const rel = this.project.relPath(this.project.outlinePath);
    const r = await this.ws.write(
      rel,
      { artifact: { kind: 'outlineDoc', text } },
      { mode: 'overwrite', what: '全书大纲' }
    );
    if (r.skipped) {
      return { skipped: true, message: '没有改动大纲。' };
    }
    log.info('全书大纲已更新', `${rel}｜${text.length} 字`);
    return { relPath: rel, message: `已写入 ${rel}` };
  }

  /**
   * 大纲拆章：为每一章建一份只有「目标」的细纲文件。
   *
   * **不建章节文件**。从前这里会顺手为每一章建一个 0 字的正文文件，因为那时
   * 细纲/场景/摘要三套镜像路径全挂在章节的 relPath 上，没有章节文件产物就
   * 无处安放。现在伴生路径挂在细纲自己身上，`chapters/` 是作者拆好正文之后
   * 才会有东西的发布区——拆个章就往那里塞几十个空文件，只会让他以为工具替他
   * 分好了章。
   *
   * **已存在的章号一律跳过，绝不覆盖。**
   */
  private async acceptPlotList(plots: PlotOutlineItem[]): Promise<AcceptResult> {
    const outlineHash = await this.outlineHash();
    let next = await this.project.nextPlotNo();
    const taken = new Set((await this.project.listPlots()).map((p) => p.no));
    const created: string[] = [];
    const skipped: number[] = [];

    for (const item of plots) {
      const no = item.no && item.no > 0 ? item.no : next;
      if (taken.has(no)) {
        skipped.push(no);
        next = Math.max(next, no + 1);
        continue;
      }
      taken.add(no);
      const rel = await this.ws.writePlot({
        no,
        // 标题原样存进 frontmatter，**不预先清洗**：清洗是为了拼文件名，
        // 由 `writePlot` 自己做。在这里洗一遍的话，标题里的空格会变成短横线，
        // 而空标题会变成「未命名」四个字——那是个假标题，还会进上下文。
        title: item.title,
        arc: item.arc,
        upstreamHash: outlineHash,
        done: false,
        // 只填「目标」：这一步产出的是骨架，剧情脉络要另外一次调用才排得出。
        // 「目标」不算 filled（isPlotFilled 只看剧情脉络），所以流水线会如实
        // 停在「待写剧情」，不会因为骨架存在就显示已规划。
        sections: { ...emptyPlotSections(), 目标: item.goal },
      });
      created.push(rel);
      next = Math.max(next, no + 1);
    }

    await this.project.syncManifest();
    // 跳过的必须说出来。默默少建三章，作者要到写到那里才发现。
    const note = skipped.length > 0 ? `，跳过已存在的第 ${skipped.join('、')} 章` : '';
    log.info(`已建 ${created.length} 章的细纲`, `${created.join('、') || '（无）'}${note}`);
    return {
      relPath: created[0],
      message: `已新建 ${created.length} 章${note}。`,
    };
  }

  /**
   * 一章的细纲：整份替换，覆盖前审阅。
   *
   * 渲染与记 `upstreamHash` 都在网关的 plot handler 里——四个小节换新，
   * 标题/幕/目标字数/done 沿用磁盘那份（「重写剧情」不该抹掉作者起的标题）。
   */
  private async acceptPlot(target: CreationTarget, sections: PlotSections): Promise<AcceptResult> {
    const plot = await this.requirePlot(target);
    const r = await this.ws.write(
      plot.relPath,
      { artifact: { kind: 'plot', sections } },
      { mode: 'overwrite', what: `第 ${plot.no} 章的细纲` }
    );
    if (r.skipped) {
      return { skipped: true, message: '没有改动这一章。' };
    }
    log.info(`第 ${plot.no} 章的细纲已写入`, plot.relPath);
    return { relPath: plot.relPath, message: `已写入 ${plot.relPath}` };
  }

  /**
   * 剧情拆场景：为每一场建一个场景文件。
   *
   * 与拆章一样**不覆盖**：已经存在的场号跳过。作者花时间设计过的场景
   * 被一次重新拆分抹掉，是这条路上最贵的错误。
   */
  private async acceptSceneList(
    target: CreationTarget,
    scenes: SceneOutlineItem[]
  ): Promise<AcceptResult> {
    const plot = await this.requirePlot(target);
    const upstreamHash = plotContentHash(plot);
    const existing = await this.project.listScenes(plot.relPath);
    const taken = new Set(existing.map((s) => s.no));

    let no = 0;
    const created: string[] = [];
    for (const item of scenes) {
      do {
        no++;
      } while (taken.has(no));
      taken.add(no);
      const rel = await this.ws.writeScene(plot.relPath, {
        plotRelPath: plot.relPath,
        no,
        title: item.title,
        place: item.place,
        time: item.time,
        characters: item.characters,
        targetWords: item.targetWords,
        upstreamHash,
        // 刚拆出来的是壳，还没设计过——status 如实说 draft。
        status: 'draft',
        sections: {
          ...emptySceneSections(),
          目的: item.goal,
        },
      });
      created.push(rel);
    }

    const note = existing.length > 0 ? `，原有 ${existing.length} 场未动` : '';
    log.info(`第 ${plot.no} 章拆出 ${created.length} 场`, `${created.join('、')}${note}`);
    return { relPath: created[0], message: `已拆出 ${created.length} 场${note}。` };
  }

  /**
   * 单张场景卡：整张替换，覆盖前审阅。
   *
   * 落点、渲染与记 `upstreamHash` 都在网关的 scene handler 里：标题沿用磁盘
   * 那份（标题决定文件名，改写一张卡不该顺手改文件名），status 由
   * `isSceneReady` 推，改了标题时清掉旧文件名。
   */
  private async acceptScene(
    target: CreationTarget,
    artifact: Extract<Artifact, { kind: 'scene' }>
  ): Promise<AcceptResult> {
    const plot = await this.requirePlot(target);
    const sceneNo = target.kind === 'scene' ? target.sceneNo : undefined;
    if (sceneNo === undefined) {
      throw new Error('没有指定是哪一场。');
    }

    const r = await this.ws.write(
      pathOfTarget(this.project, { kind: 'scene', plotRelPath: plot.relPath, sceneNo }),
      { artifact },
      { mode: 'overwrite', what: `第 ${plot.no} 章 · 场景 ${sceneNo}` }
    );
    if (r.skipped) {
      return { skipped: true, message: '没有改动这一场。' };
    }
    log.info(`第 ${plot.no} 章场景 ${sceneNo} 已写入`, r.rel);
    return { relPath: r.rel, message: `已写入 ${r.rel}` };
  }

  /**
   * 正文：追加到这一章的中转站正文末尾。
   *
   * `beatsHash` 由网关的 manuscript handler 记——正文所依据的场景指纹。
   * 少了它这一章会永远显示「正文与场景对不上」或永远不显示，两种都是错的。
   *
   * **落在 `manuscripts/`，不是 `chapters/`。** 切成发布章节是作者的活，
   * 工具不代劳（见 model/plotFile.ts 的文件头）。
   *
   * 追加是唯一不走覆盖审阅的落盘路径——它不覆盖任何东西。
   */
  private async acceptManuscript(target: CreationTarget, text: string): Promise<AcceptResult> {
    const plot = await this.requirePlot(target);
    const r = await this.ws.write(
      pathOfTarget(this.project, { kind: 'manuscript', plotRelPath: plot.relPath }),
      { artifact: { kind: 'manuscript', text } },
      { mode: 'append' }
    );

    // 写的是某一场时，把那一场标成 written，流水线进度才走得动。
    const sceneNo = target.kind === 'manuscript' ? target.sceneNo : undefined;
    if (sceneNo !== undefined) {
      const scene = await this.project.readScene(plot.relPath, sceneNo);
      if (scene && scene.status !== 'written') {
        await this.ws.writeScene(plot.relPath, { ...scene, status: 'written' });
      }
    }
    await this.project.syncManifest();

    log.info(
      `已追加 ${text.length} 字到第 ${plot.no} 章`,
      `${r.rel}｜该章摘要将变为过期${sceneNo !== undefined ? `｜场景 ${sceneNo} 已标记写完` : ''}`
    );
    return { relPath: r.rel, message: `已写入 ${r.rel}` };
  }

  // ---------------------------------------------------------------- 测试连接

  /**
   * 发一个最小请求验证配置能不能用。
   * 设置页的「测试连接」——比让用户先写半章再发现 Key 填错好得多。
   *
   * @param ref 要测的模型引用；留空则测当前选中的。
   * @param draft 设置页屏幕上那份尚未保存的服务商配置。给了就以它为准——
   *   「新加的模型必须先保存才能测」对用户毫无道理，而且保存一份没验过的
   *   配置正是测试想要避免的事。
   */
  async testConnection(ref?: string, draft?: ProviderProfile): Promise<{ ok: boolean; message: string }> {
    const config = readConfig();
    // 草稿只补充、不替换：其余服务商仍用已保存的，这样 ref 指向别家时照样能解析。
    const providers = withDraftProvider(config.providers, draft);
    const active = ref ? resolveModelRef(providers, ref) : config.active;
    if (!active) {
      return { ok: false, message: describeModelIssue(providers, ref ?? config.model) };
    }
    const provider = await buildProvider(active);
    if (!provider) {
      return {
        ok: false,
        message: `未配置「${providerLabel(active.profile)}」的 API Key，已取消测试。`,
      };
    }
    log.info(`测试连接 ${active.ref}`, provider.label);
    const startedAt = Date.now();
    const abort = new AbortController();
    try {
      let reply = '';
      for await (const ev of provider.stream(
        [{ role: 'user', content: '回复两个字：收到' }],
        { maxOutputTokens: 16, temperature: 0, timeoutMs: 30000, signal: abort.signal }
      )) {
        if (ev.type !== 'text') {
          continue;
        }
        reply += ev.text;
        // 拿到任何内容就算通了，不必等它说完。
        if (reply.trim().length >= 2) {
          break;
        }
      }
      if (reply.trim()) {
        log.info(`${active.ref} 连接正常`, `回复「${reply.trim().slice(0, 20)}」，用时 ${elapsed(startedAt)}`);
        return { ok: true, message: `${active.ref} 连接正常：${provider.label} 回复「${reply.trim().slice(0, 20)}」` };
      }
      log.warn(`${active.ref} 连接成功但没有返回内容`, `用时 ${elapsed(startedAt)}，检查模型名是否正确`);
      return { ok: false, message: `${active.ref} 连接成功但没有返回内容，检查模型名是否正确。` };
    } catch (err) {
      log.error(`${active.ref} 连接失败：${describeError(err)}`, err);
      return { ok: false, message: `${active.ref}：${describeError(err)}` };
    }
  }

  // ---------------------------------------------------------------- 内部

  /** target 指向的细纲。找不到就抛——采纳路径上，写到一个不存在的地方比报错更糟。 */
  private async requirePlot(target: CreationTarget): Promise<Plot> {
    const relPath = plotOfTarget(target);
    if (!relPath) {
      throw new Error('这个产物不属于任何章。');
    }
    const plot = await this.project.readPlot(relPath);
    if (!plot) {
      throw new Error(`找不到细纲 ${relPath}，可能刚被改名或删除。`);
    }
    return plot;
  }

  private async outlineHash(): Promise<string> {
    return hash(await this.project.readOutline());
  }
}

// ---------------------------------------------------------------- 输出清理

/**
 * 清理模型输出里常见的赘余：包裹的代码块、开场白、被要求不写却仍写出的标题。
 * 只做保守清理，不改动正文本身。
 */
export function cleanOutput(text: string): string {
  let out = text.trim();

  const fence = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }

  // 开头的「好的，以下是……」之类
  out = out.replace(/^(好的|没问题|明白了)[^\n]{0,40}[:：]\s*\r?\n+/, '');
  out = out.replace(/^(以下是|下面是)[^\n]{0,40}[:：]?\s*\r?\n+/, '');

  // 开头的章节标题行（我们在 prompt 里禁止了，但模型常忍不住）
  out = out.replace(/^#{1,6}\s*第?\s*[\d一二三四五六七八九十百]+\s*章[^\n]*\r?\n+/, '');
  out = out.replace(/^第\s*[\d一二三四五六七八九十百]+\s*章[ 　]*[^\n]{0,20}\r?\n+/, '');

  // 结尾的字数统计/创作说明
  out = out.replace(/\r?\n+[（(]?\s*(本章|全文|以上)?\s*(约|共)?\s*\d+\s*字\s*[)）]?\s*$/, '');
  out = out.replace(/\r?\n+[-—]{3,}[\s\S]*$/, (m) => (m.length < 200 ? '' : m));

  return out.trim();
}

/** 给新章节起个默认标题：优先用纲要首句。 */
export function suggestTitle(outline: string, order: number): string {
  const firstLine = outline
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
    .find((s) => s.length > 0);
  if (!firstLine) {
    return `第${order}章`;
  }
  const clipped = firstLine.split(/[。！？；,，.!?;]/)[0].trim().slice(0, 18);
  return sanitizeFileName(clipped) || `第${order}章`;
}

export { describeArtifact, isArtifactEmpty };
export type { Artifact };
