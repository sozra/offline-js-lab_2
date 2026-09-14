<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import type { AppCommand, LabDocument, NpmAction, OutputStream, PackageState, PreviewBounds, PreviewState, RunExitPayload, RunMode, RunOutputPayload, RunSnapshot, RunTrigger, ScriptInput, ScriptLanguage, SourceLocation, ToastMessage, TypeDefinitionFile } from '@shared/types'
import { isBrowserLanguage, isScriptLanguage, languageExtension } from '@shared/languages'
import { EMPTY_INPUT } from '@shared/input'
import ConfirmDialog from './components/ConfirmDialog.vue'
import CyberSelect from './components/CyberSelect.vue'
import MonacoEditor from './components/MonacoEditor.vue'
import OutputConsole from './components/OutputConsole.vue'
import PackageDialog from './components/PackageDialog.vue'
import PreviewPane from './components/PreviewPane.vue'
import LibraryDialog from './components/LibraryDialog.vue'
import InputPanel from './components/InputPanel.vue'
import RunCompareDialog from './components/RunCompareDialog.vue'
import ToastStack from './components/ToastStack.vue'
import { readBooleanStorage, readStorage, writeStorage } from './composables/storage'
import { readDocumentSession, writeDocumentSession } from './composables/useDocumentSession'
import { useRunHistory } from './composables/useRunHistory'
import { isEntrySourceLocation } from './composables/sourceLocation'
import { useOutputBuffer } from './composables/useOutputBuffer'
import { useResizableSplit } from './composables/useResizableSplit'
import { useAlignedPaneLayout } from './composables/useAlignedPaneLayout'
import type { SourceViewport } from './editorLayout'
import { DEFAULT_JAVASCRIPT, DEFAULT_TYPESCRIPT } from './defaults'
import type { LanguageServiceProbeResult } from './monaco'
import { hasReactJsxRuntimeTypes } from './jsxTypeSupport'

const api = window.offlineJsLab
const AUTO_RUN_DELAY_MS = 500
const storedLanguage = readStorage('offlineJsLab.language', 'typescript')
const initialLanguage = isScriptLanguage(storedLanguage) ? storedLanguage : 'typescript'
const restored = readDocumentSession({ code: isBrowserLanguage(initialLanguage) ? 'export default function App() {\n  return <h1>Hello, React!</h1>\n}\n' : initialLanguage === 'javascript' ? DEFAULT_JAVASCRIPT : DEFAULT_TYPESCRIPT, language: initialLanguage, input: { ...EMPTY_INPUT } })
const code = ref(restored.code)
const language = ref<ScriptLanguage>(restored.language)
const input = ref<ScriptInput>({ ...restored.input })
const filePath = ref<string | null>(restored.filePath)
const lastSavedCode = ref<string | null>(restored.lastSavedCode ?? (restored.dirty ? null : restored.code))
const dirty = computed(() => lastSavedCode.value === null ? Boolean(filePath.value) || code.value.length > 0 : code.value !== lastSavedCode.value)
const currentDocument = computed<LabDocument>(() => ({ code: code.value, language: language.value, input: { ...input.value } }))
const documentRevision = ref(0)
let documentEpoch = 0
let sessionWarningShown = false
const inputCollapsed = ref(readBooleanStorage('offlineJsLab.inputCollapsed', true))
const runMode = ref<RunMode>(readStorage('offlineJsLab.runMode', 'manual') === 'live' ? 'live' : 'manual')
const clearOutputOnRun = ref(readBooleanStorage('offlineJsLab.clearOutputOnRun', true))
const alignOutputToSource = ref(readBooleanStorage('offlineJsLab.alignOutputToSource', false))
const editorRef = ref<InstanceType<typeof MonacoEditor>>()
const splitHost = ref<HTMLElement>()
const editorReady = ref(false)
const editorScrollTop = ref(0)
const editorViewport = ref<SourceViewport>()
const languageServiceMessage = ref('LANGUAGE SERVICE LINKING')
const typeIndexMessage = ref('TYPE INDEX PENDING')
const editorMessage = computed(() => `${languageServiceMessage.value} // ${typeIndexMessage.value}`)
const typeDefinitions = ref<TypeDefinitionFile[]>([])
const packageState = ref<PackageState | null>(null)
const packageDialogVisible = ref(false)
const libraryVisible = ref(false)
const compareVisible = ref(false)
const nativeDialogBusy = ref(false)
const languageMenuOpen = ref(false)
const fileMenuOpen = ref(false)
const fileMenu = ref<HTMLDetailsElement>()
const recentFiles = ref<string[]>([])
const packageInput = ref('')
const devDependency = ref(false)
const npmBusy = ref(false)
const npmStatus = ref('NPM LINK IDLE')
const npmLog = ref('')
const appVersion = ref('—')
const platform = ref('—')
const nodeRuntime = ref('NODE —')
const currentTime = ref('00:00:00')
const runId = ref<string | null>(null)
const runStarting = ref(false)
const nodeStopping = ref(false)
let pendingNodeId: string | null = null
const currentRunId = ref('')
const completedRuns = new Map<string, RunExitPayload>()
const pendingAutoRun = ref(false)
const autoStopRequested = ref(false)
let autoRunTimer: number | null = null
const runStatusLabel = ref('IDLE')
const runStatusKind = ref('idle')
const previewRunId = ref<string | null>(null)
const previewCandidateId = ref<string | null>(null)
const previewStarting = ref(false)
const previewStatus = ref('READY TO RUN')
const previewError = ref('')
const previewDocument = ref<LabDocument | null>(null)
let previewEpoch = 0
const previewStates = new Map<string, PreviewState>()
const resultTab = ref<'preview' | 'console'>(isBrowserLanguage(language.value) ? 'preview' : 'console')
const previewConsole = ref(false)
const browserMode = computed(() => isBrowserLanguage(language.value))
const sourceAlignmentAvailable = computed(() => !browserMode.value || resultTab.value === 'console')
const sourceAlignmentEnabled = computed(() => alignOutputToSource.value && sourceAlignmentAvailable.value)
useAlignedPaneLayout(splitHost, sourceAlignmentEnabled)
const needsReactTypes = computed(() => browserMode.value && !hasReactJsxRuntimeTypes(typeDefinitions.value))
const history = useRunHistory()
const { runs, selectedId, pinned } = history
const selectedSnapshot = computed(() => runs.value.find(run => run.id === (selectedId.value || currentRunId.value)) ?? runs.value[0] ?? null)
const compareRight = ref<RunSnapshot | null>(null)
function sameDocument(document: LabDocument | null): boolean {
  return Boolean(document && document.code === code.value && document.language === language.value && document.input.format === input.value.format && document.input.text === input.value.text)
}
const outputStale = computed(() => Boolean(selectedSnapshot.value && !sameDocument(selectedSnapshot.value)))
const previewStale = computed(() => Boolean(previewDocument.value && !sameDocument(previewDocument.value)))
const needsReact = computed(() => !['react', 'react-dom'].every(name => packageState.value?.installed.some(item => item.name === name && item.installed)))
const glitchBurst = ref<'' | 'run' | 'error' | 'abort'>('')
const glitchSeq = ref(0)
let glitchTimer: number | null = null
const runElapsedMs = ref(0)
let runStartedAt = 0
let runClockTimer: number | null = null
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
const confirmState = ref({ visible: false, title: '', message: '', confirmLabel: '确认', danger: false })
let confirmResolver: ((value: boolean) => void) | null = null
const modalVisible = computed(() => packageDialogVisible.value || libraryVisible.value || compareVisible.value || confirmState.value.visible || bootVisible.value || nativeDialogBusy.value)
const running = computed(() => Boolean(runId.value || runStarting.value))
const fileActionsBlocked = computed(() => !editorReady.value || running.value || npmBusy.value || modalVisible.value)
const saveDisabled = computed(() => !editorReady.value || modalVisible.value)
const runDisabled = computed(() => !editorReady.value || running.value || previewStarting.value || npmBusy.value || modalVisible.value)
const canStop = computed(() => running.value || previewStarting.value || Boolean(previewRunId.value))
const previewVisible = computed(() => browserMode.value && resultTab.value === 'preview' && !modalVisible.value && !languageMenuOpen.value && !fileMenuOpen.value)
const packageBlockedReason = computed(() => running.value ? '脚本正在运行；请关闭此面板并停止脚本后操作依赖。' : '')
let lastPreviewBounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }
const { chunks: outputChunks, revision: outputRevision, append: appendOutput, clear: clearOutput } = useOutputBuffer()
const runBuffers = new Map<string, ReturnType<typeof useOutputBuffer>>()
const pendingHistory = new Set<string>()
let historyFrame = 0
const { ratio, dragging, gridTemplateColumns, beginResize, reset, onSplitterKeydown } = useResizableSplit(splitHost, () => editorRef.value?.layout())
const fileName = computed(() => filePath.value?.split(/[\\/]/).filter(Boolean).pop() || `untitled.${languageExtension(language.value)}`)
const workspaceLabel = computed(() => packageState.value?.workspacePath || 'WORKSPACE OFFLINE')
const runShortcut = computed(() => platform.value === 'darwin' ? '⌘↵' : 'CTRL↵')
const modeLabel = computed(() => runMode.value === 'live' ? 'LIVE LINK' : 'MANUAL LINK')
const editorLineCount = computed(() => code.value.split(/\r\n|\r|\n/).length)
const runStatusDisplay = computed(() => running.value ? `${runStatusLabel.value} // ${formatDuration(runElapsedMs.value)}` : runStatusLabel.value)

