/**
 * 空窗口欢迎页（开始 / 最近 / 怎么上手）、窗口标题、无工程时侧栏短空态。
 *
 * 「新建一本书」「导入写好的书」（2026-10-24）各是一张表单：书名、作者、放在哪一次填好，后端建文件夹并初始化
 * （`createProject` → `projectCreated`），前端再照常打开它；导入的那本 txt 先看切得出几章（`inspectBook` →
 * `bookInspected`），说明摆在表单上，打开之后带着它的路径接着导入（`projectAction importManuscript hostPath`）。
 *
 * 没有 `#nfWelcome` 就直接 return（插件）。不判断壳名。
 */
import { el as mk } from '../dom';
import { confirmProceedIfDirty, resetEditor, windowProject } from '../globals';
import { bookDirName } from '../protocol';
import type { BookInspection, WorkspaceItem, WorkspaceRecent } from '../protocol';
import { pickHostPath } from './folderPicker';
import { openForm } from './form';
import { showProjectTab } from './project/tabs';
import { el } from './refs';
import { hasWorkspace, store, vscode } from './store';
import { showTab } from './tabs';
import { toast } from './toast';

const EMPTY_HINT = '打开文件夹后即可使用';
const SIDE_PANES = ['pane-chat', 'pane-project', 'pane-files', 'pane-versions', 'pane-history'];

let fileName: string | null = null;
let about: HTMLElement | undefined;
/**
 * 刚建好、等着打开的那本书：打开之后切到「工程 → 章节」，带着 txt 的接着导入。`root` 是后端给的真实路径，与
 * `workspaces` 的 `currentId` 同一个口径——只在这个窗口真换成了它时才落地，换成了别的（没打开成、作者又开了别的）就作废，
 * 绝不把 txt 导进另一本书。
 */
let pendingBook: { root: string; importFrom?: string } | undefined;
/** 「导入写好的书」挑好、正等后端看切得出几章的那一本。别的回答不认。 */
let inspecting: string | undefined;

export function requestOpenFolder(): void {
  pickFolder('open', '打开文件夹');
}

/** 「新建一本书…」：一张表单，书名、作者、放在哪。 */
export function requestNewProject(): void {
  openBookForm();
}

/** 「导入写好的书（txt）…」：先挑一本，后端看切得出几章，再开同一张表单。 */
export function requestImportBook(): void {
  pickHostPath({
    kind: 'file',
    title: '导入写好的书：选一本 txt',
    extensions: ['txt'],
    onPick: (path) => {
      inspecting = path;
      vscode.postMessage({ type: 'inspectBook', path });
    },
  });
}

/** 后端看完了那本 txt：认不出章就说为什么（改好 txt 再来），认得出就开表单。 */
export function applyBookInspected(msg: BookInspection): void {
  if (msg.path !== inspecting) {
    return;
  }
  inspecting = undefined;
  if (msg.chapters === 0) {
    toast(msg.error ?? '这本 txt 里认不出章节。', true);
    return;
  }
  openBookForm(msg);
}

/** 建好了：照常打开（这个窗口还是新窗口看设置），打开之后切到章节页、接着导入。 */
export function applyProjectCreated(msg: { root: string; importFrom?: string }): void {
  openProject(msg.root, { fresh: true, importFrom: msg.importFrom });
}

/**
 * 新建一本书 / 导入写好的书的那张表单。`inspection` 给了就是导入：说明里写认出几章、丢掉了什么（与「导入原稿」
 * 确认框同一份），书名缺省取文件名，提交带上那本 txt。
 */
function openBookForm(inspection?: BookInspection): void {
  openForm({
    title: inspection ? '导入写好的书' : '新建一本书',
    lead: inspection
      ? `${inspection.headline}。这一步不调用模型。`
      : '起个书名就建好一本空书，接着在「工程 → 章节」里新建第 1 章开写。光写字不需要配模型。',
    details: inspection?.detail,
    fields: [
      { kind: 'text', key: 'title', label: '书名', value: inspection?.title ?? '', placeholder: '如「青云剑录」', required: true },
      { kind: 'text', key: 'author', label: '作者（可以空着）' },
      {
        kind: 'text',
        key: 'parent',
        label: '放在',
        value: store.newProjectParent ?? '',
        required: true,
        browse: {
          label: '选…',
          run: (current, set) =>
            pickHostPath({ kind: 'dir', title: '放在哪个文件夹里', start: current.trim() || undefined, onPick: set }),
        },
      },
    ],
    note: (v) => {
      const name = bookDirName(String(v.title));
      if (!name) {
        return { text: '书名里的字都不能当文件夹名，换一个。', ok: false };
      }
      return { text: `会新建文件夹 ${joinPath(String(v.parent), name)}，书就放在里面。` };
    },
    submitLabel: inspection ? '导入' : '新建',
    onSubmit: (v) =>
      vscode.postMessage({
        type: 'createProject',
        parent: String(v.parent),
        title: String(v.title),
        author: String(v.author),
        ...(inspection ? { importFrom: inspection.path } : {}),
      }),
  });
}

