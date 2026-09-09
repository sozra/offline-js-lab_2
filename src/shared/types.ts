export type ScriptLanguage = 'typescript' | 'javascript'
export type RunMode = 'manual' | 'live'
export type RunTrigger = 'manual' | 'auto'
export type OutputStream = 'stdout' | 'stderr' | 'system' | 'package' | 'muted'
export type RunExitReason = 'completed' | 'failed' | 'stopped' | 'output-limit' | 'app-closed'
export type AppCommand = 'new' | 'open' | 'save' | 'save-as' | 'run' | 'stop'
export type NpmAction = 'install' | 'sync' | 'uninstall'

export interface RuntimeInfo {
  command: string
  source: string
}

export interface RuntimeDescriptor extends RuntimeInfo {
  argsPrefix: string[]
}

export interface PackageInfo {
  name: string
  declaredVersion: string
  installedVersion: string | null
  license: string | null
  dev: boolean
  installed: boolean
}

export interface PackageState {
  workspacePath: string
  installed: PackageInfo[]
  npmRuntime: RuntimeInfo
}

export interface BootstrapState {
  appVersion: string
  platform: string
  isPackaged: boolean
  packages: PackageState
  nodeRuntime: RuntimeInfo
}

export interface OpenFileResult {
  filePath: string
  content: string
  language: ScriptLanguage
}

export interface SaveFilePayload {
  filePath: string | null
  content: string
  language: ScriptLanguage
  saveAs: boolean
}

export interface SaveFileResult {
  filePath: string
  language: ScriptLanguage
}

export interface RunStartPayload {
  code: string
  language: ScriptLanguage
  sourceFilePath: string | null
}

export type RunStartResult =
  | { ok: true; runId: string; runtime: string }
  | { ok: false; error: string }

export interface RunOutputPayload {
  runId: string
  stream: Exclude<OutputStream, 'package' | 'muted'>
  text: string
}

export interface RunExitPayload {
  runId: string
  code: number | null
  signal: string | null
  reason: RunExitReason
  durationMs: number
}

export interface PackageOutputPayload {
  stream: 'stdout' | 'stderr' | 'system'
  text: string
}

export interface InstallPackagesPayload {
  specs: string | string[]
  dev: boolean
}

export interface UninstallPackagesPayload {
  names: string | string[]
}

export interface NpmOperationResult {
  ok: boolean
  code: number | null
  signal: string | null
  action: NpmAction
}

export interface NpmOperationWithPackages extends NpmOperationResult {
  packages: PackageState
}

export interface TypeDefinitionFile {
  uri: string
  content: string
}

export interface TypeDefinitionResult {
  files: TypeDefinitionFile[]
  truncated: boolean
  totalBytes: number
}

export interface OfflineJsLabBridge {
  getBootstrap: () => Promise<BootstrapState>
  chooseWorkspace: () => Promise<PackageState | null>
  openWorkspace: () => Promise<string | null>
  openFile: () => Promise<OpenFileResult | null>
  saveFile: (payload: SaveFilePayload) => Promise<SaveFileResult | null>
  runCode: (payload: RunStartPayload) => Promise<RunStartResult>
  stopRun: (runId: string) => Promise<boolean>
  onRunOutput: (callback: (payload: RunOutputPayload) => void) => () => void
  onRunExit: (callback: (payload: RunExitPayload) => void) => () => void
  listPackages: () => Promise<PackageState>
  getTypeDefinitions: () => Promise<TypeDefinitionResult>
  installPackages: (payload: InstallPackagesPayload) => Promise<NpmOperationWithPackages>
  syncPackages: () => Promise<NpmOperationWithPackages>
  uninstallPackages: (payload: UninstallPackagesPayload) => Promise<NpmOperationWithPackages>
  stopPackageOperation: () => Promise<boolean>
  onPackageOutput: (callback: (payload: PackageOutputPayload) => void) => () => void
  onAppCommand: (callback: (command: AppCommand) => void) => () => void
}

export interface WorkspaceManifest {
  name?: string
  version?: string
  private?: boolean
  description?: string
  dependencies: Record<string, string>
  devDependencies: Record<string, string>
  [key: string]: unknown
}


export interface ToastMessage {
  id: number
  message: string
  type: 'info' | 'success' | 'error'
}

export interface OutputChunk {
  id: number
  stream: OutputStream
  text: string
}
