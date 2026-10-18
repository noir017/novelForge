/**
 * 快捷键的**唯一一张表**：每个键做什么、归哪一组、在哪儿管用。纯数据加几个纯函数，零 DOM、零副作用——
 * 标题栏菜单（view.js）也打包它：菜单上那一格 `kbd` 的字、「帮助 → 快捷键一览」面板（`shortcutsPanel.ts`）、
 * 各处提示里写的键，都从这里取（`shortcutLabel` / `formatKeys`），不各写一份。
 *
 * **新增快捷键必须登记在这里**。各模块的按键处理照旧自己判断按键（`find.ts`、`lines.ts`……），但
 * `tests/dom/standalone/shortcuts.test.js` 守着两头：表里每一条都真的有人处理（照它的生效范围摆好场面按一下，
 * 得被接走），反过来在正文里、页面上、对话输入框里把几百种按法挨个按一遍，被接走的每一下都得在表里查得到。
 * README「内置编辑器」那张快捷键表也由测试对着这张表核（`tests/unit/editor/shortcuts.test.js`）。
 *
 * ## 键怎么写
 *
 * `Mod+Shift+F` 这样，最后一段是键，前面是修饰键：
 * - `Mod`：Windows / Linux 上的 Ctrl、Mac 上的 ⌘。编辑器里认它的地方一律是 `e.ctrlKey || e.metaKey`。
 * - `Ctrl`：两边都是 Control 那颗（只有「重做」的 `Ctrl+Y` 这样写——Mac 上 ⌘Y 不是重做）。
 * - `Alt`（Mac 上 ⌥）、`Shift`。
 * - 键：字母、数字、标点照写；`Up` / `Down` / `Left` / `Right`、`Enter`、`Tab`、`Escape`、`PageUp` / `PageDown`、
 *   `F1`…`F12`，加号写 `Plus`。
 *
 * 显示按平台：Windows / Linux 写 `Ctrl+Shift+F`，Mac 写 `⇧⌘F`（修饰键顺序 ⌃⌥⇧⌘，与系统菜单一样）。
 */

/** 分组，按面板与 README 里从上到下的顺序。 */
export const SHORTCUT_GROUPS = ['文件与标签', '编辑', '段落', '查找替换', '名词补全', '视图', '面板与帮助', '文件页'] as const;
export type ShortcutGroup = (typeof SHORTCUT_GROUPS)[number];

/**
 * 在哪儿管用：
 * - `global`：哪里都行，焦点在左边的对话输入框里也认。
 * - `workbench`：编辑区里或页面上——焦点在对话输入框这类别的输入框里时不拦，留给浏览器。
 * - `editor`：光标在编辑区的正文里（`api.ts` 的 `addKeyHandler`，组字中途不收）。
 * - `context`：某个面板、浮层开着时，或某个页面上（`where` 写是哪儿）。
 */
export type ShortcutScope = 'global' | 'workbench' | 'editor' | 'context';

export interface Shortcut {
  id: string;
  /** 键（写法见文件头）。几种按法都算的列在一起，面板上用「 / 」隔开，菜单上只写第一种（Mac 上优先不用 Control 的那一种）。 */
  keys: readonly string[];
  /** 也认、但不必写出来的按法（例如字号放大的 `Ctrl++`、小键盘的加号）。 */
  also?: readonly string[];
  /** 做什么，一句话。 */
  label: string;
  group: ShortcutGroup;
  scope: ShortcutScope;
  /** 生效范围的说法。`context` 必须给；别的缺省按 `scope` 说（`scopeText`）。 */
  where?: string;
  /** 补一句：浏览器拦不住、只对哪些文件…… */
  note?: string;
  /** 标题栏菜单里写着这个键的那一项（`文件 › 保存`）。测试按它核对菜单上的字。 */
  menu?: string;
  /** 浏览器自己做的（剪切、复制、粘贴、全选）：列出来是为了菜单与一览，编辑器不拦。 */
  native?: boolean;
}

/** 浏览器拦不住、在浏览器里会被拿去干别的的说法（⚑ 键没换，桌面版里照样管用）。 */
const BROWSER_TAKES = '浏览器多半拦不住';
/** 剪切、复制、粘贴、全选是浏览器自己的，哪个输入框里都一样。 */
const NATIVE_WHERE = '能打字的地方（浏览器自己的）';

