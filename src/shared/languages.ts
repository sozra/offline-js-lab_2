import type { ScriptLanguage } from './types'

export function isScriptLanguage(value: unknown): value is ScriptLanguage {
  return value === 'javascript' || value === 'typescript' || value === 'jsx' || value === 'tsx'
}

export function isBrowserLanguage(language: ScriptLanguage): boolean {
  return language === 'jsx' || language === 'tsx'
}

export function isTypeScriptLanguage(language: ScriptLanguage): boolean {
  return language === 'typescript' || language === 'tsx'
}

export function languageExtension(language: ScriptLanguage): string {
  return language === 'typescript' ? 'ts' : language === 'javascript' ? 'js' : language
}

export function languageFromPath(filePath: string): ScriptLanguage {
  if (/\.tsx$/i.test(filePath)) return 'tsx'
  if (/\.jsx$/i.test(filePath)) return 'jsx'
  return /\.(?:ts|mts|cts)$/i.test(filePath) ? 'typescript' : 'javascript'
}
