import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadEsbuild, resolvePackagedEsbuildBinary } from '../src/main/esbuild-loader'

describe('打包后的 esbuild 二进制解析', () => {
  it('定位 app.asar.unpacked 内的平台二进制：win32 用 esbuild.exe，unix 用 bin/esbuild', () => {
    const exists = (candidate: string) => candidate.endsWith('esbuild.exe') || candidate.endsWith(path.join('bin', 'esbuild'))
    const win = resolvePackagedEsbuildBinary({ resourcesPath: 'C:\\app\\resources', platform: 'win32', arch: 'x64', exists })
    expect(win).toBe(path.join('C:\\app\\resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'win32-x64', 'esbuild.exe'))
    const mac = resolvePackagedEsbuildBinary({ resourcesPath: '/app/Contents/Resources', platform: 'darwin', arch: 'arm64', exists })
    expect(mac).toBe(path.join('/app/Contents/Resources', 'app.asar.unpacked', 'node_modules', '@esbuild', 'darwin-arm64', 'bin', 'esbuild'))
  })

  it('二进制缺失、缺少 resourcesPath 或已有显式配置时不返回覆盖路径', () => {
    expect(resolvePackagedEsbuildBinary({ resourcesPath: '/r', platform: 'win32', arch: 'x64', exists: () => false })).toBeNull()
    expect(resolvePackagedEsbuildBinary({ platform: 'win32', arch: 'x64', exists: () => true })).toBeNull()
    expect(resolvePackagedEsbuildBinary({
      resourcesPath: '/r', platform: 'win32', arch: 'x64',
      env: { ESBUILD_BINARY_PATH: 'custom' }, exists: () => true
    })).toBeNull()
  })

  it('loadEsbuild 在首次动态 import 前写入打包二进制路径并返回可用编译 API', async () => {
    const env: NodeJS.ProcessEnv = {}
    const expected = path.join(
      '/r', 'app.asar.unpacked', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`,
      process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild')
    )
    const compiler = await loadEsbuild({ resourcesPath: '/r', env, exists: () => true })
    expect(typeof compiler.build).toBe('function')
    expect(env.ESBUILD_BINARY_PATH).toBe(expected)
  })
})
