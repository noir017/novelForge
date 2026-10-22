/**
 * 情节大纲在 VS Code 里怎么打开。磁盘上没有 `outline.md`——情节大纲是各章细纲「梗概」的汇总
 * （docs/design/plans/2026-10-22-outline-from-plots.md），VS Code 的编辑器却只认文件。于是给它一个只有这一份文件的
 * 虚拟文件系统（`novelforge:` scheme），读写都经 core 的网关：读就是汇总，存就是按章号拆回各章细纲（守卫、记账与
 * 独立版的内置编辑器同一条路，`review: false`——作者手里那份就是他要存的东西）。
 *
 * 细纲改了（`summaries/` 下的 .md 变了），汇总跟着变：`touch` 通知编辑器重读（没改过的标签直接换新，改过的由 VS Code
 * 自己出「磁盘上的版本更新」那一问）。
 *
 * 这是平台专属入口（壳契约第三件）：业务规矩全在 core，这里只把「一个不是文件的文档」接到 VS Code 的文件系统 API 上。
 */
import * as vscode from 'vscode';
import { NovelProject } from '../../core/model/project';
import { Workspace } from '../../core/workspace';

export const OUTLINE_SCHEME = 'novelforge';

/** 情节大纲在虚拟文件系统里的地址：路径与工程里那个身份路径一样（`.novelforge/outline.md`）。 */
export function outlineUri(root: string): vscode.Uri {
  const project = NovelProject.open(root);
  return vscode.Uri.from({ scheme: OUTLINE_SCHEME, path: `/${project.relPath(project.outlinePath)}` });
}

/** 这个工程内相对路径是不是情节大纲（要开在虚拟文件系统上）。 */
export function isOutlinePath(root: string, relPath: string): boolean {
  return new Workspace(NovelProject.open(root)).isOutline(relPath);
}

export class OutlineFileSystem implements vscode.FileSystemProvider {
  private readonly emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  readonly onDidChangeFile = this.emitter.event;
  private mtime = Date.now();

  constructor(private readonly root: string) {}

  /** 细纲变了：汇总文档跟着变。 */
  touch(): void {
    this.mtime = Date.now();
    this.emitter.fire([{ type: vscode.FileChangeType.Changed, uri: outlineUri(this.root) }]);
  }

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  async stat(uri: vscode.Uri): Promise<vscode.FileStat> {
    const text = await this.read(uri);
    return { type: vscode.FileType.File, ctime: 0, mtime: this.mtime, size: Buffer.byteLength(text, 'utf8') };
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return Buffer.from(await this.read(uri), 'utf8');
  }

  async writeFile(uri: vscode.Uri, content: Uint8Array): Promise<void> {
    const rel = this.relOf(uri);
    // 每次一个新的工程实例：细纲列表有缓存，这里不跟对话页那一份共用，免得读到旧的。
    await new Workspace(NovelProject.open(this.root)).write(rel, { text: Buffer.from(content).toString('utf8') }, { mode: 'overwrite', review: false });
    this.touch();
  }

  readDirectory(): [string, vscode.FileType][] {
    throw vscode.FileSystemError.NoPermissions('情节大纲不是目录');
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions('情节大纲不是目录');
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions('情节大纲是各章细纲梗概的汇总，删不掉；要删某一章，在大纲里删掉那一条再保存');
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions('情节大纲不能改名');
  }

  private async read(uri: vscode.Uri): Promise<string> {
    return (await new Workspace(NovelProject.open(this.root)).read(this.relOf(uri))).text;
  }

  /** 只认情节大纲那一个地址，别的一律当不存在。 */
  private relOf(uri: vscode.Uri): string {
    const rel = uri.path.replace(/^\/+/, '');
    if (!isOutlinePath(this.root, rel)) {
      throw vscode.FileSystemError.FileNotFound(uri);
    }
    return rel;
  }
}
