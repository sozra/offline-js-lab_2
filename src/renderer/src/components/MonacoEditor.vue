<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ScriptLanguage, TypeDefinitionFile } from '@shared/types'
import { isTypeScriptLanguage, languageExtension } from '@shared/languages'
import { SOURCE_LINE_HEIGHT, SOURCE_PADDING_TOP, SOURCE_PADDING_BOTTOM, type SourceViewport } from '../editorLayout'
import {
  configureJsxTypeSupport,
  getTypeScriptApi,
  monaco,
  probeLanguageService,
  type LanguageServiceProbeResult
} from '../monaco'

const props = defineProps<{
  modelValue: string
  language: ScriptLanguage
  typeDefinitions: TypeDefinitionFile[]
  readOnly?: boolean
  alignToSource?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
  ready: []
  run: []
  save: []
  open: []
  scroll: [scrollTop: number]
  viewport: [viewport: SourceViewport]
  'language-service': [result: LanguageServiceProbeResult]
}>()

const container = ref<HTMLElement>()
let editor: ReturnType<typeof monaco.editor.create> | undefined
let resizeObserver: ResizeObserver | undefined
let applyingExternalValue = false
let typeDisposables: monaco.IDisposable[] = []
let actionDisposables: monaco.IDisposable[] = []
let languageProbeGeneration = 0
let viewportFrame = 0
let diagnosticDecorations: monaco.editor.IEditorDecorationsCollection | undefined

const requiredEditorActions = [
  'editor.action.commentLine',
  'editor.action.blockComment',
  'editor.action.formatDocument',
  'editor.action.triggerSuggest'
] as const

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function applyTypeDefinitions(files: TypeDefinitionFile[]): void {
  for (const disposable of typeDisposables) disposable.dispose()
  typeDisposables = []

  const typescript = getTypeScriptApi()
  const labTypes = 'declare const lab: { readonly input: any; readonly inputText: string };'
  typeDisposables.push(typescript.typescriptDefaults.addExtraLib(labTypes, 'file:///workspace/lab.d.ts'))
  typeDisposables.push(typescript.javascriptDefaults.addExtraLib(labTypes, 'file:///workspace/lab.d.ts'))
  for (const file of files) {
    typeDisposables.push(typescript.typescriptDefaults.addExtraLib(file.content, file.uri))
    typeDisposables.push(typescript.javascriptDefaults.addExtraLib(file.content, file.uri))
  }
  configureJsxTypeSupport(files)
}

function runEditorAction(actionId: string): void {
  const action = editor?.getAction(actionId)
  if (!action) {
    emit('language-service', {
      language: props.language,
      ok: false,
      message: `EDITOR ACTION UNAVAILABLE // ${actionId}`
    })
    return
  }

  void action.run().catch((error: unknown) => {
    emit('language-service', {
      language: props.language,
      ok: false,
      message: `${actionId}: ${formatError(error)}`
    })
  })
}

function registerEditorActions(): void {
  if (!editor) return

  actionDisposables.push(
    editor.addAction({
      id: 'offline-js-lab.trigger-suggest',
      label: '输入建议（Tab 补全）',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Space, monaco.KeyMod.Alt | monaco.KeyCode.Slash],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 4,
      run: () => runEditorAction('editor.action.triggerSuggest')
    }),
    editor.addAction({
      id: 'offline-js-lab.toggle-line-comment',
      label: '切换行注释',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyCode.Slash],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 1,
      run: () => runEditorAction('editor.action.commentLine')
    }),
    editor.addAction({
      id: 'offline-js-lab.toggle-block-comment',
      label: '切换块注释',
      keybindings: [monaco.KeyMod.CtrlCmd | monaco.KeyMod.Shift | monaco.KeyCode.Slash],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 2,
      run: () => runEditorAction('editor.action.blockComment')
    }),
    editor.addAction({
      id: 'offline-js-lab.format-document',
      label: '格式化文档',
      keybindings: [monaco.KeyMod.Shift | monaco.KeyMod.Alt | monaco.KeyCode.KeyF],
      contextMenuGroupId: '1_modification',
      contextMenuOrder: 3,
      run: () => runEditorAction('editor.action.formatDocument')
    })
  )
}

