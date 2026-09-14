export interface LocalElectronTarget {
  projectRoot: string
  version: string
  platform: 'darwin' | 'win32'
  arch: 'x64' | 'arm64'
}

export interface PackagePlan extends LocalElectronTarget {
  help: false
  target?: 'dir' | 'nsis' | 'portable'
  check: boolean
  electronDist?: string
}

export function createPackagePlan(argv: string[], options?: {
  projectRoot?: string
  env?: NodeJS.ProcessEnv
  hostArch?: string
}): PackagePlan | { help: true }
export function resolveLocalElectron(input: string, target: LocalElectronTarget): string
export function packageProject(argv: string[]): Promise<number>
