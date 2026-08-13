import { LayerId } from '../types';
import {
  outlineDoc,
  planPrev,
  planSelf,
  sceneSelf,
  sceneSiblings,
} from './artifacts';
import {
  chapterFull,
  chapterSummary,
  characters,
  globalSummary,
  lore,
  prevTail,
  revision,
  style,
} from './background';
import { ask, attachments, history, system } from './dialog';
import type { LayerFn } from './assembly';

export const LAYERS: Record<LayerId, LayerFn> = {
  system,
  ask,
  attachments,
  history,
  outlineDoc,
  planSelf,
  planPrev,
  sceneSelf,
  sceneSiblings,
  style,
  globalSummary,
  characters,
  lore,
  prevTail,
  chapterFull,
  chapterSummary,
  revision,
};

export { resolveFocus } from './focus';
export type { Focus } from './focus';
export type { Assembly, LayerFn } from './assembly';
export { isPlaceholder, tailByChars } from './render';
