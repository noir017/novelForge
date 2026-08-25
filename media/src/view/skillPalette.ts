/**
 * `/` 技能面板：贴着输入框上沿浮出来的候选列表。
 *
 * ## 为什么不是宿主的选择器
 *
 * 早一版走的是 `getHost().pick()`（与 `@` 引用同一条路）：插件弹 QuickPick、
 * 独立版弹一个居中的网页模态框。形态上省事，但那两件事不一样。
 *
 * `@` 挑的是一个**文件**——候选是整棵工程树，几百项，要搜要分组；那本来就是一次
 * 独立的检索，跳出一个框来是合理的。
 *
 * `/` 挑的是**这句话按哪套方法做**，候选通常不到十项，而且它就是这句话的一部分：
 * 打 `/` 的时候手在键盘上、光标在输入框里。跳一个居中模态框出来，等于把光标从
 * 正在写的句子上拽走一次，挑完还得自己找回去。
 *
 * 所以它回到了这个工程从前那个命令面板的形态（也是 Cursor / Claude Code 那一套）：
 * **`/` 就是输入框里的一个普通字符**，面板只是浮在它上方的候选列表。
 *
 * ## 从那一版命令面板继承下来的三条
 *
 * 那一版（`view/commands.ts`，随单步一起删了）踩过的坑，这里一条都不重踩：
 *
 * 1. **过滤串从输入框的值算出来**（{@link slashQuery}），不自己攒。从前 `/` 由
 *    keydown 拦下来**不落进输入框**，过滤串攒在模块变量里——那等于在输入框旁边
 *    又造了一个隐形输入框：光标在哪、退格退的是谁全靠猜，而**输入法打的中文一个
 *    都收不到**（composition 期间不发可打印键的 keydown）。现在中文、退格、粘贴、
 *    Ctrl+A 全都自动对。
 * 2. **面板的开合挂在 `input` 事件上**，不是一串各自为政的 keydown 分支：它是
 *    输入框内容的函数。键盘只接管 ↑↓ / Enter·Tab / Esc 四种，可打印字符一律放行。
 * 3. **判据是「整个输入框只有一个 `/词`」**（`/^\/(\S*)$/`）。`/` 在中文正文里是
 *    普通字符（路径、日期、比值、「他/她」），`看看 chapters/009` 与 `/ 一句话`
 *    都不该弹面板。这条判据同时管着「要不要开面板」与「挑中之后要不要把那几个字
 *    从输入框里抹掉」，所以只写一次。
 *
 * ## 名单从后端来
 *
 * 与那一版的唯一实质差别：候选不是纯函数算出来的，是后端推的（`skillList`）。
 * 技能在磁盘上（`.novelforge/skills/`）而档位在配置里，前端算不出来。
 *
 * 打开面板时发一条 `requestSkills` **重扫**：作者可能刚写完一份技能，这一刻他要的
 * 就是它。手上那份旧名单同时照画——等一次往返才出候选，面板就成了「打个斜杠卡半秒」。
 */
import { el as mk, clear, closestFrom } from '../dom';
import { SKILL_AUDIENCE_HINT, SKILL_MODE_LABEL } from '../protocol';
import type { SkillRow } from '../protocol';
import { el } from './refs';
import { store, vscode } from './store';

/** 当前打开的面板。同时只允许一个。 */
let panel: HTMLElement | null = null;
/** 过滤之后画出来的那几项，键盘导航认的是它。 */
let items: SkillRow[] = [];
let active = 0;
/**
 * Esc 关过之后不该马上弹回来。
 *
 * 输入框里那个 `/` 还在（那是作者的字，不替他删），而面板是由输入框的值驱动的
 * ——不记一笔「他已经关过了」，下一次按键又会把它弹出来。
 */
let dismissed = false;

/**
 * 收到过后端那份名单没有。
 *
 * 「还没收到」与「一份都没有」是两件事：第一次打 `/` 时名单必然是空的（`ready`
 * 那一套不带它），照着「空」画就会闪一句「一份能用的技能都没有」——那不是缺信息，
 * 是给了一句错的。所以那一瞬间说的是「正在读取」。
 */
let loaded = false;

/**
 * 输入框当下的技能查询串；不在挑技能时为 null。
 *
 * 整个值必须只有一个 `/词`。空串（只打了 `/`）与 null（不在挑）是两件事，
 * 所以返回 `string | null` 而不是 `string`。
 */
export function slashQuery(value: string): string | null {
  const m = /^\/(\S*)$/.exec(value);
  return m ? m[1] : null;
}

export function isSkillPaletteOpen(): boolean {
  return !!panel;
}

export function closeSkillPalette(): void {
  panel?.remove();
  panel = null;
  active = 0;
  el.skillBtn.classList.remove('active');
}

/**
 * 输入框的值变了：该开就开、该关就关、开着就重画。
 *
 * 由 composer 的 `input` 监听转进来。
 */
