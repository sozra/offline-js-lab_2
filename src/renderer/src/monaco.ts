import type { ScriptLanguage } from '@shared/types'
import * as monaco from 'monaco-editor'
import EditorWorker from 'monaco-editor/editor/editor.worker.js?worker'
import TypeScriptWorker from 'monaco-editor/languages/features/typescript/ts.worker.js?worker'

const monacoGlobal = globalThis as typeof globalThis & {
  MonacoEnvironment: {
    getWorker(moduleId: string, label: string): Worker
  }
}

/**
 * Monaco 的 JS/TS IntelliSense、悬浮说明和格式化依赖 TypeScript Worker。
 * Worker 必须由应用显式映射；否则编辑器仍可能显示语法高亮，但语言服务会静默退化。
 */
monacoGlobal.MonacoEnvironment = {
  getWorker(_moduleId: string, label: string) {
    if (label === 'javascript' || label === 'typescript') return new TypeScriptWorker()
    return new EditorWorker()
  }
}

const {
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  getJavaScriptWorker,
  getTypeScriptWorker,
  javascriptDefaults,
  typescriptDefaults
} = monaco.typescript

const typeScriptApi = {
  typescriptDefaults,
  javascriptDefaults,
  ModuleKind,
  ModuleResolutionKind,
  ScriptTarget,
  getTypeScriptWorker,
  getJavaScriptWorker
}

export type TypeScriptApi = typeof typeScriptApi

/**
 * 使用 Monaco 0.56 完整入口导出的顶层 `typescript` API，确保编辑器特性、
 * JS/TS 语言功能和命令来自同一 Monaco 模块实例。
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

/**
 * 不依赖 Monaco 的隐式默认值。显式开启 RunJS 类 scratchpad 需要的语言能力，
 * 防止某个平台或构建缓存只注册 tokenizer 而没有完整语言功能。
 */
const modeConfiguration = {
  completionItems: true,
  hovers: true,
  documentSymbols: true,
  definitions: true,
  references: true,
  documentHighlights: true,
  rename: true,
  diagnostics: true,
  documentRangeFormattingEdits: true,
  signatureHelp: true,
  onTypeFormattingEdits: true,
  codeActions: true,
  inlayHints: true
} satisfies Parameters<typeof typescriptDefaults.setModeConfiguration>[0]

typescriptDefaults.setModeConfiguration(modeConfiguration)
javascriptDefaults.setModeConfiguration(modeConfiguration)

export interface LanguageServiceProbeResult {
  language: ScriptLanguage
  ok: boolean
  message: string
}

/**
 * 主动访问当前模型对应的 Worker。与仅检查 API 是否存在相比，这能真实发现
 * Worker URL、CSP、Vite 构建或启动缓存导致的语言服务加载失败。
 */
export async function probeLanguageService(
  language: ScriptLanguage,
  uri: monaco.Uri
): Promise<void> {
  const getWorker = language === 'typescript'
    ? await getTypeScriptWorker()
    : await getJavaScriptWorker()
  const worker = await getWorker(uri)
  await worker.getSyntacticDiagnostics(uri.toString())
}

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
    'editor.selectionBackground': '#FF003C38',
    'editor.inactiveSelectionBackground': '#FF003C1E',
    'editor.lineHighlightBackground': '#121A20',
    'editorLineNumber.foreground': '#3F575C',
    'editorLineNumber.activeForeground': '#FF4D6F',
    'editorIndentGuide.background1': '#162328',
    'editorIndentGuide.activeBackground1': '#30525A',
    'editorWhitespace.foreground': '#20343A',
    'editorBracketMatch.background': '#FF003C26',
    'editorBracketMatch.border': '#FF003C',
    'editorGutter.background': '#070A0D',
    'editorWidget.background': '#0C1217',
    'editorWidget.border': '#00F0FF66',
    'editorSuggestWidget.background': '#0B1014',
    'editorSuggestWidget.border': '#00F0FF55',
    'editorSuggestWidget.selectedBackground': '#18323A',
    'editorHoverWidget.background': '#0B1014',
    'editorHoverWidget.border': '#FF003C66',
    'scrollbarSlider.background': '#00F0FF20',
    'scrollbarSlider.hoverBackground': '#00F0FF40',
    'scrollbarSlider.activeBackground': '#FCED0A55'
  }
})

export { monaco }
