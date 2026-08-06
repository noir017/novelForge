// 独立版桥接：在 view.js 之前加载，把 WebSocket 伪装成 webview API。
// webview 环境（VS Code）里 acquireVsCodeApi 已存在，本文件直接退出。
(function () {
  if (typeof acquireVsCodeApi === 'function') return;

  let ws;
  let closed = false;
  const outbox = []; // 连接未就绪时暂存的消息

  function connect() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    ws = new WebSocket(`${proto}://${location.host}/ws`);
    ws.onopen = () => {
      hideBanner();
      for (const msg of outbox.splice(0)) ws.send(JSON.stringify(msg));
    };
    ws.onmessage = (event) => {
      const msg = JSON.parse(event.data);
      // view.js 用 window.addEventListener('message', e => e.data) 收消息，
      // dispatchEvent 与其完全兼容。
      window.dispatchEvent(new MessageEvent('message', { data: msg }));
    };
    ws.onclose = () => {
      if (closed) return;
      showBanner();
      setTimeout(connect, 1500);
    };
  }

  // 断线条挂在最顶上；样式走 standalone.css 的主题变量，不写死颜色。
  let banner;
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.className = 'wb-offline';
      banner.textContent = '与服务器的连接已断开，正在重连…（未保存的内容仍在页面里）';
      document.body.appendChild(banner);
    }
    banner.style.display = '';
  }
  function hideBanner() {
    if (banner) banner.style.display = 'none';
  }

  /**
   * webview 的 getState/setState 在浏览器里对应 localStorage。
   * view.js 用它存输入框草稿——网页会被刷新，比 webview 更需要这个。
   */
  const STATE_KEY = 'novelforge.viewState';
  let memoryState;

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else outbox.push(msg);
    },
    getState() {
      if (memoryState !== undefined) return memoryState;
      try {
        memoryState = JSON.parse(localStorage.getItem(STATE_KEY) || 'null') || undefined;
      } catch {
        memoryState = undefined;
      }
      return memoryState;
    },
    setState(state) {
      memoryState = state;
      try {
        localStorage.setItem(STATE_KEY, JSON.stringify(state));
      } catch {
        // 隐私模式下写不进去，退化为仅本次会话保留。
      }
      return state;
    },
  });

  connect();
})();
