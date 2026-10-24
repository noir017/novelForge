/**
 * 配置与密钥放在哪：缺省 ~/.novelforge，`NOVELFORGE_HOME` 能把它挪走
 * （Android 壳把家目录设成放书的公共目录，密钥指回 app 私有目录）。
 */
const { describe, test, afterEach } = require('node:test');
const assert = require('node:assert/strict');
const os = require('node:os');
const path = require('node:path');
const { loadModule } = require('../helpers/load');

const { homeDir, FileConfigStore } = loadModule('src/core/stores.ts');

const saved = process.env.NOVELFORGE_HOME;

afterEach(() => {
  if (saved === undefined) {
    delete process.env.NOVELFORGE_HOME;
  } else {
    process.env.NOVELFORGE_HOME = saved;
  }
});

describe('homeDir', () => {
  test('缺省是家目录下的 .novelforge', () => {
    delete process.env.NOVELFORGE_HOME;
    assert.equal(homeDir(), path.join(os.homedir(), '.novelforge'));
  });

  test('NOVELFORGE_HOME 给了就用它，配置文件跟着走', () => {
    const dir = path.join(os.tmpdir(), 'nf-home-override');
    process.env.NOVELFORGE_HOME = dir;
    assert.equal(homeDir(), dir);
    assert.equal(new FileConfigStore().filePath, path.join(dir, 'config.json'));
  });

  test('空白的 NOVELFORGE_HOME 当没给', () => {
    process.env.NOVELFORGE_HOME = '  ';
    assert.equal(homeDir(), path.join(os.homedir(), '.novelforge'));
  });
});
