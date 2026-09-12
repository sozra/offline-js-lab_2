# Offline JS Lab v0.4.0

Offline JS Lab 是一个运行在本机的 JavaScript / TypeScript Scratchpad，也支持 React JSX / TSX 交互组件预览。它使用 Electron、Vue 3、electron-vite、TypeScript、Monaco Editor 与 esbuild，目标是在不依赖账号或在线服务的前提下，提供接近 RunJS 的快速编辑与运行体验。

v0.3.x 将此前的原生 HTML/CSS/JavaScript Renderer 重构为 Vue 技术栈，并加入一套受《赛博朋克 2077》界面语言启发的原创 Cyberdeck UI。项目没有使用游戏字体、Logo、截图、音效或其他专有素材。

v0.3.5 把隐式输出扩展到独立函数调用：`calculate()` 和 `await loadData()` 的返回值未被赋值或传给其他函数时，会像外层包了 `console.log()` 一样显示 `⇒` 结果。调用只执行一次，返回 `undefined` 时保持安静，显式 `console.*` 也不会重复输出。

v0.3.4 增加源代码行对齐输出与隐式纯表达式结果。`LINE:SYNC` 开启时，显式 `console.log/info/warn/error/debug` 和隐式值会按 Monaco 的源行高度排列，并与编辑器双向同步滚动；关闭后仍显示原有的完整时间顺序输出。像 `value`、`value > 10`、`obj.key` 这样的无副作用表达式会直接显示结果，无需再包一层 `console.log()`。

v0.3.3 修复 Windows 环境中 Monaco 可能只剩语法高亮、却缺少悬浮说明、格式化菜单和 `Ctrl + /` 注释快捷键的问题。Renderer 改用 Monaco 0.56 完整入口，显式开启 JS/TS 语言能力、强制 Vite 单实例解析，并增加 TypeScript Worker 连通性自检与跨键盘布局快捷键兜底。

v0.3.2 修复 Monaco 0.56 自定义入口使用错误导致的 Renderer 挂载前黑屏，修正两个只读 `computed` 的 TypeScript 类型，并避开 `vue-tsc` 3.1.6 的模板 codegen 崩溃。启动阶段现在始终显示加载占位；若 Vue、Monaco 或 Preload 初始化失败，会直接显示错误诊断而不是纯黑窗口。

v0.3.1 修复 Electron 42+ 延迟下载二进制与 electron-vite 5 启动方式不兼容而导致的 `Error: Electron uninstall`。

v0.3.6 修正脚本编译目标：探测实际执行的系统 Node.js 版本，esbuild 不再使用 Electron 内嵌 Node 版本作为用户脚本 target。`OFFLINE_JS_LAB_NODE` 显式配置优先；无效配置显示诊断，不静默切换运行环境。

v0.3.7 准备本地 React JSX/TSX 预览后端与输入/输出协议：预览使用独立 WebContentsView、内存资源和专用 Preload，禁止应用 bridge、远程网络与导航；编译失败保留上次页面。Node 增加原始源码行列映射、有界对象快照、`lab.input` / `lab.inputText` 输入和用户触发的进程树强制停止。最近文件由 Main 原子保存到 userData，仅记住用户打开或保存过的文件。v0.4.0 将这些能力接入主界面，并加入输入、片段收藏、运行历史和比较。

## v0.4.0 使用指南

### Node 脚本与 React 组件

语言选择区区分 Node JavaScript / TypeScript 和 React JSX / TSX。Node 模式保留原有表达式隐式输出、顶层 await 和 npm 包能力；React 模式默认导出组件，右侧显示可交互预览，也能切换到控制台。

在「依赖」中安装工作区依赖（应用不使用 CDN，也不会自动联网安装）：

```bash
npm install react react-dom
npm install -D @types/react @types/react-dom
```

「片段与模板」提供可直接载入的 JSX 计数器与 TSX 数据组件。例如：

