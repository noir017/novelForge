/**
 * `vscode` 模块桩。
 *
 * `src/core/` 是零 vscode 依赖的（见 tests/contract/corePurity.test.js），所以绝大多数
 * 测试用 `external: ['vscode']` 就够了。少数还没脱钩的路径（`project.ts` 的 readConfig、
 * `src/vscode/migrate.ts`、上下文装配走的 workspace.fs）需要这份桩。
 *
 * 四档能力，逐级包含——按需取用，别一上来就 `full`：
 *   'minimal'   仅占位，让 import 不炸
 *   'config'    + workspace.getConfiguration / window.show*Message
 *   'workspace' + workspaceFolders / asRelativePath / Uri / FileType
 *   'full'      + 真实文件系统支撑的 workspace.fs 与各类 class/enum 桩
 *
 * 迁移前的四份桩都不还原 `Module._load`；这里返回 `restore()`，请挂到 `after()`。
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');

const FileType = { Unknown: 0, File: 1, Directory: 2, SymbolicLink: 64 };

function makeUri(fsPath) {
  return {
    fsPath,
    path: fsPath.replace(/\\/g, '/'),
    scheme: 'file',
    toString: () => `file://${fsPath.replace(/\\/g, '/')}`,
    with: (o) => makeUri(o && o.path ? o.path : fsPath),
  };
}

const Uri = {
  file: (p) => makeUri(p),
  joinPath: (base, ...segs) => makeUri(path.join(base.fsPath, ...segs)),
  parse: (s) => makeUri(s.replace(/^file:\/\//, '')),
};

function realFs() {
  return {
    readFile: async (uri) => new Uint8Array(fs.readFileSync(uri.fsPath)),
    writeFile: async (uri, bytes) => {
      fs.mkdirSync(path.dirname(uri.fsPath), { recursive: true });
      fs.writeFileSync(uri.fsPath, Buffer.from(bytes));
    },
    stat: async (uri) => {
      const s = fs.statSync(uri.fsPath);
      return { type: s.isDirectory() ? FileType.Directory : FileType.File, size: s.size };
    },
    readDirectory: async (uri) =>
      fs
        .readdirSync(uri.fsPath, { withFileTypes: true })
        .map((d) => [d.name, d.isDirectory() ? FileType.Directory : FileType.File]),
    createDirectory: async (uri) => fs.mkdirSync(uri.fsPath, { recursive: true }),
    delete: async (uri) => fs.rmSync(uri.fsPath, { recursive: true, force: true }),
  };
}

class EventEmitter {
  constructor() { this.listeners = []; this.event = (fn) => { this.listeners.push(fn); return { dispose: () => {} }; }; }
  fire(v) { this.listeners.forEach((fn) => fn(v)); }
  dispose() {}
}

/**
 * @param {object} [opts]
 * @param {'minimal'|'config'|'workspace'|'full'} [opts.level]
 * @param {string} [opts.root] workspaceFolders 指向的目录
 * @param {object} [opts.config] getConfiguration 读到的设置（可后续 mutate）
 */
function installVscodeStub(opts = {}) {
  const { level = 'config', root, config = {} } = opts;
  const settings = config;

  const stub = { window: {}, workspace: {}, commands: {}, Uri: {} };

  if (level !== 'minimal') {
    stub.window = {
      showErrorMessage: async () => undefined,
      showWarningMessage: async () => undefined,
      showInformationMessage: async () => undefined,
      showInputBox: async () => undefined,
      showQuickPick: async () => undefined,
      createOutputChannel: () => ({ appendLine: () => {}, dispose: () => {}, show: () => {} }),
    };
    stub.workspace.getConfiguration = () => ({
      get: (key, dflt) => (key in settings ? settings[key] : dflt),
      update: async (key, value) => { settings[key] = value; },
      has: (key) => key in settings,
      inspect: () => undefined,
    });
  }

  if (level === 'workspace' || level === 'full') {
    stub.Uri = Uri;
    stub.FileType = FileType;
    if (root) {
      stub.workspace.workspaceFolders = [{ uri: makeUri(root), name: path.basename(root), index: 0 }];
      stub.workspace.asRelativePath = (p) => {
        const fsPath = typeof p === 'string' ? p : p.fsPath;
        return path.relative(root, fsPath).replace(/\\/g, '/');
      };
    }
    stub.workspace.fs = level === 'full' ? realFs() : {};
  }

  if (level === 'full') {
    stub.EventEmitter = EventEmitter;
    stub.TreeItem = class { constructor(label, state) { this.label = label; this.collapsibleState = state; } };
    stub.ThemeIcon = class { constructor(id) { this.id = id; } };
    stub.ThemeColor = class { constructor(id) { this.id = id; } };
    stub.MarkdownString = class {
      constructor(v) { this.value = v ?? ''; }
      appendMarkdown(v) { this.value += v; return this; }
    };
    stub.CancellationTokenSource = class {
      constructor() { this.token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose: () => {} }) }; }
      cancel() { this.token.isCancellationRequested = true; }
      dispose() {}
    };
    stub.TreeItemCollapsibleState = { None: 0, Collapsed: 1, Expanded: 2 };
    stub.ProgressLocation = { SourceControl: 1, Window: 10, Notification: 15 };
    stub.ViewColumn = { Active: -1, Beside: -2, One: 1, Two: 2 };
    stub.RelativePattern = class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } };
    stub.workspace.createFileSystemWatcher = () => ({
      onDidCreate: () => ({ dispose: () => {} }),
      onDidChange: () => ({ dispose: () => {} }),
      onDidDelete: () => ({ dispose: () => {} }),
      dispose: () => {},
    });
    stub.commands.executeCommand = async () => undefined;
    stub.commands.registerCommand = () => ({ dispose: () => {} });
  }

  const originalLoad = Module._load;
  Module._load = function (request, ...args) {
    if (request === 'vscode') return stub;
    return originalLoad.call(this, request, ...args);
  };

  return {
    stub,
    settings,
    /** 挂到 after()：迁移前四份桩都不还原，这里补上。 */
    restore() { Module._load = originalLoad; },
  };
}

module.exports = { installVscodeStub, FileType, Uri, makeUri };
