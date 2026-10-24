/**
 * 仓库里的预设写作技能（skills/writing/）：改编自 jarvis-write 的三类预设，加上本仓库自己写的几份。
 *
 * 它们不随应用发布，作者从 GitHub 一份一份装进「我的技能库」——装的时候过的就是
 * `inspectSkillMarkdown` 那几道关，所以这里拿同一个函数把每一份过一遍，免得哪天改了一份、
 * 作者装的时候才发现装不了。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | 每个目录一份 SKILL.md，兼容、name 就是目录名 | 安装按 frontmatter 的 name 落目录；名字对不上，README 里的名字就对不上装出来的那一份 |
 * | stage 写明，且跟前缀对得上 | 文风写正文、味道与骨架规划；自己写的照 OWN；不写就要靠关键词猜 |
 * | 改编的许可两行都在，许可原文在；自己写的不挂 jarvis-write 的出处 | Apache-2.0 要求保留出处、写明改过；不是改编的就别说是 |
 * | README 列全，没有多列 | README 就是安装入口，少一行等于没有这份 |
 * | 正文挨着中文的标点是全角 | 示范段会被模型照着学；原文是半角，转的时候改过，别再改回去 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT, loadModule } = require('../helpers/load');

const m = loadModule('src/core/model/writingSkill.ts');

const DIR = path.join(ROOT, 'skills', 'writing');
const STAGE_OF_PREFIX = { style: 'drafting', taste: 'planning', pattern: 'planning' };
/** 本仓库自己写的（不是改编的）：名字 → 绑哪个阶段 */
const OWN = { 'tension-logic-humanizer': 'drafting' };

const names = fs
  .readdirSync(DIR, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .sort();
const adapted = names.filter((n) => !(n in OWN));
const raw = (name) => fs.readFileSync(path.join(DIR, name, 'SKILL.md'), 'utf8');

describe('预设写作技能（skills/writing/）', () => {
  test('文风 16、味道 8、骨架 8，另有自己写的', () => {
    const count = (prefix) => adapted.filter((n) => n.startsWith(`${prefix}-`)).length;
    assert.deepEqual([count('style'), count('taste'), count('pattern'), adapted.length], [16, 8, 8, 32]);
    assert.deepEqual(names.filter((n) => n in OWN), Object.keys(OWN).sort());
  });

  test('每一份都兼容，name 就是目录名，stage 跟前缀对得上', () => {
    for (const name of names) {
      const i = m.inspectSkillMarkdown(raw(name), name);
      assert.ok(m.isSkillName(name), name);
      assert.equal(i.compatible, true, `${name}：${m.describeIncompat(i.reasons)}`);
      assert.equal(i.name, name);
      assert.equal(i.stage, OWN[name] ?? STAGE_OF_PREFIX[name.split('-')[0]], name);
      assert.ok(i.displayName && i.description && i.version, name);
    }
  });

  test('改编的每一份都写着许可与出处，许可原文在；自己写的不挂出处', () => {
    for (const name of adapted) {
      const text = raw(name);
      assert.match(text, /^license: Apache-2\.0$/m, name);
      assert.match(text, /^origin: 改编自 jarvis-write/m, name);
    }
    for (const name of Object.keys(OWN)) assert.doesNotMatch(raw(name), /jarvis-write/, name);
    assert.match(fs.readFileSync(path.join(DIR, 'LICENSE-jarvis-write'), 'utf8'), /Apache License\s+Version 2\.0/);
  });

  test('README 列全，没有多列', () => {
    const readme = fs.readFileSync(path.join(DIR, 'README.md'), 'utf8');
    const listed = [...readme.matchAll(/tree\/main\/skills\/writing\/([^)\s]+)\)/g)].map((x) => x[1]).sort();
    assert.deepEqual(listed, names);
  });

  test('正文里挨着中文的标点是全角', () => {
    const halfWidth = /[一-鿿「」][,?!:;()]|[,?!:;()][一-鿿「」]/;
    for (const name of names) {
      const body = m.inspectSkillMarkdown(raw(name), name).body;
      const line = body.split('\n').find((l) => halfWidth.test(l));
      assert.equal(line, undefined, `${name}：${line}`);
    }
  });
});
