<script setup lang="ts">
import {
  computed,
  nextTick,
  onBeforeUnmount,
  onMounted,
  ref,
  watch
} from 'vue'
import type {
  AppCommand,
  NpmAction,
  OutputStream,
  PackageState,
  RunExitPayload,
  RunMode,
  RunTrigger,
  ScriptLanguage,
  ToastMessage,
  TypeDefinitionFile
} from '@shared/types'
import ConfirmDialog from './components/ConfirmDialog.vue'
import MonacoEditor from './components/MonacoEditor.vue'
import OutputConsole from './components/OutputConsole.vue'
import PackageDialog from './components/PackageDialog.vue'
import ToastStack from './components/ToastStack.vue'
import { readBooleanStorage, readStorage, writeStorage } from './composables/storage'
import { useOutputBuffer } from './composables/useOutputBuffer'
import { useResizableSplit } from './composables/useResizableSplit'
import { DEFAULT_JAVASCRIPT, DEFAULT_TYPESCRIPT } from './defaults'
import type { LanguageServiceProbeResult } from './monaco'

const api = window.offlineJsLab
const AUTO_RUN_DELAY_MS = 500

const storedLanguage = readStorage('offlineJsLab.language', 'typescript')
const language = ref<ScriptLanguage>(storedLanguage === 'javascript' ? 'javascript' : 'typescript')
const runMode = ref<RunMode>(
  readStorage('offlineJsLab.runMode', 'manual') === 'live' ? 'live' : 'manual'
)
const clearOutputOnRun = ref(
  readBooleanStorage('offlineJsLab.clearOutputOnRun', true)
)
const fallbackCode = language.value === 'typescript' ? DEFAULT_TYPESCRIPT : DEFAULT_JAVASCRIPT
const code = ref(readStorage('offlineJsLab.code', fallbackCode))
const filePath = ref<string | null>(null)
const dirty = ref(false)

const editorRef = ref<InstanceType<typeof MonacoEditor>>()
const splitHost = ref<HTMLElement>()
const editorReady = ref(false)
const languageServiceMessage = ref('LANGUAGE SERVICE LINKING')
const typeIndexMessage = ref('TYPE INDEX PENDING')
const editorMessage = computed(() => `${languageServiceMessage.value} // ${typeIndexMessage.value}`)
const typeDefinitions = ref<TypeDefinitionFile[]>([])

const packageState = ref<PackageState | null>(null)
const packageDialogVisible = ref(false)
const packageInput = ref('')
const devDependency = ref(false)
const npmBusy = ref(false)
const npmStatus = ref('NPM LINK IDLE')

const appVersion = ref('—')
const platform = ref('—')
const nodeRuntime = ref('NODE —')
const currentTime = ref('00:00:00')

const runId = ref<string | null>(null)
const runStarting = ref(false)
const completedRuns = new Map<string, RunExitPayload>()
const pendingAutoRun = ref(false)
const autoStopRequested = ref(false)
let autoRunTimer: number | null = null

const runStatusLabel = ref('IDLE')
const runStatusKind = ref('idle')

const bootVisible = ref(true)
const bootProgress = ref(12)
const bootMessage = ref('NEURAL LINK // INITIALIZING')
const bootError = ref('')
let bootstrapReady = false
let bootHideTimer: number | null = null
let clockTimer: number | null = null
let lastLanguageServiceFailure = ''

const toasts = ref<ToastMessage[]>([])
let nextToastId = 1
const toastTimers = new Map<number, number>()

const confirmState = ref({
  visible: false,
  title: '',
  message: '',
  confirmLabel: '确认',
  danger: false
})
let confirmResolver: ((value: boolean) => void) | null = null

const {
  chunks: outputChunks,
  revision: outputRevision,
  append: appendOutput,
  clear: clearOutput
} = useOutputBuffer()

const { ratio, dragging, gridTemplateColumns, beginResize, reset, onSplitterKeydown } =
  useResizableSplit(splitHost, () => editorRef.value?.layout())

const fileName = computed(() => {
  if (!filePath.value) return language.value === 'typescript' ? 'untitled.ts' : 'untitled.js'
  return filePath.value.split(/[\\/]/).filter(Boolean).pop() || filePath.value
})

