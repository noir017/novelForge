/**
 * 关标签：有未保存的修改时问「保存 / 不保存 / 取消」（页内对话框，`dialog.ts`）。
 *
 * - 一份：「保存」（主按钮）/「不保存」/「取消」。
 * - 几份一起关（关闭其它 / 左侧 / 右侧）而其中好几份没保存：**合成一个对话框问一次**，列出是哪几份——
 *   「全部保存」/「全部不保存」/「取消」。没改过的那几份不问，跟着一起关。
 * - 「保存」**等这一份的回执**（`editorSaved`）回来才关；撞上冲突、磁盘上没了、出错就**不关**，冲突条留着。
 *   等回执的这段时间里又改了的也不关（关了那几笔就没了）。
 * - 磁盘上已经没有了的那一份（`OpenFile.gone`）在对话框里注明「保存会在原路径重建」：在这里点了保存就算答应过，
 *   不再另问。
 *
 * 只经 `Pane` 的公开方法碰编辑区（`files` / `discard`），保存经 `saving.ts`。
 */
import { askDialog } from './dialog';
import type { OpenFile } from './paneElements';
import { requestSave } from './saving';
import type { Pane } from './store';

/** 同一块编辑区同一时刻只问一次：连按两下 Ctrl+W 不叠两个对话框。 */
const asking = new WeakSet<Pane>();

const isDirty = (file: OpenFile): boolean => file.draft !== file.text;

/**
 * 关这几份（`paths` 里不在这块的跳过）。全都关掉了回 true；作者点了取消、或有几份没存成留着，回 false。
 */
export async function requestClose(pane: Pane, paths: string[]): Promise<boolean> {
  if (asking.has(pane)) {
    return false;
  }
  const dirty = paths.filter((p) => {
    const file = pane.files.get(p);
    return !!file && isDirty(file);
  });
  if (dirty.length === 0) {
    pane.discard(paths);
    return true;
  }

  asking.add(pane);
  let choice: 'save' | 'discard' | 'cancel';
  try {
    choice = await askDialog(closeDialog(dirty.map((p) => pane.files.get(p)!)));
  } finally {
    asking.delete(pane);
  }
  if (choice === 'cancel') {
    return false;
  }
  if (choice === 'discard') {
    pane.discard(paths);
    return true;
  }

  // 对话框开着的时候情况可能变了（核对磁盘把一份换成了新版、另一块把它搬走了）：按现在的样子再看一遍。
  const toSave = paths.filter((p) => {
    const file = pane.files.get(p);
    return !!file && isDirty(file);
  });
  const outcomes = await Promise.all(
    toSave.map((p) => requestSave(pane, p, { recreate: !!pane.files.get(p)?.gone }))
  );
  const keep = new Set(
    toSave.filter((p, i) => {
      const file = pane.files.get(p);
      // 没存成（冲突、磁盘上没了、出错、取消），或者等回执的工夫里又改了：留着。
      return (outcomes[i] !== 'saved' && outcomes[i] !== 'skipped') || (!!file && isDirty(file));
    })
  );
  pane.discard(paths.filter((p) => !keep.has(p)));
  return keep.size === 0;
}

function closeDialog(files: OpenFile[]) {
  const goneNote = '磁盘上已经没有这个文件，保存会在原路径重新建一份';
  if (files.length === 1) {
    const [file] = files;
    return {
      title: '关闭之前要保存吗？',
      message: `「${file.name}」有未保存的修改。`,
      detail: file.gone ? `${goneNote}。` : undefined,
      buttons: [
        { value: 'cancel' as const, label: '取消' },
        { value: 'discard' as const, label: '不保存' },
        { value: 'save' as const, label: '保存', primary: true },
      ],
      cancel: 'cancel' as const,
    };
  }
  return {
    title: '关闭之前要保存吗？',
    message: `这 ${files.length} 份有未保存的修改：`,
    items: files.map((f) => ({ label: f.name, title: f.path, note: f.gone ? `（${goneNote}）` : undefined })),
    buttons: [
      { value: 'cancel' as const, label: '取消' },
      { value: 'discard' as const, label: '全部不保存' },
      { value: 'save' as const, label: '全部保存', primary: true },
    ],
    cancel: 'cancel' as const,
  };
}
