# AGENTS.md

本文件适用于仓库根目录及全部子目录，供 AI coding agents 与维护者理解 Offline JS Lab。修改架构、IPC、运行状态机、持久化键、设计系统或开发命令时，必须同步更新本文件和 README。

## 1. 产品定位

Offline JS Lab 是 Electron 本地 JavaScript / TypeScript Scratchpad，而不是完整 IDE：

- 左侧 Monaco Editor；
- 右侧 stdout、stderr、编译及 npm 输出；
- 手动运行与 500 ms 防抖实时运行；
- 标准 npm CLI 管理工作区依赖；
- macOS 开发、Windows 公司内网使用；
- 当前优先单人、`npm start`、本地工作流。

不要主动扩展账号、云同步、遥测、自动更新、插件市场、团队协作、远程执行、多文件 IDE 或恶意代码沙箱。

## 2. v0.3.2 技术栈

- Electron：窗口、菜单、对话框、文件系统、IPC；
- electron-vite：分别构建 Main、Preload、Renderer；
- `scripts/ensure-electron.mjs`：在开发启动前准备 Electron 42+ 按需下载的本机二进制；
- Vue 3 + `<script setup lang="ts">`：Renderer UI；
- TypeScript：Main、Preload、Shared、Renderer；
- Monaco Editor：代码编辑与语言服务；
- esbuild：将用户 JS/TS 打包成临时 ESM；
- 系统 Node.js 子进程：执行用户代码；
- 系统 npm CLI：工作区依赖；
- Vitest：单元和结构测试；
- 原生 CSS：Cyberdeck 设计系统，不引入 UI 框架。

## 3. 必须保持的安全边界

1. Renderer 必须保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
2. Preload 只通过 `contextBridge` 暴露 `OfflineJsLabBridge` 中具名 API；禁止暴露通用 `ipcRenderer.send/invoke`。
3. Main IPC handler 必须验证发送页面。
4. 用户脚本不得在 Vue 主线程或 Electron 主进程执行。
5. JS/TS 先由 esbuild 输出临时 `.mjs`，再用独立 Node 进程运行。
6. npm 与用户脚本拥有当前用户权限；不要将进程隔离宣传为安全沙箱。
7. 禁止 CDN、远程字体、远程 UI 素材、遥测和运行时外部资源。
8. 所有变更同时考虑 macOS 与 Windows 路径、快捷键和进程行为。
9. 不重新加入运行超时。8 MB 输出上限是缓冲保护，不是超时。

## 4. 工程分层

```text
src/main
```

只处理 Electron 生命周期、系统能力、工作区、npm、运行进程和 IPC。不要把 Vue 状态放入 Main。

```text
src/preload
```

只做安全桥接与事件订阅，不放业务状态，不直接暴露 Electron 对象。

```text
src/shared
```

放 IPC 常量和跨进程 TypeScript 类型。新增或更改 payload 必须先修改这里，再同步 Main、Preload、Renderer。

```text
src/renderer
```

Vue 应用、Monaco、composables 与 CSS。Renderer 不直接使用 `fs`、`child_process`、`electron` 或 Node 全局。

## 5. 关键文件职责

- `scripts/ensure-electron.mjs`：检查 `electron/path.txt` 与可执行文件，并在缺失时调用本地 `install-electron`。
- `src/main/index.ts`：BrowserWindow、菜单、可信 IPC、文件对话框。
- `src/main/runtime.ts`：Node/npm 路径解析与子进程环境。
- `src/main/workspace.ts`：默认工作区、原子设置写入、package.json、包与 `.d.ts` 扫描。
- `src/main/npm-manager.ts`：参数校验、npm spawn、输出转发与停止。
- `src/main/run-manager.ts`：esbuild、Node spawn、输出限制、停止与清理。
- `src/main/runner.cjs`：导入编译后的临时模块并处理未捕获错误。
- `src/preload/index.ts`：实现 `OfflineJsLabBridge`。
- `src/renderer/src/main.ts`：Renderer 启动边界；先校验 Preload bridge，再动态导入并挂载 `App.vue`。
- `src/renderer/src/startup-error.ts`：Vue/Monaco 挂载前失败时渲染可读错误页，禁止回退为纯黑窗口。
- `src/renderer/src/App.vue`：应用级状态与跨组件编排。
- `MonacoEditor.vue`：Monaco 生命周期、快捷键、类型定义注入。
- `OutputConsole.vue`：输出显示、自动跟随、清空设置。
- `PackageDialog.vue`：工作区与 npm 低频操作。
- `useResizableSplit.ts`：分栏比例与拖拽。
- `useOutputBuffer.ts`：ANSI 清理、分块合并与 revision。
- `monaco.ts`：Monaco 0.56 modular imports、Worker、TS/JS defaults、主题。
- `styles.css`：全局 Cyberdeck 设计系统、响应式和动画。

## 6. 启动与执行链路

