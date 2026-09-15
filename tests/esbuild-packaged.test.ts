import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { loadEsbuild } from '../src/main/esbuild-loader'

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const binarySubpath = process.platform === 'win32' ? 'esbuild.exe' : path.join('bin', 'esbuild')

describe('打包布局下的真实 esbuild service', () => {
  it.skipIf(Boolean(process.env.ESBUILD_BINARY_PATH))('构建使用 app.asar.unpacked 内的真实二进制，而不是 ASAR 内部路径', async () => {
    const resources = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-esbuild-res-'))
    try {
      const unpackedBinary = path.join(
        resources, 'app.asar.unpacked', 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, binarySubpath
      )
      await fs.mkdir(path.dirname(unpackedBinary), { recursive: true })
      await fs.copyFile(path.join(projectRoot, 'node_modules', '@esbuild', `${process.platform}-${process.arch}`, binarySubpath), unpackedBinary)
      await fs.chmod(unpackedBinary, 0o755)

      const { build } = await loadEsbuild({ resourcesPath: resources })
      expect(process.env.ESBUILD_BINARY_PATH).toBe(unpackedBinary)
      const outfile = path.join(resources, 'out.mjs')
      await build({
        stdin: { contents: 'console.log("packed ok")', resolveDir: resources, sourcefile: 'scratch.js', loader: 'js' },
        outfile, bundle: true, format: 'esm', platform: 'node', logLevel: 'silent'
      })
      expect(await fs.readFile(outfile, 'utf8')).toContain('packed ok')
    } finally {
      await fs.rm(resources, { recursive: true, force: true })
    }
  })
})
