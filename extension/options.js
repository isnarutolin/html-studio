// options.js — 选项页：批注同步目标 + 本地程序检测
const $ = (s) => document.querySelector(s);

function setState(el, text, cls) {
  el.textContent = text;
  el.className = 'state' + (cls ? ' ' + cls : '');
}

/* ---------------- 本地程序（native host） ---------------- */
// content script 不能直接调 sendNativeMessage，走 background 转发（和页面里同一套协议）
function callNative(msg) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage({ type: 'hs-native', msg }, (resp) => {
      const err = chrome.runtime.lastError;
      if (err) return reject(new Error(err.message || '无法连接本地程序'));
      if (!resp) return reject(new Error('本地程序无响应'));
      if (resp.ok === false) return reject(new Error(resp.error || '本地程序出错'));
      resolve(resp);
    });
  });
}

async function checkNative() {
  const state = $('#nativeState');
  const hint = $('#nativeHint');
  setState(state, '正在检测…');
  setState(hint, '');
  try {
    const r = await callNative({ op: 'ping' });
    setState(state, '✓ 已安装，可以写回磁盘', 'ok');
    if (r && r.version) setState(hint, 'v' + r.version);
  } catch (e) {
    setState(state, '✗ 未安装 —— 保存将改为浏览器下载', 'bad');
    setState(hint, '装法：python3 extension/install.py');
  }
}
$('#btnRecheck').addEventListener('click', checkNative);

/* ---------------- 批注同步配置 ---------------- */
function normalize(url) {
  return String(url || '').trim().replace(/\/+$/, '');
}

function load() {
  chrome.storage.local.get({ hsSync: false, hsServer: '' }, (v) => {
    $('#sync').checked = !!v.hsSync;
    $('#server').value = v.hsServer || '';
  });
}

$('#btnSave').addEventListener('click', () => {
  const server = normalize($('#server').value);
  const sync = $('#sync').checked;
  if (sync && !server) {
    setState($('#testState'), '开启同步必须填服务器地址', 'bad');
    return;
  }
  if (server && !/^https?:\/\//i.test(server)) {
    setState($('#testState'), '地址要以 http:// 或 https:// 开头', 'bad');
    return;
  }
  chrome.storage.local.set({ hsSync: sync, hsServer: server }, () => {
    setState($('#testState'), '已保存，刷新页面后生效', 'ok');
  });
});

$('#btnTest').addEventListener('click', async () => {
  const server = normalize($('#server').value);
  const el = $('#testState');
  if (!server) return setState(el, '先填地址', 'bad');
  setState(el, '测试中…');
  try {
    const r = await fetch(server + '/api/health', { cache: 'no-store' });
    const j = await r.json();
    if (j && j.ok) setState(el, '✓ 连上了（' + (j.root ? '目录 ' + j.root : 'ok') + '）', 'ok');
    else setState(el, '✗ 有响应但看起来不是批注服务', 'bad');
  } catch (e) {
    setState(el, '✗ 连不上：' + (e.message || e), 'bad');
  }
});

// 让用户少踩坑：https 页面连 http 服务器会被浏览器拦
$('#server').addEventListener('input', () => {
  const v = normalize($('#server').value);
  if (/^http:\/\//i.test(v)) {
    setState($('#testState'), '提示：http 服务器只能给 http 页面同步（https 页面会被 mixed content 拦）');
  } else {
    setState($('#testState'), '');
  }
});

checkNative();
load();
