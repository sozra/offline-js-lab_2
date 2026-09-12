import fs from 'node:fs/promises'
import fsSync from 'node:fs'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  protocol,
  session,
  shell,
  type IpcMainInvokeEvent,
  type MenuItemConstructorOptions,
  type OpenDialogOptions,
  type OpenDialogReturnValue,
  type SaveDialogOptions,
  type SaveDialogReturnValue,
  type WebContents
} from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppCommand,
  BootstrapState,
  InstallPackagesPayload,
  NpmAction,
  PackageOutputPayload,
  PackageState,
  PreviewBounds,
  RunStartPayload,
  SaveFilePayload,
  ScriptLanguage,
  UninstallPackagesPayload
} from '@shared/types'
import { NpmManager } from './npm-manager'
import { RunManager } from './run-manager'
import { PreviewManager } from './preview-manager'
import { RecentFiles } from './recent-files'
import { PREVIEW_SCHEME } from './preview-build'
import { WorkspaceService } from './workspace'

const MAX_FILE_BYTES = 10 * 1024 * 1024
app.setName('Offline JS Lab')
protocol.registerSchemesAsPrivileged([{ scheme: PREVIEW_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } }])

let mainWindow: BrowserWindow | null = null
let workspaceService: WorkspaceService | null = null
let npmManager: NpmManager | null = null
let runManager: RunManager | null = null
let previewManager: PreviewManager | null = null
let recentFiles: RecentFiles | null = null

async function recordRecentFile(filePath: string): Promise<void> {
  await recentFiles?.record(filePath).catch(error => console.warn('无法更新最近文件列表', error))
}

