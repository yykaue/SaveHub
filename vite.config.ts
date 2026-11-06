import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Vite 渲染进程构建配置：在生产构建时自动剥离开发服务器 WebSocket CSP 许可
export default defineConfig(({ command }) => ({
  plugins: [
    react(),
    {
      name: 'savehub-production-csp',
      transformIndexHtml(html) {
        return command === 'build' ? html.replace(' ws://127.0.0.1:5173', '') : html;
      },
    },
  ],
  base: './',
  server: { host: '127.0.0.1', port: 5173, strictPort: true },
  build: { outDir: 'dist', sourcemap: false },
}));
