// 入口：装配事件、启动首次渲染
import './styles/index.css';
import { subscribe, getState, hydrateFromServer, setStatus } from './state/store.js';
import { renderAll } from './render/index.js';
import { bindEvents } from './events/bindEvents.js';
import { APP_VERSION, GIT_SHA } from './config/constants.js';

// 应用版本徽标：只显示版本号。
// 版本号唯一真值为 app/package.json 的 version，由 scripts/gen-version.mjs 在构建期注入，
// 与服务器实际托管的构建产物同源，避免手工维护造成的显示/实际版本不一致。
const appVersionBadge = document.getElementById('appVersionBadge');
if (appVersionBadge) appVersionBadge.textContent = APP_VERSION;

// 订阅状态变更 → 全量重绘
subscribe((state) => renderAll(state));

// 绑定所有事件
bindEvents();

// 首屏渲染
renderAll(getState());

// 运行时版本自检：比对「运行中的 bundle」与「服务器实际托管的构建产物」（dist/version.json）。
// 不一致说明浏览器缓存了旧版本，提示强制刷新即可消除「显示版本 ≠ 已部署实际版本」。
async function checkVersionConsistency() {
  try {
    const res = await fetch(`./version.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!res.ok) return;
    const deployed = await res.json();
    const versionMatched = deployed.appVersion === APP_VERSION;
    // 非 git 环境（sha 为 unknown）时跳过 sha 比对，避免误报
    const shaComparable = deployed.gitSha && deployed.gitSha !== 'unknown' && GIT_SHA !== 'unknown';
    const shaMatched = !shaComparable || deployed.gitSha === GIT_SHA;
    if (versionMatched && shaMatched) return;
    setStatus('schedule',
      `检测到新版本：服务器为 ${deployed.appVersion} · ${deployed.gitSha}，当前页面为缓存旧版本（${APP_VERSION} · ${GIT_SHA}），请按 Ctrl+F5 强制刷新`,
      'warning');
  } catch {
    // 无 version.json（本地 dev / 纯静态部署）时跳过自检，不影响功能
  }
}

// 启动时尝试从本机服务器加载历史数据（局域网共享模式）。
// 服务器可用 → 数据自动保存到本机磁盘，其他人通过局域网链接访问同一份数据；
// 不可用（纯静态部署/本地开发）→ 静默退回本地模式，不影响原有功能。
hydrateFromServer().then((res) => {
  if (res && res.loaded) {
    if (res.upgraded) {
      setStatus('schedule', `检测到版本已更新，已自动重新排课并同步服务器数据（${res.upgraded}）`, 'info');
    } else if (res.stale) {
      setStatus('schedule',
        `数据版本（${res.stale}）与当前应用版本（${APP_VERSION}）不一致，且缺少课程体系数据无法自动重排；请导入课程体系后重新排课以刷新报告`,
        'warning');
    } else {
      setStatus('schedule', '已接入本机服务器：数据自动保存到本机电脑，可分享局域网链接给他人', 'info');
    }
  }
  checkVersionConsistency();
});
