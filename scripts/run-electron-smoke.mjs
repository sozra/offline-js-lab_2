import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'
import { spawn } from 'node:child_process'

// A temporary Electron app manifest preserves the real app version/name while
// the smoke shim sets userData before loading the built production Main.
const directory = path.dirname(fileURLToPath(import.meta.url))
const repository = path.dirname(directory)
const packageJson = JSON.parse(await fs.readFile(path.join(repository, 'package.json'), 'utf8'))
const launcher = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-lab-smoke-launcher-'))
await fs.writeFile(path.join(launcher, 'package.json'), JSON.stringify({
  name: packageJson.name, version: packageJson.version, main: path.join(directory, 'electron-smoke.cjs')
}))
const electron = createRequire(import.meta.url)('electron')
const args = process.argv.slice(2)
if (!args.some(value => value.startsWith('--node='))) args.push(`--node=${process.execPath}`)
const environment = { ...process.env }
delete environment.ELECTRON_RUN_AS_NODE
const child = spawn(electron, [launcher, ...args], { cwd: repository, env: environment, stdio: 'inherit' })
child.once('error', async error => { console.error(error); await fs.rm(launcher, { recursive: true, force: true }); process.exitCode = 1 })
child.once('exit', async (code, signal) => {
  await fs.rm(launcher, { recursive: true, force: true })
  process.exitCode = code ?? (signal ? 1 : 0)
})
