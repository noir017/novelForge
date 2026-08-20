/**
 * 独立版入口：`bun run src/shells/standalone/main.ts [dir]` 或
 * `bun build --compile` 出的单文件可执行文件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { dirBaseName, initProjectFlow } from '../../core/actions';
import { initHost } from '../../core/host';
import { NovelProject } from '../../core/model/project';
import { FileConfigStore } from '../../core/stores';
import { parseArgs } from './cli';
import { startServer } from './server';
import { openWithSystem } from './systemOpen';
import { TerminalHost } from './terminalHost';

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.init) {
    // CLI 交互式 init：终端问答后写盘，不开服务。
    // 流程本身**复用 core 的 initProjectFlow**——插件命令、网页按钮走的是同一条，
    // 这里只是换了个把问答接到终端上的 Host。
    const host = new TerminalHost(new FileConfigStore());
    initHost(host);
    const root = opts.root ?? path.resolve('.');
    const project = NovelProject.open(root);
    try {
      if (await initProjectFlow(project, dirBaseName(project))) {
        console.log(`已初始化：${path.join(root, '.novelforge')}`);
      }
    } finally {
      host.close();
    }
    process.exit(0);
  }

  // 解析已允许 root 为空；空窗口起服务要等 WorkspaceHub 接上后再去掉 cwd 回落。
  const serverRoot = opts.root ?? path.resolve('.');
  if (!fs.existsSync(path.join(serverRoot, '.novelforge', 'project.json'))) {
    console.log(`提示：目录还不是小说工程：${serverRoot}`);
    console.log('可先跑 novelforge init，或在网页上点「初始化工程」。');
  }

  // 端口被占时顺延，最多试 20 次。
  let port = opts.port;
  for (let i = 0; ; i++) {
    try {
      port = startServer({ root: serverRoot, port, verbose: opts.verbose });
      break;
    } catch (err) {
      if (i >= 20) {
        throw err;
      }
      port++;
    }
  }

  if (opts.open) {
    openWithSystem(`http://127.0.0.1:${port}/`);
  }
}

void main();
