import { spawn } from 'node:child_process';

/**
 * 交给系统默认程序打开（文件、目录或 URL）。
 *
 * 这一句 `explorer | open | xdg-open` 原先在两处各写了一份：`main.ts` 开浏览器、
 * `fileHost.ts` 的「在外部打开」。属于平台机制，所以留在壳里，但只留一份。
 *
 * `detached + unref`：起完就不管，别让子进程拖着服务不退出。
 * 抛不抛异常由调用方决定要不要接——`spawn` 在找不到命令时是**异步**报错
 * （ENOENT 走 error 事件，不是抛出来），所以这里挂一个空 handler，
 * 免得它冒成 unhandled error 把整个服务带崩。
 */
export function openWithSystem(target: string): void {
  const cmd =
    process.platform === 'win32' ? 'explorer' : process.platform === 'darwin' ? 'open' : 'xdg-open';
  const child = spawn(cmd, [target], { detached: true, stdio: 'ignore' });
  child.on('error', () => undefined);
  child.unref();
}
