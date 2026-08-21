/**
 * 种类 → handler 注册表。
 *
 * 认不出的种类落到 `plain`（纯文本进出、无记账）——**绝不抛**：网关不该
 * 因为一个没登记的种类就拒绝写一个普通文本文件。
 */
import { ArtifactKind } from '../kind';
import { Handler } from './types';
import { docHandler } from './doc';
import { plainHandler } from './plain';
import { volumeHandler } from './volume';
import { plotHandler } from './plot';
import { manuscriptHandler } from './manuscript';
import { chapterHandler } from './chapter';
import { summaryHandler } from './summary';

const REGISTRY: Partial<Record<ArtifactKind, Handler>> = {
  outline: docHandler,
  style: docHandler,
  globalSummary: docHandler,
  character: docHandler,
  lore: docHandler,
  volume: volumeHandler,
  plot: plotHandler,
  manuscript: manuscriptHandler,
  chapter: chapterHandler,
  summary: summaryHandler,
  other: plainHandler,
  draft: plainHandler,
};

export function handlerFor(kind: ArtifactKind): Handler {
  return REGISTRY[kind] ?? plainHandler;
}

export type { Handler, HandlerCtx, HandlerWriteResult } from './types';
