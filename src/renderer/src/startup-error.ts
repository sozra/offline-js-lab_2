function errorDetails(error: unknown): string {
  if (error instanceof Error) return error.stack || error.message
  return String(error)
}

function makeElement<K extends keyof HTMLElementTagNameMap>(
  tagName: K,
  className?: string,
  text?: string
): HTMLElementTagNameMap[K] {
  const element = document.createElement(tagName)
  if (className) element.className = className
  if (text !== undefined) element.textContent = text
  return element
}

/**
 * Vue/Monaco 在挂载前失败时显示可读诊断，避免只留下 BrowserWindow 的黑色背景。
 * 全程使用 textContent，不把异常字符串作为 HTML 注入。
 */
export function renderStartupFailure(error: unknown): void {
  const host = document.getElementById('app')
  if (!host) {
    console.error('[renderer] #app 容器不存在', error)
    return
  }

  const root = makeElement('main', 'startup-failure')
  const frame = makeElement('section', 'startup-failure__frame')
  const eyebrow = makeElement('div', 'startup-failure__eyebrow', 'RENDERER BOOT // FATAL')
  const title = makeElement('h1', 'startup-failure__title', '界面启动失败')
  const summary = makeElement(
    'p',
    'startup-failure__summary',
    'Renderer 在 Vue 挂载前发生异常。错误信息已直接显示，不会再只呈现黑屏。'
  )
  const details = makeElement('pre', 'startup-failure__details', errorDetails(error))
  const hint = makeElement(
    'p',
    'startup-failure__hint',
    '可按 ⌘⌥I（Windows：Ctrl+Shift+I）打开开发者工具，或重新加载界面。'
  )
  const actions = makeElement('div', 'startup-failure__actions')
  const reloadButton = makeElement('button', 'startup-failure__reload', 'RELOAD RENDERER')
  reloadButton.type = 'button'
  reloadButton.addEventListener('click', () => window.location.reload())

  actions.append(reloadButton)
  frame.append(eyebrow, title, summary, details, hint, actions)
  root.append(frame)
  host.replaceChildren(root)
}
