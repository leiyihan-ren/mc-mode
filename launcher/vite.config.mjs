import { fileURLToPath, URL } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// 0.7.0 模块一：Feature 化目录重组后，所有内部引用统一走 @ 别名。
// 文件在 src/features/ 下移动时 import 路径保持不变，杜绝相对路径断裂。
export default defineConfig(({ mode }) => ({
  plugins: [react()],
  base: './',
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) }
  },
  // 0.7.0 模块一：生产构建剥离全部 console.*（含第三方依赖的调试输出），
  // 开发模式保留以便排错。产物级做到控制台零噪声。
  esbuild: mode === 'production' ? { drop: ['console'] } : {},
  server: { port: 5173, strictPort: true },
  build: { outDir: 'dist', chunkSizeWarningLimit: 2000 }
}))