```tsx
import { useState } from 'react'

export default function App() {
  const [count, setCount] = useState(0)
  return <button onClick={() => setCount(count + 1)}>点击 {count} 次</button>
}
```

预览在独立浏览器环境执行，支持 hooks、DOM、事件、本地 CSS 与图片/字体导入。它不提供 `fs`、Node 内置模块或应用文件/npm API。所有资源来自本地构建；远程网络、导航、新窗口及设备权限被禁用。

Manual / Live 均可用于组件。编译成功才替换画面；编译失败保留上次成功预览并显示错误。每次成功运行重建组件、重置状态；「重启预览」同时清理旧页面的计时器和事件。预览卡住时可停止并重新运行，没有自动脚本运行超时。

### 输入数据

编辑器下方的「输入数据」可折叠，支持 JSON 或纯文本，最多 512 K 字符。格式化保留原始数字文本与重复键，不执行用户代码；JSON 无效（包括空 JSON 文本）时不能运行。运行时仍按 JavaScript 的 JSON 语义解析输入。

```ts
// JSON 输入示例：[{ "amount": 12 }, { "amount": 8 }]
const records = lab.input as Array<{ amount: number }>
records.reduce((sum, item) => sum + item.amount, 0)

// 纯文本和 JSON 都能读取原始文本
lab.inputText
```

输入在运行开始时生成快照，对 Node 和 React 使用同一 API。修改输入也会触发 Live 防抖。输入随会话、收藏和运行快照保存；保存 `.js/.ts/.jsx/.tsx` 文件只保存源码，不会把输入偷偷写进代码文件。

### 查看、固定与比较结果

- 输出可按文本搜索、类型筛选、复制单条文本；对象支持展开检查和数组表格。
- 「复制快照 JSON」导出输出时的有限快照，特殊值、访问器、循环引用和截断使用标记保留，不承诺恢复任意原始 JavaScript 对象。
- 运行选择器可以查看当前会话最近 12 次运行；总序列化预算为 12 M 字符。每次保留代码、输入、语言与输出，超限会明确标记截断。
- 「固定结果」将选中运行保存为比较基线；再执行或选中另一次运行后点击「比较」，查看 stdout/stderr/表达式文本的新增与删除，并可恢复任一侧代码和输入。
- 固定基线最多 1 M 字符，在重启后保留；保存失败会提示，不会假装固定成功。普通运行历史只保留在当前会话。
- 比较每侧最多 500 行、100,000 字符；已截断的历史/缓冲不能被当成完整一致的证据。
- `LINE:SYNC` 只对齐当前或选中的一次运行；关闭后可看完整时间顺序。源码或输入变化时显示过期提示，暂停旧位置跳转与双向滚动，恢复对应快照后才能准确定位。
- `RUN:CLEAR` 仍是手动和 Live 共用的唯一清空偏好；「清空」不修改偏好和固定基线。

错误位置从原始源码映射到 Monaco 行列。点击源位置可跳转并高亮；属于其他文件的错误不会错误定位到当前编辑器。

### 片段、文件与恢复

「片段与模板」支持收藏当前代码、语言、输入，搜索、改名、删除和载入。最多 60 个收藏，总容量 2 M 字符；内置空白 JS/TS、JSON 数据处理、异步、正则、React JSX/TSX 模板。覆盖当前修改前使用应用确认框。检测到损坏或未知版本的收藏数据时保留原记录并进入只读恢复状态，避免新收藏覆盖原始数据。

应用恢复草稿时保留原文件路径和保存基线，避免恢复文本后错误显示已保存。「最近文件」记住最多 12 个明确打开/保存过的路径。文件选择仍由 Main 处理，不建立文件树或多文件 IDE。

窗口关闭、页面重新加载或 Renderer 崩溃时，Main 会停止原页面拥有的 Node/npm 操作和组件预览，避免恢复后遗留无法从新页面停止的后台任务。

