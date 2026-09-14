#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { fileURLToPath } from 'node:url'

const currentFile = fileURLToPath(import.meta.url)
const projectRoot = path.resolve(path.dirname(currentFile), '..')

const help = `用法：npm run dist:<mac|win|nsis|portable> -- [选项]
      npm run dist:check -- <mac|win|nsis|portable> [选项]

  --electron-dist <路径>  本地 Electron 官方 ZIP、ZIP 所在目录或完整解压目录
  --arch <x64|arm64>      目标架构（Windows 默认 x64，macOS 默认本机架构）
  --dir                  仅生成应用目录，不生成 DMG / NSIS / Portable
  --check                仅检查参数和本地 Electron，不编译、不打包、不下载
  --help                 显示帮助

路径优先级：--electron-dist > OFFLINE_JS_LAB_ELECTRON_DIST > package.json build.electronDist。
相对路径以项目根目录为基准。未指定本地路径时保留 electron-builder 默认下载/缓存行为。
本地路径无效时立即失败，不回退下载。NSIS 等额外打包工具仍需提前缓存。`

export function createPackagePlan(argv, options = {}) {
  const root = options.projectRoot ?? projectRoot
  const env = options.env ?? process.env
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'electron-dist': { type: 'string' },
      arch: { type: 'string' },
      dir: { type: 'boolean', default: false },
      check: { type: 'boolean', default: false },
      help: { type: 'boolean', default: false }
    }
  })
  if (values.help) return { help: true }
  const preset = positionals[0]
  if (positionals.length !== 1 || !['mac', 'win', 'nsis', 'portable'].includes(preset)) {
    throw new Error('请指定打包目标 mac、win、nsis 或 portable。使用 --help 查看用法。')
  }
  const platform = preset === 'mac' ? 'darwin' : 'win32'
  const arch = values.arch ?? (platform === 'win32' ? 'x64' : options.hostArch ?? process.arch)
  if (!['x64', 'arm64'].includes(arch)) throw new Error(`不支持目标架构 ${arch}，请使用 --arch x64 或 --arch arm64。`)
  const packageJson = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'))
  const version = packageJson.devDependencies.electron
  if (!/^\d+\.\d+\.\d+(?:-[\w.-]+)?$/.test(version)) {
    throw new Error('package.json 的 devDependencies.electron 必须固定到精确版本。')
  }
  const configuredPath = values['electron-dist'] ?? env.OFFLINE_JS_LAB_ELECTRON_DIST ?? packageJson.build?.electronDist
  const electronDist = configuredPath == null ? undefined : resolveLocalElectron(configuredPath, {
    projectRoot: root, version, platform, arch
  })
  return {
    help: false,
    projectRoot: root,
    platform,
    arch,
    version,
    target: values.dir ? 'dir' : ['nsis', 'portable'].includes(preset) ? preset : undefined,
    check: values.check,
    electronDist
  }
}

export function resolveLocalElectron(input, { projectRoot: root, version, platform, arch }) {
  if (typeof input !== 'string' || !input.trim()) throw new Error('本地 Electron 路径不能为空，且必须是文件系统路径。')
  const resolved = path.resolve(root, input)
  if (!fs.existsSync(resolved)) throw new Error(`本地 Electron 路径不存在：${resolved}`)
  const expectedZip = `electron-v${version}-${platform}-${arch}.zip`
  if (fs.statSync(resolved).isFile()) {
    if (path.basename(resolved) !== expectedZip) {
      throw new Error(`Electron ZIP 必须使用匹配目标的官方文件名 ${expectedZip}；收到 ${path.basename(resolved)}。请勿通过重命名绕过版本/平台/架构检查。`)
    }
    const fd = fs.openSync(resolved, 'r')
    try {
      const signature = Buffer.alloc(4)
      if (fs.readSync(fd, signature, 0, 4, 0) !== 4 || signature.readUInt32LE() !== 0x04034b50) {
        throw new Error(`不是有效的 Electron ZIP 文件：${resolved}`)
      }
    } finally {
      fs.closeSync(fd)
    }
    return resolved
  }
  if (!fs.statSync(resolved).isDirectory()) throw new Error(`本地 Electron 必须是 ZIP 或目录：${resolved}`)
  const archive = path.join(resolved, expectedZip)
  if (fs.existsSync(archive)) return resolveLocalElectron(archive, { projectRoot: root, version, platform, arch })

  const executable = platform === 'darwin' ? 'Electron.app/Contents/MacOS/Electron' : 'electron.exe'
  const runtime = platform === 'darwin'
    ? 'Electron.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat'
    : 'icudtl.dat'
  for (const required of ['version', executable, runtime]) {
    if (!fs.existsSync(path.join(resolved, required)) || !fs.statSync(path.join(resolved, required)).isFile()) {
      throw new Error(`本地目录缺少 ${required}：${resolved}。请提供完整的 ${platform}-${arch} 解压根目录（不是 .app / .exe 本身），或包含 ${expectedZip} 的目录。`)
    }
  }
  const actualVersion = fs.readFileSync(path.join(resolved, 'version'), 'utf8').trim().replace(/^v/, '')
  if (actualVersion !== version) throw new Error(`本地 Electron 版本 ${actualVersion} 与项目要求 ${version} 不一致。`)
  validateExecutableArch(path.join(resolved, executable), platform, arch)
  return resolved
}

