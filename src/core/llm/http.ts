/**
 * 三条协议共用的 HTTP 零碎：主机名、响应体、错误措辞、工具参数解析。
 *
 * 这些从前住在 `openaiProvider.ts` 里，另一个 provider 反过来 import 它——
 * 两家的时候还算凑合，三家之后「其中一个当宿主」就说不通了：
 * `chatCompletions` 要用 `describeHttpBody`，却与 Responses 没有任何关系。
 * 搬到这里，谁都不欠谁。
 */

export function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

export async function describeHttpError(response: Response, label: string): Promise<string> {
  return describeHttpBody(response.status, await readBody(response), label);
}

/** 响应体读一次就没了，所以读它的地方只有这一个。读不出来当空字符串。 */
export async function readBody(response: Response): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '';
  }
}

/** 已经读出来的响应体 → 一句人话。三家 provider 共用。 */
export function describeHttpBody(
  status: number,
  body: string,
  label: string,
  /**
   * 这一家打的是哪个接口。404 那句提示要指名道姓——三条协议共用这个函数，
   * 而对着 Anthropic 那条路说「没有 /responses 接口」会把人往反方向带。
   */
  endpoint = '/responses'
): string {
  let detail = body;
  try {
    const json = JSON.parse(body) as { error?: { message?: string }; message?: string };
    detail = json.error?.message ?? json.message ?? body;
  } catch {
    /* 不是 JSON 就原样用 */
  }
  detail = detail.slice(0, 400);

  const hint =
    status === 401 || status === 403
      ? '（API Key 可能无效，可在设置页重新录入该服务商的 Key）'
      : status === 404
        ? `（接口地址或模型名可能填错了；也可能是这个服务商没有 ${endpoint} 接口——` +
          '换个协议类型再试，多数第三方服务商只认「OpenAI 通用」那条）'
        : status === 429
          ? '（触发限流，稍后再试）'
          : '';

  return `${label} 返回 HTTP ${status}${hint}${detail ? `：${detail}` : ''}`;
}

/** 解析工具参数。失败或解析出非对象一律退成空对象，绝不抛。 */
export function parseToolArgs(raw: string): Record<string, unknown> {
  if (!raw.trim()) {
    return {};
  }
  try {
    const parsed: unknown = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
  } catch {
    /* 坏 JSON 不抛：由上层报「参数解析失败」给模型看，让它重试 */
  }
  return {};
}
