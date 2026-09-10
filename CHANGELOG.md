# Changelog

## 0.3.5

- 隐式输出扩展到未赋值、未传参的独立函数调用，支持普通调用与 `await` 调用。
- 独立调用只求值一次，非 `undefined` 返回值以 `⇒` 显示；无返回值的动作型函数保持安静。
- 显式 `console.*`、已赋值调用和作为其他函数参数的内层调用不会重复输出；增加对应插桩与子进程回归测试。

## 0.3.4

- 增加 `LINE:SYNC` 持久化开关；可定位输出按 Monaco 21 px 行高排列，并支持编辑器与输出区双向同步滚动。
- `console.log/info/warn/error/debug` 在编译前获得源行标记，通过子进程 fd 3 独立结构化通道传回 Main，再由可选 `sourceLine` IPC 字段送到 Renderer。
- 增加保守的隐式表达式输出：变量、属性读取、比较、逻辑和条件表达式等会显示带 `⇒` 的结果，无需 `console.log()`。
- 函数调用、构造、赋值、自增/自减、`await`、`yield`、`delete` 与 `void` 不参与隐式输出，避免把有行为的语句误判成调试值。
- 无法定位的编译错误、原始 stdout/stderr 与依赖内部打印在对齐模式下进入 `UNMAPPED` 区；关闭对齐后保留完整时间顺序视图。
- TypeScript 编译器 API 调整为运行时依赖，用于 JS/TS AST 识别；新增源码插桩、进程输出和 Renderer 结构测试。

## 0.3.3

- 修复 Windows 环境中 Monaco 可能只保留语法高亮、但悬浮类型/JSDoc、格式化与编辑命令未完整工作的跨平台退化问题。
- 改用 Monaco 0.56 完整 `monaco-editor` 入口，确保编辑器 features、languages 与顶层 `monaco.typescript` API 来自同一模块实例。
- Renderer Vite 配置增加 `dedupe: ['monaco-editor']`，降低不同平台预构建缓存生成重复 Monaco 模块图的风险。
- 通过 `setModeConfiguration()` 显式开启 JS/TS hover、completion、signature help、formatting、diagnostics、rename、references、code actions 与 inlay hints。
- Monaco 编辑器显式启用右键菜单、悬浮、粘贴格式化和输入格式化，并在右键菜单固定加入行注释、块注释与格式化文档操作。
- 增加 `Ctrl/Cmd + /` 与块注释的物理 `Slash` 按键兜底，兼容 Windows 不同键盘布局；增加 `Shift + Alt/Option + F` 格式化文档。
- 增加 TypeScript/JavaScript Worker 实际连通性检测；成功显示 `LANGUAGE SERVICE ONLINE`，失败在标题、Toast 与输出区明确报告。
- 新增对应源码检查、结构测试和 macOS/Windows 人工冒烟清单。

## 0.3.2

- 修复 Monaco 0.56 自定义 ESM 入口下错误读取 `monaco.typescript` / `monaco.languages.typescript`，导致模块初始化阶段抛错、Vue 尚未挂载便出现纯黑窗口的问题。
- 改为直接使用 `monaco-editor/languages/features/typescript/register` 的 `typescriptDefaults`、`javascriptDefaults`、`ModuleKind`、`ModuleResolutionKind` 与 `ScriptTarget` 具名导出。
- Renderer 入口改为动态导入 `App.vue`，新增 `startup-error.ts`、初始加载占位和可重新加载的启动诊断页；以后初始化失败不再静默黑屏。
- 修复 `useOutputBuffer` 与 `useResizableSplit` 把只读 `ComputedRef` 错误声明成 `WritableComputedRef` 的类型问题。
- 将 `vue-tsc` 从存在 `walkObjectLiteral` codegen 崩溃的 3.1.6 升级为 3.3.11。
- 新增防回归结构测试和源码检查，并同步 README、AGENTS 与第三方依赖版本说明。

## 0.3.1

- 修复 Electron 42+ 不再在 npm `postinstall` 阶段下载平台二进制后，electron-vite 5 启动时报 `Error: Electron uninstall` 的问题。
- 新增 `scripts/ensure-electron.mjs`，在 `npm start`、`npm run dev` 和 `npm run preview` 前检查并按需安装 Electron 本机二进制。
- 已安装时只做 `path.txt` 与目标可执行文件检查，不重复下载。
- 为 Electron 44 显式指定 `node24.18` 与 `chrome152` 构建目标，避免 electron-vite 未识别新主版本时使用旧目标回退。
- 新增 Electron 安装状态单元测试，并同步 README、AGENTS 与源码结构检查。

## 0.3.0

- Renderer 从原生 HTML/CSS/JavaScript 重构为 Vue 3 + TypeScript。
- 工程迁移到 electron-vite，Main、Preload、Shared 同步类型化。
- 引入组件化 Monaco、Output Console、Dependency Matrix、Confirm Dialog 和 Toast。
- 新增原创 Cyberdeck HUD 视觉、启动自检、扫描线、执行脉冲、glitch 与对话框过渡。
- 支持 `prefers-reduced-motion`。
- 保留手动/实时运行、500 ms 防抖、运行前清空设置、可调分栏、npm 工作区与类型定义。
- 继续移除运行超时，仅保留 8 MB 输出保护。
- 新增 Vitest 单元测试和 Renderer 结构检查。
