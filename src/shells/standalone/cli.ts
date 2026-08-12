import * as path from 'node:path';

export interface CliOptions {
  root: string;
  port: number;
  open: boolean;
  init: boolean;
  /** 终端里连 debug 级日志一起打（逐章进度等）。网页的日志页始终收全量。 */
  verbose: boolean;
}

/**
 * novelforge [dir] [--port N] [--no-open] [--verbose]
 * novelforge init [dir]
 */
export function parseArgs(argv: string[]): CliOptions {
  let root = '.';
  let port = 3680;
  let open = true;
  let init = false;
  let verbose = false;
  const rest: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--port') {
      port = Number(argv[++i]) || 3680;
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
  if (rest.length > 0) {
    root = rest[0];
  }
  return { root: path.resolve(root), port, open, init, verbose };
}
