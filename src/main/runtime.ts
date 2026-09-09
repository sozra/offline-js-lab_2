import fs from 'node:fs'
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
  const npmNode = existingPath(env.npm_node_execpath)
  if (npmNode) {
    return { command: npmNode, argsPrefix: [], source: 'npm_node_execpath' }
  }

  const explicitNode = existingPath(env.OFFLINE_JS_LAB_NODE)
  if (explicitNode) {
    return { command: explicitNode, argsPrefix: [], source: 'OFFLINE_JS_LAB_NODE' }
  }

  return {
    command: platform === 'win32' ? 'node.exe' : 'node',
    argsPrefix: [],
    source: 'PATH'
  }
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