const running = computed(() => Boolean(runId.value || runStarting.value))
const fileActionsBlocked = computed(() => running.value || npmBusy.value)
const runDisabled = computed(() => !editorReady.value || running.value || npmBusy.value)
const workspaceLabel = computed(() => packageState.value?.workspacePath || 'WORKSPACE OFFLINE')
const runShortcut = computed(() => (platform.value === 'darwin' ? '⌘↵' : 'CTRL↵'))
const modeLabel = computed(() => (runMode.value === 'live' ? 'LIVE LINK' : 'MANUAL LINK'))

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function showToast(message: string, type: ToastMessage['type'] = 'info'): void {
  const id = nextToastId++
  toasts.value.push({ id, message, type })
  const timer = window.setTimeout(() => {
    toasts.value = toasts.value.filter((item) => item.id !== id)
    toastTimers.delete(id)
  }, 3600)
  toastTimers.set(id, timer)
}

function requestConfirm(options: {
  title: string
  message: string
  confirmLabel?: string
  danger?: boolean
}): Promise<boolean> {
  confirmResolver?.(false)
  confirmState.value = {
    visible: true,
    title: options.title,
    message: options.message,
    confirmLabel: options.confirmLabel ?? '确认',
    danger: options.danger ?? false
  }
  return new Promise((resolve) => {
    confirmResolver = resolve
  })
}

function settleConfirm(value: boolean): void {
  confirmState.value.visible = false
  const resolve = confirmResolver
  confirmResolver = null
  resolve?.(value)
}

function setRunStatus(label: string, kind = 'idle'): void {
  runStatusLabel.value = label
  runStatusKind.value = kind
}

function dividerLabel(trigger: RunTrigger): string {
  const time = new Date().toLocaleTimeString('zh-CN', { hour12: false })
  return `\n╞══ ${trigger === 'auto' ? 'LIVE EXECUTION' : 'MANUAL EXECUTION'} // ${time} ══╡\n`
}

function cancelAutoRun(): void {
  if (autoRunTimer !== null) {
    window.clearTimeout(autoRunTimer)
    autoRunTimer = null
  }
  pendingAutoRun.value = false
  autoStopRequested.value = false
}

function scheduleAutoRun(delayMs = AUTO_RUN_DELAY_MS): void {
  if (runMode.value !== 'live') return
  pendingAutoRun.value = true
  if (autoRunTimer !== null) window.clearTimeout(autoRunTimer)
  autoRunTimer = window.setTimeout(() => {
    autoRunTimer = null
    flushAutoRun()
  }, delayMs)
}

function flushAutoRun(): void {
  if (!pendingAutoRun.value || runMode.value !== 'live' || npmBusy.value || !editorReady.value) {
    return
  }
  if (runStarting.value) return

  if (runId.value) {
    if (!autoStopRequested.value) {
      autoStopRequested.value = true
      void api.stopRun(runId.value).catch((error: unknown) => {
        autoStopRequested.value = false
        appendOutput(`自动停止旧进程失败：${formatError(error)}\n`, 'stderr')
      })
    }
    return
  }

  autoStopRequested.value = false
  pendingAutoRun.value = false
  void runCode('auto')
}

function formatDuration(durationMs: number): string {
  if (!Number.isFinite(durationMs)) return ''
  return durationMs < 1000
    ? `${Math.max(0, Math.round(durationMs))} MS`
    : `${(durationMs / 1000).toFixed(durationMs < 10_000 ? 2 : 1)} S`
}

function applyRunExit(payload: RunExitPayload): void {
  const duration = formatDuration(payload.durationMs)
  if (payload.reason === 'completed' && payload.code === 0) {
    setRunStatus(duration ? `COMPLETE // ${duration}` : 'COMPLETE', 'success')
  } else if (payload.reason === 'stopped') {
    setRunStatus('ABORTED', 'stopped')
  } else if (payload.reason === 'output-limit') {
    setRunStatus('BUFFER LIMIT', 'error')
  } else {
    const codeText = payload.code === null ? '' : ` // CODE ${payload.code}`
    setRunStatus(`FAILED${codeText}`, 'error')
  }
}

