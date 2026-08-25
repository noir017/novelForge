/**
 * 把 `src/skills/**\/SKILL.md` 烘成 TS 常量，供 `core/skills/` 直接 import。
 *
 * ## 为什么不能运行时读盘
 *
 * 三个壳的资源路径各不相同，而其中一个根本没有「路径」这回事：
 *
 * - **VS Code 壳**：`.vscodeignore` 排除了 `src/**`，`.vsix` 里没有这些文件；
 * - **独立版**：`bun build --compile` 出的是单文件可执行，运行时没有 `src/skills/`；
 * - **桌面壳**：sidecar 就是上面那个单文件。
 *
 * 拷进 `dist/` 再读盘只解决前两个壳的一半，还要让 `core/` 知道自己装在哪
 * ——而「我装在哪」是平台知识，按分层约定属于壳，不属于 `core/`。
 *
 * 烘成常量三个壳全部白拿：`core/` 直接 import，esbuild 与 bun 各自把它打进
 * 产物，`.vscodeignore` 一行不改。与 `embed-media.js` 是同一件事、同一个理由。
 *
 * **代价**：改一份 `SKILL.md` 要重新生成才生效。内置技能是我们改的，改完本来
 * 就要重新构建。而正常路径上根本漏不掉：这个函数挂在 `esbuild.js`、`embed-media.js`
 * 与 `tests/helpers/load.js` 三处前置上，各条构建/测试路径都会跑到。
 * `tests/contract/skills.test.js` 另比对一遍磁盘与常量，防的是**烘的过程本身失真**
 * （转义写错吃掉了正文里的反引号那一类）。
 *
 * ## 目录名就是技能名；frontmatter 认 `description` 与 `audience`
 *
 * 一个技能 = 一个子目录 + 里面的 `SKILL.md`，**名字始终是目录名**（路径即身份）。
 *
 * `audience` 说这一份是写给谁读的（`agent` / `generate`，缺省 `agent`，见
 * `core/model/skillMode.ts`）。它必须解析：索引要按受众分成两段列，而 `generate`
 * 那一类的正文一个字都不进 agent 的上下文——不知道受众就分不出这一刀。
 *
 * `description` 这一行原本是不解析的——那时索引只列名字，它没有消费者，而留着
 * 一个没人读的字段只会慢慢跑偏。「完整」这一档（名字 + 一句描述都进每一轮）
 * 给了它消费者，所以现在解析它。**仍然只认这一个键**：`name` 由目录名决定，
 * 再从 frontmatter 读一遍就是给同一件事留两个真相。
 *
 * 只支持单行 `key: value`（可带引号）。写成 YAML 折行的话这里读到空串，
 * 那一档退化成只显示名字——不报错，因为描述缺席不是错误。
 *
 * **`body` 是文件原文**，frontmatter 一并留着：不剥掉，`tests/contract/skills.test.js`
 * 那条逐字比对才是真的逐字，而模型多读三行元数据没有代价。
 *
 * ## 内置技能不许有 references/
 *
 * 附件靠 `read` 取，而 `read` 走 `guardRead`，只认工程根之内的路径——内置技能
 * 不在工程里，链接会断。所以内置技能的 `SKILL.md` 必须自足：长内容压进正文，
 * 或者拆成两个技能。这里**直接拦**，不留给人去记。
 *
 * 用法：node scripts/build-skills.js
 *      require('./build-skills').buildSkills()   // 各构建/测试入口的前置
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const SRC_DIR = path.join(ROOT, 'src', 'skills');
const OUT = path.join(ROOT, 'src', 'core', 'skills', 'builtin.ts');

/** 入口文件名。与 `core/skills/` 那边的约定同一个字。 */
const ENTRY = 'SKILL.md';

/**
 * 从 frontmatter 里抠 `description`。**只认这一个键、只认单行。**
 *
 * 刻意不引入 yaml 解析：这里要的就是一行字，而 `core/model/markdown.ts` 那个
 * 轻量解析器住在 `src/core/` 里——构建脚本是 CommonJS、跑在 TS 编译之前，
 * import 不动它。两边都只支持 `key: value`，行为是一致的。
 *
 * 读不出来回空串：描述缺席不是错误，那一档退化成只显示名字。
 */
function readKey(text, key) {
  const fence = /^\ufeff?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fence) {
    return '';
  }
  const line = new RegExp(`^${key}\\s*:\\s*(.*)$`, 'm').exec(fence[1]);
  if (!line) {
    return '';
  }
  const raw = line[1].trim();
  const unquoted =
    raw.length >= 2 && ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")))
      ? raw.slice(1, -1)
      : raw;
  return unquoted.trim();
}

