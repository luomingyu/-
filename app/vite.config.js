import { defineConfig } from 'vite'

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
  }
})
