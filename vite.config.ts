import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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
