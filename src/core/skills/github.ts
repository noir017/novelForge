/**
 * 从 GitHub 装技能：**先检查、再确认安装**，两步之间内容变了就不装。
 *
 * 移植自 AI-Novel-Writer `electron/controllers/app-data-controller.ts:133-379`：
 *
 * 1. **检查**（`inspectGitHubSkill`）：下载、读 frontmatter、跑兼容检查、算 sha256，把
 *    「这个地址检查过、内容是这个 hash」记在进程里。不写任何文件。
 * 2. **安装**（`installGitHubSkill`）：没检查过的地址不装；**重新下载一遍**，hash 与落点都要与
 *    检查时一致，不兼容的不装，同名的不覆盖，然后原样写进我的技能库。
 *
 * 第二步重新下载、而不是拿第一步的内容去写：作者点「确认安装」时看到的是第一步的结果，
 * 中间隔了多久不知道；确认的必须就是写进去的那一份。
 *
 * 两条路共用这一张检查表：设置页检查过的地址 agent 也装得了，反之亦然（上游同样如此）——
 * 两边装之前都要作者点头（设置页的确认框 / `run installSkill` 的 `always` 闸门）。
 *
 * 与上游不同：检查结果**带正文**给作者看（上游装之前看不到技能写了什么）；进程里那张表
 * 有上限，最早的先丢。
 */
import { createHash } from 'node:crypto';
import {
  MAX_SKILL_BYTES,
  SkillInspection,
  describeIncompat,
  githubRawUrl,
  inspectSkillMarkdown,
  isSafeRef,
  isSkillName,
  parseGitHubSkillUrl,
} from '../model/writingSkill';
import { scoped } from '../runtime/logger';
import { LoadedSkill, installUserSkill, loadSkill } from './library';

const log = scoped('技能');

const TIMEOUT_MS = 10_000;
const MAX_URL_LENGTH = 2048;
const USER_AGENT = 'novel-forge';
/** 检查过、还没装的地址最多记多少个。 */
const MAX_PENDING = 32;

export interface RemoteSkill {
  sourceUrl: string;
  /** 真正下载的那个 raw 地址。 */
  resolvedUrl: string;
  sha256: string;
  inspection: SkillInspection;
  /**
   * 装不了的原因（不兼容、名字不合法、我的技能库里已经有同名的）。空 = 可以装。
   * 检查时就说清，作者不必点了「确认安装」才知道装不了。
   */
  blockers: string[];
}

const inspected = new Map<string, RemoteSkill>();

function checkUrl(url: unknown): string {
  if (typeof url !== 'string' || !url.trim() || url.length > MAX_URL_LENGTH) {
    throw new Error('GitHub 地址无效');
  }
  return url.trim();
}

/** 下载并检查。**不改任何东西**——那张检查表除外。 */
export async function inspectGitHubSkill(url: string, signal?: AbortSignal): Promise<RemoteSkill> {
  const sourceUrl = checkUrl(url);
  inspected.delete(sourceUrl);
  const { remote } = await fetchSkill(sourceUrl, signal);
  inspected.set(sourceUrl, remote);
  while (inspected.size > MAX_PENDING) {
    inspected.delete(inspected.keys().next().value as string);
  }
  log.info(
    `检查了技能「${remote.inspection.name}」`,
    `${remote.resolvedUrl}｜${remote.inspection.bytes} 字节｜${remote.blockers.length > 0 ? `装不了：${remote.blockers.join('；')}` : '可以装'}`
  );
  return remote;
}

/** 这个地址检查过的结果。**零 I/O**：agent 的确认框要用它说清装的是什么。 */
export function inspectedGitHubSkill(url: string): RemoteSkill | undefined {
  return typeof url === 'string' ? inspected.get(url.trim()) : undefined;
}

/** 安装检查过的那一份。见文件头的五道关。 */
export async function installGitHubSkill(url: string, signal?: AbortSignal): Promise<LoadedSkill> {
  const sourceUrl = checkUrl(url);
  const confirmed = inspected.get(sourceUrl);
  if (!confirmed) {
    throw new Error('请先检查这份技能，再确认安装。');
  }
  inspected.delete(sourceUrl);
  const { remote, raw } = await fetchSkill(sourceUrl, signal);
  if (remote.sha256 !== confirmed.sha256 || remote.resolvedUrl !== confirmed.resolvedUrl) {
    throw new Error('这份技能在检查之后变了，请重新检查。');
  }
  if (remote.blockers.length > 0) {
    throw new Error(`装不了：${remote.blockers.join('；')}`);
  }
  return installUserSkill(remote.inspection.name, raw);
}

async function fetchSkill(sourceUrl: string, signal?: AbortSignal): Promise<{ remote: RemoteSkill; raw: string }> {
  const location = parseGitHubSkillUrl(sourceUrl);
  const timeout = (): AbortSignal =>
    signal ? AbortSignal.any([signal, AbortSignal.timeout(TIMEOUT_MS)]) : AbortSignal.timeout(TIMEOUT_MS);

  let ref = location.ref;
  if (!ref) {
    const repo = await fetch(
      `https://api.github.com/repos/${encodeURIComponent(location.owner)}/${encodeURIComponent(location.repo)}`,
      {
        headers: { Accept: 'application/vnd.github+json', 'User-Agent': USER_AGENT },
        redirect: 'error',
        signal: timeout(),
      }
    );
    if (!repo.ok) {
      throw new Error(`查不到这个 GitHub 仓库（HTTP ${repo.status}）`);
    }
    const data = (await repo.json()) as { default_branch?: unknown };
    if (!isSafeRef(data.default_branch)) {
      throw new Error('GitHub 返回的默认分支名不受支持');
    }
    ref = data.default_branch;
  }

  const resolvedUrl = githubRawUrl(location.owner, location.repo, ref, location.path);
  const response = await fetch(resolvedUrl, {
    headers: { Accept: 'text/plain', 'User-Agent': USER_AGENT },
    redirect: 'error',
    signal: timeout(),
  });
  if (!response.ok) {
    throw new Error(`SKILL.md 下载失败（HTTP ${response.status}）`);
  }
  const declared = Number(response.headers.get('content-length') ?? 0);
  if (declared > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md 超过 64 KiB');
  }
  const raw = await response.text();
  if (new TextEncoder().encode(raw).byteLength > MAX_SKILL_BYTES) {
    throw new Error('SKILL.md 超过 64 KiB');
  }

  const inspection = inspectSkillMarkdown(raw);
  const blockers: string[] = [];
  if (!inspection.compatible) {
    blockers.push(`不是自包含的提示词（${describeIncompat(inspection.reasons)}）`);
  }
  if (!isSkillName(inspection.name)) {
    blockers.push(`frontmatter 里的 name「${inspection.name}」不能当目录名`);
  } else if (await loadSkill(`user:${inspection.name}`)) {
    blockers.push(`我的技能库里已经有「${inspection.name}」了，要换新版先卸载旧的`);
  }
  return {
    raw,
    remote: {
      sourceUrl,
      resolvedUrl,
      sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
      inspection,
      blockers,
    },
  };
}