npm 安装期间可以继续编辑，暂缓运行。依赖弹窗显示阻塞原因、操作日志和中止入口；npm 日志独立保留最近 1 M 字符，不会被下一次运行清空。Node/npm 路径、实际 Node 版本和工作区信息可用于排查内网环境。

确认框的 Enter 只触发当前聚焦按钮；危险操作默认聚焦取消，Tab 保持在模态内，关闭后恢复焦点。模态打开时屏蔽应用菜单与编辑器的运行/文件快捷键，原生预览也会隐藏。

### 完整界面冒烟测试

先执行 `npm run build`，再运行 `npm run test:electron -- --dependencies=/绝对路径/node_modules`。依赖目录需包含本地 `react` 和 `react-dom`；省略时会明确跳过 React 场景。默认使用启动测试的系统 Node，也可传 `--node=/绝对路径/node` 指定可执行文件。

脚本使用真实 Electron 窗口、Monaco 键盘输入、应用 IPC 和组件交互，只有原生打开/保存对话框的路径选择被替换为测试文件。它在系统临时目录创建独立配置和工作区，保留报告及截图，不使用日常工作区。覆盖脚本结束与停止、Live 连续编辑、输入、固定比较、收藏、草稿恢复、React 交互与预览显隐、编译失败保留画面和最小窗口布局。

2026-09-12 在 macOS 验证：`npm run check` 通过，17 组共 120 项测试通过；生产构建与整 App 12 项 Electron 场景通过，Renderer 控制台错误为空，刷新后旧脚本进程确实退出且可再次运行。另在独立后端测试中验证了预览无限循环停止、8 MB 输出保护和多次运行复用一个 Session。Windows 路径有单元覆盖，尚未进行 Windows 实机验证；安装包签名及发布不在本次验证范围内。

## 主要能力

- 左侧 Monaco Editor 编写 JavaScript / TypeScript，右侧查看 stdout、stderr、编译信息和 npm 输出。
- 可用 `LINE:SYNC` 将打印结果与对应源代码行对齐；编辑器与输出区保持相同行高并同步滚动。
- 裸写纯表达式或有非 `undefined` 返回值的独立函数调用，即可查看 `⇒` 结果。
- 中间分隔条可拖动、方向键微调，双击或按 Home 恢复 50:50。
- 支持手动运行，以及停止输入约 500 ms 后自动执行的实时运行。
- 可设置每次手动或实时运行前是否清空输出，也可随时手动清空。
- JS/TS 通过 esbuild 打包，再交给独立 Node.js 子进程执行。
- 支持顶层 `await`、ESM、CommonJS `require()`、Node 内置模块、相对模块和工作区 npm 包。
- 通过标准 npm CLI 安装、同步、卸载 Lodash、Day.js 等包。
- 自动扫描工作区 `.d.ts` 并注入 Monaco 语言服务。
- 新建、打开、保存、另存为，以及未保存修改确认。
- macOS 与 Windows 共用同一套源码；当前阶段可只用 `npm start`。

## 开发环境

推荐：

- Node.js 22 或更高版本；
- npm 10 或更高版本；
- macOS 或 Windows；
- 首次安装应用依赖时能访问 npm Registry，或公司内网 npm 仓库。

安装并启动：

```bash
npm install
npm start
```

第一次执行 `npm start` 时，`prestart` 会先运行：

```bash
npm run electron:ensure
```

它会检查 `node_modules/electron/path.txt` 及其指向的本机可执行文件；Electron 二进制尚未准备好时，自动调用项目本地的 `install-electron`。后续启动只做快速存在性检查，不会重复下载。

需要单独重试安装时可以执行：

```bash
npm run electron:ensure
# 或 Electron 官方等价命令
npx install-electron --no
```

常用检查：

```bash
npm run check:source
npm run typecheck
npm test
npm run build
```

`npm start` 先确保 Electron 本机二进制存在，再启动 electron-vite 开发服务。修改 Vue、CSS、主进程或 Preload 后可以快速重载。当前使用场景不要求先构建 DMG 或 EXE。

