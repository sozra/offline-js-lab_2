import fsSync from 'node:fs'
import path from 'node:path'

type EsbuildModule = typeof import('esbuild')
export type EsbuildCompiler = Pick<EsbuildModule, 'build'>

export interface EsbuildBinaryLocator {
  resourcesPath?: string
  platform?: NodeJS.Platform
  arch?: string
  env?: NodeJS.ProcessEnv
  exists?: (candidate: string) => boolean
}

// esbuild 的 JS API 在模块加载时捕获 ESBUILD_BINARY_PATH，因此打包后必须在
// 首次 import('esbuild') 之前同步把路径指向 app.asar.unpacked 里的真实二进制；
// spawn 无法执行 ASAR 内部路径，否则 Windows 上第一次运行报 ENOENT、之后报 EPIPE。
export function resolvePackagedEsbuildBinary(locator: EsbuildBinaryLocator = {}): string | null {
  const env = locator.env ?? process.env
  // 用户显式配置的 ESBUILD_BINARY_PATH 优先，与 OFFLINE_JS_LAB_NODE 的处理一致。
  if (env.ESBUILD_BINARY_PATH) return null
  const resourcesPath = locator.resourcesPath ?? (process as { resourcesPath?: string }).resourcesPath
  // 开发模式与纯 Node 测试进程没有 Electron 的 resourcesPath，交由 esbuild 自行解析 node_modules。
  if (!resourcesPath) return null
  const platform = locator.platform ?? process.platform
  const arch = locator.arch ?? process.arch
  const subpath = platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild')
  const candidate = path.join(
    resourcesPath, 'app.asar.unpacked', 'node_modules', '@esbuild', `${platform}-${arch}`, subpath
  )
  const exists = locator.exists ?? ((path: string) => fsSync.existsSync(path))
  return exists(candidate) ? candidate : null
}

let compiler: EsbuildModule | null = null

export async function loadEsbuild(locator: EsbuildBinaryLocator = {}): Promise<EsbuildModule> {
  if (!compiler) {
    const binaryPath = resolvePackagedEsbuildBinary(locator)
    if (binaryPath) (locator.env ?? process.env).ESBUILD_BINARY_PATH = binaryPath
    compiler = await import('esbuild')
  }
  return compiler
}
