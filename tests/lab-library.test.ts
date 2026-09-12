import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { LAB_LIBRARY_KEY, LAB_TEMPLATES, LIBRARY_COUNT_LIMIT, LIBRARY_SIZE_LIMIT, useLabLibrary } from '../src/renderer/src/composables/useLabLibrary'
import { isLabDocument } from '../src/renderer/src/composables/useDocumentSession'
import type { LabDocument } from '../src/shared/types'

const document: LabDocument = { code: 'console.log(lab.input)', language: 'typescript', input: { format: 'json', text: '{"answer":42}' } }
let values: Map<string, string>
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }
beforeEach(() => {
  values = new Map()
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)) }
  vi.stubGlobal('window', { localStorage: storage })
})
afterEach(() => vi.unstubAllGlobals())

describe('local snippet library', () => {
  it('saves a standalone copy of an experiment and restores it after reopening', () => {
    const library = useLabLibrary()
    const source = { ...document, input: { ...document.input } }
    expect(library.save('  My experiment  ', source)).toBe(true)
    source.input.text = 'changed later'
    const restored = useLabLibrary().snippets.value[0]!
    expect(restored).toMatchObject({ ...document, name: 'My experiment' })
    expect(restored.id).toBeTruthy()
    expect(library.snippets.value[0]!.input.text).toBe(document.input.text)
  })

  it('persists rename and delete without replacing unrelated snippets', () => {
    const library = useLabLibrary()
    library.save('First', document)
    library.save('Second', document)
    const second = library.snippets.value[0]!.id
    const first = library.snippets.value[1]!.id
    expect(library.rename(first, 'Renamed')).toBe(true)
    expect(library.remove(second)).toBe(true)
    expect(useLabLibrary().snippets.value.map(item => item.name)).toEqual(['Renamed'])
  })

  it('does not report success or mutate in-memory items when persistence fails', () => {
    const library = useLabLibrary()
    library.save('Keep me', document)
    const original = [...library.snippets.value]
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(library.save('Not saved', document)).toBe(false)
    expect(library.rename(original[0]!.id, 'Not renamed')).toBe(false)
    expect(library.remove(original[0]!.id)).toBe(false)
    expect(library.snippets.value).toEqual(original)
    expect(library.error.value).toContain('未保存')
    expect(useLabLibrary().snippets.value).toEqual(original)
  })

  it('recovers valid records while exposing invalid records and duplicate ids', () => {
    const good = { ...document, name: 'Good', id: 'one', updatedAt: 1 }
    values.set(LAB_LIBRARY_KEY, JSON.stringify({ version: 1, snippets: [good, good, { id: 'bad' }] }))
    const library = useLabLibrary()
    expect(library.snippets.value).toEqual([good])
    expect(library.error.value).toContain('已跳过')
  })

  it('shows a read failure for malformed storage and continues to offer templates', () => {
    values.set(LAB_LIBRARY_KEY, '{broken')
    const library = useLabLibrary()
    expect(library.snippets.value).toEqual([])
    expect(library.error.value).toBeTruthy()
    expect(LAB_TEMPLATES.length).toBeGreaterThan(0)
  })

  it.each([
    '{broken',
    JSON.stringify({ version: 2, snippets: [{ ...document, name: 'Future data', id: 'saved', updatedAt: 1 }] }),
    JSON.stringify({ version: 1, snippets: [{ ...document, name: 'Readable', id: 'saved', updatedAt: 1 }, { id: 'recoverable', code: 'valuable draft', futureField: true }] })
  ])('protects unrecognized or partially invalid original library data from subsequent mutations', raw => {
    values.set(LAB_LIBRARY_KEY, raw)
    const library = useLabLibrary()
    expect(library.readOnly.value).toBe(true)
    expect(library.save('New experiment', document)).toBe(false)
    expect(library.rename('saved', 'New name')).toBe(false)
    expect(library.remove('saved')).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
    expect(values.get(LAB_LIBRARY_KEY)).toBe(raw)
    expect(library.error.value).toContain('只读')
  })

  it('enforces both record count and overall storage bounds', () => {
    const library = useLabLibrary()
    for (let index = 0; index < LIBRARY_COUNT_LIMIT; index++) expect(library.save(String(index), document)).toBe(true)
    expect(library.save('Too many', document)).toBe(false)
    expect(library.error.value).toContain('最多收藏')
    values.clear()
    const largeLibrary = useLabLibrary()
    expect(largeLibrary.save('Oversize', { ...document, code: 'x'.repeat(LIBRARY_SIZE_LIMIT) })).toBe(false)
    expect(largeLibrary.snippets.value).toEqual([])
  })

  it('rejects empty names and malformed document shapes', () => {
    const library = useLabLibrary()
    expect(library.save('   ', document)).toBe(false)
    expect(library.save('x'.repeat(81), document)).toBe(false)
    expect(library.save('Bad', { ...document, language: 'html' } as unknown as LabDocument)).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })

  it('ships self-contained JS/TS/JSX/TSX templates with valid JSON samples', () => {
    expect(new Set(LAB_TEMPLATES.map(item => item.language))).toEqual(new Set(['javascript', 'typescript', 'jsx', 'tsx']))
    for (const template of LAB_TEMPLATES) {
      expect(isLabDocument(template)).toBe(true)
      if (template.input.format === 'json') expect(() => JSON.parse(template.input.text)).not.toThrow()
      expect(template.code).not.toMatch(/https?:\/\//)
    }
  })
})
