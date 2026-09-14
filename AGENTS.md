# AGENTS.md

本文件适用于仓库根目录及全部子目录，供 AI coding agents 与维护者理解 Offline JS Lab。修改架构、IPC、运行状态机、持久化键、设计系统或开发命令时，必须同步更新本文件和 README。

## 1. 产品定位

Offline JS Lab 是 Electron 本地 JavaScript / TypeScript Scratchpad，而不是完整 IDE：

- 左侧 Monaco Editor；
- 右侧 stdout、stderr、编译及 npm 输出，或独立 React JSX/TSX 组件预览；
- 手动运行与 500 ms 防抖实时运行；
- 标准 npm CLI 管理工作区依赖；
- macOS 开发、Windows 公司内网使用；
- 当前优先单人、`npm start`、本地工作流。

不要主动扩展账号、云同步、遥测、自动更新、插件市场、团队协作、远程执行、多文件 IDE 或恶意代码沙箱。

## 2. v0.4.3 技术栈

- Electron：窗口、菜单、对话框、文件系统、IPC；
- electron-vite：分别构建 Main、Preload、Renderer；
- `scripts/ensure-electron.mjs`：在开发启动前准备 Electron 42+ 按需下载的本机二进制；
- Vue 3 + `<script setup lang="ts">`：Renderer UI；
- TypeScript：Main、Preload、Shared、Renderer，并以编译器 API 识别用户源码表达式；
- Monaco Editor：代码编辑与语言服务；
- esbuild：将用户 JS/TS 打包成临时 ESM；
- 系统 Node.js 子进程：执行用户代码；
- 系统 npm CLI：工作区依赖；
- Vitest：单元和结构测试；
- 原生 CSS：Cyberdeck 设计系统，不引入 UI 框架。
- React/ReactDOM：来自用户工作区 npm 的组件预览运行时，不替换 Vue 应用外壳。

## 3. 必须保持的安全边界

1. Renderer 必须保持 `nodeIntegration: false`、`contextIsolation: true`、`sandbox: true`。
2. Preload 只通过 `contextBridge` 暴露 `OfflineJsLabBridge` 中具名 API；禁止暴露通用 `ipcRenderer.send/invoke`。
3. Main IPC handler 必须验证发送页面。
4. 用户脚本不得在 Vue 主线程或 Electron 主进程执行。
5. JS/TS 先由 TypeScript AST 做保守的源行标注，再由 esbuild 输出临时 `.mjs`，最后用独立 Node 进程运行；AST 阶段不得执行用户代码。
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
- `scripts/package.mjs`：打包参数预检、本地 Electron 选择、源码构建与 electron-builder 公共 API 编排；不执行外部 Electron，不改写开发二进制。
- `src/main/index.ts`：BrowserWindow、菜单、可信 IPC、文件对话框。
- `src/main/runtime.ts`：Node/npm 路径解析与子进程环境。
- `src/main/workspace.ts`：默认工作区、原子设置写入、package.json、包与 `.d.ts` 扫描。
- `src/main/npm-manager.ts`：参数校验、npm spawn、输出转发与停止。
- `src/main/source-instrumenter.ts`：识别可定位的 console 调用、纯表达式与未使用返回值的独立调用，只生成文本插入，不执行源码。
- `src/main/run-manager.ts`：源码标注、esbuild、Node spawn、fd 3 结构化输出、输出限制、停止与清理。
- `src/main/runner.cjs`：导入编译后的临时模块、格式化行定位输出并处理未捕获错误。
- `src/preload/index.ts`：实现 `OfflineJsLabBridge`。
- `src/renderer/src/main.ts`：Renderer 启动边界；先校验 Preload bridge，再动态导入并挂载 `App.vue`。
- `src/renderer/src/startup-error.ts`：Vue/Monaco 挂载前失败时渲染可读错误页，禁止回退为纯黑窗口。
- `src/renderer/src/App.vue`：应用级状态与跨组件编排。
- `MonacoEditor.vue`：Monaco 生命周期、显式编辑命令、Windows 键盘布局兜底、Worker 自检、类型定义注入和对齐模式滚动同步。
- `OutputConsole.vue`：顺序/源行对齐输出、自动跟随、滚动同步与输出设置。
- `PackageDialog.vue`：工作区与 npm 低频操作。
- `useResizableSplit.ts`：分栏比例与拖拽。
- `useOutputBuffer.ts`：ANSI 清理、分块合并与 revision。
- `monaco.ts`：Monaco 0.56 完整入口、单实例 TS/JS API、Worker、自检、mode configuration 与主题。
- `jsxTypeSupport.ts`：根据工作区 JSX runtime 声明选择 Monaco noEmit 检查模式；不修改预览构建模式。
- `ResultDiffEditor.vue`：结果只读 Monaco 双栏差异、行内高亮与差异导航；销毁时释放两个模型、编辑器和订阅。
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
  -> source-instrumenter 标注 console 与隐式输出源行
  -> RunManager + esbuild
  -> .offline-js-lab/runs/<uuid>.mjs
  -> 系统 Node + runner.cjs
  -> stdout/stderr + fd 3 结构化行定位输出
  -> run:output（可选 sourceLine）
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

