<script setup lang="ts">
import { onBeforeUnmount, onMounted } from 'vue'
import type { PackageState } from '@shared/types'

const props = defineProps<{
  visible: boolean
  packageState: PackageState | null
  npmBusy: boolean
  npmStatus: string
  packageInput: string
  devDependency: boolean
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

function onKeydown(event: KeyboardEvent): void {
  if (event.key === 'Escape' && props.visible) emit('close')
}

function onInputKeydown(event: KeyboardEvent): void {
  if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') {
    event.preventDefault()
    emit('install')
  }
}

onMounted(() => window.addEventListener('keydown', onKeydown))
onBeforeUnmount(() => window.removeEventListener('keydown', onKeydown))
</script>

<template>
  <Teleport to="body">
    <Transition name="hud-dialog">
      <div v-if="visible" class="dialog-backdrop" role="presentation" @mousedown.self="emit('close')">
        <section class="cyber-dialog package-dialog" role="dialog" aria-modal="true" aria-labelledby="package-dialog-title">
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
                <button class="cyber-button cyber-button--secondary" type="button" :disabled="npmBusy" @click="emit('chooseWorkspace')">
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
                  :value="packageInput"
                  rows="3"
                  spellcheck="false"
                  placeholder="lodash dayjs"
                  :disabled="npmBusy"
                  @input="emit('update:packageInput', ($event.target as HTMLTextAreaElement).value)"
                  @keydown="onInputKeydown"
                />
              </label>
              <div class="install-row">
                <label class="cyber-check">
                  <input
                    type="checkbox"
                    :checked="devDependency"
                    :disabled="npmBusy"
                    @change="emit('update:devDependency', ($event.target as HTMLInputElement).checked)"
                  />
                  <span aria-hidden="true" />
                  DEV DEPENDENCY
                </label>
                <div class="button-cluster button-cluster--right">
                  <button class="cyber-button cyber-button--ghost" type="button" :disabled="npmBusy" @click="emit('sync')">
                    同步
                  </button>
                  <button
                    v-if="!npmBusy"
                    class="cyber-button cyber-button--primary"
                    type="button"
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
            </section>

            <section class="config-block config-block--packages">
              <div class="config-block__head">
                <div>
                  <span class="eyebrow">DIRECT DEPENDENCIES</span>
                  <h3>已声明包</h3>
                </div>
                <button class="micro-button" type="button" :disabled="npmBusy" @click="emit('refresh')">SCAN</button>
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
                  <button class="micro-button micro-button--danger" type="button" :disabled="npmBusy" @click="emit('uninstall', item.name)">
                    REMOVE
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