async function readScriptFile(filePath: string) {
  const stat = await fs.stat(filePath)
  if (!stat.isFile()) throw new Error('所选路径不是文件。')
  if (stat.size > MAX_FILE_BYTES) throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 的限制。`)
  const content = await fs.readFile(filePath, 'utf8')
  await recordRecentFile(filePath)
  return { filePath, content, language: guessLanguage(filePath) }
}
let npmOperationPending = false

function workspace(): WorkspaceService {
  if (!workspaceService) throw new Error('工作区服务尚未初始化。')
  return workspaceService
}

function npmService(): NpmManager {
  if (!npmManager) throw new Error('npm 服务尚未初始化。')
  return npmManager
}

function runner(): RunManager {
  if (!runManager) throw new Error('运行服务尚未初始化。')
  return runManager
}

function previewer(): PreviewManager {
  if (!previewManager) throw new Error('预览服务尚未初始化。')
  return previewManager
}

function resolveUnpackedPath(inputPath: string): string {
  const marker = `${path.sep}app.asar${path.sep}`
  if (!inputPath.includes(marker)) return inputPath
  const unpackedPath = inputPath.replace(marker, `${path.sep}app.asar.unpacked${path.sep}`)
  return fsSync.existsSync(unpackedPath) ? unpackedPath : inputPath
}

function configureEsbuildBinary(): void {
  if (!app.isPackaged) return
  const platformPackage = `${process.platform}-${process.arch}`
  const binaryRelativePath =
    process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild')
  const candidate = path.join(
    process.resourcesPath,
    'app.asar.unpacked',
    'node_modules',
    '@esbuild',
    platformPackage,
    binaryRelativePath
  )
  if (fsSync.existsSync(candidate)) process.env.ESBUILD_BINARY_PATH = candidate
}

function getRunnerPath(): string {
  if (app.isPackaged) return resolveUnpackedPath(path.join(process.resourcesPath, 'runner.cjs'))
  return path.join(process.cwd(), 'src', 'main', 'runner.cjs')
}

function getBuiltRendererUrl(): string {
  return pathToFileURL(path.join(__dirname, '../renderer/index.html')).href
}

function isTrustedSender(event: IpcMainInvokeEvent): boolean {
  if (!mainWindow || mainWindow.isDestroyed() || event.sender !== mainWindow.webContents || event.senderFrame !== mainWindow.webContents.mainFrame) return false
  const senderUrl = event.senderFrame?.url
  if (!senderUrl) return false
  const devUrl = process.env.ELECTRON_RENDERER_URL
  if (devUrl) {
    try {
      return new URL(senderUrl).origin === new URL(devUrl).origin
    } catch {
      return false
    }
  }
  return senderUrl === getBuiltRendererUrl()
}

function registerTrustedHandler(
  channel: string,
  handler: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown | Promise<unknown>
): void {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!isTrustedSender(event)) throw new Error('拒绝来自非应用页面的 IPC 请求。')
    return handler(event, ...args)
  })
}

function getOwnerWindow(webContents: WebContents): BrowserWindow | null {
  return BrowserWindow.fromWebContents(webContents) || mainWindow
}

function showOpenDialog(
  webContents: WebContents,
  options: OpenDialogOptions
): Promise<OpenDialogReturnValue> {
  const owner = getOwnerWindow(webContents)
  return owner ? dialog.showOpenDialog(owner, options) : dialog.showOpenDialog(options)
}

function showSaveDialog(
  webContents: WebContents,
  options: SaveDialogOptions
): Promise<SaveDialogReturnValue> {
  const owner = getOwnerWindow(webContents)
  return owner ? dialog.showSaveDialog(owner, options) : dialog.showSaveDialog(options)
}

function send(webContents: WebContents | null, channel: string, payload: unknown): void {
  if (webContents && !webContents.isDestroyed()) webContents.send(channel, payload)
}

function sendAppCommand(command: AppCommand): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    send(mainWindow.webContents, IPC.appCommand, command)
  }
}

function guessLanguage(filePath: string): ScriptLanguage {
  if (/\.tsx$/i.test(filePath)) return 'tsx'
  if (/\.jsx$/i.test(filePath)) return 'jsx'
  return /\.(?:ts|mts|cts)$/i.test(filePath) ? 'typescript' : 'javascript'
}

async function getPackageState(): Promise<PackageState> {
  return {
    workspacePath: workspace().getPath(),
    installed: await workspace().listPackages(),
    npmRuntime: npmService().getRuntimeInfo()
  }
}

async function getBootstrapState(): Promise<BootstrapState> {
  return {
    appVersion: app.getVersion(),
    platform: process.platform,
    isPackaged: app.isPackaged,
    packages: await getPackageState(),
    nodeRuntime: await runner().getRuntimeInfo()
  }
}

async function runNpmOperation(
  event: IpcMainInvokeEvent,
  action: NpmAction,
  payload: Partial<InstallPackagesPayload & UninstallPackagesPayload> = {}
): Promise<unknown> {
  if (npmOperationPending || runner().hasActiveRuns() || previewer().hasActivePreview()) throw new Error('请先停止当前脚本或组件预览，再操作依赖。')
  npmOperationPending = true
  const progress = (output: PackageOutputPayload): void => {
    send(event.sender, IPC.packagesOutput, output)
  }
  try {
    const result = await npmService().run(action, payload, progress)
    return { ...result, packages: await getPackageState() }
  } finally {
    npmOperationPending = false
  }
}

function registerIpcHandlers(): void {
  registerTrustedHandler(IPC.bootstrapGet, () => getBootstrapState())

  registerTrustedHandler(IPC.workspaceChoose, async (event) => {
    const result = await showOpenDialog(event.sender, {
      title: '选择 Offline JS Lab 工作区',
      defaultPath: workspace().getPath(),
      properties: ['openDirectory', 'createDirectory', 'promptToCreate']
    })
    if (result.canceled || result.filePaths.length === 0) return null

    runner().stopAll()
    previewer().stop()
    npmService().stopAll()
    const selectedPath = result.filePaths[0]
    if (!selectedPath) return null
    await workspace().setWorkspace(selectedPath)
    return getPackageState()
  })

  registerTrustedHandler(IPC.workspaceOpen, async () => {
    const errorMessage = await shell.openPath(workspace().getPath())
    return errorMessage || null
  })

  registerTrustedHandler(IPC.fileOpen, async (event) => {
    const result = await showOpenDialog(event.sender, {
      title: '打开脚本或 JSX/TSX 组件',
      defaultPath: workspace().getPath(),
      properties: ['openFile'],
      filters: [
        { name: 'JavaScript / TypeScript / React', extensions: ['js', 'mjs', 'cjs', 'ts', 'mts', 'cts', 'jsx', 'tsx'] },
        { name: '所有文件', extensions: ['*'] }
      ]
    })
    if (result.canceled || result.filePaths.length === 0) return null

    const filePath = result.filePaths[0]
    if (!filePath) return null
    return readScriptFile(filePath)
  })

  registerTrustedHandler(IPC.recentFiles, () => recentFiles?.list() ?? [])
  registerTrustedHandler(IPC.recentFileOpen, async (_event, filePath: unknown) => {
    if (typeof filePath !== 'string' || !(await recentFiles?.includes(filePath))) throw new Error('该文件不在最近文件列表中，请使用“打开”选择文件。')
    return readScriptFile(filePath)
  })

  registerTrustedHandler(IPC.fileSave, async (event, rawPayload) => {
    const payload = (rawPayload ?? {}) as Partial<SaveFilePayload>
    const content = typeof payload.content === 'string' ? payload.content : ''
    const language: ScriptLanguage = payload.language === 'javascript' || payload.language === 'jsx' || payload.language === 'tsx' ? payload.language : 'typescript'
    const forceSaveAs = Boolean(payload.saveAs)
    let filePath = typeof payload.filePath === 'string' && payload.filePath
      ? path.resolve(payload.filePath)
      : null

    if (Buffer.byteLength(content, 'utf8') > MAX_FILE_BYTES) {
      throw new Error(`文件超过 ${MAX_FILE_BYTES / 1024 / 1024} MB 的 MVP 限制。`)
    }

    if (!filePath || forceSaveAs) {
      const extension = language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language
      const defaultName = `scratch.${extension}`
      const result = await showSaveDialog(event.sender, {
        title: '保存脚本',
        defaultPath: filePath || path.join(workspace().getPath(), defaultName),
        filters: [
          {
            name: language === 'typescript' || language === 'tsx' ? 'TypeScript' : 'JavaScript',
            extensions: [extension]
          },
          { name: '所有文件', extensions: ['*'] }
        ]
      })
      if (result.canceled || !result.filePath) return null
      filePath = result.filePath
    }

    await fs.mkdir(path.dirname(filePath), { recursive: true })
    await fs.writeFile(filePath, content, 'utf8')
    await recordRecentFile(filePath)
    return { filePath, language: guessLanguage(filePath) }
  })

  registerTrustedHandler(IPC.runStart, (event, payload) => {
    if (npmOperationPending || previewer().hasActivePreview()) return { ok: false, error: '请先停止 npm 操作或组件预览。' }
    return runner().start(event.sender, payload as RunStartPayload)
  })
  registerTrustedHandler(IPC.runStop, (_event, runId) =>
    runner().stop(typeof runId === 'string' ? runId : '')
  )
  registerTrustedHandler(IPC.runForceStop, (_event, runId) => runner().forceStop(typeof runId === 'string' ? runId : ''))
  registerTrustedHandler(IPC.previewStart, (event, payload) => {
    if (npmOperationPending || runner().hasActiveRuns()) return { ok: false, error: '请先停止 npm 操作或 Node 脚本。' }
    return previewer().start(event.sender, payload as RunStartPayload)
  })
  registerTrustedHandler(IPC.previewStop, () => previewer().stop())
  registerTrustedHandler(IPC.previewBounds, (_event, bounds) => previewer().setBounds(bounds as PreviewBounds))
  ipcMain.on(IPC.previewMessage, (event, message: unknown) => previewer().handleMessage(event, message))

  registerTrustedHandler(IPC.packagesList, () => getPackageState())
  registerTrustedHandler(IPC.packagesTypes, () => workspace().collectTypeDefinitions())
  registerTrustedHandler(IPC.packagesInstall, (event, payload) =>
    runNpmOperation(event, 'install', payload as InstallPackagesPayload)
  )
  registerTrustedHandler(IPC.packagesSync, (event) => runNpmOperation(event, 'sync'))
  registerTrustedHandler(IPC.packagesUninstall, (event, payload) =>
    runNpmOperation(event, 'uninstall', payload as UninstallPackagesPayload)
  )
  registerTrustedHandler(IPC.packagesStop, () => npmService().stop())
}

function createApplicationMenu(): void {
  if (process.platform !== 'darwin') {
    Menu.setApplicationMenu(null)
    return
  }

  const template: MenuItemConstructorOptions[] = [
    {
      label: app.name,
      submenu: [
        { role: 'about' },
        { type: 'separator' },
        { role: 'services' },
        { type: 'separator' },
        { role: 'hide' },
        { role: 'hideOthers' },
        { role: 'unhide' },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: '文件',
      submenu: [
        { label: '新建', accelerator: 'CmdOrCtrl+N', click: () => sendAppCommand('new') },
        { label: '打开…', accelerator: 'CmdOrCtrl+O', click: () => sendAppCommand('open') },
        { type: 'separator' },
        { label: '保存', accelerator: 'CmdOrCtrl+S', click: () => sendAppCommand('save') },
        {
          label: '另存为…',
          accelerator: 'CmdOrCtrl+Shift+S',
          click: () => sendAppCommand('save-as')
        },
        { type: 'separator' },
        { role: 'close' }
      ]
    },
    {
      label: '编辑',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' }
      ]
    },
    {
      label: '运行',
      submenu: [
        {
          label: '运行代码',
          accelerator: 'CmdOrCtrl+Enter',
          click: () => sendAppCommand('run')
        },
        {
          label: '停止运行',
          accelerator: 'CmdOrCtrl+.',
          click: () => sendAppCommand('stop')
        }
      ]
    },
    {
      label: '显示',
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    {
      label: '窗口',
      submenu: [
        { role: 'minimize' },
        { role: 'zoom' },
        { type: 'separator' },
        { role: 'front' }
      ]
    }
  ]

  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}

function stopHostWork(): void {
  runManager?.stopAll()
  npmManager?.stopAll()
  previewManager?.stop()
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1480,
    height: 900,
    minWidth: 980,
    minHeight: 640,
    show: false,
    title: 'Offline JS Lab',
    backgroundColor: '#05070a',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: process.platform !== 'darwin',
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  mainWindow = window
  window.once('ready-to-show', () => window.show())
  window.on('closed', () => {
    stopHostWork()
    if (mainWindow === window) mainWindow = null
  })
  window.on('resize', () => previewManager?.applyBounds())
  window.webContents.on('did-start-navigation', (_event, _url, inPlace, isMainFrame) => {
    // A replacement renderer cannot recover the previous renderer's run IDs.
    // Release its processes before the new document starts accepting commands.
    if (isMainFrame && !inPlace) stopHostWork()
  })
  window.webContents.on('render-process-gone', stopHostWork)
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  window.webContents.on('will-navigate', (event) => event.preventDefault())
  window.webContents.on('will-attach-webview', (event) => event.preventDefault())

  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL)
  } else {
    void window.loadFile(path.join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(async () => {
  recentFiles = new RecentFiles(app.getPath('userData'))
  configureEsbuildBinary()
  workspaceService = new WorkspaceService(app)
  await workspaceService.init()
  npmManager = new NpmManager(workspaceService)
  runManager = new RunManager(workspaceService, getRunnerPath)
  previewManager = new PreviewManager(() => mainWindow, () => workspace().getPath(), () => path.join(__dirname, '../preload/preview.js'))

  registerIpcHandlers()
  createApplicationMenu()
  session.defaultSession.setPermissionRequestHandler((_webContents, _permission, callback) => {
    callback(false)
  })
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', stopHostWork)

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
