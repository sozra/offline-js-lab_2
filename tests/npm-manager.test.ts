import { EventEmitter } from 'node:events'
import { PassThrough } from 'node:stream'
import type { ChildProcess, SpawnOptions } from 'node:child_process'
import { describe, expect, it } from 'vitest'
import {
  NpmManager,
  buildNpmArguments,
  parsePackageSpecs
} from '../src/main/npm-manager'
import type { WorkspaceService } from '../src/main/workspace'

class FakeChild extends EventEmitter {
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false

  kill(): boolean {
    this.killed = true
    queueMicrotask(() => this.emit('close', null, 'SIGTERM'))
    return true
  }
}

describe('npm package parsing', () => {
  it('解析普通包、版本包与 scoped 包', () => {
    expect(parsePackageSpecs('lodash dayjs\n@types/lodash lodash@4.17.21')).toEqual([
      'lodash',
      'dayjs',
      '@types/lodash',
      'lodash@4.17.21'
    ])
    expect(() => parsePackageSpecs('--registry=https://bad.example')).toThrow(/不支持/)
  })

  it('生成标准 npm install 参数', () => {
    expect(buildNpmArguments('install', { specs: 'lodash dayjs', dev: false })).toEqual([
      'install',
      'lodash',
      'dayjs',
      '--save',
      '--no-audit',
      '--no-fund',
      '--color=false'
    ])
    expect(buildNpmArguments('install', { specs: '@types/lodash', dev: true })).toContain('--save-dev')
  })
})

describe('NpmManager', () => {
  it('在工作区调用解析出的 npm CLI 并转发输出', async () => {
    const calls: Array<{ command: string; args: readonly string[]; options: SpawnOptions }> = []
    const outputs: string[] = []
    let child: FakeChild | undefined

    const workspace = { getPath: () => '/tmp/offline-js-lab-test' } as WorkspaceService
    const manager = new NpmManager(
      workspace,
      ((command: string, args: readonly string[], options: SpawnOptions) => {
        child = new FakeChild()
        calls.push({ command, args, options })
        queueMicrotask(() => {
          child?.stdout.write('added 2 packages\n')
          child?.stdout.end()
          child?.stderr.end()
          child?.emit('close', 0, null)
        })
        return child as unknown as ChildProcess
      }) as typeof import('node:child_process').spawn,
      () => ({
        command: '/fake/node',
        argsPrefix: ['/fake/npm-cli.js'],
        source: 'test'
      })
    )

    const result = await manager.run(
      'install',
      { specs: 'lodash dayjs', dev: false },
      (output) => outputs.push(output.text)
    )

    expect(result.ok).toBe(true)
    expect(calls[0]?.command).toBe('/fake/node')
    expect(calls[0]?.args.slice(0, 4)).toEqual([
      '/fake/npm-cli.js',
      'install',
      'lodash',
      'dayjs'
    ])
    expect(calls[0]?.options.cwd).toBe('/tmp/offline-js-lab-test')
    expect(outputs.join('')).toMatch(/added 2 packages/)
  })
})