async function runCode(trigger: RunTrigger = 'manual'): Promise<void> {
  if (!editorReady.value || runId.value || runStarting.value || npmBusy.value) return

  if (trigger === 'manual') {
    if (autoRunTimer !== null) {
      window.clearTimeout(autoRunTimer)
      autoRunTimer = null
    }
    pendingAutoRun.value = false
  }

  if (clearOutputOnRun.value) clearOutput()
  runStarting.value = true
  setRunStatus('COMPILING', 'running')
  appendOutput(dividerLabel(trigger), 'system')

  try {
    const result = await api.runCode({
      code: code.value,
      language: language.value,
      sourceFilePath: filePath.value
    })
    runStarting.value = false

    if (!result.ok) {
      appendOutput(`${result.error}\n`, 'stderr')
      setRunStatus('COMPILE ERROR', 'error')
      flushAutoRun()
      return
    }

    const earlyExit = completedRuns.get(result.runId)
    if (earlyExit) {
      completedRuns.delete(result.runId)
      runId.value = null
      applyRunExit(earlyExit)
    } else {
      runId.value = result.runId
      setRunStatus('PROCESS ACTIVE', 'running')
    }
    flushAutoRun()
  } catch (error) {
    runStarting.value = false
    appendOutput(`启动失败：${formatError(error)}\n`, 'stderr')
    setRunStatus('LINK FAILURE', 'error')
    flushAutoRun()
  }
}

async function stopRun(preserveAutoRun = false): Promise<void> {
  if (!runId.value) return
  if (!preserveAutoRun) cancelAutoRun()

  try {
    const stopped = await api.stopRun(runId.value)
    if (!stopped) appendOutput('执行进程已经结束。\n', 'muted')
  } catch (error) {
    appendOutput(`停止失败：${formatError(error)}\n`, 'stderr')
  }
}

function handleRunExit(payload: RunExitPayload): void {
  if (payload.runId === runId.value) {
    runId.value = null
    autoStopRequested.value = false
    applyRunExit(payload)
    window.setTimeout(flushAutoRun, 0)
    return
  }

  if (runStarting.value) completedRuns.set(payload.runId, payload)
}

async function canDiscardChanges(): Promise<boolean> {
  if (!dirty.value) return true
  return requestConfirm({
    title: '放弃未保存修改？',
    message: '当前脚本尚未保存。继续操作会丢失这些修改。',
    confirmLabel: '放弃修改',
    danger: true
  })
}

async function newFile(): Promise<void> {
  if (!(await canDiscardChanges())) return
  filePath.value = null
  code.value = language.value === 'typescript' ? DEFAULT_TYPESCRIPT : DEFAULT_JAVASCRIPT
  dirty.value = false
  await nextTick()
  editorRef.value?.focus()
  scheduleAutoRun(80)
}

async function openFile(): Promise<void> {
  if (!(await canDiscardChanges())) return
  try {
    const result = await api.openFile()
    if (!result) return
    filePath.value = result.filePath
    language.value = result.language
    code.value = result.content
    dirty.value = false
    await nextTick()
    editorRef.value?.focus()
    scheduleAutoRun(80)
  } catch (error) {
    showToast(`打开失败：${formatError(error)}`, 'error')
  }
}

async function saveFile(saveAs = false): Promise<void> {
  if (!editorReady.value) return
  try {
    const result = await api.saveFile({
      filePath: filePath.value,
      content: code.value,
      language: language.value,
      saveAs
    })
    if (!result) return
    filePath.value = result.filePath
    language.value = result.language
    dirty.value = false
    showToast('脚本已保存', 'success')
  } catch (error) {
    showToast(`保存失败：${formatError(error)}`, 'error')
  }
}

async function refreshTypeDefinitions(): Promise<void> {
  typeIndexMessage.value = 'INDEXING PACKAGE TYPES'
  try {
    const result = await api.getTypeDefinitions()
    typeDefinitions.value = result.files
    typeIndexMessage.value = `${result.files.length} TYPE FILES // ${Math.round(result.totalBytes / 1024)} KB`
    if (result.truncated) showToast('类型定义超过扫描上限，只加载了部分文件', 'info')
  } catch (error) {
    typeIndexMessage.value = 'TYPE INDEX FAILED'
    showToast(`加载类型定义失败：${formatError(error)}`, 'error')
  }
}

