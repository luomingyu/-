// 入口：装配事件、启动首次渲染
import './styles/index.css';
import { subscribe, getState, hydrateFromServer, setStatus } from './state/store.js';
import { renderAll } from './render/index.js';
import { bindEvents } from './events/bindEvents.js';
import { ALGORITHM_VERSION } from './scheduler/report.js';

// 标题右侧展示排课算法版本（与报告/持久化数据中的版本号同源，避免手改不一致）
const versionBadge = document.getElementById('algorithmVersionBadge');
if (versionBadge) versionBadge.textContent = `算法 ${ALGORITHM_VERSION}`;

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
      ? `检测到算法版本已更新，已自动重新排课并同步服务器数据（${res.upgraded}）`
      : '已接入本机服务器：数据自动保存到本机电脑，可分享局域网链接给他人', 'info');
  }
});
