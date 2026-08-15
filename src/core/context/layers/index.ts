import { LayerId } from '../types';
import {
  outlineDoc,
  plotNext,
  plotPrev,
  plotSelf,
  sceneSelf,
  sceneSiblings,
} from './artifacts';
import {
  characters,
  globalSummary,
  lore,
  manuscriptFull,
  plotSummary,
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
  plotSelf,
  plotPrev,
  plotNext,
  sceneSelf,
  sceneSiblings,
  style,
  globalSummary,
  characters,
  lore,
  prevTail,
  manuscriptFull,
  plotSummary,
  revision,
};

export { resolveFocus } from './focus';
export type { Focus } from './focus';
export type { Assembly, LayerFn } from './assembly';
export { isPlaceholder, tailByChars } from './render';
