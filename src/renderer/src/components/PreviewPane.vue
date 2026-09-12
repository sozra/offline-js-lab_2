<script setup lang="ts">
import { nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { PreviewBounds } from '@shared/types'

const props = defineProps<{ visible: boolean; active: boolean; status: string; error: string; busy: boolean; needsReact: boolean; stale: boolean }>()
const emit = defineEmits<{ bounds: [bounds: PreviewBounds]; restart: []; dependencies: [] }>()
const host = ref<HTMLElement>()
let observer: ResizeObserver | undefined
let frame = 0
let lastBounds = ''

function reportBounds(): void {
  frame = 0
  const rect = host.value?.getBoundingClientRect()
  const bounds: PreviewBounds = { x: rect?.x ?? 0, y: rect?.y ?? 0, width: rect?.width ?? 0, height: rect?.height ?? 0, visible: props.visible && Boolean(rect && rect.width > 0 && rect.height > 0) }
  const signature = JSON.stringify(bounds)
  if (signature !== lastBounds) { lastBounds = signature; emit('bounds', bounds) }
}
function scheduleBounds(): void {
  if (frame) cancelAnimationFrame(frame)
  frame = requestAnimationFrame(reportBounds)
}
watch(() => [props.visible, props.status, props.error, props.active], async () => { await nextTick(); scheduleBounds() })
onMounted(() => {
  observer = new ResizeObserver(scheduleBounds)
  if (host.value) observer.observe(host.value)
  window.addEventListener('resize', scheduleBounds)
  window.addEventListener('scroll', scheduleBounds, true)
  scheduleBounds()
})
onBeforeUnmount(() => {
  observer?.disconnect()
  if (frame) cancelAnimationFrame(frame)
  window.removeEventListener('resize', scheduleBounds)
  window.removeEventListener('scroll', scheduleBounds, true)
  emit('bounds', { x: 0, y: 0, width: 0, height: 0, visible: false })
})
</script>

<template>
  <section class="preview-pane" aria-label="React 组件预览">
    <header class="preview-pane__head">
      <span>REACT PREVIEW <b>{{ status }}</b></span>
      <button class="micro-button" type="button" :disabled="busy" @click="emit('restart')">重启预览</button>
    </header>
    <div v-if="error || stale" class="preview-notice" :class="{ 'preview-notice--error': error }" role="status">
      {{ error || '代码或输入已修改，当前画面来自上次运行。' }}
    </div>
    <div ref="host" class="preview-surface">
      <div v-if="!active" class="preview-empty">
        <strong>{{ busy ? '正在构建组件…' : '在这里预览 JSX / TSX' }}</strong>
        <p>默认导出 React 组件后运行，支持状态、事件和输入数据。</p>
        <button v-if="needsReact" class="cyber-button" type="button" @click="emit('dependencies')">准备 React 依赖</button>
        <p v-else>点击运行或启用实时模式。每次运行重置组件状态。</p>
      </div>
    </div>
  </section>
</template>

<style scoped>
.preview-pane{display:flex;flex-direction:column;min-height:0;min-width:0;flex:1;background:#080d11;border:1px solid #29414a}
.preview-pane__head{display:flex;flex-wrap:wrap;gap:8px;align-items:center;justify-content:space-between;flex:none;padding:9px 12px;color:var(--cyber-cyan);font-size:11px;border-bottom:1px solid #29414a}
.preview-pane__head b{font-weight:400;color:#afc5ce;margin-left:8px}
.preview-surface{flex:1;min-height:100px;position:relative;background:#fff}
.preview-empty{display:flex;position:absolute;inset:0;align-items:center;justify-content:center;flex-direction:column;padding:20px;text-align:center;color:#b7ccd4;background:#0d171d;overflow:auto}
.preview-empty strong{color:var(--cyber-cyan);font-size:14px}.preview-empty p{max-width:36em;font-size:12px;line-height:1.7}
.preview-notice{padding:8px 12px;background:#22200c;color:#fff09c;font-size:12px;overflow-wrap:anywhere;max-height:110px;overflow:auto;flex:none}
.preview-notice--error{background:#30121b;color:#ffb0c1}
</style>