export const SHORTCUTS = [
  // ---------------------------------------------------------------- 文件与标签
  { id: 'quickOpen', keys: ['Mod+P'], label: '转到一章或一个文件（「转到…」）', group: '文件与标签', scope: 'global', menu: '文件 › 转到…' },
  { id: 'save', keys: ['Mod+S'], label: '保存当前这一份', group: '文件与标签', scope: 'global', menu: '文件 › 保存' },
  {
    id: 'closeTab',
    keys: ['Mod+W'],
    label: '关掉当前标签（有没保存的修改先问）',
    group: '文件与标签',
    scope: 'global',
    note: `${BROWSER_TAKES}：在浏览器里会关掉整个网页（有没保存的内容时浏览器先问一句）；桌面版里管用`,
  },
  {
    id: 'newFile',
    keys: ['Mod+N'],
    label: '新建文件',
    group: '文件与标签',
    scope: 'global',
    note: `${BROWSER_TAKES}：在浏览器里会开一个新窗口；桌面版里管用`,
    menu: '文件 › 新建文件',
  },
  { id: 'openFolder', keys: ['Mod+O'], label: '打开文件夹…', group: '文件与标签', scope: 'global', menu: '文件 › 打开文件夹…' },
  { id: 'prevChapter', keys: ['Alt+PageUp'], label: '上一章', group: '文件与标签', scope: 'workbench', note: '正开着某一章的正文或细纲时' },
  { id: 'nextChapter', keys: ['Alt+PageDown'], label: '下一章', group: '文件与标签', scope: 'workbench', note: '正开着某一章的正文或细纲时' },

  // ---------------------------------------------------------------- 编辑
  { id: 'undo', keys: ['Mod+Z'], label: '撤销（每个文件各记各的）', group: '编辑', scope: 'editor', menu: '编辑 › 撤销' },
  { id: 'redo', keys: ['Ctrl+Y', 'Mod+Shift+Z'], label: '重做', group: '编辑', scope: 'editor', menu: '编辑 › 重做' },
  { id: 'cut', keys: ['Mod+X'], label: '剪切', group: '编辑', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '编辑 › 剪切' },
  { id: 'copy', keys: ['Mod+C'], label: '复制', group: '编辑', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '编辑 › 复制' },
  { id: 'paste', keys: ['Mod+V'], label: '粘贴', group: '编辑', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '编辑 › 粘贴' },
  { id: 'selectAll', keys: ['Mod+A'], label: '全选', group: '编辑', scope: 'editor', where: NATIVE_WHERE, native: true, menu: '编辑 › 全选' },
  {
    id: 'indent',
    keys: ['Tab'],
    label: '缩进；选中几行时每行行首加一级',
    group: '编辑',
    scope: 'editor',
    note: '正文一级是两个全角空格，其余文件两个半角空格',
  },
  { id: 'outdent', keys: ['Shift+Tab'], label: '去掉一级缩进', group: '编辑', scope: 'editor' },
  {
    id: 'newParagraph',
    keys: ['Enter'],
    label: '另起一段',
    group: '编辑',
    scope: 'editor',
    note: '正文按这本书的分段格式（空一行或段首缩进）；Markdown 列表接着往下写',
  },
  { id: 'lineBreak', keys: ['Shift+Enter'], label: '只换行、不缩进', group: '编辑', scope: 'editor' },

  // ---------------------------------------------------------------- 段落
  { id: 'moveParagraph', keys: ['Alt+Up', 'Alt+Down'], label: '这一段与上 / 下一段对调', group: '段落', scope: 'editor' },
  { id: 'copyParagraph', keys: ['Shift+Alt+Down', 'Shift+Alt+Up'], label: '把这一段复制一份放在下面 / 上面', group: '段落', scope: 'editor' },
  { id: 'deleteParagraph', keys: ['Mod+Shift+K'], label: '删掉这一段', group: '段落', scope: 'editor' },
  { id: 'paragraphBelow', keys: ['Mod+Enter'], label: '不管光标在哪，在这一段下面另起一段', group: '段落', scope: 'editor' },

  // ---------------------------------------------------------------- 查找替换
  {
    id: 'find',
    keys: ['Mod+F'],
    label: '查找（这一份文件）',
    group: '查找替换',
    scope: 'workbench',
    note: '焦点在左边对话输入框里时还是浏览器自己的查找',
    menu: '编辑 › 查找',
  },
  { id: 'replace', keys: ['Mod+H'], label: '替换（这一份文件）', group: '查找替换', scope: 'workbench', menu: '编辑 › 替换' },
  { id: 'findNext', keys: ['F3'], label: '下一处', group: '查找替换', scope: 'workbench' },
  { id: 'findPrev', keys: ['Shift+F3'], label: '上一处', group: '查找替换', scope: 'workbench' },
  { id: 'findBoxNext', keys: ['Enter'], label: '下一处', group: '查找替换', scope: 'context', where: '查找条的查找框里' },
  { id: 'findBoxPrev', keys: ['Shift+Enter'], label: '上一处', group: '查找替换', scope: 'context', where: '查找条的查找框里' },
  { id: 'replaceBoxEnter', keys: ['Enter'], label: '替换当前这一处、跳到下一处', group: '查找替换', scope: 'context', where: '查找条的替换框里' },
  { id: 'bookFind', keys: ['Mod+Shift+F'], label: '全书查找', group: '查找替换', scope: 'global', menu: '编辑 › 全书查找替换…' },
  { id: 'bookReplace', keys: ['Mod+Shift+H'], label: '全书替换（光标进替换框）', group: '查找替换', scope: 'global' },

  // ---------------------------------------------------------------- 名词补全
  {
    id: 'names',
    keys: ['Alt+/'],
    label: '名词补全：列出角色名、地名这些名字',
    group: '名词补全',
    scope: 'editor',
    note: '只在正文、草稿、细纲、角色卡、设定、情节大纲、叙事线里',
    menu: '视图 › 名词补全',
  },
  { id: 'namesPick', keys: ['Up', 'Down'], label: '选上一个 / 下一个名字', group: '名词补全', scope: 'context', where: '补全框开着时' },
  {
    id: 'namesAccept',
    keys: ['Enter', 'Tab'],
    label: '插入选中的名字',
    group: '名词补全',
    scope: 'context',
    where: '补全框开着时',
    note: '边打边弹出来的框只认 Tab，回车照常换段',
  },

  // ---------------------------------------------------------------- 视图
  {
    id: 'preview',
    keys: ['Mod+Shift+V'],
    label: '预览 / 编辑切换',
    group: '视图',
    scope: 'workbench',
    note: '只对 Markdown（.md）文件；别的文件照常是粘贴',
  },
  {
    id: 'zoomIn',
    keys: ['Mod+='],
    also: ['Mod+Plus'],
    label: '正文字号放大',
    group: '视图',
    scope: 'editor',
    note: '光标不在正文里时是浏览器自己的整页缩放',
    menu: '视图 › 放大字号',
  },
  { id: 'zoomOut', keys: ['Mod+-'], label: '正文字号缩小', group: '视图', scope: 'editor', menu: '视图 › 缩小字号' },
  { id: 'zoomReset', keys: ['Mod+0'], label: '正文字号还原', group: '视图', scope: 'editor', menu: '视图 › 还原字号' },
  { id: 'focusMode', keys: ['F8'], label: '专注模式：进去 / 出来', group: '视图', scope: 'global', menu: '视图 › 专注模式' },
  {
    id: 'focusExit',
    keys: ['Escape'],
    label: '退出专注模式',
    group: '视图',
    scope: 'context',
    where: '专注模式里',
    note: '查找条、面板、菜单开着时先收它们',
  },

  // ---------------------------------------------------------------- 面板与帮助
  { id: 'shortcuts', keys: ['Mod+/'], label: '快捷键一览（就是这一张）', group: '面板与帮助', scope: 'global', menu: '帮助 › 快捷键一览' },
  { id: 'quickOpenPick', keys: ['Up', 'Down'], label: '选上一条 / 下一条', group: '面板与帮助', scope: 'context', where: '「转到…」面板里' },
  { id: 'quickOpenOpen', keys: ['Enter'], label: '打开选中的那一条', group: '面板与帮助', scope: 'context', where: '「转到…」面板里' },
  { id: 'quickOpenBeside', keys: ['Mod+Enter'], label: '开在右边第二块编辑区', group: '面板与帮助', scope: 'context', where: '「转到…」面板里' },
  {
    id: 'closePanel',
    keys: ['Escape'],
    label: '收起面板、弹窗或菜单',
    group: '面板与帮助',
    scope: 'context',
    where: '面板、弹窗、菜单开着时',
    note: '查找条、全书查找替换、补全框、码字统计、体检、外观面板、对话框都是',
  },

  // ---------------------------------------------------------------- 文件页
  { id: 'filesCopy', keys: ['Mod+C'], label: '复制选中的文件或文件夹', group: '文件页', scope: 'context', where: '「文件」页的树上选中一行时' },
  { id: 'filesCut', keys: ['Mod+X'], label: '剪切选中的文件或文件夹', group: '文件页', scope: 'context', where: '「文件」页的树上选中一行时' },
  { id: 'filesPaste', keys: ['Mod+V'], label: '粘贴到选中的文件夹', group: '文件页', scope: 'context', where: '「文件」页的树上选中一行时' },
] as const satisfies readonly Shortcut[];

