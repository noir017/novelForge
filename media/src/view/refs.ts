/**
 * 页面上那些固定 id 的节点。
 *
 * 全部 `byId`（取不到就抛）——这些 id 在 webviewHtml.ts 与 html.ts 里都有，
 * 缺一个说明模板与前端不同步，早点炸比晚点炸好。**可选的**那几个
 * （独立版专属的徽标、内置编辑器容器）各自就地 `maybeById` 探测，不进这里。
 */
import { byId } from '../dom';

export const el = {
  tabbar: byId('tabbar'),
  messages: byId('messages'),
  emptyHint: byId('emptyHint'),
  newSessionBtn: byId<HTMLButtonElement>('newSessionBtn'),
  renamePlotBtn: byId<HTMLButtonElement>('renamePlotBtn'),
  workbench: byId<HTMLButtonElement>('workbench'),
  nextStep: byId('nextStep'),
  nextStepHint: byId('nextStepHint'),
  nextStepBtn: byId<HTMLButtonElement>('nextStepBtn'),
  cmdBtn: byId<HTMLButtonElement>('cmdBtn'),
  pendingCmd: byId('pendingCmd'),
  chips: byId('chips'),
  composerInput: byId('composerInput'),
  input: byId<HTMLTextAreaElement>('input'),
  atBtn: byId<HTMLButtonElement>('atBtn'),
  selBtn: byId<HTMLButtonElement>('selBtn'),
  modelSelect: byId<HTMLSelectElement>('modelSelect'),
  thinkSelect: byId<HTMLSelectElement>('thinkSelect'),
  targetSelect: byId<HTMLSelectElement>('targetSelect'),
  targetWords: byId<HTMLInputElement>('targetWords'),
  sendBtn: byId<HTMLButtonElement>('sendBtn'),
  stopBtn: byId<HTMLButtonElement>('stopBtn'),
  providerMeta: byId('providerMeta'),
  projectToolbar: byId('projectToolbar'),
  projectBody: byId('projectBody'),
  taskList: byId('taskList'),
  historyMeta: byId('historyMeta'),
  sessionList: byId('sessionList'),
  logBody: byId('logBody'),
  logLevel: byId<HTMLSelectElement>('logLevel'),
  logFilter: byId<HTMLInputElement>('logFilter'),
  logFollow: byId<HTMLInputElement>('logFollow'),
  logMeta: byId('logMeta'),
  logCopyBtn: byId<HTMLButtonElement>('logCopyBtn'),
  logClearBtn: byId<HTMLButtonElement>('logClearBtn'),
  providerList: byId('providerList'),
  providerCount: byId('providerCount'),
  providerModal: byId('providerModal'),
  providerModalTitle: byId('providerModalTitle'),
  providerModalBody: byId('providerModalBody'),
  providerModalClose: byId<HTMLButtonElement>('providerModalClose'),
  addProviderBtn: byId<HTMLButtonElement>('addProviderBtn'),
  toast: byId('toast'),
};
