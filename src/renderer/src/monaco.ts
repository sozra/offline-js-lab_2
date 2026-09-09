import * as monaco from 'monaco-editor/editor'
import 'monaco-editor/features/register.all'
import 'monaco-editor/languages/definitions/javascript/register'
import {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  javascriptDefaults,
  typescriptDefaults
} from 'monaco-editor/languages/features/typescript/register'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment: {
    getWorker(moduleId: string, label: string): Worker
  }
}

monacoGlobal.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'javascript' || label === 'typescript') return new TypeScriptWorker()
    return new EditorWorker()
  }
}

const typeScriptApi = {
  typescriptDefaults,
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget
}

export type TypeScriptApi = typeof typeScriptApi

/**
 * Monaco 0.56 的自定义 ESM 入口不会把 TypeScript API 挂回 `monaco` 命名空间。
 * 始终返回 register 入口的具名导出，避免 Renderer 在 Vue 挂载前抛错并黑屏。
 */
export function getTypeScriptApi(): TypeScriptApi {
  return typeScriptApi
}

const compilerOptions = {
  allowNonTsExtensions: true,
  allowSyntheticDefaultImports: true,
  esModuleInterop: true,
  module: ModuleKind.ESNext,
  moduleResolution: ModuleResolutionKind.NodeJs,
  noEmit: true,
  resolveJsonModule: true,
  strict: false,
  target: ScriptTarget.ESNext
}

typescriptDefaults.setCompilerOptions(compilerOptions)
javascriptDefaults.setCompilerOptions({
  ...compilerOptions,
  allowJs: true,
  checkJs: true
})

const diagnosticsOptions = {
  noSemanticValidation: false,
  noSyntaxValidation: false,
  diagnosticCodesToIgnore: [2307, 7016]
}
typescriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
javascriptDefaults.setDiagnosticsOptions(diagnosticsOptions)
typescriptDefaults.setEagerModelSync(true)
javascriptDefaults.setEagerModelSync(true)

monaco.editor.defineTheme('cyberdeck-2077', {
  base: 'vs-dark',
  inherit: true,
  rules: [
    { token: 'comment', foreground: '61767B', fontStyle: 'italic' },
    { token: 'keyword', foreground: 'FCED0A' },
    { token: 'number', foreground: '00F0FF' },
    { token: 'string', foreground: 'A8FF60' },
    { token: 'type.identifier', foreground: 'FF6BD6' },
    { token: 'identifier', foreground: 'DCECEF' },
    { token: 'delimiter', foreground: '82969B' }
  ],
  colors: {
    'editor.background': '#070A0D',
    'editor.foreground': '#DCECEF',
    'editorCursor.foreground': '#FCED0A',
    'editor.selectionBackground': '#00F0FF33',
    'editor.inactiveSelectionBackground': '#00F0FF1C',
    'editor.lineHighlightBackground': '#10171C',
    'editorLineNumber.foreground': '#3F575C',
    'editorLineNumber.activeForeground': '#FCED0A',
    'editorIndentGuide.background1': '#162328',
    'editorIndentGuide.activeBackground1': '#30525A',
    'editorWhitespace.foreground': '#20343A',
    'editorBracketMatch.background': '#FCED0A22',
    'editorBracketMatch.border': '#FCED0A',
    'editorGutter.background': '#070A0D',
    'editorWidget.background': '#0C1217',
    'editorWidget.border': '#00F0FF66',
    'editorSuggestWidget.background': '#0B1014',
    'editorSuggestWidget.border': '#00F0FF55',
    'editorSuggestWidget.selectedBackground': '#18323A',
    'editorHoverWidget.background': '#0B1014',
    'editorHoverWidget.border': '#FCED0A55',
    'scrollbarSlider.background': '#00F0FF20',
    'scrollbarSlider.hoverBackground': '#00F0FF40',
    'scrollbarSlider.activeBackground': '#FCED0A55'
  }
})

export { monaco }
