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

  let banner;
  function showBanner() {
    if (!banner) {
      banner = document.createElement('div');
      banner.style.cssText =
        'position:fixed;top:0;left:0;right:0;z-index:9999;' +
        'background:#b83e3e;color:#fff;padding:6px 12px;font-size:12px;text-align:center;';
      banner.textContent = '与服务器的连接已断开，正在重连…';
      document.body.appendChild(banner);
    }
    banner.style.display = '';
  }
  function hideBanner() {
    if (banner) banner.style.display = 'none';
  }

  window.acquireVsCodeApi = () => ({
    postMessage(msg) {
      if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
      else outbox.push(msg);
    },
    getState() {
      return undefined;
    },
    setState() {},
  });

  connect();
})();