/**
 * Monaco 的 Ctrl+/ 映射通常可以直接工作，但不同 Windows 键盘布局可能把
 * `/` 报告为不同字符。用物理按键 code 做捕获级兜底，避免依赖 event.key。
 */
function onNativeEditorKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.code === 'Slash') {
    event.preventDefault()
    event.stopPropagation()
    runEditorAction(event.shiftKey ? 'editor.action.blockComment' : 'editor.action.commentLine')
    return
  }

  if (event.shiftKey && event.altKey && event.code === 'KeyF') {
    event.preventDefault()
    event.stopPropagation()
    runEditorAction('editor.action.formatDocument')
  }
}

async function verifyLanguageService(): Promise<void> {
  const model = editor?.getModel()
  if (!model) return

  const generation = ++languageProbeGeneration
  const language = props.language

  try {
    const missingActions = requiredEditorActions.filter((actionId) => !editor?.getAction(actionId))
    if (missingActions.length > 0) {
      throw new Error(`缺少编辑器命令：${missingActions.join(', ')}`)
    }

    await probeLanguageService(language, model.uri)
    if (generation !== languageProbeGeneration) return
    emit('language-service', {
      language,
      ok: true,
      message: `${languageExtension(language).toUpperCase()} LANGUAGE SERVICE ONLINE`
    })
  } catch (error) {
    if (generation !== languageProbeGeneration) return
    emit('language-service', {
      language,
      ok: false,
      message: `LANGUAGE SERVICE OFFLINE // ${formatError(error)}`
    })
  }
}

onMounted(() => {
  if (!container.value) return
  const extension = languageExtension(props.language)
  const model = monaco.editor.createModel(
    props.modelValue,
    isTypeScriptLanguage(props.language) ? 'typescript' : 'javascript',
    monaco.Uri.parse(`file:///workspace/scratch.${extension}`)
  )

  editor = monaco.editor.create(container.value, {
    model,
    theme: 'cyberdeck-2077',
    readOnly: props.readOnly ?? false,
    automaticLayout: false,
    contextmenu: true,
    hover: {
      enabled: 'on',
      delay: 250,
      sticky: true
    },
    quickSuggestions: {
      other: true,
      comments: false,
      strings: true
    },
    suggestOnTriggerCharacters: true,
    quickSuggestionsDelay: 100,
    tabCompletion: 'on',
    acceptSuggestionOnEnter: 'smart',
    suggestSelection: 'first',
    wordBasedSuggestions: 'currentDocument',
    snippetSuggestions: 'inline',
    suggest: {
      preview: true,
      previewMode: 'prefix',
      localityBonus: true,
      showStatusBar: true
    },
    parameterHints: { enabled: true },
    formatOnPaste: true,
    formatOnType: true,
    fontFamily: "'Fira Code', SFMono-Regular, Cascadia Code, Consolas, Liberation Mono, Menlo, monospace",
    fontLigatures: true,
    fontSize: 13,
    lineHeight: SOURCE_LINE_HEIGHT,
    minimap: { enabled: false },
    padding: { top: SOURCE_PADDING_TOP, bottom: SOURCE_PADDING_BOTTOM },
    renderWhitespace: 'selection',
    renderLineHighlight: 'all',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
    stickyScroll: { enabled: !props.alignToSource },
    scrollbar: { horizontal: 'visible', horizontalScrollbarSize: 9, verticalScrollbarSize: 9 },
    tabSize: 2,
    wordWrap: 'off',
    bracketPairColorization: { enabled: true },
    guides: { bracketPairs: true, indentation: true },
    cursorBlinking: 'phase',
    cursorSmoothCaretAnimation: 'on',
    overviewRulerBorder: false,
    fixedOverflowWidgets: true
  })

  editor.onDidChangeModelContent(() => {
    if (applyingExternalValue || !editor) return
    const value = editor.getValue()
    diagnosticDecorations?.clear()
    emit('update:modelValue', value)
    emit('change', value)
  })

  editor.onDidScrollChange((event) => {
    if (event.scrollTopChanged) emit('scroll', event.scrollTop)
    scheduleViewport()
  })
  editor.onDidLayoutChange(scheduleViewport)
  editor.onDidContentSizeChange(scheduleViewport)
  editor.onDidChangeHiddenAreas(scheduleViewport)

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('run'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, () => emit('open'))
  diagnosticDecorations = editor.createDecorationsCollection()
  registerEditorActions()

  applyTypeDefinitions(props.typeDefinitions)
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(container.value)
  container.value.addEventListener('keydown', onNativeEditorKeydown, true)
  emit('ready')
  scheduleViewport()
  window.setTimeout(() => void verifyLanguageService(), 0)
})

