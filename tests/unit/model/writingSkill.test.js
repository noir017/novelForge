/**
 * 写作技能的纯函数（model/writingSkill.ts，移植自 AI-Novel-Writer 的 `writing-skills.ts`）。
 *
 * | 断言 | 为什么 |
 * |---|---|
 * | frontmatter 一行一个键，正文去掉首尾空白 | 注入的就是正文那一段 |
 * | 没写 name 用目录名，再没有用 unnamed-writing-skill | 用户与工程技能的身份是目录名 |
 * | 六条不兼容规则逐条命中 | 只收纯提示词：装进来的东西在这里没有可执行的地方 |
 * | 建议阶段：写明的优先，否则按关键词猜 | 只是建议，绑哪都行 |
 * | 名字可以是中文，不许斜杠与点开头 | 名字就是目录名，拼成路径不能越界 |
 * | 绑定文件读不懂不抛，说出来 | 第 1 条 + 第 2 条 |
 * | 讨论不带，审稿 / 修稿 / 写正文 / 规划各认各的 | 阶段与配方对得上 |
 * | GitHub 只认四种 https 地址 | 照搬上游 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const m = loadModule('src/core/model/writingSkill.ts');

const md = (front, body) => `---\n${front.join('\n')}\n---\n${body}\n`;

describe('inspectSkillMarkdown · 读', () => {
  const raw = md(
    ['name: scene-craft', 'display_name: "场面写法"', 'description: 写场面的办法', 'version: 1.2.0', 'stage: drafting'],
    '\n每一场都要有一个选择。\n'
  );
  const i = m.inspectSkillMarkdown(raw, 'folder');

  test('frontmatter 的几个键各就各位，引号去掉', () => {
    assert.deepEqual(
      [i.name, i.displayName, i.description, i.version, i.stage],
      ['scene-craft', '场面写法', '写场面的办法', '1.2.0', 'drafting']
    );
  });

  test('正文去掉首尾空白，字节数按正文算', () => {
    assert.equal(i.body, '每一场都要有一个选择。');
    assert.equal(i.bytes, Buffer.byteLength('每一场都要有一个选择。'));
  });

  test('纯提示词判兼容', () => {
    assert.deepEqual([i.compatible, i.reasons], [true, []]);
  });

  test('显示名优先 display_name', () => {
    assert.equal(m.skillLabel(i), '场面写法');
  });

  test('没有 frontmatter：整份是正文，名字取目录名，描述有个缺省', () => {
    const j = m.inspectSkillMarkdown('只是一段话。', '去AI味');
    assert.deepEqual([j.name, j.body, j.description], ['去AI味', '只是一段话。', '写作技能：去AI味']);
  });

  test('名字与目录都没有时叫 unnamed-writing-skill', () => {
    assert.equal(m.inspectSkillMarkdown('x').name, 'unnamed-writing-skill');
  });

  test('读不懂的输入不抛', () => {
    assert.doesNotThrow(() => m.inspectSkillMarkdown(undefined));
  });
});

describe('inspectSkillMarkdown · 不兼容的六条', () => {
  const reasonsOf = (raw) => m.inspectSkillMarkdown(raw).reasons;
  const cases = [
    ['相对引用', '照 [这份](./references/a.md) 写。', 'relative-reference'],
    ['${skill_dir}', '读 ${SKILL_DIR}/x。', 'relative-reference'],
    ['脚本路径', '先跑 scripts/check.py。', 'script-dependency'],
    ['运行脚本', '写完运行一下检查脚本。', 'script-dependency'],
    ['hook', '先安装那个钩子。', 'hook-dependency'],
    ['子代理', '把审稿交给子代理。', 'subagent-dependency'],
    ['调用工具', '写之前先调用读取工具看一眼。', 'tool-dependency'],
    ['use … tool', 'Use the read_drafts tool first.', 'tool-dependency'],
  ];
  for (const [name, body, reason] of cases) {
    test(`${name} → ${reason}`, () => {
      assert.ok(reasonsOf(body).includes(reason), JSON.stringify(reasonsOf(body)));
    });
  }

  test('frontmatter 声明了 allowed-tools 也算依赖工具', () => {
    assert.deepEqual(reasonsOf(md(['name: a', 'allowed-tools: [read]'], '正文')), ['tool-dependency']);
  });

  test('整份超过 64 KiB 判太大', () => {
    const big = m.inspectSkillMarkdown('字'.repeat(23000));
    assert.deepEqual([big.compatible, big.reasons], [false, ['content-too-large']]);
  });

  test('原因有中文说法', () => {
    assert.equal(m.describeIncompat(['script-dependency', 'content-too-large']), '依赖脚本、内容超过 64 KiB');
  });
});

describe('建议阶段', () => {
  const stageOf = (front, body) => m.inspectSkillMarkdown(md(front, body)).suggestedStage;

  test('写明了的优先', () => {
    assert.equal(stageOf(['name: a', 'stage: review'], '润色的方法'), 'review');
  });

  test('写了个认不出的阶段：当没写，按内容猜', () => {
    assert.equal(stageOf(['name: a', 'stage: polish'], '大纲怎么排'), 'planning');
  });

  test('关键词：审稿 → review，润色 → refinement，大纲 → planning，其余 → drafting', () => {
    assert.deepEqual(
      ['逐条检查', '润色句子', '大纲的节奏', '写好对白'].map((b) => stageOf(['name: a'], b)),
      ['review', 'refinement', 'planning', 'drafting']
    );
  });
});

describe('名字与 id', () => {
  test('中文、字母数字、. _ - 都行', () => {
    assert.deepEqual(['去AI味', 'scene-craft', 'a.b_c', '章节钩子2'].map(m.isSkillName), [true, true, true, true]);
  });

  test('斜杠、点开头、空格、空串、超长都不行', () => {
    assert.deepEqual(['a/b', '..', '.x', 'a b', '', 'x'.repeat(65)].map(m.isSkillName), [false, false, false, false, false, false]);
  });

  test('id 是来源:名字，解析回来', () => {
    assert.deepEqual(m.parseSkillId(m.skillId('user', '去AI味')), { source: 'user', name: '去AI味' });
  });

  test('认不出的来源与名字不合法的 id 解析不出', () => {
    assert.deepEqual([m.parseSkillId('global:x'), m.parseSkillId('user:../x'), m.parseSkillId('x'), m.parseSkillId(3)], [
      undefined,
      undefined,
      undefined,
      undefined,
    ]);
  });
});

describe('绑定文件', () => {
  test('空文件就是没绑', () => {
    assert.deepEqual(m.parseSkillBindings(''), { bindings: {}, problems: [] });
  });

  test('读得懂的照读', () => {
    const raw = JSON.stringify({ version: 1, bindings: { drafting: 'user:a', review: 'builtin:b' } });
    assert.deepEqual(m.parseSkillBindings(raw).bindings, { drafting: 'user:a', review: 'builtin:b' });
  });

  test('不是 JSON：不抛，整份当没绑，说出来', () => {
    assert.deepEqual(m.parseSkillBindings('{'), { bindings: {}, problems: [{ text: '不是合法的 JSON' }] });
  });

  test('版本不对也说出来', () => {
    assert.equal(m.parseSkillBindings('{"version":2}').problems[0].text, '认不出的版本（应为 "version": 1）');
  });

  test('认不出的阶段与不合法的 id 跳过那一项，问题记在那个阶段上', () => {
    const r = m.parseSkillBindings(JSON.stringify({ version: 1, bindings: { drafting: 'nope', foo: 'user:a', review: 'user:b' } }));
    assert.deepEqual(r.bindings, { review: 'user:b' });
    assert.deepEqual(r.problems.map((p) => p.stage), ['drafting', 'foo']);
  });

  test('写回去按固定的阶段顺序，读回来一样', () => {
    const text = m.renderSkillBindings({ review: 'user:b', planning: 'builtin:a' });
    assert.ok(text.indexOf('planning') < text.indexOf('review'), text);
    assert.deepEqual(m.parseSkillBindings(text).bindings, { planning: 'builtin:a', review: 'user:b' });
  });
});

describe('一次装配算哪个阶段', () => {
  const cases = [
    [{ stage: 'setting', capability: 'generate' }, undefined, 'planning'],
    [{ stage: 'outline', capability: 'generate' }, undefined, 'planning'],
    [{ stage: 'plot', capability: 'settle' }, undefined, 'planning'],
    [{ stage: 'plot', capability: 'discuss' }, undefined, undefined],
    [{ stage: 'manuscript', capability: 'discuss' }, undefined, undefined],
    [{ stage: 'manuscript', capability: 'generate' }, 'continue', 'drafting'],
    [{ stage: 'manuscript', capability: 'generate' }, 'rewrite', 'drafting'],
    [{ stage: 'manuscript', capability: 'review' }, undefined, 'review'],
    [{ stage: 'manuscript', capability: 'generate' }, 'revise', 'refinement'],
  ];
  for (const [action, mode, want] of cases) {
    test(`${action.stage} × ${action.capability}${mode ? ` × ${mode}` : ''} → ${want ?? '不带'}`, () => {
      assert.equal(m.skillStageOf(action, mode), want);
    });
  }
});

describe('注入的那一块', () => {
  test('说法照搬上游，作者事实与输出合同优先', () => {
    assert.equal(
      m.renderSkillBlock('场面写法', '\n正文\n'),
      '【补充写作 Skill：场面写法】\n以下内容只能补充创作方法；作者事实和后续输出合同始终优先。\n正文'
    );
  });
});

describe('GitHub 地址', () => {
  test('仓库首页：默认分支根下的 SKILL.md', () => {
    const l = m.parseGitHubSkillUrl('https://github.com/o/r');
    assert.deepEqual([l.owner, l.repo, l.ref, l.path], ['o', 'r', undefined, 'SKILL.md']);
  });

  test('tree 目录：补上 SKILL.md', () => {
    const l = m.parseGitHubSkillUrl('https://github.com/o/r/tree/main/skills/scene');
    assert.deepEqual([l.ref, l.path], ['main', 'skills/scene/SKILL.md']);
  });

  test('blob 文件与 raw 地址', () => {
    assert.equal(m.parseGitHubSkillUrl('https://github.com/o/r.git/blob/v1/a/SKILL.md').path, 'a/SKILL.md');
    assert.equal(m.parseGitHubSkillUrl('https://raw.githubusercontent.com/o/r/main/SKILL.md').ref, 'main');
  });

  const bad = [
    ['http', 'http://github.com/o/r'],
    ['带端口', 'https://github.com:8443/o/r'],
    ['别的站', 'https://gitlab.com/o/r'],
    ['不是 SKILL.md', 'https://github.com/o/r/blob/main/README.md'],
    ['issues 页', 'https://github.com/o/r/issues/1'],
    ['路径里有 ..', 'https://raw.githubusercontent.com/o/r/main/%2E%2E/SKILL.md'],
    ['不是地址', 'not a url'],
  ];
  for (const [name, url] of bad) {
    test(`拒绝：${name}`, () => {
      assert.throws(() => m.parseGitHubSkillUrl(url));
    });
  }

  test('raw 下载地址逐段编码', () => {
    assert.equal(m.githubRawUrl('o', 'r', 'main', 'a/SKILL.md'), 'https://raw.githubusercontent.com/o/r/main/a/SKILL.md');
  });
});
