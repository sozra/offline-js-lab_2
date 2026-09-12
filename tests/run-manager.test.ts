import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunManager } from '../src/main/run-manager'
import type { WorkspaceService } from '../src/main/workspace'
import type { RunExitPayload, RunOutputPayload } from '../src/shared/types'

const roots: string[] = []
const testDirectory = path.dirname(fileURLToPath(import.meta.url))

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function waitFor(predicate: () => boolean, timeoutMs = 3000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('等待异步事件超时。')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

type Sent =
  | { channel: 'run:output'; payload: RunOutputPayload }
  | { channel: 'run:exit'; payload: RunExitPayload }

async function createFixture(compiledSource?: string): Promise<{
  root: string
  manager: RunManager
  workspace: WorkspaceService
}> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-js-lab-run-'))
  roots.push(root)
  const runsPath = path.join(root, '.offline-js-lab', 'runs')
  const nodeModulesPath = path.join(root, 'node_modules')
  await fs.mkdir(runsPath, { recursive: true })
  await fs.mkdir(nodeModulesPath, { recursive: true })

  const workspace = {
    getPath: () => root,
    getRunsPath: () => runsPath,
    getNodeModulesPath: () => nodeModulesPath
  } as WorkspaceService

  const getCompiler = compiledSource === undefined
    ? undefined
    : () => ({
        async build(options: { outfile?: string }) {
          if (!options.outfile) throw new Error('测试编译器缺少 outfile。')
          await fs.writeFile(options.outfile, compiledSource, 'utf8')
          return { errors: [], warnings: [] }
        }
      } as unknown as Pick<typeof import('esbuild'), 'build'>)

  const manager = new RunManager(
    workspace,
    () => path.resolve(testDirectory, '..', 'src', 'main', 'runner.cjs'),
    undefined,
    () => ({ command: process.execPath, argsPrefix: [], source: 'test' }),
    getCompiler
  )

  return { root, manager, workspace }
}

function createWebContents(sent: Sent[]): {
  isDestroyed: () => boolean
  send: (channel: string, payload: RunOutputPayload | RunExitPayload) => void
} {
  return {
    isDestroyed: () => false,
    send: (channel, payload) => sent.push({ channel, payload } as Sent)
  }
}

