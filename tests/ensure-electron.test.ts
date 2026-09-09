import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  readElectronInstallState,
  resolveElectronInstallScript
} from '../scripts/ensure-electron.mjs'

const temporaryDirectories: string[] = []

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true })
  }
})

function createElectronDirectory(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'offline-js-lab-electron-'))
  temporaryDirectories.push(directory)
  fs.mkdirSync(path.join(directory, 'dist'), { recursive: true })
  return directory
}

describe('Electron binary preparation', () => {
  it('reports a missing path.txt as not installed', () => {
    const directory = createElectronDirectory()
    const state = readElectronInstallState(directory)

    expect(state.installed).toBe(false)
    expect(state.reason).toBe('missing-path-file')
  })

  it('verifies the executable referenced by path.txt', () => {
    const directory = createElectronDirectory()
    const executableRelativePath = process.platform === 'win32'
      ? 'electron.exe'
      : 'Electron.app/Contents/MacOS/Electron'
    const executablePath = path.join(directory, 'dist', executableRelativePath)

    fs.mkdirSync(path.dirname(executablePath), { recursive: true })
    fs.writeFileSync(executablePath, '')
    fs.writeFileSync(path.join(directory, 'path.txt'), `${executableRelativePath}\n`)

    const state = readElectronInstallState(directory)
    expect(state.installed).toBe(true)
    expect(state.executablePath).toBe(executablePath)
  })

  it('prefers the install-electron bin and falls back to install.js', () => {
    const directory = createElectronDirectory()
    const configured = resolveElectronInstallScript(
      { bin: { 'install-electron': 'custom-install.js' } },
      directory
    )
    expect(configured).toBe(path.join(directory, 'custom-install.js'))

    fs.writeFileSync(path.join(directory, 'install.js'), '')
    const fallback = resolveElectronInstallScript({ bin: { electron: 'cli.js' } }, directory)
    expect(fallback).toBe(path.join(directory, 'install.js'))
  })
})
