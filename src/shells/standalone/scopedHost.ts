import { AsyncLocalStorage } from 'node:async_hooks';
import { ConfigStore } from '../../core/config';
import { Disposable, Host, InputOptions, PickChoice, ReviewVerdict } from '../../core/host';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';
import { EditorPane } from '../../core/protocol';
import { FileHost } from './fileHost';

/**
 * 一次调用是替哪个窗口做的：弹窗、toast、打开编辑器都该落到那几个网页上。
 * `owner` 是工程根，空窗口没有。
 */
export interface WindowScope {
  host: FileHost;
  owner?: string;
}

const scopes = new AsyncLocalStorage<WindowScope>();

/** 在这个窗口的上下文里跑 `fn`。它里面（含所有 await 之后）的 `getHost()` 都落到 `scope.host`。 */
export function runInScope<T>(scope: WindowScope, fn: () => T): T {
  return scopes.run(scope, fn);
}

export function currentScope(): WindowScope | undefined {
  return scopes.getStore();
}

/**
 * 独立版注册给 core 的那个全局 Host。
 *
 * core 里到处是 `getHost().toast(...)`、`getHost().confirm(...)`，而一个进程同时开着几个工程、
 * 几个窗口：这一层按调用所在的上下文（{@link runInScope}）转给那个窗口自己的 `FileHost`。
 * 不在任何上下文里（启动期）就落到 `fallback`，它广播给所有网页。
 */
export class ScopedHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;

  constructor(private readonly fallback: FileHost) {}

  get config(): ConfigStore {
    return this.fallback.config;
  }

  private get target(): FileHost {
    return currentScope()?.host ?? this.fallback;
  }

  input(opts: InputOptions): Promise<string | undefined> {
    return this.target.input(opts);
  }

  confirm(message: string, actions: string[], opts?: { modal?: boolean; detail?: string }): Promise<string | undefined> {
    return this.target.confirm(message, actions, opts);
  }

  pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    return this.target.pick(choices, title);
  }

  progress<T>(title: string, fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>): Promise<T> {
    return this.target.progress(title, fn);
  }

  watch(project: NovelProject, onChange: () => void): Disposable {
    return this.target.watch(project, onChange);
  }

  openFile(relPath: string): Promise<void> {
    return this.target.openFile(relPath);
  }

  toast(message: string, level?: 'info' | 'error'): void {
    this.target.toast(message, level);
  }

  selectionAttachment(project: NovelProject): Promise<Attachment | undefined> {
    return this.target.selectionAttachment(project);
  }

  browseFile(project: NovelProject): Promise<string | undefined> {
    return this.target.browseFile(project);
  }

  openInEditor(relPath: string, pane?: EditorPane): Promise<void> {
    return this.target.openInEditor(relPath, pane);
  }

  openBeside(relPath: string): Promise<void> {
    return this.target.openBeside(relPath);
  }

  saveFromEditor(relPath: string, text: string, baseHash?: string): Promise<void> {
    return this.target.saveFromEditor(relPath, text, baseHash);
  }

  openExternal(relPath: string): Promise<void> {
    return this.target.openExternal(relPath);
  }

  reviewReplace(
    name: string,
    currentText: string,
    proposedText: string,
    relPath?: string,
    opts?: { merge?: boolean }
  ): Promise<ReviewVerdict> {
    return this.target.reviewReplace(name, currentText, proposedText, relPath, opts);
  }

  mergeTexts(title: string, before: string, after: string): Promise<ReviewVerdict> {
    return this.target.mergeTexts(title, before, after);
  }

  revealText(relPath: string, quote: string): Promise<boolean> {
    return this.target.revealText(relPath, quote);
  }
}