/** 预览用的拼路径：目录里写的是反斜杠（Windows）就用反斜杠。真建在哪以后端为准。 */
function joinPath(parent: string, name: string): string {
  const dir = parent.trim();
  const sep = dir.includes('\\') && !dir.includes('/') ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

export function requestOpenFile(): void {
  if (!hasWorkspace()) {
    return;
  }
  pickFolder('file', '打开文件：工程内相对路径');
}

function pickFolder(intent: 'open' | 'file', title: string): void {
  const ev = new CustomEvent('nf-pick-folder', { detail: { intent }, cancelable: true });
  window.dispatchEvent(ev);
  if (ev.defaultPrevented) {
    return;
  }
  const path = window.prompt(title, '');
  if (!path?.trim()) {
    return;
  }
  if (intent === 'file') {
    vscode.postMessage({ type: 'openEditor', path: path.trim() });
    return;
  }
  openProject(path.trim());
}

export function openRecent(root: string): void {
  openProject(root);
}

/** 新窗口网址上的这两个参数：刚建好的书（打开之后切到章节页）、接着要导入的那本 txt。 */
const BOOK_PARAM = 'book';
const IMPORT_PARAM = 'import';

/**
 * 打开一个工程。这个窗口已经开着别的工程、且设置里开着「新窗口中打开项目」时开一个新窗口，
 * 这个窗口不动；否则换掉这个窗口里的工程。`fresh`：刚建好的书，打开后切到「工程 → 章节」；
 * `importFrom`：接着把这本 txt 导进来。
 */
export function openProject(root: string, opts: { fresh?: boolean; importFrom?: string } = {}): void {
  if (store.openInNewWindow && store.currentId && store.currentId !== root) {
    const url = new URL(location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('project', root);
    if (opts.fresh) {
      url.searchParams.set(BOOK_PARAM, '1');
    }
    if (opts.importFrom) {
      url.searchParams.set(IMPORT_PARAM, opts.importFrom);
    }
    if (window.open(url.toString(), '_blank')) {
      return;
    }
    toast('浏览器拦下了新窗口，改在当前窗口打开。');
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  if (opts.fresh) {
    pendingBook = { root, ...(opts.importFrom ? { importFrom: opts.importFrom } : {}) };
  }
  vscode.postMessage({ type: 'openFolder', path: root, mode: 'replace' });
}

/** 刚建好的书打开了：侧栏切到「工程 → 章节」（新书在那里新建第 1 章，导入的书在那里看导进来的章），有 txt 就接着导入。 */
function landInBook(book: { importFrom?: string }): void {
  showTab('project');
  vscode.postMessage({ type: 'switchTab', tab: 'project' });
  showProjectTab('chapters');
  if (book.importFrom) {
    vscode.postMessage({ type: 'projectAction', action: 'importManuscript', hostPath: book.importFrom });
  }
}

/**
 * 网址跟着这个窗口的工程走：刷新、断线重连都回到这个工程（WebSocket 握手带着它），
 * 收藏下来的网址也直接打开它。插件的 webview 没有可改的网址。
 */
function syncUrl(currentId: string | null): void {
  if (location.protocol !== 'http:' && location.protocol !== 'https:') {
    return;
  }
  if (windowProject() === currentId) {
    return;
  }
  const url = new URL(location.href);
  if (currentId) {
    url.searchParams.set('project', currentId);
  } else {
    url.searchParams.delete('project');
  }
  history.replaceState(history.state, '', url.toString());
}

export function closeFolder(): void {
  if (!hasWorkspace()) {
    return;
  }
  if (!confirmProceedIfDirty()) {
    return;
  }
  vscode.postMessage({ type: 'closeFolder' });
}

export function showWelcome(): void {
  const node = document.getElementById('nfWelcome');
  if (!node) {
    return;
  }
  if (store.currentId === null) {
    revealNarrowEditor();
    return;
  }
  document.body.classList.add('show-welcome');
  revealNarrowEditor();
}

/**
 * 窄屏（≤900px，与 `narrow.css`、`editor/shell.ts` 的 `NARROW_WIDTH` 同一个界）上编辑区是收着的覆盖层，欢迎页在它里面：
 * 要给人看就得翻上来，与编辑器打开文件时的 `revealEditor` 是同一个类。宽屏上编辑区常驻，什么都不做。
 */
function revealNarrowEditor(): void {
  if (window.matchMedia?.('(max-width: 900px)').matches) {
    document.body.classList.add('editor-open');
  }
}

export function hideWelcome(): void {
  document.body.classList.remove('show-welcome');
}

export function showAbout(): void {
  if (!about) {
    return;
  }
  const version = document.getElementById('wbTitle')?.dataset.version || '0.0.0';
  const ver = about.querySelector('.nf-about-ver');
  const pathLine = about.querySelector('.nf-about-path');
  if (ver) {
    ver.textContent = `版本 ${version}`;
  }
  if (pathLine) {
    const root = store.currentId;
    pathLine.textContent = root ? `工程 ${root}` : '';
  }
  about.classList.add('open');
}

export function applyWorkspaces(msg: {
  currentId: string | null;
  items: WorkspaceItem[];
  recents: WorkspaceRecent[];
  openInNewWindow?: boolean;
  newProjectParent?: string;
}): void {
  const prev = store.currentId;
  store.currentId = msg.currentId;
  store.recents = msg.recents ?? [];
  if (typeof msg.openInNewWindow === 'boolean') {
    store.openInNewWindow = msg.openInNewWindow;
  }
  if (msg.newProjectParent) {
    store.newProjectParent = msg.newProjectParent;
  }
  // 先改网址再重置编辑器：标签页按网址上的工程分开记，重置之后要读的是新工程那一份。
  syncUrl(msg.currentId);
  const empty = msg.currentId === null;
  const wasEmpty = document.body.classList.contains('no-workspace');
  document.body.classList.toggle('no-workspace', empty);
  if (empty) {
    document.body.classList.remove('show-welcome');
    fileName = null;
    // 窄屏上欢迎页所在的编辑区是收着的覆盖层：刚变成空窗口（含一打开页面就是空窗口）时把它翻上来
    // （标题栏 ▤ 照样能收起，去设置页配模型）。
    if (!wasEmpty || prev === undefined) {
      revealNarrowEditor();
    }
  } else if (wasEmpty && prev !== undefined) {
    // 从欢迎页打开了一本书：窄屏上把覆盖着的编辑区收起来，露出侧栏（打开之后会切到「工程 → 章节」）。
    document.body.classList.remove('editor-open');
  }
  if (prev !== undefined && msg.currentId !== prev) {
    resetEditor();
  }
  // 等的是「这个窗口换了工程」那一条：空窗口那一条（新窗口刚装好时自己推的）与还是原来那本的不算。
  if (pendingBook && msg.currentId && msg.currentId !== prev) {
    const book = pendingBook;
    pendingBook = undefined;
    if (msg.currentId === book.root) {
      landInBook(book);
    }
  }
  updateTitle(msg.items[0]);
  renderRecents();
  syncComposerLock();
}

export function installWelcome(): void {
  const root = document.getElementById('nfWelcome');
  if (!root) {
    return;
  }

  ensureSideEmptyHints();
  about = buildAbout();
  document.body.appendChild(about);

  root.addEventListener('click', (e) => {
    const btn = (e.target as HTMLElement | null)?.closest<HTMLElement>('[data-welcome]');
    if (!btn?.dataset.welcome) {
      return;
    }
    if (btn.dataset.welcome === 'openFolder') {
      requestOpenFolder();
    } else if (btn.dataset.welcome === 'newProject') {
      requestNewProject();
    } else if (btn.dataset.welcome === 'importBook') {
      requestImportBook();
    }
  });

  window.addEventListener('nf-editor-active', (e) => {
    fileName = fileNameOf(e.detail.path);
    if (e.detail.path) {
      hideWelcome();
    }
    updateTitle();
  });

  // 刚建好的书开在了新窗口里：打开之后由这个窗口切到章节页、接着导入。参数用过就摘掉，刷新不再来一遍。
  const url = new URL(location.href);
  const project = url.searchParams.get('project');
  if (url.searchParams.has(BOOK_PARAM) && project) {
    const importFrom = url.searchParams.get(IMPORT_PARAM) || undefined;
    pendingBook = { root: project, ...(importFrom ? { importFrom } : {}) };
    url.searchParams.delete(BOOK_PARAM);
    url.searchParams.delete(IMPORT_PARAM);
    history.replaceState(history.state, '', url.toString());
  }

  // 没指定工程的 MCP 调用落到最近操作的那个窗口上：拿到焦点就告诉后端一声。
  window.addEventListener('focus', () => vscode.postMessage({ type: 'windowFocus' }));

  if (document.body.classList.contains('no-workspace')) {
    applyWorkspaces({ currentId: null, items: [], recents: [] });
  }
}

function syncComposerLock(): void {
  const on = hasWorkspace();
  el.input.disabled = !on;
  el.sendBtn.disabled = !on || store.busy;
  el.atBtn.disabled = !on || store.busy;
  el.selBtn.disabled = !on || store.busy;
  el.cmdBtn.disabled = !on || store.busy;
  el.modelSelect.disabled = !on;
  el.thinkSelect.disabled = !on;
  el.targetSelect.disabled = !on;
  el.newSessionBtn.disabled = !on || store.busy;
  el.renamePlotBtn.disabled = !on || store.busy;
  el.nextStepBtn.disabled = !on || store.busy;
}

/**
 * 标题栏写两份，CSS 按宽度挑一份露出来（`menubar.css` / `narrow.css`）：宽屏地方够，写工程的完整目录
 * （`.wb-title-full`）；窄屏（手机竖屏只剩一百来像素）写书名——工程文件夹的名字（`.wb-title-short`），整条路径在那儿
 * 只露得出 `/storage/emulated/0/Docu…` 这样谁也认不出的开头。浏览器标签页窄，只写名字。完整目录总在悬停提示上。
 */
function updateTitle(item?: WorkspaceItem): void {
  const current = item ?? (store.currentId ? { id: store.currentId, root: store.currentId, name: nameOf(store.currentId) } : undefined);
  const titleText = document.getElementById('wbTitleText');
  let title = 'Novel Forge';
  let barText = title;
  let shortText = title;
  if (current) {
    title = fileName ? `${fileName} - ${current.name} - Novel Forge` : `${current.name} - Novel Forge`;
    barText = fileName ? `${fileName} - ${current.root} - Novel Forge` : `${current.root} - Novel Forge`;
    shortText = current.name;
  }
  if (titleText) {
    titleText.replaceChildren(mk('span', 'wb-title-full', barText), mk('span', 'wb-title-short', shortText));
    titleText.title = current?.root ?? '';
  }
  document.title = title;
}

function renderRecents(): void {
  const list = document.getElementById('nfRecentList');
  if (!list) {
    return;
  }
  list.innerHTML = '';
  if (store.recents.length === 0) {
    list.appendChild(mk('li', 'nf-recent-empty', '没有最近打开的工程'));
    return;
  }
  for (const rec of store.recents) {
    const li = mk('li');
    const btn = mk('button');
    btn.type = 'button';
    btn.appendChild(mk('span', undefined, rec.name));
    btn.appendChild(mk('span', 'nf-recent-path', rec.root));
    btn.addEventListener('click', () => openRecent(rec.root));
    li.appendChild(btn);
    list.appendChild(li);
  }
}

function ensureSideEmptyHints(): void {
  for (const id of SIDE_PANES) {
    const pane = document.getElementById(id);
    if (!pane || pane.querySelector('.ws-empty')) {
      continue;
    }
    // 遮罩上也给一颗「打开文件夹…」（W12）：侧栏的每一页都看得见下一步，不必先找到欢迎页。
    const box = mk('div', 'ws-empty');
    const inner = mk('div', 'ws-empty-inner');
    inner.appendChild(mk('p', undefined, EMPTY_HINT));
    const btn = mk('button', 'chip-btn', '打开文件夹…');
    btn.dataset.welcome = 'openFolder';
    btn.addEventListener('click', () => requestOpenFolder());
    inner.appendChild(btn);
    box.appendChild(inner);
    pane.appendChild(box);
  }
}

function buildAbout(): HTMLElement {
  const wrap = mk('div', 'nf-about');
  const card = mk('div', 'nf-about-card');
  card.appendChild(mk('h2', undefined, 'Novel Forge'));
  card.appendChild(mk('p', 'nf-about-ver', '版本'));
  card.appendChild(mk('p', 'nf-about-path'));
  const close = mk('button', 'primary', '关闭');
  close.type = 'button';
  close.addEventListener('click', () => wrap.classList.remove('open'));
  card.appendChild(close);
  wrap.appendChild(card);
  return wrap;
}

function fileNameOf(path: string | null): string | null {
  if (!path) {
    return null;
  }
  const parts = path.split('/');
  return parts[parts.length - 1] || path;
}

function nameOf(root: string): string {
  const parts = root.replace(/\\/g, '/').split('/');
  return parts[parts.length - 1] || root;
}
