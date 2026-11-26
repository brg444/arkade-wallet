import path from 'path'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import eslint from 'vite-plugin-eslint'
import basicSsl from '@vitejs/plugin-basic-ssl'
import tailwindcss from '@tailwindcss/vite'
import basicAuth from './plugins/vite-plugin-basic-auth'

// https://vitejs.dev/config/
export default defineConfig({
  resolve: {
    alias: [
      { find: '@', replacement: path.resolve(__dirname, './src') },
      // Node built-ins pulled in by the USD account's lazy chunk (Satora SDK,
      // ZeroDev): Web Crypto for `crypto`, the `events` package for EventEmitter
      { find: /^(node:)?crypto$/, replacement: path.resolve(__dirname, './src/shims/node-crypto.ts') },
      { find: /^(node:)?events$/, replacement: path.resolve(__dirname, './node_modules/events/events.js') },
    ],
  },
  plugins: [
    basicAuth(),
    react(),
    tailwindcss(),
    eslint({
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: ['src/test/**/*.ts', 'src/test/**/*.tsx'],
      cache: false,
    }),
    process.env.HTTPS === 'true' && basicSsl(),
  ].filter(Boolean),
  server: {
    port: 3002,
    host: true,
    allowedHosts: ['.trycloudflare.com'],
    proxy: {
      '/predict-api/oracle/prices': {
        target: 'https://coinflip-mainnet-production.up.railway.app',
        changeOrigin: true,
        rewrite: () => '/oracle/prices',
      },
      '/predict-api/oracle/fixing': {
        target: 'https://coinflip-mainnet-production.up.railway.app',
        changeOrigin: true,
        rewrite: (p) => p.replace(/^\/predict-api/, ''),
      },
    },
  },
  build: {
    emptyOutDir: true,
    sourcemap: true,
    rollupOptions: {
      external: ['fs'],
    },
  },
  worker: {
    format: 'es',
  },
})
