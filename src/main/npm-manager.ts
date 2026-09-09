import { spawn, type ChildProcess } from 'node:child_process'
import type {
  InstallPackagesPayload,
  NpmAction,
  NpmOperationResult,
  PackageOutputPayload,
  RuntimeDescriptor,
  UninstallPackagesPayload
} from '@shared/types'
import { isValidPackageName, type WorkspaceService } from './workspace'
import {
  createChildEnvironment,
  describeRuntime,
  resolveNpmRuntime
} from './runtime'

const MAX_PACKAGE_SPECS = 50

type SpawnProcess = typeof spawn
type NpmPayload = Partial<InstallPackagesPayload & UninstallPackagesPayload>
type OutputCallback = (payload: PackageOutputPayload) => void

export function packageNameFromSpec(spec: string): string {
  if (spec.startsWith('@')) {
    const slashIndex = spec.indexOf('/')
    if (slashIndex < 2) return spec
    const versionIndex = spec.indexOf('@', slashIndex + 1)
    return versionIndex === -1 ? spec : spec.slice(0, versionIndex)
  }

  const versionIndex = spec.lastIndexOf('@')
  return versionIndex > 0 ? spec.slice(0, versionIndex) : spec
}

export function parsePackageSpecs(input: unknown): string[] {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)
  const specs = values.map((value) => String(value).trim()).filter(Boolean)

  if (specs.length === 0) throw new Error('请输入至少一个 npm 包名，例如 lodash dayjs。')
  if (specs.length > MAX_PACKAGE_SPECS) {
    throw new Error(`一次最多安装 ${MAX_PACKAGE_SPECS} 个包。`)
  }

  for (const spec of specs) {
    if (spec.length > 300 || spec.startsWith('-') || /[\u0000-\u001f\u007f\s]/.test(spec)) {
      throw new Error(`不支持的 npm 包参数：${spec}`)
    }

    if (!isValidPackageName(packageNameFromSpec(spec))) {
      throw new Error(`无效的 npm 包名：${spec}`)
    }
  }

  return [...new Set(specs)]
}

export function parsePackageNames(input: unknown): string[] {
  const values = Array.isArray(input) ? input : String(input ?? '').split(/[\s,]+/)
  const names = values.map((value) => String(value).trim()).filter(Boolean)

  if (names.length === 0) throw new Error('缺少要卸载的 npm 包名。')
  for (const name of names) {
    if (!isValidPackageName(name)) throw new Error(`无效的 npm 包名：${name}`)
  }

  return [...new Set(names)]
}

export function buildNpmArguments(action: NpmAction, payload: NpmPayload = {}): string[] {
  const common = ['--no-audit', '--no-fund', '--color=false']

  if (action === 'install') {
    return [
      'install',
      ...parsePackageSpecs(payload.specs),
      payload.dev ? '--save-dev' : '--save',
      ...common
    ]
  }

  if (action === 'sync') return ['install', ...common]
  if (action === 'uninstall') return ['uninstall', ...parsePackageNames(payload.names), ...common]
  throw new Error(`不支持的 npm 操作：${String(action)}`)
}

function emitOutput(callback: OutputCallback | undefined, stream: PackageOutputPayload['stream'], text: unknown): void {
  if (callback && text) callback({ stream, text: String(text) })
}

export class NpmManager {
  private active: { child: ChildProcess; action: NpmAction } | null = null

  constructor(
    private readonly workspace: WorkspaceService,
    private readonly spawnProcess: SpawnProcess = spawn,
    private readonly resolveRuntime: () => RuntimeDescriptor = resolveNpmRuntime
  ) {}

  getRuntimeInfo(): { command: string; source: string } {
    const runtime = this.resolveRuntime()
    return { command: describeRuntime(runtime), source: runtime.source }
  }

  async run(
    action: NpmAction,
    payload: NpmPayload = {},
    onOutput?: OutputCallback
  ): Promise<NpmOperationResult> {
    if (this.active) throw new Error('已有 npm 操作正在执行。')

    const npmArguments = buildNpmArguments(action, payload)
    const runtime = this.resolveRuntime()
    const args = [...runtime.argsPrefix, ...npmArguments]
    const cwd = this.workspace.getPath()
    emitOutput(onOutput, 'system', `$ npm ${npmArguments.join(' ')}\n`)

    return new Promise((resolve, reject) => {
      let child: ChildProcess | null = null
      let settled = false

      const clearActive = (): void => {
        if (child && this.active?.child === child) this.active = null
      }

      try {
        child = this.spawnProcess(runtime.command, args, {
          cwd,
          env: createChildEnvironment(
            { OFFLINE_JS_LAB: '1' },
            { preserveNodeOptions: true }
          ),
          shell: false,
          stdio: ['ignore', 'pipe', 'pipe'],
          windowsHide: true
        })
      } catch (error) {
        reject(new Error(`无法启动 npm：${toErrorMessage(error)}`))
        return
      }

      this.active = { child, action }
      child.stdout?.on('data', (chunk) => emitOutput(onOutput, 'stdout', chunk.toString('utf8')))
      child.stderr?.on('data', (chunk) => emitOutput(onOutput, 'stderr', chunk.toString('utf8')))

      child.once('error', (error) => {
        if (settled) return
        settled = true
        clearActive()
        reject(
          new Error(
            `npm 启动失败：${error.message}。请确认 Node.js/npm 已安装，或通过 npm start 启动应用。`
          )
        )
      })

      child.once('close', (code, signal) => {
        if (settled) return
        settled = true
        clearActive()
        const normalizedCode = Number.isInteger(code) ? code : null
        resolve({
          ok: normalizedCode === 0,
          code: normalizedCode,
          signal: signal ?? null,
          action
        })
      })
    })
  }

  stop(): boolean {
    return this.active ? this.active.child.kill() : false
  }

  stopAll(): void {
    this.stop()
  }
}

function toErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
