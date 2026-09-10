import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { WebContents } from 'electron'
import * as esbuild from 'esbuild'
import { IPC } from '@shared/ipc'
import type {
  RunExitPayload,
  RunExitReason,
  RunOutputPayload,
  RunStartPayload,
  RunStartResult,
  RuntimeDescriptor
} from '@shared/types'
import type { WorkspaceService } from './workspace'
import {
  createChildEnvironment,
  describeRuntime,
  resolveNodeRuntime
} from './runtime'
import { instrumentSource } from './source-instrumenter'

const MAX_CODE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_STRUCTURED_FRAME_BYTES = 512 * 1024

const ESM_COMPATIBILITY_BANNER = `
import { createRequire as __offlineCreateRequire } from 'node:module';
import { fileURLToPath as __offlineFileURLToPath } from 'node:url';
import { dirname as __offlineDirname } from 'node:path';
const require = __offlineCreateRequire(import.meta.url);
const __filename = __offlineFileURLToPath(import.meta.url);
const __dirname = __offlineDirname(__filename);
`

type SpawnProcess = typeof spawn
type WebContentsTarget = Pick<WebContents, 'isDestroyed' | 'send'>
type Compiler = Pick<typeof esbuild, 'build'>

interface RunRecord {
  child: ChildProcess
  outputPath: string
  reason: RunExitReason
  startedAt: number
  outputBytes: number
  outputLimited: boolean
}

interface EsbuildLikeError extends Error {
  errors?: Array<{
    text: string
    location?: { file?: string; line: number; column: number } | null
  }>
}

export function formatBuildError(error: unknown): string {
  const buildError = error as EsbuildLikeError
  if (!Array.isArray(buildError?.errors) || buildError.errors.length === 0) {
    return error instanceof Error ? error.message : String(error)
  }

  return buildError.errors
    .map((item) => {
      if (!item.location) return item.text
      const file = item.location.file || 'scratch'
      return `${file}:${item.location.line}:${item.location.column + 1} ${item.text}`
    })
    .join('\n')
}

async function removeQuietly(filePath: string): Promise<void> {
  try {
    await fs.rm(filePath, { force: true })
  } catch {
    // A stale temporary file is preferable to losing the process close event.
  }
}

