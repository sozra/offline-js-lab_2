<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { OutputChunk, RunSnapshot, SourceLocation } from '@shared/types'
import { alignedRunChunks, selectOutputChunks, snapshotJson } from '../composables/outputPresentation'
import ValueTree from './ValueTree.vue'
import { SOURCE_LINE_HEIGHT, SOURCE_PADDING_TOP, SOURCE_PADDING_BOTTOM, type SourceViewport } from '../editorLayout'

const props = defineProps<{
  chunks: OutputChunk[]
  revision: number
  statusLabel: string
  statusKind: string
  clearOnRun: boolean
  alignToSource: boolean
  alignmentAvailable?: boolean
  editorLineCount: number
  editorScrollTop: number
  editorViewport?: SourceViewport
  runs?: RunSnapshot[]
  selectedRunId?: string
  currentRunId?: string
  stale?: boolean
  pinned?: RunSnapshot | null
}>()
const emit = defineEmits<{
  'update:clearOnRun': [value: boolean]
  'update:alignToSource': [value: boolean]
  'source-scroll': [scrollTop: number]
  'select-run': [id: string]
  'restore-run': []
  locate: [location: SourceLocation]
  pin: []
  compare: []
  unpin: []
  clear: []
}>()
interface AlignedRow { line: number; chunks: OutputChunk[] }
const viewport = ref<HTMLElement>()
const viewportHeight = ref(0)
let viewportObserver: ResizeObserver | undefined
const stickToBottom = ref(true)
const query = ref('')
const streamFilter = ref('all')
const clipboardStatus = ref('')
const inspectedChunk = ref<OutputChunk | null>(null)
const expandedValues = ref(new Set<string>())
const selectedSnapshot = computed(() => props.runs?.find(run => run.id === props.selectedRunId))
const baseChunks = computed(() => selectOutputChunks(props.chunks, props.runs ?? [], props.selectedRunId))
const activeRunId = computed(() => props.selectedRunId || props.currentRunId || '')
const filteredChunks = computed(() => baseChunks.value.filter(chunk =>
  (streamFilter.value === 'all' || chunk.stream === streamFilter.value) &&
  (!query.value || chunk.text.toLocaleLowerCase().includes(query.value.toLocaleLowerCase()))
))
const scopedChunks = computed(() => alignedRunChunks(filteredChunks.value, activeRunId.value))
const mappedChunks = computed(() => scopedChunks.value.filter((chunk): chunk is OutputChunk & { sourceLine: number } =>
  Number.isInteger(chunk.sourceLine) && Number(chunk.sourceLine) > 0
))
const showAlignedView = computed(() => props.alignToSource && props.alignmentAvailable !== false && mappedChunks.value.length > 0)
const syncEnabled = computed(() => showAlignedView.value && !props.stale)
const sourcePositions = computed(() => new Map(props.editorViewport?.lines.map(row => [row.line, row.top])))
const alignedRows = computed<AlignedRow[]>(() => {
  const rows = new Map<number, OutputChunk[]>()
  for (const chunk of mappedChunks.value) {
    const row = rows.get(chunk.sourceLine)
    if (row) row.push(chunk)
    else rows.set(chunk.sourceLine, [chunk])
  }
  return [...rows.entries()].sort(([left], [right]) => left - right).map(([line, chunks]) => ({ line, chunks }))
})
const visibleAlignedRows = computed(() => alignedRows.value.flatMap(row => {
  const top = syncEnabled.value && props.editorViewport
    ? sourcePositions.value.get(row.line)
    : SOURCE_PADDING_TOP + (row.line - 1) * SOURCE_LINE_HEIGHT
  return top === undefined ? [] : [{ ...row, top }]
}))
const unpositionedChunks = computed(() => filteredChunks.value.filter(chunk => {
  if (activeRunId.value && chunk.runId && chunk.runId !== activeRunId.value) return false
  if (Number.isInteger(chunk.sourceLine) && Number(chunk.sourceLine) > 0) return false
  return !(chunk.stream === 'system' && /╞══ .*EXECUTION/.test(chunk.text))
}))
const alignedCanvasHeight = computed(() => {
  if (syncEnabled.value && props.editorViewport && viewportHeight.value) {
    // Match Monaco's scroll range even when native scrollbar sizes differ.
    return props.editorViewport.scrollHeight - props.editorViewport.height + viewportHeight.value
  }
  const lastMappedLine = alignedRows.value.at(-1)?.line ?? 1
  const sourceLineCount = props.stale && selectedSnapshot.value ? selectedSnapshot.value.code.split('\n').length : props.editorLineCount
  return SOURCE_PADDING_TOP + Math.max(1, sourceLineCount, lastMappedLine) * SOURCE_LINE_HEIGHT + SOURCE_PADDING_BOTTOM
})
const canPin = computed(() => Boolean(props.selectedRunId || props.currentRunId || props.runs?.length))
function alignedText(text: string): string { return text.replace(/\r\n?/g, '\n').replace(/\n/g, ' ↵ ').trimEnd() }
function runLabel(run: RunSnapshot): string { return `${new Date(run.createdAt).toLocaleTimeString()} · ${run.language.toUpperCase()} · ${run.status}` }
function location(chunk: OutputChunk): SourceLocation | null {
  if (chunk.location) return chunk.location
  return chunk.sourceLine ? { line: chunk.sourceLine, column: 1 } : null
}
function canLocate(chunk: OutputChunk): boolean {
  return !props.stale && (!chunk.runId || !activeRunId.value || chunk.runId === activeRunId.value)
}
function chunkKey(chunk: OutputChunk): string { return `${chunk.runId || ''}-${chunk.id}` }
function toggleValues(event: Event, chunk: OutputChunk): void {
  if ((event.currentTarget as HTMLDetailsElement).open) expandedValues.value.add(chunkKey(chunk))
  else expandedValues.value.delete(chunkKey(chunk))
}
function locate(chunk: OutputChunk): void { const target = location(chunk); if (canLocate(chunk) && target) emit('locate', target) }
async function copyChunk(chunk: OutputChunk, json = false): Promise<void> {
  try {
    await navigator.clipboard.writeText(json && chunk.values ? snapshotJson(chunk.values) : chunk.text)
    clipboardStatus.value = json ? '已复制快照 JSON；特殊值和截断信息以标记保留。' : '已复制输出文本。'
  } catch { clipboardStatus.value = '复制失败，请选中文本后使用 Ctrl/Cmd+C。' }
}
function onScroll(): void {
  const element = viewport.value
  if (!element) return
  if (syncEnabled.value) {
    if (Math.abs(element.scrollTop - props.editorScrollTop) > 1) emit('source-scroll', element.scrollTop)
  } else if (!showAlignedView.value) stickToBottom.value = element.scrollHeight - element.scrollTop - element.clientHeight < 54
}
async function toBottom(): Promise<void> {
  stickToBottom.value = true
  await nextTick()
  if (viewport.value) viewport.value.scrollTop = viewport.value.scrollHeight
}
watch(() => [props.editorScrollTop, props.editorViewport, viewportHeight.value], async () => {
  await nextTick()
  if (syncEnabled.value && viewport.value) viewport.value.scrollTop = props.editorScrollTop
})
watch(syncEnabled, async enabled => { await nextTick(); if (enabled && viewport.value) viewport.value.scrollTop = props.editorScrollTop })
watch(showAlignedView, async aligned => { if (!aligned && stickToBottom.value) await toBottom() })
watch(() => props.revision, async () => {
  if (inspectedChunk.value && !baseChunks.value.some(chunk => chunk.id === inspectedChunk.value?.id && chunk.runId === inspectedChunk.value?.runId)) inspectedChunk.value = null
  if (expandedValues.value.size) {
    const keys = new Set(baseChunks.value.map(chunkKey))
    for (const key of expandedValues.value) if (!keys.has(key)) expandedValues.value.delete(key)
  }
  if (!showAlignedView.value && stickToBottom.value) await toBottom()
})
watch(() => props.selectedRunId, async () => { inspectedChunk.value = null; expandedValues.value.clear(); clipboardStatus.value = ''; if (!showAlignedView.value) await toBottom() })
onMounted(() => {
  viewportObserver = new ResizeObserver(() => { viewportHeight.value = viewport.value?.clientHeight ?? 0 })
  if (viewport.value) viewportObserver.observe(viewport.value)
})
onBeforeUnmount(() => viewportObserver?.disconnect())
</script>

