import { describe, expect, it } from 'vitest'
import { isEntrySourceLocation } from '../src/renderer/src/composables/sourceLocation'

describe('entry source location matching', () => {
  it('accepts the scratch source and relative entry paths without aligning imported files', () => {
    const scratch = { filePath: null, language: 'typescript' as const }
    expect(isEntrySourceLocation({ file: 'scratch.ts', line: 2, column: 1 }, scratch, '/work', 'darwin')).toBe(true)
    expect(isEntrySourceLocation({ file: '/work/scratch.ts', line: 2, column: 1 }, scratch, '/work', 'darwin')).toBe(true)
    expect(isEntrySourceLocation({ file: 'helpers/scratch.ts', line: 2, column: 1 }, scratch, '/work', 'darwin')).toBe(false)
    expect(isEntrySourceLocation({ file: 'node_modules/pkg/index.ts', line: 2, column: 1 }, scratch, '/work', 'darwin')).toBe(false)
    expect(isEntrySourceLocation(undefined, scratch, '/work', 'darwin')).toBe(true)
  })

  it('resolves file URLs, spaces, source namespaces and parent-relative paths', () => {
    const entry = { filePath: '/My Files/entry.tsx', language: 'tsx' as const }
    for (const file of ['file:///My%20Files/entry.tsx', '../My Files/entry.tsx', 'lab-source:/My Files/entry.tsx']) {
      expect(isEntrySourceLocation({ file, line: 3, column: 2 }, entry, '/work', 'darwin')).toBe(true)
    }
    expect(isEntrySourceLocation({ file: 'entry.tsx', line: 3, column: 2 }, entry, '/work', 'darwin')).toBe(false)
    expect(isEntrySourceLocation({ file: 'file:///My%ZZFiles/entry.tsx', line: 3, column: 2 }, entry, '/work', 'darwin')).toBe(false)
  })

  it('normalizes Windows drive letters, slashes, case and UNC URLs', () => {
    const entry = { filePath: 'C:\\Lab Files\\entry.tsx', language: 'tsx' as const }
    for (const file of ['c:/lab files/ENTRY.TSX', 'file:///C:/Lab%20Files/entry.tsx', '../Lab Files/entry.tsx']) {
      expect(isEntrySourceLocation({ file, line: 1, column: 1 }, entry, 'C:\\Workspace', 'win32')).toBe(true)
    }
    expect(isEntrySourceLocation({ file: 'D:\\Lab Files\\entry.tsx', line: 1, column: 1 }, entry, 'C:\\Workspace', 'win32')).toBe(false)
    expect(isEntrySourceLocation({ file: 'file://server/share/entry.tsx', line: 1, column: 1 }, { ...entry, filePath: '\\\\SERVER\\share\\entry.tsx' }, 'C:\\Work', 'win32')).toBe(true)
  })
})
