/**
 * 内置技能的三条契约。
 *
 * 这一组守的是**「生成物不入库」这个决定的代价**。`src/core/skills/builtin.ts`
 * 由 `scripts/build-skills.js` 从 `src/skills/**\/SKILL.md` 烘出来、不进仓库，
 * 于是有两种翻车方式在别处都不会红：
 *
 * 1. **烘的过程本身失真**——转义写错吃掉了正文里的反引号、编码坏了、漏了一个
 *    技能。跑起来的方法论与磁盘上写的那份不是同一份，而两边都「看着正常」。
 * 2. **给内置技能加了 `references/`** → 那个链接在产品里永远点不开
 *    （`read` 走 `guardRead`，只认工程根之内的路径，而内置技能不在工程里，
 *    甚至不在磁盘上）。
 *
 * 第三条是名字：索引只列名字，所以名字**必须自带触发力**——这一条判不了好坏，
 * 但判得了「是不是个占位名」。
 *
 * 「改了 `SKILL.md` 忘了重新生成」**不在这份清单里**：`tests/helpers/load.js`
 * 在 require 时就会烘一遍，各条构建路径的前置也都带着它——那种状态跑不出来。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../helpers/load');

const SRC_DIR = path.join(ROOT, 'src', 'skills');
const ENTRY = 'SKILL.md';

/** 磁盘上的那一份：目录名 → { body, description }。 */
function onDisk() {
  const out = {};
  if (!fs.existsSync(SRC_DIR)) {
    return out;
  }
  for (const e of fs.readdirSync(SRC_DIR, { withFileTypes: true })) {
    if (!e.isDirectory()) continue;
    const entry = path.join(SRC_DIR, e.name, ENTRY);
    if (fs.existsSync(entry)) {
      const body = fs.readFileSync(entry, 'utf8');
      out[e.name] = { body, description: descriptionOf(body) };
    }
  }
  return out;
}

/**
 * frontmatter 里那一行描述。**这里刻意重写一遍**，不 import 生成器里那个
 * ——两份实现互相对账才叫契约；用同一个函数算两边，恒等式永远成立，测不出
 * 「烘的时候把描述抠错了」。
 */
function descriptionOf(text) {
  const fence = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(text);
  if (!fence) return '';
  const line = /^description\s*:\s*(.*)$/m.exec(fence[1]);
  if (!line) return '';
  const raw = line[1].trim();
  const quoted =
    raw.length >= 2 &&
    ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'")));
  return (quoted ? raw.slice(1, -1) : raw).trim();
}

// helpers/load.js 已经在 require 时保证生成过一次，所以这里读到的常量一定在。
const { BUILTIN_SKILLS } = loadModule('src/core/skills/builtin.ts');
const disk = onDisk();

describe('常量与磁盘一致', () => {
  test('至少有一个内置技能（防止空跑通过）', () => {
    assert.ok(Object.keys(disk).length > 0, SRC_DIR);
  });

  // 烘的时候漏了一个（目录名判断写歪、读盘失败被吞）在这里红。
  test('名单一致', () => {
    assert.deepEqual(Object.keys(BUILTIN_SKILLS).sort(), Object.keys(disk).sort());
  });

  test('每一份正文逐字一致', () => {
    for (const [name, skill] of Object.entries(disk)) {
      assert.equal(
        BUILTIN_SKILLS[name].body,
        skill.body,
        `${name}/${ENTRY} 烘出来的与磁盘上的不是同一份`
      );
    }
  });

  // 「完整」这一档每轮都要把这一行发给模型，抠错了它会拿着一句错的描述判断
  // 「这一轮该不该用它」。
  test('描述与磁盘上那一行一致', () => {
    for (const [name, skill] of Object.entries(disk)) {
      assert.equal(BUILTIN_SKILLS[name].description, skill.description, `${name} 的描述抠错了`);
    }
  });

  // 内置技能是我们写的，描述必须写——「完整」档没有它就退化成只有名字，
  // 而作者在设置页里挑档位时也看不出这一份是干什么的。
  test('每一份都写了描述', () => {
    const missing = Object.entries(disk)
      .filter(([, skill]) => !skill.description.trim())
      .map(([name]) => name);
    assert.deepEqual(missing, [], '内置技能得在 frontmatter 里写一行 description');
  });
});

describe('内置技能必须自足', () => {
  // 附件靠 read 取，而内置技能不在工程里——链接会断。长内容压进正文，或者拆成两个技能。
  test('没有子目录（references/ 在内置这一半够不着）', () => {
    const bad = [];
    for (const name of Object.keys(disk)) {
      for (const child of fs.readdirSync(path.join(SRC_DIR, name), { withFileTypes: true })) {
        if (child.isDirectory()) bad.push(`${name}/${child.name}/`);
      }
    }
    assert.deepEqual(bad, [], '内置技能带了附件目录，产品里那些链接点不开');
  });

  // 相对链接指向 references/ 或者仓库源码，两种都是断的：前者不存在，
  // 后者（`../../core/context/prompts.ts`）产品内的 agent 根本够不着。
  test('正文里没有指向仓库路径的相对链接', () => {
    const bad = [];
    for (const [name, skill] of Object.entries(disk)) {
      for (const m of skill.body.matchAll(/\]\((\.[^)]*)\)/g)) {
        bad.push(`${name}: ${m[1]}`);
      }
    }
    assert.deepEqual(bad, [], '产品内的 agent 够不着仓库里的路径，这些链接是死的');
  });
});

describe('名字要自带触发力', () => {
  // 索引只列名字，模型全靠它判断「这一轮要不要读」。
  test('不是占位名', () => {
    const lazy = /^(skill|流程|工作流|test|demo|example|默认|通用)\d*$/i;
    const bad = Object.keys(disk).filter((n) => lazy.test(n));
    assert.deepEqual(bad, [], '这种名字模型看不出什么时候该用它');
  });

  test('目录名合法（会拼进 builtin: 前缀里给模型抄）', () => {
    const bad = Object.keys(disk).filter((n) => /[\s:/\\]/.test(n));
    assert.deepEqual(bad, [], '名字里有空白或分隔符，模型抄不准');
  });
});

describe('受众烘对了', () => {
  // 索引按受众分两段，`skill` 工具只认第一段。烘错一份，那一份要么被 agent
  // 读进整份正文（贵），要么永远没人带给 generate（等于没装）。
  test('每一份都带 audience，且是两个合法值之一', () => {
    const bad = Object.entries(BUILTIN_SKILLS)
      .filter(([, s]) => s.audience !== 'agent' && s.audience !== 'generate')
      .map(([n, s]) => `${n}: ${JSON.stringify(s.audience)}`);
    assert.deepEqual(bad, []);
  });

  test('与磁盘上那份 frontmatter 对得上', () => {
    const bad = [];
    for (const [name, skill] of Object.entries(disk)) {
      const fence = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(skill.body);
      const line = fence && /^audience\s*:\s*(.*)$/m.exec(fence[1]);
      const want = line && line[1].trim() === 'generate' ? 'generate' : 'agent';
      if (BUILTIN_SKILLS[name].audience !== want) {
        bad.push(`${name}: 烘成 ${BUILTIN_SKILLS[name].audience}，磁盘上是 ${want}`);
      }
    }
    assert.deepEqual(bad, []);
  });
});
