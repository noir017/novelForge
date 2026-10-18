/**
 * 独立版的访问控制：监听地址要不要令牌、请求带的凭据认不认、Origin 认不认、登录页。
 *
 * 缺省形态没变：只绑 127.0.0.1、无鉴权，安全全靠「别的机器连不进来」。部署到服务器
 * （Docker 镜像就是这样）得绑 0.0.0.0，这道墙就没了，所以**绑非回环地址必须配令牌**，
 * 没配就拒绝启动（`exposureError`）——宁可起不来，也不要裸奔。令牌只认环境变量
 * `NOVELFORGE_TOKEN`：命令行参数会出现在 `ps` 里。
 *
 * 配了令牌之后，不管绑在哪都要鉴权：
 * - 网页：登录页交一次令牌，换一个 cookie。cookie 里是由令牌派生的值、不是令牌原文；
 *   换令牌重启后旧 cookie 自然作废。`SameSite=Lax`：跨站页面发起的 WebSocket 握手与
 *   `fetch` 带不上它，顶层导航（从书签、别的页面点进来）带得上。
 * - MCP 客户端：`Authorization: Bearer <令牌>`（`claude mcp add … --header`）。
 *
 * 纯函数，只用标准 `Request` / `Response`，单测在 Node 下直接跑。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

export const TOKEN_ENV = 'NOVELFORGE_TOKEN';
/** 令牌下限。登录页能被人反复试，短令牌经不起猜。 */
export const MIN_TOKEN_LENGTH = 16;
export const LOGIN_PATH = '/login';

const COOKIE_NAME = 'nf_session';
const COOKIE_MAX_AGE_S = 30 * 24 * 3600;
/** 令牌错了先等一会儿再回：拖慢逐个猜的速度，对正常输错的人只是一眨眼。 */
const LOGIN_FAIL_DELAY_MS = 1000;

/** 回环地址：只有本机连得进来，这时才允许不设令牌。 */
export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[(.*)\]$/, '$1');
  return h === 'localhost' || h === '::1' || /^127\.\d+\.\d+\.\d+$/.test(h);
}

/**
 * 这样起服务安不安全。返回要打印给作者的那句话；没问题返回 undefined。
 * `token` 由调用方先把空串归一成 undefined。
 */
export function exposureError(host: string, token: string | undefined): string | undefined {
  const hint = `可用 \`openssl rand -hex 24\` 生成一个，放进环境变量 ${TOKEN_ENV}。`;
  if (token !== undefined && token.length < MIN_TOKEN_LENGTH) {
    return `访问令牌太短（${token.length} 位，至少 ${MIN_TOKEN_LENGTH} 位）。${hint}`;
  }
  if (token === undefined && !isLoopbackHost(host)) {
    return `监听 ${host} 会让别的机器连进来，必须先设访问令牌。${hint}`;
  }
  return undefined;
}

/** 两边先摘要成等长再比，`timingSafeEqual` 才不会因长度不同直接抛、也不泄露长度。 */
function sameSecret(a: string, b: string): boolean {
  const digest = (s: string) => createHash('sha256').update(s).digest();
  return timingSafeEqual(digest(a), digest(b));
}

/** cookie 里放的值。 */
export function sessionValue(token: string): string {
  return createHash('sha256').update(`novelforge-session:${token}`).digest('hex');
}

function cookieOf(req: Request, name: string): string | undefined {
  const header = req.headers.get('cookie');
  if (!header) {
    return undefined;
  }
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim();
    }
  }
  return undefined;
}

/** 请求带的凭据认不认：Bearer 令牌或登录换来的 cookie，有一样对就行。 */
export function isAuthorized(req: Request, token: string): boolean {
  const bearer = /^Bearer\s+(.+)$/i.exec(req.headers.get('authorization') ?? '');
  if (bearer && sameSecret(bearer[1].trim(), token)) {
    return true;
  }
  const cookie = cookieOf(req, COOKIE_NAME);
  return cookie !== undefined && sameSecret(cookie, sessionValue(token));
}

/**
 * WS 与 MCP 的 Origin 白名单。
 *
 * 没有 Origin 头的一律放过——命令行工具（冒烟测试里的 Bun WebSocket、wscat、MCP 客户端）
 * 不发这个头，浏览器一定发，所以缺失说明不是网页发起的请求。
 *
 * 本机同端口始终认。**配了令牌时**再认同源（Origin 与 `Host` / `X-Forwarded-Host` 一致）：
 * 经服务器地址或反代访问时，Origin 本来就不是 127.0.0.1。没配令牌时绝不能认这条——
 * DNS rebinding 的页面开在 `evil.com:3680`，解析到 127.0.0.1 后 Origin 与 Host 恰好一致，
 * 那时挡住它的只有「只认本机」这一条；配了令牌则它拿不到绑在真实地址上的 cookie。
 */