export function syncSkillPalette(): void {
  const q = slashQuery(el.input.value);
  if (q === null) {
    // 已经不是在挑技能了（删掉了 `/`、或往后打了别的字）——顺手把「关过了」
    // 这一笔也清掉，下次打 `/` 才还能弹。
    dismissed = false;
    closeSkillPalette();
    return;
  }
  if (dismissed) {
    return;
  }
  if (panel) {
    redraw();
  } else {
    openSkillPalette();
  }
}

/**
 * 「/ 技能」按钮：开则关，关则开。
 *
 * 输入框为空时顺手把 `/` 打进去——按钮和键盘走的是同一条路，界面上不该出现
 * 「点按钮弹出来的面板」和「打 / 弹出来的面板」两种东西。输入框里已经有别的字时
 * **不动那些字**：他正写着要求，挑份技能带上就好。
 */
export function toggleSkillPalette(): void {
  if (panel) {
    dismissed = true;
    closeSkillPalette();
    return;
  }
  dismissed = false;
  if (el.input.value === '') {
    el.input.value = '/';
  }
  el.input.focus();
  openSkillPalette();
}

export function openSkillPalette(): void {
  closeSkillPalette();
  if (el.skillBtn.disabled) {
    return;
  }
  // 每次打开都重扫一遍：作者可能刚在 .novelforge/skills/ 下写完一份。手上那份
  // 旧名单先照画，回来了再重画（`applySkillList`）——等一次往返才出候选的话，
  // 面板就成了「打个斜杠卡半秒」。
  vscode.postMessage({ type: 'requestSkills' });

  panel = mk('div', 'skill-panel');
  panel.setAttribute('role', 'listbox');
  // 挂在输入框那一格里（它是 position: relative），面板从输入框上沿往上浮。
  // 斜杠与过滤串留在输入框里，候选浮在正上方——视线不用离开正在打字的地方。
  el.composerInput.appendChild(panel);
  el.skillBtn.classList.add('active');
  redraw();

  // 点别处收起。延到下一拍再挂，否则「点按钮打开」这一次点击自己就把它关了。
  setTimeout(() => document.addEventListener('click', onDocClick), 0);
}

/** 后端推来一份新名单：开着的面板要就地更新，别等作者再按一下键。 */
export function applySkillList(rows: SkillRow[]): void {
  store.skillList = rows;
  loaded = true;
  if (panel) {
    redraw();
  }
}

function onDocClick(e: MouseEvent): void {
  if (!panel) {
    document.removeEventListener('click', onDocClick);
    return;
  }
  if (!panel.contains(e.target as Node) && !closestFrom(e.target, '#skillBtn')) {
    dismissed = true;
    closeSkillPalette();
    document.removeEventListener('click', onDocClick);
  }
}

function redraw(): void {
  if (!panel) {
    return;
  }
  clear(panel);

  const filter = slashQuery(el.input.value) ?? '';
  items = matching(store.skillList, filter);
  active = Math.min(active, Math.max(0, items.length - 1));

  const head = mk('div', 'skill-panel-head');
  head.appendChild(mk('span', 'skill-panel-title', '技能'));
  head.appendChild(mk('span', 'meta', headNote(filter)));
  panel.appendChild(head);

  // 一份技能都没有：说清为什么，别摆一块空白让人以为面板坏了。工程技能写在
  // 哪儿要写全——那正是作者这时候需要知道的一件事。**还没收到那份名单时说的是
  // 另一句话**：第一次打 `/` 时名单必然是空的，照着「一份都没有」画等于给了
  // 一句错的。
  if (store.skillList.length === 0) {
    panel.appendChild(
      mk(
        'div',
        'skill-panel-empty',
        loaded
          ? '一份能用的技能都没有。可以在 .novelforge/skills/<名字>/SKILL.md 里写一份，或者在设置页里把某份技能从「禁用」改回来。'
          : '正在读取技能…'
      )
    );
    return;
  }

  items.forEach((row, i) => {
    panel!.appendChild(buildRow(row, i));
  });
}

/** 面板标题右边那一句。三种情况说三句话，不含糊成一句。 */
function headNote(filter: string): string {
  if (store.skillList.length === 0) {
    return '';
  }
  if (items.length === 0) {
    return `没有匹配「${filter}」的技能`;
  }
  return '↑↓ 选择 · Enter 确认';
}

