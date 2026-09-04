// ============================================================
// 持久化 IO 层：与「本机服务器」(server/index.mjs) 互通
// ------------------------------------------------------------
// - loadFromServer()：应用启动时把本机磁盘上的历史数据拉取到内存
// - schedulePersist()：业务数据一变，防抖发送给服务器落盘
// 约定：
//   - 服务器不可用（比如纯静态部署 / npm run dev）时静默跳过，
//     系统退化为"刷新即丢失"的本地模式，不影响原有功能。
// ============================================================

let timer = null;

/** 从服务器加载业务数据；失败返回 null */
export async function loadFromServer() {
  try {
    const res = await fetch('/api/data', { method: 'GET' });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

/** 防抖保存业务数据到服务器 */
export function schedulePersist(availabilityFiles, courseSystemFiles, courses, scheduleReports) {
  clearTimeout(timer);
  timer = setTimeout(async () => {
    try {
      await fetch('/api/data', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ availabilityFiles, courseSystemFiles, courses, scheduleReports })
      });
    } catch {
      // 服务器不可用时静默失败（本地模式）
    }
  }, 300);
}