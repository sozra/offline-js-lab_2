<script setup lang="ts">
import { computed, nextTick, ref, watch } from 'vue'
import type { OutputChunk } from '@shared/types'

const ALIGNED_LINE_HEIGHT = 21
const ALIGNED_PADDING_TOP = 15
const ALIGNED_PADDING_BOTTOM = 24

const props = defineProps<{
  chunks: OutputChunk[]
  revision: number
  statusLabel: string
  statusKind: string
  clearOnRun: boolean
  alignToSource: boolean
  editorLineCount: number
  editorScrollTop: number
}>()

const emit = defineEmits<{
  'update:clearOnRun': [value: boolean]
  'update:alignToSource': [value: boolean]
  'source-scroll': [scrollTop: number]
  clear: []
}>()

interface AlignedRow {
  line: number
  chunks: OutputChunk[]
}

const viewport = ref<HTMLElement>()
let stickToBottom = true

const mappedChunks = computed(() =>
  props.chunks.filter(
    (chunk): chunk is OutputChunk & { sourceLine: number } =>
      Number.isInteger(chunk.sourceLine) && Number(chunk.sourceLine) > 0
  )
)

const showAlignedView = computed(() => props.alignToSource && mappedChunks.value.length > 0)

const alignedRows = computed<AlignedRow[]>(() => {
  const rows = new Map<number, OutputChunk[]>()
  for (const chunk of mappedChunks.value) {
    const row = rows.get(chunk.sourceLine)
    if (row) row.push(chunk)
    else rows.set(chunk.sourceLine, [chunk])
  }
  return [...rows.entries()]
    .sort(([left], [right]) => left - right)
    .map(([line, chunks]) => ({ line, chunks }))
})

const unpositionedChunks = computed(() =>
  props.chunks.filter((chunk) => {
    if (Number.isInteger(chunk.sourceLine) && Number(chunk.sourceLine) > 0) return false
    return !(chunk.stream === 'system' && /╞══ .*EXECUTION/.test(chunk.text))
  })
)

const alignedCanvasHeight = computed(() => {
  const lastMappedLine = alignedRows.value.at(-1)?.line ?? 1
  const lineCount = Math.max(1, props.editorLineCount, lastMappedLine)
  return ALIGNED_PADDING_TOP + lineCount * ALIGNED_LINE_HEIGHT + ALIGNED_PADDING_BOTTOM
})

function alignedText(text: string): string {
  return text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ↵ ').trimEnd()
}

function onScroll(): void {
  const element = viewport.value
  if (!element) return
  if (showAlignedView.value) {
    if (Math.abs(element.scrollTop - props.editorScrollTop) > 1) {
      emit('source-scroll', element.scrollTop)
    }
    return
  }
  stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 54
}

watch(
  () => props.editorScrollTop,
  (scrollTop) => {
    if (showAlignedView.value && viewport.value) viewport.value.scrollTop = scrollTop
  }
)

watch(showAlignedView, async (aligned) => {
  await nextTick()
  if (!viewport.value) return
  if (aligned) viewport.value.scrollTop = props.editorScrollTop
  else stickToBottom = viewport.value.scrollHeight - viewport.value.scrollTop - viewport.value.clientHeight < 54
})

watch(
  () => props.revision,
  async () => {
    if (showAlignedView.value || !stickToBottom) return
    await nextTick()
    if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
  }
)
</script>

<template>
  <section class="hud-panel output-panel" aria-label="运行输出">
    <div class="panel-corner panel-corner--top" aria-hidden="true" />
    <header class="pane-head output-head">
      <div class="pane-ident">
        <span class="pane-index">02</span>
        <div>
          <strong>OUTPUT STREAM</strong>
          <small>{{ alignToSource ? 'SOURCE-LINKED ROWS // STDOUT + VALUES' : 'NODE PROCESS // STDOUT + STDERR' }}</small>
        </div>
      </div>

      <div class="output-controls">
        <span class="run-state" :class="`run-state--${statusKind}`">
          <i aria-hidden="true" />
          {{ statusLabel }}
        </span>
        <label class="cyber-toggle" title="让可定位的打印结果与编辑器源代码行保持相同高度和滚动位置">
          <input
            type="checkbox"
            :checked="alignToSource"
            aria-label="按源代码行对齐输出"
            @change="emit('update:alignToSource', ($event.target as HTMLInputElement).checked)"
          />
          <span class="cyber-toggle__track" aria-hidden="true"><i /></span>
          <span class="cyber-toggle__label">LINE:SYNC</span>
        </label>
        <label class="cyber-toggle" title="控制手动与实时运行前是否清空输出">
          <input
            type="checkbox"
            :checked="clearOnRun"
            aria-label="每次运行前清空输出"
            @change="emit('update:clearOnRun', ($event.target as HTMLInputElement).checked)"
          />
          <span class="cyber-toggle__track" aria-hidden="true"><i /></span>
          <span class="cyber-toggle__label">RUN:CLEAR</span>
        </label>
        <button class="micro-button" type="button" title="立即清空输出" @click="emit('clear')">
          PURGE
        </button>
      </div>
    </header>

    <div class="console-shell" :class="{ 'console-shell--aligned': showAlignedView }">
      <div class="console-ruler" aria-hidden="true">
        <span>000</span><span>128</span><span>256</span><span>512</span>
      </div>
      <div ref="viewport" class="console-viewport" role="log" aria-live="polite" @scroll="onScroll">
        <div v-if="chunks.length === 0" class="console-empty">
          <span class="console-empty__reticle" aria-hidden="true" />
          <strong>NO SIGNAL</strong>
          <p>运行结果将在此处建立数据链路。</p>
          <small>CMD/CTRL + ENTER TO EXECUTE</small>
        </div>

        <div
          v-else-if="showAlignedView"
          class="aligned-output-canvas"
          :style="{ height: `${alignedCanvasHeight}px` }"
        >
          <div
            v-for="row in alignedRows"
            :key="row.line"
            class="aligned-output-row"
            :style="{ top: `${ALIGNED_PADDING_TOP + (row.line - 1) * ALIGNED_LINE_HEIGHT}px` }"
          >
            <span class="aligned-output-line">L{{ String(row.line).padStart(3, '0') }}</span>
            <span
              v-for="chunk in row.chunks"
              :key="chunk.id"
              class="aligned-output-value output-chunk"
              :class="`output-chunk--${chunk.stream}`"
              :title="chunk.text"
            >{{ alignedText(chunk.text) }}</span>
          </div>

        </div>

        <pre v-else class="console-content"><span
          v-for="chunk in chunks"
          :key="chunk.id"
          class="output-chunk"
          :class="`output-chunk--${chunk.stream}`"
        >{{ chunk.text }}</span></pre>
      </div>
      <div v-if="showAlignedView && unpositionedChunks.length" class="console-unpositioned" role="note">
        <b>UNMAPPED</b>
        <pre><span
          v-for="chunk in unpositionedChunks"
          :key="chunk.id"
          class="output-chunk"
          :class="`output-chunk--${chunk.stream}`"
        >{{ chunk.text }}</span></pre>
      </div>
      <div class="console-scan" aria-hidden="true" />
    </div>
    <div class="panel-corner panel-corner--bottom" aria-hidden="true" />
  </section>
</template>
