import type { LabDocument, ScriptInput, ScriptLanguage } from '@shared/types'

export const DOCUMENT_SESSION_KEY = 'offlineJsLab.documentSession'
export const INPUT_TEXT_LIMIT = 512 * 1024
export const DOCUMENT_CODE_LIMIT = 2 * 1024 * 1024

export interface DocumentSession extends LabDocument {
  filePath: string | null
  dirty: boolean
  lastSavedCode: string | null
}

export function isScriptLanguage(value: unknown): value is ScriptLanguage {
  return value === 'javascript' || value === 'typescript' || value === 'jsx' || value === 'tsx'
}

export function isScriptInput(value: unknown): value is ScriptInput {
  if (!value || typeof value !== 'object') return false
  const input = value as Partial<ScriptInput>
  return (input.format === 'json' || input.format === 'text') &&
    typeof input.text === 'string' && input.text.length <= INPUT_TEXT_LIMIT
}

export function isLabDocument(value: unknown): value is LabDocument {
  if (!value || typeof value !== 'object') return false
  const doc = value as Partial<LabDocument>
  return typeof doc.code === 'string' && doc.code.length <= DOCUMENT_CODE_LIMIT &&
    isScriptLanguage(doc.language) && isScriptInput(doc.input)
}

export function readDocumentSession(defaultDoc: LabDocument): DocumentSession {
  const fallback: DocumentSession = {
    ...defaultDoc, input: { ...defaultDoc.input }, filePath: null, dirty: false, lastSavedCode: null
  }
  try {
    const raw = window.localStorage.getItem(DOCUMENT_SESSION_KEY)
    if (raw !== null) {
      const saved: unknown = JSON.parse(raw)
      if (!saved || typeof saved !== 'object') return fallback
      const record = saved as { version?: unknown; document?: unknown }
      if (record.version !== 1 || !isLabDocument(record.document)) return fallback
      const session = record.document as Partial<DocumentSession> & LabDocument
      const filePath = typeof session.filePath === 'string' && session.filePath.length <= 32768
        ? session.filePath : null
      const lastSavedCode = typeof session.lastSavedCode === 'string' && session.lastSavedCode.length <= DOCUMENT_CODE_LIMIT
        ? session.lastSavedCode : null
      return {
        code: session.code, language: session.language, input: { ...session.input }, filePath, lastSavedCode,
        // A missing/invalid baseline cannot turn a restored file into a falsely saved document.
        dirty: session.dirty === true || (filePath !== null && (lastSavedCode === null || lastSavedCode !== session.code))
      }
    }
    const legacyCode = window.localStorage.getItem('offlineJsLab.code')
    const legacyLanguage = window.localStorage.getItem('offlineJsLab.language')
    if (legacyCode !== null && legacyCode.length <= DOCUMENT_CODE_LIMIT) {
      fallback.code = legacyCode
      fallback.dirty = true
    }
    if (isScriptLanguage(legacyLanguage)) fallback.language = legacyLanguage
  } catch {
    // Corrupt or unavailable browser storage must never prevent starting the editor.
  }
  return fallback
}

export function writeDocumentSession(session: DocumentSession): boolean {
  if (!isLabDocument(session) || typeof session.dirty !== 'boolean' ||
    !(session.filePath === null || (typeof session.filePath === 'string' && session.filePath.length <= 32768)) ||
    !(session.lastSavedCode === null || (typeof session.lastSavedCode === 'string' && session.lastSavedCode.length <= DOCUMENT_CODE_LIMIT))) return false
  try {
    // One setItem is atomic. Do not spread a session across independently written keys.
    window.localStorage.setItem(DOCUMENT_SESSION_KEY, JSON.stringify({ version: 1, document: session }))
    return true
  } catch {
    return false
  }
}
