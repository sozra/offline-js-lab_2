export interface ElectronInstallState {
  installed: boolean
  pathFile: string
  executablePath: string | null
  reason: 'missing-path-file' | 'empty-path-file' | 'missing-executable' | null
}

export interface ElectronPackageJson {
  bin?: string | Record<string, string>
}

export function readElectronInstallState(electronDirectory: string): ElectronInstallState
export function resolveElectronInstallScript(
  packageJson: ElectronPackageJson,
  electronDirectory: string
): string | null
export function ensureElectronBinary(options?: {
  logger?: Pick<Console, 'log' | 'error'>
}): number
