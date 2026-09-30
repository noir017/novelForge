import { LayerId } from '../types';
import {
  guidance,
  outlineDoc,
  outlineSlice,
  plotAhead,
  plotList,
  plotNext,
  plotPrev,
  plotSelf,
  premiseWorld,
  rosterDoc,
  settingDocs,
  structure,
} from './artifacts';
import {
  chapterSoFar,
  characters,
  evidence,
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
  settingDocs,
  guidance,
  premiseWorld,
  rosterDoc,
  outlineDoc,
  outlineSlice,
  structure,
  plotList,
  plotSelf,
  plotPrev,
  plotNext,
  plotAhead,
  chapterSoFar,
  style,
  globalSummary,
  characters,
  lore,
  prevTail,
  manuscriptFull,
  plotSummary,
  evidence,
  revision,
};

export { resolveFocus } from './focus';
export type { Focus } from './focus';
export type { Assembly, LayerFn } from './assembly';
export { isPlaceholder, tailByChars } from './render';
