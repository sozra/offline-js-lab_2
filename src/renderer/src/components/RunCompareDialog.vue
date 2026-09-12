<script setup lang="ts">
import { computed, ref } from 'vue'
import type { RunSnapshot } from '@shared/types'
import { compareResults, resultText } from '../composables/useRunHistory'
import { useDialogFocus } from '../composables/useDialogFocus'
import ResultDiffEditor from './ResultDiffEditor.vue'

const props = defineProps<{ visible: boolean; left: RunSnapshot | null; right: RunSnapshot | null }>()
const emit = defineEmits<{ close: []; restore: [snapshot: RunSnapshot] }>()
const dialog = ref<HTMLElement>()
const { onDialogKeydown } = useDialogFocus(() => props.visible, dialog, () => emit('close'))
const comparison = computed(() => compareResults(resultText(props.left?.chunks ?? []), resultText(props.right?.chunks ?? [])))
const changes = computed(() => ({ added: comparison.value.rows.filter(row => row.kind === 'added').length, removed: comparison.value.rows.filter(row => row.kind === 'removed').length }))
const time = (snapshot: RunSnapshot | null) => snapshot ? new Date(snapshot.createdAt).toLocaleString() : '尚无结果'
</script>

<template>
  <Teleport to="body"><Transition name="hud-dialog"><div v-if="visible" class="dialog-backdrop" @mousedown.self="emit('close')">
    <section ref="dialog" class="cyber-dialog compare-dialog" role="dialog" aria-modal="true" aria-labelledby="compare-title" tabindex="-1" @keydown="onDialogKeydown">
      <header class="dialog-head"><div><span class="eyebrow">RESULT COMPARISON</span><h2 id="compare-title">比较两次运行</h2><p>新增 {{ changes.added }} 行 · 删除 {{ changes.removed }} 行 · 仅比较 stdout、stderr 与表达式文本</p></div><button class="dialog-close" type="button" aria-label="关闭比较" @click="emit('close')">×</button></header>
      <div class="compare-labels"><div><strong>固定基线</strong><span>{{ time(left) }} · {{ left?.language.toUpperCase() }}</span><button class="micro-button" type="button" :disabled="!left" @click="left && emit('restore', left)">恢复此代码与输入</button></div><div><strong>本次结果</strong><span>{{ time(right) }} · {{ right?.language.toUpperCase() }}</span><button class="micro-button" type="button" :disabled="!right" @click="right && emit('restore', right)">恢复此代码与输入</button></div></div>
      <p v-if="comparison.truncated" class="compare-warning" role="status">比较或原始缓冲／历史已截断：此处每侧最多 500 行、100,000 字符。未保留或未显示的部分不能据此判断是否相同。</p>
      <ResultDiffEditor :left="comparison.leftText" :right="comparison.rightText" :truncated="comparison.truncated" />
      <footer class="dialog-foot"><span>文本差异 · 每侧上限 500 行 / 100 K 字符</span><button class="cyber-button cyber-button--secondary" type="button" @click="emit('close')">完成</button></footer>
    </section>
  </div></Transition></Teleport>
</template>

<style scoped>
.compare-dialog{width:min(1100px,calc(100vw - 40px));height:min(760px,calc(100vh - 48px));display:flex;flex-direction:column;min-height:0}.compare-dialog .dialog-head{justify-content:space-between;align-items:flex-start;flex:none}.compare-dialog h2{font-size:22px;margin-top:5px}.compare-dialog .dialog-head p{font-size:11px;margin-top:7px;color:#a2b6c2}.compare-labels{display:grid;grid-template-columns:1fr 1fr;border-bottom:1px solid #364a55;flex:none}.compare-labels>div{display:flex;flex-wrap:wrap;align-items:center;gap:8px;padding:13px 18px;min-width:0}.compare-labels>div+div{border-left:1px solid #364a55}.compare-labels strong{font-size:12px;color:#d8e6ec}.compare-labels span{font-size:11px;color:#a1b3bf;flex:1;min-width:130px}.compare-labels button{font-size:11px}.compare-warning{flex:none;margin:0;padding:10px 18px;background:#302d15;color:var(--cyber-yellow);font-size:12px;line-height:1.6}.compare-dialog .dialog-foot{flex:none;gap:10px}.compare-dialog .dialog-foot>span{font-size:11px}.compare-dialog :is(button,[tabindex]):focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:2px}@media(max-width:650px){.compare-labels>div{padding:10px}.compare-labels span{min-width:100px}.compare-dialog .dialog-foot{flex-wrap:wrap}}
</style>
