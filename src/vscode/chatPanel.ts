import * as vscode from 'vscode';
import { ChatController, ViewHost } from '../core/controller';
import { InMessage, OutMessage } from '../core/protocol';
import { renderHtml } from './webviewHtml';

/**
 * 编辑器宿主：把同一个对话面板作为标签页在编辑器区打开。
 *
 * 侧边栏太窄时用这个——两边挂的是同一个 controller，看到的是同一个会话。
 */
export class ChatPanel implements ViewHost {
  private static instance: ChatPanel | undefined;

  readonly kind = 'editor' as const;

  static show(extensionUri: vscode.Uri, controller: ChatController): void {
    if (ChatPanel.instance) {
      ChatPanel.instance.panel.reveal(vscode.ViewColumn.Beside);
      return;
    }
    const panel = vscode.window.createWebviewPanel(
      'novelForge.chatPanel',
      'Novel Forge',
      vscode.ViewColumn.Beside,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(extensionUri, 'media')],
      }
    );
    ChatPanel.instance = new ChatPanel(panel, extensionUri, controller);
  }

  static disposeInstance(): void {
    ChatPanel.instance?.panel.dispose();
  }

  private constructor(
    private readonly panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    private readonly controller: ChatController
  ) {
    panel.iconPath = vscode.Uri.joinPath(extensionUri, 'media', 'icon.svg');
    panel.webview.html = renderHtml(panel.webview, extensionUri);
    panel.webview.onDidReceiveMessage((msg: InMessage) => void this.controller.handle(msg));

    this.controller.attach(this);
    panel.onDidDispose(() => {
      this.controller.detach(this);
      ChatPanel.instance = undefined;
    });
  }

  post(message: OutMessage): void {
    void this.panel.webview.postMessage(message);
  }

  reveal(): void {
    this.panel.reveal(vscode.ViewColumn.Beside);
  }
}
