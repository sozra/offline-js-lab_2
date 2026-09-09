"use strict";
const electron = require("electron");
const IPC = {
  bootstrapGet: "bootstrap:get",
  workspaceChoose: "workspace:choose",
  workspaceOpen: "workspace:open",
  fileOpen: "file:open",
  fileSave: "file:save",
  runStart: "run:start",
  runStop: "run:stop",
  runOutput: "run:output",
  runExit: "run:exit",
  packagesList: "packages:list",
  packagesTypes: "packages:types",
  packagesInstall: "packages:install",
  packagesSync: "packages:sync",
  packagesUninstall: "packages:uninstall",
  packagesStop: "packages:stop",
  packagesOutput: "packages:output",
  appCommand: "app:command"
};
function subscribe(channel, callback) {
  if (typeof callback !== "function") throw new TypeError("事件监听器必须是函数。");
  const listener = (_event, payload) => callback(payload);
  electron.ipcRenderer.on(channel, listener);
  return () => electron.ipcRenderer.removeListener(channel, listener);
}
const api = {
  getBootstrap: () => electron.ipcRenderer.invoke(IPC.bootstrapGet),
  chooseWorkspace: () => electron.ipcRenderer.invoke(IPC.workspaceChoose),
  openWorkspace: () => electron.ipcRenderer.invoke(IPC.workspaceOpen),
  openFile: () => electron.ipcRenderer.invoke(IPC.fileOpen),
  saveFile: (payload) => electron.ipcRenderer.invoke(IPC.fileSave, payload),
  runCode: (payload) => electron.ipcRenderer.invoke(IPC.runStart, payload),
  stopRun: (runId) => electron.ipcRenderer.invoke(IPC.runStop, runId),
  onRunOutput: (callback) => subscribe(IPC.runOutput, callback),
  onRunExit: (callback) => subscribe(IPC.runExit, callback),
  listPackages: () => electron.ipcRenderer.invoke(IPC.packagesList),
  getTypeDefinitions: () => electron.ipcRenderer.invoke(IPC.packagesTypes),
  installPackages: (payload) => electron.ipcRenderer.invoke(IPC.packagesInstall, payload),
  syncPackages: () => electron.ipcRenderer.invoke(IPC.packagesSync),
  uninstallPackages: (payload) => electron.ipcRenderer.invoke(IPC.packagesUninstall, payload),
  stopPackageOperation: () => electron.ipcRenderer.invoke(IPC.packagesStop),
  onPackageOutput: (callback) => subscribe(IPC.packagesOutput, callback),
  onAppCommand: (callback) => subscribe(IPC.appCommand, callback)
};
electron.contextBridge.exposeInMainWorld("offlineJsLab", api);
