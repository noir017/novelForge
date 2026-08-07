/**
 * 离线冒烟测试：不启动 VS Code，直接验证纯逻辑部分在示例数据上的行为。
 * 用法：node scripts/smoke.js
 */
const fs = require('fs');
const path = require('path');
const esbuild = require('esbuild');
const Module = require('module');

const ROOT = path.join(__dirname, '..');
const SAMPLE = path.join(ROOT, 'sample-novel');

let failures = 0;
function check(name, cond, detail) {
  if (cond) {
    console.log(`  ✓ ${name}`);
  } else {
    failures++;
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`);
  }
}

/** 把一个不依赖 vscode 的模块 bundle 后 require 出来。 */
function loadModule(relPath) {
  const result = esbuild.buildSync({
    entryPoints: [path.join(ROOT, relPath)],
    bundle: true,
    format: 'cjs',
    platform: 'node',
    write: false,
    external: ['vscode'],
  });
  const code = result.outputFiles[0].text;
  const m = new Module(relPath, null);
  m._compile(code, path.join(ROOT, relPath));
  return m.exports;
}

console.log('\n== markdown.ts ==');
{
  const md = loadModule('src/core/model/markdown.ts');

  const raw = fs.readFileSync(path.join(SAMPLE, '.novelforge/characters/林昭.md'), 'utf8');
  const parsed = md.parseMarkdown(raw);
  check('解析 frontmatter name', parsed.frontmatter.name === '林昭', JSON.stringify(parsed.frontmatter.name));
  check(
    '解析行内数组 aliases',
    Array.isArray(parsed.frontmatter.aliases) && parsed.frontmatter.aliases[0] === '阿昭',
    JSON.stringify(parsed.frontmatter.aliases)
  );
  check('解析数字字段 firstAppear', parsed.frontmatter.firstAppear === '1');
  check('body 不含 frontmatter', !parsed.body.startsWith('---'));

  const sections = md.pickSections(parsed.body, ['身份', '语言习惯', '当前状态', '不存在的小节']);
  check('抽取「身份」小节', sections.身份.includes('七年前那场火的幸存者'));
  check('抽取「语言习惯」小节', sections.语言习惯.includes('答话极短'));
  check('抽取「当前状态」小节', sections.当前状态.includes('停舟'));
  check('缺失小节返回空串', sections.不存在的小节 === '');

  // 块状数组写法
  const block = md.parseMarkdown('---\ntags:\n  - 主角\n  - 视角人物\nname: 甲\n---\n\n正文');
  check('解析块状数组', Array.isArray(block.frontmatter.tags) && block.frontmatter.tags.length === 2,
    JSON.stringify(block.frontmatter.tags));
  check('块状数组后的键仍能解析', block.frontmatter.name === '甲');

  // H1 处理
  check('extractH1', md.extractH1('# 楔子\n\n正文') === '楔子');
  check('stripH1 去掉标题', md.stripH1('# 楔子\n\n雨下了三天').startsWith('雨下了三天'));
  check('stripH1 不误伤无标题正文', md.stripH1('雨下了三天') === '雨下了三天');

  // 无 frontmatter / 畸形 frontmatter 不应抛错
  check('无 frontmatter 不抛错', md.parseMarkdown('# 标题\n正文').frontmatter.name === undefined);
  const messy = md.parseMarkdown('---\n这行不是键值对\nname: 乙\n---\n正文');
  check('畸形行被跳过而非抛错', messy.frontmatter.name === '乙');

  // 序列化往返
  const fm = md.stringifyFrontmatter({ name: '丙', aliases: ['x', 'y'], firstAppear: 3, skip: undefined });
  const round = md.parseMarkdown(`${fm}\n\n正文`);
  check('frontmatter 序列化往返', round.frontmatter.name === '丙' && round.frontmatter.aliases.length === 2);
  check('undefined 字段被跳过', !fm.includes('skip'));
}

console.log('\n== tokenizer.ts ==');
{
  const tk = loadModule('src/core/context/tokenizer.ts');

  check('空串为 0', tk.estimateTokens('') === 0);
  const cn = tk.estimateTokens('雨下了三天');
  check('中文按 1.5x 估算', cn === Math.ceil(5 * 1.5), `got ${cn}`);
  const en = tk.estimateTokens('abcdefgh');
  check('英文按 4 字符估算', en === 2, `got ${en}`);
  check('中文估算高于英文同长度', tk.estimateTokens('一二三四') > tk.estimateTokens('abcd'));

  const chapter = fs.readFileSync(path.join(SAMPLE, 'chapters/002-客栈里的女人.md'), 'utf8');
  const full = tk.estimateTokens(chapter);
  check('示例章节 token 数量级合理（500~2000）', full > 500 && full < 2000, `got ${full}`);

  const tail = tk.takeTail(chapter, 100);
  check('takeTail 不超预算', tk.estimateTokens(tail) <= 100, `got ${tk.estimateTokens(tail)}`);
  check('takeTail 取的是结尾', chapter.trimEnd().endsWith(tail.trimEnd().slice(-20)));
  check('takeTail 不足预算时原样返回', tk.takeTail('短文本', 1000) === '短文本');

  const head = tk.takeHead(chapter, 100);
  check('takeHead 带截断标记', head.includes('因上下文预算截断'));
  check('takeHead 取的是开头', head.startsWith('# 客栈里的女人'));
  check('takeHead 不足预算时原样返回', tk.takeHead('短文本', 1000) === '短文本');
}

console.log('\n== continueWriting.ts · cleanOutput ==');
{
  const cw = loadModule('src/core/features/continueWriting.ts');

  const { cleanOutput } = cw;
  check('去掉代码块包裹', cleanOutput('```\n正文内容\n```') === '正文内容');
  check('去掉「好的，以下是」开场白', cleanOutput('好的，以下是续写内容：\n\n正文内容') === '正文内容');
  check('去掉「以下是」开场白', cleanOutput('以下是第四章：\n\n正文内容') === '正文内容');
  check('去掉 markdown 章节标题', cleanOutput('## 第四章 灯下\n\n正文内容') === '正文内容');
  check('去掉裸章节标题行', cleanOutput('第四章 灯下\n\n正文内容') === '正文内容');
  check('去掉结尾字数统计', cleanOutput('正文内容\n\n（本章约 2000 字）') === '正文内容');
  check('正常正文不被误伤', cleanOutput('雨下了三天，青崖镇的石板路泡得发白。') === '雨下了三天，青崖镇的石板路泡得发白。');
  check(
    '正文中的「第三章」不被误删',
    cleanOutput('他想起第三章那件事，于是停下。').includes('第三章'),
  );

  const title = cw.ContinueSession.suggestTitle('1. 林昭带年轻守卫去见他母亲，第三块令牌出现。\n2. 沈氏尾随。', 4);
  check('suggestTitle 取纲要首句', title === '林昭带年轻守卫去见他母亲', `got "${title}"`);
  check('suggestTitle 空纲要有兜底', cw.ContinueSession.suggestTitle('', 4) === '第4章');
}

console.log('\n== summarize.ts · parseSummaryResponse ==');
{
  const sum = loadModule('src/core/features/summarize.ts');

  const standard = `## 梗概\n\n林昭进镇。\n\n## 出场人物\n\n林昭、李叔\n\n## 时间地点\n\n傍晚，镇口\n\n## 关键事件\n\n- 递上令牌\n\n## 新增伏笔\n\n令牌来历\n\n## 状态变更\n\n无`;
  const parsed = sum.parseSummaryResponse(standard);
  check('解析标准六小节', parsed.梗概 === '林昭进镇。' && parsed.出场人物 === '林昭、李叔');
  check('关键事件保留列表', parsed.关键事件 === '- 递上令牌');

  const fenced = sum.parseSummaryResponse('```markdown\n' + standard + '\n```');
  check('剥离代码块围栏', fenced.梗概 === '林昭进镇。');

  const inline = sum.parseSummaryResponse('梗概：林昭进镇。\n出场人物：林昭、李叔\n关键事件：递上令牌');
  check('行内写法兜底', inline.梗概 === '林昭进镇。' && inline.出场人物 === '林昭、李叔');

  const bold = sum.parseSummaryResponse('**梗概**：林昭进镇。\n**出场人物**：林昭');
  check('加粗行内写法兜底', bold.梗概 === '林昭进镇。');

  const garbage = sum.parseSummaryResponse('模型胡说了一通完全没有结构的内容。');
  check('完全无结构时全文进梗概', garbage.梗概 === '模型胡说了一通完全没有结构的内容。');

  // 真实示例摘要文件应能被解析回来
  const real = fs.readFileSync(path.join(SAMPLE, '.novelforge/summaries/002.md'), 'utf8');
  const md = loadModule('src/core/model/markdown.ts');
  const realParsed = sum.parseSummaryResponse(md.parseMarkdown(real).body);
  check('解析真实摘要文件', realParsed.出场人物.includes('沈氏'), realParsed.出场人物);
  check('真实摘要的未收伏笔非空', realParsed.新增伏笔.length > 10);
}

console.log('\n== characters.ts · parseCharacterResponse ==');
{
  const ch = loadModule('src/core/features/characters.ts');

  const json = JSON.stringify([
    { name: '林昭', aliases: ['阿昭'], tags: ['主角'], 身份: '幸存者', 语言习惯: '答话极短', 当前状态: '客栈中' },
    { name: '沈氏', aliases: [], tags: ['配角'], 人物关系: ['与林昭：试探', '与掌柜：未知'] },
  ]);
  const cards = ch.parseCharacterResponse(json);
  check('解析出两个角色', cards.length === 2, `got ${cards.length}`);
  check('保留 aliases', cards[0].aliases[0] === '阿昭');
  check('映射小节字段', cards[0].sections.身份 === '幸存者' && cards[0].sections.语言习惯 === '答话极短');
  check('未提供的小节为空串', cards[0].sections.外貌 === '');
  check('数组字段转为列表', cards[1].sections.人物关系 === '- 与林昭：试探\n- 与掌柜：未知');

  check('代码块包裹的 JSON', ch.parseCharacterResponse('```json\n' + json + '\n```').length === 2);
  check('前后有废话的 JSON', ch.parseCharacterResponse('好的：\n' + json + '\n以上。').length === 2);
  check('非 JSON 返回空数组', ch.parseCharacterResponse('我无法完成').length === 0);
  check('坏 JSON 返回空数组而非抛错', ch.parseCharacterResponse('[{name: 缺引号}]').length === 0);
  check('无 name 的条目被丢弃', ch.parseCharacterResponse('[{"身份":"x"}]').length === 0);
  check('字符串形式的 aliases 被拆分', ch.parseCharacterResponse('[{"name":"甲","aliases":"a、b"}]')[0].aliases.length === 2);
}

console.log('\n== 示例工程数据一致性 ==');
{
  const crypto = require('crypto');
  const md = loadModule('src/core/model/markdown.ts');
  const manifest = JSON.parse(fs.readFileSync(path.join(SAMPLE, '.novelforge/project.json'), 'utf8'));

  // 用真实的章节判定规则过滤，而不是写死 .md——章节可以是任意非二进制扩展名，
  // 这条断言要跟着规则走，不然示例工程里加一份 .txt 章节它就误报。
  const chapterFile = loadModule('src/core/model/chapterFile.ts');
  const files = fs.readdirSync(path.join(SAMPLE, 'chapters')).filter((f) => chapterFile.isChapterFileName(f));
  check('manifest 章节数与磁盘一致', manifest.chapters.length === files.length);

  for (const entry of manifest.chapters) {
    const raw = fs.readFileSync(path.join(SAMPLE, entry.file), 'utf8').replace(/^﻿/, '').trim();
    const h = crypto.createHash('sha1').update(raw.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16);
    check(`第 ${entry.order} 章 contentHash 正确`, h === entry.contentHash, `expected ${h}`);
    check(`第 ${entry.order} 章摘要标记为最新`, entry.summaryHash === h);

    const sumPath = path.join(SAMPLE, '.novelforge/summaries', `${String(entry.order).padStart(3, '0')}.md`);
    check(`第 ${entry.order} 章摘要文件存在`, fs.existsSync(sumPath));
    const sumFm = md.parseMarkdown(fs.readFileSync(sumPath, 'utf8')).frontmatter;
    check(`第 ${entry.order} 章摘要 sourceHash 匹配正文`, sumFm.sourceHash === h, `${sumFm.sourceHash} vs ${h}`);
  }

  // 角色卡的 aliases 应能在示例纲要中被命中（验证角色筛选可用）
  const outline = '林昭带年轻守卫去见他母亲，沈氏在暗处跟着。';
  const cards = fs.readdirSync(path.join(SAMPLE, '.novelforge/characters'));
  let hitCount = 0;
  for (const f of cards) {
    const fm = md.parseMarkdown(fs.readFileSync(path.join(SAMPLE, '.novelforge/characters', f), 'utf8')).frontmatter;
    const names = [fm.name, ...(Array.isArray(fm.aliases) ? fm.aliases : [])];
    if (names.some((n) => n && n.length >= 2 && outline.includes(n))) hitCount++;
  }
  check('示例纲要能命中 3 个角色（林昭/沈氏/年轻守卫）', hitCount === 3, `got ${hitCount}`);
}

console.log(`\n${failures === 0 ? '全部通过' : `${failures} 项失败`}\n`);
process.exit(failures === 0 ? 0 : 1);