async function refreshPackageState(): Promise<void> {
  try {
    packageState.value = await api.listPackages()
  } catch (error) {
    showToast(`读取包状态失败：${formatError(error)}`, 'error')
  }
}

async function chooseWorkspace(): Promise<void> {
  if (running.value || npmBusy.value) return
  try {
    const result = await api.chooseWorkspace()
    if (!result) return
    packageState.value = result
    await refreshTypeDefinitions()
    appendOutput(`\n[WORKSPACE] ${result.workspacePath}\n`, 'system')
    showToast('工作区链路已切换', 'success')
    scheduleAutoRun(80)
  } catch (error) {
    showToast(`切换工作区失败：${formatError(error)}`, 'error')
  }
}

async function openWorkspace(): Promise<void> {
  try {
    const errorMessage = await api.openWorkspace()
    if (errorMessage) throw new Error(errorMessage)
  } catch (error) {
    showToast(`打开工作区失败：${formatError(error)}`, 'error')
  }
}

async function performNpmOperation(
  action: NpmAction,
  payload: { specs?: string; dev?: boolean; names?: string[] },
  label: string
): Promise<void> {
  if (npmBusy.value || running.value) return
  npmBusy.value = true
  npmStatus.value = `${label.toUpperCase()} // ACTIVE`
  appendOutput(`\n╞══ ${label.toUpperCase()} ══╡\n`, 'package')

  try {
    const result = action === 'install'
      ? await api.installPackages({ specs: payload.specs ?? '', dev: Boolean(payload.dev) })
      : action === 'sync'
        ? await api.syncPackages()
        : await api.uninstallPackages({ names: payload.names ?? [] })

    packageState.value = result.packages
    await refreshTypeDefinitions()
    if (!result.ok) throw new Error(`npm 退出码 ${result.code ?? '未知'}`)

    npmStatus.value = `${label.toUpperCase()} // COMPLETE`
    showToast(`${label}完成`, 'success')
    if (action === 'install') packageInput.value = ''
    scheduleAutoRun(80)
  } catch (error) {
    npmStatus.value = `${label.toUpperCase()} // FAILED`
    appendOutput(`[npm 失败] ${formatError(error)}\n`, 'stderr')
    showToast(`${label}失败：${formatError(error)}`, 'error')
    await refreshPackageState()
  } finally {
    npmBusy.value = false
  }
}

async function installPackages(): Promise<void> {
  const specs = packageInput.value.trim()
  if (!specs) {
    showToast('请输入包名，例如 lodash dayjs', 'error')
    return
  }
  await performNpmOperation('install', { specs, dev: devDependency.value }, '安装 npm 包')
}

async function uninstallPackage(name: string): Promise<void> {
  const confirmed = await requestConfirm({
    title: `卸载 ${name}？`,
    message: '该包会从当前工作区 package.json 与 node_modules 中移除。',
    confirmLabel: '卸载',
    danger: true
  })
  if (confirmed) await performNpmOperation('uninstall', { names: [name] }, `卸载 ${name}`)
}

async function stopPackageOperation(): Promise<void> {
  try {
    const stopped = await api.stopPackageOperation()
    if (stopped) npmStatus.value = 'NPM LINK // ABORTING'
  } catch (error) {
    showToast(`停止 npm 失败：${formatError(error)}`, 'error')
  }
}

function setRunMode(mode: RunMode): void {
  runMode.value = mode
}

function setLanguage(value: ScriptLanguage): void {
  language.value = value
  scheduleAutoRun()
}

function onEditorChange(): void {
  dirty.value = true
  scheduleAutoRun()
}

function onEditorReady(): void {
  editorReady.value = true
  languageServiceMessage.value = 'EDITOR CORE ONLINE // LS LINKING'
  bootProgress.value = Math.max(bootProgress.value, 68)
  editorRef.value?.focus()
  if (runMode.value === 'live') scheduleAutoRun(80)
  maybeFinishBoot()
}

function onLanguageServiceStatus(result: LanguageServiceProbeResult): void {
  if (result.ok) {
    languageServiceMessage.value = result.message
    lastLanguageServiceFailure = ''
    return
  }

  languageServiceMessage.value = 'LANGUAGE SERVICE DEGRADED'
  if (result.message === lastLanguageServiceFailure) return
  lastLanguageServiceFailure = result.message
  appendOutput(`\n[EDITOR LANGUAGE SERVICE] ${result.message}\n`, 'stderr')
  showToast('Monaco 语言服务加载失败；悬浮说明和格式化可能不可用', 'error')
}

