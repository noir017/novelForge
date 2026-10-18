/**
 * 标签上的名字（纯函数，零 DOM）：类型短标记 + 名字，**仍然同名的再加最短的区分目录**（像 VS Code 那样）。
 *
 * 短标记与名字来自后端（`EditorFileView.label`，`views/editorLabel.ts`）——同一章的正文、细纲、草稿
 * 从前三个标签都写「003-夜访.md」，现在是「003-夜访」「细纲 003-夜访」「草稿 003-夜访」。还撞名的是
 * 同一种、不同目录的两份（两卷里各有一个「003-夜访」）：给每一份找它与其余几份**都不一样**的最短
 * 目录后缀（从紧挨着文件的那一级往上加），写在名字后面淡一点的那一格里。
 *
 * 两块编辑区里开着的文件放在一起比——「▾」列表里两块的文件排在一起，各写各的就分不清了。
 */
import type { EditorFileLabel } from '../protocol';

export interface TabNameSource {
  path: string;
  /** 文件名（后端没给称呼时的退路）。 */
  name: string;
  label?: EditorFileLabel;
}

export interface TabName {
  /** 类型短标记，正文不带（空串）。 */
  tag: string;
  title: string;
  /** 区分用的目录，不撞名时是空串。 */
  desc: string;
}

/** 每份文件在标签上怎么写。 */
export function tabNames(files: readonly TabNameSource[]): Map<string, TabName> {
  const out = new Map<string, TabName>();
  const groups = new Map<string, TabNameSource[]>();
  for (const f of files) {
    const tag = f.label?.tag ?? '';
    const title = f.label?.title ?? f.name;
    out.set(f.path, { tag, title, desc: '' });
    const key = `${tag}\u0000${title}`;
    groups.set(key, [...(groups.get(key) ?? []), f]);
  }
  for (const group of groups.values()) {
    if (group.length < 2) {
      continue;
    }
    for (const f of group) {
      out.get(f.path)!.desc = distinguish(f.path, group.filter((g) => g !== f).map((g) => g.path));
    }
  }
  return out;
}

/**
 * `path` 与 `others` 都不一样的最短目录后缀。目录完全一样（同一个目录里 `003-夜访.md` 与 `003-夜访.txt`）
 * 时退到文件名本身——那是唯一的区别。
 */
export function distinguish(path: string, others: readonly string[]): string {
  const dirs = dirsOf(path);
  const otherDirs = others.map(dirsOf);
  const most = Math.max(dirs.length, ...otherDirs.map((d) => d.length));
  for (let k = 1; k <= most; k++) {
    const mine = suffix(dirs, k);
    if (otherDirs.every((d) => suffix(d, k) !== mine)) {
      return dirs.length === 0 ? '工程根' : mine;
    }
  }
  return path.slice(path.lastIndexOf('/') + 1);
}

function dirsOf(path: string): string[] {
  return path.split('/').slice(0, -1);
}

function suffix(dirs: readonly string[], k: number): string {
  return dirs.slice(Math.max(0, dirs.length - k)).join('/');
}