export function isAllowedOrigin(origin: string | null, req: Request, port: number, withToken: boolean): boolean {
  if (!origin) {
    return true;
  }
  let u: URL;
  try {
    u = new URL(origin);
  } catch {
    return false;
  }
  if (isLoopbackHost(u.hostname) && u.port === String(port)) {
    return true;
  }
  if (!withToken) {
    return false;
  }
  const forwarded = req.headers.get('x-forwarded-host')?.split(',')[0];
  return [req.headers.get('host'), forwarded].some((h) => !!h && h.trim().toLowerCase() === u.host.toLowerCase());
}

/** 登录后跳回哪：只认站内路径，`//evil.com` 与绝对地址一律回首页，免得登录页成了跳板。 */
export function safeNext(next: string | null | undefined): string {
  if (!next || !next.startsWith('/') || next.startsWith('//') || next.startsWith('/\\')) {
    return '/';
  }
  return next;
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => `&#${c.charCodeAt(0)};`);
}

/** 登录页。自带样式：`/media/view.css` 依赖主页面的主题变量，单独拿来用不成样子。 */
export function loginPage(next: string, failed: boolean): string {
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Novel Forge · 登录</title>
<link rel="icon" href="/favicon.ico" type="image/svg+xml">
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { display: grid; place-items: center; min-height: 100vh; margin: 0; }
  form { display: grid; gap: 12px; width: min(320px, 90vw); }
  h1 { font-size: 20px; margin: 0; }
  p { margin: 0; opacity: .75; font-size: 14px; }
  input, button { font: inherit; padding: 8px 10px; border-radius: 6px; }
  input { border: 1px solid #8886; background: transparent; color: inherit; }
  button { border: 0; background: #4daafc; color: #fff; cursor: pointer; }
  .error { color: #e5484d; opacity: 1; }
</style>
</head>
<body>
<form method="post" action="${LOGIN_PATH}">
  <h1>Novel Forge</h1>
  <p>这台服务设了访问令牌，输入后进入。</p>
  ${failed ? '<p class="error">令牌不对。</p>' : ''}
  <input type="hidden" name="next" value="${escapeHtml(safeNext(next))}">
  <input type="password" name="token" placeholder="访问令牌" autocomplete="current-password" autofocus required>
  <button type="submit">进入</button>
</form>
</body>
</html>
`;
}

/** 未登录访问页面时回的那一页：401，内容是登录页，交完跳回原地址。 */
export function loginRequired(url: URL): Response {
  return new Response(loginPage(url.pathname + url.search, false), {
    status: 401,
    headers: { 'content-type': 'text/html; charset=utf-8' },
  });
}

/** `/login`：GET 出登录页，POST 核对令牌、种 cookie、303 跳回。 */
export async function handleLogin(req: Request, token: string): Promise<Response> {
  const html = (body: string, status: number) =>
    new Response(body, { status, headers: { 'content-type': 'text/html; charset=utf-8' } });
  const url = new URL(req.url);
  if (req.method === 'GET') {
    return html(loginPage(safeNext(url.searchParams.get('next')), false), 200);
  }
  if (req.method !== 'POST') {
    return new Response('Method Not Allowed', { status: 405, headers: { allow: 'GET, POST' } });
  }
  let given = '';
  let next = '/';
  try {
    const form = await req.formData();
    given = String(form.get('token') ?? '');
    next = safeNext(String(form.get('next') ?? '/'));
  } catch {
    // 表单解析不了就当令牌是空的
  }
  if (!sameSecret(given, token)) {
    await new Promise((r) => setTimeout(r, LOGIN_FAIL_DELAY_MS));
    return html(loginPage(next, true), 401);
  }
  // 经 HTTPS 反代访问时加 Secure；直连 http 的局域网访问加了反而存不下。
  const https =
    url.protocol === 'https:' || req.headers.get('x-forwarded-proto')?.split(',')[0].trim() === 'https';
  const cookie = [
    `${COOKIE_NAME}=${sessionValue(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${COOKIE_MAX_AGE_S}`,
    ...(https ? ['Secure'] : []),
  ].join('; ');
  return new Response(null, { status: 303, headers: { location: next, 'set-cookie': cookie } });
}
