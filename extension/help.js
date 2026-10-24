const $ = (s) => document.querySelector(s);
const EXT_ID = chrome.runtime.id;

function set(id, state, detail, pre) {
  const card = $('#' + id);
  card.className = 'card ' + state;
  card.querySelector('.ic').textContent =
    { ok: '✓', bad: '✕', warn: '!', wait: '•' }[state] || '•';
  $('#' + id.replace('c', 'd')).innerHTML = detail;
  if (pre) {
    const p = card.querySelector('pre');
    p.textContent = pre;
    p.style.display = 'block';
  }
}

// 1. 扩展本身
set('c1', 'ok', `已加载，ID <code>${EXT_ID}</code>，版本 ${chrome.runtime.getManifest().version}`);

// 2. 文件访问权限
function checkFileAccess() {
  if (!chrome.extension || !chrome.extension.isAllowedFileSchemeAccess) {
    set('c2', 'warn', '当前 Chrome 版本读不到这个权限状态，去 chrome://extensions → 详情 里手动确认「允许访问文件网址」已打开。');
    return;
  }
  chrome.extension.isAllowedFileSchemeAccess((allowed) => {
    if (allowed) {
      set('c2', 'ok', '已开启 —— 扩展可以注入本地 html 页面。');
      $('#btnGo').style.display = 'none';
    } else {
      set('c2', 'bad',
        '未开启，所以本地 html 页面不会有 ✎ 按钮。<br>开启方法：<b>chrome://extensions</b> → 找到 HTML Studio → 点「<b>详情</b>」→ 打开「<b>允许访问文件网址</b>」，然后刷新本地页面。');
      const b = $('#btnGo');
      b.style.display = 'inline-block';
      b.onclick = () => chrome.tabs.create({ url: `chrome://extensions/?id=${EXT_ID}` });
    }
  });
}
checkFileAccess();
// 从 chrome://extensions 改完开关回来时自动复检
window.addEventListener('focus', () => setTimeout(checkFileAccess, 300));

// 3. native host
chrome.runtime.sendNativeMessage('com.narutolin.htmlstudio', { op: 'ping' }, (resp) => {
  const err = chrome.runtime.lastError;
  if (err) {
    set('c3', 'bad',
      '连不上本地服务，保存会失败。在终端跑一次注册脚本，然后<b>完全退出并重开 Chrome</b>：',
      `cd ~/html-studio/extension\npython3 install.py\n# 检查：python3 install.py --check\n\n错误信息：${err.message}`);
    return;
  }
  if (!resp || resp.ok !== true) {
    set('c3', 'bad', '本地服务有响应但返回异常：', JSON.stringify(resp, null, 2));
    return;
  }
  set('c3', 'ok',
    `已连通，版本 ${resp.version}。备份目录：<code>${resp.backupRoot}</code>`);
});