// Read binary headers without launching Electron, including when cross-packaging Windows on macOS.
function validateExecutableArch(executable, platform, arch) {
  const fd = fs.openSync(executable, 'r')
  try {
    const read = (offset, length) => {
      const buffer = Buffer.alloc(length)
      if (fs.readSync(fd, buffer, 0, length, offset) !== length) throw new Error(`Electron 可执行文件头不完整：${executable}`)
      return buffer
    }
    let actualArch
    if (platform === 'win32') {
      const dos = read(0, 64)
      if (dos.toString('ascii', 0, 2) === 'MZ') {
        const pe = read(dos.readUInt32LE(0x3c), 6)
        if (pe.readUInt32LE() === 0x00004550) actualArch = { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[pe.readUInt16LE(4)]
      }
    } else {
      const header = read(0, 8)
      // Official macOS downloads contain a thin little-endian 64-bit Mach-O launcher.
      if (header.readUInt32LE() === 0xfeedfacf) actualArch = { 0x01000007: 'x64', 0x0100000c: 'arm64' }[header.readUInt32LE(4)]
    }
    if (actualArch !== arch) throw new Error(`Electron 架构不匹配：目标 ${platform}-${arch}，文件为 ${actualArch ?? '无法识别的格式'}（${executable}）。请使用对应平台和架构的官方发行版。`)
  } finally {
    fs.closeSync(fd)
  }
}

export async function packageProject(argv) {
  try {
    const plan = createPackagePlan(argv)
    if (plan.help) {
      console.log(help)
      return 0
    }
    console.log(`[package] Electron ${plan.version} / ${plan.platform}-${plan.arch} / ${plan.target ?? '默认安装包'}`)
    console.log(plan.electronDist
      ? `[package] 使用本地 Electron：${plan.electronDist}（不下载 Electron）`
      : '[package] 未指定本地 Electron，使用 electron-builder 默认下载/缓存流程。')
    if (plan.check) {
      console.log('[package] 参数检查通过；未编译、打包或下载。ZIP 内容完整性与额外工具缓存需在实际打包时验证。')
      return 0
    }
    // npm supplies its own CLI path on macOS and Windows; never interpolate paths into a shell.
    if (!process.env.npm_execpath) throw new Error('请通过 npm run dist:mac / dist:win / dist:nsis / dist:portable 执行打包。')
    const compiled = spawnSync(process.execPath, [process.env.npm_execpath, 'run', 'build'], {
      cwd: plan.projectRoot, env: process.env, stdio: 'inherit'
    })
    if (compiled.error) throw compiled.error
    if (compiled.status !== 0) return compiled.status ?? 1
    const { build, createTargets, Platform } = await import('electron-builder')
    await build({
      projectDir: plan.projectRoot,
      targets: createTargets([plan.platform === 'darwin' ? Platform.MAC : Platform.WINDOWS], plan.target, plan.arch),
      config: {
        electronVersion: plan.version,
        ...(plan.electronDist ? { electronDist: plan.electronDist } : {})
      },
      publish: 'never'
    })
    return 0
  } catch (error) {
    console.error(`[package] ${error instanceof Error ? error.message : String(error)}`)
    return 1
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === currentFile) {
  process.exitCode = await packageProject(process.argv.slice(2))
}
