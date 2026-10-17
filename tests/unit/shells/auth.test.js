/**
 * 独立版的访问控制（auth.ts）：什么时候必须配令牌、凭据认不认、Origin 认不认、登录后往哪跳。
 * 整条登录往返（种 cookie、WS / MCP 带凭据）在 tests/e2e/standalone/server.test.js 的「令牌鉴权」里。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const { loadModule } = require('../../helpers/load');

const auth = loadModule('src/shells/standalone/auth.ts');

const TOKEN = 'a-long-enough-token-0123';
const req = (headers = {}, url = 'http://127.0.0.1:3680/') => new Request(url, { headers });

describe('exposureError', () => {
  test('只绑本机时不要令牌', () => {
    assert.equal(auth.exposureError('127.0.0.1', undefined), undefined);
    assert.equal(auth.exposureError('localhost', undefined), undefined);
    assert.equal(auth.exposureError('::1', undefined), undefined);
  });

  test('绑非回环地址又没令牌：拒绝，并说出环境变量名', () => {
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) {
      const err = auth.exposureError(host, undefined);
      assert.ok(err && err.includes(auth.TOKEN_ENV), `${host}: ${err}`);
    }
  });

  test('令牌太短：不管绑在哪都拒绝', () => {
    assert.ok(auth.exposureError('127.0.0.1', 'short'));
    assert.ok(auth.exposureError('0.0.0.0', 'x'.repeat(auth.MIN_TOKEN_LENGTH - 1)));
  });

  test('够长的令牌：绑 0.0.0.0 也放行', () => {
    assert.equal(auth.exposureError('0.0.0.0', TOKEN), undefined);
  });
});

describe('isAuthorized', () => {
  const cookie = `nf_session=${auth.sessionValue(TOKEN)}`;

  test('Bearer 令牌对了就认，前缀不分大小写', () => {
    assert.ok(auth.isAuthorized(req({ authorization: `Bearer ${TOKEN}` }), TOKEN));
    assert.ok(auth.isAuthorized(req({ authorization: `bearer ${TOKEN}` }), TOKEN));
  });

  test('登录换来的 cookie 认，夹在别的 cookie 中间也认', () => {
    assert.ok(auth.isAuthorized(req({ cookie }), TOKEN));
    assert.ok(auth.isAuthorized(req({ cookie: `a=1; ${cookie}; b=2` }), TOKEN));
  });

  test('cookie 里不是令牌原文：直接把令牌塞进 cookie 不认', () => {
    assert.ok(!auth.isAuthorized(req({ cookie: `nf_session=${TOKEN}` }), TOKEN));
  });

  test('错的、空的、没带的都不认', () => {
    assert.ok(!auth.isAuthorized(req({ authorization: 'Bearer wrong' }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ authorization: 'Bearer ' }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ authorization: `Basic ${TOKEN}` }), TOKEN));
    assert.ok(!auth.isAuthorized(req({ cookie: 'nf_session=nope' }), TOKEN));
    assert.ok(!auth.isAuthorized(req(), TOKEN));
  });

  test('换了令牌，旧 cookie 作废', () => {
    assert.ok(!auth.isAuthorized(req({ cookie }), `${TOKEN}-rotated`));
  });
});

describe('isAllowedOrigin', () => {
  test('没有 Origin（命令行客户端）放过', () => {
    assert.ok(auth.isAllowedOrigin(null, req(), 3680, false));
  });

  test('本机同端口始终认，端口不同不认', () => {
    for (const o of ['http://127.0.0.1:3680', 'http://localhost:3680', 'http://[::1]:3680']) {
      assert.ok(auth.isAllowedOrigin(o, req(), 3680, false), o);
    }
    assert.ok(!auth.isAllowedOrigin('http://127.0.0.1:9999', req(), 3680, false));
  });

  test('没配令牌时不认同源：挡住 DNS rebinding', () => {
    const r = req({ host: 'evil.com:3680' }, 'http://evil.com:3680/ws');
    assert.ok(!auth.isAllowedOrigin('http://evil.com:3680', r, 3680, false));
  });

  test('配了令牌时认同源：直连服务器地址', () => {
    const r = req({ host: '192.168.1.5:3680' }, 'http://192.168.1.5:3680/ws');
    assert.ok(auth.isAllowedOrigin('http://192.168.1.5:3680', r, 3680, true));
  });

  test('配了令牌时认同源：经反代，认 X-Forwarded-Host', () => {
    const r = req({ host: '127.0.0.1:3680', 'x-forwarded-host': 'novel.example.com' });
    assert.ok(auth.isAllowedOrigin('https://novel.example.com', r, 3680, true));
  });

  test('配了令牌也不认跨源、不认坏 Origin', () => {
    const r = req({ host: 'novel.example.com' });
    assert.ok(!auth.isAllowedOrigin('https://evil.com', r, 3680, true));
    assert.ok(!auth.isAllowedOrigin('not a url', r, 3680, true));
  });
});

describe('safeNext', () => {
  test('站内路径原样保留（带查询串）', () => {
    assert.equal(auth.safeNext('/?project=%2Fdata%2Fbook'), '/?project=%2Fdata%2Fbook');
  });

  test('外站、协议相对、反斜杠、空值一律回首页', () => {
    for (const next of ['https://evil.com', '//evil.com', '/\\evil.com', '', null, undefined, 'relative']) {
      assert.equal(auth.safeNext(next), '/', String(next));
    }
  });
});

describe('loginPage', () => {
  test('next 进隐藏域前转义', () => {
    const html = auth.loginPage('/?a="><script>', false);
    assert.ok(!html.includes('"><script>'));
  });

  test('失败时才显示「令牌不对」', () => {
    assert.ok(!auth.loginPage('/', false).includes('令牌不对'));
    assert.ok(auth.loginPage('/', true).includes('令牌不对'));
  });
});