<template>
  <section class="hud-panel output-panel output-panel--enhanced" aria-label="运行输出">
    <div class="panel-corner panel-corner--top" aria-hidden="true" />
    <header class="pane-head output-head">
      <div class="pane-ident"><span class="pane-index">02</span><div><strong>运行输出</strong><small>OUTPUT STREAM · STDOUT + VALUES</small></div></div>
      <div class="output-controls">
        <span class="run-state" :class="`run-state--${statusKind}`"><i aria-hidden="true" />{{ statusLabel }}</span>
        <details class="output-settings"><summary>输出设置</summary><div class="output-settings__body">
          <label class="cyber-toggle" title="只对齐选中的一次运行；完整历史保留在顺序视图"><input type="checkbox" :checked="alignToSource" aria-label="按源代码行对齐输出" @change="emit('update:alignToSource', ($event.target as HTMLInputElement).checked)" /><span class="cyber-toggle__track" aria-hidden="true"><i /></span><span class="cyber-toggle__label">源行对齐 · LINE:SYNC</span></label>
          <label class="cyber-toggle" title="控制手动与实时运行前是否清空输出"><input type="checkbox" :checked="clearOnRun" aria-label="每次运行前清空输出" @change="emit('update:clearOnRun', ($event.target as HTMLInputElement).checked)" /><span class="cyber-toggle__track" aria-hidden="true"><i /></span><span class="cyber-toggle__label">运行前清空 · RUN:CLEAR</span></label>
          <p>{{ alignmentAvailable === false ? '切换到控制台标签后可按源行对齐。' : '源行对齐只显示当前或选中的运行；关闭后查看完整时间顺序。' }}</p>
        </div></details>
        <button class="micro-button" type="button" title="立即清空输出 · PURGE" @click="emit('clear')">清空</button>
      </div>
    </header>
    <div class="console-shell" :class="{ 'console-shell--aligned': showAlignedView }">
      <div class="console-ruler" aria-hidden="true"><span>000</span><span>128</span><span>256</span><span>512</span></div>
      <div ref="viewport" class="console-viewport" role="log" aria-live="polite" @scroll="onScroll">
        <div v-if="filteredChunks.length === 0" class="console-empty"><span class="console-empty__reticle" aria-hidden="true" /><strong>{{ baseChunks.length ? '没有匹配结果' : '等待运行' }}</strong><p>{{ baseChunks.length ? '调整搜索词或输出类型。' : '运行代码后，结果会显示在这里。' }}</p><small>CMD/CTRL + ENTER</small></div>
        <div v-else-if="showAlignedView" class="aligned-output-canvas" :style="{ height: `${alignedCanvasHeight}px` }">
          <div v-for="row in visibleAlignedRows" :key="row.line" class="aligned-output-row" :style="{ top: `${row.top}px` }">
            <button class="aligned-output-line" type="button" :disabled="stale" :title="stale ? '源码已变化，恢复快照后可定位' : `跳转到第 ${row.line} 行`" @click="locate(row.chunks[0]!)">L{{ String(row.line).padStart(3, '0') }}</button>
            <button v-for="chunk in row.chunks" :key="chunk.id" type="button" class="aligned-output-value output-chunk" :class="`output-chunk--${chunk.stream}`" :title="`${chunk.text}\n点击展开与复制`" @click="inspectedChunk = chunk">{{ alignedText(chunk.text) }}</button>
          </div>
        </div>
        <div v-else class="console-content output-entries">
          <article v-for="chunk in filteredChunks" :key="`${chunk.runId || ''}-${chunk.id}`" class="output-entry" :class="`output-chunk--${chunk.stream}`">
            <div class="output-entry__actions"><button v-if="location(chunk)" class="output-location" type="button" :disabled="!canLocate(chunk)" :title="canLocate(chunk) ? '定位源码' : '此行来自其他源码，请选择对应运行并恢复快照后定位'" @click="locate(chunk)">L{{ location(chunk)!.line }}:{{ location(chunk)!.column }}</button><button type="button" @click="copyChunk(chunk)">复制</button><button v-if="chunk.values?.length" type="button" @click="copyChunk(chunk, true)">复制快照 JSON</button></div>
            <pre class="output-chunk">{{ chunk.text }}</pre>
            <details v-if="chunk.values?.length" class="output-value-details" :open="expandedValues.has(chunkKey(chunk))" @toggle="toggleValues($event, chunk)"><summary>检查值 <span>运行时快照</span></summary><template v-if="expandedValues.has(chunkKey(chunk))"><ValueTree v-for="(value, index) in chunk.values" :key="index" :value="value" /></template></details>
          </article>
        </div>
      </div>
      <div v-if="showAlignedView && unpositionedChunks.length && !inspectedChunk" class="console-unpositioned" role="note"><b>UNMAPPED<br />无源行</b><div><article v-for="chunk in unpositionedChunks" :key="chunk.id" :class="`output-chunk--${chunk.stream}`"><button v-if="location(chunk)" class="unmapped-locate" type="button" :disabled="stale" @click="locate(chunk)">定位 L{{ location(chunk)!.line }}</button><pre>{{ chunk.text }}</pre></article></div></div>
      <div v-if="inspectedChunk" class="output-inspector"><header><strong>输出详情</strong><button class="micro-button" type="button" @click="copyChunk(inspectedChunk)">复制</button><button v-if="inspectedChunk.values?.length" class="micro-button" type="button" @click="copyChunk(inspectedChunk, true)">快照 JSON</button><button class="micro-button" type="button" @click="inspectedChunk = null">关闭</button></header><pre :class="`output-chunk--${inspectedChunk.stream}`">{{ inspectedChunk.text }}</pre><ValueTree v-for="(value, index) in inspectedChunk.values || []" :key="index" :value="value" /></div>
      <button v-if="!showAlignedView && !stickToBottom" class="output-to-bottom micro-button" type="button" @click="toBottom">↓ 回到底部并自动跟随</button>
      <div v-if="clipboardStatus" class="output-copy-status" role="status">{{ clipboardStatus }}<button type="button" aria-label="关闭复制提示" @click="clipboardStatus = ''">×</button></div>
      <div class="console-scan" aria-hidden="true" />
    </div>
    <div class="output-browse">
      <select :value="selectedRunId || ''" aria-label="选择运行结果" @change="emit('select-run', ($event.target as HTMLSelectElement).value)"><option value="">{{ showAlignedView ? '本次运行 · 源行对齐' : '完整顺序输出' }}</option><option v-for="run in runs || []" :key="run.id" :value="run.id">{{ runLabel(run) }}</option></select>
      <button class="micro-button" type="button" :disabled="!canPin" title="将当前选择的运行固定为比较基线" @click="emit('pin')">固定结果</button>
      <button class="micro-button" type="button" :disabled="!pinned || !canPin" @click="emit('compare')">比较</button>
      <details v-if="pinned" class="pinned-details"><summary title="已固定比较基线">已固定</summary><div><span>{{ new Date(pinned.createdAt).toLocaleString() }}</span><button class="micro-button" type="button" @click="emit('unpin')">取消固定</button></div></details>
      <details v-if="stale" class="output-context">
        <summary title="代码或输入已变化；行定位与滚动同步已暂停">旧结果</summary>
        <div><p>代码或输入已变化。重新运行即可更新结果；恢复快照后可继续行定位与滚动同步。</p><button class="micro-button" type="button" @click="emit('restore-run')">恢复运行快照</button></div>
      </details>
      <button v-else-if="selectedRunId" class="output-history-back" type="button" title="正在查看历史运行，点击返回完整输出" @click="emit('select-run', '')">返回全部</button>
      <div class="output-search"><input v-model="query" type="search" aria-label="搜索输出文本" placeholder="搜索输出…" /><select v-model="streamFilter" aria-label="输出类型筛选"><option value="all">全部类型</option><option value="stdout">标准输出</option><option value="stderr">错误</option><option value="expression">表达式</option><option value="system">系统</option><option value="package">npm</option></select></div>
    </div>
    <div class="panel-corner panel-corner--bottom" aria-hidden="true" />
  </section>
