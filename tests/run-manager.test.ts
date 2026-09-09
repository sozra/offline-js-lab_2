import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
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

async function createFixture(compiledSource: string): Promise<{
  root: string
  manager: RunManager
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

  const manager = new RunManager(
    workspace,
    () => path.resolve(testDirectory, '..', 'src', 'main', 'runner.cjs'),
    undefined,
    () => ({ command: process.execPath, argsPrefix: [], source: 'test' }),
    () => ({
      async build(options: { outfile?: string }) {
        if (!options.outfile) throw new Error('测试编译器缺少 outfile。')
        await fs.writeFile(options.outfile, compiledSource, 'utf8')
        return { errors: [], warnings: [] }
      }
    } as unknown as Pick<typeof import('esbuild'), 'build'>)
  )

  return { root, manager }
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