function formatError(error: unknown): string { return error instanceof Error ? error.message : String(error) }
function showToast(message: string, type: ToastMessage['type'] = 'info'): void {
  const id = nextToastId++
  toasts.value.push({ id, message, type })
  toastTimers.set(id, window.setTimeout(() => { toasts.value = toasts.value.filter(item => item.id !== id); toastTimers.delete(id) }, 4200))
}
function persistDocument(): void {
  const saved = writeDocumentSession({ ...currentDocument.value, filePath: filePath.value, dirty: dirty.value, lastSavedCode: lastSavedCode.value })
  if (!saved && !sessionWarningShown) { sessionWarningShown = true; showToast('会话恢复未能保存：本地存储可能已满。请保存代码文件或收藏较小的片段。', 'error') }
  if (saved) sessionWarningShown = false
}
function requestConfirm(options: { title: string; message: string; confirmLabel?: string; danger?: boolean }): Promise<boolean> {
  confirmResolver?.(false)
  confirmState.value = { visible: true, title: options.title, message: options.message, confirmLabel: options.confirmLabel ?? '确认', danger: options.danger ?? false }
  return new Promise(resolve => { confirmResolver = resolve })
}
function settleConfirm(value: boolean): void { confirmState.value.visible = false; const resolve = confirmResolver; confirmResolver = null; resolve?.(value) }
function setRunStatus(label: string, kind = 'idle'): void { runStatusLabel.value = label; runStatusKind.value = kind }
function triggerGlitch(kind: 'run' | 'error' | 'abort'): void {
  if (glitchTimer !== null) window.clearTimeout(glitchTimer)
  glitchBurst.value = kind; glitchSeq.value++
  glitchTimer = window.setTimeout(() => { glitchBurst.value = ''; glitchTimer = null }, 400)
}
function formatDuration(duration: number): string { return !Number.isFinite(duration) ? '' : duration < 1000 ? `${Math.max(0, Math.round(duration))} MS` : `${(duration / 1000).toFixed(duration < 10000 ? 2 : 1)} S` }
function snapshotFor(id: string): RunSnapshot | undefined { return runs.value.find(run => run.id === id) }
function flushHistory(): void {
  if (historyFrame) cancelAnimationFrame(historyFrame)
  historyFrame = 0
  for (const id of pendingHistory) { const buffer = runBuffers.get(id); if (buffer) history.update(id, buffer.chunks.value) }
  pendingHistory.clear()
}
function statusFor(id: string, status: string): void { flushHistory(); const run = snapshotFor(id); if (run) history.update(id, run.chunks, status) }
function appendRun(id: string, text: string, stream: OutputStream, sourceLine?: number, extra: { location?: SourceLocation; values?: RunOutputPayload['values'] } = {}): void {
  const snapshot = snapshotFor(id)
  if (!snapshot) return
  if (!isEntrySourceLocation(extra.location, snapshot, workspaceLabel.value, platform.value)) sourceLine = undefined
  const metadata = { runId: id, sourceRevision: snapshot.revision, location: extra.location, values: extra.values }
  appendOutput(text, stream, sourceLine, metadata)
  runBuffers.get(id)?.append(text, stream, sourceLine, metadata)
  pendingHistory.add(id)
  if (!historyFrame) historyFrame = requestAnimationFrame(flushHistory)
}
function beginRun(trigger: RunTrigger): RunSnapshot {
  flushHistory()
  const snapshot: RunSnapshot = { ...currentDocument.value, id: crypto.randomUUID(), revision: documentRevision.value, createdAt: Date.now(), filePath: filePath.value, chunks: [], status: '编译中' }
  currentRunId.value = snapshot.id
  history.begin(snapshot)
  runBuffers.set(snapshot.id, useOutputBuffer())
  for (const id of runBuffers.keys()) if (!runs.value.some(run => run.id === id)) runBuffers.delete(id)
  if (clearOutputOnRun.value) clearOutput()
  appendRun(snapshot.id, `\n╞══ ${trigger === 'auto' ? 'LIVE' : 'MANUAL'} EXECUTION // ${new Date().toLocaleTimeString('zh-CN', { hour12: false })} ══╡\n`, 'system')
  return snapshot
}
function cancelAutoRun(): void {
  if (autoRunTimer !== null) window.clearTimeout(autoRunTimer)
  autoRunTimer = null; pendingAutoRun.value = false; autoStopRequested.value = false
}
function scheduleAutoRun(delay = AUTO_RUN_DELAY_MS): void {
  if (runMode.value !== 'live') return
  pendingAutoRun.value = true
  if (autoRunTimer !== null) window.clearTimeout(autoRunTimer)
  autoRunTimer = window.setTimeout(() => { autoRunTimer = null; flushAutoRun() }, delay)
}
function flushAutoRun(): void {
  if (!pendingAutoRun.value || runMode.value !== 'live' || autoRunTimer !== null || npmBusy.value || modalVisible.value || !editorReady.value || (pendingNodeId && !running.value)) return
  if (running.value) {
    if (!autoStopRequested.value) { autoStopRequested.value = true; void stopRun(true) }
    return
  }
  pendingAutoRun.value = false; autoStopRequested.value = false
  void runCode('auto')
}
function applyRunExit(payload: RunExitPayload): void {
  const success = payload.reason === 'completed' && payload.code === 0
  const label = success ? `完成 · ${formatDuration(payload.durationMs)}` : payload.reason === 'stopped' ? '已停止' : payload.reason === 'output-limit' ? '输出达到上限' : '运行失败'
  statusFor(payload.runId, label)
  if (payload.runId !== currentRunId.value) return
  setRunStatus(label, success ? 'success' : payload.reason === 'stopped' ? 'stopped' : 'error')
  if (!success) triggerGlitch(payload.reason === 'stopped' ? 'abort' : 'error')
}
function handleRunExit(payload: RunExitPayload): void {
  if (pendingNodeId === payload.runId) completedRuns.set(payload.runId, payload)
  if (payload.runId !== runId.value && payload.runId !== pendingNodeId) return
  runId.value = null; runStarting.value = false; nodeStopping.value = false; autoStopRequested.value = false
  applyRunExit(payload)
  runBuffers.delete(payload.runId)
  // The start promise still owns pendingNodeId until it settles.
  if (!pendingNodeId) flushAutoRun()
}
async function runCode(trigger: RunTrigger = 'manual'): Promise<void> {
  if (!editorReady.value || running.value || pendingNodeId || npmBusy.value || modalVisible.value || (trigger === 'manual' && previewStarting.value)) return
  if (new TextEncoder().encode(code.value).length > 2 * 1024 * 1024) { cancelAutoRun(); showToast('代码超过 2 MB，无法创建运行快照或执行。请先缩小代码。', 'error'); return }
  if (trigger === 'manual') cancelAutoRun()
  const snapshot = beginRun(trigger)
  if (isBrowserLanguage(snapshot.language)) { await runPreview(snapshot); return }
  const id = snapshot.id
  runId.value = id; pendingNodeId = id; runStarting.value = true; nodeStopping.value = false
  setRunStatus('COMPILING', 'running')
  try {
    if (previewRunId.value || previewCandidateId.value) await stopPreview()
    const result = await api.runCode({ runId: id, code: snapshot.code, language: snapshot.language, sourceFilePath: snapshot.filePath, input: snapshot.input })
    if (pendingNodeId !== id) return
    if (!result.ok) {
      runId.value = null
      if (!nodeStopping.value) { appendRun(id, `${result.error}\n`, 'stderr', result.location?.line, { location: result.location }); setRunStatus('编译失败', 'error'); statusFor(id, '编译失败'); triggerGlitch('error') }
      else { statusFor(id, '已停止'); setRunStatus('已停止', 'stopped') }
      runBuffers.delete(id)
    } else {
      const early = completedRuns.get(id)
      if (early) { completedRuns.delete(id); runId.value = null; applyRunExit(early) }
      else { runId.value = id; if (!nodeStopping.value) { setRunStatus('PROCESS ACTIVE', 'running'); statusFor(id, '运行中'); triggerGlitch('run') } }
    }
  } catch (error) {
    runId.value = null; appendRun(id, `启动失败：${formatError(error)}\n`, 'stderr'); setRunStatus('启动失败', 'error'); statusFor(id, '启动失败')
    runBuffers.delete(id)
  } finally {
    if (pendingNodeId === id) { pendingNodeId = null; runStarting.value = false; if (!runId.value) nodeStopping.value = false; flushAutoRun() }
  }
}
async function runPreview(snapshot: RunSnapshot): Promise<void> {
  const previousCandidate = previewCandidateId.value
  if (previousCandidate && previousCandidate !== previewRunId.value) { statusFor(previousCandidate, '已被新运行替代'); runBuffers.delete(previousCandidate) }
  const epoch = ++previewEpoch
  previewCandidateId.value = snapshot.id; previewStarting.value = true; previewError.value = ''; previewStatus.value = 'BUILDING'
  setRunStatus('组件编译中', 'running')
  try {
    const result = await api.startPreview({ runId: snapshot.id, code: snapshot.code, language: snapshot.language, sourceFilePath: snapshot.filePath, input: snapshot.input })
    if (epoch !== previewEpoch) return
    if (!result.ok) {
      previewCandidateId.value = null; previewStarting.value = false
      previewError.value = `${result.error}${previewRunId.value ? '\n正在显示上次成功构建的组件。' : ''}`
      previewStatus.value = 'BUILD FAILED'; statusFor(snapshot.id, '编译失败'); setRunStatus('组件编译失败', 'error')
      appendRun(snapshot.id, `${result.error}\n`, 'stderr', result.location?.line, { location: result.location }); triggerGlitch('error')
      flushHistory(); runBuffers.delete(snapshot.id)
    } else {
      const oldId = previewRunId.value
      if (oldId && oldId !== snapshot.id) { flushHistory(); runBuffers.delete(oldId) }
      previewRunId.value = snapshot.id
      previewDocument.value = { code: snapshot.code, language: snapshot.language, input: { ...snapshot.input } }
      const state = previewStates.get(snapshot.id)
      if (state) handlePreviewState(state)
      else { previewStatus.value = 'LOADING'; statusFor(snapshot.id, '组件加载中') }
    }
  } catch (error) {
    if (epoch !== previewEpoch) return
    previewStarting.value = false; previewCandidateId.value = null; previewError.value = formatError(error); previewStatus.value = 'FAILED'
    appendRun(snapshot.id, `组件启动失败：${formatError(error)}\n`, 'stderr'); statusFor(snapshot.id, '启动失败'); setRunStatus('组件启动失败', 'error')
    runBuffers.delete(snapshot.id)
  }
}
function handlePreviewState(state: PreviewState): void {
  previewStates.set(state.runId, state)
  if (previewStates.size > 30) previewStates.delete(previewStates.keys().next().value!)
  if (state.runId !== previewCandidateId.value && state.runId !== previewRunId.value) return
  statusFor(state.runId, state.status === 'ready' ? '组件在线' : state.status === 'failed' ? '组件错误' : '已停止')
  if (previewCandidateId.value && state.runId !== previewCandidateId.value) return
  if (state.status === 'ready') {
    if (previewRunId.value && previewRunId.value !== state.runId) { flushHistory(); runBuffers.delete(previewRunId.value) }
    previewRunId.value = state.runId; previewCandidateId.value = null; previewStarting.value = false; previewStatus.value = 'ONLINE'; previewError.value = ''
    const snapshot = snapshotFor(state.runId)
    if (snapshot) previewDocument.value = { code: snapshot.code, language: snapshot.language, input: { ...snapshot.input } }
    setRunStatus('组件在线', 'success'); triggerGlitch('run')
  } else if (state.status === 'failed') {
    // A failed state is emitted only after Main has installed the compiled
    // document. It can arrive before startPreview's promise settles.
    if (previewCandidateId.value === state.runId) {
      if (previewRunId.value && previewRunId.value !== state.runId) { flushHistory(); runBuffers.delete(previewRunId.value) }
      previewRunId.value = state.runId
      const snapshot = snapshotFor(state.runId)
      if (snapshot) previewDocument.value = { code: snapshot.code, language: snapshot.language, input: { ...snapshot.input } }
    }
    previewStarting.value = false; previewCandidateId.value = null; previewStatus.value = 'FAILED'; previewError.value = state.error || '组件运行失败'
    setRunStatus('组件运行失败', 'error'); triggerGlitch('error')
  } else if (previewRunId.value === state.runId) { previewRunId.value = null; previewStarting.value = false; previewStatus.value = 'STOPPED' }
}
async function stopPreview(): Promise<void> {
  ++previewEpoch
  const candidate = previewCandidateId.value
  const active = previewRunId.value
  if (candidate) statusFor(candidate, '已停止')
  previewCandidateId.value = null; previewStarting.value = false
  await api.stopPreview()
  flushHistory(); if (active) runBuffers.delete(active); if (candidate) runBuffers.delete(candidate)
  previewRunId.value = null; previewDocument.value = null; previewStatus.value = 'STOPPED'; previewError.value = ''
}
async function stopRun(preserveAutoRun = false, force = false): Promise<void> {
  if (!preserveAutoRun && modalVisible.value) return
  if (!preserveAutoRun) cancelAutoRun()
  if (previewRunId.value || previewCandidateId.value) { try { await stopPreview(); setRunStatus('预览已停止', 'stopped') } catch (error) { showToast(formatError(error), 'error') }; return }
  const id = runId.value || pendingNodeId
  if (!id) return
  nodeStopping.value = true; setRunStatus(force ? '强制停止中' : '停止中', 'stopped')
  try {
    const stopped = await (force ? api.forceStopRun(id) : api.stopRun(id))
    if (!stopped && runId.value === id && !pendingNodeId) { runId.value = null; nodeStopping.value = false; setRunStatus('已结束', 'stopped'); flushAutoRun() }
  } catch (error) { autoStopRequested.value = false; appendRun(id, `停止失败：${formatError(error)}\n`, 'stderr') }
}
async function canDiscardChanges(): Promise<boolean> {
  if (!dirty.value && input.value.text === EMPTY_INPUT.text && input.value.format === EMPTY_INPUT.format) return true
  return requestConfirm({ title: '替换当前代码与输入？', message: '未保存的代码或输入数据将被替换。完整实验可先在片段库中收藏；保存脚本文件只保存代码。', confirmLabel: '替换当前实验', danger: true })
}
async function replaceDocument(document: LabDocument, path: string | null, baseline: string | null): Promise<void> {
  cancelAutoRun(); await stopPreview(); documentEpoch++
  code.value = document.code; language.value = document.language; input.value = { ...document.input }; filePath.value = path; lastSavedCode.value = baseline
  resultTab.value = isBrowserLanguage(document.language) ? 'preview' : 'console'
  await nextTick(); editorRef.value?.focus(); scheduleAutoRun()
}
async function newFile(): Promise<void> {
  if (fileActionsBlocked.value || !(await canDiscardChanges())) return
  await replaceDocument({ code: '', language: language.value, input: { ...EMPTY_INPUT } }, null, '')
}
async function refreshRecentFiles(): Promise<void> {
  try { recentFiles.value = await api.getRecentFiles() } catch { recentFiles.value = [] }
}
async function openFile(recent?: string): Promise<void> {
  if (fileMenu.value) fileMenu.value.open = false
  if (fileActionsBlocked.value || !(await canDiscardChanges())) return
  nativeDialogBusy.value = true
  try {
    await hidePreview()
    const result = recent ? await api.openRecentFile(recent) : await api.openFile()
    if (result) { await replaceDocument({ code: result.content, language: result.language, input: { ...EMPTY_INPUT } }, result.filePath, result.content); await refreshRecentFiles() }
  } catch (error) { showToast(`打开失败：${formatError(error)}`, 'error') }
  finally { nativeDialogBusy.value = false; flushAutoRun() }
}
async function saveFile(saveAs = false): Promise<void> {
  if (fileMenu.value) fileMenu.value.open = false
  if (saveDisabled.value) return
  const submitted = { code: code.value, language: language.value, filePath: filePath.value, epoch: documentEpoch }
  nativeDialogBusy.value = true
  try {
    await hidePreview()
    const result = await api.saveFile({ filePath: submitted.filePath, content: submitted.code, language: submitted.language, saveAs })
    if (!result || submitted.epoch !== documentEpoch) return
    filePath.value = result.filePath; lastSavedCode.value = submitted.code
    if (language.value === submitted.language) language.value = result.language
    showToast(dirty.value ? '已保存提交时的代码；之后的编辑仍未保存。输入数据保留在会话与片段中。' : '代码已保存。输入数据保留在会话与片段中。', 'success')
    await refreshRecentFiles()
  } catch (error) { showToast(`保存失败：${formatError(error)}`, 'error') }
  finally { nativeDialogBusy.value = false; flushAutoRun() }
}
function openLibrary(): void { if (!fileActionsBlocked.value) libraryVisible.value = true }
async function loadLibrary(document: LabDocument): Promise<void> {
  if (running.value || npmBusy.value || confirmState.value.visible) return
  libraryVisible.value = false
  if (!(await canDiscardChanges())) { libraryVisible.value = true; return }
  await replaceDocument(document, null, null)
}
function pinResult(): void { flushHistory(); if (selectedSnapshot.value && !history.pin(selectedSnapshot.value)) showToast('固定失败：结果超过 1 MB 或本地存储已满。可先减少输出后重试。', 'error'); else if (selectedSnapshot.value) showToast('结果已固定，可与后续运行比较', 'success') }
function unpinResult(): void { if (!history.unpin()) showToast('无法清除固定结果，请检查本地存储。', 'error') }
function compareResults(): void { flushHistory(); if (pinned.value && selectedSnapshot.value) { compareRight.value = JSON.parse(JSON.stringify(selectedSnapshot.value)) as RunSnapshot; compareVisible.value = true } }
async function restoreRun(snapshot = selectedSnapshot.value): Promise<void> {
  if (!snapshot || running.value || npmBusy.value || confirmState.value.visible) return
  const fromCompare = compareVisible.value; compareVisible.value = false
  if (!(await canDiscardChanges())) { compareVisible.value = fromCompare; return }
  await replaceDocument(snapshot, snapshot.filePath, null)
}
function locateOutput(location: SourceLocation): void {
  if (outputStale.value) return
  const source = selectedSnapshot.value
  if (source && !isEntrySourceLocation(location, source, workspaceLabel.value, platform.value)) { showToast(`位置属于其他文件：${location.file}:${location.line}:${location.column}`, 'info'); return }
  editorRef.value?.revealLocation(location.line, location.column)
}
function purgeOutput(): void { clearOutput(); selectedId.value = '' }
async function refreshTypeDefinitions(): Promise<void> {
  typeIndexMessage.value = 'INDEXING PACKAGE TYPES'
  try { const result = await api.getTypeDefinitions(); typeDefinitions.value = result.files; typeIndexMessage.value = `${result.files.length} TYPE FILES // ${Math.round(result.totalBytes / 1024)} KB`; if (result.truncated) showToast('类型定义超过扫描上限，只加载了部分文件') }
  catch (error) { typeIndexMessage.value = 'TYPE INDEX FAILED'; showToast(`加载类型定义失败：${formatError(error)}`, 'error') }
}
async function refreshPackageState(): Promise<void> { try { packageState.value = await api.listPackages() } catch (error) { showToast(`读取包状态失败：${formatError(error)}`, 'error') } }
async function chooseWorkspace(): Promise<void> {
  if (running.value || npmBusy.value || confirmState.value.visible) return
  try { await stopPreview(); const result = await api.chooseWorkspace(); if (!result) return; packageState.value = result; await refreshTypeDefinitions(); appendOutput(`\n[WORKSPACE] ${result.workspacePath}\n`, 'system'); showToast('工作区链路已切换', 'success'); scheduleAutoRun() }
  catch (error) { showToast(`切换工作区失败：${formatError(error)}`, 'error') }
}
async function openWorkspace(): Promise<void> { try { const error = await api.openWorkspace(); if (error) throw new Error(error) } catch (error) { showToast(`打开工作区失败：${formatError(error)}`, 'error') } }
function prepareReact(): void { if (modalVisible.value || running.value || npmBusy.value) return; packageInput.value = 'react react-dom @types/react @types/react-dom'; devDependency.value = false; packageDialogVisible.value = true }
function prepareReactTypes(): void { if (modalVisible.value || running.value || npmBusy.value) return; packageInput.value = '@types/react @types/react-dom'; devDependency.value = true; packageDialogVisible.value = true }
async function performNpmOperation(action: NpmAction, payload: { specs?: string; dev?: boolean; names?: string[] }, label: string): Promise<void> {
  if (npmBusy.value || running.value || confirmState.value.visible) return
  npmBusy.value = true; npmStatus.value = `${label} · 进行中`; pendingAutoRun.value = false
  npmLog.value += `\n╞══ ${label} ══╡\n`
  appendOutput(`\n╞══ ${label} ══╡\n`, 'package')
  try {
    await stopPreview()
    const result = action === 'install' ? await api.installPackages({ specs: payload.specs ?? '', dev: Boolean(payload.dev) }) : action === 'sync' ? await api.syncPackages() : await api.uninstallPackages({ names: payload.names ?? [] })
    packageState.value = result.packages; await refreshTypeDefinitions()
    if (!result.ok) throw new Error(`npm 退出码 ${result.code ?? '未知'}`)
    npmStatus.value = `${label} · 完成`; showToast(`${label}完成`, 'success'); if (action === 'install') packageInput.value = ''
  } catch (error) { const message = `[npm 失败] ${formatError(error)}\n`; npmStatus.value = `${label} · 失败`; npmLog.value = (npmLog.value + message).slice(-1024 * 1024); appendOutput(message, 'stderr'); showToast(message, 'error'); await refreshPackageState() }
  finally { npmBusy.value = false; scheduleAutoRun() }
}
async function installPackages(): Promise<void> { const specs = packageInput.value.trim(); if (!specs) { showToast('请输入包名，例如 lodash dayjs', 'error'); return }; await performNpmOperation('install', { specs, dev: devDependency.value }, '安装 npm 包') }
async function uninstallPackage(name: string): Promise<void> { if (npmBusy.value || running.value || confirmState.value.visible) return; const ok = await requestConfirm({ title: `卸载 ${name}？`, message: '该包会从当前工作区 package.json 与 node_modules 中移除。', confirmLabel: '卸载', danger: true }); if (ok) await performNpmOperation('uninstall', { names: [name] }, `卸载 ${name}`) }
async function stopPackageOperation(): Promise<void> { try { if (await api.stopPackageOperation()) npmStatus.value = 'NPM · 停止中' } catch (error) { showToast(`停止 npm 失败：${formatError(error)}`, 'error') } }
function setRunMode(mode: RunMode): void { if (!modalVisible.value) runMode.value = mode }
async function setLanguage(value: ScriptLanguage): Promise<void> { if (fileActionsBlocked.value || value === language.value) return; cancelAutoRun(); await stopPreview(); language.value = value; resultTab.value = isBrowserLanguage(value) ? 'preview' : 'console'; scheduleAutoRun() }
function onEditorChange(): void { /* The document watcher also covers input edits and restored snippets. */ }
function onEditorReady(): void { editorReady.value = true; languageServiceMessage.value = 'EDITOR CORE ONLINE // LS LINKING'; bootProgress.value = Math.max(bootProgress.value, 68); editorRef.value?.focus(); scheduleAutoRun(); maybeFinishBoot() }
function onLanguageServiceStatus(result: LanguageServiceProbeResult): void {
  if (result.ok) { languageServiceMessage.value = result.message; lastLanguageServiceFailure = ''; return }
  languageServiceMessage.value = 'LANGUAGE SERVICE DEGRADED'
  if (result.message === lastLanguageServiceFailure) return
  lastLanguageServiceFailure = result.message; appendOutput(`\n[EDITOR LANGUAGE SERVICE] ${result.message}\n`, 'stderr'); showToast('Monaco 语言服务加载失败；悬浮说明和格式化可能不可用', 'error'); triggerGlitch('error')
}
function maybeFinishBoot(): void { if (!bootstrapReady || !editorReady.value || bootHideTimer !== null) return; bootProgress.value = 100; bootMessage.value = 'SYSTEM READY // LINK STABLE'; bootHideTimer = window.setTimeout(() => { bootVisible.value = false; bootHideTimer = null; flushAutoRun() }, 280) }
function handleAppCommand(command: AppCommand): void { if (modalVisible.value) return; if (command === 'new') void newFile(); else if (command === 'open') void openFile(); else if (command === 'save') void saveFile(false); else if (command === 'save-as') void saveFile(true); else if (command === 'run') void runCode('manual'); else if (command === 'stop') void stopRun() }
function onGlobalKeydown(event: KeyboardEvent): void {
  if (event.defaultPrevented || modalVisible.value || !(event.ctrlKey || event.metaKey)) return
  const key = event.key.toLowerCase()
  const command = key === 'n' ? 'new' : key === 'o' ? 'open' : key === 's' ? event.shiftKey ? 'save-as' : 'save' : key === 'enter' ? 'run' : key === '.' ? 'stop' : null
  if (command) { event.preventDefault(); handleAppCommand(command) }
}
async function hidePreview(): Promise<void> { await api.setPreviewBounds({ ...lastPreviewBounds, visible: false }) }
function onPreviewBounds(bounds: PreviewBounds): void { lastPreviewBounds = bounds; void api.setPreviewBounds({ ...bounds, visible: bounds.visible && previewVisible.value }).catch(error => showToast(`预览布局失败：${formatError(error)}`, 'error')) }
function updateClock(): void { currentTime.value = new Date().toLocaleTimeString('zh-CN', { hour12: false }) }
watch([code, language, input], () => { documentRevision.value++; persistDocument(); scheduleAutoRun() }, { deep: true })
watch([filePath, lastSavedCode], persistDocument)
watch(language, value => writeStorage('offlineJsLab.language', value))
watch(runMode, value => { writeStorage('offlineJsLab.runMode', value); if (value === 'live') scheduleAutoRun(); else cancelAutoRun() })
watch(clearOutputOnRun, value => writeStorage('offlineJsLab.clearOutputOnRun', value))
watch(alignOutputToSource, value => writeStorage('offlineJsLab.alignOutputToSource', value))
watch(inputCollapsed, value => writeStorage('offlineJsLab.inputCollapsed', value))
watch([fileName, dirty], () => { document.title = `${dirty.value ? '● ' : ''}${fileName.value} — Offline JS Lab` }, { immediate: true })
watch(previewVisible, visible => { if (!visible) void hidePreview().catch(() => {}); else void nextTick(() => onPreviewBounds({ ...lastPreviewBounds, visible: true })) }, { flush: 'sync' })
watch(modalVisible, visible => { if (!visible) flushAutoRun() })
watch(running, value => {
  document.documentElement.classList.toggle('is-running', value)
  if (value && runClockTimer === null) { runStartedAt = performance.now(); runElapsedMs.value = 0; runClockTimer = window.setInterval(() => { runElapsedMs.value = performance.now() - runStartedAt }, 100) }
  else if (!value && runClockTimer !== null) { window.clearInterval(runClockTimer); runClockTimer = null }
})
const unsubscribers: Array<() => void> = []
onMounted(async () => {
  updateClock(); clockTimer = window.setInterval(updateClock, 1000); window.addEventListener('keydown', onGlobalKeydown)
  unsubscribers.push(
    api.onRunOutput(payload => { if (payload.runId === currentRunId.value) appendRun(payload.runId, payload.text, payload.stream, payload.sourceLine, payload) }),
    api.onRunExit(handleRunExit),
    api.onPreviewOutput(payload => { if (payload.runId === previewRunId.value || payload.runId === previewCandidateId.value) appendRun(payload.runId, payload.text, payload.stream, payload.sourceLine, payload) }),
    api.onPreviewState(handlePreviewState),
    api.onPackageOutput(({ text, stream }) => { npmLog.value = (npmLog.value + text).slice(-1024 * 1024); appendOutput(text, stream === 'stderr' ? 'stderr' : 'package') }),
    api.onAppCommand(handleAppCommand)
  )
  try {
    bootMessage.value = 'HOST RUNTIME // NEGOTIATING'; bootProgress.value = 34
    const bootstrap = await api.getBootstrap(); appVersion.value = bootstrap.appVersion; platform.value = bootstrap.platform; document.documentElement.dataset.platform = bootstrap.platform
    nodeRuntime.value = `NODE ${bootstrap.nodeRuntime.version || '—'} · ${bootstrap.nodeRuntime.command}`; packageState.value = bootstrap.packages
    bootMessage.value = 'TYPE MATRIX // INDEXING'; bootProgress.value = 76
    await Promise.all([refreshTypeDefinitions(), refreshRecentFiles()]); bootstrapReady = true; maybeFinishBoot()
    if (restored.filePath || restored.dirty) showToast(restored.filePath ? '已恢复上次文件与草稿。保存状态以本地草稿基线显示。' : '已恢复未保存草稿；代码与输入保存在本机。')
    persistDocument()
  } catch (error) {
    bootError.value = formatError(error); bootMessage.value = 'BOOT SEQUENCE FAILED'; bootProgress.value = 100
    appendOutput(`初始化失败：${formatError(error)}\n`, 'stderr'); setRunStatus('BOOT ERROR', 'error'); showToast('应用初始化失败，请查看输出区', 'error')
    bootHideTimer = window.setTimeout(() => { bootVisible.value = false }, 900)
  }
})
onBeforeUnmount(() => {
  flushHistory()
  persistDocument(); cancelAutoRun(); void api.stopPreview().catch(() => {})
  if (clockTimer !== null) window.clearInterval(clockTimer)
  if (bootHideTimer !== null) window.clearTimeout(bootHideTimer)
  if (glitchTimer !== null) window.clearTimeout(glitchTimer)
  if (runClockTimer !== null) window.clearInterval(runClockTimer)
  for (const timer of toastTimers.values()) window.clearTimeout(timer)
  for (const unsubscribe of unsubscribers) unsubscribe()
  window.removeEventListener('keydown', onGlobalKeydown); confirmResolver?.(false)
})
</script>

