import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// Electron 44 embeds Node.js 24.18 and Chromium 152. electron-vite 5.0.0's
// built-in version table currently stops at Electron 41, so keep the targets
// explicit instead of allowing an unknown major to fall back to stale values.
const electronNodeTarget = 'node24.18'
const electronChromeTarget = 'chrome152'

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@main': resolve('src/main'),
        '@shared': resolve('src/shared')
      }
    },
    build: {
      target: electronNodeTarget
    }
  },
  preload: {
    plugins: [externalizeDepsPlugin()],
    resolve: {
      alias: {
        '@shared': resolve('src/shared')
      }
    },
    build: {
      target: electronNodeTarget
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      }
    },
    plugins: [vue()],
    worker: {
      format: 'es'
    },
    build: {
      target: electronChromeTarget
    }
  }
})
