/**
 * 设置页的连接测试 + 两个输出小工具。
 *
 * 这个文件从前是 `CreationSession`——一个类同时管四件事：有没有在生成、
 * 装配上下文、解析产物、落盘（六条分支）。四件事各自搬走之后它就没了：
 *
 * | 从前的职责 | 现在在哪 |
 * |---|---|
 * | `currentAbort` 并发控制 | `controller/index.ts`（那是**调度**的责任） |
 * | 装配 + 调模型 + 解析 | `generation/generate.ts`（无状态，收 signal） |
 * | `acceptArtifact` 六条分支 | `generation/accept.ts`（守卫在 `workspace/`） |
 * | `preview()` | `generation/generate.ts` 的 `previewContext` |
 *
 * 留在这里的三样东西都跟创作编排没关系：`testConnection` 是设置页的活，
 * `cleanOutput` / `suggestTitle` 是纯文本工具（前者还被 `pipelineBatch.ts`
 * 用着）。
 */
import { buildProvider } from '../llm/registry';
import { readConfig } from '../config';
import { describeError, elapsed, scoped } from '../runtime/logger';
import { sanitizeFileName } from '../model/fs';
import {
  describeModelIssue,
  ProviderProfile,
  providerLabel,
  resolveModelRef,
  withDraftProvider,
} from '../model/providers';

const log = scoped('创作');

/**
 * 发一个最小请求验证配置能不能用。
 * 设置页的「测试连接」——比让用户先写半章再发现 Key 填错好得多。
 *
 * **严格用指定的那个模型**，不走分档池、不 fallback（第 12 条）：测的就是
 * 「这一个能不能用」，换成别的答案毫无意义。
 *
 * @param ref 要测的模型引用；留空则测当前选中的。
 * @param draft 设置页屏幕上那份尚未保存的服务商配置。给了就以它为准——
 *   「新加的模型必须先保存才能测」对用户毫无道理，而且保存一份没验过的
 *   配置正是测试想要避免的事。
 */
export async function testConnection(
  ref?: string,
  draft?: ProviderProfile
): Promise<{ ok: boolean; message: string }> {
  const config = readConfig();
  // 草稿只补充、不替换：其余服务商仍用已保存的，这样 ref 指向别家时照样能解析。
  const providers = withDraftProvider(config.providers, draft);
  const active = ref ? resolveModelRef(providers, ref) : config.active;
  if (!active) {
    return { ok: false, message: describeModelIssue(providers, ref ?? config.model) };
  }
  const provider = await buildProvider(active);
  if (!provider) {
    return {
      ok: false,
      message: `未配置「${providerLabel(active.profile)}」的 API Key，已取消测试。`,
    };
  }
  log.info(`测试连接 ${active.ref}`, provider.label);
  const startedAt = Date.now();
  const abort = new AbortController();
  try {
    let reply = '';
    for await (const ev of provider.stream(
      [{ role: 'user', content: '回复两个字：收到' }],
      { maxOutputTokens: 16, temperature: 0, timeoutMs: 30000, signal: abort.signal }
    )) {
      if (ev.type !== 'text') {
        continue;
      }
      reply += ev.text;
      // 拿到任何内容就算通了，不必等它说完。
      if (reply.trim().length >= 2) {
        break;
      }
    }
    if (reply.trim()) {
      log.info(`${active.ref} 连接正常`, `回复「${reply.trim().slice(0, 20)}」，用时 ${elapsed(startedAt)}`);
      return { ok: true, message: `${active.ref} 连接正常：${provider.label} 回复「${reply.trim().slice(0, 20)}」` };
    }
    log.warn(`${active.ref} 连接成功但没有返回内容`, `用时 ${elapsed(startedAt)}，检查模型名是否正确`);
    return { ok: false, message: `${active.ref} 连接成功但没有返回内容，检查模型名是否正确。` };
  } catch (err) {
    log.error(`${active.ref} 连接失败：${describeError(err)}`, err);
    return { ok: false, message: `${active.ref}：${describeError(err)}` };
  }
}

// ---------------------------------------------------------------- 输出清理

/**
 * 清理模型输出里常见的赘余：包裹的代码块、开场白、被要求不写却仍写出的标题。
 * 只做保守清理，不改动正文本身。
 *
 * **只对正文层用**。在 JSON 产物上跑这几条正则会切坏结构——产物里的
 * ``` 由 `parse.ts` 的 `stripCodeFence` 在解析时处理。
 */
export function cleanOutput(text: string): string {
  let out = text.trim();

  const fence = /^```(?:\w+)?\r?\n([\s\S]*?)\r?\n?```$/.exec(out);
  if (fence) {
    out = fence[1].trim();
  }

  // 开头的「好的，以下是……」之类
  out = out.replace(/^(好的|没问题|明白了)[^\n]{0,40}[:：]\s*\r?\n+/, '');
  out = out.replace(/^(以下是|下面是)[^\n]{0,40}[:：]?\s*\r?\n+/, '');

  // 开头的章节标题行（我们在 prompt 里禁止了，但模型常忍不住）
  out = out.replace(/^#{1,6}\s*第?\s*[\d一二三四五六七八九十百]+\s*章[^\n]*\r?\n+/, '');
  out = out.replace(/^第\s*[\d一二三四五六七八九十百]+\s*章[ 　]*[^\n]{0,20}\r?\n+/, '');

  // 结尾的字数统计/创作说明
  out = out.replace(/\r?\n+[（(]?\s*(本章|全文|以上)?\s*(约|共)?\s*\d+\s*字\s*[)）]?\s*$/, '');
  out = out.replace(/\r?\n+[-—]{3,}[\s\S]*$/, (m) => (m.length < 200 ? '' : m));

  return out.trim();
}

/** 给新章节起个默认标题：优先用纲要首句。 */
export function suggestTitle(outline: string, order: number): string {
  const firstLine = outline
    .split(/\r?\n/)
    .map((s) => s.replace(/^[\s\-*\d.、)]+/, '').trim())
    .find((s) => s.length > 0);
  if (!firstLine) {
    return `第${order}章`;
  }
  const clipped = firstLine.split(/[。！？；,，.!?;]/)[0].trim().slice(0, 18);
  return sanitizeFileName(clipped) || `第${order}章`;
}