## `Electron uninstall` 启动错误

这个文本容易被理解为 Electron 被卸载，实际表示 electron-vite 没有在 `node_modules/electron/path.txt` 找到已安装二进制路径。Electron 42 起不再在 npm `postinstall` 阶段下载自身，而会在第一次运行 Electron CLI 时按需下载；electron-vite 5.0.0 启动前直接读取 `path.txt`，因此会在二进制尚未生成时先报错。

v0.3.1 已通过 `prestart → electron:ensure` 处理这一顺序问题。旧版 v0.3.0 可以在项目目录临时执行：

```bash
npx install-electron --no
npm start
```

若安装脚本本身报下载、证书、代理或解压错误，再检查：

```bash
node -v
npm -v
npm config get registry
env | grep '^ELECTRON_'
```

不要设置 `ELECTRON_SKIP_BINARY_DOWNLOAD=1`。公司环境若不能访问 Electron 二进制下载地址，需要按公司镜像策略配置 Electron mirror；普通 npm Registry 能安装 `electron` 这个 JavaScript 包，并不一定代表可以取得体积较大的 Electron 平台二进制。

## v0.3.1 全黑窗口与 `vue-tsc` 3.1.6

旧版能启动 Electron、但窗口只有黑色背景时，主要原因不是 CSS：`monaco-editor/editor` 的自定义入口不会自动把 TypeScript API 挂载回 `monaco` 命名空间，而旧实现会在 Vue 挂载前读取这个不存在的 API 并抛错。由于当时入口使用静态 `import App from './App.vue'`，异常发生在 `createApp()` 之前，页面没有机会显示错误。

v0.3.2 改为从以下入口直接导入官方具名导出：

```ts
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  javascriptDefaults,
  typescriptDefaults
} from 'monaco-editor/languages/features/typescript/register'
```

Renderer 入口也改为动态导入 `App.vue`，并提供启动错误页。以后即使依赖入口再次变化，也会看到异常堆栈和 `RELOAD RENDERER`，而不是纯黑窗口。

同时，`vue-tsc` 3.1.6 与 Vue 3.5.25 的组合存在 `walkObjectLiteral` 内部崩溃。v0.3.2 固定使用已包含修复的 `vue-tsc` 3.3.11。升级旧目录后必须让 npm 更新开发依赖：

```bash
npm install
npm run check
npm start
```

若只是想先确认旧目录中的黑屏根因，也可在 Electron 窗口按 `Cmd + Option + I` 打开开发者工具；旧版通常会看到 `Monaco TypeScript language service 未加载` 一类启动异常。

## Windows 上 Monaco 语言能力缺失

v0.3.2 使用 Monaco 0.56 的自定义模块入口并手动组合编辑器贡献、JavaScript 定义和 TypeScript 语言功能。该组合在 macOS 上可以正常工作，但在部分 Windows 开发环境或 Vite 缓存状态下，可能出现“编辑器能显示并高亮，但高级能力没有完整注册”的退化状态：

- 鼠标悬浮变量、函数或 npm 包 API 时没有类型与注释；
- 右键菜单中没有格式化入口；
- `Ctrl + /` 不能切换行注释；
- 代码仍然可以编辑和运行，因此问题不容易在启动阶段暴露。

v0.3.3 改为 Monaco 官方完整入口：

```ts
import * as monaco from 'monaco-editor'
```

同时完成以下加固：

- 从同一个 `monaco.typescript` 实例取得 JS/TS defaults 与 Worker API；
- 在 electron-vite Renderer 配置中设置 `dedupe: ['monaco-editor']`；
- 通过 `setModeConfiguration()` 显式开启 hover、completion、signature help、diagnostics、formatting、rename、references、code actions 和 inlay hints；
- 编辑器选项显式设置 `contextmenu: true`、`hover.enabled: true`、`formatOnPaste` 与 `formatOnType`；
- 右键菜单固定提供“切换行注释”“切换块注释”“格式化文档”；
- 使用 `KeyboardEvent.code === 'Slash'` 为 Windows 非美式键盘布局提供 `Ctrl + /` 兜底；
- 创建编辑器后真正调用 TypeScript/JavaScript Worker，而不是只检查 API 是否存在。

