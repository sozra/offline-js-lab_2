<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { monaco } from '../monaco'

// The parent supplies the same bounded, normalized text used by its line summary.
const props = defineProps<{ left: string; right: string; truncated: boolean }>()
const host = ref<HTMLElement>()
const differenceCount = ref(0)
const computing = ref(true)
const failure = ref('')
const status = computed(() => {
  if (failure.value) return failure.value
  if (computing.value) return '正在计算差异…'
  if (props.left === props.right) return props.truncated ? '已显示部分相同 · 完整结果未知' : '两次输出相同'
  return `${differenceCount.value} 处差异`
})
let editor: monaco.editor.IStandaloneDiffEditor | undefined
let original: monaco.editor.ITextModel | undefined
let modified: monaco.editor.ITextModel | undefined
let subscription: monaco.IDisposable | undefined

function dispose(): void {
  subscription?.dispose()
  editor?.dispose()
  original?.dispose()
  modified?.dispose()
  subscription = undefined
  editor = undefined
  original = undefined
  modified = undefined
}

function navigate(direction: 'previous' | 'next'): void {
  editor?.goToDiff(direction)
}

onMounted(() => {
  if (!host.value) return
  try {
    original = monaco.editor.createModel(props.left, 'plaintext')
    modified = monaco.editor.createModel(props.right, 'plaintext')
    editor = monaco.editor.createDiffEditor(host.value, {
      theme: 'cyberdeck-2077',
      automaticLayout: true,
      readOnly: true,
      originalEditable: false,
      domReadOnly: true,
      renderSideBySide: true,
      useInlineViewWhenSpaceIsLimited: false,
      enableSplitViewResizing: false,
      diffAlgorithm: 'advanced',
      ignoreTrimWhitespace: false,
      renderIndicators: true,
      renderMarginRevertIcon: false,
      renderGutterMenu: false,
      diffWordWrap: 'on',
      scrollBeyondLastLine: false,
      minimap: { enabled: false },
      stickyScroll: { enabled: false },
      folding: false,
      links: false,
      contextmenu: false,
      renderLineHighlight: 'none',
      renderWhitespace: 'selection',
      unicodeHighlight: { ambiguousCharacters: false, invisibleCharacters: false },
      fontFamily: 'SFMono-Regular, Cascadia Code, Consolas, Liberation Mono, Menlo, monospace',
      fontSize: 12,
      lineHeight: 21,
      lineNumbersMinChars: 3,
      padding: { top: 12, bottom: 12 },
      originalAriaLabel: '固定基线输出，只读',
      modifiedAriaLabel: '本次运行输出，只读',
      accessibilityVerbose: true
    })
    subscription = editor.onDidUpdateDiff(() => {
      differenceCount.value = editor?.getLineChanges()?.length ?? 0
      computing.value = false
    })
    editor.setModel({ original, modified })
    editor.revealFirstDiff()
  } catch (error) {
    dispose()
    failure.value = '差异视图加载失败，请关闭后重新打开。'
    computing.value = false
    console.error('Result diff editor failed to initialize', error)
  }
})

watch(() => [props.left, props.right] as const, ([left, right]) => {
  if (!editor || !original || !modified) return
  computing.value = true
  differenceCount.value = 0
  original.setValue(left)
  modified.setValue(right)
})

onBeforeUnmount(dispose)
</script>

<template>
  <div class="result-diff">
    <div class="compare-tools">
      <div class="compare-legend"><span class="compare-legend--removed">− 基线删除</span><span class="compare-legend--added">+ 本次新增</span><span>深色高亮为行内变化</span></div>
      <nav class="compare-navigation" aria-label="差异导航">
        <span class="compare-status" role="status">{{ status }}</span>
        <button class="micro-button" type="button" aria-label="上一处差异" :disabled="computing || !differenceCount" @click="navigate('previous')">↑ 上一处</button>
        <button class="micro-button" type="button" aria-label="下一处差异" :disabled="computing || !differenceCount" @click="navigate('next')">↓ 下一处</button>
      </nav>
    </div>
    <div ref="host" class="compare-editor" :aria-busy="computing" />
  </div>
</template>

<style scoped>
.result-diff { display: flex; flex: 1; flex-direction: column; min-height: 0; }
.compare-tools { display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between; gap: 10px; padding: 10px 18px; border-bottom: 1px solid #283943; background: #101a22; }
.compare-legend, .compare-navigation { display: flex; flex-wrap: wrap; align-items: center; gap: 12px; font-size: 11px; color: #a1b3bf; }
.compare-legend--removed { color: #ff9bad; }
.compare-legend--added { color: #a0e6bf; }
.compare-status { font-variant-numeric: tabular-nums; }
.compare-navigation .micro-button { font-size: 11px; }
.compare-editor { flex: 1; min-height: 0; overflow: hidden; background: #070a0d; }
button:focus-visible { outline: 2px solid var(--cyber-yellow); outline-offset: 2px; }
@media (max-width: 650px) { .compare-tools { padding: 10px; } }
</style>
