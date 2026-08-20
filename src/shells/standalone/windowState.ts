import * as fs from 'node:fs';
import * as path from 'node:path';
import { homeDir } from '../../core/stores';

const FILE = 'window.json';
const MAX_RECENTS = 20;

export interface WindowRecent {
  root: string;
  name: string;
  openedAt: number;
}

export interface WindowState {
  lastOpen: string | null;
  recents: WindowRecent[];
}

function empty(): WindowState {
  return { lastOpen: null, recents: [] };
}

function fileOf(baseDir?: string): string {
  return path.join(baseDir ?? homeDir(), FILE);
}

function asRecents(raw: unknown): WindowRecent[] {
  if (!Array.isArray(raw)) {
    return [];
  }
  const out: WindowRecent[] = [];
  for (const item of raw) {
    if (!item || typeof item !== 'object') {
      continue;
    }
    const rec = item as Record<string, unknown>;
    if (typeof rec.root !== 'string' || rec.root.length === 0) {
      continue;
    }
    out.push({
      root: rec.root,
      name: typeof rec.name === 'string' && rec.name ? rec.name : path.basename(rec.root) || rec.root,
      openedAt: typeof rec.openedAt === 'number' ? rec.openedAt : 0,
    });
  }
  return out.slice(0, MAX_RECENTS);
}

/** 读窗口记忆。缺文件或坏 JSON 都当成空，不抛。 */
export function readWindowState(baseDir?: string): WindowState {
  try {
    const raw = JSON.parse(fs.readFileSync(fileOf(baseDir), 'utf8')) as Record<string, unknown>;
    const lastOpen = raw.lastOpen;
    return {
      lastOpen: typeof lastOpen === 'string' && lastOpen.length > 0 ? lastOpen : null,
      recents: asRecents(raw.recents),
    };
  } catch {
    return empty();
  }
}

export function writeWindowState(state: WindowState, baseDir?: string): void {
  const dir = baseDir ?? homeDir();
  fs.mkdirSync(dir, { recursive: true });
  const text = `${JSON.stringify(
    { lastOpen: state.lastOpen, recents: state.recents },
    null,
    2
  )}\n`;
  fs.writeFileSync(fileOf(baseDir), text, 'utf8');
}

/** 成功打开工程：记下 lastOpen，recents upsert，上限 20。 */
export function rememberOpen(root: string, baseDir?: string): WindowState {
  const resolved = path.resolve(root);
  const name = path.basename(resolved) || resolved;
  const state = readWindowState(baseDir);
  state.lastOpen = resolved;
  state.recents = [
    { root: resolved, name, openedAt: Date.now() },
    ...state.recents.filter((r) => r.root !== resolved),
  ].slice(0, MAX_RECENTS);
  writeWindowState(state, baseDir);
  return state;
}

/** 关闭文件夹：lastOpen 清空，recents 不动。 */
export function rememberClosed(baseDir?: string): WindowState {
  const state = readWindowState(baseDir);
  state.lastOpen = null;
  writeWindowState(state, baseDir);
  return state;
}
