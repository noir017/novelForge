/**
 * MCP 那一头的说明：`initialize` 回给客户端的 `instructions`。宿主把它放进外部 agent 的
 * 上下文，**只说怎么用这几个工具**——领域知识（细纲写到什么程度、章末钩子怎么留）在
 * `context/prompts.ts`，由 `generate` 内部那次调用自己带着，这里不写第二份。
 */
export const MCP_INSTRUCTIONS = [
  'Novel Forge 是作者本人的小说创作工具。这几个工具读写的是他此刻在 Novel Forge 里打开的那个小说工程。',
  '',
  '- 工程就是一堆 Markdown：.novelforge/ 下是架构（config.md / premise.md / world.md）、情节大纲（outline.md）、' +
    '细纲（plots/<章号>-<标题>.md，一章一份，细纲号就是章号）；正文在 chapters/。先 list / read / search 看清楚再动手。',
  '- 要产出内容用 generate：它在 Novel Forge 内部按分阶段装配好的上下文调创作模型。正文直接流给作者看，**不会回到你这里**；' +
    '作者在 Novel Forge 界面上点头才落盘，结论写在返回里。不要自己拼一份内容用 write 代替 generate——创作质量来自那一层的装配。',
  '- 连续多章（排细纲、写正文、定稿、同步摘要）用 run 的批量动作，不要循环调 generate。',
  '- 工具结果末尾有时附一段「# 当前工程」：那是 Novel Forge 状态机算出的下一步，与界面上的主按钮是同一句话。' +
    '照它走，不要另做判断；它变了才会再出现。',
  '- 覆盖已有内容、改动写作技能这类动作会在 Novel Forge 界面上请作者确认，等他回答之前工具调用不会返回。' +
    '作者拒绝了就别重试同一个动作，问问他想怎么改。',
  '- 没有删除、改名、移动——那些由作者自己做。',
].join('\n');
