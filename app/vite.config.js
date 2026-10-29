import { defineConfig } from 'vite'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// 构建期版本指纹：与 scripts/gen-version.mjs 同源（app/package.json 的 version），
// 构建产物额外输出 dist/version.json，供前端运行时自检「页面缓存版本 vs 服务器实际托管版本」。
function buildVersionInfo() {
  const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, 'package.json'), 'utf8'))
  const raw = String(pkg.version || '0.0.0')
  const appVersion = raw.startsWith('v') ? raw : `v${raw}`
  let gitSha = 'unknown'
  try {
    gitSha = execSync('git rev-parse --short HEAD', {
      cwd: __dirname,
      stdio: ['ignore', 'pipe', 'ignore']
    }).toString().trim() || 'unknown'
  } catch {
    // 非 git 环境降级：不影响构建
  }
  const p = (n) => String(n).padStart(2, '0')
  const d = new Date()
  const buildTime = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  return { appVersion, buildTime, gitSha }
}

function versionJsonPlugin() {
  return {
    name: 'emit-version-json',
    apply: 'build',
    generateBundle() {
      this.emitFile({
        type: 'asset',
        fileName: 'version.json',
        source: JSON.stringify(buildVersionInfo(), null, 2)
      })
    }
  }
}

export default defineConfig({
  // 相对路径 base：生产构建产物可部署到任意子路径（如 GitHub Pages 项目页面），
  // 开发模式（dev）下 Vite 始终使用绝对路径，不受影响
  base: './',
  server: {
    port: 5173,
    open: true
  },
  build: {
    outDir: 'dist'
  },
  plugins: [versionJsonPlugin()]
})
