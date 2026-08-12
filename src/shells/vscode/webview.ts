import * as vscode from 'vscode';
import { renderHtml } from './webviewHtml';

/**
 * 两个 webview 宿主（侧边栏与编辑器标签页）共用的接线：能加载哪些目录、
 * 以及把页面模板接到 `webview.asWebviewUri`。
 *
 * 这两件事从前在 chatViewProvider.ts 与 chatPanel.ts 里各写了一份，
 * `localResourceRoots` 少一条就是一片 404，不该有两个地方能写错。
 */

/** icon.svg 在 `media/`，脚本与样式在 `dist/media/`（构建产物）。 */
export function localResourceRoots(extensionUri: vscode.Uri): vscode.Uri[] {
  return [
    vscode.Uri.joinPath(extensionUri, 'media'),
    vscode.Uri.joinPath(extensionUri, 'dist', 'media'),
  ];
}

/** 建 webview 的标准 options（两个宿主再各自补 retainContextWhenHidden 之类）。 */
export function webviewOptions(extensionUri: vscode.Uri): vscode.WebviewOptions {
  return { enableScripts: true, localResourceRoots: localResourceRoots(extensionUri) };
}

/**
 * 渲染页面。F5 调试前必须跑过 `npm run compile`——`dist/media/` 是构建产物，
 * 缺了它这里出来的 URI 全部 404，页面一片白。
 */
export function htmlFor(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  return renderHtml({
    asset: (name) =>
      webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, 'dist', 'media', name)).toString(),
    cspSource: webview.cspSource,
  });
}
