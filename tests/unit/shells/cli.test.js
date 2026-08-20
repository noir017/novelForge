/**
 * 独立版 CLI：不带目录时 root 为空，不再把 cwd 当成工程。
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { loadModule } = require('../../helpers/load');

const { parseArgs } = loadModule('src/shells/standalone/cli.ts');

describe('parseArgs', () => {
  test('无参数时 root 为 undefined', () => {
    assert.equal(parseArgs([]).root, undefined);
  });

  test('无参数时仍有默认端口并打开浏览器', () => {
    const opts = parseArgs([]);
    assert.equal(opts.port, 3680);
    assert.equal(opts.open, true);
    assert.equal(opts.init, false);
    assert.equal(opts.verbose, false);
  });

  test('位置参数解析成绝对路径', () => {
    const opts = parseArgs(['sample-novel']);
    assert.equal(opts.root, path.resolve('sample-novel'));
  });

  test('init 无目录时 root 是 cwd', () => {
    const opts = parseArgs(['init']);
    assert.equal(opts.init, true);
    assert.equal(opts.root, path.resolve('.'));
  });

  test('init 带目录', () => {
    const opts = parseArgs(['init', '/tmp/book']);
    assert.equal(opts.init, true);
    assert.equal(opts.root, path.resolve('/tmp/book'));
  });

  test('无 root 时仍认 --port / --no-open / --verbose', () => {
    const opts = parseArgs(['--port', '4000', '--no-open', '--verbose']);
    assert.equal(opts.root, undefined);
    assert.equal(opts.port, 4000);
    assert.equal(opts.open, false);
    assert.equal(opts.verbose, true);
  });
});
