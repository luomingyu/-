// ============================================================
// 月度排课系统 · 本机服务器（局域网共享 + 数据落盘）
// ------------------------------------------------------------
// 功能：
//   1. 静态托管前端构建产物（app/dist）
//   2. 提供数据持久化 API（所有数据存本机 server-data/data.json）
//      - GET  /api/data  读取业务数据（内存缓存，重启时从磁盘加载）
//      - POST /api/data  写入业务数据（更新内存 + 防抖落盘，原子写）
//   3. 提供排课执行 API（方案 B：排课从浏览器迁移到服务器侧）
//      - POST /api/schedule  执行排课（入参业务数据，返回排课结果与报告）
//   4. 启动自检：检测到数据版本落后于当前代码时，自动重排升级后端数据
//   5. 启动时打印局域网访问地址，其他人同网段打开即用（免登录）
//
// 使用：
//   cd app && npm run build && npm run serve
// 或：
//   node server/index.mjs        （自动使用最后构建的 dist）
// ============================================================
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { runServerSchedule, needsScheduleUpgrade, upgradeStoredData, APP_VERSION } from './schedule.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(__dirname, '..');      // 项目根目录
const distDir = path.join(projectRoot, 'app', 'dist');  // 前端构建产物
const dataDir = path.join(projectRoot, 'server-data');
const dataFile = path.join(dataDir, 'data.json');

const PORT = Number(process.env.PORT) || 5000;
const SAVE_DEBOUNCE_MS = 500; // 落盘防抖，合并高频写入

// ---------- 数据持久化 ----------
// 内存中始终是最新数据；写盘做防抖 + 原子写（先写 .tmp 再改名），避免断电/崩溃产生半截文件
let latestData = null;
let saveTimer = null;

function loadDataFromDisk() {
  if (fs.existsSync(dataFile)) {
    try {
      latestData = JSON.parse(fs.readFileSync(dataFile, 'utf8'));
      console.log(`[数据] 已从磁盘加载: ${dataFile}`);
    } catch (err) {
      console.error(`[数据] 读取 ${dataFile} 失败，将按空数据启动:`, err.message);
      latestData = { availabilityFiles: [], courseSystemFiles: [], presetFiles: [], courses: [], scheduleReports: [] };
    }
  } else {
    latestData = { availabilityFiles: [], courseSystemFiles: [], presetFiles: [], courses: [], scheduleReports: [] };
    console.log('[数据] 首次启动，无历史数据文件');
  }
}

function writeDataToDisk() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(dataDir, { recursive: true });
      const tmpFile = dataFile + '.tmp';
      fs.writeFileSync(tmpFile, JSON.stringify(latestData, null, 2), 'utf8');
      fs.renameSync(tmpFile, dataFile);
      console.log(`[数据] 已保存 ${new Date().toLocaleTimeString()} (业务改动自动落盘)`);
    } catch (err) {
      console.error('[数据] 保存失败:', err.message);
    }
  }, SAVE_DEBOUNCE_MS);
}

// ---------- 静态托管 ----------
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.map': 'application/json'
};

function serveStatic(req, res) {
  let urlPath = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  if (urlPath === '/') urlPath = '/index.html';

  const filePath = path.join(distDir, urlPath);
  // 防目录穿越：确保解析后的路径仍在 dist 内
  if (!filePath.startsWith(distDir + path.sep) && filePath !== path.join(distDir, 'index.html')) {
    res.writeHead(403).end('Forbidden');
    return;
  }

  fs.readFile(filePath, (err, buf) => {
    // 缓存策略：
    //   - /assets/* 文件名带内容 hash → 长期缓存（immutable），构建后文件名变化自然失效
    //   - HTML / 其他文件 → no-store（完全禁止缓存），避免浏览器/代理缓存的旧 HTML 继续引用旧 bundle
    //     （no-cache 缺少校验头时部分浏览器/代理会直接复用缓存，导致旧 bundle 长期不被替换）
    const cacheControl = urlPath.startsWith('/assets/')
      ? 'public, max-age=31536000, immutable'
      : 'no-store, no-cache, must-revalidate';

    if (err) {
      // SPA 路由回退到 index.html
      if (!urlPath.includes('.')) {
        fs.readFile(path.join(distDir, 'index.html'), (err2, html) => {
          if (err2) {
            res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
            res.end(`找不到前端构建产物。\n请先在 app 目录执行: npm install && npm run build\n`);
            return;
          }
          res.writeHead(200, { 'Content-Type': MIME['.html'], 'Cache-Control': cacheControl });
          res.end(html);
        });
        return;
      }
      res.writeHead(404).end('Not Found');
      return;
    }
    res.writeHead(200, {
      'Content-Type': MIME[path.extname(filePath)] || 'application/octet-stream',
      'Cache-Control': cacheControl
    });
    res.end(buf);
  });
}

