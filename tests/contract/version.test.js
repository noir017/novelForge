/**
 * 版本号只记一处：仓库根 `package.json`。
 *
 * 从前三处各记一份（`package.json` / `tauri.conf.json` / `Cargo.toml`），发版时 CI 再
 * 一处处改过去，漏一处安装包上的版本号就是旧的。现在 `npm version` 只改 `package.json`，
 * 别的地方都从它来——这几条钉的是「别处没有偷偷长回第二份」：
 *
 * | 用例 | 钉的是什么 |
 * |---|---|
 * | tauri.conf.json 指向 package.json | Tauri 照**它所在目录**解析这个路径（CLI 读配置时先切进那个目录）；路径不存在时它会把这串字当版本号解析，直接报错 |
 * | Cargo.toml 是 0.0.0 | 那里的值不被任何地方读，写个像样的数只会让人以为它是版本号 |
 * | 版本号是 X.Y.Z | release.yml 只认这个形状（Windows MSI 不认带字母的预发布号） |
 * | Android 的版本取自 package.json | app/build.gradle 照 `rootProject` 解析那个相对路径；写死 versionName 就又长出了第二份 |
 */
const { describe, test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const { ROOT } = require('../helpers/load');

const DESKTOP = path.join(ROOT, 'src', 'shells', 'desktop');
const ANDROID = path.join(ROOT, 'src', 'shells', 'android');
const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));

describe('版本号只记在 package.json', () => {
  test('tauri.conf.json 的 version 指向仓库根 package.json', () => {
    const conf = JSON.parse(fs.readFileSync(path.join(DESKTOP, 'tauri.conf.json'), 'utf8'));
    assert.equal(path.resolve(DESKTOP, conf.version), path.join(ROOT, 'package.json'), conf.version);
  });

  test('Cargo.toml 的 version 是占位的 0.0.0', () => {
    const cargo = fs.readFileSync(path.join(DESKTOP, 'Cargo.toml'), 'utf8');
    assert.match(cargo, /^version = "0\.0\.0"$/m);
  });

  test('Android 的 versionName / versionCode 取自仓库根 package.json', () => {
    const gradle = fs.readFileSync(path.join(ANDROID, 'app', 'build.gradle'), 'utf8');
    const m = /rootProject\.file\('([^']+)'\)/.exec(gradle);
    assert.ok(m, 'build.gradle 里没有读 package.json');
    // rootProject 是 settings.gradle 所在的目录
    assert.equal(path.resolve(ANDROID, m[1]), path.join(ROOT, 'package.json'), m[1]);
    assert.match(gradle, /versionName appVersion/);
    assert.doesNotMatch(gradle, /versionName\s+['"]/);
  });

  test('package.json 的版本号是 X.Y.Z', () => {
    assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  });
});
