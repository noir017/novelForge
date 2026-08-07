import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../core/config';
import {
  FileConflictError,
  FileEditError,
  isEditablePath,
  readFileForEditor,
  writeFileFromEditor,
} from '../core/fileEditing';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NON_CHAPTER_EXTENSIONS, isChapterFileName } from '../core/model/chapterFile';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { EditorPane, OutMessage } from '../core/protocol';
import { PromptHub } from './promptHub';

/**
 * 独立 Web 服务壳的 Host 实现。
 *
 * 交互（input/confirm/pick）经 WebSocket 变成网页弹窗（PromptHub）；
 * 进度降级为 toast；文件监听用 fs.watch（失败退化为轮询）；
 * 「打开文件」交给网页里的内置编辑器，非文本文件才回落到系统默认程序。
 */
export class FileHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;
  readonly prompts: PromptHub;
  /**
   * 用来回答「这份文件是不是某一章、它的草稿在哪」。
   * 只做纯路径推导，不缓存章节列表——那份缓存归 controller 持有的实例管。
   */
  private readonly project: NovelProject | undefined;

  constructor(
    public readonly config: ConfigStore,
    private readonly broadcastMsg: (msg: OutMessage) => void,
    /** 小说工程根目录；openFile 据此解析相对路径。 */
    private readonly root?: string
  ) {
    this.prompts = new PromptHub(broadcastMsg);
    this.project = root ? NovelProject.open(root) : undefined;
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    const value = await this.prompts.ask({
      kind: 'input',
      title: opts.title ?? '输入',
      message: opts.prompt,
      placeholder: opts.placeHolder,
      value: opts.value,
      password: opts.password,
      multiline: opts.multiline,
    });
    if (value === undefined) {
      return undefined;
    }
    if (opts.validate) {
      const err = opts.validate(value);
      if (err) {
        this.toast(err, 'error');
        return this.input(opts);
      }
    }
    return value;
  }

  async confirm(message: string, actions: string[], opts?: { detail?: string }): Promise<string | undefined> {
    // 网页弹窗只有 确定/取消；把第一个 action 当作「确定」的语义。
    const value = await this.prompts.ask({
      kind: 'confirm',
      title: actions[0] ?? '确认',
      message,
      value: opts?.detail,
    });
    return value === 'yes' ? (actions[0] ?? '确定') : undefined;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    const labels = choices.map((c) => (c.description ? `${c.label}（${c.description}）` : c.label));
    const picked = await this.prompts.ask({ kind: 'pick', title, options: labels });
    if (!picked) {
      return undefined;
    }
    const idx = labels.indexOf(picked);
    return idx >= 0 ? choices[idx].value : undefined;
  }

  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    this.toast(`开始：${title}`);
    const abort = new AbortController();
    try {
      return await fn(abort.signal, (m) => this.toast(`${title}：${m}`));
    } catch (err) {
      this.toast(err instanceof Error ? err.message : String(err), 'error');
      throw err;
    }
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    // 去抖：onChange 会触发 pushState，那是一次全量重扫（每章读盘算摘要新鲜度）。
    // 编辑器连续保存、Git 切分支这类操作会连着扔出十几个事件，逐个跑一遍没必要。
    let timer: ReturnType<typeof setTimeout> | undefined;
    const fire = (): void => {
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(onChange, 250);
    };

    // 优先 fs.watch（recursive）；不支持时退化为 1s 轮询。
    try {
      const watcher = fs.watch(project.root, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (name.includes('node_modules') || name.includes('.trash')) {
          return;
        }
        // 只跳过「改了也与工程无关」的二进制文件。章节可以是任意扩展名
        // （含无扩展名），目录事件也没有扩展名——两者都得放行。
        const ext = path.extname(name).toLowerCase();
        if (ext && NON_CHAPTER_EXTENSIONS.has(ext)) {
          return;
        }
        fire();
      });
      return {
        dispose: () => {
          if (timer) {
            clearTimeout(timer);
          }
          watcher.close();
        },
      };
    } catch {
      const timer2 = setInterval(() => {
        // 轮询兜底：目录可访问就触发一次刷新（pushState 内部会合并）。
        void fsp.stat(project.novelDir).then(onChange, () => undefined);
      }, 1000);
      return { dispose: () => clearInterval(timer2) };
    }
  }

  /**
   * 「打开文件」。文本文件进网页的内置编辑器，其余（图片等）交系统默认程序。
   *
   * 这里刻意让 openFile 也走编辑器：controller 里「采纳写入后打开」
   * 「点章节名」「点上下文条目」全都调它，改这一处，三处都对。
   */
  async openFile(relPath: string): Promise<void> {
    if (isEditablePath(relPath)) {
      await this.openInEditor(relPath);
      return;
    }
    await this.openExternal(relPath);
  }

  /** 读一份快照广播给前端，网页里开标签页。失败只报错，不抛给 controller。 */
  async openInEditor(relPath: string, pane?: EditorPane): Promise<void> {
    try {
      const file = await readFileForEditor(this.root ?? '.', relPath);
      this.broadcastMsg({
        type: 'editorOpen',
        file: { ...file, draftPath: this.draftPathOf(file.path) },
        pane,
      });
    } catch (err) {
      if (err instanceof FileEditError) {
        this.broadcastMsg({ type: 'editorError', path: relPath, message: err.message });
        return;
      }
      throw err;
    }
  }

  /** 「在旁边打开」= 开在第二块编辑区（草稿区）。 */
  async openBeside(relPath: string): Promise<void> {
    if (!isEditablePath(relPath)) {
      await this.openExternal(relPath);
      return;
    }
    await this.openInEditor(relPath, 'draft');
  }

  /**
   * 这份文件是章节正文时，给出它草稿的相对路径；否则 undefined。
   *
   * 「在章节根之下」由 draftRelPathFor 判定，「文件名像章节」由
   * isChapterFileName 判定——两半都复用现成的，不在这里写第三份规则。
   */
  private draftPathOf(rel: string): string | undefined {
    if (!this.project) {
      return undefined;
    }
    const draft = this.project.draftRelPathFor(rel);
    if (!draft || draft === rel) {
      return undefined;
    }
    return isChapterFileName(path.basename(rel)) ? draft : undefined;
  }

  /** 保存编辑器内容。冲突不覆盖，改为把磁盘版本回给前端让用户取舍。 */
  async saveFromEditor(relPath: string, text: string, baseHash?: string): Promise<void> {
    try {
      const file = await writeFileFromEditor(this.root ?? '.', relPath, text, baseHash);
      // draftPath 要一并带回：前端的保存分支只更新 text/hash，
      // 这里漏掉的话工具栏上的「草稿」按钮会在首次保存后消失。
      this.broadcastMsg({ type: 'editorSaved', file: { ...file, draftPath: this.draftPathOf(file.path) } });
    } catch (err) {
      if (err instanceof FileConflictError) {
        this.broadcastMsg({
          type: 'editorConflict',
          path: relPath,
          diskText: err.diskText,
          diskHash: err.diskHash,
        });
        return;
      }
      if (err instanceof FileEditError) {
        this.broadcastMsg({ type: 'editorError', path: relPath, message: err.message });
        return;
      }
      throw err;
    }
  }

  /** 用系统默认程序打开（用户自己的编辑器 / 图片查看器）。 */
  async openExternal(relPath: string): Promise<void> {
    const abs = path.resolve(this.root ?? '.', relPath);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [abs], { detached: true, stdio: 'ignore' }).unref();
      this.toast(`已用系统程序打开：${relPath}`);
    } catch {
      this.toast(`无法打开：${relPath}，请手动打开。`);
    }
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    this.broadcastMsg({ type: 'toast', message, level });
  }

  async selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    void project;
    // 独立版没有编辑器选区：弹粘贴框，存快照。
    const text = await this.input({
      title: '加入选区',
      prompt: '粘贴要引用的原文',
      multiline: true,
      placeHolder: '在编辑器里复制后粘贴到这里',
      validate: (v) => (v.trim() ? undefined : '不能为空'),
    });
    if (text === undefined) {
      return undefined;
    }
    return {
      id: `paste-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
      kind: 'selection',
      label: '粘贴的选区',
      text,
    };
  }

  async browseFile(project: NovelProject): Promise<string | undefined> {
    const rel = await this.input({
      title: '引用文件',
      prompt: '输入工程内的相对路径（如 chapters/003.md）',
      validate: (v) => {
        const abs = project.pathOf(v.trim());
        if (!fs.existsSync(abs)) {
          return '文件不存在';
        }
        return undefined;
      },
    });
    return rel?.trim();
  }

  async reviewReplace(name: string, currentText: string, proposedText: string): Promise<'apply' | 'discard' | undefined> {
    // 网页上无法开 diff：给出规模信息后纯确认。
    const ok = await this.confirm(
      `将更新角色卡「${name}」（新版 ${proposedText.length} 字，当前 ${currentText.length} 字）。`,
      ['应用更新'],
      { detail: '合并模型建议与现有内容；模型留空的小节保留原文。' }
    );
    return ok ? 'apply' : 'discard';
  }

  // standalone 没有 openNativeSettings：前端已隐藏按钮，此处不提供。
}
