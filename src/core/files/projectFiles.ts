import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import {
  carryDraft,
  carryPlan,
  carryScenes,
  carrySummary,
  isProtectedPath,
  normalizeRel,
  renameEntryInRoot,
  sectionOf,
} from './fileOps';
import { getHost } from '../host';
import { describeError, scoped } from '../runtime/logger';
import { exists } from '../model/fs';
import { NovelProject } from '../model/project';
import { FileOpResult } from '../protocol';

const log = scoped('文件页');

/**
 * 文件页（资源管理器）的类文件操作：工程根范围的重命名、移动、复制。
 *
 * 与 fileOps.ts 的分工：那边锁在章节/角色/设定三个区里，是工程页的产品
 * 承诺；这边面向整个工程根（含 `.novelforge/`），是文件页的磁盘视角。
 * 相同的约束仍然在：
 *
 * 1. **不出工程根**：`..` 逃逸与绝对路径一律拒绝。
 * 2. **不静默覆盖**：目标同名逐项拒绝，其余项继续。
 * 3. **固定目录不动**：chapters/、drafts/、.novelforge 及其关键子目录受保护。
 * 4. **垃圾箱不搬**：`.novelforge/.trash/` 里的内容不是操作对象。
 *
 * 章节联动：源在 chapters/ 下的移动带草稿跟随与 manifest 同步；
 * 章节被移出 chapters/ 时草稿留在原镜像路径，只记日志提醒。
 */

/** 工程根范围的重命名。逐项结果的形状与 move/copy 对齐。 */
export async function renameAny(project: NovelProject, relPath: string): Promise<FileOpResult> {
  const from = normalizeRel(relPath) ?? relPath;
  const to = await renameEntryInRoot(project, relPath);
  return to ? { from, to, ok: true } : { from, ok: false };
}

/** 粘贴（剪切变体）：把若干文件/目录移动到目标目录。 */
export async function moveInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, false);
}

/** 粘贴（复制变体）：把若干文件/目录递归复制到目标目录。 */
export async function copyInto(
  project: NovelProject,
  sources: string[],
  targetDir: string
): Promise<FileOpResult[]> {
  return pasteAll(project, sources, targetDir, true);
}

async function pasteAll(
  project: NovelProject,
  sources: string[],
  targetDir: string,
  copy: boolean
): Promise<FileOpResult[]> {
  // 空串落点 = 工程根目录；normalizeRel 不收空串，单独放行。
  const dest = targetDir.trim() === '' ? '' : normalizeRel(targetDir);
  if (dest === undefined) {
    log.warn(`粘贴被拒：目标目录不合法`, `原始输入 ${JSON.stringify(targetDir)}`);
    getHost().toast('目标目录不合法。', 'error');
    return sources.map((from) => ({ from, ok: false, error: '目标目录不合法' }));
  }
  const destAbs = dest === '' ? project.root : project.pathOf(dest);
  let destIsDir = false;
  try {
    destIsDir = (await fs.stat(destAbs)).isDirectory();
  } catch {
    destIsDir = false;
  }
  if (!destIsDir) {
    log.warn(`粘贴被拒：目标目录不存在 ${dest || '（工程根）'}`);
    getHost().toast(`目标目录不存在：${dest || '（工程根）'}`, 'error');
    return sources.map((from) => ({ from, ok: false, error: '目标目录不存在' }));
  }

  const results: FileOpResult[] = [];
  let chaptersTouched = false;
  for (const source of sources) {
    const r = await pasteOne(project, source, dest, copy);
    if (r.ok && sectionOf(project, r.from)?.section === 'chapters') {
      chaptersTouched = true;
    }
    results.push(r);
  }

  // 移动章节改了路径；复制进 chapters/ 的可能带来新章节。两种都重算 manifest。
  const chaptersRoot = project.relPath(project.chaptersDir);
  if (chaptersTouched || (copy && (dest === chaptersRoot || dest.startsWith(`${chaptersRoot}/`)))) {
    await project.syncManifest();
  }
  project.invalidate();

  const failed = results.filter((r) => !r.ok);
  if (failed.length > 0) {
    getHost().toast(`${failed.length} 项未${copy ? '复制' : '移动'}：${failed[0].error}`, 'error');
  } else {
    log.info(
      `${copy ? '已复制' : '已移动'} ${results.length} 项`,
      `落点 ${dest === '' ? '（工程根）' : dest}`
    );
    getHost().toast(`已${copy ? '复制' : '移动'} ${results.length} 项到 ${dest === '' ? '工程根目录' : dest}。`);
  }
  return results;
}

