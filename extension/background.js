// 点工具栏图标 = 开关编辑模式；如果当前页面注入不了（不是本地 html、
// 或没开「允许访问文件网址」），就把自检页打开，直接告诉用户缺什么。
chrome.action.onClicked.addListener(async (tab) => {
  if (tab && tab.id != null) {
    try {
      await chrome.tabs.sendMessage(tab.id, { type: 'html-studio-toggle' });
      return; // 页面里已有编辑器，切换成功
    } catch (e) {
      // 落下去打开自检页
    }
  }
  openSelfCheck();
});

function openSelfCheck() {
  const url = chrome.runtime.getURL('help.html');
  chrome.tabs.query({ url }, (tabs) => {
    if (tabs && tabs.length) {
      chrome.tabs.update(tabs[0].id, { active: true });
    } else {
      chrome.tabs.create({ url });
    }
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === 'install') openSelfCheck();
  console.log('[HTML Studio] 已安装。若本地页面没有 ✎，请打开自检页查看缺哪一步。');
});

// 内容脚本不能直接调 sendNativeMessage，这里代为转发。
const HOST_NAME = 'com.narutolin.htmlstudio';

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req || req.type !== 'hs-native') return undefined;
  chrome.runtime.sendNativeMessage(HOST_NAME, req.msg, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) sendResponse({ ok: false, error: err.message || '无法连接本地 host' });
    else if (!resp) sendResponse({ ok: false, error: '本地 host 无响应' });
    else sendResponse(resp);
  });
  return true; // 异步 sendResponse
});
