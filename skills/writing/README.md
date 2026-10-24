# 预设写作技能

这里备了 33 份写作技能：32 份改编自 [jarvis-write](https://github.com/ynnyh/jarvis-write) 的三类预设：文风胶囊（写正文）、味道锚（规划）、故事骨架（规划）；另有 1 份是本仓库自己写的[对峙场面去 AI 味](#去-ai-味写正文)（写正文）。它们**不随应用发布**，要用哪份就从 GitHub 装进「我的技能库」，再绑到对应的阶段。

## 怎么用

1. 设置页「技能」→ GitHub 地址，贴下面表里的地址，点「检查」，看过正文再点「确认安装」。也可以对外部 agent 说「装一下这个地址，绑到写正文上」。
2. 装上**不会自动绑定**，在同一页把它绑到表头写的阶段：文风绑「写正文」，味道和骨架绑「规划」。
3. 一个阶段只能绑一份：味道和骨架都在「规划」，只能二选一；文风和别的写正文技能（比如内置的「去 AI 味」）也只能二选一。两份都想要，可以把正文合成一份，放进本工程的 `.novelforge/skills/<名字>/SKILL.md`。

每份都是「一段写法 + 一段示范」：文风给笔法和一段仿写，味道给题材质感、味道坐标、一段示范场景与「跑偏 → 对味」对照，骨架给故事引擎、节奏、必备桥段与开场示范。**示范都是 jarvis-write 自撰的原创短段，不是任何原作节选**；名家笔法只是风格参考。

**没在真实模型上比过有没有用。** 这一类纯提示词的技能效果因模型而异（内置「去 AI 味」里修饰那几条单绑就几乎没用，见 [src/core/skills/README.md](../../src/core/skills/README.md)），先拿一两章试。

## 文风（写正文）

| 技能 | 名字 | 一句话 |
|---|---|---|
| [爽文快节奏（男频）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-shuangwen) | `style-shuangwen` | 节奏第一：短句、碎段，能推进就推进，不铺陈。 |
| [仙侠古风（疏朗写意）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-xianxia) | `style-xianxia` | 半文白为底，句读短，四字词组与对偶自然穿插。 |
| [悬疑冷硬（信息控制）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-xuanyi) | `style-xuanyi` | 叙述冷，只写看得见、听得见的。 |
| [言情细腻（感官优先）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-yanqing) | `style-yanqing` | 感官优先：温度、气息、触感、视线落点，都先于情绪名词。 |
| [历史权谋（话里有话）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-quanmou) | `style-quanmou` | 对话交锋为主体，话里有话，字面与真意分离。 |
| [硬科幻（冷叙述·概念密度）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-kehuan) | `style-kehuan` | 技术细节具体且自洽，术语克制、不炫。 |
| [轻小说吐槽（内心弹幕）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-qingxiaoshuo) | `style-qingxiaoshuo` | 第一人称口语，内心弹幕与正文自然交错。 |
| [恐怖惊悚（慢压·错位）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-kongbu) | `style-kongbu` | 慢压：先铺日常，再渗入一点错位。 |
| [鲁迅·冷峻反讽](https://github.com/noir017/novelForge/tree/main/skills/writing/style-luxun) | `style-luxun` | 白描为主，句子短而顿挫，克制、冷峻，底下压着反讽与悲悯。 |
| [余华·平静叙苦](https://github.com/noir017/novelForge/tree/main/skills/writing/style-yuhua) | `style-yuhua` | 用平静甚至近乎温和的语气叙述残酷与苦难，情感克制到近乎冷。 |
| [汪曾祺·淡而有味](https://github.com/noir017/novelForge/tree/main/skills/writing/style-wangzengqi) | `style-wangzengqi` | 散文化，淡而有味，生活气息浓。 |
| [金庸·武侠白话](https://github.com/noir017/novelForge/tree/main/skills/writing/style-jinyong) | `style-jinyong` | 古典白话，武侠节奏明快利落。 |
| [王小波·冷静荒诞](https://github.com/noir017/novelForge/tree/main/skills/writing/style-wangxiaobo) | `style-wangxiaobo` | 黑色幽默与冷静的荒诞并存。 |
| [海明威·冰山极简（译笔）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-hemingway) | `style-hemingway` | 冰山理论：只写水面上的动作与对话，情绪压在水下不说破。 |
| [冷硬克制（硬汉派）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-cooldry) | `style-cooldry` | 克制、冷、不抒情。 |
| [素淡白描（平实）](https://github.com/noir017/novelForge/tree/main/skills/writing/style-plain) | `style-plain` | 平实、干净、不炫技的白描。 |

## 味道（规划）

| 技能 | 名字 | 一句话 |
|---|---|---|
| [现实青春·疼痛细腻](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-youth-realism) | `taste-youth-realism` | 像《最好的我们》《你好，旧时光》一类的现实校园成长。 |
| [甜宠恋爱·轻松上头](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-sweet-dopamine) | `taste-sweet-dopamine` | 像轻松向甜宠、下饭恋爱一类。 |
| [虐恋深情·意难平](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-tragic-deep) | `taste-tragic-deep` | 像高虐、BE 美学、意难平一类。 |
| [玄幻热血·爽感升级](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-xuanhuan-blood) | `taste-xuanhuan-blood` | 像境界流、升级打脸爽文一类。 |
| [悬疑冷硬·抽丝剥茧](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-suspense-cold) | `taste-suspense-cold` | 像社会派/硬核推理、冷硬悬疑一类。 |
| [历史厚重·家国沉浮](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-history-heavy) | `taste-history-heavy` | 像正剧向历史、家国群像一类。 |
| [治愈日常·细水温情](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-healing-warm) | `taste-healing-warm` | 像生活流、治愈系、烟火气一类。 |
| [硬核科幻·点子驱动](https://github.com/noir017/novelForge/tree/main/skills/writing/taste-scifi-idea) | `taste-scifi-idea` | 像点子流、思辨科幻一类。 |

## 骨架（规划）

| 技能 | 名字 | 一句话 |
|---|---|---|
| [身份错位·打脸流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-face-slap) | `pattern-face-slap` | 战神归来、赘婿翻身、隐藏大佬被小看一类的当众打脸。 |
| [重生复仇·先知改命流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-rebirth-revenge) | `pattern-rebirth-revenge` | 重生回到悲剧之前、带着记忆逆天改命一类的复仇爽文。 |
| [前世今生·千年羁绊流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-past-life) | `pattern-past-life` | 隔世重逢、三生羁绊、今生前缘解不开一类的宿命爱情。 |
| [闪婚契约·先婚后爱流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-flash-marriage) | `pattern-flash-marriage` | 契约婚姻、闪婚老公、隐婚甜宠一类的先婚后爱。 |
| [阶层碰撞·追梦异国流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-class-gap-romance) | `pattern-class-gap-romance` | 普通青年闯进顶级圈层（异国练习生/豪门/顶级职场）的阶层落差恋爱。 |
| [废柴逆袭·草根翻身流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-underdog) | `pattern-underdog` | 人人踩一脚的底层少年一路翻盘一类的草根逆袭。 |
| [马甲大佬·多重身份流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-secret-identity) | `pattern-secret-identity` | 马甲遍地的扫地僧、全网追的大神就在身边一类的多重身份。 |
| [甜宠撒糖·糖点密集流](https://github.com/noir017/novelForge/tree/main/skills/writing/pattern-sweet-daily) | `pattern-sweet-daily` | 双向暗恋、欢喜冤家、日常发糖一类的密集甜宠。 |

## 去 AI 味（写正文）

| 技能 | 名字 | 一句话 |
|---|---|---|
| [高潮对峙与逻辑去AI味（写正文/修稿）](https://github.com/noir017/novelForge/tree/main/skills/writing/tension-logic-humanizer) | `tension-logic-humanizer` | 对峙交锋、绝境反转一类的高张力场面：伪装者不露强硬动作，删掉金手指参数、报账式求饶与流水账转场。 |

这一份不是改编的：照作者自己一段稿子的改前改后写成，随本仓库的许可（AGPL-3.0），所以 frontmatter 里没有 `license` 与 `origin` 两行。它也是写正文的技能，和文风、内置的「去 AI 味」只能三选一。

## 来源与改动

改编自 jarvis-write（Copyright 2026 ynnyh，Apache License 2.0，许可原文见 [LICENSE-jarvis-write](LICENSE-jarvis-write)）的 `backend/app/prompts/style_capsules.py`（`CAPSULES`）、`dna_capsules.py`（`DNA_CAPSULES` 与 `GENRE_PAIRWISE`）、`story_patterns.py`（`STORY_PATTERNS`），取自 1660ca3。每份 frontmatter 的 `license` 与 `origin` 两行写着它出自哪一条。相对原文改了这些：

- **写成 SKILL.md**：原来是代码里的字段，生成时由对方的引擎拼进提示词；这里把字段写成正文的几节，引导语照原来的意思改写。
- **标点改成全角**：原文的中文里用的是半角逗号、问号、冒号与括号，示范段会被模型照着学，所以挨着中文的一律换成全角。
- **改正写反的引号**：故事骨架里有几处把一对引号写反了（`」被小看→…→打脸「`，甜宠那条开头写成了 `』`），按配对顺序改正。
- **「跑偏 → 对味」对照只给现实青春带全**：原来按题材模式取「现实向」那一组，可那一组的改法全是校园场景（教辅、贺卡、同桌），套到悬疑、历史上会把规划往校园带；所以只有现实青春带这一组，八份都带两条通用的对照。
- **去掉「最高优先级」**：原来故事骨架的块头写着结构锚最高优先级，这里的技能只补充写法，作者事实与输出格式说了算（注入时的块头就是这么说的）。
- **「像哪些作品」只写在 description 里**：设置页看得到，正文里没有。原项目也不把书名喂给模型，因为模型对一本书的记忆靠不住。

转换脚本没有放进仓库：它只是一次性的，用 `ast` 读对方的源码、不执行。以后要改哪一份，直接改这里的 `SKILL.md`。
