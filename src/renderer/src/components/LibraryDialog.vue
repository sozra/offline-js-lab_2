<script setup lang="ts">
import { computed, ref } from 'vue'
import type { LabDocument } from '@shared/types'
import { LAB_TEMPLATES, useLabLibrary } from '../composables/useLabLibrary'
import { useDialogFocus } from '../composables/useDialogFocus'
import ConfirmDialog from './ConfirmDialog.vue'

const props = defineProps<{ visible: boolean; document: LabDocument }>()
const emit = defineEmits<{ close: []; load: [document: LabDocument] }>()
const { snippets, error, readOnly, save, rename, remove } = useLabLibrary()
const dialog = ref<HTMLElement>()
const searchInput = ref<HTMLInputElement>()
const query = ref('')
const name = ref('')
const editingId = ref<string | null>(null)
const editingName = ref('')
const removingId = ref<string | null>(null)
const status = ref('')
const filteredSnippets = computed(() => snippets.value.filter(item => `${item.name} ${item.language}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const filteredTemplates = computed(() => LAB_TEMPLATES.filter(item => `${item.name} ${item.language} ${item.description}`.toLocaleLowerCase().includes(query.value.toLocaleLowerCase())))
const { onDialogKeydown } = useDialogFocus(() => props.visible, dialog, () => emit('close'), () => searchInput.value)

function saveCurrent(): void {
  status.value = ''
  if (save(name.value, props.document)) { name.value = ''; status.value = '当前代码、语言和输入已收藏。' }
}

function saveName(): void {
  if (editingId.value && rename(editingId.value, editingName.value)) { editingId.value = null; status.value = '名称已更新。' }
}

function deleteSnippet(): void {
  if (removingId.value && remove(removingId.value)) status.value = '片段已删除。'
  removingId.value = null
}

function load(document: LabDocument): void {
  emit('load', { code: document.code, language: document.language, input: { ...document.input } })
}
</script>

<template>
  <Teleport to="body">
    <Transition name="hud-dialog">
      <div v-if="visible" class="dialog-backdrop library-backdrop" @mousedown.self="emit('close')">
        <section ref="dialog" class="cyber-dialog library-dialog" role="dialog" aria-modal="true" aria-labelledby="library-title" tabindex="-1" @keydown="onDialogKeydown">
          <header class="dialog-head">
            <div><span class="eyebrow">LOCAL EXPERIMENTS</span><h2 id="library-title">片段收藏与模板</h2><p>每个片段保留代码、语言与输入数据</p></div>
            <button class="dialog-close" type="button" aria-label="关闭片段库" @click="emit('close')">×</button>
          </header>
          <div class="library-body">
            <form class="library-save" @submit.prevent="saveCurrent">
              <label for="snippet-name">收藏当前实验</label>
              <div><input id="snippet-name" v-model="name" maxlength="80" placeholder="为这个实验起个名字" /><button class="cyber-button cyber-button--primary" type="submit" :disabled="readOnly || !name.trim()">收藏</button></div>
            </form>
            <p v-if="error" class="library-error" role="alert">{{ error }}</p>
            <p v-else-if="status" class="library-status" role="status">{{ status }}</p>
            <input ref="searchInput" v-model="query" class="library-search" type="search" aria-label="搜索片段和模板" placeholder="搜索片段、模板或语言…" />
            <h3>我的收藏 <span>{{ snippets.length }} / 60</span></h3>
            <p v-if="!filteredSnippets.length" class="library-empty">{{ snippets.length ? '没有匹配的收藏。' : '还没有收藏。保存一个常用实验，下次直接继续。' }}</p>
            <article v-for="snippet in filteredSnippets" :key="snippet.id" class="library-item">
              <form v-if="editingId === snippet.id" class="library-rename" @submit.prevent="saveName">
                <input v-model="editingName" maxlength="80" aria-label="新的片段名称" />
                <button class="micro-button" type="submit">保存名称</button><button class="micro-button" type="button" @click="editingId = null">取消</button>
              </form>
              <template v-else>
                <div class="library-copy"><strong>{{ snippet.name }}</strong><span>{{ snippet.language.toUpperCase() }} · {{ new Date(snippet.updatedAt).toLocaleDateString() }} · {{ snippet.input.format.toUpperCase() }} 输入</span></div>
                <div class="library-actions"><button class="micro-button" type="button" @click="load(snippet)">载入</button><button class="micro-button" type="button" :disabled="readOnly" @click="editingId = snippet.id; editingName = snippet.name">改名</button><button class="micro-button micro-button--danger" type="button" :disabled="readOnly" @click="removingId = snippet.id">删除</button></div>
              </template>
            </article>
            <h3>内置模板 <span>本地运行</span></h3>
            <p v-if="!filteredTemplates.length" class="library-empty">没有匹配的模板。</p>
            <article v-for="template in filteredTemplates" :key="template.id" class="library-item">
              <div class="library-copy"><strong>{{ template.name }}</strong><span>{{ template.description }}</span></div>
              <button class="micro-button" type="button" @click="load(template)">使用模板</button>
            </article>
          </div>
          <footer class="dialog-foot"><span>仅存于本机 · 收藏容量上限 2 M 字符</span><button class="cyber-button cyber-button--secondary" type="button" @click="emit('close')">完成</button></footer>
        </section>
      </div>
    </Transition>
  </Teleport>
  <ConfirmDialog :visible="visible && removingId !== null" title="删除收藏片段？" message="删除后无法恢复。当前编辑器中的代码不会改变。" confirm-label="删除片段" danger @confirm="deleteSnippet" @cancel="removingId = null" />
</template>

<style scoped>
.library-dialog{width:min(760px,calc(100vw - 40px));max-height:calc(100vh - 50px);display:flex;flex-direction:column}
.library-dialog .dialog-head{flex:none;align-items:flex-start;justify-content:space-between}
.library-dialog h2{font-size:23px;margin-top:6px}.library-dialog .dialog-head p{font-size:12px;margin-top:7px;color:#99a9b5}
.library-body{padding:18px 24px;overflow-y:auto;min-height:0}.library-body h3{display:flex;align-items:center;gap:10px;font-size:13px;margin:22px 0 10px;color:#dce6ec}.library-body h3 span{color:#92a5b4;font-weight:normal;font-size:11px}
.library-save>label{display:block;font-size:12px;color:#a4b4c0;margin-bottom:8px}.library-save>div{display:flex;gap:10px}.library-save input{flex:1;min-width:0}
.library-body input{background:#0b1117;border:1px solid #394854;color:#e6eff5;padding:10px 12px;font:inherit;font-size:12px}.library-search{width:100%;margin-top:15px;box-sizing:border-box}
.library-item{display:flex;gap:14px;align-items:center;justify-content:space-between;border-bottom:1px solid #293540;padding:12px 0}.library-copy{min-width:0;display:flex;flex-direction:column;gap:7px}.library-copy strong{font-size:13px;overflow-wrap:anywhere;color:#dfe8ee}.library-copy span,.library-empty{font-size:11px;line-height:1.7;color:#9eaebc}.library-actions{display:flex;flex:none;gap:8px}.library-item>.micro-button{flex:none}
.library-rename{display:flex;align-items:center;gap:8px;width:100%;flex-wrap:wrap}.library-rename input{flex:1;min-width:100px}.library-error{color:var(--cyber-red);font-size:12px;line-height:1.7}.library-status{color:var(--cyber-green);font-size:12px}.library-dialog :is(input,button):focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:2px}.library-dialog .dialog-foot{flex:none;gap:12px}.library-dialog .dialog-foot>span{font-size:11px}
@media(max-width:620px){.library-body{padding:14px}.library-item{align-items:flex-start;flex-wrap:wrap}.library-dialog .dialog-foot{flex-wrap:wrap}}
</style>
