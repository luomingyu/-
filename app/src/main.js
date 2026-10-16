// 入口：装配事件、启动首次渲染
import './styles/index.css';
import { subscribe, getState, hydrateFromServer, setStatus } from './state/store.js';
import { renderAll } from './render/index.js';
import { bindEvents } from './events/bindEvents.js';
import { ALGORITHM_VERSION } from './scheduler/report.js';
import { APP_VERSION } from './config/constants.js';

// 标题右侧展示排课算法版本（仅算法标识；报告与持久化数据的版本号已统一为应用版本 APP_VERSION）
const versionBadge = document.getElementById('algorithmVersionBadge');
if (versionBadge) versionBadge.textContent = `算法 ${ALGORITHM_VERSION}`;

// 应用版本徽标（与开发文档版本历史同步，v5.94 起独立于算法版本展示）
const appVersionBadge = document.getElementById('appVersionBadge');
if (appVersionBadge) appVersionBadge.textContent = `应用 ${APP_VERSION}`;

// 订阅状态变更 → 全量重绘
subscribe((state) => renderAll(state));

// 绑定所有事件
bindEvents();

// 首屏渲染
renderAll(getState());

// 启动时尝试从本机服务器加载历史数据（局域网共享模式）。
// 服务器可用 → 数据自动保存到本机磁盘，其他人通过局域网链接访问同一份数据；
// 不可用（纯静态部署/本地开发）→ 静默退回本地模式，不影响原有功能。
hydrateFromServer().then((res) => {
  if (res && res.loaded) {
    setStatus('schedule', res.upgraded
      ? `检测到版本已更新，已自动重新排课并同步服务器数据（${res.upgraded}）`
      : '已接入本机服务器：数据自动保存到本机电脑，可分享局域网链接给他人', 'info');
  }
});