编辑器标题右侧会显示类似：

```text
TS LANGUAGE SERVICE ONLINE // 24 TYPE FILES // 312 KB
```

若 Worker URL、CSP 或构建缓存导致语言服务启动失败，状态会变为：

```text
LANGUAGE SERVICE DEGRADED
```

完整错误同时写入右侧输出区，不再静默退化。

从 v0.3.2 原目录升级后，建议在 Windows PowerShell 清理一次旧的 Vite 预构建缓存：

```powershell
Remove-Item -Recurse -Force node_modules\.vite, out -ErrorAction SilentlyContinue
npm start
```

本次没有更改 npm 依赖版本，通常不必重新执行 `npm install`；使用完整 v0.3.3 源码首次启动时仍按正常流程执行 `npm install`。

## 应用依赖与脚本依赖

两类 `node_modules` 彼此独立：

```text
offline-js-lab/node_modules/
```

这是应用自身依赖，包括 Electron、Vue、Monaco、electron-vite 与 esbuild，由项目根目录的 `npm install` 生成。

```text
~/Documents/OfflineJsLabWorkspace/node_modules/              # macOS
%USERPROFILE%\Documents\OfflineJsLabWorkspace\node_modules\  # Windows
```

这是用户脚本运行时依赖。点击右上角 `MATRIX` 打开 Dependency Matrix，在其中安装：

```text
lodash dayjs
```

或直接进入工作区运行：

```bash
npm install lodash dayjs
npm install -D @types/lodash
```

脚本示例：

```ts
import _ from 'lodash'
import dayjs from 'dayjs'

const rows = [
  { projectName: 'A', value: 1 },
  { projectName: 'A', value: 2 },
  { projectName: 'B', value: 3 }
]

console.log(_.groupBy(rows, 'projectName'))
console.log(dayjs('20260908').format('YYYY-MM-DD'))
```

CommonJS 也可以使用：

```js
const _ = require('lodash')
const dayjs = require('dayjs')

console.log(_.uniq([1, 1, 2, 3]))
console.log(dayjs().format('YYYY-MM-DD HH:mm:ss'))
```

## 公司内网 npm 仓库

应用不维护第二套包管理器，也不在源码中硬编码 Registry、Token、证书或代理。它调用当前环境可用的 Node/npm，并沿用 npm 标准配置优先级中的项目、用户与全局 `.npmrc`。

只要公司 Windows 终端中下列命令可用，Dependency Matrix 通常也会使用同一内网配置：

```powershell
npm install lodash
```

仓库附有 `.npmrc.example`，仅用于说明配置形式，不包含真实地址或凭据。

## 运行模式

### MANUAL

通过以下方式运行：

- 点击 `EXECUTE`；
- macOS：`Cmd + Enter`；
- Windows：`Ctrl + Enter`。

### LIVE

切换到 `LIVE` 后，代码停止修改约 500 ms 会自动运行。快速连续输入只保留最后一次执行意图；若旧脚本仍在运行，应用会先终止旧进程，再执行最新代码。

### RUN:CLEAR

输出区顶部的 `RUN:CLEAR` 控制每次运行前是否清空：

- 开启：手动和实时运行都先清空；
- 关闭：每次结果追加到现有输出；
- `PURGE`：立即清空，但不改变设置。

该偏好保存为：

```text
offlineJsLab.clearOutputOnRun
```

### LINE:SYNC 与隐式表达式结果

输出区顶部的 `LINE:SYNC` 控制显示方式：

