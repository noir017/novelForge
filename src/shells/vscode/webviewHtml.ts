import { makeNonce } from '../../core/protocol';
import {
  chatPane,
  historyPane,
  logsPane,
  projectPane,
  providerModal,
  settingsPane,
  tabbar,
  toastSlot,
} from '../shared/panes';

/**
 * 两个 webview 宿主共用的 HTML。只加载本地资源，CSP 里不开任何外部来源。
 * bridge.js 在 view.js 之前加载：webview 里它检测到 acquireVsCodeApi 存在就直通。
 *
 * pane 的 DOM 全部来自 [../shared/panes.ts](../shared/panes.ts)——这里只剩
 * head / CSP / 标签栏与装配顺序。**这个函数不碰 vscode API**：`asset` 与
 * `cspSource` 由调用方（[webview.ts](webview.ts)）给，于是页面模板可以被
 * jsdom 直接执行（tests/helpers/dom.js 就是这么拿真实页面的）。
 *
 * body 上的 `data-vscode-context` 关掉 VS Code 给 webview 右键菜单加的
 * 复制/粘贴项：右键全部由 view.js 自己接管（见 media/README.md），
 * 不关掉的话点一下会同时冒出两层菜单——JS 的 preventDefault 压不住那一层。
 */
export interface WebviewHtmlOptions {
  /** 把 `dist/media/` 下的产物名换成 webview 能加载的 URI。 */
  asset: (name: string) => string;
  /** `webview.cspSource`。 */
  cspSource: string;
}

export function renderHtml(opts: WebviewHtmlOptions): string {
  const nonce = makeNonce();
  const { asset, cspSource } = opts;

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${cspSource}; script-src 'nonce-${nonce}'; font-src ${cspSource}; img-src ${cspSource};">
<link href="${asset('view.css')}" rel="stylesheet">
<title>Novel Forge</title>
</head>
<body data-vscode-context='{"preventDefaultContextMenuItems": true}'>
${tabbar([
  { tab: 'chat', label: '对话' },
  { tab: 'project', label: '工程' },
  { tab: 'history', label: '历史' },
  { tab: 'logs', label: '日志' },
  { tab: 'settings', label: '设置' },
])}

${chatPane({ selectionFromEditor: true })}

${projectPane()}

${historyPane()}

${logsPane()}

${settingsPane({ nativeSettings: true })}

${providerModal()}

${toastSlot()}
<script nonce="${nonce}" src="${asset('bridge.js')}"></script>
<script nonce="${nonce}" src="${asset('view.js')}"></script>
</body>
</html>`;
}
