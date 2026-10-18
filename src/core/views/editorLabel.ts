/**
 * 内置编辑器怎么称呼一份文件：标签上的类型短标记与名字、工具栏上的面包屑。
 *
 * **纯函数、零 I/O、绝不抛**——每次 `editorOpen` / `editorSaved` / `editorDiskChanged` 都要带一份，
 * 输入是前端传上来的路径。种类来自 `workspace/kind.ts` 的 `kindOfPath`（与网关同一张表），章号与标题
 * 来自章节 / 细纲的文件名规则（`model/chapterFile.ts` / `model/plotFile.ts`）——与 `kind`、`draftPath`
 * 同一条原则：这些规则只在后端，前端不拿路径猜。
 *
 * 标题取**文件名**里的那一段，不读 H1：读盘要花一趟，而标签上要的只是「这是哪一份」。
 *
 * | 种类 | 短标记 | 标签上的名字 | 面包屑 |
 * |---|---|---|---|
 * | 正文 `chapters/第一卷/003-夜访.md` | （不带） | 003-夜访 | 正文 › 第一卷 › 第 3 章 夜访 |
 * | 细纲 `.novelforge/summaries/第一卷/003-夜访.md` | 细纲 | 003-夜访 | 细纲 › 第一卷 › 第 3 章 夜访 |
 * | 草稿 `drafts/003-夜访.md` | 草稿 | 003-夜访 | 草稿 › 第 3 章 夜访 |
 * | 角色 / 设定 | 角色 / 设定 | 林晚 | 角色 › 配角 › 林晚 |
 * | 架构三件、情节大纲 | （不带） | 小说配置 / 情节大纲 | 故事架构 › 小说配置 |
 * | 文风、全书摘要、叙事线 | （不带） | 文风 / 全书摘要 / 叙事线 | 文风与摘要 › 文风 |
 * | 写作技能 | 技能 | 技能目录名 | 技能 › 名字 |
 * | 其他 | （不带） | 原文件名（扩展名留着） | 按目录一段一段 |
 */
import * as path from 'node:path';
import { NovelProject } from '../model/project';
import { SETTING_DOC_LABEL } from '../model/pipeline';
import { parseChapterFileName } from '../model/chapterFile';
import { parsePlotFileName } from '../model/plotFile';
import { kindOfPath } from '../workspace/kind';
import type { EditorCrumb, EditorFileLabel } from '../protocol';

/** 区根那一段怎么叫。 */
const AREA_LABEL = {
  chapter: '正文',
  plot: '细纲',
  draft: '草稿',
  character: '角色',
  lore: '设定',
  skill: '技能',
} as const;

/** 有中文称呼的固定文件归在哪一组（与工程页的分组同一个说法）。 */
const ARCHITECTURE = '故事架构';
const STYLE_GROUP = '文风与摘要';

export function describeEditorFile(project: NovelProject, relPath: string): EditorFileLabel {
  const info = kindOfPath(project, relPath);
  const rel = info.rel ?? normalizeSlashes(relPath);
  const base = path.posix.basename(rel);

  switch (info.kind) {
    case 'chapter':
      return inArea(project.relPath(project.chaptersDir), rel, '', AREA_LABEL.chapter, chapterLeaf(base));
    case 'plot':
      return inArea(project.relPath(project.plotsDir), rel, AREA_LABEL.plot, AREA_LABEL.plot, plotLeaf(base));
    case 'draft':
      // 草稿镜像正文的路径：文件名像章节的照样写「第 N 章 标题」。
      return inArea(project.relPath(project.draftsDir), rel, AREA_LABEL.draft, AREA_LABEL.draft, chapterLeaf(base));
    case 'character':
      return inArea(project.relPath(project.charactersDir), rel, AREA_LABEL.character, AREA_LABEL.character, plainLeaf(base));
    case 'lore':
      return inArea(project.relPath(project.loreDir), rel, AREA_LABEL.lore, AREA_LABEL.lore, plainLeaf(base));
    case 'setting':
      return fixed(rel, ARCHITECTURE, info.doc ? SETTING_DOC_LABEL[info.doc] : stem(base));
    case 'outline':
      return fixed(rel, ARCHITECTURE, '情节大纲');
    case 'style':
      return fixed(rel, STYLE_GROUP, '文风');
    case 'globalSummary':
      return fixed(rel, STYLE_GROUP, '全书摘要');
    case 'threads':
      return fixed(rel, STYLE_GROUP, '叙事线');
    case 'skill':
      return skillLabel(project, rel, base);
    default:
      return otherLabel(rel, base);
  }
}