</template>

<style scoped>
.output-panel--enhanced{display:flex;flex-direction:column;min-height:0;min-width:0}.output-panel--enhanced>.output-head{flex:none;min-height:56px;height:auto;flex-wrap:wrap;gap:9px;padding-top:9px;padding-bottom:9px}.output-panel--enhanced .pane-ident strong{font-size:13px}.output-panel--enhanced .pane-ident small{font-size:9px}.output-panel--enhanced .output-controls{flex-wrap:wrap;gap:8px}.output-panel--enhanced .micro-button{font-size:11px;min-height:26px}.output-panel--enhanced>.console-shell{flex:1;min-height:0}.output-browse{display:flex;align-items:center;gap:7px;padding:8px 12px;flex-wrap:wrap;background:#0c131a;border-top:1px solid #293b45;flex:none}.output-browse>select{flex:1;min-width:120px;max-width:100%}.output-browse :is(select,input){color:#c6d8e4;background:#101c25;border:1px solid #314752;font:11px var(--code-font,monospace);padding:5px 7px;min-height:27px;box-sizing:border-box}.output-search{display:flex;gap:7px;flex-basis:100%;min-width:0}.output-search input{flex:1;min-width:70px}.output-search select{flex:none;max-width:130px}.output-settings,.pinned-details,.output-context{position:relative;font-size:11px;color:#a9c0cc}.output-settings>summary,.pinned-details>summary{cursor:pointer;padding:5px 7px;border:1px solid #37515b;list-style:none}.output-settings__body,.pinned-details>div{position:absolute;right:0;top:100%;z-index:25;width:260px;background:#101c24;border:1px solid #49636f;box-shadow:0 10px 30px #0009;padding:13px;display:flex;flex-direction:column;gap:14px}.output-settings__body .cyber-toggle__label{display:inline!important;font-size:11px!important}.output-settings__body p{font-size:11px;line-height:1.6;margin:0;color:#96aebc}.pinned-details>div{width:220px;gap:9px}.output-context>summary,.output-history-back{color:#a0b1bc;background:transparent;border:0;padding:4px;font:11px var(--code-font,monospace);cursor:pointer;list-style:none;white-space:nowrap}.output-context>summary:hover,.output-history-back:hover{color:#d4e3ea}.output-context>div{position:absolute;bottom:calc(100% + 9px);right:0;z-index:25;width:245px;padding:12px;background:#101c24;border:1px solid #49636f;box-shadow:0 10px 30px #0009;color:#b3c5ce}.output-context p{margin:0 0 10px;font-size:11px;line-height:1.7}.pinned-details>div{top:auto;bottom:calc(100% + 9px)}.output-copy-status{position:absolute;right:12px;bottom:12px;z-index:7;max-width:calc(100% - 24px);display:flex;align-items:center;gap:10px;padding:7px 10px;border:1px solid #38514a;background:#13211f;color:#b9d4cc;font-size:11px}.output-copy-status button{background:none;border:0;color:inherit;font-size:16px;cursor:pointer}.output-entries.console-content{min-width:0;padding:9px 12px 45px;white-space:normal}.output-entry{position:relative;border-bottom:1px solid #25313a55;padding:5px 0 7px}.output-entry>pre{font:12px/1.65 var(--code-font,monospace);white-space:pre-wrap;overflow-wrap:anywhere;margin:0}.output-entry__actions{display:flex;gap:9px;align-items:center;min-height:20px;font:10px var(--code-font,monospace);color:#849eae}.output-entry__actions>button{background:none;border:0;padding:0;color:inherit;font:inherit;cursor:pointer}.output-entry__actions>button:hover{color:var(--cyber-cyan)}.output-entry__actions .output-location{color:#8dbbcf}.output-entry__actions>button:disabled{color:#596874;cursor:default}.output-value-details{margin:4px 0 0;border-left:2px solid #314d5d;padding-left:7px;font-size:11px;color:#a0c6d9}.output-value-details>summary{cursor:pointer;list-style:revert}.output-value-details>summary>span{font-size:10px;color:#899eaa;margin-left:9px}.output-value-details[open]>summary{margin-bottom:5px}.aligned-output-line{border-top:0;border-bottom:0;border-left:0;cursor:pointer}.aligned-output-line:disabled{cursor:default;color:#687985}.aligned-output-value{background:none;border:0;padding:0 4px;font:inherit;line-height:21px;text-align:left;cursor:pointer}.aligned-output-value:hover{background:#263a45}.console-unpositioned{max-height:130px}.console-unpositioned>div{overflow:auto;min-width:0}.console-unpositioned pre{white-space:pre-wrap;overflow-wrap:anywhere}.unmapped-locate{border:0;background:none;color:#9fc9db;font:10px var(--code-font,monospace);padding:4px 8px;cursor:pointer}.output-inspector{position:absolute;bottom:8px;left:10px;right:10px;z-index:5;max-height:55%;overflow:auto;background:#101b24;border:1px solid #4a6674;padding:10px 12px;box-shadow:0 6px 20px #000b}.output-inspector>header{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin-bottom:8px}.output-inspector strong{font-size:12px;color:#bcd5e2;flex:1}.output-inspector>pre{font:12px/1.65 var(--code-font,monospace);white-space:pre-wrap;overflow-wrap:anywhere;margin:0 0 8px}.output-to-bottom{position:absolute;right:15px;bottom:12px;z-index:6;background:#173442;color:#bfe9f8}.output-panel--enhanced :is(button,input,select,summary):focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:2px}@media(max-width:650px){.output-panel--enhanced .pane-ident small{display:none}.output-settings__body{right:-42px;width:230px}.output-browse{padding:7px}.output-browse>select{flex-basis:100%}}
</style>