/**
 * 受众：`agent`（缺省）或 `generate`。**认不出的值一律当缺省**，不报错——
 * 拼错一个词不该让整次构建失败，而回落到「给 agent」是两者中较保守的那个
 * （它至少要 agent 明确去读才生效）。
 *
 * 与 `core/skills/index.ts` 那份是同一个规则的两处实现，理由同上：构建脚本是
 * CommonJS、跑在 TS 编译之前，import 不动 `src/core/`。
 */
function readAudience(text) {
  const raw = readKey(text, 'audience');
  return raw === 'generate' ? 'generate' : 'agent';
}

/**
 * 扫出全部内置技能。返回 `[名字, { body, description }]`，**按名字排序**——
 * 生成文件的内容不该随文件系统的返回顺序抖动，否则每次生成都是一份看着改过的
 * diff。
 */
function collect() {
  if (!fs.existsSync(SRC_DIR)) {
    return [];
  }
  const out = [];
  for (const dirent of fs.readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!dirent.isDirectory()) {
      continue;
    }
    const dir = path.join(SRC_DIR, dirent.name);
    const entry = path.join(dir, ENTRY);
    if (!fs.existsSync(entry)) {
      // 目录里没有 SKILL.md 就不是技能。静默跳过——`src/skills/` 下将来可能
      // 放别的东西，为它报错等于替不相干的目录立规矩。
      continue;
    }
    for (const child of fs.readdirSync(dir, { withFileTypes: true })) {
      if (child.isDirectory()) {
        throw new Error(
          `内置技能 ${dirent.name} 有子目录 ${child.name}/。` +
            '内置技能不在工程里，read 够不着它的附件，链接会断——' +
            '把长内容压进 SKILL.md，或者拆成两个技能。'
        );
      }
    }
    const body = fs.readFileSync(entry, 'utf8');
    out.push([
      dirent.name,
      { body, description: readKey(body, 'description'), audience: readAudience(body) },
    ]);
  }
  return out.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

/**
 * 生成那份常量。返回技能名清单。
 *
 * **内容没变就不碰文件**：这个函数挂在六条构建/测试路径的前置上，每次都重写
 * 会把 mtime 顶掉——而 `tests/helpers/load.js` 的磁盘 bundle 缓存正是按 mtime
 * 判失效的，白白让每一轮全量测试重 bundle 一遍 `src/core/`。
 */
function buildSkills({ quiet = false } = {}) {
  const skills = collect();

  const lines = [
    '// 由 scripts/build-skills.js 从 src/skills/**/SKILL.md 生成，勿手改。',
    '//',
    '// 改技能改那边的 Markdown，然后 `npm run skills`。',
    '// tests/contract/skills.test.js 会比对两边，烘失真了当场变红。',
    '',
    "import type { SkillAudience } from '../model/skillMode';",
    '',
    '/** 一份内置技能：正文原文、frontmatter 里那一行描述（可能是空串）与受众。 */',
    'export interface BuiltinSkill {',
    '  body: string;',
    '  description: string;',
    '  audience: SkillAudience;',
    '}',
    '',
    '/** 内置技能：目录名 → 那一份。 */',
    'export const BUILTIN_SKILLS: Record<string, BuiltinSkill> = {',
  ];
  for (const [name, skill] of skills) {
    lines.push(
      `  ${JSON.stringify(name)}: { body: ${JSON.stringify(skill.body)}, ` +
        `description: ${JSON.stringify(skill.description)}, ` +
        `audience: ${JSON.stringify(skill.audience)} },`
    );
  }
  lines.push('};');
  const next = lines.join('\n') + '\n';

  let current;
  try {
    current = fs.readFileSync(OUT, 'utf8');
  } catch {
    current = undefined;
  }
  if (current !== next) {
    fs.mkdirSync(path.dirname(OUT), { recursive: true });
    fs.writeFileSync(OUT, next, 'utf8');
  }

  if (!quiet) {
    console.log(
      `✓ ${current === next ? '已是最新' : '生成'} ${path.relative(ROOT, OUT)}（${
        skills.length
      } 个技能${skills.length > 0 ? `：${skills.map(([n]) => n).join(' / ')}` : ''}）`
    );
  }
  return skills.map(([name]) => name);
}

module.exports = { buildSkills, SRC_DIR, OUT, ENTRY };

if (require.main === module) {
  try {
    buildSkills();
  } catch (err) {
    console.error(`✘ ${err.message}`);
    process.exit(1);
  }
}