- 开启：带源位置的输出按源代码行排列，行高与 Monaco 的 21 px 行高一致；滚动任意一侧会同步另一侧；
- 关闭：恢复按实际发生时间追加的完整输出；
- 编译错误、`process.stdout.write()`、依赖包内部打印等没有可靠源位置的内容，会在对齐模式的 `UNMAPPED` 区显示；
- 该开关只改变输出展示，不改变脚本的执行次序。

以下表达式默认会像 Scratchpad/REPL 一样显示结果：

```ts
const price = 42
price                         // ⇒ 42
price > 20                    // ⇒ true
const summary = { price, active: true }
summary                       // ⇒ { price: 42, active: true }
function double(value: number) { return value * 2 }
double(price)                 // ⇒ 84
await Promise.resolve(price)  // ⇒ 42
```

独立函数调用和独立 `await` 调用会显示非 `undefined` 返回值；返回 `undefined` 的动作型函数只执行、不增加输出。已赋值的调用、作为参数传入的内层调用、`new`、赋值、自增/自减、`yield`、`delete` 和 `void` 不会被额外打印。显式的 `console.*` 也不会被隐式输出重复接管。

显示偏好保存为：

```text
offlineJsLab.alignOutputToSource
```

## 没有运行超时

v0.3.6 不包含 10/30/60 秒超时或隐藏计时器。普通脚本在 Node 子进程关闭时立即显示完成；包含 `setInterval()`、监听器或服务的脚本会持续运行，直到点击 `ABORT` 或使用 `Cmd/Ctrl + .`。

仍保留单次 8 MB 输出上限，避免无限打印拖垮界面。这是缓冲保护，不是超时。

## Vue Renderer 结构

```text
src/
├─ main/
│  ├─ index.ts               Electron 生命周期、窗口、IPC
│  ├─ source-instrumenter.ts 源行标注与隐式输出识别
│  ├─ run-manager.ts         esbuild 与 Node 子进程
│  ├─ npm-manager.ts         npm CLI 操作
│  ├─ runtime.ts             Node/npm 路径解析
│  ├─ workspace.ts           工作区、package.json、.d.ts
│  └─ runner.cjs             子进程入口
├─ preload/
│  └─ index.ts               contextBridge 白名单 API
├─ shared/
│  ├─ ipc.ts                 IPC channel 常量
│  └─ types.ts               主进程、Preload、Renderer 共享类型
└─ renderer/
   ├─ index.html
   └─ src/
      ├─ App.vue             应用状态与顶层编排
      ├─ components/
      │  ├─ MonacoEditor.vue
      │  ├─ OutputConsole.vue
      │  ├─ PackageDialog.vue
      │  ├─ ConfirmDialog.vue
      │  └─ ToastStack.vue
      ├─ composables/
      │  ├─ useOutputBuffer.ts
      │  ├─ useResizableSplit.ts
      │  └─ storage.ts
      ├─ monaco.ts           Worker、语言服务与主题
      ├─ startup-error.ts    Vue 挂载前失败的可视化诊断
      ├─ styles.css          Cyberdeck 设计系统与动画
      └─ main.ts
```

参考 Offline API Lab 的工程边界，Renderer 采用 Vue 3 + TypeScript，主进程、Preload 与共享模型也迁移到 TypeScript，并由 electron-vite 分别构建。

## UI / UX 设计

Cyberdeck 界面以以下原则实现：

- 主任务始终是“左边写代码、右边看结果”；
- 工作区和 npm 管理留在低频弹层；
- 黄色表示主操作，青色表示数据链路，红色表示中止或错误；
- 斜切边框、状态码、扫描线、轻微 glitch 和运行脉冲用于建立 HUD 层次；
- 动画不阻塞操作，所有平台统一启用完整动画，不跟随系统减少动态效果设置；
- 不加载 CDN、远程字体、远程图片或遥测资源；
- 窄窗口会逐步隐藏次要文字，而不是挤压编辑器和输出区。

## 快捷键

