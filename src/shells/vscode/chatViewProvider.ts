import * as vscode from 'vscode';
import { ChatController, ViewHost } from '../../core/controller';
import { InMessage, OutMessage } from '../../core/protocol';
import { htmlFor, webviewOptions } from './webview';

/**
 * 侧边栏宿主。视图在 package.json 里注册为 `novelForge.chat`，
 * 与树视图同处 Novel Forge 活动栏容器。
 *
 * 面板内部用 tabbar 切换 对话/历史/设置，参考 Roo 的做法——
 * 侧边栏本来就窄，多开几个 view 不如一个视图内切页。
 */
export class ChatViewProvider implements vscode.WebviewViewProvider, ViewHost {
  static readonly viewType = 'novelForge.chat';

  readonly kind = 'sidebar' as const;
  private view: vscode.WebviewView | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = webviewOptions(this.extensionUri);
    view.webview.html = htmlFor(view.webview, this.extensionUri);
    view.webview.onDidReceiveMessage((msg: InMessage) => void this.controller.handle(msg));

    this.controller.attach(this);
    view.onDidDispose(() => {
      this.controller.detach(this);
      this.view = undefined;
    });
  }

  post(message: OutMessage): void {
    void this.view?.webview.postMessage(message);
  }

  reveal(): void {
    if (this.view) {
      this.view.show?.(true);
    } else {
      // 视图还没被创建过（用户没点开过侧边栏），先让容器聚焦。
      void vscode.commands.executeCommand(`${ChatViewProvider.viewType}.focus`);
    }
  }
}
