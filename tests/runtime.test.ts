import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { resolveNodeRuntime, resolveNpmRuntime } from '../src/main/runtime'

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
})