// ---------- 路由 ----------
function readBody(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => { body += chunk; if (body.length > 32 * 1024 * 1024) { req.destroy(); reject(new Error('body too large')); } });
    req.on('end', () => resolve(body));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://localhost');

  // CORS（同源部署一般不需要，保留便于局域网内其它页面调试）
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') { res.writeHead(204).end(); return; }

  try {
    // 数据 API
    if (url.pathname === '/api/data') {
      if (req.method === 'GET') {
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(latestData));
        return;
      }
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        latestData = {
          availabilityFiles: Array.isArray(body.availabilityFiles) ? body.availabilityFiles : [],
          courseSystemFiles: Array.isArray(body.courseSystemFiles) ? body.courseSystemFiles : [],
          presetFiles: Array.isArray(body.presetFiles) ? body.presetFiles : [],
          courses: Array.isArray(body.courses) ? body.courses : [],
          scheduleReports: Array.isArray(body.scheduleReports) ? body.scheduleReports : []
        };
        writeDataToDisk();
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify({ ok: true }));
        return;
      }
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    // 排课 API（方案 B：排课在服务器侧执行）
    // 入参为 body 的 availabilityFiles/courseSystemFiles/currentDate，
    // 返回排课结果；是否落盘由前端收到结果后走既有 /api/data 持久化流程。
    if (url.pathname === '/api/schedule') {
      if (req.method === 'POST') {
        const body = JSON.parse(await readBody(req) || '{}');
        const result = runServerSchedule(body);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
        return;
      }
      res.writeHead(405).end('Method Not Allowed');
      return;
    }

    // 健康检查
    if (url.pathname === '/api/health') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true }));
      return;
    }

    // 其它一律走静态文件
    serveStatic(req, res);
  } catch (err) {
    console.error('[错误]', err.message);
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('服务器内部错误: ' + err.message);
  }
});

// ---------- 启动 ----------
function getLanIPs() {
  const ips = [];
  const nets = os.networkInterfaces();
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) ips.push(net.address);
    }
  }
  return ips;
}

// 校验 dist 是否存在
if (!fs.existsSync(path.join(distDir, 'index.html'))) {
  console.warn('⚠  未找到 ' + distDir + '，请先构建前端：');
  console.warn('   cd app && npm install && npm run build');
  console.warn('   （也可以先用 npm run dev 只做本地开发，但无法共享数据）');
} else {
  console.log('✔ 前端构建产物: ' + distDir);
}

loadDataFromDisk();

// 启动自检：数据版本落后于当前代码时，自动用当前版本重排并落盘
// （常态化解法：版本更新后无需手动重排，服务器启动即自动升级后端数据）
if (needsScheduleUpgrade(latestData)) {
  console.log(`[自检] 数据版本 ${latestData.scheduleReports?.[0]?.appVersion || '无版本字段'} ≠ 当前代码 ${APP_VERSION}，开始自动升级...`);
  const upgraded = upgradeStoredData(latestData);
  if (upgraded) {
    latestData = upgraded;
    writeDataToDisk();
    console.log(`[自检] 自动升级完成：数据已按版本 ${APP_VERSION} 重新排课并保存`);
  } else {
    console.warn('[自检] 自动升级失败，保持原数据启动（前端打开页面时会再尝试自动重排）');
  }
} else {
  console.log(`[自检] 数据版本已是最新 (${latestData.scheduleReports?.[0]?.appVersion || '无排课记录'})`);
}

server.listen(PORT, '0.0.0.0', () => {
  console.log('');
  console.log('═══ 月度排课系统 · 局域网共享已启动 ═══');
  console.log(`  本机访问:   http://localhost:${PORT}`);
  const ips = getLanIPs();
  ips.forEach(ip => console.log(`  局域网访问: http://${ip}:${PORT}`));
  console.log('');
  console.log(`  数据存于:   ${dataFile}`);
  console.log('  提示: 首次运行若弹出 Windows 防火墙提示，请勾选"专用网络"并允许访问，');
  console.log('        其他人即可在同一 WiFi/局域网内通过上面的地址打开使用。');
  console.log('  Ctrl+C 停止服务。');
  console.log('══════════════════════════════════════════');
});