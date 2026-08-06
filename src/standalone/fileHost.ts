import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { ConfigStore } from '../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../core/host';
import { NovelProject } from '../core/model/project';
import { Attachment } from '../core/model/session';
import { OutMessage } from '../core/protocol';
import { PromptHub } from './promptHub';

/**
 * 独立 Web 服务壳的 Host 实现。
 *
 * 交互（input/confirm/pick）经 WebSocket 变成网页弹窗（PromptHub）；
 * 进度降级为 toast；文件监听用 fs.watch（失败退化为轮询）；
 * 「打开文件」用系统默认程序——写作仍然在用户自己的编辑器里。
 */
export class FileHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;
  readonly prompts: PromptHub;

  constructor(
    public readonly config: ConfigStore,
    private readonly broadcastMsg: (msg: OutMessage) => void,
    /** 小说工程根目录；openFile 据此解析相对路径。 */
    private readonly root?: string
  ) {
    this.prompts = new PromptHub(broadcastMsg);
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
    // 优先 fs.watch（recursive）；不支持时退化为 1s 轮询。
    try {
      const watcher = fs.watch(project.root, { recursive: true }, (_event, filename) => {
        const name = String(filename ?? '');
        if (name.includes('node_modules') || name.includes('.trash')) {
          return;
        }
        // 目录事件没有扩展名——工程页上文件夹是可见节点，新建/删除空文件夹
        // 也得刷新。凡是不带扩展名的路径都放行。
        if (/\.[^./\\]+$/.test(name) && !/\.(md|json)$/i.test(name)) {
          return;
        }
        onChange();
      });
      return { dispose: () => watcher.close() };
    } catch {
      const timer = setInterval(() => {
        // 轮询兜底：目录可访问就触发一次刷新（pushState 内部会合并）。
        void fsp.stat(project.novelDir).then(onChange, () => undefined);
      }, 1000);
      return { dispose: () => clearInterval(timer) };
    }
  }

  async openFile(relPath: string): Promise<void> {
    // 用系统默认程序打开（用户自己的编辑器）。
    const abs = path.resolve(this.root ?? '.', relPath);
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    try {
      spawn(cmd, [abs], { detached: true, stdio: 'ignore' }).unref();
      this.toast(`已打开：${relPath}`);
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