```text
npm start
  -> npm lifecycle: prestart
  -> npm run electron:ensure
  -> 检查 node_modules/electron/path.txt 与平台可执行文件
  -> 缺失时运行本地 install-electron --no
  -> electron-vite dev
  -> Main 创建安全 BrowserWindow
  -> Preload 暴露 window.offlineJsLab
  -> main.ts 校验 window.offlineJsLab
  -> 动态 import App.vue（失败时显示 startup-error）
  -> Vue mount
  -> bootstrap:get
  -> 初始化工作区/包状态/Node runtime
  -> 扫描 .d.ts
  -> Monaco ready
  -> 关闭启动自检覆盖层
```

启动准备规则：

- Electron 42+ 不再依赖 npm `postinstall` 自动下载二进制；不得删除 `prestart` / `predev` / `prepreview` 的准备步骤。
- 已存在有效 `path.txt` 与目标可执行文件时必须快速退出，不重复下载。
- 不覆盖 `ELECTRON_MIRROR`、代理、证书或 npm 配置，沿用用户/公司环境。
- 检测到 `ELECTRON_SKIP_BINARY_DOWNLOAD` 时明确失败，不伪装成安装成功。
- Electron 版本升级时同步更新 `electron.vite.config.ts` 中明确声明的 Node/Chromium build target。
- 不直接修改 `node_modules/electron-vite` 作为长期修复。

运行代码：

```text
App.vue runCode()
  -> 可选清空输出
  -> run:start
  -> RunManager + esbuild
  -> .offline-js-lab/runs/<uuid>.mjs
  -> 系统 Node + runner.cjs
  -> run:output
  -> run:exit
  -> 删除临时文件
```

## 7. 实时运行状态机

`App.vue` 必须保持以下不变量：

- 同一时间最多一个脚本进程；
- 快速连续编辑只执行最新代码；
- 防抖时间默认 500 ms；
- npm 操作期间不启动脚本；
- 编辑发生在旧进程运行期间时，先停止旧进程，再执行最新版本；
- `run:start` Promise 返回前可能已收到 `run:exit`，所以保留 `completedRuns` 处理早到退出事件；
- 旧进程的 output/exit 不得覆盖当前新进程状态；
- 切回手动模式时取消待执行自动任务；
- 普通进程自然退出后立即结束“运行中”，不得依赖计时器。

修改相关逻辑时必须测试普通结束、编译失败、长驻脚本手动停止与连续编辑。

## 8. 输出清理行为

唯一状态源是：

```ts
clearOutputOnRun
```

- 默认 `true`；
- 手动和实时运行共用同一判断；
- 开启时，在本次运行分隔行之前清空；
- 关闭时追加；
- `PURGE` 永远只清空当前输出，不修改设置；
- 持久化键：`offlineJsLab.clearOutputOnRun`。

禁止重新写成“手动追加、实时清空”两套硬编码分支。

## 9. Renderer 持久化键

| Key | 类型 | 默认值 |
|---|---|---|
| `offlineJsLab.code` | string | 示例代码 |
| `offlineJsLab.language` | `typescript` / `javascript` | `typescript` |
| `offlineJsLab.runMode` | `manual` / `live` | `manual` |
| `offlineJsLab.clearOutputOnRun` | boolean string | `true` |
| `offlineJsLab.splitRatio` | number string | `0.5` |

新增键时：

- 提供安全默认值；
- 容忍缺失和非法旧值；
- Vue state、控件与存储保持一致；
- 在本表和 README 中登记。

工作区路径不在 localStorage，而在 Electron `userData/settings.json`，由 `WorkspaceService` 管理。

## 10. 工作区与 npm

默认工作区：

```text
macOS:   ~/Documents/OfflineJsLabWorkspace
Windows: %USERPROFILE%\Documents\OfflineJsLabWorkspace
```

结构：

```text
OfflineJsLabWorkspace/
├─ package.json
├─ package-lock.json          # npm 生成后存在
├─ node_modules/
└─ .offline-js-lab/
   └─ runs/
```

规则：

- 调用当前环境 Node/npm；
- 沿用项目、用户、全局 `.npmrc`，兼容内网 Registry；
- 源码禁止硬编码 Registry、Token、账号、证书或代理；
- 安装附加 `--no-audit --no-fund --color=false`；
- npm 输出进入 Output Console；
- npm 结束后刷新包状态和 `.d.ts`；
- npm 与脚本执行不得同时启动；
- 当前个人工具允许标准 npm 生命周期脚本，只安装可信包。

## 11. Electron / electron-vite 兼容性

当前组合：

```text
Electron 44.2.0
electron-vite 5.0.0
Node target node24.18
Chromium target chrome152
```

Electron 42 起把平台二进制下载从 npm `postinstall` 改为第一次运行 CLI 时按需执行，而 electron-vite 5.0.0 会先直接读取 `electron/path.txt`。因此项目必须保留 `scripts/ensure-electron.mjs` 和 npm lifecycle hook 来打破这一启动顺序冲突。

