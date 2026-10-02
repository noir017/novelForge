// Novel Forge 独立版的 WebSocket 驱动：常驻连接，把 cmd.jsonl 新追加的每一行原样发给服务，
// 收到的消息写成摘要日志与几份「最新快照」，弹窗 / 权限卡片写进 pending.json 等人（或脚本）回答。
//
// 用法：node drv.mjs [--port 3680] [--state D:/tmp/nfdrv]
// 断线自动重连（服务重启后端口不变就能接上；服务端的批量任务不随连接断开而停）。
import fs from 'node:fs';
import path from 'node:path';

const arg = (name, dflt) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : process.env[`NF_${name.toUpperCase()}`] ?? dflt;
};
const PORT = arg('port', '3680');
const DIR = path.resolve(arg('state', path.join(process.cwd(), 'nf-state')));
fs.mkdirSync(DIR, { recursive: true });
const P = (f) => path.join(DIR, f);

const log = (s) => fs.appendFileSync(P('log.txt'), `[${new Date().toLocaleTimeString()}] ${s}\n`);
const pending = new Map();
const savePending = () => fs.writeFileSync(P('pending.json'), JSON.stringify([...pending.values()], null, 1));
savePending();
fs.writeFileSync(P('tasks.json'), '[]');
let cmdOffset = fs.existsSync(P('cmd.jsonl')) ? fs.statSync(P('cmd.jsonl')).size : 0;
const deltaLen = {};
let ws;

function connect() {
  ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
  ws.onopen = () => {
    log(`OPEN port=${PORT}`);
    ws.send(JSON.stringify({ type: 'ready' }));
  };
  ws.onclose = () => {
    // 未决的弹窗在服务端随连接断开按取消处理，这里也清掉，免得拿旧 requestId 去答。
    pending.clear();
    savePending();
    log('CLOSE, reconnect in 2s');
    setTimeout(connect, 2000);
  };
  ws.onerror = (e) => log('ERR ' + (e.message ?? e.type));
  ws.onmessage = (ev) => {
    const m = JSON.parse(ev.data);
    switch (m.type) {
      case 'delta':
      case 'toolDelta':
      case 'reasoning':
        deltaLen[m.type] = (deltaLen[m.type] || 0) + m.text.length;
        return;
      case 'writeProgress':
        fs.writeFileSync(P('progress.json'), JSON.stringify(m));
        return;
      case 'log':
        if (['warn', 'error'].includes(m.entry.level)) log('LOG ' + JSON.stringify(m.entry).slice(0, 600));
        return;
      case 'logs':
      case 'logHistory':
        return;
      case 'init':
      case 'state':
      case 'project':
      case 'pipeline':
      case 'session':
      case 'sessions':
      case 'settings':
      case 'workspaces':
      case 'skills':
        fs.writeFileSync(P(`last-${m.type}.json`), JSON.stringify(m, null, 1));
        if (!['session', 'state', 'init', 'pipeline', 'project'].includes(m.type)) log(m.type);
        return;
      case 'busy':
        fs.writeFileSync(P('busy.json'), JSON.stringify(m.value));
        log(`busy ${m.value}`);
        return;
      case 'tasks':
        fs.writeFileSync(P('tasks.json'), JSON.stringify(m.tasks, null, 1));
        return;
      case 'prompt':
      case 'gate':
        pending.set(m.requestId, m);
        savePending();
        log(`${m.type.toUpperCase()} ${m.requestId} ${JSON.stringify({ ...m, current: undefined, proposed: m.proposed?.length, argsText: m.argsText?.slice(0, 300) }).slice(0, 1500)}`);
        return;
      case 'gateDone':
        pending.delete(m.requestId);
        savePending();
        log(`gateDone ${m.requestId} ${m.verdict}`);
        return;
      case 'turnDone':
        log(`turnDone ${JSON.stringify(m.turn).slice(0, 400)} deltas=${JSON.stringify(deltaLen)}`);
        for (const k in deltaLen) delete deltaLen[k];
        return;
      case 'editorOpen':
      case 'dirListings':
        log(`${m.type} ${m.file?.path ?? ''}`);
        return;
      default:
        log(`${m.type} ${JSON.stringify(m).slice(0, 800)}`);
    }
  };
}
connect();

setInterval(() => {
  const f = P('cmd.jsonl');
  if (!fs.existsSync(f) || ws?.readyState !== WebSocket.OPEN) return;
  const size = fs.statSync(f).size;
  if (size <= cmdOffset) return;
  const buf = Buffer.alloc(size - cmdOffset);
  const fd = fs.openSync(f, 'r');
  fs.readSync(fd, buf, 0, buf.length, cmdOffset);
  fs.closeSync(fd);
  cmdOffset = size;
  for (const line of buf.toString('utf8').split('\n').filter(Boolean)) {
    const msg = JSON.parse(line);
    if (msg.type === 'promptResult' || msg.type === 'gateResult') {
      pending.delete(msg.requestId);
      savePending();
    }
    ws.send(JSON.stringify(msg));
    log('SENT ' + line.slice(0, 300));
  }
}, 500);
