import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  DOCUMENT_SESSION_KEY, INPUT_TEXT_LIMIT, isLabDocument, readDocumentSession, writeDocumentSession
} from '../src/renderer/src/composables/useDocumentSession'
import type { DocumentSession } from '../src/renderer/src/composables/useDocumentSession'
import type { LabDocument } from '../src/shared/types'

const fallback: LabDocument = { code: '// new experiment', language: 'typescript', input: { format: 'text', text: '' } }
let values: Map<string, string>
let storage: { getItem: ReturnType<typeof vi.fn>; setItem: ReturnType<typeof vi.fn> }

beforeEach(() => {
  values = new Map()
  storage = { getItem: vi.fn((key: string) => values.get(key) ?? null), setItem: vi.fn((key: string, value: string) => values.set(key, value)) }
  vi.stubGlobal('window', { localStorage: storage })
})
afterEach(() => vi.unstubAllGlobals())

describe('document session recovery', () => {
  it('restores a dirty file association, saved baseline, language, and input together', () => {
    const session: DocumentSession = {
      code: 'export default () => <h1>Draft</h1>', language: 'tsx', filePath: 'C:\\experiments\\component.tsx', dirty: true,
      lastSavedCode: 'export default () => <h1>Saved</h1>', input: { format: 'json', text: '{"label":"Draft"}' }
    }
    expect(writeDocumentSession(session)).toBe(true)
    expect(storage.setItem).toHaveBeenCalledTimes(1)
    expect(readDocumentSession(fallback)).toEqual(session)
  })

  it('migrates an existing legacy draft without claiming it was saved to a file', () => {
    values.set('offlineJsLab.code', 'console.log("recovered")')
    values.set('offlineJsLab.language', 'javascript')
    expect(readDocumentSession(fallback)).toEqual({
      code: 'console.log("recovered")', language: 'javascript', input: { format: 'text', text: '' },
      filePath: null, dirty: true, lastSavedCode: null
    })
  })

  it('retains a clean saved file only when its baseline matches', () => {
    const session: DocumentSession = { ...fallback, filePath: '/tmp/saved.ts', dirty: false, lastSavedCode: fallback.code }
    writeDocumentSession(session)
    expect(readDocumentSession(fallback).dirty).toBe(false)
    writeDocumentSession({ ...session, lastSavedCode: null })
    expect(readDocumentSession(fallback).dirty).toBe(true)
    writeDocumentSession({ ...session, lastSavedCode: 'previous content' })
    expect(readDocumentSession(fallback).dirty).toBe(true)
  })

  it.each(['{', 'null', '{"version":2,"document":{}}', '{"version":1,"document":{"code":"abc","language":"html","input":{}}}'])('recovers safely from invalid session %s', raw => {
    values.set(DOCUMENT_SESSION_KEY, raw)
    expect(readDocumentSession(fallback)).toEqual({ ...fallback, filePath: null, dirty: false, lastSavedCode: null })
    expect(values.get(DOCUMENT_SESSION_KEY)).toBe(raw)
  })

  it('reports quota failure and leaves the prior atomic session intact', () => {
    const session: DocumentSession = { ...fallback, filePath: null, dirty: true, lastSavedCode: null }
    writeDocumentSession(session)
    storage.setItem.mockImplementation(() => { throw new Error('QuotaExceededError') })
    expect(writeDocumentSession({ ...session, code: 'new code' })).toBe(false)
    expect(readDocumentSession(fallback).code).toBe(fallback.code)
  })

  it('rejects oversize inputs and invalid input formats before persisting', () => {
    expect(isLabDocument({ ...fallback, input: { format: 'json', text: 'x'.repeat(INPUT_TEXT_LIMIT + 1) } })).toBe(false)
    expect(isLabDocument({ ...fallback, input: { format: 'yaml', text: '' } })).toBe(false)
    expect(writeDocumentSession({ ...fallback, input: { format: 'text', text: 'x'.repeat(INPUT_TEXT_LIMIT + 1) }, filePath: null, dirty: true, lastSavedCode: null })).toBe(false)
    expect(storage.setItem).not.toHaveBeenCalled()
  })
})