<template>
  <div class="app-shell app-shell--lab-v4" :class="{ 'app-shell--resizing': dragging }">
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
          <svg class="toolbar-button__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><path d="M12 5v14M5 12h14" /></svg><b>新建</b>
        </button>
        <button class="toolbar-button" type="button" :disabled="fileActionsBlocked" title="打开 Cmd/Ctrl+O" @click="openFile()">
          <svg class="toolbar-button__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M3 7a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7z" /></svg><b>打开</b>
        </button>
        <button class="toolbar-button" type="button" :disabled="saveDisabled" title="保存 Cmd/Ctrl+S" @click="saveFile(false)">
          <svg class="toolbar-button__icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2z" /><path d="M17 21v-8H7v8M7 3v5h8" /></svg><b>保存</b>
        </button>
        <button class="toolbar-button toolbar-button--library" type="button" :disabled="fileActionsBlocked" title="本地片段收藏与模板" @click="openLibrary"><b>片段 / 模板</b></button>
        <details ref="fileMenu" class="file-more" @toggle="fileMenuOpen = ($event.target as HTMLDetailsElement).open"><summary :aria-disabled="fileActionsBlocked">更多</summary><div class="file-more__menu">
          <button type="button" :disabled="saveDisabled" title="另存为 Cmd/Ctrl+Shift+S" @click="saveFile(true)">另存为… <small>Ctrl/Cmd+Shift+S</small></button>
          <strong>最近文件</strong>
          <span v-if="!recentFiles.length">打开或保存文件后显示在此处。</span>
          <button v-for="recent in recentFiles" :key="recent" type="button" :disabled="fileActionsBlocked" :title="recent" @click="openFile(recent)">{{ recent.split(/[\\/]/).pop() }}<small>{{ recent }}</small></button>
        </div></details>
      </nav>

      <div class="command-controls">
        <CyberSelect
          :model-value="language"
          :options="[
            { value: 'typescript', label: 'Node · TS' },
            { value: 'javascript', label: 'Node · JS' },
            { value: 'tsx', label: 'React · TSX' },
            { value: 'jsx', label: 'React · JSX' }
          ]"
          label="LANG"
          assistive-label="脚本语言"
          :disabled="fileActionsBlocked"
          @update:model-value="setLanguage($event as ScriptLanguage)"
          @open-change="languageMenuOpen = $event"
        />

        <div class="mode-switch" aria-label="运行模式">
          <button type="button" :class="{ active: runMode === 'manual' }" :disabled="modalVisible" @click="setRunMode('manual')">手动</button>
          <button type="button" :class="{ active: runMode === 'live', pending: pendingAutoRun && runMode === 'live' }" :disabled="modalVisible" @click="setRunMode('live')">
            <i aria-hidden="true" />实时
          </button>
        </div>

        <button class="execute-button" :class="{ 'execute-button--active': running }" type="button" :disabled="runDisabled" @click="runCode('manual')">
          <span class="execute-button__edge" aria-hidden="true" />
          <span class="execute-button__copy"><b>{{ browserMode ? '运行组件' : '运行代码' }}</b><small>{{ runShortcut }}</small></span>
        </button>
        <button class="abort-button" type="button" :disabled="!canStop || modalVisible" title="停止 Cmd/Ctrl+." @click="stopRun()">
          停止
        </button>
        <button v-if="nodeStopping" class="abort-button force-stop" type="button" :disabled="modalVisible" title="主动强制结束进程树" @click="stopRun(false, true)">强制结束</button>
        <button class="matrix-button" type="button" :disabled="modalVisible" title="包与工作区" @click="packageDialogVisible = true">
          <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round" aria-hidden="true"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z" /></svg><b>依赖</b>
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
              <span v-if="dirty" class="dirty-tag">未保存</span>
              <small>{{ filePath || '本地草稿 · 尚未保存到文件' }}</small>
            </div>
          </div>
          <button v-if="needsReactTypes" class="micro-button" type="button" :disabled="modalVisible || running || npmBusy" title="尚未索引 React JSX 类型；组件仍可运行。打开依赖面板安装 @types/react 和 @types/react-dom，以启用完整的 React 补全与类型检查。" @click="prepareReactTypes">补全 React 类型</button>
          <div class="editor-telemetry">
            <span>{{ language.toUpperCase() }} CORE</span>
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
            :read-only="modalVisible"
            :align-to-source="sourceAlignmentEnabled"
            @change="onEditorChange"
            @ready="onEditorReady"
            @language-service="onLanguageServiceStatus"
            @run="runCode('manual')"
            @save="saveFile(false)"
            @open="openFile()"
            @scroll="editorScrollTop = $event"
            @viewport="editorViewport = $event"
          />
        </div>
        <InputPanel v-model="input" v-model:collapsed="inputCollapsed" />
        <div v-if="npmBusy" class="editor-operation-note">依赖操作进行中，可以继续编辑；完成后再运行。</div>
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

      <section class="results-deck" :class="{ 'results-deck--preview': browserMode && resultTab === 'preview', 'results-deck--split': browserMode && resultTab === 'preview' && previewConsole }" aria-label="实验结果">
        <div v-if="browserMode" class="results-tabs" role="tablist" aria-label="结果显示">
          <button type="button" role="tab" :aria-selected="resultTab === 'preview'" @click="resultTab = 'preview'">组件预览</button>
          <button type="button" role="tab" :aria-selected="resultTab === 'console'" @click="resultTab = 'console'">控制台</button>
          <label v-if="resultTab === 'preview'"><input v-model="previewConsole" type="checkbox" /> 同时显示控制台</label>
        </div>
        <PreviewPane
          v-show="browserMode && resultTab === 'preview'"
          :visible="previewVisible"
          :active="Boolean(previewRunId)"
          :status="previewStatus"
          :error="previewError"
          :busy="previewStarting || npmBusy || running"
          :needs-react="needsReact"
          :stale="previewStale"
          @bounds="onPreviewBounds"
          @restart="runCode('manual')"
          @dependencies="prepareReact"
        />
        <OutputConsole
          v-show="!browserMode || resultTab === 'console' || previewConsole"
          :chunks="outputChunks"
          :revision="outputRevision"
          :status-label="runStatusDisplay"
          :status-kind="runStatusKind"
          :clear-on-run="clearOutputOnRun"
          :align-to-source="alignOutputToSource"
          :alignment-available="sourceAlignmentAvailable"
          :editor-line-count="editorLineCount"
          :editor-scroll-top="editorScrollTop"
          :editor-viewport="editorViewport"
          :runs="runs"
          :selected-run-id="selectedId"
          :current-run-id="currentRunId"
          :stale="outputStale"
          :pinned="pinned"
          @update:clear-on-run="clearOutputOnRun = $event"
          @update:align-to-source="alignOutputToSource = $event"
          @source-scroll="editorRef?.setScrollTop($event)"
          @select-run="selectedId = $event"
          @restore-run="restoreRun()"
          @locate="locateOutput"
          @pin="pinResult"
          @compare="compareResults"
          @unpin="unpinResult"
          @clear="purgeOutput"
        />
      </section>
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
      :npm-log="npmLog"
      :blocked-reason="packageBlockedReason"
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

    <LibraryDialog :visible="libraryVisible" :document="currentDocument" @close="libraryVisible = false" @load="loadLibrary" />
    <RunCompareDialog :visible="compareVisible" :left="pinned" :right="compareRight" @close="compareVisible = false" @restore="restoreRun($event)" />

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

    <div v-if="glitchBurst" :key="glitchSeq" class="glitch-burst" :class="`glitch-burst--${glitchBurst}`" aria-hidden="true" />

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
