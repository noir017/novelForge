/**
 * 独立版入口：`bun run src/standalone/main.ts [dir]` 或
 * `bun build --compile` 出的单文件可执行文件。
 */
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline/promises';
import { NovelProject } from '../core/model/project';
import { parseArgs } from './cli';
import { startServer } from './server';

async function main(): Promise<void> {
  const opts = parseArgs(process.argv.slice(2));

  if (opts.init) {
    // CLI 交互式 init：终端问答后写盘，不开服务。
    const project = NovelProject.open(opts.root);
    if (await project.isInitialized()) {
      console.log('该目录已是小说工程。');
    } else {
      const title = await ask('作品名：');
      const author = await ask('作者名（可留空）：');
      await project.initialize({ title: title.trim() || '我的小说', author: author.trim() });
      console.log(`已初始化：${path.join(opts.root, '.novelforge')}`);
    }
    process.exit(0);
  }

  if (!fs.existsSync(path.join(opts.root, '.novelforge', 'project.json'))) {
    console.log(`提示：目录还不是小说工程：${opts.root}`);
    console.log('可先跑 novelforge init，或在网页上点「初始化工程」。');
  }

  // 端口被占时顺延，最多试 20 次。
  let port = opts.port;
  for (let i = 0; ; i++) {
    try {
      port = startServer({ root: opts.root, port });
      break;
    } catch (err) {
      if (i >= 20) {
        throw err;
      }
      port++;
    }
  }

  if (opts.open) {
    const url = `http://127.0.0.1:${port}/`;
    const cmd = process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
    spawn(cmd, [url], { detached: true, stdio: 'ignore' }).unref();
  }
}

async function ask(label: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return (await rl.question(label)).trim();
  } finally {
    rl.close();
  }
}

void main();