源行输出规则：

- `console.log/info/warn/error/debug` 必须保持原参数只求值一次，并携带调用起始行；
- 裸的变量、属性、字面量、比较、逻辑与条件表达式可产生 `expression` 输出；
- 独立函数调用和独立 `await` 调用可产生 `expression` 输出，但返回 `undefined` 时必须保持安静，且调用只能求值一次；
- 显式 `console.*`、已赋值或作为参数传入的内层调用不得重复隐式打印；`new`、赋值、自增/自减、`yield`、`delete`、`void` 不得隐式打印；
- 字符串指令序言（如 `"use strict"`）不得被改写；
- fd 3 的结构化输出与普通 stdout/stderr 共用 8 MB 上限；
- `LINE:SYNC` 只改变 Renderer 展示；关闭后必须能看到完整时间顺序输出；
- 对齐模式行高与 Monaco `lineHeight: 21`、`padding.top: 15` 保持一致，并双向同步垂直滚动；
- 无 `sourceLine` 的错误、原始进程输出和依赖包输出在 `UNMAPPED` 区可见。

## 9. Renderer 持久化键

| Key | 类型 | 默认值 |
|---|---|---|
| `offlineJsLab.code` | string，旧键只迁移 | 示例代码 |
| `offlineJsLab.language` | 旧语言键只迁移 | `typescript` |
| `offlineJsLab.runMode` | `manual` / `live` | `manual` |
| `offlineJsLab.clearOutputOnRun` | boolean string | `true` |
| `offlineJsLab.alignOutputToSource` | boolean string | `false` |
| `offlineJsLab.splitRatio` | number string | `0.5` |
| `offlineJsLab.documentSession` | version 1 JSON：code/language/input/filePath/dirty/lastSavedCode | 迁移旧草稿或默认 |
| `offlineJsLab.snippetLibrary` | version 1 JSON：snippets | 空列表 |
| `offlineJsLab.pinnedResult.v1` | RunSnapshot JSON | 无 |
| `offlineJsLab.inputCollapsed` | boolean string | `true` |

新增键时：

- 提供安全默认值；
- 容忍缺失和非法旧值；
- Vue state、控件与存储保持一致；
- 在本表和 README 中登记。

工作区路径不在 localStorage，而在 Electron `userData/settings.json`，由 `WorkspaceService` 管理。