async function pasteOne(
  project: NovelProject,
  relPath: string,
  dest: string,
  copy: boolean
): Promise<FileOpResult> {
  const rel = normalizeRel(relPath);
  if (!rel) {
    log.warn(`粘贴被拒：路径不合法`, `原始输入 ${JSON.stringify(relPath)}`);
    return { from: relPath, ok: false, error: '路径不合法' };
  }
  if (isProtectedPath(project, rel)) {
    log.warn(`粘贴被拒：${rel} 是工程的固定目录`);
    return { from: rel, ok: false, error: `「${rel}」是固定目录` };
  }
  if (rel === '.novelforge/.trash' || rel.startsWith('.novelforge/.trash/')) {
    log.warn(`粘贴被拒：${rel} 在回收站里`);
    return { from: rel, ok: false, error: '回收站里的内容不能操作' };
  }

  const abs = project.pathOf(rel);
  let isDir: boolean;
  try {
    isDir = (await fs.stat(abs)).isDirectory();
  } catch {
    log.warn(`粘贴被拒：找不到 ${rel}`);
    return { from: rel, ok: false, error: `找不到 ${rel}` };
  }

  const name = path.basename(rel);
  const nextRel = dest === '' ? name : `${dest}/${name}`;
  if (nextRel === rel) {
    return { from: rel, ok: false, error: '已经在这个目录里' };
  }
  // 目录不能搬进自己的子孙——那会把子树从文件系统上摘下来。
  if (isDir && (dest === rel || dest.startsWith(`${rel}/`))) {
    log.warn(`粘贴被拒：不能把文件夹放进自己里面`, `${rel} → ${dest}`);
    return { from: rel, ok: false, error: '不能放进它自己里面' };
  }
  const nextAbs = project.pathOf(nextRel);
  if (await exists(nextAbs)) {
    log.warn(`粘贴被拒：目标已有同名项 ${nextRel}`);
    return { from: rel, ok: false, error: `目标已有同名项 ${nextRel}` };
  }

  try {
    if (copy) {
      await fs.cp(abs, nextAbs, { recursive: true });
    } else {
      await fs.rename(abs, nextAbs);
    }
  } catch (err) {
    log.warn(`粘贴失败：${rel} → ${nextRel}`, describeError(err));
    return { from: rel, ok: false, error: describeError(err) };
  }

  if (!copy && sectionOf(project, rel)?.section === 'chapters') {
    // 章节移动：草稿、摘要、细纲、场景一并跟随。
    // 移出 chapters/ 时新镜像路径推导不出，四样都留在原处，逐样说出来——
    // 不说的话作者会以为它们跟着走了，而界面上正好也看不出区别。
    const toDraft = project.draftRelPathFor(nextRel);
    if (toDraft) {
      await carryDraft(project, rel, nextRel, isDir);
      await carrySummary(project, rel, nextRel, isDir);
      await carryPlan(project, rel, nextRel, isDir);
      await carryScenes(project, rel, nextRel, isDir);
    } else {
      const strays: [string, string | undefined][] = [
        ['草稿', project.draftRelPathFor(rel)],
        ['摘要', project.summaryMirrorRelPath(rel, isDir)],
        ['细纲', project.planMirrorRelPath(rel, isDir)],
        ['场景', project.sceneMirrorRelPath(rel, isDir)],
      ];
      for (const [what, from] of strays) {
        if (from && (await exists(project.pathOf(from)))) {
          log.warn(`章节被移出 chapters/，${what}留在原处`, `${what}仍在 ${from}`);
        }
      }
    }
  }

  log.info(`${copy ? '已复制' : '已移动'}${isDir ? '文件夹' : ''}`, `${rel} → ${nextRel}`);
  return { from: rel, to: nextRel, ok: true };
}