| 操作 | macOS | Windows |
|---|---|---|
| 新建 | `Cmd + N` | `Ctrl + N` |
| 打开 | `Cmd + O` | `Ctrl + O` |
| 保存 | `Cmd + S` | `Ctrl + S` |
| 另存为 | `Cmd + Shift + S` | `Ctrl + Shift + S` |
| 运行 | `Cmd + Enter` | `Ctrl + Enter` |
| 停止 | `Cmd + .` | `Ctrl + .` |
| 切换行注释 | `Cmd + /` | `Ctrl + /` |
| 切换块注释 | `Cmd + Shift + /` | `Ctrl + Shift + /` |
| 格式化文档 | `Shift + Option + F` | `Shift + Alt + F` |

## 本地持久化

Renderer 使用 `localStorage` 保存：

| Key | 用途 | 默认值 |
|---|---|---|
| `offlineJsLab.code` | 旧草稿键，仅用于迁移 | 内置示例 |
| `offlineJsLab.language` | 旧语言键，仅用于迁移 | `typescript` |
| `offlineJsLab.runMode` | 手动 / 实时 | `manual` |
| `offlineJsLab.clearOutputOnRun` | 运行前清空 | `true` |
| `offlineJsLab.alignOutputToSource` | 输出按源代码行对齐 | `false` |
| `offlineJsLab.splitRatio` | 左右分栏比例 | `0.5` |
| `offlineJsLab.documentSession` | version 1：代码、语言、输入、文件路径、dirty、保存基线 | 从旧草稿迁移或默认文档 |
| `offlineJsLab.snippetLibrary` | version 1：片段收藏 | 空列表 |
| `offlineJsLab.pinnedResult.v1` | 固定比较基线 | 无 |
| `offlineJsLab.inputCollapsed` | 输入面板折叠状态 | `true` |

工作区路径存放在 Electron `userData/settings.json`；最近文件在 `userData/recent-files.json` 原子保存。会话采用单键原子更新；非法旧数据使用安全默认值，存储不足会显示提示。

## 安全边界

Renderer 保持：

```text
nodeIntegration: false
contextIsolation: true
sandbox: true
```

Preload 只暴露具名、类型化 IPC API。用户代码在独立 Node 子进程中执行，不直接进入 Vue Renderer 或 Electron 主进程。

但当前定位是个人开发工具，不是恶意代码沙箱。脚本与 npm 包仍拥有当前操作系统用户权限，可以读取文件、访问网络、启动进程，并执行 npm 生命周期脚本。只应运行自己信任的代码与依赖。

## 构建

目前可只使用 `npm start`。需要构建时：

```bash
npm run dist:mac
```

```powershell
npm run dist:win
```

Windows 也可分别生成 NSIS 与 Portable：

```powershell
npm run dist:nsis
npm run dist:portable
```

未配置代码签名证书。

## 当前非目标

- 多标签页与项目文件树；
- 断点调试；
- 变量内联结果；
- 完整 IDE；
- 账号、云同步、遥测、自动更新；
- 不受信任代码沙箱；
- 重新加入运行超时。

维护或交给 AI coding agent 前，请先阅读根目录的 [`AGENTS.md`](./AGENTS.md)。

## 分阶段开发与回退

此次改动在 `codex/jsx-ux-lab` 分支完成，原始 `master` 保留在 `6508178`。阶段提交区分实际 Node 版本修正、构建产物清理、执行/预览后端和主界面工作流。`out/` 已移出 Git 跟踪，后续构建不会污染源码差异；不提交 node_modules、release 或用户工作区。

每个后端提交均先导出暂存代码到独立临时目录运行检查。完整应用烟雾测试使用独立临时 userData 与工作区，不读取或覆盖日常草稿、收藏及 npm 依赖。建议用 `git log --oneline --graph` 查看阶段，用 `git diff <阶段提交>..HEAD -- src tests` 定位差异。保留当前改动后可切回 `master`，或从某个阶段创建新的诊断分支。
