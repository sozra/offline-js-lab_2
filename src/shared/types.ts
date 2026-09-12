export type ScriptLanguage = 'typescript' | 'javascript' | 'jsx' | 'tsx'
export type RunMode = 'manual' | 'live'
export type RunTrigger = 'manual' | 'auto'
export type OutputStream = 'stdout' | 'stderr' | 'expression' | 'system' | 'package' | 'muted'
export type RunExitReason = 'completed' | 'failed' | 'stopped' | 'output-limit' | 'app-closed'
export type AppCommand = 'new' | 'open' | 'save' | 'save-as' | 'run' | 'stop'
export type NpmAction = 'install' | 'sync' | 'uninstall'

export interface RuntimeInfo {
  command: string
  source: string
  version?: string
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
  runId?: string
  code: string
  language: ScriptLanguage
  sourceFilePath: string | null
  input?: ScriptInput
}

export interface ScriptInput {
  format: 'json' | 'text'
  text: string
}

export interface SourceLocation {
  file?: string
  line: number
  column: number
}

export interface ValueSnapshot {
  kind: string
  preview: string
  children?: Array<{ key: string; value: ValueSnapshot }>
  truncated?: boolean
}

export type RunStartResult =
  | { ok: true; runId: string; runtime: string }
  | { ok: false; error: string; location?: SourceLocation }

export interface RunOutputPayload {
  runId: string
  stream: Exclude<OutputStream, 'package' | 'muted'>
  text: string
  sourceLine?: number
  location?: SourceLocation
  values?: ValueSnapshot[]
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
  getRecentFiles: () => Promise<string[]>
  openRecentFile: (filePath: string) => Promise<OpenFileResult>
  saveFile: (payload: SaveFilePayload) => Promise<SaveFileResult | null>
  runCode: (payload: RunStartPayload) => Promise<RunStartResult>
  stopRun: (runId: string) => Promise<boolean>
  forceStopRun: (runId: string) => Promise<boolean>
  startPreview: (payload: RunStartPayload) => Promise<PreviewStartResult>
  stopPreview: () => Promise<void>
  setPreviewBounds: (bounds: PreviewBounds) => Promise<void>
  onPreviewOutput: (callback: (payload: RunOutputPayload) => void) => () => void
  onPreviewState: (callback: (payload: PreviewState) => void) => () => void
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
  sourceLine?: number
  runId?: string
  sourceRevision?: number
  location?: SourceLocation
  values?: ValueSnapshot[]
}

export interface PreviewBounds {
  x: number
  y: number
  width: number
  height: number
  visible: boolean
}

export type PreviewStartResult =
  | { ok: true; runId: string }
  | { ok: false; error: string; location?: SourceLocation }

export interface PreviewState {
  runId: string
  status: 'ready' | 'failed' | 'stopped'
  error?: string
}

export interface LabDocument {
  code: string
  language: ScriptLanguage
  input: ScriptInput
}

export interface SavedSnippet extends LabDocument {
  id: string
  name: string
  updatedAt: number
}

export interface RunSnapshot extends LabDocument {
  id: string
  revision: number
  createdAt: number
  filePath: string | null
  chunks: OutputChunk[]
  status: string
}
