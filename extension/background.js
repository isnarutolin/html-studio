// 点工具栏图标 = 开关编辑模式。
// 本地 html 页面里已经有 ✎，网页（http/https）默认不挂 ✎，靠这个图标进去；
// 如果当前标签页注入不了内容脚本（PDF、chrome:// 之类），就打开自检页说明缺什么。
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

const MENU_EDIT = 'hs-edit-page';
const MENU_HELP = 'hs-self-check';

function setupMenus() {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_EDIT,
      title: 'HTML Studio：编辑本页',
      contexts: ['page', 'selection', 'image'],
    });
    chrome.contextMenus.create({
      id: MENU_HELP,
      title: 'HTML Studio：自检 / 帮助',
      contexts: ['action'],
    });
  });
}

chrome.runtime.onInstalled.addListener((details) => {
  setupMenus();
  if (details.reason === 'install') openSelfCheck();
  console.log('[HTML Studio] 已安装。若本地页面没有 ✎，请打开自检页查看缺哪一步。');
});

chrome.runtime.onStartup && chrome.runtime.onStartup.addListener(setupMenus);

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === MENU_HELP) return openSelfCheck();
  if (info.menuItemId === MENU_EDIT && tab && tab.id != null) {
    chrome.tabs.sendMessage(tab.id, { type: 'html-studio-toggle' }, () => {
      // 注入不了的页面（PDF / chrome:// / 商店页）读 lastError 消掉告警，并给用户指路
      if (chrome.runtime.lastError) openSelfCheck();
    });
  }
});

// 内容脚本不能直接调 sendNativeMessage，这里代为转发。
const HOST_NAME = 'com.narutolin.htmlstudio';

chrome.runtime.onMessage.addListener((req, sender, sendResponse) => {
  if (!req) return undefined;

  if (req.type === 'hs-open-help') {
    openSelfCheck();
    return undefined;
  }

  if (req.type !== 'hs-native') return undefined;
  chrome.runtime.sendNativeMessage(HOST_NAME, req.msg, (resp) => {
    const err = chrome.runtime.lastError;
    if (err) sendResponse({ ok: false, error: err.message || '无法连接本地 host' });
    else if (!resp) sendResponse({ ok: false, error: '本地 host 无响应' });
    else sendResponse(resp);
  });
  return true; // 异步 sendResponse
});
