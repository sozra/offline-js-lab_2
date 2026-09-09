import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { WorkspaceService, isValidPackageName } from '../src/main/workspace'

const roots: string[] = []

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => fs.rm(root, { recursive: true, force: true })))
})

async function createFixture(): Promise<{ root: string; workspace: WorkspaceService }> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'offline-js-lab-workspace-'))
  roots.push(root)
  const app = {
    getPath(name: string): string {
      if (name === 'userData') return path.join(root, 'userData')
      if (name === 'documents') return path.join(root, 'documents')
      throw new Error(`未知 app 路径：${name}`)
    }
  }
  const workspace = new WorkspaceService(app)
  await workspace.init()
  return { root, workspace }
}

describe('WorkspaceService', () => {
  it('初始化工作区并维护 package.json', async () => {
    const { workspace } = await createFixture()
    const manifest = await workspace.readManifest()

    expect(manifest.private).toBe(true)
    expect(await workspace.listPackages()).toEqual([])

    manifest.dependencies.lodash = '^4.17.21'
    await workspace.writeManifest(manifest)
    const packages = await workspace.listPackages()
    expect(packages[0]?.name).toBe('lodash')
    expect(packages[0]?.installed).toBe(false)
  })

  it('发现 node_modules 中的 .d.ts 类型文件', async () => {
    const { workspace } = await createFixture()
    const packageDirectory = path.join(workspace.getNodeModulesPath(), 'demo')
    await fs.mkdir(packageDirectory, { recursive: true })
    await fs.writeFile(
      path.join(packageDirectory, 'package.json'),
      JSON.stringify({ name: 'demo', version: '1.0.0' })
    )
    await fs.writeFile(
      path.join(packageDirectory, 'index.d.ts'),
      'export declare const value: number;'
    )

    const result = await workspace.collectTypeDefinitions()
    expect(result.files).toHaveLength(1)
    expect(result.files[0]?.uri).toMatch(/node_modules\/demo\/index\.d\.ts$/)
  })

  it('只接受安全 npm 包名', () => {
    expect(isValidPackageName('lodash')).toBe(true)
    expect(isValidPackageName('@types/lodash')).toBe(true)
    expect(isValidPackageName('../escape')).toBe(false)
    expect(isValidPackageName('@scope/../../escape')).toBe(false)
  })
})