/** 在某个区里的文件：区根一段（可点）、中间各级目录（可点）、最后是这份文件。 */
function inArea(
  root: string,
  rel: string,
  tag: string,
  areaLabel: string,
  leaf: { title: string; crumb: string }
): EditorFileLabel {
  const under = root && rel.startsWith(`${root}/`) ? rel.slice(root.length + 1) : rel;
  const dirs = under.split('/').slice(0, -1);
  const crumbs: EditorCrumb[] = [{ label: areaLabel, dir: root }];
  let cur = root;
  for (const dir of dirs) {
    cur = cur ? `${cur}/${dir}` : dir;
    crumbs.push({ label: dir, dir: cur });
  }
  crumbs.push({ label: leaf.crumb });
  return { tag, title: leaf.title, crumbs };
}

/** 固定的单文件：组名一段（点了定位到它所在的目录）+ 中文称呼。 */
function fixed(rel: string, group: string, title: string): EditorFileLabel {
  return { tag: '', title, crumbs: [{ label: group, dir: parentOf(rel) }, { label: title }] };
}

function skillLabel(project: NovelProject, rel: string, base: string): EditorFileLabel {
  const root = project.relPath(project.skillsDir);
  if (!root || !rel.startsWith(`${root}/`)) {
    // 阶段绑定那一份（`.novelforge/skills.json`）。
    return { tag: AREA_LABEL.skill, title: '技能绑定', crumbs: [{ label: AREA_LABEL.skill, dir: root }, { label: '技能绑定' }] };
  }
  // `skills/<名字>/SKILL.md` 叫那个名字；技能目录里别的文件叫自己的文件名。
  const parts = rel.slice(root.length + 1).split('/');
  const title = parts.length === 2 && /^skill\.md$/i.test(parts[1]) ? parts[0] : stem(base);
  return inArea(root, rel, AREA_LABEL.skill, AREA_LABEL.skill, { title, crumb: title });
}

/** 认不出的文件：原文件名（扩展名留着——`project.json` 去掉扩展名就认不出了），目录一段一段。 */
function otherLabel(rel: string, base: string): EditorFileLabel {
  const parts = rel.split('/').filter(Boolean);
  const crumbs: EditorCrumb[] = [];
  let cur = '';
  for (const dir of parts.slice(0, -1)) {
    cur = cur ? `${cur}/${dir}` : dir;
    crumbs.push({ label: dir, dir: cur });
  }
  crumbs.push({ label: base || rel });
  return { tag: '', title: base || rel, crumbs };
}

/** 章节（与镜像它的草稿）：标签上是去掉扩展名的文件名，面包屑上是「第 N 章 标题」。 */
function chapterLeaf(base: string): { title: string; crumb: string } {
  const parsed = parseChapterFileName(base);
  return parsed ? { title: stem(base), crumb: chapterCrumb(parsed.order, parsed.stem) } : plainLeaf(base);
}

function plotLeaf(base: string): { title: string; crumb: string } {
  const parsed = parsePlotFileName(base);
  return parsed ? { title: stem(base), crumb: chapterCrumb(parsed.no, parsed.stem) } : plainLeaf(base);
}

function plainLeaf(base: string): { title: string; crumb: string } {
  const title = stem(base);
  return { title, crumb: title };
}

/** 「第 3 章 夜访」；文件名里没有标题时就是「第 3 章」。 */
function chapterCrumb(no: number, title: string): string {
  const named = title.trim();
  return named ? `第 ${no} 章 ${named}` : `第 ${no} 章`;
}

/** 去掉扩展名。只有扩展名的（`.gitignore`）原样留着。 */
function stem(base: string): string {
  const ext = path.posix.extname(base);
  return ext && ext !== base ? base.slice(0, -ext.length) : base;
}

function parentOf(rel: string): string {
  const i = rel.lastIndexOf('/');
  return i === -1 ? '' : rel.slice(0, i);
}

function normalizeSlashes(rel: string): string {
  return (rel ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
}
