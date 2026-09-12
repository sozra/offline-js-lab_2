import fs from 'node:fs/promises'
import crypto from 'node:crypto'
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
  it('解析输入JSON和文本、保留调用方runId，并在结束后删除所有临时文件', async () => {
    const fixture = await createFixture()
    const sent: Sent[] = []
    const runId = crypto.randomUUID()
    const result = await fixture.manager.start(createWebContents(sent), {
      runId, code: 'console.log(lab.input.answer, lab.inputText)', language: 'typescript',
      sourceFilePath: null, input: { format: 'json', text: '{"answer":42}' }
    })
    expect(result).toMatchObject({ ok: true, runId })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent).toEqual(expect.arrayContaining([expect.objectContaining({ payload: expect.objectContaining({ text: '42 {"answer":42}\n' }) })]))
    expect(await fs.readdir(fixture.workspace.getRunsPath())).toEqual([])
    expect(fixture.manager.hasActiveRuns()).toBe(false)
    sent.length = 0
    await fixture.manager.start(createWebContents(sent), {
      code: 'lab.input', language: 'javascript', sourceFilePath: null,
      input: { format: 'text', text: 'hello\nworld' }
    })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent.some((item) => item.channel === 'run:output' && item.payload.values?.[0]?.preview === '"hello\\nworld"')).toBe(true)
  })

  it('输入错误和浏览器语言在启动前返回明确错误', async () => {
    const { manager, workspace } = await createFixture()
    const sent: Sent[] = []
    const invalid = await manager.start(createWebContents(sent), {
      code: 'console.log("must not run")', language: 'javascript', sourceFilePath: null,
      input: { format: 'json', text: '{' }
    })
    expect(invalid).toMatchObject({ ok: false, error: expect.stringContaining('有效 JSON') })
    expect(await manager.start(createWebContents(sent), { code: '<h1 />', language: 'jsx', sourceFilePath: null }))
      .toMatchObject({ ok: false, error: expect.stringContaining('浏览器预览') })
    expect(sent).toHaveLength(0)
    expect(await fs.readdir(workspace.getRunsPath())).toEqual([])
    expect(manager.hasActiveRuns()).toBe(false)
  })

  it('编译错误和运行错误定位到AST插入之前的原始源码行列', async () => {
    const fixture = await createFixture()
    const sent: Sent[] = []
    const invalidCode = 'console.log("before"); const value = ;'
    const buildError = await fixture.manager.start(createWebContents(sent), {
      code: invalidCode, language: 'typescript', sourceFilePath: null
    })
    expect(buildError, JSON.stringify(buildError)).toMatchObject({ ok: false, location: { line: 1, column: invalidCode.lastIndexOf(';') + 1 } })
    expect(await fs.readdir(fixture.workspace.getRunsPath())).toEqual([])
    const runtimeCode = 'console.log("你好"); missingFunction()'
    await fixture.manager.start(createWebContents(sent), { code: runtimeCode, language: 'javascript', sourceFilePath: null })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent).toEqual(expect.arrayContaining([
      expect.objectContaining({ channel: 'run:output', payload: expect.objectContaining({
        stream: 'stderr', text: expect.stringContaining('ReferenceError'),
        location: { file: path.join(fixture.root, 'scratch.js'), line: 1, column: runtimeCode.indexOf('missingFunction') + 1 }
      }) }),
      expect.objectContaining({ channel: 'run:exit', payload: expect.objectContaining({ reason: 'failed', code: 1 }) })
    ]))
  })

  it('有界结构化对象保留循环引用与访问器，且不调用getter、toJSON或自定义inspect', async () => {
    const { manager } = await createFixture()
    const sent: Sent[] = []
    await manager.start(createWebContents(sent), {
      language: 'typescript', sourceFilePath: null,
      code: [
        'import { inspect } from "node:util"',
        'let sideEffects = 0',
        'const value: any = { answer: 42, list: [1, 2], toJSON() { sideEffects++; return "unsafe" } }',
        'Object.defineProperty(value, "danger", { enumerable: true, get() { sideEffects++; throw new Error("getter called") } })',
        'value[inspect.custom] = () => { sideEffects++; return "unsafe" }',
        'value.self = value',
        'console.log("%j %s %o", value, value, value)',
        'sideEffects'
      ].join('\n')
    })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    const outputs = sent.filter((item): item is Extract<Sent, { channel: 'run:output' }> => item.channel === 'run:output')
    const printed = outputs.find((item) => item.payload.sourceLine === 7)?.payload
    expect(printed?.values?.[1]?.children).toEqual(expect.arrayContaining([
      { key: 'answer', value: { kind: 'number', preview: '42' } },
      { key: 'danger', value: { kind: 'accessor', preview: '[Getter]' } },
      { key: 'self', value: { kind: 'circular', preview: '[Circular / shared reference]' } }
    ]))
    expect(outputs.find((item) => item.payload.sourceLine === 8)?.payload.text).toBe('⇒ 0\n')
    expect(sent.find((item) => item.channel === 'run:exit')?.payload).toMatchObject({ reason: 'completed' })
  })

  it('编译准备期间拒绝并行启动，可取消并紧接着执行最新代码', async () => {
    const fixture = await createFixture()
    let resolveVersion!: (value: string) => void
    const version = new Promise<string>((resolve) => { resolveVersion = resolve })
    const manager = new RunManager(fixture.workspace,
      () => path.resolve(testDirectory, '..', 'src', 'main', 'runner.cjs'), undefined,
      () => ({ command: process.execPath, argsPrefix: [], source: 'test' }), undefined, () => version)
    const sent: Sent[] = []
    const runId = crypto.randomUUID()
    const pending = manager.start(createWebContents(sent), { runId, code: '"old"', language: 'javascript', sourceFilePath: null })
    expect(manager.hasActiveRuns()).toBe(true)
    expect(await manager.start(createWebContents(sent), { code: '"parallel"', language: 'javascript', sourceFilePath: null })).toMatchObject({ ok: false })
    expect(manager.stop(runId)).toBe(true)
    resolveVersion(process.versions.node)
    expect(await pending).toMatchObject({ ok: false, error: '运行已取消。' })
    expect(sent).toHaveLength(0)
    expect(await manager.start(createWebContents(sent), { code: 'console.log("latest")', language: 'javascript', sourceFilePath: null })).toMatchObject({ ok: true })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent.some((item) => item.channel === 'run:output' && item.payload.text === 'latest\n')).toBe(true)
  })

  it('强制停止会结束忽略SIGTERM的脚本', async () => {
    const { manager } = await createFixture('process.on("SIGTERM", () => {}); console.log("ready"); setInterval(() => {}, 1000)')
    const sent: Sent[] = []
    const result = await manager.start(createWebContents(sent), { code: '', language: 'javascript', sourceFilePath: null })
    if (!result.ok) throw new Error(result.error)
    await waitFor(() => sent.some((item) => item.channel === 'run:output' && item.payload.text.includes('ready')))
    expect(manager.forceStop(result.runId)).toBe(true)
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent.find((item) => item.channel === 'run:exit')?.payload).toMatchObject({ reason: 'stopped' })
    expect(manager.hasActiveRuns()).toBe(false)
  })

  it.skipIf(process.platform === 'win32')('普通停止同时通知并结束POSIX子进程树', async () => {
    const descendantCode = 'process.on("SIGTERM", () => { console.log("descendant stopped"); process.exit(0) }); console.log("descendant ready"); setInterval(() => {}, 1000)'
    const { manager } = await createFixture([
      'import { spawn } from "node:child_process";',
      `spawn(process.execPath, ['-e', ${JSON.stringify(descendantCode)}], { stdio: 'inherit' });`,
      'setInterval(() => {}, 1000);'
    ].join('\n'))
    const sent: Sent[] = []
    const result = await manager.start(createWebContents(sent), { code: '', language: 'javascript', sourceFilePath: null })
    if (!result.ok) throw new Error(result.error)
    try {
      await waitFor(() => sent.some((item) => item.channel === 'run:output' && item.payload.text.includes('descendant ready')))
      expect(manager.stop(result.runId)).toBe(true)
      await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
      expect(sent.some((item) => item.channel === 'run:output' && item.payload.text.includes('descendant stopped'))).toBe(true)
    } finally { manager.stopAll() }
  })

  it('大型数组、深层对象、超长Symbol及Proxy快照有界且不执行陷阱', async () => {
    const { manager } = await createFixture()
    const sent: Sent[] = []
    await manager.start(createWebContents(sent), {
      language: 'javascript', sourceFilePath: null,
      code: [
        'const big = Array.from({ length: 1000 }, (_, index) => ({ index, value: "x".repeat(5000) }))',
        'const proxy = new Proxy({}, { ownKeys() { throw new Error("trap called") } })',
        'console.log(big, Symbol("s".repeat(100000)), proxy)'
      ].join('\n')
    })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    const rich = sent.find((item): item is Extract<Sent, { channel: 'run:output' }> => item.channel === 'run:output' && Boolean(item.payload.values))?.payload
    expect(rich?.values?.[0]?.truncated).toBe(true)
    expect(JSON.stringify(rich?.values).length).toBeLessThan(200000)
    expect(sent.find((item) => item.channel === 'run:exit')?.payload).toMatchObject({ reason: 'completed' })
    expect(sent.some((item) => item.channel === 'run:output' && item.payload.text.includes('内部输出协议错误'))).toBe(false)
  })

  it('结构化元数据与文本共用8MB上限', async () => {
    const { manager } = await createFixture([
      'import fs from "node:fs";',
      'const record = Buffer.from(JSON.stringify({ stream: "stdout", text: "", values: [{ kind: "string", preview: "x".repeat(16000) }] }) + "\\n");',
      'for (let i = 0; i < 700; i++) { let offset = 0; while (offset < record.length) offset += fs.writeSync(3, record, offset); }',
      'setInterval(() => {}, 1000);'
    ].join('\n'))
    const sent: Sent[] = []
    await manager.start(createWebContents(sent), { code: '', language: 'javascript', sourceFilePath: null })
    await waitFor(() => sent.some((item) => item.channel === 'run:exit'))
    expect(sent.find((item) => item.channel === 'run:exit')?.payload).toMatchObject({ reason: 'output-limit' })
    expect(sent.some((item) => item.channel === 'run:output' && item.payload.text.includes('8 MB'))).toBe(true)
  })

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
