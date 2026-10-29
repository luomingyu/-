// ============================================================
// 版本指纹生成：把「应用版本」收敛为单一真值（app/package.json 的 version）
// ------------------------------------------------------------
// 产物：app/src/config/version.generated.js
//   export const APP_VERSION / BUILD_TIME / GIT_SHA
// 该文件由本脚本生成（前端构建、dev、serve 前自动执行），
// 浏览器 bundle 与 Node 服务器（复用 app/src 排课模块）共用同一份值，
// 从而保证「页面徽标版本」「报告落库版本」「服务器版本」永不漂移。
// ============================================================
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { execSync } from 'node:child_process';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const appDir = path.resolve(__dirname, '..');

const pkg = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8'));
const rawVersion = String(pkg.version || '0.0.0');
const APP_VERSION = rawVersion.startsWith('v') ? rawVersion : `v${rawVersion}`;

// git 短 sha（非 git 环境/无 git 命令时降级为 unknown，不影响构建）
let GIT_SHA = 'unknown';
try {
  GIT_SHA = execSync('git rev-parse --short HEAD', {
    cwd: appDir,
    stdio: ['ignore', 'pipe', 'ignore']
  }).toString().trim() || 'unknown';
} catch {
  // 忽略：非 git 环境
}

const p = (n) => String(n).padStart(2, '0');
const d = new Date();
const BUILD_TIME = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;

const content = `// 本文件由 scripts/gen-version.mjs 自动生成，请勿手动修改。
// 版本唯一真值：app/package.json 的 version 字段（构建/dev/serve 前自动重算）。
export const APP_VERSION = '${APP_VERSION}';
export const BUILD_TIME = '${BUILD_TIME}';
export const GIT_SHA = '${GIT_SHA}';
`;

const target = path.join(appDir, 'src', 'config', 'version.generated.js');
fs.writeFileSync(target, content, 'utf8');
console.log(`[版本] 已生成 src/config/version.generated.js → ${APP_VERSION} · ${GIT_SHA} · ${BUILD_TIME}`);
