/**
 * 临时工程的收尾。
 *
 * **必须先关库再删目录**：SQLite 连接开着时 Windows 上删不掉
 * `.novelforge/novelforge.db`，临时工程会全留在 temp 里（EBUSY）。迁移前这条只有
 * 两个脚本做对，另有一个脚本从不删目录——每跑一次泄漏一个临时工程。
 */
const fs = require('fs');

/**
 * 关库（如果这组测试碰过库）再删目录。两步都不抛：收尾失败不该盖掉真正的失败原因。
 * @param {string} dir 临时目录
 * @param {{ resetDatabases?: () => void }} [db] 载入的 `src/core/runtime/db.ts`，没碰过库就不用传
 */
function cleanup(dir, db) {
  if (db && typeof db.resetDatabases === 'function') {
    try {
      db.resetDatabases();
    } catch {
      /* 关不掉也要接着删 */
    }
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true });
  } catch {
    /* 删不掉就算了，不要盖掉真正的失败 */
  }
}

module.exports = { cleanup };
