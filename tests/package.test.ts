import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { createPackagePlan, resolveLocalElectron, type LocalElectronTarget } from '../scripts/package.mjs'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const temporaryDirectories: string[] = []
const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).devDependencies.electron as string

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) fs.rmSync(directory, { recursive: true, force: true })
})

function fixture() {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-js-lab-package-'))
  temporaryDirectories.push(directory)
  fs.writeFileSync(path.join(directory, 'package.json'), JSON.stringify({ devDependencies: { electron: version } }))
  return directory
}

function target(projectRoot: string, platform: LocalElectronTarget['platform'] = 'win32', arch: LocalElectronTarget['arch'] = 'x64'): LocalElectronTarget {
  return { projectRoot, platform, arch, version }
}

function archive(directory: string, platform = 'win32', arch = 'x64', release = version) {
  const file = path.join(directory, `electron-v${release}-${platform}-${arch}.zip`)
  // Preflight checks the name and signature; electron-builder validates/extracts actual ZIP contents.
  fs.writeFileSync(file, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
  return file
}

function unpacked(directory: string, platform: 'win32' | 'darwin', arch: 'x64' | 'arm64') {
  const dist = path.join(directory, `${platform} runtime with spaces`)
  const executable = platform === 'win32' ? 'electron.exe' : 'Electron.app/Contents/MacOS/Electron'
  const runtime = platform === 'win32' ? 'icudtl.dat' : 'Electron.app/Contents/Frameworks/Electron Framework.framework/Resources/icudtl.dat'
  const header = Buffer.alloc(128)
  if (platform === 'win32') {
    header.write('MZ')
    header.writeUInt32LE(64, 0x3c)
    header.writeUInt32LE(0x00004550, 64)
    header.writeUInt16LE(arch === 'x64' ? 0x8664 : 0xaa64, 68)
  } else {
    header.writeUInt32LE(0xfeedfacf)
    header.writeUInt32LE(arch === 'x64' ? 0x01000007 : 0x0100000c, 4)
  }
  for (const [file, content] of [[executable, header], [runtime, ''], ['version', `${version}\n`]] as const) {
    const fullPath = path.join(dist, file)
    fs.mkdirSync(path.dirname(fullPath), { recursive: true })
    fs.writeFileSync(fullPath, content)
  }
  return dist
}

describe('local Electron packaging', () => {
  it('preserves existing targets and default download mode without a local path', () => {
    const projectRoot = fixture()
    for (const preset of ['win', 'nsis', 'portable']) {
      expect(createPackagePlan([preset], { projectRoot, env: {}, hostArch: 'arm64' })).toMatchObject({
        platform: 'win32', arch: 'x64', target: preset === 'win' ? undefined : preset, electronDist: undefined
      })
    }
    expect(createPackagePlan(['mac'], { projectRoot, env: {}, hostArch: 'arm64' })).toMatchObject({ platform: 'darwin', arch: 'arm64' })
    expect(createPackagePlan(['portable', '--dir', '--arch=x64'], { projectRoot, env: {} })).toMatchObject({ target: 'dir' })
  })

  it('uses CLI > environment > package config, resolving relative paths against the project', () => {
    const projectRoot = fixture()
    const file = archive(projectRoot)
    const env = { OFFLINE_JS_LAB_ELECTRON_DIST: 'missing environment path' }
    expect(createPackagePlan(['win', '--electron-dist', path.basename(file)], { projectRoot, env })).toMatchObject({ electronDist: file })
    expect(() => createPackagePlan(['win'], { projectRoot, env })).toThrow('路径不存在')
    fs.writeFileSync(path.join(projectRoot, 'package.json'), JSON.stringify({
      devDependencies: { electron: version }, build: { electronDist: path.basename(file) }
    }))
    expect(createPackagePlan(['win'], { projectRoot, env: {} })).toMatchObject({ electronDist: file })
    expect(() => createPackagePlan(['win', '--electron-dist='], { projectRoot, env: {} })).toThrow('不能为空')
  })

  it('selects the exact ZIP for the target from a directory with multiple platforms and architectures', () => {
    const projectRoot = fixture()
    archive(projectRoot, 'darwin', 'arm64')
    archive(projectRoot, 'win32', 'arm64')
    const winZip = archive(projectRoot)
    expect(resolveLocalElectron('.', target(projectRoot))).toBe(winZip)
    expect(resolveLocalElectron(winZip, target(projectRoot))).toBe(winZip)
  })

  it('rejects wrong ZIP version, platform, architecture, non-ZIP files and truncated files', () => {
    const projectRoot = fixture()
    for (const file of [archive(projectRoot, 'darwin', 'x64'), archive(projectRoot, 'win32', 'arm64'), archive(projectRoot, 'win32', 'x64', '1.0.0')]) {
      expect(() => resolveLocalElectron(file, target(projectRoot))).toThrow('官方文件名')
    }
    const file = archive(projectRoot)
    fs.writeFileSync(file, '')
    expect(() => resolveLocalElectron(file, target(projectRoot))).toThrow('不是有效')
    fs.writeFileSync(file, 'not a zip')
    expect(() => resolveLocalElectron(file, target(projectRoot))).toThrow('不是有效')
    expect(() => resolveLocalElectron('package.json', target(projectRoot))).toThrow('官方文件名')
    expect(() => resolveLocalElectron('missing.zip', target(projectRoot))).toThrow('路径不存在')
  })

  it.each(['win32', 'darwin'] as const)('reads %s executable architecture without executing it', (platform) => {
    const projectRoot = fixture()
    const dist = unpacked(projectRoot, platform, 'arm64')
    expect(resolveLocalElectron(dist, target(projectRoot, platform, 'arm64'))).toBe(dist)
    expect(() => resolveLocalElectron(dist, target(projectRoot, platform, 'x64'))).toThrow('架构不匹配')
    const otherPlatform = platform === 'win32' ? 'darwin' : 'win32'
    expect(() => resolveLocalElectron(dist, target(projectRoot, otherPlatform, 'arm64'))).toThrow('完整的')
    fs.writeFileSync(path.join(dist, 'version'), '1.0.0')
    expect(() => resolveLocalElectron(dist, target(projectRoot, platform, 'arm64'))).toThrow('版本 1.0.0')
  })

  it('rejects partial distributions, corrupt executable headers and an .exe path', () => {
    const projectRoot = fixture()
    const dist = unpacked(projectRoot, 'win32', 'x64')
    const executable = path.join(dist, 'electron.exe')
    expect(() => resolveLocalElectron(executable, target(projectRoot))).toThrow('官方文件名')
    fs.writeFileSync(executable, '')
    expect(() => resolveLocalElectron(dist, target(projectRoot))).toThrow('文件头不完整')
    fs.rmSync(path.join(dist, 'icudtl.dat'))
    expect(() => resolveLocalElectron(dist, target(projectRoot))).toThrow('缺少 icudtl.dat')
  })

  it('rejects unknown arguments and malformed targets instead of ignoring them', () => {
    const projectRoot = fixture()
    for (const argv of [[], ['linux'], ['mac', 'win'], ['win', '--arch=universal'], ['win', '--electron-dist'], ['win', '--electron-dis=bad']]) {
      expect(() => createPackagePlan(argv, { projectRoot, env: {} })).toThrow()
    }
    expect(createPackagePlan(['--help'], { projectRoot: 'does not exist' })).toEqual({ help: true })
  })

  it('supports quoted paths through the real CLI; check and failure never invoke build or download', () => {
    const projectRoot = fixture()
    const dist = unpacked(projectRoot, 'win32', 'x64')
    const invoke = (args: string[]) => spawnSync(process.execPath, [path.join(root, 'scripts/package.mjs'), ...args], {
      cwd: os.tmpdir(), encoding: 'utf8',
      env: { ...process.env, npm_execpath: path.join(projectRoot, 'must-not-run-npm.cjs'), OFFLINE_JS_LAB_ELECTRON_DIST: '' }
    })
    const checked = invoke(['win', '--check', '--electron-dist', dist])
    expect(checked.status, checked.stderr).toBe(0)
    expect(checked.stdout).toContain('未编译、打包或下载')
    const invalid = invoke(['win', '--electron-dist', path.join(projectRoot, 'missing')])
    expect(invalid.status).toBe(1)
    expect(invalid.stderr).toContain('路径不存在')
    expect(invalid.stderr).not.toContain('must-not-run-npm')
  })
})
