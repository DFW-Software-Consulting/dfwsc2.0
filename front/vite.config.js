import { realpathSync } from 'node:fs'
import { resolve } from 'node:path'
import { build, defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { prerender } from './scripts/prerender.mjs'

// After the client build: bundle src/entry-server.jsx for Node (`vite build --ssr`), then
// render the marketing routes to static HTML. Runs inside `vite build` so `npm run build`
// and the Dockerfile stay a single step.
function prerenderPlugin() {
  let config
  let buildFailed = false
  return {
    name: 'prerender',
    apply: 'build',
    configResolved(resolved) {
      config = resolved
    },
    buildEnd(error) {
      if (error) buildFailed = true
    },
    async closeBundle() {
      // closeBundle also runs after a failed build, and for the nested SSR build.
      if (buildFailed || config.build.ssr) return
      const serverDir = resolve(config.root, 'build-ssr')
      await build({ build: { ssr: 'src/entry-server.jsx', outDir: serverDir } })
      await prerender({ clientDir: resolve(config.root, config.build.outDir), serverDir })
    },
  }
}

// https://vite.dev/config/
export default defineConfig({
  envDir: '../',
  build: {
    outDir: 'build-dist',
    emptyOutDir: true,
    manifest: true, // read by the prerender step to link each page's CSS and JS chunks (removed after)
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
