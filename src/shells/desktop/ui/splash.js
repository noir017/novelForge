/**
 * 启动页的三态渲染。
 *
 * 状态既 **拉** 也 **推**：页面加载完成的时刻与 Rust 侧 emit 的时刻没有先后保证，
 * 只监听会丢掉早于自己的那次推送，只拉又不知道后来变没变。所以 load 时 invoke
 * 一次 `boot_state`，之后跟着 `boot-state` 事件更新。
 *
 * 依赖 tauri.conf.json 的 `withGlobalTauri: true`——这一页是纯静态文件，
 * 没有打包步骤，只能用全局的 window.__TAURI__。
 */
const { invoke } = window.__TAURI__.core;
const { listen } = window.__TAURI__.event;

const el = (id) => document.getElementById(id);
const ui = {
  spinner: el('spinner'),
  title: el('title'),
  path: el('path'),
  detail: el('detail'),
  actions: el('actions'),
  retry: el('btnRetry'),
  pick: el('btnPick'),
  pickAgain: el('btnPickAgain'),
  logs: el('btnLogs'),
};

/** 每个按钮在哪些状态下出现。 */
const BUTTONS = {
  picking: ['pick'],
  failed: ['retry', 'pickAgain', 'logs'],
  starting: [],
};

function render(state) {
  const phase = state?.phase ?? 'starting';
  const visible = BUTTONS[phase] ?? [];

  ui.spinner.hidden = phase !== 'starting';
  ui.path.textContent = state?.project ?? '';
  ui.detail.hidden = !state?.message;
  ui.detail.textContent = state?.message ?? '';
  ui.actions.hidden = visible.length === 0;
  for (const key of ['retry', 'pick', 'pickAgain', 'logs']) {
    ui[key].hidden = !visible.includes(key);
  }

  if (phase === 'picking') {
    ui.title.textContent = '选择一个小说工程';
    ui.path.textContent = '可以是已有的工程目录，也可以是个空文件夹——空的会在里面引导你初始化。';
  } else if (phase === 'failed') {
    ui.title.textContent = '内置服务没起来';
  } else {
    ui.title.textContent = '正在启动 Novel Forge…';
  }
}

/** 点了按钮就回到「启动中」：命令本身是异步的，界面不该停在旧状态上。 */
function act(button, command, showSpinner = true) {
  button.addEventListener('click', () => {
    if (showSpinner) {
      render({ phase: 'starting', project: ui.path.textContent });
    }
    invoke(command).catch((err) => {
      render({ phase: 'failed', message: String(err) });
    });
  });
}

act(ui.retry, 'retry');
act(ui.pick, 'select_project');
act(ui.pickAgain, 'select_project');
// 「查看日志」不改状态：它只是开一个文件管理器窗口，失败界面得留着。
ui.logs.addEventListener('click', () => {
  invoke('open_logs').catch((err) => {
    ui.detail.hidden = false;
    ui.detail.textContent = String(err);
  });
});

listen('boot-state', (event) => render(event.payload));
invoke('boot_state').then(render).catch(() => render({ phase: 'starting' }));
