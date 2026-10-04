import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { fileURLToPath } from 'node:url'

export default defineConfig({
  root: fileURLToPath(new URL('./web', import.meta.url)),
  plugins: [react(), tailwindcss()],
  build: { outDir: '../dist', emptyOutDir: true },
  server: {
    host: '127.0.0.1',
    port: 5191,
    strictPort: true,
    proxy: {
      '/api': {
        target: 'http://127.0.0.1:8791',
        changeOrigin: true,
        configure(proxy) {
          proxy.on('proxyReq', (req, incoming) => {
            if (incoming.headers.origin === 'http://127.0.0.1:5191')
              req.setHeader('Origin', 'http://127.0.0.1:8791')
          })
        },
      },
      '/healthz': 'http://127.0.0.1:8791',
    },
  },
})