function scheduleViewport(): void {
  if (viewportFrame) return
  viewportFrame = requestAnimationFrame(() => {
    viewportFrame = 0
    if (!editor) return
    const lines: SourceViewport['lines'] = []
    for (const range of editor.getVisibleRanges()) {
      for (let line = range.startLineNumber; line <= range.endLineNumber; line++) {
        lines.push({ line, top: editor.getTopForLineNumber(line) })
      }
    }
    emit('viewport', { scrollTop: editor.getScrollTop(), scrollHeight: editor.getScrollHeight(), height: editor.getLayoutInfo().height, lines })
  })
}

watch(
  () => props.modelValue,
  (value) => {
    if (!editor || editor.getValue() === value) return
    applyingExternalValue = true
    editor.setValue(value)
    applyingExternalValue = false
  }
)

watch(
  () => props.language,
  (language) => {
    const model = editor?.getModel()
    if (!model) return
    const nextModel = monaco.editor.createModel(
      model.getValue(),
      isTypeScriptLanguage(language) ? 'typescript' : 'javascript',
      monaco.Uri.parse(`file:///workspace/scratch.${languageExtension(language)}`)
    )
    editor?.setModel(nextModel)
    model.dispose()
    window.setTimeout(() => void verifyLanguageService(), 0)
  }
)

watch(
  () => props.typeDefinitions,
  (files) => {
    applyTypeDefinitions(files)
    window.setTimeout(() => void verifyLanguageService(), 0)
  },
  { deep: false }
)

watch(
  () => props.alignToSource,
  (align) => { editor?.updateOptions({ stickyScroll: { enabled: !align } }); scheduleViewport() }
)

watch(
  () => props.readOnly,
  (readOnly) => editor?.updateOptions({ readOnly: Boolean(readOnly) })
)

onBeforeUnmount(() => {
  languageProbeGeneration += 1
  resizeObserver?.disconnect()
  if (viewportFrame) cancelAnimationFrame(viewportFrame)
  if (container.value) container.value.removeEventListener('keydown', onNativeEditorKeydown, true)
  for (const disposable of typeDisposables) disposable.dispose()
  for (const disposable of actionDisposables) disposable.dispose()
  const model = editor?.getModel()
  editor?.dispose()
  model?.dispose()
})

defineExpose({
  focus: () => editor?.focus(),
  layout: () => editor?.layout(),
  revealLocation: (line: number, column = 1) => {
    const model = editor?.getModel()
    if (!model || !editor) return
    const safeLine = Math.max(1, Math.min(model.getLineCount(), line))
    const safeColumn = Math.max(1, Math.min(model.getLineMaxColumn(safeLine), column))
    editor.setPosition({ lineNumber: safeLine, column: safeColumn })
    editor.revealLineInCenter(safeLine)
    diagnosticDecorations?.set([{ range: new monaco.Range(safeLine, 1, safeLine, 1), options: { isWholeLine: true, className: 'lab-source-highlight' } }])
    editor.focus()
  },
  setScrollTop: (scrollTop: number) => {
    editor?.setScrollTop(Math.max(0, scrollTop), monaco.editor.ScrollType.Immediate)
  }
})
</script>

<template>
  <div ref="container" class="monaco-editor-host" />
</template>

<style scoped>
.monaco-editor-host {
  width: 100%;
  height: 100%;
  min-width: 0;
  min-height: 0;
  overflow: hidden;
  background: #070a0d;
}
</style>