function maybeFinishBoot(): void {
  if (!bootstrapReady || !editorReady.value || bootHideTimer !== null) return
  bootProgress.value = 100
  bootMessage.value = 'SYSTEM READY // LINK STABLE'
  bootHideTimer = window.setTimeout(() => {
    bootVisible.value = false
    bootHideTimer = null
  }, 420)
}

function handleAppCommand(command: AppCommand): void {
  if (command === 'new') void newFile()
  else if (command === 'open') void openFile()
  else if (command === 'save') void saveFile(false)
  else if (command === 'save-as') void saveFile(true)
  else if (command === 'run') void runCode('manual')
  else if (command === 'stop') void stopRun()
}

function onGlobalKeydown(event: KeyboardEvent): void {
  if (!(event.ctrlKey || event.metaKey)) return
  const target = event.target as HTMLElement | null
  const insidePackageInput = packageDialogVisible.value && target?.tagName === 'TEXTAREA'
  if (insidePackageInput) return

  const key = event.key.toLowerCase()
  if (key === 'n') {
    event.preventDefault()
    void newFile()
  } else if (key === 'o') {
    event.preventDefault()
    void openFile()
  } else if (key === 's') {
    event.preventDefault()
    void saveFile(event.shiftKey)
  } else if (event.key === 'Enter') {
    event.preventDefault()
    void runCode('manual')
  } else if (event.key === '.') {
    event.preventDefault()
    void stopRun()
  }
}

function updateClock(): void {
  currentTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false })
}

watch(code, (value) => writeStorage('offlineJsLab.code', value))
watch(language, (value) => writeStorage('offlineJsLab.language', value))
watch(runMode, (value) => {
  writeStorage('offlineJsLab.runMode', value)
  if (value === 'live') scheduleAutoRun(80)
  else cancelAutoRun()
})
watch(clearOutputOnRun, (value) => writeStorage('offlineJsLab.clearOutputOnRun', value))
watch([fileName, dirty], () => {
  document.title = `${dirty.value ? '● ' : ''}${fileName.value} — Offline JS Lab`
})
watch(running, (value) => document.documentElement.classList.toggle('is-running', value))

const unsubscribers: Array<() => void> = []

onMounted(async () => {
  updateClock()
  clockTimer = window.setInterval(updateClock, 1000)
  window.addEventListener('keydown', onGlobalKeydown)

  unsubscribers.push(
    api.onRunOutput(({ text, stream }) => appendOutput(text, stream as OutputStream)),
    api.onRunExit(handleRunExit),
    api.onPackageOutput(({ text, stream }) => {
      appendOutput(text, stream === 'stderr' ? 'stderr' : 'package')
    }),
    api.onAppCommand(handleAppCommand)
  )

  try {
    bootMessage.value = 'HOST RUNTIME // NEGOTIATING'
    bootProgress.value = 34
    const bootstrap = await api.getBootstrap()
    appVersion.value = bootstrap.appVersion
    platform.value = bootstrap.platform
    document.documentElement.dataset.platform = bootstrap.platform
    nodeRuntime.value = `NODE ${bootstrap.nodeRuntime.command}`
    packageState.value = bootstrap.packages
    bootMessage.value = 'TYPE MATRIX // INDEXING'
    bootProgress.value = 76
    await refreshTypeDefinitions()
    bootstrapReady = true
    maybeFinishBoot()
  } catch (error) {
    bootError.value = formatError(error)
    bootMessage.value = 'BOOT SEQUENCE FAILED'
    bootProgress.value = 100
    appendOutput(`初始化失败：${formatError(error)}\n`, 'stderr')
    setRunStatus('BOOT ERROR', 'error')
    showToast('应用初始化失败，请查看输出区', 'error')
    window.setTimeout(() => {
      bootVisible.value = false
    }, 900)
  }
})

