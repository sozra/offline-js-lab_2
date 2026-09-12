import { resolve } from 'node:path'
import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import vue from '@vitejs/plugin-vue'

// Electron 44.2.0 embeds Node.js 24.20 and Chromium 152. Keep Node 24.18
// as a conservative application build target. electron-vite 5.0.0's
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
      target: electronNodeTarget,
      rollupOptions: {
        input: {
          index: resolve('src/preload/index.ts'),
          preview: resolve('src/preload/preview.ts')
        },
        // Sandboxed preloads cannot require a generated shared JS chunk.
        // Separate entry builds inline their small shared IPC constant.
        output: { entryFileNames: '[name].js' }
      }
    }
  },
  renderer: {
    root: resolve('src/renderer'),
    resolve: {
      alias: {
        '@renderer': resolve('src/renderer/src'),
        '@shared': resolve('src/shared')
      },
      // Monaco 的编辑器贡献、语言 API 与 Worker 必须解析到同一个包实例。
      // 显式去重可避免不同平台的 Vite 缓存产生重复模块图并让语言服务退化。
      dedupe: ['monaco-editor']
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
