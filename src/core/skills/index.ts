/**
 * 写作技能（Skill）：按创作阶段绑一份补充写作方法，生成时拼进提示词。
 * 详见 [README.md](README.md)；纯函数部分在 [model/writingSkill.ts](../model/writingSkill.ts)。
 */
export { BUILTIN_SKILL_DIRS } from './builtin/embedded';
export {
  installUserSkill,
  listSkills,
  loadSkill,
  setUserSkillsDir,
  uninstallUserSkill,
  userSkillsDir,
} from './library';
export type { LoadedSkill, SkillFiles } from './library';
export { inspectGitHubSkill, inspectedGitHubSkill, installGitHubSkill } from './github';
export type { RemoteSkill } from './github';
export { boundSkillFor, readSkillBindings, saveSkillBinding, unbindSkillEverywhere } from './bindings';
export type { BindingsFile, BoundSkill } from './bindings';
