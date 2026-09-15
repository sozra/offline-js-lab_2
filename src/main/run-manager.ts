import crypto from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import fs from 'node:fs/promises'
import path from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import { parseScriptInput } from '@shared/input'
import type {
  RunExitPayload, RunExitReason, RunOutputPayload, RunStartPayload, RunStartResult,
  RuntimeDescriptor, RuntimeInfo, SourceLocation, ValueSnapshot
} from '@shared/types'
import type { WorkspaceService } from './workspace'
import { createChildEnvironment, describeRuntime, probeNodeVersion, resolveNodeRuntime } from './runtime'
import { instrumentSource, type InstrumentSourceResult } from './source-instrumenter'
import { loadEsbuild } from './esbuild-loader'

const MAX_CODE_BYTES = 2 * 1024 * 1024
const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_STRUCTURED_FRAME_BYTES = 512 * 1024
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
type Compiler = Pick<typeof import('esbuild'), 'build'>
type OutputMetadata = Pick<RunOutputPayload, 'sourceLine' | 'location' | 'values'>
interface RunRecord {
  child: ChildProcess
  outputPath: string
  inputPath: string
  reason: RunExitReason
  startedAt: number
  outputBytes: number
  outputLimited: boolean
}
interface EsbuildLikeError extends Error {
  errors?: Array<{ text: string; location?: { file?: string; line: number; column: number } | null }>
}

export function formatBuildError(error: unknown): string {
  const buildError = error as EsbuildLikeError
  if (!Array.isArray(buildError?.errors) || buildError.errors.length === 0) {
    return error instanceof Error ? error.message : String(error)
  }
  return buildError.errors.map((item) => !item.location ? item.text :
    `${item.location.file || 'scratch'}:${item.location.line}:${item.location.column + 1} ${item.text}`
  ).join('\n')
}

function mapBuildError(error: unknown, sourceFile: string, instrumented?: InstrumentSourceResult): {
  error: string; location?: SourceLocation
} {
  const buildError = error as EsbuildLikeError
  const mapped = buildError.errors?.map((item) => {
    if (!item.location) return item
    const isEntry = item.location.file === sourceFile ||
      item.location.file === path.basename(sourceFile) ||
      (item.location.file && path.resolve(item.location.file) === sourceFile) ||
      sourceFile.endsWith(path.sep + item.location.file)
    const generatedLine = instrumented?.code.split('\n')[item.location.line - 1] ?? ''
    const generatedColumn = Buffer.from(generatedLine).subarray(0, item.location.column).toString('utf8').length + 1
    const position = isEntry && instrumented
      ? instrumented.originalPosition(item.location.line, generatedColumn)
      : { line: item.location.line, column: item.location.column + 1 }
    return { ...item, location: { file: isEntry ? sourceFile : item.location.file, line: position.line, column: position.column - 1 } }
  })
  const first = mapped?.find((item) => item.location)?.location
  return {
    error: mapped ? formatBuildError({ errors: mapped }) : formatBuildError(error),
    location: first ? { file: first.file, line: first.line, column: first.column + 1 } : undefined
  }
}

async function removeQuietly(...filePaths: string[]): Promise<void> {
  await Promise.all(filePaths.map(async (filePath) => {
    try { await fs.rm(filePath, { force: true }) } catch { /* Preserve the process close event. */ }
  }))
}
function send<T>(webContents: WebContentsTarget, channel: string, payload: T): void {
  if (!webContents.isDestroyed()) webContents.send(channel, payload)
}
function readLocation(value: unknown): SourceLocation | undefined {
  if (!value || typeof value !== 'object') return undefined
  const location = value as SourceLocation
  if (!Number.isInteger(location.line) || location.line < 1 ||
    !Number.isInteger(location.column) || location.column < 1 ||
    (location.file !== undefined && typeof location.file !== 'string')) return undefined
  return { line: location.line, column: location.column, file: location.file?.slice(0, 4096) }
}
function readSnapshots(value: unknown): ValueSnapshot[] | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value) || value.length > 100) throw new Error('invalid snapshots')
  let nodes = 0
  const read = (item: unknown, depth: number): ValueSnapshot => {
    if (++nodes > 500 || depth > 8 || !item || typeof item !== 'object') throw new Error('invalid snapshot')
    const candidate = item as ValueSnapshot
    if (typeof candidate.kind !== 'string' || typeof candidate.preview !== 'string' ||
      candidate.kind.length > 40 || candidate.preview.length > 32768) throw new Error('invalid snapshot')
    const result: ValueSnapshot = { kind: candidate.kind, preview: candidate.preview }
    if (candidate.truncated) result.truncated = true
    if (candidate.children !== undefined) {
      if (!Array.isArray(candidate.children) || candidate.children.length > 100) throw new Error('invalid children')
      result.children = candidate.children.map((child) => {
        if (!child || typeof child.key !== 'string' || child.key.length > 1024) throw new Error('invalid key')
        return { key: child.key, value: read(child.value, depth + 1) }
      })
    }
    return result
  }
  return value.map((item) => read(item, 0))
}