onBeforeUnmount(() => {
  cancelAutoRun()
  if (clockTimer !== null) window.clearInterval(clockTimer)
  if (bootHideTimer !== null) window.clearTimeout(bootHideTimer)
  for (const timer of toastTimers.values()) window.clearTimeout(timer)
  for (const unsubscribe of unsubscribers) unsubscribe()
  window.removeEventListener('keydown', onGlobalKeydown)
  confirmResolver?.(false)
})
</script>

<template>
  <div class="app-shell" :class="{ 'app-shell--resizing': dragging }">
    <div class="ambient-grid" aria-hidden="true" />
    <div class="scanline-layer" aria-hidden="true" />

    <header class="command-bar">
      <div class="drag-zone" aria-hidden="true" />
      <div class="brand-lockup">
        <div class="brand-sigil" aria-hidden="true">
          <span>JS</span><i>77</i>
        </div>
        <div class="brand-copy">
          <span class="brand-kicker">LOCAL CYBERDECK // V{{ appVersion }}</span>
          <h1 data-text="OFFLINE JS LAB">OFFLINE JS LAB</h1>
        </div>
      </div>

      <nav class="file-actions" aria-label="文件操作">
        <button class="toolbar-button" type="button" :disabled="fileActionsBlocked" title="新建 Cmd/Ctrl+N" @click="newFile">
          <span class="toolbar-button__glyph">＋</span><b>NEW</b>
        </button>
        <button class="toolbar-button" type="button" :disabled="fileActionsBlocked" title="打开 Cmd/Ctrl+O" @click="openFile">
          <span class="toolbar-button__glyph">↗</span><b>OPEN</b>
        </button>
        <button class="toolbar-button" type="button" title="保存 Cmd/Ctrl+S" @click="saveFile(false)">
          <span class="toolbar-button__glyph">◇</span><b>SAVE</b>
        </button>
        <button class="toolbar-button toolbar-button--compact" type="button" title="另存为 Cmd/Ctrl+Shift+S" @click="saveFile(true)">
          <span class="toolbar-button__glyph">⇩</span><b>SAVE AS</b>
        </button>
      </nav>

      <div class="command-controls">
        <label class="select-module">
          <span>LANG</span>
          <select :value="language" :disabled="fileActionsBlocked" aria-label="脚本语言" @change="setLanguage(($event.target as HTMLSelectElement).value as ScriptLanguage)">
            <option value="typescript">TYPE·SCRIPT</option>
            <option value="javascript">JAVA·SCRIPT</option>
          </select>
        </label>

        <div class="mode-switch" aria-label="运行模式">
          <button type="button" :class="{ active: runMode === 'manual' }" @click="setRunMode('manual')">MANUAL</button>
          <button type="button" :class="{ active: runMode === 'live' }" @click="setRunMode('live')">
            <i aria-hidden="true" />LIVE
          </button>
        </div>

        <button class="execute-button" :class="{ 'execute-button--active': running }" type="button" :disabled="runDisabled" @click="runCode('manual')">
          <span class="execute-button__edge" aria-hidden="true" />
          <span class="execute-button__copy"><b>EXECUTE</b><small>{{ runShortcut }}</small></span>
        </button>
        <button class="abort-button" type="button" :disabled="!runId" title="停止 Cmd/Ctrl+." @click="stopRun()">
          ABORT
        </button>
        <button class="matrix-button" type="button" title="包与工作区" @click="packageDialogVisible = true">
          <span aria-hidden="true">⌬</span><b>MATRIX</b>
        </button>
      </div>
    </header>

    <main ref="splitHost" class="split-deck" :style="{ gridTemplateColumns }">
      <section class="hud-panel editor-panel" aria-label="代码编辑器">
        <div class="panel-corner panel-corner--top" aria-hidden="true" />
        <header class="pane-head editor-head">
          <div class="pane-ident">
            <span class="pane-index">01</span>
            <div class="file-ident">
              <strong :title="filePath || '尚未保存到文件'">{{ fileName }}</strong>
              <span v-if="dirty" class="dirty-tag">MODIFIED</span>
              <small>{{ filePath || 'VOLATILE MEMORY // UNSAVED BUFFER' }}</small>
            </div>
          </div>
          <div class="editor-telemetry">
            <span>{{ language === 'typescript' ? 'TS' : 'JS' }} CORE</span>
            <i aria-hidden="true" />
            <span>{{ editorMessage }}</span>
          </div>
        </header>
        <div class="editor-shell">
          <div class="editor-rail" aria-hidden="true"><span>CODE</span><i /><i /><i /></div>
          <MonacoEditor
            ref="editorRef"
            v-model="code"
            :language="language"
            :type-definitions="typeDefinitions"
            :read-only="npmBusy"
            @change="onEditorChange"
            @ready="onEditorReady"
            @language-service="onLanguageServiceStatus"
            @run="runCode('manual')"
            @save="saveFile(false)"
            @open="openFile"
          />
        </div>
        <div class="panel-corner panel-corner--bottom" aria-hidden="true" />
      </section>

      <div
        class="deck-splitter"
        :class="{ 'deck-splitter--active': dragging }"
        role="separator"
        aria-label="调整代码与输出区域宽度"
        aria-orientation="vertical"
        aria-valuemin="15"
        aria-valuemax="85"
        :aria-valuenow="Math.round(ratio * 100)"
        tabindex="0"
        title="拖动调整宽度；双击恢复 50:50"
        @pointerdown="beginResize"
        @dblclick="reset"
        @keydown="onSplitterKeydown"
      >
        <span class="splitter-pulse" aria-hidden="true" />
        <span class="splitter-grip" aria-hidden="true"><i /><i /><i /></span>
      </div>

      <OutputConsole
        :chunks="outputChunks"
        :revision="outputRevision"
        :status-label="runStatusLabel"
        :status-kind="runStatusKind"
        :clear-on-run="clearOutputOnRun"
        @update:clear-on-run="clearOutputOnRun = $event"
        @clear="clearOutput"
      />
    </main>

    <footer class="telemetry-bar">
      <div class="telemetry-segment telemetry-segment--wide" :title="workspaceLabel">
        <i class="telemetry-dot" aria-hidden="true" />
        <span>WORKSPACE</span><b>{{ workspaceLabel }}</b>
      </div>
      <div class="telemetry-segment"><span>RUN MODE</span><b>{{ modeLabel }}</b></div>
      <div class="telemetry-segment"><span>RUNTIME</span><b :title="nodeRuntime">{{ nodeRuntime }}</b></div>
      <div class="telemetry-segment"><span>HOST</span><b>{{ platform.toUpperCase() }}</b></div>
      <div class="telemetry-clock"><span>{{ currentTime }}</span><i>LOCAL</i></div>
    </footer>

    <PackageDialog
      :visible="packageDialogVisible"
      :package-state="packageState"
      :npm-busy="npmBusy"
      :npm-status="npmStatus"
      :package-input="packageInput"
      :dev-dependency="devDependency"
      @close="packageDialogVisible = false"
      @choose-workspace="chooseWorkspace"
      @open-workspace="openWorkspace"
      @refresh="refreshPackageState"
      @install="installPackages"
      @sync="performNpmOperation('sync', {}, '同步 npm 依赖')"
      @stop="stopPackageOperation"
      @uninstall="uninstallPackage"
      @update:package-input="packageInput = $event"
      @update:dev-dependency="devDependency = $event"
    />

    <ConfirmDialog
      :visible="confirmState.visible"
      :title="confirmState.title"
      :message="confirmState.message"
      :confirm-label="confirmState.confirmLabel"
      :danger="confirmState.danger"
      @confirm="settleConfirm(true)"
      @cancel="settleConfirm(false)"
    />

    <ToastStack :toasts="toasts" />

    <Transition name="boot-fade">
      <div v-if="bootVisible" class="boot-screen" role="status" aria-live="polite">
        <div class="boot-scan" aria-hidden="true" />
        <div class="boot-frame">
          <div class="boot-code">OSJL::CYBERDECK / BUILD {{ appVersion }}</div>
          <div class="boot-logo" data-text="OFFLINE JS LAB">OFFLINE JS LAB</div>
          <p>{{ bootMessage }}</p>
          <div class="boot-progress" :class="{ 'boot-progress--error': bootError }">
            <span :style="{ width: `${bootProgress}%` }" />
          </div>
          <div class="boot-readout"><span>{{ String(bootProgress).padStart(3, '0') }}%</span><b>{{ bootError || 'SECURE LOCAL SESSION' }}</b></div>
        </div>
      </div>
    </Transition>
  </div>
</template>