function send<T>(webContents: WebContentsTarget, channel: string, payload: T): void {
  if (!webContents.isDestroyed()) webContents.send(channel, payload)
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>()

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly getRunnerPath: () => string,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly resolveRuntime: () => RuntimeDescriptor = resolveNodeRuntime,
    private readonly getCompiler: () => Compiler = () => esbuild
  ) {}

  getRuntimeInfo(): { command: string; source: string } {
    const runtime = this.resolveRuntime()
    return { command: describeRuntime(runtime), source: runtime.source }
  }

  async start(webContents: WebContentsTarget, payload: RunStartPayload): Promise<RunStartResult> {
    const code = typeof payload?.code === 'string' ? payload.code : ''
    const language = payload?.language === 'javascript' ? 'javascript' : 'typescript'
    const sourceFilePath = payload?.sourceFilePath ? path.resolve(payload.sourceFilePath) : null

    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return {
        ok: false,
        error: `脚本超过 ${MAX_CODE_BYTES / 1024 / 1024} MB 的 MVP 限制。`
      }
    }

    const runId = crypto.randomUUID()
    const outputPath = path.join(this.workspace.getRunsPath(), `${runId}.mjs`)
    const resolveDir = sourceFilePath ? path.dirname(sourceFilePath) : this.workspace.getPath()
    const sourceFile = sourceFilePath
      ? path.basename(sourceFilePath)
      : language === 'typescript'
        ? 'scratch.ts'
        : 'scratch.js'

    await fs.mkdir(this.workspace.getRunsPath(), { recursive: true })

    try {
      const compiler = this.getCompiler()
      const nodeMajor = Number.parseInt(process.versions.node.split('.')[0] ?? '22', 10)
      await compiler.build({
        stdin: {
          contents: instrumentSource(code, language).code,
          loader: language === 'typescript' ? 'ts' : 'js',
          resolveDir,
          sourcefile: sourceFile
        },
        absWorkingDir: this.workspace.getPath(),
        banner: { js: ESM_COMPATIBILITY_BANNER },
        bundle: true,
        charset: 'utf8',
        format: 'esm',
        legalComments: 'none',
        logLevel: 'silent',
        nodePaths: [this.workspace.getNodeModulesPath()],
        outfile: outputPath,
        platform: 'node',
        sourcemap: 'inline',
        target: [`node${Number.isFinite(nodeMajor) ? nodeMajor : 22}`]
      })
    } catch (error) {
      await removeQuietly(outputPath)
      return { ok: false, error: formatBuildError(error) }
    }

    const runtime = this.resolveRuntime()
    const args = [...runtime.argsPrefix, this.getRunnerPath(), outputPath]
    let child: ChildProcess

    try {
      child = this.spawnProcess(runtime.command, args, {
        cwd: this.workspace.getPath(),
        env: createChildEnvironment({ OFFLINE_JS_LAB: '1' }),
        shell: false,
        stdio: ['ignore', 'pipe', 'pipe', 'pipe'],
        windowsHide: true
      })
    } catch (error) {
      await removeQuietly(outputPath)
      return { ok: false, error: `无法启动 Node.js 执行进程：${toErrorMessage(error)}` }
    }

    const record: RunRecord = {
      child,
      outputPath,
      reason: 'completed',
      startedAt: Date.now(),
      outputBytes: 0,
      outputLimited: false
    }
    this.runs.set(runId, record)

    const terminateForOutputLimit = (message?: string): void => {
      const currentRecord = this.runs.get(runId)
      if (!currentRecord || currentRecord.outputLimited) return
      currentRecord.outputLimited = true
      currentRecord.reason = 'output-limit'
      send<RunOutputPayload>(webContents, IPC.runOutput, {
        runId,
        stream: 'system',
        text: message ?? `\n输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已终止执行进程。\n`
      })
      currentRecord.child.kill()
    }

    const forwardOutput = (
      stream: 'stdout' | 'stderr' | 'expression',
      chunk: unknown,
      sourceLine?: number
    ): void => {
      const currentRecord = this.runs.get(runId)
      if (!currentRecord || currentRecord.outputLimited) return

      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - currentRecord.outputBytes)
      const accepted = buffer.subarray(0, remaining)

      if (accepted.length > 0) {
        const payload: RunOutputPayload = {
          runId,
          stream,
          text: accepted.toString('utf8')
        }
        if (sourceLine && Number.isInteger(sourceLine)) payload.sourceLine = sourceLine
        send(webContents, IPC.runOutput, payload)
      }

      currentRecord.outputBytes += buffer.length
      if (buffer.length > remaining) {
        terminateForOutputLimit()
      }
    }

    child.stdout?.on('data', (chunk) => forwardOutput('stdout', chunk))
    child.stderr?.on('data', (chunk) => forwardOutput('stderr', chunk))

    const structuredOutput = child.stdio[3]
    if (structuredOutput && 'on' in structuredOutput) {
      const decoder = new StringDecoder('utf8')
      let pending = ''

      const consumeRecords = (flush = false): void => {
        const records = pending.split('\n')
        pending = flush ? '' : (records.pop() ?? '')
        for (const record of records) {
          if (!record) continue
          try {
            const parsed = JSON.parse(record) as {
              line?: unknown
              stream?: unknown
              text?: unknown
            }
            if (
              !Number.isInteger(parsed.line) ||
              Number(parsed.line) < 1 ||
              (parsed.stream !== 'stdout' &&
                parsed.stream !== 'stderr' &&
                parsed.stream !== 'expression') ||
              typeof parsed.text !== 'string'
            ) {
              throw new Error('invalid record')
            }
            forwardOutput(parsed.stream, parsed.text, Number(parsed.line))
          } catch {
            forwardOutput('stderr', '[内部输出协议错误：已忽略一条无法解析的行定位记录。]\n')
          }
        }
      }

      structuredOutput.on('data', (chunk) => {
        pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk)))
        if (Buffer.byteLength(pending, 'utf8') > MAX_STRUCTURED_FRAME_BYTES) {
          pending = ''
          terminateForOutputLimit('\n行定位输出记录异常过大，已终止执行进程。\n')
          return
        }
        consumeRecords()
      })
      structuredOutput.on('end', () => {
        pending += decoder.end()
        if (pending) pending += '\n'
        consumeRecords(true)
      })
    }

    child.once('error', (error) => {
      const currentRecord = this.runs.get(runId)
      if (currentRecord) currentRecord.reason = 'failed'
      send<RunOutputPayload>(webContents, IPC.runOutput, {
        runId,
        stream: 'stderr',
        text:
          `无法启动 Node.js：${error.message}\n` +
          '请确认 Node.js 位于 PATH 中，或使用 npm start 启动应用。\n'
      })
    })

    child.once('close', async (code, signal) => {
      const latestRecord = this.runs.get(runId) ?? record
      this.runs.delete(runId)
      await removeQuietly(outputPath)

      if (latestRecord.reason === 'completed' && Number.isInteger(code) && code !== 0) {
        latestRecord.reason = 'failed'
      }

      const exitPayload: RunExitPayload = {
        runId,
        code: Number.isInteger(code) ? code : null,
        signal: signal ?? null,
        reason: latestRecord.reason,
        durationMs: Date.now() - latestRecord.startedAt
      }
      send(webContents, IPC.runExit, exitPayload)
    })

    return { ok: true, runId, runtime: describeRuntime(runtime) }
  }

  stop(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record) return false
    record.reason = 'stopped'
    return record.child.kill()
  }

  stopAll(): void {
    for (const record of this.runs.values()) {
      record.reason = 'app-closed'
      record.child.kill()
    }
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
