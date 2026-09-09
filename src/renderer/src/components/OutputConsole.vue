<script setup lang="ts">
import { nextTick, ref, watch } from 'vue'
import type { OutputChunk } from '@shared/types'

const props = defineProps<{
  chunks: OutputChunk[]
  revision: number
  statusLabel: string
  statusKind: string
  clearOnRun: boolean
}>()

const emit = defineEmits<{
  'update:clearOnRun': [value: boolean]
  clear: []
}>()

const viewport = ref<HTMLElement>()
let stickToBottom = true

function onScroll(): void {
  const element = viewport.value
  if (!element) return
  stickToBottom = element.scrollHeight - element.scrollTop - element.clientHeight < 54
}

watch(
  () => props.revision,
  async () => {
    if (!stickToBottom) return
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
          <small>NODE PROCESS // STDOUT + STDERR</small>
        </div>
      </div>

      <div class="output-controls">
        <span class="run-state" :class="`run-state--${statusKind}`">
          <i aria-hidden="true" />
          {{ statusLabel }}
        </span>
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

    <div class="console-shell">
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
        <pre v-else class="console-content"><span
          v-for="chunk in chunks"
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
