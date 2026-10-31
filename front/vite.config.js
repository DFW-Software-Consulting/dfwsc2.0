import { realpathSync } from 'node:fs'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'


// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  build: {
    outDir: 'build-dist',
    emptyOutDir: true,
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    fs: {
      allow: [
        realpathSync(new URL('.', import.meta.url)),
        realpathSync(new URL('./node_modules', import.meta.url)),
      ],
    },
  },
  plugins: [
    react(),
    tailwindcss(),
  ],
})
