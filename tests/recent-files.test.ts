import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { RecentFiles } from '../src/main/recent-files'

const roots: string[] = []
afterEach(async () => { await Promise.all(roots.splice(0).map(root => fs.rm(root, { recursive: true, force: true }))) })
async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'lab-recent-'))
  roots.push(root)
  return { root, recent: new RecentFiles(root) }
}
describe('recent files', () => {
  it('keeps twelve explicit files ordered and deduplicated across concurrent writes and restart', async () => {
    const { root, recent } = await fixture()
    const files = Array.from({ length: 15 }, (_, index) => path.join(root, `snippet-${index}.tsx`))
    await Promise.all(files.map(file => recent.record(file)))
    expect(await recent.list()).toEqual(files.slice(3).reverse())
    await recent.record(files[5]!)
    expect((await new RecentFiles(root).list())[0]).toBe(files[5])
    expect(await recent.includes(files[5]!)).toBe(true)
    expect(await recent.includes(path.join(root, 'unselected.ts'))).toBe(false)
    expect(await recent.includes('relative.ts')).toBe(false)
    expect((await fs.readdir(root)).filter(file => file.endsWith('.tmp'))).toEqual([])
  })
  it('tolerates invalid stored records without accepting relative paths or arbitrary objects', async () => {
    const { root, recent } = await fixture()
    await fs.writeFile(path.join(root, 'recent-files.json'), '{broken')
    expect(await recent.list()).toEqual([])
    const valid = path.join(root, 'valid.js')
    await fs.writeFile(path.join(root, 'recent-files.json'), JSON.stringify(['relative', {}, valid, valid]))
    expect(await recent.list()).toEqual([valid])
  })
})
