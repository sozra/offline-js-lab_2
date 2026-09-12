import { contextBridge, ipcRenderer } from 'electron'
import { IPC } from '@shared/ipc'
import type {
  AppCommand,
  OfflineJsLabBridge,
  PackageOutputPayload,
  PreviewState,
  RunExitPayload,
  RunOutputPayload
} from '@shared/types'

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  if (typeof callback !== 'function') throw new TypeError('事件监听器必须是函数。')
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload)
  ipcRenderer.on(channel, listener)
  return () => ipcRenderer.removeListener(channel, listener)
}

const api: OfflineJsLabBridge = {
  getBootstrap: () => ipcRenderer.invoke(IPC.bootstrapGet),
  chooseWorkspace: () => ipcRenderer.invoke(IPC.workspaceChoose),
  openWorkspace: () => ipcRenderer.invoke(IPC.workspaceOpen),
  openFile: () => ipcRenderer.invoke(IPC.fileOpen),
  getRecentFiles: () => ipcRenderer.invoke(IPC.recentFiles),
  openRecentFile: (filePath) => ipcRenderer.invoke(IPC.recentFileOpen, filePath),
  saveFile: (payload) => ipcRenderer.invoke(IPC.fileSave, payload),
  runCode: (payload) => ipcRenderer.invoke(IPC.runStart, payload),
  stopRun: (runId) => ipcRenderer.invoke(IPC.runStop, runId),
  forceStopRun: (runId) => ipcRenderer.invoke(IPC.runForceStop, runId),
  startPreview: (payload) => ipcRenderer.invoke(IPC.previewStart, payload),
  stopPreview: () => ipcRenderer.invoke(IPC.previewStop),
  setPreviewBounds: (bounds) => ipcRenderer.invoke(IPC.previewBounds, bounds),
  onPreviewOutput: (callback) => subscribe<RunOutputPayload>(IPC.previewOutput, callback),
  onPreviewState: (callback) => subscribe<PreviewState>(IPC.previewState, callback),
  onRunOutput: (callback) => subscribe<RunOutputPayload>(IPC.runOutput, callback),
  onRunExit: (callback) => subscribe<RunExitPayload>(IPC.runExit, callback),
  listPackages: () => ipcRenderer.invoke(IPC.packagesList),
  getTypeDefinitions: () => ipcRenderer.invoke(IPC.packagesTypes),
  installPackages: (payload) => ipcRenderer.invoke(IPC.packagesInstall, payload),
  syncPackages: () => ipcRenderer.invoke(IPC.packagesSync),
  uninstallPackages: (payload) => ipcRenderer.invoke(IPC.packagesUninstall, payload),
  stopPackageOperation: () => ipcRenderer.invoke(IPC.packagesStop),
  onPackageOutput: (callback) => subscribe<PackageOutputPayload>(IPC.packagesOutput, callback),
  onAppCommand: (callback) => subscribe<AppCommand>(IPC.appCommand, callback)
}

contextBridge.exposeInMainWorld('offlineJsLab', api)