脚本编译目标必须取实际系统 Node 的版本探测结果（按命令与参数缓存），不得取 Electron Main 的 `process.versions.node`；版本探测失败必须诊断。`OFFLINE_JS_LAB_NODE` 显式配置优先。环境版本探测可以限时，用户脚本本身无运行超时。

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
Embedded Node 24.20.0（实机验证；应用构建沿用下面的保守 target）
electron-vite 5.0.0
Node target node24.18
Chromium target chrome152
```

Electron 42 起把平台二进制下载从 npm `postinstall` 改为第一次运行 CLI 时按需执行，而 electron-vite 5.0.0 会先直接读取 `electron/path.txt`。因此项目必须保留 `scripts/ensure-electron.mjs` 和 npm lifecycle hook 来打破这一启动顺序冲突。

electron-vite 5.0.0 内建 Electron 版本目标表暂未覆盖 44，所以 `electron.vite.config.ts` 显式指定 Electron 44 对应的 Node/Chromium target。升级 Electron 时必须查询该 Electron 版本实际内嵌的 Node 与 Chromium，再同步配置与测试。

## 12. Monaco 约束

Monaco 0.56 必须使用完整官方入口：

```ts
import * as monaco from 'monaco-editor'
```

项目刻意不再使用 `monaco-editor/editor` 加多个副作用 `register` 的自定义组合。完整入口会加载全部编辑器 features 与 languages，可避免不同平台或 Vite 预构建缓存只保留 tokenizer、却遗漏 hover、formatter、context menu command 等能力。

必须保持以下不变量：

- TypeScript/JavaScript API 从同一个 `monaco.typescript` 运行时对象取得；
- `electron.vite.config.ts` 的 Renderer 保留 `dedupe: ['monaco-editor']`；
- `MonacoEnvironment.getWorker()` 将 `javascript` / `typescript` 映射到 TS Worker，其余映射到 Editor Worker；
- `typescriptDefaults` 和 `javascriptDefaults` 都显式调用 `setModeConfiguration()`，开启 hover、completion、formatting、diagnostics 等能力；
- 编辑器显式启用 `contextmenu` 与 `hover`；
- `MonacoEditor.vue` 保留行注释、块注释与格式化文档 action；
- `Ctrl/Cmd + /` 除 Monaco keybinding 外，还要保留基于 `KeyboardEvent.code === 'Slash'` 的捕获级兜底，以兼容 Windows 键盘布局；
- 创建编辑器和切换语言后调用 `probeLanguageService()`，实际取得 Worker 并执行诊断；不能只检查对象是否存在；
- Worker 失败时通过 `language-service` 事件把可见诊断传给 `App.vue`，不得静默显示为“在线”。

不要重新引入以下模式：

```ts
import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
// 再通过其他入口拼接 JS/TS language features
```

也不要使用旧的 `monaco-editor/basic-languages/...`、`esm/vs/...` 私有路径，或加载两个不同 Monaco 实例。

更改 Monaco 时至少在 macOS 与 Windows 人工验证：

1. 编辑器正常加载、输入和撤销；
2. 悬浮本地变量、带 JSDoc 的函数和 Lodash API 会显示类型/注释；
3. 右键菜单包含注释与格式化操作；
4. `Ctrl/Cmd + /` 切换行注释；
5. `Ctrl/Cmd + Shift + /` 切换块注释；
6. `Shift + Alt/Option + F` 格式化文档；
7. 标题状态显示 `TS/JS LANGUAGE SERVICE ONLINE`；
8. 人为破坏 Worker 映射后显示 `LANGUAGE SERVICE DEGRADED`，并在输出区写入错误；
9. npm 类型定义扫描后 Lodash/Day.js 补全可用；
10. `npm start` 与生产构建中的 Worker URL 都正确。

启动错误边界必须保持：

- `main.ts` 在静态加载 Vue 与全局 CSS 后，动态导入 `App.vue`；
- 动态导入、Preload bridge 校验或 `createApp().mount()` 失败时调用 `renderStartupFailure()`；
- `index.html` 保留 `renderer-loading` 占位，避免初始化阶段只看到黑色背景；
- 错误详情使用 `textContent` 写入，禁止把异常字符串拼进 `innerHTML`；
- 不要为了隐藏错误而吞掉 `console.error`。

工具链约束：

- 禁止重新固定 `vue-tsc` 3.1.6；该版本会在部分 Vue 3.5.25 模板上于 `walkObjectLiteral` 内部崩溃；
- 只读 `computed()` 的公开类型使用 `ComputedRef<T>`，不要写 `ReturnType<typeof computed<T>>`，后者会错误匹配 writable overload；
- 升级 Vue、TypeScript、Monaco 或 vue-tsc 时必须实际运行 `npm run typecheck:web`。

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
- 所有平台统一启用完整动画，不增加根据系统减少动态效果设置禁用动画的逻辑；
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
npm run test:electron -- --node=/absolute/node --dependencies=/absolute/node_modules
npm run check
npm run build
```

可选构建：

