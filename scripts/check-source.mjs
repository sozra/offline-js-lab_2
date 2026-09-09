import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const root = path.resolve(import.meta.dirname, '..')
const requiredFiles = [
  'package.json',
  'README.md',
  'AGENTS.md',
  'electron.vite.config.ts',
  'scripts/ensure-electron.mjs',
  'src/main/index.ts',
  'src/main/run-manager.ts',
  'src/main/npm-manager.ts',
  'src/main/runner.cjs',
  'src/preload/index.ts',
  'src/shared/ipc.ts',
  'src/shared/types.ts',
  'src/renderer/index.html',
  'src/renderer/src/main.ts',
  'src/renderer/src/startup-error.ts',
  'src/renderer/src/App.vue',
  'src/renderer/src/monaco.ts',
  'src/renderer/src/styles.css'
]

const failures = []
for (const relativePath of requiredFiles) {
  if (!fs.existsSync(path.join(root, relativePath))) failures.push(`缺少必要文件：${relativePath}`)
}

const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
for (const name of ['vue', 'monaco-editor', 'esbuild']) {
  if (!packageJson.dependencies?.[name]) failures.push(`dependencies 缺少 ${name}`)
}
for (const name of ['electron', 'electron-vite', '@vitejs/plugin-vue', 'typescript', 'vue-tsc', 'vitest']) {
  if (!packageJson.devDependencies?.[name]) failures.push(`devDependencies 缺少 ${name}`)
}

if (packageJson.scripts?.['electron:ensure'] !== 'node scripts/ensure-electron.mjs') {
  failures.push('缺少 electron:ensure 二进制准备命令。')
}
if (packageJson.scripts?.prestart !== 'npm run electron:ensure') {
  failures.push('npm start 前必须自动准备 Electron 二进制。')
}

const rendererFiles = [
  'src/renderer/index.html',
  ...walk(path.join(root, 'src/renderer/src')).filter((file) => /\.(?:vue|ts|css)$/.test(file))
    .map((file) => path.relative(root, file))
]
const rendererSource = rendererFiles
  .map((file) => fs.readFileSync(path.join(root, file), 'utf8'))
  .join('\n')

if (/https?:\/\//i.test(rendererSource)) failures.push('Renderer 不得依赖远程 URL、字体或素材。')
if (/timeoutMs|offlineJsLab\.timeout/.test(rendererSource)) failures.push('Renderer 中检测到已移除的运行超时逻辑。')
if (!/prefers-reduced-motion/.test(rendererSource)) failures.push('设计系统缺少 prefers-reduced-motion。')
if (!/offlineJsLab\.clearOutputOnRun/.test(rendererSource)) failures.push('缺少运行前清空持久化键。')
if (!/<script setup lang="ts">/.test(rendererSource)) failures.push('Vue Renderer 未检测到 TypeScript script setup。')


const rendererMainSource = fs.readFileSync(path.join(root, 'src/renderer/src/main.ts'), 'utf8')
const monacoSource = fs.readFileSync(path.join(root, 'src/renderer/src/monaco.ts'), 'utf8')
const monacoEditorSource = fs.readFileSync(
  path.join(root, 'src/renderer/src/components/MonacoEditor.vue'),
  'utf8'
)
const electronViteSource = fs.readFileSync(path.join(root, 'electron.vite.config.ts'), 'utf8')
if (!/await import\(['"]\.\/App\.vue['"]\)/.test(rendererMainSource)) {
  failures.push('Renderer 必须动态导入 App.vue，以便启动失败时显示诊断界面。')
}
if (!/renderStartupFailure/.test(rendererMainSource)) {
  failures.push('Renderer 缺少启动失败可视化回退。')
}
if (!/import \* as monaco from ['"]monaco-editor['"]/.test(monacoSource)) {
  failures.push('Monaco 0.56 必须使用完整 monaco-editor 入口，确保所有编辑器贡献和语言功能被注册。')
}
if (!/monaco\.typescript/.test(monacoSource)) {
  failures.push('JS/TS 默认配置必须来自完整 Monaco 实例的顶层 typescript API。')
}
if (!/setModeConfiguration\(modeConfiguration\)/.test(monacoSource)) {
  failures.push('必须显式启用 JS/TS 悬浮、格式化、补全等语言能力。')
}
if (!/probeLanguageService/.test(monacoSource)) {
  failures.push('缺少 Monaco TypeScript Worker 实际连通性检测。')
}
if (!/dedupe:\s*\[['"]monaco-editor['"]\]/.test(electronViteSource)) {
  failures.push('Vite Renderer 必须去重 monaco-editor，避免产生多个 Monaco 模块实例。')
}
if (!/contextmenu:\s*true/.test(monacoEditorSource) || !/hover:\s*\{[\s\S]*enabled:\s*true/.test(monacoEditorSource)) {
  failures.push('MonacoEditor 必须显式开启右键菜单和悬浮提示。')
}
if (!/editor\.action\.commentLine/.test(monacoEditorSource) || !/event\.code === ['"]Slash['"]/.test(monacoEditorSource)) {
  failures.push('缺少 Ctrl/Cmd+/ 注释命令和 Windows 键盘布局兜底。')
}
if (!/editor\.action\.formatDocument/.test(monacoEditorSource)) {
  failures.push('缺少格式化文档操作。')
}
if (/candidate\.typescript|candidate\.languages\?\.typescript/.test(monacoSource)) {
  failures.push('不得从自定义 Monaco 入口猜测 TypeScript API。')
}
if (packageJson.devDependencies?.['vue-tsc'] === '3.1.6') {
  failures.push('vue-tsc 3.1.6 存在模板 codegen 崩溃问题，必须使用修复版本。')
}

const mainSource = fs.readFileSync(path.join(root, 'src/main/index.ts'), 'utf8')
if (!/nodeIntegration:\s*false/.test(mainSource)) failures.push('BrowserWindow 必须关闭 nodeIntegration。')
if (!/contextIsolation:\s*true/.test(mainSource)) failures.push('BrowserWindow 必须启用 contextIsolation。')
if (!/sandbox:\s*true/.test(mainSource)) failures.push('BrowserWindow 必须启用 sandbox。')

const preloadSource = fs.readFileSync(path.join(root, 'src/preload/index.ts'), 'utf8')
if (/exposeInMainWorld\([^)]*ipcRenderer/.test(preloadSource)) failures.push('Preload 不得直接暴露 ipcRenderer。')

if (failures.length > 0) {
  for (const failure of failures) console.error(`✗ ${failure}`)
  process.exitCode = 1
} else {
  console.log(`✓ 源码结构检查通过（${requiredFiles.length} 个必要文件）`)
}

function walk(directory) {
  if (!fs.existsSync(directory)) return []
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const fullPath = path.join(directory, entry.name)
    return entry.isDirectory() ? walk(fullPath) : [fullPath]
  })
}
