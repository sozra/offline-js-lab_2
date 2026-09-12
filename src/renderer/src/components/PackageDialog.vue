<script setup lang="ts">
import { computed, ref } from 'vue'
import type { PackageState } from '@shared/types'
import { useDialogFocus } from '../composables/useDialogFocus'

const props = defineProps<{
  visible: boolean
  packageState: PackageState | null
  npmBusy: boolean
  npmStatus: string
  packageInput: string
  devDependency: boolean
  blockedReason?: string
  npmLog?: string
}>()

const emit = defineEmits<{
  close: []
  chooseWorkspace: []
  openWorkspace: []
  refresh: []
  install: []
  sync: []
  stop: []
  uninstall: [name: string]
  'update:packageInput': [value: string]
  'update:devDependency': [value: boolean]
}>()

const dialog = ref<HTMLElement>()
const packageField = ref<HTMLTextAreaElement>()
const mutationBlocked = computed(() => props.npmBusy || Boolean(props.blockedReason))
const installBlocked = computed(() => mutationBlocked.value || !props.packageInput.trim())
const { onDialogKeydown } = useDialogFocus(() => props.visible, dialog, () => emit('close'), () => props.npmBusy ? undefined : packageField.value)

function onInputKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    if (!installBlocked.value) emit('install')
  }
}

</script>