function buildRow(row: SkillRow, i: number): HTMLElement {
  const node = mk('button', `skill-item${i === active ? ' active' : ''}`);
  node.dataset.skill = row.name;
  node.setAttribute('role', 'option');
  node.setAttribute('aria-selected', i === active ? 'true' : 'false');

  const line = mk('span', 'skill-line');
  // 名字前面带上斜杠：面板里挑的和输入框里打的是同一样东西。显示的是不带前缀
  // 那一半（前缀是给模型照抄的，作者认的是名字本身），全名在 tooltip 上。
  const label = mk('span', 'skill-item-label', `/${row.stem}`);
  label.title = row.name;
  line.appendChild(label);
  // 同名的两份（内置一份、工程一份）靠这个徽章分得清哪行是哪份。
  line.appendChild(mk('span', 'skill-item-src', row.source === 'builtin' ? '内置' : '本工程'));
  // 给创作模型的那一类另标一枚：挑中它带过去的是一句指令而不是整份正文，
  // 作者该知道自己挑的是哪一种东西。
  if (row.audience === 'generate') {
    const badge = mk('span', 'skill-item-src', '给创作模型');
    badge.title = SKILL_AUDIENCE_HINT.generate;
    line.appendChild(badge);
  }
  // 已经呼出的那几份：面板浮起来正好盖住输入框上方那几枚标签，不标一下的话
  // 作者只会再挑一次，然后收到一句「已经呼出这一份了」。
  if (store.skills.some((s) => s.name === row.name)) {
    line.appendChild(mk('span', 'skill-item-held', '已呼出'));
  }
  node.appendChild(line);

  // 描述没写就不占一行——那一行空着比没有更难看。「仅用户」之外的档位额外标一下：
  // 那几档 agent 每轮也看得见，作者改过之后该在这里认得出来。
  // `generate` 那一类不标档位：它只有「启用 / 禁用」两种，而列在面板里的
  // 本来就都是启用的——标一句「agent 每轮可见（仅用户）」是句错话。
  const hint = row.audience === 'generate' || row.mode === 'user' ? row.description : hintWithMode(row);
  if (hint) {
    node.appendChild(mk('span', 'skill-item-hint', hint));
  }

  node.addEventListener('mouseenter', () => {
    if (active !== i) {
      active = i;
      redraw();
    }
  });
  node.addEventListener('click', () => pick(row));
  return node;
}

function hintWithMode(row: SkillRow): string {
  const mode = `agent 每轮可见（${SKILL_MODE_LABEL[row.mode]}）`;
  return row.description ? `${row.description} · ${mode}` : mode;
}

/**
 * 名字（不带前缀那一半）与描述都认，大小写不敏感。
 *
 * 也认全名：作者从别处抄一段 `builtin:foreshadowing-audit` 过来时该找得到。
 * **不做拼音首字母**——那一版命令面板的命令自带 `keys`（后端定义的），技能的
 * 名字是作者自己起的，替他猜一份拼音索引会在中文名上频繁猜错。
 */
function matching(all: SkillRow[], q: string): SkillRow[] {
  const needle = q.trim().toLowerCase();
  if (!needle) {
    return all;
  }
  return all.filter(
    (s) =>
      s.stem.toLowerCase().includes(needle) ||
      s.name.toLowerCase().includes(needle) ||
      s.description.toLowerCase().includes(needle)
  );
}

function pick(row: SkillRow): void {
  // `/词` 那几个字是用来挑技能的，不是要发给模型的话——挑完就收走，输入框留给
  // 真正的要求。输入框里本来就是别人的正文时（按钮开的面板）一个字都不动。
  if (slashQuery(el.input.value) !== null) {
    el.input.value = '';
  }
  dismissed = false;
  closeSkillPalette();
  document.removeEventListener('click', onDocClick);
  // **正文不在前端**：只发名字，后端读盘、攒着、推回一枚标签（见
  // core/controller/skills.ts）。几千字放在前端等于让「刷新一次就丢」变成可能。
  vscode.postMessage({ type: 'useSkill', name: row.name });
  el.input.focus();
}

/**
 * 面板开着时接管键盘。返回 true 表示这一下已被消费，输入框不该再处理。
 *
 * 只认导航与确认那四种键：**可打印字符一律放行**给输入框，过滤串由
 * {@link syncSkillPalette} 从输入框的值重算。
 */
export function handleSkillKey(e: KeyboardEvent): boolean {
  if (!panel) {
    return false;
  }
  switch (e.key) {
    case 'Escape':
      dismissed = true;
      closeSkillPalette();
      return true;
    case 'ArrowDown':
      active = items.length === 0 ? 0 : (active + 1) % items.length;
      redraw();
      return true;
    case 'ArrowUp':
      active = items.length === 0 ? 0 : (active - 1 + items.length) % items.length;
      redraw();
      return true;
    case 'Tab':
    case 'Enter':
      // 有候选就挑它；一个都没匹配上时 Enter **不该悄悄把 `/xxx` 当成一句话发出去**。
      if (items[active]) {
        pick(items[active]);
      }
      return true;
    default:
      return false;
  }
}

/** 面板与那颗按钮在生成期间都该停手——呼出的技能是给**下一句话**用的。 */
export function setSkillPaletteDisabled(disabled: boolean): void {
  el.skillBtn.disabled = disabled;
  if (disabled) {
    closeSkillPalette();
  }
}
