<script setup lang="ts">
import { onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { ScriptLanguage, TypeDefinitionFile } from '@shared/types'
import { getTypeScriptApi, monaco } from '../monaco'

const props = defineProps<{
  modelValue: string
  language: ScriptLanguage
  typeDefinitions: TypeDefinitionFile[]
  readOnly?: boolean
}>()

const emit = defineEmits<{
  'update:modelValue': [value: string]
  change: [value: string]
  ready: []
  run: []
  save: []
  open: []
}>()

const container = ref<HTMLElement>()
let editor: ReturnType<typeof monaco.editor.create> | undefined
let resizeObserver: ResizeObserver | undefined
let applyingExternalValue = false
let typeDisposables: monaco.IDisposable[] = []

function applyTypeDefinitions(files: TypeDefinitionFile[]): void {
  for (const disposable of typeDisposables) disposable.dispose()
  typeDisposables = []

  const typescript = getTypeScriptApi()
  for (const file of files) {
    typeDisposables.push(typescript.typescriptDefaults.addExtraLib(file.content, file.uri))
    typeDisposables.push(typescript.javascriptDefaults.addExtraLib(file.content, file.uri))
  }
}

onMounted(() => {
  if (!container.value) return
  const extension = props.language === 'typescript' ? 'ts' : 'js'
  const model = monaco.editor.createModel(
    props.modelValue,
    props.language,
    monaco.Uri.parse(`file:///workspace/scratch.${extension}`)
  )

  editor = monaco.editor.create(container.value, {
    model,
    theme: 'cyberdeck-2077',
    readOnly: props.readOnly ?? false,
    automaticLayout: false,
    fontFamily: 'SFMono-Regular, Cascadia Code, Consolas, Liberation Mono, Menlo, monospace',
    fontLigatures: true,
    fontSize: 13,
    lineHeight: 21,
    minimap: { enabled: false },
    padding: { top: 15, bottom: 24 },
    renderWhitespace: 'selection',
    renderLineHighlight: 'all',
    roundedSelection: false,
    scrollBeyondLastLine: false,
    smoothScrolling: true,
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
    emit('update:modelValue', value)
    emit('change', value)
  })

  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.Enter, () => emit('run'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => emit('save'))
  editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyO, () => emit('open'))

  applyTypeDefinitions(props.typeDefinitions)
  resizeObserver = new ResizeObserver(() => editor?.layout())
  resizeObserver.observe(container.value)
  emit('ready')
})

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
    monaco.editor.setModelLanguage(model, language)
  }
)

watch(
  () => props.typeDefinitions,
  (files) => applyTypeDefinitions(files),
  { deep: false }
)

watch(
  () => props.readOnly,
  (readOnly) => editor?.updateOptions({ readOnly: Boolean(readOnly) })
)

onBeforeUnmount(() => {
  resizeObserver?.disconnect()
  for (const disposable of typeDisposables) disposable.dispose()
  const model = editor?.getModel()
  editor?.dispose()
  model?.dispose()
})

defineExpose({
  focus: () => editor?.focus(),
  layout: () => editor?.layout()
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
