import { realpathSync } from 'node:fs'
import { build, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { prerender } from './scripts/prerender.mjs'

// After the client build: bundle src/entry-server.jsx for Node (`vite build --ssr`), then
// render the marketing routes to static HTML. Runs inside `vite build` so `npm run build`
// and the Dockerfile stay a single step.
function prerenderPlugin() {
  let isSsrBuild = false
  return {
    name: 'prerender',
    apply: 'build',
    configResolved(config) {
      isSsrBuild = Boolean(config.build.ssr)
    },
    async closeBundle() {
      if (isSsrBuild) return
      await build({ build: { ssr: 'src/entry-server.jsx', outDir: 'build-ssr' } })
      await prerender()
    },
  }
}


// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  build: {
    outDir: 'build-dist',
    emptyOutDir: true,
    chunkSizeWarningLimit: 560, // sized just above the lazy three.js HeroScene chunk (~535 kB); other chunks still warn
  },
  // The prerender build (`vite build --ssr`) bundles everything, including CSS-importing
  // packages, so the prerender script can import it from plain Node.
  ssr: { noExternal: true },
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
    prerenderPlugin(),
  ],
})