export type ShortcutId = (typeof SHORTCUTS)[number]['id'];

const BY_ID = new Map<string, Shortcut>(SHORTCUTS.map((s) => [s.id, s]));

/** 按 id 取一条。 */
export function shortcutById(id: ShortcutId): Shortcut {
  return BY_ID.get(id)!;
}

// ---------------------------------------------------------------- 解析

/** 一种按法拆开之后。`key` 是规范名（字母小写、`Up`、`Enter`、`Plus`……）。 */
export interface KeyCombo {
  mod: boolean;
  ctrl: boolean;
  alt: boolean;
  shift: boolean;
  key: string;
}

/** `Mod+Shift+F` → `{ mod, shift, key: 'f' }`。最后一段是键（`Mod++` 不这样写，加号写 `Plus`）。 */
export function parseKey(spec: string): KeyCombo {
  const parts = spec.split('+');
  const key = parts.pop() ?? '';
  const mods = new Set(parts);
  return {
    mod: mods.has('Mod'),
    ctrl: mods.has('Ctrl'),
    alt: mods.has('Alt'),
    shift: mods.has('Shift'),
    key: key.length === 1 ? key.toLowerCase() : key,
  };
}

/** 一下按键里与「是哪个键」有关的那几样（`KeyboardEvent` 本身就满足）。 */
export interface KeyLike {
  key: string;
  code?: string;
  ctrlKey: boolean;
  metaKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

/** 按着 Alt（Mac 上 ⌥）时 `key` 是打出来的那个特殊字符（⌥/ 是 `÷`），这几个键改看 `code`。 */
const CODE_KEY: Record<string, string> = { Slash: '/', Minus: '-', Equal: '=', Comma: ',', Period: '.' };

function keyFromCode(code: string | undefined): string | undefined {
  if (!code) {
    return undefined;
  }
  const letter = /^Key([A-Z])$/.exec(code) ?? /^Digit(\d)$/.exec(code);
  return letter ? letter[1].toLowerCase() : CODE_KEY[code];
}

/** `KeyboardEvent.key` 换成表里的规范名。 */
export function keyName(e: Pick<KeyLike, 'key' | 'code' | 'altKey'>): string {
  if (e.altKey) {
    const fromCode = keyFromCode(e.code);
    if (fromCode) {
      return fromCode;
    }
  }
  switch (e.key) {
    case 'ArrowUp':
      return 'Up';
    case 'ArrowDown':
      return 'Down';
    case 'ArrowLeft':
      return 'Left';
    case 'ArrowRight':
      return 'Right';
    case 'Esc':
      return 'Escape';
    case ' ':
      return 'Space';
    case '+':
      return 'Plus';
  }
  if (e.code === 'NumpadAdd') {
    return 'Plus';
  }
  return e.key.length === 1 ? e.key.toLowerCase() : e.key;
}

/**
 * 这一下是不是这种按法。`Mod` 认 Ctrl 或 ⌘（两边编辑器里都这样认），没写 `Mod` / `Ctrl` 的两样都不许按；
 * Alt、Shift 按写的来（加号本身就是 Shift 打出来的，`Plus` 不看 Shift）。
 */
export function matchesKey(e: KeyLike, spec: string): boolean {
  const want = parseKey(spec);
  if (keyName(e) !== want.key) {
    return false;
  }
  const ctrlOrMeta = e.ctrlKey || e.metaKey;
  if (want.mod) {
    if (!ctrlOrMeta) {
      return false;
    }
  } else if (want.ctrl) {
    if (!e.ctrlKey || e.metaKey) {
      return false;
    }
  } else if (ctrlOrMeta) {
    return false;
  }
  if (e.altKey !== want.alt) {
    return false;
  }
  return want.key === 'Plus' || e.shiftKey === want.shift;
}

/** 这一下是不是这一条（`keys` 与 `also` 里任一种按法）。 */
export function matchesShortcut(e: KeyLike, id: ShortcutId): boolean {
  const s = shortcutById(id);
  return [...s.keys, ...(s.also ?? [])].some((spec) => matchesKey(e, spec));
}

// ---------------------------------------------------------------- 显示

/** 认不认作 Mac（显示 ⌘ / ⌥）。看 `navigator`，拿不到就当不是。 */
export function isMacPlatform(
  nav: { platform?: string; userAgent?: string; userAgentData?: { platform?: string } } | undefined = typeof navigator ===
  'undefined'
    ? undefined
    : (navigator as { platform?: string; userAgent?: string; userAgentData?: { platform?: string } })
): boolean {
  const platform = nav?.userAgentData?.platform || nav?.platform || '';
  if (platform) {
    return /mac|iphone|ipad|ipod/i.test(platform);
  }
  return /Mac OS X|Macintosh/i.test(nav?.userAgent ?? '');
}

const KEY_TEXT: Record<string, string> = {
  Up: '↑',
  Down: '↓',
  Left: '←',
  Right: '→',
  Escape: 'Esc',
  Plus: '+',
  Space: '空格',
};

function keyText(key: string, mac: boolean): string {
  if (mac && key === 'Enter') {
    return '↩';
  }
  return KEY_TEXT[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

/** 一种按法怎么写：Windows / Linux `Ctrl+Shift+F`，Mac `⇧⌘F`。 */
export function formatKey(spec: string, mac: boolean): string {
  const k = parseKey(spec);
  if (mac) {
    return `${k.ctrl ? '⌃' : ''}${k.alt ? '⌥' : ''}${k.shift ? '⇧' : ''}${k.mod ? '⌘' : ''}${keyText(k.key, true)}`;
  }
  const parts: string[] = [];
  if (k.mod || k.ctrl) {
    parts.push('Ctrl');
  }
  if (k.shift) {
    parts.push('Shift');
  }
  if (k.alt) {
    parts.push('Alt');
  }
  parts.push(keyText(k.key, false));
  return parts.join('+');
}

/** 一条的全部按法，「 / 」隔开（面板与 README 里那样写）。 */
export function formatKeys(s: Shortcut, mac: boolean): string {
  return s.keys.map((spec) => formatKey(spec, mac)).join(' / ');
}

/** 菜单上写哪一种：第一种；Mac 上优先不用 Control 的那一种（Mac 上重做写 ⇧⌘Z，不写 ⌃Y）。 */
export function primaryKey(s: Shortcut, mac: boolean): string {
  return (mac && s.keys.find((spec) => !parseKey(spec).ctrl)) || s.keys[0];
}

/** 菜单与提示里写的那一个键（按当前平台）。 */
export function shortcutLabel(id: ShortcutId, mac = isMacPlatform()): string {
  return formatKey(primaryKey(shortcutById(id), mac), mac);
}

const SCOPE_TEXT: Record<Exclude<ShortcutScope, 'context'>, string> = {
  global: '哪里都行',
  workbench: '编辑区里或页面上',
  editor: '光标在编辑区里',
};

/** 在哪儿管用，面板与 README 里那一格。 */
export function scopeText(s: Shortcut): string {
  return s.where ?? (s.scope === 'context' ? '' : SCOPE_TEXT[s.scope]);
}

/** 筛选：做什么、在哪儿、补充说明、分组、按法（两种平台的写法都认），不分大小写，空白隔开的几段都得有。 */
export function filterShortcuts(list: readonly Shortcut[], query: string): Shortcut[] {
  const words = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) {
    return [...list];
  }
  return list.filter((s) => {
    const hay = [s.label, scopeText(s), s.note ?? '', s.group, formatKeys(s, false), formatKeys(s, true)].join('\n').toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

/** 按分组排好（分组的顺序是 `SHORTCUT_GROUPS`，组里按表里的顺序），空的组不给。 */
export function groupShortcuts(list: readonly Shortcut[]): { group: ShortcutGroup; items: Shortcut[] }[] {
  return SHORTCUT_GROUPS.map((group) => ({ group, items: list.filter((s) => s.group === group) })).filter(
    (g) => g.items.length > 0
  );
}
