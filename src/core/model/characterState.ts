/**
 * 角色卡「当前状态」一节归谁（D15）。
 *
 * 定稿时机器要把本章出场的人的当前状态更新到这一章——批量串行写十章，不能每章弹一次
 * diff。可作者手改过的内容不能被静默覆盖（第 3 条）。两头都要，于是这一节的归属只看
 * 一件事：**自上次机器写入之后，有没有人改过它**。
 *
 * 机器每次写这一节都在 frontmatter 记下它的指纹（`stateHash`）与写到第几章（`stateThrough`）。
 * 下次要写时：
 *
 * - 这一节是空的 → 机器的（没有东西可吞）；
 * - 指纹对得上 → 机器的（没人动过）；
 * - 其余（改过、或者从没记过指纹却有内容）→ 作者的，不写。
 *
 * 最后那半句与 AI-Novel-Writer 同一口径（`finalize-chapter.command.ts:481-483`：非空而又不是
 * 机器派生的值一律保护）：手写的卡、换轴之前的卡，宁可多问一句也不替作者改。
 */
import { hash } from './fs';
import { CharacterCard } from './types';

/** 「当前状态」这一节的指纹。只看内容，不看首尾空白。 */
export function stateHashOf(text: string): string {
  return hash((text ?? '').trim());
}

/** 这一节现在归机器（可以直接更新）还是归作者（不写，挂黄 ❗）。 */
export function stateOwnedByMachine(card: Pick<CharacterCard, 'sections' | 'stateHash'>): boolean {
  const text = card.sections.当前状态 ?? '';
  if (!text.trim()) {
    return true;
  }
  return !!card.stateHash && card.stateHash === stateHashOf(text);
}

/**
 * 机器写完「当前状态」之后盖章：记指纹与写到第几章。建卡、采纳「更新角色卡」、定稿
 * 那几处都走它——少盖一处，机器自己写的东西下次就被当成作者的。
 */
export function stampState<T extends Pick<CharacterCard, 'sections'>>(
  card: T,
  through: number
): T & { stateThrough: number; stateHash: string } {
  return { ...card, stateThrough: through, stateHash: stateHashOf(card.sections.当前状态) };
}

/** 「状态截至第 3 章」「开篇状态」。角色行说明与装配明细共用。 */
export function describeStateThrough(through: number | undefined): string {
  if (through === undefined) {
    return '';
  }
  return through <= 0 ? '开篇状态' : `状态截至第 ${through} 章`;
}
