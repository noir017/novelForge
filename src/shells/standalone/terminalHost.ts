import { createInterface, Interface } from 'node:readline/promises';
import { ConfigStore } from '../../core/config';
import { Disposable, Host, InputOptions, PickChoice } from '../../core/host';
import { NovelProject } from '../../core/model/project';
import { Attachment } from '../../core/model/session';

/**
 * 终端形态的 Host：`novelforge init` 用它。
 *
 * 为什么要有这个东西——从前 `main.ts` 的 init 分支自己 readline 问作品名与作者，
 * 那是「初始化工程」这条流程的**第二份实现**（第一份是 core/actions.ts 的
 * `initProjectFlow`，插件命令与网页按钮都走它）。两份实现意味着以后改了一处忘了
 * 另一处：CLI 装出来的工程与网页装出来的会慢慢不一样。
 *
 * 有了这个壳，CLI 就只是「第三个宿主」，流程仍然只有一条。副作用是 CLI init
 * 之后也会接着问「要现在新建第 1 章吗？」——与另外两处一致，那正是重点。
 *
 * 只实现 `init` 这条路真正会用到的东西：input / confirm / pick 走终端问答，
 * toast 打印，openFile 只报一句路径（终端里没有编辑器可开）。`Host` 上的可选方法
 * 一概不实现——core 会自己回落。
 */
export class TerminalHost implements Host {
  readonly name = 'standalone' as const;
  readonly supportsVscodeLm = false;

  /**
   * 整个进程共用一个 readline。
   *
   * **不能每问一句就新建一个再关掉**：关掉之后管道输入（`printf … | novelforge init`）
   * 里剩下的行就读不到了，第二问直接拿到 EOF，看起来像是程序自己跑完了。
   * 交互式终端下这个毛病看不出来，正是这种问题最难查的地方。
   */
  private rl: Interface | undefined;
  /** stdin 关了（EOF / Ctrl+D）。此后一切问答都按「取消」处理。 */
  private closed = false;
  /**
   * 已经读到、但还没有人问的行。
   *
   * 管道输入是**一次全来**的，而两问之间还夹着落盘等 await；不排队的话那几行
   * 会在没人接的时候被丢掉，于是「初始化完要不要建第 1 章」这种后面的问题
   * 永远读到 EOF。交互式输入下队列一直是空的，没有副作用。
   */
  private buffered: string[] = [];
  /** 正在等一行的那个问题。 */
  private waiting: ((line: string | undefined) => void) | undefined;

  constructor(public readonly config: ConfigStore) {}

  /** 用完请调一次，否则进程会被 readline 的句柄拖着不退。 */
  close(): void {
    this.rl?.close();
    this.rl = undefined;
  }

  async input(opts: InputOptions): Promise<string | undefined> {
    // 终端问答里 title 与 prompt 都是给人看的，拼一行足够：
    //   初始化小说工程（1/2） · 作品名 [我的小说]：
    const parts = [opts.title, opts.prompt].filter(Boolean).join(' · ');
    const label = `${parts}${opts.value ? ` [${opts.value}]` : ''}：`;
    for (;;) {
      const answer = await this.ask(label);
      if (answer === undefined) {
        return undefined; // EOF：当作取消，别在校验失败里死循环
      }
      // 直接回车 = 采用默认值，与图形界面里预填好文本框的行为一致。
      const value = answer === '' && opts.value !== undefined ? opts.value : answer;
      const err = opts.validate?.(value);
      if (!err) {
        return value;
      }
      console.log(`  ${err}`);
    }
  }

  /** 只认第一个动作为「是」，其余都当取消——与网页那边的确定/取消同构。 */
  async confirm(message: string, actions: string[]): Promise<string | undefined> {
    const yes = actions[0] ?? '确定';
    const answer = (await this.ask(`${message}（${yes}? y/N）：`))?.toLowerCase();
    return answer === 'y' || answer === 'yes' ? yes : undefined;
  }

  async pick<T>(choices: PickChoice<T>[], title: string): Promise<T | undefined> {
    if (choices.length === 0) {
      return undefined;
    }
    console.log(title);
    choices.forEach((c, i) => {
      const desc = c.description ? `（${c.description}）` : '';
      console.log(`  ${i + 1}. ${c.label}${desc}`);
    });
    const answer = await this.ask(`选一项（1-${choices.length}，回车取消）：`);
    const index = Number(answer) - 1;
    return Number.isInteger(index) && index >= 0 && index < choices.length
      ? choices[index].value
      : undefined;
  }

  /** 终端里没有进度条可画：直接跑，把每条进度打出来。 */
  async progress<T>(
    title: string,
    fn: (signal: AbortSignal, report: (message: string) => void) => Promise<T>
  ): Promise<T> {
    console.log(title);
    return fn(new AbortController().signal, (message) => console.log(`  ${message}`));
  }

  /** CLI 是一次性的，没有界面要刷新。 */
  watch(_project: NovelProject, _onChange: () => void): Disposable {
    return { dispose: () => undefined };
  }

  /** 终端里开不了编辑器，报一句路径就够。 */
  async openFile(relPath: string): Promise<void> {
    console.log(`文件：${relPath}`);
  }

  toast(message: string, level: 'info' | 'error' = 'info'): void {
    console[level === 'error' ? 'error' : 'log'](message);
  }

  /** 终端里没有选区可取，也没有粘贴框可弹。 */
  async selectionAttachment(_project: NovelProject): Promise<Attachment | undefined> {
    return undefined;
  }

  /** 问一句。返回 undefined 表示 stdin 已经关了（EOF），调用方按取消处理。 */
  private async ask(label: string): Promise<string | undefined> {
    if (this.closed && this.buffered.length === 0) {
      return undefined;
    }
    process.stdout.write(label);
    const line = this.buffered.length > 0 ? this.buffered.shift() : await this.nextLine();
    return line?.trim();
  }

  /**
   * 等下一行。
   *
   * 不用 `rl.question()`：它在 EOF 时永不 resolve（readline 直接 close），
   * 整个进程会静悄悄地退出，看起来就像「问了一半自己跑完了」。自己听 line/close
   * 两个事件，顺便把没人接的行排进队列。
   */
  private nextLine(): Promise<string | undefined> {
    if (!this.rl) {
      this.rl = createInterface({ input: process.stdin, output: process.stdout });
      this.rl.on('line', (line) => {
        const waiter = this.waiting;
        this.waiting = undefined;
        if (waiter) {
          waiter(line);
        } else {
          this.buffered.push(line);
        }
      });
      this.rl.on('close', () => {
        this.closed = true;
        const waiter = this.waiting;
        this.waiting = undefined;
        waiter?.(undefined);
      });
    }
    if (this.closed) {
      return Promise.resolve(undefined);
    }
    return new Promise((resolve) => {
      this.waiting = resolve;
    });
  }
}
