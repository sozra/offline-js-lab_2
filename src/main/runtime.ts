import fs from 'node:fs'
import { execFile } from 'node:child_process'
import type { RuntimeDescriptor } from '@shared/types'

function existingPath(value: string | undefined): string | null {
  return typeof value === 'string' && value.length > 0 && fs.existsSync(value)
    ? value
    : null
}

export function resolveNodeRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): RuntimeDescriptor {
  const explicitNode = env.OFFLINE_JS_LAB_NODE?.trim()
  if (explicitNode) {
    return { command: explicitNode, argsPrefix: [], source: 'OFFLINE_JS_LAB_NODE' }
  }

  const npmNode = existingPath(env.npm_node_execpath)
  if (npmNode) {
    return { command: npmNode, argsPrefix: [], source: 'npm_node_execpath' }
  }

  return {
    command: platform === 'win32' ? 'node.exe' : 'node',
    argsPrefix: [],
    source: 'PATH'
  }
}

const nodeVersionProbes = new Map<string, Promise<string>>()

/** Probe the executable that runs scripts, never Electron's embedded Node. */
export function probeNodeVersion(runtime: RuntimeDescriptor): Promise<string> {
  const key = JSON.stringify([runtime.command, runtime.argsPrefix])
  const cached = nodeVersionProbes.get(key)
  if (cached) return cached

  const probe = new Promise<string>((resolve, reject) => {
    execFile(runtime.command, [...runtime.argsPrefix, '--version'], {
      env: createChildEnvironment(),
      encoding: 'utf8',
      windowsHide: true,
      // This only bounds the environment probe; scripts have no execution timeout.
      timeout: 5000,
      maxBuffer: 4096
    }, (error, stdout) => {
      if (error) {
        reject(new Error(`无法检测 Node.js 版本（${describeRuntime(runtime)}）：${error.message}`))
        return
      }
      const version = /^v?(\d+\.\d+\.\d+)(?:[-+][\w.-]+)?\s*$/.exec(stdout.trim())?.[1]
      if (!version) {
        reject(new Error(`Node.js 版本响应无效（${describeRuntime(runtime)}）。`))
        return
      }
      resolve(version)
    })
  })
  nodeVersionProbes.set(key, probe)
  // A corrected installation may be retried without restarting the application.
  void probe.catch(() => nodeVersionProbes.delete(key))
  return probe
}

export function resolveNpmRuntime(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform
): RuntimeDescriptor {
  const npmCli = existingPath(env.npm_execpath)
  if (npmCli) {
    const nodeRuntime = resolveNodeRuntime(env, platform)
    return {
      command: nodeRuntime.command,
      argsPrefix: [...nodeRuntime.argsPrefix, npmCli],
      source: `npm CLI via ${nodeRuntime.source}`
    }
  }

  const explicitNpm = existingPath(env.OFFLINE_JS_LAB_NPM)
  if (explicitNpm) {
    return { command: explicitNpm, argsPrefix: [], source: 'OFFLINE_JS_LAB_NPM' }
  }

  return {
    command: platform === 'win32' ? 'npm.cmd' : 'npm',
    argsPrefix: [],
    source: 'PATH'
  }
}

export function createChildEnvironment(
  extra: NodeJS.ProcessEnv = {},
  options: { preserveNodeOptions?: boolean } = {}
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    FORCE_COLOR: '0',
    NO_COLOR: '1',
    ...extra
  }

  if (!options.preserveNodeOptions) delete environment.NODE_OPTIONS
  delete environment.ELECTRON_RUN_AS_NODE
  return environment
}

export function describeRuntime(runtime: RuntimeDescriptor): string {
  const prefix = runtime.argsPrefix.length > 0 ? ` ${runtime.argsPrefix.join(' ')}` : ''
  return `${runtime.command}${prefix}`
}
