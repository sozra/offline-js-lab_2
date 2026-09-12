import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { probeNodeVersion, resolveNodeRuntime, resolveNpmRuntime } from '../src/main/runtime'

describe('runtime resolution', () => {
  it('优先复用 npm start 注入的 Node 与 npm CLI', () => {
    const currentFile = fileURLToPath(import.meta.url)
    const env = {
      npm_node_execpath: process.execPath,
      npm_execpath: currentFile
    }

    const nodeRuntime = resolveNodeRuntime(env, process.platform)
    const npmRuntime = resolveNpmRuntime(env, process.platform)

    expect(nodeRuntime.command).toBe(process.execPath)
    expect(nodeRuntime.source).toBe('npm_node_execpath')
    expect(npmRuntime.command).toBe(process.execPath)
    expect(npmRuntime.argsPrefix).toEqual([currentFile])
  })

  it('为 Windows 与 macOS/Linux 提供 PATH 回退', () => {
    expect(resolveNodeRuntime({}, 'win32').command).toBe('node.exe')
    expect(resolveNpmRuntime({}, 'win32').command).toBe('npm.cmd')
    expect(resolveNodeRuntime({}, 'darwin').command).toBe('node')
    expect(resolveNpmRuntime({}, 'darwin').command).toBe('npm')
  })

  it('显式 Node 配置优先于 npm 注入，并保留无效路径供诊断', () => {
    expect(resolveNodeRuntime({
      npm_node_execpath: process.execPath,
      OFFLINE_JS_LAB_NODE: '/missing/custom-node'
    })).toMatchObject({ command: '/missing/custom-node', source: 'OFFLINE_JS_LAB_NODE' })
  })

  it('检测实际系统 Node 版本，并复用相同命令和参数的探测', async () => {
    const runtime = { command: process.execPath, argsPrefix: [], source: 'test' }
    const first = probeNodeVersion(runtime)
    expect(probeNodeVersion({ ...runtime })).toBe(first)
    await expect(first).resolves.toBe(process.versions.node)
    await expect(probeNodeVersion({ ...runtime, command: '/missing/custom-node' })).rejects.toThrow('无法检测 Node.js 版本')
  })
})