electron-vite 5.0.0 内建 Electron 版本目标表暂未覆盖 44，所以 `electron.vite.config.ts` 显式指定 Electron 44 对应的 Node/Chromium target。升级 Electron 时必须查询该 Electron 版本实际内嵌的 Node 与 Chromium，再同步配置与测试。

## 12. Monaco 约束

Monaco 0.56 使用 modular exports：

```ts
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/javascript/register'
import {
  ModuleKind, ModuleResolutionKind, ScriptTarget,
  javascriptDefaults, typescriptDefaults
} from 'monaco-editor/languages/features/typescript/register'
```

不要退回已经失效的 `monaco-editor/basic-languages/...` 或旧 `esm/vs/...` 路径。也不要再尝试从 `(monaco as any).typescript` 或 `monaco.languages.typescript` 猜测 API；Monaco 0.56 自定义入口下必须使用 `register` 模块的具名导出，否则会在 Vue 挂载前抛错并导致黑屏。

更改 Monaco 时验证：

- 编辑器加载；
- TS/JS 诊断；
- TS Worker 正确分流；
- Lodash 类型补全；
- 主题；
- `npm start` 与生产构建路径。


启动错误边界必须保持：

- `main.ts` 在静态加载 Vue 与全局 CSS 后，动态导入 `App.vue`；
- 动态导入、Preload bridge 校验或 `createApp().mount()` 失败时调用 `renderStartupFailure()`；
- `index.html` 保留 `renderer-loading` 占位，避免初始化阶段只看到黑色背景；
- 错误详情使用 `textContent` 写入，禁止把异常字符串拼进 `innerHTML`；
- 不要为了隐藏错误而吞掉 `console.error`。

工具链约束：

- 禁止重新固定 `vue-tsc` 3.1.6；该版本会在部分 Vue 3.5.25 模板上于 `walkObjectLiteral` 内部崩溃；
- 只读 `computed()` 的公开类型使用 `ComputedRef<T>`，不要写 `ReturnType<typeof computed<T>>`，后者会错误匹配 writable overload；
- 升级 Vue、TypeScript 或 vue-tsc 时必须实际运行 `npm run typecheck:web`。

## 13. Vue 组件约定

- 组件 props/events 必须有 TypeScript 类型；
- 顶层异步流程集中在 `App.vue`，可复用纯逻辑放 composable；
- 子组件不直接调用 IPC，除非未来明确建立独立领域 service；
- 需要跨进程的状态不要用隐式全局；
- 对话框使用 Teleport 与 Vue Transition；
- 不使用浏览器原生 `confirm()`；
- 键盘操作与可见按钮必须保持等价；
- 模板中的低频控件不得挤占主编辑/输出区域。

## 14. Cyberdeck 设计系统

此 UI 是原创的赛博朋克 HUD 风格，不复制游戏资产。

颜色语义：

- `--cyber-yellow`：主操作、执行、焦点；
- `--cyber-cyan`：数据链路、正常连接、输出系统信息；
- `--cyber-red`：错误、中止、危险确认；
- `--cyber-green`：成功、已安装、在线状态；
- 深色中性色：内容背景与层级。

交互规则：

- 主屏保持代码/输出双栏；
- 斜切角与扫描线是装饰，不得覆盖可点击区域；
- hover/active 反馈保持 100–200 ms；
- glitch 只用于 Logo 或状态，不用于正文；
- 运行动画不能导致布局抖动；
- 必须维护 `prefers-reduced-motion`；
- 文字对比度和 focus-visible 不得删除；
- 禁止为了“更像游戏”引入远程字体、图片、视频或音效。

## 15. 常用命令

```bash
npm install
npm run electron:ensure
npm start
npm run check:source
npm run typecheck
npm test
npm run check
npm run build
```

可选构建：

```bash
npm run dist:mac
npm run dist:win
npm run dist:nsis
npm run dist:portable
```

## 16. 测试与交付

变更前至少运行：

```bash
npm run check
```

Renderer/UI 改动还要人工检查：

1. 清空 Electron 二进制后，首次 `npm start` 能自动准备；第二次启动不会重复下载；
2. macOS 和 Windows 标题栏不挡控件；
3. 启动自检能够结束；
4. Monaco 显示并能输入；
5. 人为破坏 App/Monaco 导入时显示启动诊断页，而不是纯黑；
6. 分栏拖动、双击、键盘微调；
7. Manual / Live；
8. RUN:CLEAR 开关与 PURGE；
9. 普通脚本完成后不残留运行中；
10. 长驻脚本可 ABORT；
11. 新建、打开、保存、另存为；
12. Dependency Matrix 安装 Lodash/Day.js；
13. 窗口缩至最小尺寸无关键控件重叠；
14. 减少动态效果设置下无持续扫描动画。

AI agent 完成修改时：

- 总结架构和行为变化；
- 列出实际运行的检查；
- 不声称未执行的 Electron 实机测试已经通过；
- 更新版本号、README、AGENTS；
- 不提交 `node_modules`、`out`、`release` 或工作区内容。
