import fs from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'

/** Only remembers files explicitly opened or saved by the user. */
export class RecentFiles {
  private pending: Promise<void> = Promise.resolve()
  private readonly filePath: string

  constructor(userData: string) { this.filePath = path.join(userData, 'recent-files.json') }

  private async read(): Promise<string[]> {
    try {
      const stat = await fs.stat(this.filePath)
      if (stat.size > 512 * 1024) return []
      const value: unknown = JSON.parse(await fs.readFile(this.filePath, 'utf8'))
      if (!Array.isArray(value)) return []
      return [...new Set(value.filter((item): item is string => typeof item === 'string' && item.length > 0 && item.length <= 32768 && path.isAbsolute(item)))].slice(0, 12)
    } catch { return [] }
  }

  async list(): Promise<string[]> { await this.pending; return this.read() }

  record(filePath: string): Promise<void> {
    const target = path.resolve(filePath)
    const task = this.pending.then(async () => {
      const current = await this.read()
      const compare = (value: string): string => process.platform === 'win32' ? value.toLowerCase() : value
      const next = [target, ...current.filter(item => compare(item) !== compare(target))].slice(0, 12)
      await fs.mkdir(path.dirname(this.filePath), { recursive: true })
      const temporary = `${this.filePath}.${crypto.randomUUID()}.tmp`
      try {
        await fs.writeFile(temporary, JSON.stringify(next, null, 2), 'utf8')
        await fs.rename(temporary, this.filePath)
      } finally { await fs.rm(temporary, { force: true }).catch(() => {}) }
    })
    this.pending = task.catch(() => {})
    return task
  }

  async includes(filePath: string): Promise<boolean> {
    if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) return false
    const compare = (value: string): string => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value)
    return (await this.list()).some(item => compare(item) === compare(filePath))
  }
}
