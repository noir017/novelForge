import * as path from 'node:path';

export interface CliOptions {
  /** 小说工程目录。不带位置参数且不是 `init` 时为空——进空窗口。 */
  root: string | undefined;
  port: number;
  /** 监听地址。缺省只绑本机；绑别的地址必须配令牌（见 auth.ts 的 `exposureError`）。 */
  host: string;
  open: boolean;
  init: boolean;
  /** 终端里连 debug 级日志一起打（逐章进度等）。网页的日志页始终收全量。 */
  verbose: boolean;
}

/**
 * novelforge [dir] [--port N] [--host ADDR] [--no-open] [--verbose]
 * novelforge init [dir]
 *
 * 不带目录起服务时 `root` 为 undefined（不再把 cwd 当成工程）。
 * `init` 不带目录时仍默认当前目录，与原来一致。
 * 令牌不走参数（会出现在 `ps` 里），只认环境变量 `NOVELFORGE_TOKEN`，由 main.ts 读。
 */
export function parseArgs(argv: string[]): CliOptions {
  let port = 3680;
  let host = '127.0.0.1';
  let open = true;
  let init = false;
  let verbose = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = Number(argv[++i]) || 3680;
    } else if (a === '--host') {
      host = argv[++i]?.trim() || '127.0.0.1';
    } else if (a === '--no-open') {
      open = false;
    } else if (a === '--verbose' || a === '-v') {
      verbose = true;
    } else if (a === 'init') {
      init = true;
    } else if (!a.startsWith('-')) {
      rest.push(a);
    }
  }
  let root: string | undefined;
  if (rest.length > 0) {
    root = path.resolve(rest[0]);
  } else if (init) {
    root = path.resolve('.');
  }
  return { root, port, host, open, init, verbose };
}