describe('RunManager', () => {
  it('esbuild target 使用探测的执行 Node 版本而不是宿主版本', async () => {
    const fixture = await createFixture()
    const build = vi.fn(async (options: import('esbuild').BuildOptions) => {
      await fs.writeFile(options.outfile!, 'console.log("target checked")', 'utf8')
      return { errors: [], warnings: [] }
    })
    const detectedVersion = process.versions.node === '18.20.8' ? '20.19.0' : '18.20.8'
    const manager = new RunManager(
      fixture.workspace,
      () => path.resolve(testDirectory, '..', 'src', 'main', 'runner.cjs'),
      undefined,
      () => ({ command: process.execPath, argsPrefix: [], source: 'test override' }),
      () => ({ build } as unknown as Pick<typeof import('esbuild'), 'build'>),
      async () => detectedVersion
    )
    expect(await manager.getRuntimeInfo()).toMatchObject({ version: detectedVersion })
    const sent: Sent[] = []
    const result = await manager.start(createWebContents(sent), {
      code: '1', language: 'javascript', sourceFilePath: null
    })
    expect(result.ok).toBe(true)
    expect(build).toHaveBeenCalledWith(expect.objectContaining({ target: [`node${detectedVersion}`] }))
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
  })

  it('为显式打印和纯表达式输出传递对应的源代码行号', async () => {
    const fixture = await createFixture()
    const sent: Sent[] = []
    const result = await fixture.manager.start(createWebContents(sent), {
      language: 'typescript',
      code: [
        'const value: number = 21',
        'value * 2',
        'console.log("mapped", await Promise.resolve(value))'
      ].join('\n'),
      sourceFilePath: null
    })

    expect(result.ok).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))

    const output = sent.filter(
      (item): item is Extract<Sent, { channel: 'run:output' }> => item.channel === 'run:output'
    )
    expect(output.filter((item) => item.payload.sourceLine)).toHaveLength(2)
    expect(output).toEqual(expect.arrayContaining([
      expect.objectContaining({
        payload: expect.objectContaining({ sourceLine: 2, stream: 'expression', text: '⇒ 42\n' })
      }),
      expect.objectContaining({
        payload: expect.objectContaining({ sourceLine: 3, stream: 'stdout', text: 'mapped 21\n' })
      })
    ]))
  })

  it('不接管同名局部 console，并保持参数只求值一次', async () => {
    const fixture = await createFixture()
    const sent: Sent[] = []
    const testCode = [
      'let calls = 0',
      'const console = { log(value: number) { calls += 1; return value } }',
      'const result = console.log(5)',
      ';[calls, result]'
    ].join('\n')
    const result = await fixture.manager.start(createWebContents(sent), {
      language: 'typescript',
      code: testCode,
      sourceFilePath: null
    })

    expect(result.ok).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))

    const positioned = sent.filter(
      (item): item is Extract<Sent, { channel: 'run:output' }> =>
        item.channel === 'run:output' && Boolean(item.payload.sourceLine)
    )
    expect(positioned).toHaveLength(1)
    expect(positioned[0]?.payload).toMatchObject({
      sourceLine: 4,
      stream: 'expression',
      text: '⇒ [ 1, 5 ]\n'
    })
  })

  it('隐式显示独立同步与异步调用的非 undefined 返回值', async () => {
    const fixture = await createFixture()
    const sent: Sent[] = []
    const testCode = [
      'let effects = 0',
      'function double(value: number) { effects += 1; return value * 2 }',
      'function touch() { effects += 1 }',
      'double(21)',
      'touch()',
      'await Promise.resolve(7)',
      'effects'
    ].join('\n')
    const result = await fixture.manager.start(createWebContents(sent), {
      language: 'typescript',
      code: testCode,
      sourceFilePath: null
    })

    expect(result.ok).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))

    const positioned = sent.filter(
      (item): item is Extract<Sent, { channel: 'run:output' }> =>
        item.channel === 'run:output' && Boolean(item.payload.sourceLine)
    )
    expect(positioned.map((item) => item.payload)).toEqual([
      expect.objectContaining({ sourceLine: 4, stream: 'expression', text: '⇒ 42\n' }),
      expect.objectContaining({ sourceLine: 6, stream: 'expression', text: '⇒ 7\n' }),
      expect.objectContaining({ sourceLine: 7, stream: 'expression', text: '⇒ 2\n' })
    ])
  })

  it('普通脚本打印后由系统 Node 自然结束', async () => {
    const fixture = await createFixture('console.log("hello from node");\n')
    const sent: Sent[] = []
    const result = await fixture.manager.start(createWebContents(sent), {
      language: 'typescript',
      code: 'console.log("source");',
      sourceFilePath: null
    })

    expect(result.ok).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))

    const output = sent
      .filter((item): item is Extract<Sent, { channel: 'run:output' }> => item.channel === 'run:output')
      .map((item) => item.payload.text)
      .join('')
    const exit = sent.find(
      (item): item is Extract<Sent, { channel: 'run:exit' }> => item.channel === 'run:exit'
    )

    expect(output).toMatch(/hello from node/)
    expect(exit?.payload.reason).toBe('completed')
    expect(exit?.payload.code).toBe(0)
  })

  it('长驻脚本没有超时，可由用户手动停止', async () => {
    const fixture = await createFixture('console.log("ready"); setInterval(() => {}, 1000);\n')
    const sent: Sent[] = []
    const result = await fixture.manager.start(createWebContents(sent), {
      language: 'javascript',
      code: 'setInterval(() => {}, 1000);',
      sourceFilePath: null
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    await waitFor(() => sent.some(
      (item) => item.channel === 'run:output' && item.payload.text.includes('ready')
    ))
    expect(fixture.manager.stop(result.runId)).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))

    const exit = sent.find(
      (item): item is Extract<Sent, { channel: 'run:exit' }> => item.channel === 'run:exit'
    )
    expect(exit?.payload.reason).toBe('stopped')
  })
})
