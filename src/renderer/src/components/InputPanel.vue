<script setup lang="ts">
import { computed, ref } from 'vue'
import type { ScriptInput } from '@shared/types'
import { INPUT_TEXT_LIMIT } from '../composables/useDocumentSession'
import { formatJsonInput } from '../composables/inputFormatting'

const props = defineProps<{ modelValue: ScriptInput; collapsed: boolean }>()
const emit = defineEmits<{
  'update:modelValue': [input: ScriptInput]
  'update:collapsed': [collapsed: boolean]
}>()
const sizeWarning = ref('')
const jsonError = computed(() => {
  if (props.modelValue.format !== 'json') return ''
  try { JSON.parse(props.modelValue.text); return '' } catch (error) {
    return error instanceof Error ? error.message : 'JSON 格式无效'
  }
})

function updateText(event: Event): void {
  const target = event.target as HTMLTextAreaElement
  if (target.value.length > INPUT_TEXT_LIMIT) {
    sizeWarning.value = '输入最多 512 K 字符，本次超限输入未应用。'
    target.value = props.modelValue.text
    return
  }
  sizeWarning.value = ''
  emit('update:modelValue', { ...props.modelValue, text: target.value })
}

function formatJson(): void {
  if (jsonError.value) return
  try {
    const text = formatJsonInput(props.modelValue.text)
    sizeWarning.value = ''
    emit('update:modelValue', { format: 'json', text })
  } catch (error) { sizeWarning.value = error instanceof Error ? error.message : '格式化失败，已保留原始输入。' }
}
</script>

<template>
  <section class="input-panel" :class="{ 'input-panel--collapsed': collapsed }" aria-label="运行输入数据">
    <header class="input-panel__head">
      <button class="input-panel__toggle" type="button" :aria-expanded="!collapsed" aria-controls="lab-input-body" @click="emit('update:collapsed', !collapsed)">
        <span aria-hidden="true">{{ collapsed ? '▸' : '▾' }}</span>
        输入数据 <span class="input-panel__meta">{{ modelValue.format.toUpperCase() }} · {{ modelValue.text.length.toLocaleString() }} 字符</span>
        <span v-if="jsonError" class="input-panel__invalid">JSON 无效</span>
      </button>
      <code v-if="collapsed" class="input-panel__usage">lab.input</code>
    </header>
    <div v-if="!collapsed" id="lab-input-body" class="input-panel__body">
      <div class="input-panel__controls">
        <label>格式
          <select :value="modelValue.format" aria-label="输入数据格式" @change="emit('update:modelValue', { ...modelValue, format: ($event.target as HTMLSelectElement).value as ScriptInput['format'] })">
            <option value="json">JSON</option><option value="text">纯文本</option>
          </select>
        </label>
        <span class="input-panel__hint"><code>lab.input</code> {{ modelValue.format === 'json' ? '读取 JSON 值' : '读取文本' }} · <code>lab.inputText</code> 读取原文</span>
        <button v-if="modelValue.format === 'json'" class="micro-button" type="button" :disabled="Boolean(jsonError)" @click="formatJson">格式化 JSON</button>
      </div>
      <textarea
        :value="modelValue.text"
        :aria-invalid="Boolean(jsonError)"
        :aria-describedby="jsonError || sizeWarning ? 'lab-input-error' : undefined"
        :placeholder="modelValue.format === 'json' ? '{ &quot;items&quot;: [] }' : '粘贴本次实验的输入文本…'"
        aria-label="运行输入内容"
        spellcheck="false"
        @input="updateText"
      />
      <p v-if="jsonError || sizeWarning" id="lab-input-error" class="input-panel__error" role="status">{{ sizeWarning || jsonError }}</p>
      <p v-else class="input-panel__foot">随下一次运行生效 · 输入与代码一起恢复和收藏 · 最大 512 K 字符</p>
    </div>
  </section>
</template>

<style scoped>
.input-panel{flex:none;border-top:1px solid #273039;background:#10151b;color:#dce4ea;min-width:0}
.input-panel__head{display:flex;align-items:center;min-height:36px;padding:0 12px;gap:12px}
.input-panel__toggle{display:flex;align-items:center;gap:9px;flex:1;min-width:0;background:none;border:0;padding:8px 0;color:inherit;text-align:left;font:inherit;font-size:12px;cursor:pointer}
.input-panel__meta,.input-panel__hint,.input-panel__foot{color:#95a6b3;font-size:11px}
.input-panel__usage,.input-panel__hint code{color:var(--cyber-cyan);font-size:11px}
.input-panel__invalid,.input-panel__error{color:var(--cyber-red)}
.input-panel__invalid{margin-left:auto;font-size:11px}
.input-panel__body{padding:0 12px 9px}
.input-panel__controls{display:flex;align-items:center;flex-wrap:wrap;gap:8px;margin:0 0 8px;font-size:11px}
.input-panel__controls label{display:flex;align-items:center;gap:6px}
.input-panel__controls select{color:#dce4ea;background:#17212a;border:1px solid #394652;padding:3px 6px;font:inherit}
.input-panel__hint{flex:1;min-width:180px}
.input-panel textarea{display:block;width:100%;height:115px;min-height:65px;max-height:250px;resize:vertical;border:1px solid #34414b;background:#090d12;color:#e2e9ef;padding:10px;font-family:monospace;font-size:12px;line-height:1.5;box-sizing:border-box}
.input-panel textarea[aria-invalid=true]{border-color:var(--cyber-red)}
.input-panel__error,.input-panel__foot{margin:6px 0 0;font-size:11px;overflow-wrap:anywhere}
.input-panel :is(button,select,textarea):focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:2px}
</style>