```bash
npm run dist:mac
npm run dist:win
npm run dist:nsis
npm run dist:portable
npm run dist:check -- win --electron-dist /absolute/path/to/electron
npm run dist:win -- --electron-dist /absolute/path/to/electron
npm run dist:mac -- --dir --electron-dist ./node_modules/electron/dist
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
4. Monaco 显示并能输入，标题状态显示 TS/JS LANGUAGE SERVICE ONLINE；
5. 悬浮类型/JSDoc、右键格式化、Ctrl/Cmd+/、块注释和格式化快捷键在 macOS/Windows 均可用；
6. 人为破坏 App/Monaco 导入时显示启动诊断页，而不是纯黑；
7. 分栏拖动、双击、键盘微调；
8. Manual / Live；
9. RUN:CLEAR 开关与 PURGE；
10. LINE:SYNC 开关、21 px 行对齐及编辑/输出双向滚动；
11. 纯表达式显示一次 `⇒` 结果；有返回值的独立调用会输出，`undefined` 不输出，已赋值/传参的调用不另行输出；
12. 普通脚本完成后不残留运行中；
13. 长驻脚本可 ABORT；
14. 新建、打开、保存、另存为；
15. Dependency Matrix 安装 Lodash/Day.js；
16. 窗口缩至最小尺寸无关键控件重叠；
17. 系统减少动态效果设置下仍保持项目约定的完整动画。

AI agent 完成修改时：

- 总结架构和行为变化；
- 列出实际运行的检查；
- 不声称未执行的 Electron 实机测试已经通过；
- 更新版本号、README、AGENTS；
- 不提交 `node_modules`、`out`、`release` 或工作区内容。

## 17. v0.3.7 执行协议扩展

- `RunStartPayload.runId` 可由 Renderer 预分配，准备阶段即可停止；旧 output/exit 必须按 runId 过滤。
- Node 输入经独立临时 JSON 文件给 runner 的 `lab.input` / `lab.inputText`，退出删除；不通过命令行插值执行输入。
- TypeScript AST 改写提供原始映射，再与 esbuild map 串联；Node 开启 `--enable-source-maps`，编译错误 UTF-8 字节列转换为 Monaco UTF-16 列。
- 输出可携带 `values` 快照与 `location`，快照有大小/深度限制；getter、自定义 inspect/toJSON 不作为输出求值。8 MB 上限包括结构化数据。
- 普通停止与用户触发强制停止均管理进程树；不添加脚本超时。
- `preview-build.ts` 只构建用户工作区本地 React/ReactDOM，不运行用户模块；`preview-manager.ts` 用独立 WebContentsView 和内存 session 管理其生命周期。
- 专用 `src/preload/preview.ts` 只转发预览输出，不暴露应用 bridge。Main 验证精确 sender、主 frame 与当前 runId；应用 IPC 只接受主窗口主 frame。
- `lab-preview:` 协议仅提供本次构建的内存资源映射。禁止远程请求、导航、新窗口、权限和 webview；Node/contextIsolation/sandbox 边界保持。
- 编译失败保留旧预览；成功替换或停止时销毁旧 WebContents，清理其状态。预览区 bounds 由 Main/Renderer 同步，弹窗期间必须隐藏原生视图。

- 预览复用一个专用内存 Session，每次采用唯一 origin；清理只能清旧 origin，不得每次新建 partition 累积 BrowserContext，或让旧清理注销新页面协议。
- Preload 与 Main 按原始消息共同执行 8 MB 上限，达到限制明确报告并销毁预览，不得静默停止日志转发。
- 浏览器普通 getter 不求值；浏览器无法提前识别 Proxy，属性描述符读取可能触发其 trap，只发生在隔离预览进程。不要宣传恶意代码安全沙箱。
- `recent-files.ts` 在 userData/recent-files.json 原子保存最近 12 个用户明确打开/保存的路径；open-recent 仅接受该列表中的路径。

## 18. v0.4.0 Renderer 工作流

- `ScriptLanguage` 为 javascript/typescript/jsx/tsx；前两者运行于系统 Node，后两者运行于独立浏览器预览。Monaco 用 JS/TS language ID + 正确 .jsx/.tsx 模型 URI，切换时保留代码并探测 Worker；两个 defaults 注入 lab 全局声明。v0.4.1 在索引到 react/jsx-runtime.d.ts（含 @types/react）时配置 ReactJSX；缺少时使用 noEmit + Preserve，保留源码检查且不误报 TS2875，不全局忽略该诊断。刷新类型/切换工作区必须更新此模式；esbuild 实际预览始终 automatic JSX。缺类型时头部「补全 React 类型」只打开现有依赖面板预填 @types/react @types/react-dom，不自动安装，也不把在线 Worker 标为降级。
- `useDocumentSession.ts` 单键原子恢复文件路径、dirty 和 lastSavedCode；保存文件前捕获提交源码，异步保存期间的新编辑不能被标为已保存。
- `useLabLibrary.ts` 管理 60 个/2 M 字符的本地收藏与模板；输入与代码一并保存。加载收藏/历史走统一放弃修改确认。
- 损坏、部分非法或未知版本的收藏记录只读保留，不得通过下一次保存静默覆盖；可读条目仍可载入恢复。
- `InputPanel.vue` 只校验/格式化 JSON 或文本，最大 512 K 字符；空 JSON 无效，纯文本空值有效。折叠不改变输入，输入编辑参与 500 ms Live 防抖。
- `inputFormatting.ts` 在校验后只重排 JSON 空白，保留数字词法值和重复键，并限制格式化膨胀后的大小。
- `useRunHistory.ts` 保存当前会话最近 12 次/12 M 字符的有界不可变运行快照；固定基线最多 1 M 字符并持久化。截断必须显式标记，存储失败保持旧基线并提示。
- `useOutputBuffer.ts` 保留 runId/sourceRevision/location/values，跨 run 或源码版本不得合并；8 M 字符/5000 块界面缓冲超限时显式提示。Main 的 8 MB wire 输出限制仍独立有效。
- `OutputConsole.vue` 支持运行选择、源行对齐、搜索/类型过滤、复制、ValueTree 树/表格与恢复。完整顺序不能混淆为单次运行；代码/输入过期时暂停定位和滚动。
- `sourceLocation.ts` 统一入口文件匹配，兼容文件 URL、相对路径和 Windows 路径；依赖文件错误保留在 UNMAPPED，不使用其行号对齐当前编辑器。
- 对象树按需挂载；复制快照必须保留稀疏数组索引、自定义属性和特殊值标记。
- `RunCompareDialog.vue` 仅比较stdout/stderr/expression，最多每侧500行/100 K字符；截断不能推断全量一致，恢复必须复制快照并确认当前修改。
- v0.4.1 使用同一 Monaco 实例的只读 diff editor 展示结果，两个 plaintext 模型与增删统计必须使用同一份归一化、截断后的文本。保持左右对齐、字符高亮、行号和差异导航；不忽略行首/行尾空格，不提供修改/回退输出操作。红色表示基线删除，绿色表示本次新增；关闭弹窗销毁模型和编辑器，不影响主代码模型。仅截断部分一致时必须明确完整结果未知。
- `PreviewPane.vue` 只报告 DOM bounds；App 负责IPC与状态。任何模态、切到控制台或启动覆盖层出现时，立即隐藏原生View，避免压在Vue弹窗之上。
- Node运行、Node准备态、预览构建/活动页面、npm必须明确协调；Node runId与最近run snapshot id、preview id不得混用。普通Node自然退出立即结束运行状态，Browser ready可早于start返回。
- Main `stopHostWork()` 在窗口关闭、非同文档的主frame导航、Renderer崩溃与退出时回收Node/npm/preview；不能仅停止预览，否则重新加载后Node旧runId丢失会留下无法控制的进程。
- npmBusy只暂停执行，不把Monaco设为只读；弹窗日志与脚本清空偏好分离。
- `useDialogFocus.ts` 统一Tab/焦点恢复/Escape。App对DOM快捷键、Monaco事件与Electron菜单统一检查模态/运行阻塞条件。
- 语言和最近文件菜单展开期间也隐藏原生预览，但不能将菜单状态并入会使菜单自身禁用的模态状态。
- `scripts/electron-smoke.cjs` 基于生产构建，在独立临时 profile/workspace 驱动整 App；先 build 再执行 test:electron，不与正在读取 out 的测试并行重建。
- JSX实际测试包括hooks点击、输入、缺包、编译失败保留、重启重置、错误行列、无限循环停止后恢复、弹窗遮挡、生产Preload和Worker加载。Windows实机未执行时不得声称通过。

## 19. v0.4.2 行对齐与输入建议

- 历史选择、固定比较和搜索位于输出底部；旧结果使用底部「旧结果」详情入口，保留恢复快照，不插入横幅或改变输出起点。复制反馈浮在输出区内；旧预览只在预览头部轻量标识，实际错误仍明确显示。
- `useAlignedPaneLayout.ts` 在启用源行对齐时测量左右 shell 的交集，通过内部 padding 对齐可视区域的顶部和底部，适应头部换行、窗口缩放及输入折叠；不靠固定头部高度或 magic offset。比较预览和控制台同时显示时暂用顺序输出，切到控制台后恢复对齐偏好。
- `editorLayout.ts` 定义 Renderer 专用 SourceViewport 与共享 21 px 行高、15/24 px 上下留白。Monaco 通过公开 getVisibleRanges/getTopForLineNumber/getScrollHeight API 报告真实行位置和滚动范围，对齐输出只挂载可见源行（包含折叠）；不得再次仅用源码行号乘行高推断当前编辑视图。旧结果仍按快照行号展示并暂停定位/同步。
- 对齐时关闭 Monaco sticky scroll，避免固定标题遮挡源行；关闭对齐恢复。左右滚动范围需计入各自 viewport 与水平滚动条，底部不能产生额外漂移。ResizeObserver/rAF 在销毁时清理。
- 本地补全显式启用 quickSuggestions、参数提示、suggest.preview 与 tabCompletion；预览来自现有语言服务候选，不调用在线 AI，不生成任意后续代码。Tab 无候选时仍缩进，撤销、选择与片段 Tab 顺序由 Monaco 管理，禁止全局拦截 Tab。
- Cmd/Ctrl+Space 或 Alt/Option+/ 与右键「输入建议（Tab 补全）」等价。保留 Ctrl/Cmd+/ 的物理键兜底与格式化命令。
- 生产 Electron smoke 要验证真实行 DOM 的屏幕坐标、两侧滚动及底部、输入展开/窗口调整、旧结果无占位横幅，以及候选预览、Tab 补全与普通缩进/撤销。此工作流始于 0.4.2；Windows 实机未测必须如实说明。

## 20. v0.4.3 本地 Electron 打包

- `dist:mac/win/nsis/portable` 统一经过 `scripts/package.mjs`：先预检，再 `npm run build`，最后 electron-builder。`dist:check -- <目标>` / `--check` 只预检；`--dir` 仅生成应用目录。Windows 默认 x64，macOS 默认当前 Node 架构；`--arch` 支持 x64 / arm64。
- 本地路径优先级：`--electron-dist` > `OFFLINE_JS_LAB_ELECTRON_DIST` > `package.json build.electronDist`；相对路径基于项目根目录。没有配置时保留 builder 默认缓存/下载流程；明确配置的空值或无效路径必须失败，不回退下载。
- 支持官方 ZIP、含多个官方 ZIP 的目录和完整解压根目录。ZIP 按项目锁定的 Electron 版本、目标平台、架构匹配原始文件名并检查 ZIP 头；解压目录检查 version、关键资源及 PE / Mach-O 架构头。不得通过执行目标 Electron 检测架构，避免跨平台执行和副作用。不得将文件名校验描述成 ZIP 内容校验或来源认证。
- 本地路径通过 electron-builder 的字符串 `electronDist` 配置传递，不使用可能吞掉异常后回退下载的 hook。复制/解压由 builder 完成；不更改用户的离线源文件、node_modules/electron/path.txt 或开发启动逻辑。
- `npm run build` 只编译应用；不能附加本机 Electron 下载前置步骤，否则 macOS 打 Windows 包也会被本机下载阻塞。原有 `prestart/predev/prepreview` 仍保留。
- 本地发行包只免去 Electron 下载，完全离线还需要项目 npm 依赖、平台系统工具和 builder 辅助工具缓存（`ELECTRON_BUILDER_CACHE`）。不能承诺仅设置 `ELECTRON_SKIP_BINARY_DOWNLOAD` 或 `--dir` 就能完整离线打包。打包 API 使用 `publish: 'never'`。
- 涉及命令改动时验证在线默认计划、配置优先级、空格路径、版本/平台/架构错误、不完整文件及预检无副作用；实际打包验证须注明宿主系统和产物种类，不声称未执行的 Windows/安装包测试通过。
