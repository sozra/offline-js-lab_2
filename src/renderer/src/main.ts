import { createApp } from 'vue'
import './styles.css'
import { renderStartupFailure } from './startup-error'

let rendererMounted = false

window.addEventListener('error', (event) => {
  if (!rendererMounted) renderStartupFailure(event.error ?? event.message)
})

window.addEventListener('unhandledrejection', (event) => {
  if (!rendererMounted) renderStartupFailure(event.reason)
})

async function bootstrapRenderer(): Promise<void> {
  try {
    if (!window.offlineJsLab) {
      throw new Error('Electron preload bridge 未加载：window.offlineJsLab 不存在。')
    }

    const host = document.getElementById('app')
    if (!host) throw new Error('Renderer 缺少 #app 挂载容器。')

    // 动态导入确保 App.vue / Monaco 模块初始化失败时能够渲染诊断界面。
    const { default: App } = await import('./App.vue')
    const app = createApp(App)
    let mountError: unknown
    app.config.errorHandler = (error, _instance, info) => {
      mountError = error
      console.error(`[renderer] Vue mount error (${info})`, error)
    }
    app.mount(host)

    if (mountError !== undefined) {
      app.unmount()
      throw mountError
    }

    rendererMounted = true
  } catch (error) {
    console.error('[renderer] bootstrap failed', error)
    renderStartupFailure(error)
  }
}

void bootstrapRenderer()