export class RunManager {
  private readonly runs = new Map<string, RunRecord>()
  private preparing: { runId: string; cancelled: boolean } | null = null

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly getRunnerPath: () => string,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly resolveRuntime: () => RuntimeDescriptor = resolveNodeRuntime,
    private readonly getCompiler: () => Compiler | Promise<Compiler> = () => loadEsbuild(),
    private readonly getNodeVersion: (runtime: RuntimeDescriptor) => Promise<string> = probeNodeVersion
  ) {}

  async getRuntimeInfo(): Promise<RuntimeInfo> {
    const runtime = this.resolveRuntime()
    const version = await this.getNodeVersion(runtime).catch(() => undefined)
    return { command: describeRuntime(runtime), source: runtime.source, version }
  }

  hasActiveRuns(): boolean { return this.preparing !== null || this.runs.size > 0 }

  async start(webContents: WebContentsTarget, payload: RunStartPayload): Promise<RunStartResult> {
    if (this.hasActiveRuns()) return { ok: false, error: '上一次运行仍在准备或执行，请先停止。' }
    if (payload?.language !== 'javascript' && payload?.language !== 'typescript') {
      return { ok: false, error: 'JSX/TSX 组件请切换到浏览器预览运行。' }
    }
    const runId = typeof payload.runId === 'string' && UUID.test(payload.runId) ? payload.runId : crypto.randomUUID()
    this.preparing = { runId, cancelled: false }
    try {
      return await this.startPrepared(webContents, payload, runId)
    } finally {
      if (this.preparing?.runId === runId) this.preparing = null
    }
  }

  private async startPrepared(webContents: WebContentsTarget, payload: RunStartPayload, runId: string): Promise<RunStartResult> {
    const code = typeof payload.code === 'string' ? payload.code : ''
    const language = payload.language === 'javascript' ? 'javascript' : 'typescript'
    const sourceFilePath = typeof payload.sourceFilePath === 'string' && payload.sourceFilePath ? path.resolve(payload.sourceFilePath) : null
    if (Buffer.byteLength(code, 'utf8') > MAX_CODE_BYTES) {
      return { ok: false, error: `脚本超过 ${MAX_CODE_BYTES / 1024 / 1024} MB 的限制。` }
    }
    const outputPath = path.join(this.workspace.getRunsPath(), `${runId}.mjs`)
    const inputPath = path.join(this.workspace.getRunsPath(), `${runId}.input.json`)
    const resolveDir = sourceFilePath ? path.dirname(sourceFilePath) : this.workspace.getPath()
    const sourceFile = sourceFilePath ?? path.join(resolveDir, language === 'typescript' ? 'scratch.ts' : 'scratch.js')
    const runtime = this.resolveRuntime()
    let instrumented: InstrumentSourceResult | undefined
    try {
      const input = parseScriptInput(payload.input)
      const nodeVersion = await this.getNodeVersion(runtime)
      if (this.preparing?.cancelled) return { ok: false, error: '运行已取消。' }
      await fs.mkdir(this.workspace.getRunsPath(), { recursive: true })
      instrumented = instrumentSource(code, language, sourceFile)
      const compiler = await this.getCompiler()
      await compiler.build({
        stdin: {
          contents: instrumented.code + '\n//# sourceMappingURL=data:application/json;base64,' + Buffer.from(instrumented.sourceMap).toString('base64'),
          loader: language === 'typescript' ? 'ts' : 'js', resolveDir, sourcefile: sourceFile
        },
        absWorkingDir: this.workspace.getPath(), banner: { js: ESM_COMPATIBILITY_BANNER },
        bundle: true, charset: 'utf8', format: 'esm', legalComments: 'none', logLevel: 'silent',
        nodePaths: [this.workspace.getNodeModulesPath()], outfile: outputPath,
        platform: 'node', sourcemap: 'inline', target: [`node${nodeVersion}`]
      })
      await fs.writeFile(inputPath, JSON.stringify({ ...input, sourceFile }), { encoding: 'utf8', mode: 0o600 })
    } catch (error) {
      await removeQuietly(outputPath, inputPath)
      return { ok: false, ...mapBuildError(error, sourceFile, instrumented) }
    }
    if (this.preparing?.cancelled) {
      await removeQuietly(outputPath, inputPath)
      return { ok: false, error: '运行已取消。' }
    }
    let child: ChildProcess
    try {
      child = this.spawnProcess(runtime.command, [...runtime.argsPrefix, '--enable-source-maps', this.getRunnerPath(), outputPath, inputPath], {
        cwd: this.workspace.getPath(), env: createChildEnvironment({ OFFLINE_JS_LAB: '1' }),
        shell: false, stdio: ['ignore', 'pipe', 'pipe', 'pipe'], windowsHide: true,
        // POSIX groups allow ABORT to stop ordinary descendant processes too.
        detached: process.platform !== 'win32'
      })
    } catch (error) {
      await removeQuietly(outputPath, inputPath)
      return { ok: false, error: `无法启动 Node.js 执行进程：${toErrorMessage(error)}` }
    }
    const record: RunRecord = { child, outputPath, inputPath, reason: 'completed', startedAt: Date.now(), outputBytes: 0, outputLimited: false }
    this.runs.set(runId, record)
    const terminateForOutputLimit = (message?: string): void => {
      const current = this.runs.get(runId)
      if (!current || current.outputLimited) return
      current.outputLimited = true
      current.reason = 'output-limit'
      send<RunOutputPayload>(webContents, IPC.runOutput, {
        runId, stream: 'system', text: message ?? `\n输出超过 ${MAX_OUTPUT_BYTES / 1024 / 1024} MB，已终止执行进程。\n`
      })
      this.terminateTree(current, true)
    }
    const forwardOutput = (stream: 'stdout' | 'stderr' | 'expression', text: string, metadata: OutputMetadata = {}, byteCost = Buffer.byteLength(text)): void => {
      const current = this.runs.get(runId)
      if (!current || current.outputLimited) return
      const remaining = Math.max(0, MAX_OUTPUT_BYTES - current.outputBytes)
      if (byteCost <= remaining) {
        if (text || metadata.values?.length) send(webContents, IPC.runOutput, { runId, stream, text, ...metadata })
      } else {
        const accepted = Buffer.from(text).subarray(0, remaining)
        if (accepted.length) send(webContents, IPC.runOutput, { runId, stream, text: accepted.toString('utf8') })
      }
      // Account for the complete wire record, including rich metadata and JSON escaping.
      current.outputBytes += byteCost
      if (byteCost > remaining) terminateForOutputLimit()
    }
    for (const [stream, readable] of [['stdout', child.stdout], ['stderr', child.stderr]] as const) {
      const decoder = new StringDecoder('utf8')
      readable?.on('data', (chunk: Buffer) => forwardOutput(stream, decoder.write(chunk), {}, chunk.length))
      readable?.on('end', () => { const tail = decoder.end(); if (tail) forwardOutput(stream, tail) })
    }
    const structuredOutput = child.stdio[3]
    if (structuredOutput && 'on' in structuredOutput) {
      const decoder = new StringDecoder('utf8')
      let pending = ''
      const consumeRecords = (): void => {
        let newline: number
        while ((newline = pending.indexOf('\n')) >= 0) {
          const encoded = pending.slice(0, newline)
          pending = pending.slice(newline + 1)
          if (!encoded) continue
          const wireBytes = Buffer.byteLength(encoded) + 1
          if (wireBytes > MAX_STRUCTURED_FRAME_BYTES) { terminateForOutputLimit('\n结构化输出记录过大，已终止执行进程。\n'); pending = ''; return }
          try {
            const parsed = JSON.parse(encoded) as { line?: unknown; stream?: unknown; text?: unknown; location?: unknown; values?: unknown }
            if ((parsed.stream !== 'stdout' && parsed.stream !== 'stderr' && parsed.stream !== 'expression') || typeof parsed.text !== 'string') throw new Error('invalid record')
            const sourceLine = Number.isInteger(parsed.line) && Number(parsed.line) > 0 ? Number(parsed.line) : undefined
            const location = readLocation(parsed.location)
            const values = readSnapshots(parsed.values)
            forwardOutput(parsed.stream, parsed.text, { sourceLine, location, values }, wireBytes)
          } catch {
            forwardOutput('stderr', '[内部输出协议错误：已忽略一条无法解析的记录。]\n', {}, wireBytes)
          }
        }
        if (Buffer.byteLength(pending) > MAX_STRUCTURED_FRAME_BYTES) {
          pending = ''
          terminateForOutputLimit('\n结构化输出记录过大，已终止执行进程。\n')
        }
      }
      structuredOutput.on('data', (chunk) => { pending += decoder.write(Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk))); consumeRecords() })
      structuredOutput.on('end', () => { pending += decoder.end(); if (pending) pending += '\n'; consumeRecords() })
    }
    child.once('error', (error) => {
      const current = this.runs.get(runId)
      if (current) current.reason = 'failed'
      forwardOutput('stderr', `无法启动 Node.js：${error.message}\n请确认 Node.js 位于 PATH 中，或检查 Node 路径设置。\n`)
    })
    child.once('close', async (code, signal) => {
      const latest = this.runs.get(runId) ?? record
      this.runs.delete(runId)
      await removeQuietly(outputPath, inputPath)
      if (latest.reason === 'completed' && Number.isInteger(code) && code !== 0) latest.reason = 'failed'
      send<RunExitPayload>(webContents, IPC.runExit, {
        runId, code: Number.isInteger(code) ? code : null, signal: signal ?? null,
        reason: latest.reason, durationMs: Date.now() - latest.startedAt
      })
    })
    return { ok: true, runId, runtime: describeRuntime(runtime) }
  }

  private terminateTree(record: RunRecord, force: boolean): boolean {
    const pid = record.child.pid
    if (!pid) return record.child.kill(force ? 'SIGKILL' : 'SIGTERM')
    if (process.platform === 'win32') {
      try {
        // Console Node processes have no portable graceful Windows signal. /F /T
        // terminates the tree before its parent disappears and descendants are lost.
        const taskkill = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        taskkill.once('error', () => { record.child.kill(force ? 'SIGKILL' : 'SIGTERM') })
        taskkill.once('exit', (code) => { if (code && this.runs.size) record.child.kill(force ? 'SIGKILL' : 'SIGTERM') })
        return true
      } catch { return record.child.kill(force ? 'SIGKILL' : 'SIGTERM') }
    }
    try { process.kill(-pid, force ? 'SIGKILL' : 'SIGTERM'); return true }
    catch { return record.child.kill(force ? 'SIGKILL' : 'SIGTERM') }
  }

  stop(runId: string): boolean {
    if (this.preparing?.runId === runId) { this.preparing.cancelled = true; return true }
    const record = this.runs.get(runId)
    if (!record) return false
    record.reason = 'stopped'
    return this.terminateTree(record, false)
  }
  forceStop(runId: string): boolean {
    const record = this.runs.get(runId)
    if (!record) return this.stop(runId)
    record.reason = 'stopped'
    return this.terminateTree(record, true)
  }
  stopAll(): void {
    if (this.preparing) this.preparing.cancelled = true
    for (const record of this.runs.values()) { record.reason = 'app-closed'; this.terminateTree(record, true) }
  }
}

function toErrorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error) }