<template>
  <Teleport to="body">
    <Transition name="hud-dialog">
      <div v-if="visible" class="dialog-backdrop" role="presentation" @mousedown.self="emit('close')">
        <section ref="dialog" class="cyber-dialog package-dialog" role="dialog" aria-modal="true" aria-labelledby="package-dialog-title" tabindex="-1" @keydown="onDialogKeydown">
          <div class="dialog-notch" aria-hidden="true" />
          <header class="dialog-head">
            <div class="dialog-code">SYS.CONFIG / 03</div>
            <div>
              <h2 id="package-dialog-title">DEPENDENCY MATRIX</h2>
              <p>工作区、内网 npm Registry 与脚本类型定义</p>
            </div>
            <button class="dialog-close" type="button" aria-label="关闭" @click="emit('close')">
              <span>×</span>
            </button>
          </header>

          <div class="dialog-body">
            <section class="config-block">
              <div class="config-block__head">
                <div>
                  <span class="eyebrow">LOCAL WORKSPACE</span>
                  <h3>执行空间</h3>
                </div>
                <span class="status-chip status-chip--cyan">MOUNTED</span>
              </div>
              <div class="path-readout" :title="packageState?.workspacePath || ''">
                <span class="path-readout__prompt">ROOT://</span>
                <code>{{ packageState?.workspacePath || 'INITIALIZING...' }}</code>
              </div>
              <div class="button-cluster">
                <button class="cyber-button cyber-button--secondary" type="button" :disabled="mutationBlocked" :title="blockedReason" @click="emit('chooseWorkspace')">
                  更换目录
                </button>
                <button class="cyber-button cyber-button--ghost" type="button" @click="emit('openWorkspace')">
                  打开文件夹
                </button>
              </div>
            </section>

            <section class="config-block">
              <div class="config-block__head">
                <div>
                  <span class="eyebrow">PACKAGE UPLINK</span>
                  <h3>npm 安装</h3>
                </div>
                <span class="status-chip" :class="npmBusy ? 'status-chip--yellow' : 'status-chip--cyan'">
                  {{ npmBusy ? 'TRANSMITTING' : 'READY' }}
                </span>
              </div>
              <p class="config-hint">
                {{ packageState?.npmRuntime.command || 'npm' }} ·
                {{ packageState?.npmRuntime.source || 'PATH' }} · 沿用当前 .npmrc
              </p>
              <label class="field-stack">
                <span>PACKAGE SPEC // 空格或换行分隔</span>
                <textarea
                  ref="packageField"
                  :value="packageInput"
                  rows="3"
                  spellcheck="false"
                  placeholder="lodash dayjs"
                  @input="emit('update:packageInput', ($event.target as HTMLTextAreaElement).value)"
                  @keydown="onInputKeydown"
                />
              </label>
              <div class="install-row">
                <label class="cyber-check">
                  <input
                    type="checkbox"
                    :checked="devDependency"
                    :disabled="mutationBlocked"
                    @change="emit('update:devDependency', ($event.target as HTMLInputElement).checked)"
                  />
                  <span aria-hidden="true" />
                  DEV DEPENDENCY
                </label>
                <div class="button-cluster button-cluster--right">
                  <button class="cyber-button cyber-button--ghost" type="button" :disabled="mutationBlocked" :title="blockedReason" @click="emit('sync')">
                    同步
                  </button>
                  <button
                    v-if="!npmBusy"
                    class="cyber-button cyber-button--primary"
                    type="button"
                    :disabled="installBlocked"
                    :title="blockedReason || (!packageInput.trim() ? '先输入要安装的包名' : '')"
                    @click="emit('install')"
                  >
                    npm install
                  </button>
                  <button v-else class="cyber-button cyber-button--danger" type="button" @click="emit('stop')">
                    中止 npm
                  </button>
                </div>
              </div>
              <div class="npm-status-line"><i aria-hidden="true" />{{ npmStatus }}</div>
              <p v-if="blockedReason" class="npm-blocked-reason" role="status">{{ blockedReason }}</p>
              <details v-if="npmLog" class="npm-inline-log">
                <summary>查看 npm 输出</summary>
                <pre>{{ npmLog }}</pre>
              </details>
            </section>

            <section class="config-block config-block--packages">
              <div class="config-block__head">
                <div>
                  <span class="eyebrow">DIRECT DEPENDENCIES</span>
                  <h3>已声明包</h3>
                </div>
                <button class="micro-button" type="button" :disabled="mutationBlocked" :title="blockedReason" @click="emit('refresh')">扫描</button>
              </div>

              <div v-if="!packageState?.installed.length" class="package-empty">
                <strong>NO MODULES INDEXED</strong>
                <span>可先安装 lodash dayjs</span>
              </div>
              <div v-else class="package-list">
                <article v-for="item in packageState.installed" :key="item.name" class="package-row">
                  <span class="package-dot" :class="{ 'package-dot--missing': !item.installed }" aria-hidden="true" />
                  <div class="package-copy">
                    <strong>{{ item.name }}</strong>
                    <span>
                      {{ item.installedVersion || item.declaredVersion || 'unknown' }} ·
                      {{ item.dev ? 'devDependency' : 'dependency' }}
                      <template v-if="item.license"> · {{ item.license }}</template>
                    </span>
                  </div>
                  <button class="micro-button micro-button--danger" type="button" :disabled="mutationBlocked" :title="blockedReason" @click="emit('uninstall', item.name)">
                    移除
                  </button>
                </article>
              </div>
            </section>
          </div>

          <footer class="dialog-foot">
            <span>CTRL/CMD + ENTER // INSTALL</span>
            <button class="cyber-button cyber-button--secondary" type="button" @click="emit('close')">完成</button>
          </footer>
        </section>
      </div>
    </Transition>
  </Teleport>
</template>

<style scoped>
.npm-blocked-reason{margin:10px 0 0;color:var(--cyber-yellow);font-size:12px;line-height:1.6}
.npm-inline-log{margin-top:12px;border:1px solid #35414d;padding:9px 12px;color:#a7bac7;font-size:12px}
.npm-inline-log summary{cursor:pointer;list-style:revert}
.npm-inline-log pre{margin:10px 0 0;max-height:180px;overflow:auto;white-space:pre-wrap;overflow-wrap:anywhere;font-size:11px;line-height:1.6;color:#d4e2eb}
.npm-inline-log summary:focus-visible{outline:2px solid var(--cyber-yellow);outline-offset:3px}
</style>
