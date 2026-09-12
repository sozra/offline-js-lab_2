import { languageExtension } from '@shared/languages'
import type { RunSnapshot, SourceLocation } from '@shared/types'

function normalizePath(value: string, workspace: string, windows: boolean): string | null {
  let candidate = value.replace(/^lab-source:/, '')
  if (/^file:/i.test(candidate)) {
    try {
      const url = new URL(candidate)
      candidate = `${url.host ? `//${url.host}` : ''}${decodeURIComponent(url.pathname)}`
    } catch { return null }
  }
  candidate = candidate.replace(/\\/g, '/')
  if (windows) candidate = candidate.replace(/^\/([a-z]:\/)/i, '$1')
  if (!/^(?:\/|[a-z]:\/)/i.test(candidate)) candidate = `${workspace.replace(/\\/g, '/')}/${candidate}`
  const prefix = candidate.startsWith('//') ? '//' : candidate.startsWith('/') ? '/' : ''
  const segments: string[] = []
  for (const segment of candidate.split('/')) {
    if (!segment || segment === '.') continue
    if (segment === '..') {
      if (segments.length && !segments.at(-1)?.endsWith(':')) segments.pop()
    } else segments.push(segment)
  }
  const result = prefix + segments.join('/')
  return windows ? result.toLocaleLowerCase('en-US') : result
}

/** Only source positions for this run's entry document may align to the editor. */
export function isEntrySourceLocation(
  location: SourceLocation | undefined,
  document: Pick<RunSnapshot, 'filePath' | 'language'>,
  workspacePath: string,
  platform: string
): boolean {
  if (!location?.file) return true
  const windows = platform === 'win32'
  const source = document.filePath || `${workspacePath}/scratch.${languageExtension(document.language)}`
  const actual = normalizePath(location.file, workspacePath, windows)
  return actual !== null && actual === normalizePath(source, workspacePath, windows)
}
