#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(currentFile), '..')
const requireFromProject = createRequire(path.join(projectRoot, 'package.json'))

export function readElectronInstallState(electronDirectory) {
  const pathFile = path.join(electronDirectory, 'path.txt')
  if (!fs.existsSync(pathFile)) {
    return {
      installed: false,
      pathFile,
      executablePath: null,
      reason: 'missing-path-file'
    }
  }

  const executableRelativePath = fs.readFileSync(pathFile, 'utf8').trim()
  if (!executableRelativePath) {
    return {
      installed: false,
      pathFile,
      executablePath: null,
      reason: 'empty-path-file'
    }
  }

  const executablePath = path.resolve(electronDirectory, 'dist', executableRelativePath)
  return {
    installed: fs.existsSync(executablePath),
    pathFile,
    executablePath,
    reason: fs.existsSync(executablePath) ? null : 'missing-executable'
  }
}

export function resolveElectronInstallScript(packageJson, electronDirectory) {
  const bin = packageJson.bin
  const configuredPath = typeof bin === 'object' && bin !== null
    ? bin['install-electron']
    : null

  if (typeof configuredPath === 'string' && configuredPath.trim()) {
    return path.resolve(electronDirectory, configuredPath)
  }

  const legacyFallback = path.resolve(electronDirectory, 'install.js')
  return fs.existsSync(legacyFallback) ? legacyFallback : null
}

export function ensureElectronBinary(options = {}) {
  const logger = options.logger ?? console
  let electronPackagePath

  try {
    electronPackagePath = requireFromProject.resolve('electron/package.json')
  } catch {
    logger.error('[electron] 未找到本地 electron 包。请先运行 npm install。')
    return 1
  }

  const electronDirectory = path.dirname(electronPackagePath)
  const packageJson = JSON.parse(fs.readFileSync(electronPackagePath, 'utf8'))
  const before = readElectronInstallState(electronDirectory)

  if (before.installed) {
    logger.log(`[electron] ${packageJson.version} 二进制已就绪。`)
    return 0
  }

  if (isTruthy(process.env.ELECTRON_SKIP_BINARY_DOWNLOAD)) {
    logger.error('[electron] 检测到 ELECTRON_SKIP_BINARY_DOWNLOAD，Electron 二进制无法自动安装。')
    logger.error('[electron] 请取消该环境变量后重新执行 npm start。')
    return 1
  }

  const installScript = resolveElectronInstallScript(packageJson, electronDirectory)
  if (!installScript || !fs.existsSync(installScript)) {
    logger.error('[electron] 当前 electron 包未提供 install-electron 安装脚本。')
    logger.error('[electron] 请删除 node_modules/electron 后重新运行 npm install。')
    return 1
  }

  logger.log(`[electron] 首次运行，正在安装 Electron ${packageJson.version} 对应的本机二进制…`)

  const result = spawnSync(process.execPath, [installScript, '--no'], {
    cwd: projectRoot,
    env: process.env,
    stdio: 'inherit'
  })

  if (result.error) {
    logger.error(`[electron] 无法启动安装脚本：${result.error.message}`)
    return 1
  }

  if (result.status !== 0) {
    logger.error(`[electron] 二进制安装失败，退出码：${result.status ?? 'unknown'}`)
    logger.error('[electron] 可手动执行：npx install-electron --no')
    return result.status ?? 1
  }

  const after = readElectronInstallState(electronDirectory)
  if (!after.installed) {
    logger.error('[electron] 安装脚本已结束，但仍未找到 Electron 可执行文件。')
    logger.error(`[electron] 预期位置：${after.executablePath ?? after.pathFile}`)
    return 1
  }

  logger.log(`[electron] Electron ${packageJson.version} 二进制安装完成。`)
  return 0
}

function isTruthy(value) {
  if (!value) return false
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase())
}

const isDirectExecution = process.argv[1]
  && path.resolve(process.argv[1]) === currentFile

if (isDirectExecution) {
  process.exitCode = ensureElectronBinary()
}
