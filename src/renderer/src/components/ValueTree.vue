<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ValueSnapshot } from '@shared/types'
import { snapshotTable } from '../composables/outputPresentation'

const props = withDefaults(defineProps<{ value: ValueSnapshot; label?: string; depth?: number }>(), { depth: 0 })
const expanded = ref(false)
const tableMode = ref(false)
const children = computed(() => props.depth < 6 ? (props.value.children ?? []).slice(0, 60) : [])
const table = computed(() => props.depth === 0 ? snapshotTable(props.value) : null)
</script>

<template>
  <div class="value-tree">
    <div class="value-tree__summary">
      <button v-if="children.length" type="button" :aria-expanded="expanded" :aria-label="`${expanded ? '收起' : '展开'} ${label || value.kind}`" @click="expanded = !expanded">{{ expanded ? '▾' : '▸' }}</button>
      <span v-else class="value-tree__spacer" />
      <span v-if="label !== undefined" class="value-tree__key">{{ label }}:</span>
      <span class="value-tree__value" :class="`value-tree__value--${value.kind}`">{{ value.preview }}</span>
      <span v-if="value.truncated" class="value-tree__limit" title="此处只保留有界快照，展开不会求值">已截断</span>
      <button v-if="table" class="value-tree__table-button" type="button" @click="tableMode = !tableMode; expanded = true">{{ tableMode ? '树形' : '表格' }}</button>
    </div>
    <template v-if="expanded">
      <div v-if="tableMode && table" class="value-tree__table-wrap">
        <table><thead><tr><th scope="col">索引</th><th v-for="column in table.columns" :key="column" scope="col">{{ column }}</th></tr></thead><tbody><tr v-for="row in table.rows" :key="row.key"><th scope="row">{{ row.key }}</th><td v-for="(cell, index) in row.cells" :key="index">{{ cell }}</td></tr></tbody></table>
        <p v-if="table.truncated">表格最多显示 30 行、12 列；树形视图可查看其余已捕获字段。</p>
      </div>
      <div v-else class="value-tree__children"><ValueTree v-for="(child, index) in children" :key="`${child.key}-${index}`" :value="child.value" :label="child.key" :depth="depth + 1" /></div>
    </template>
  </div>
</template>

<style scoped>
.value-tree{font:12px/1.7 var(--code-font,monospace);color:#cbdde5;min-width:0}.value-tree__summary{display:flex;align-items:baseline;gap:6px;min-width:0}.value-tree button{font:inherit;color:var(--cyber-cyan);border:0;background:none;padding:0 2px;cursor:pointer}.value-tree__spacer{width:13px;flex:none}.value-tree__key{color:#a2bfd1;flex:none}.value-tree__value{overflow-wrap:anywhere;white-space:pre-wrap}.value-tree__value--string{color:#9ddebf}.value-tree__value--number,.value-tree__value--bigint{color:#f1d787}.value-tree__value--accessor,.value-tree__value--circular,.value-tree__limit{color:#99a7b3}.value-tree__limit{font-size:10px;white-space:nowrap}.value-tree__children{margin-left:12px;padding-left:10px;border-left:1px solid #31414c}.value-tree .value-tree__table-button{margin-left:auto;border:1px solid #3a515d;white-space:nowrap;font-size:10px;padding:0 5px}.value-tree__table-wrap{overflow:auto;margin:7px 0 8px 18px}.value-tree table{border-collapse:collapse;min-width:100%;font-size:11px}.value-tree th,.value-tree td{border:1px solid #324650;padding:4px 8px;text-align:left;white-space:pre-wrap;min-width:55px;max-width:280px;overflow-wrap:anywhere}.value-tree th{background:#13202a;color:#a3c5d4}.value-tree__table-wrap p{font-size:10px;color:#9facb5}.value-tree button:focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:2px}
</style>
