export const IPC = {
  bootstrapGet: 'bootstrap:get',
  workspaceChoose: 'workspace:choose',
  workspaceOpen: 'workspace:open',
  fileOpen: 'file:open',
  fileSave: 'file:save',
  runStart: 'run:start',
  runStop: 'run:stop',
  runOutput: 'run:output',
  runExit: 'run:exit',
  packagesList: 'packages:list',
  packagesTypes: 'packages:types',
  packagesInstall: 'packages:install',
  packagesSync: 'packages:sync',
  packagesUninstall: 'packages:uninstall',
  packagesStop: 'packages:stop',
  packagesOutput: 'packages:output',
  appCommand: 'app:command'
} as const
