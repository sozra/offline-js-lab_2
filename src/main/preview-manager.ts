import crypto from 'node:crypto'
import { WebContentsView, session, type BrowserWindow, type IpcMainEvent, type Session, type WebContents } from 'electron'
import { IPC } from '@shared/ipc'
import type { PreviewBounds, PreviewStartResult, PreviewState, RunOutputPayload, RunStartPayload, ValueSnapshot } from '@shared/types'
import { buildPreview, locatePreviewSource, PREVIEW_CSP, PREVIEW_SCHEME, previewBuildFailure, type PreviewArtifact } from './preview-build'

const MAX_OUTPUT_BYTES = 8 * 1024 * 1024
const MAX_MESSAGE_BYTES = 256 * 1024
type Target = Pick<WebContents, 'isDestroyed' | 'send'>
type PreviewCompiler = typeof buildPreview

interface PreviewRecord {
  runId: string
  host: BrowserWindow
  target: Target
  view: WebContentsView
  session: Session
  artifact: PreviewArtifact
  url: string
  origin: string
  disposed: boolean
  failed: boolean
  outputBytes: number
}

interface PreviewMessage {
  runId: string
  type: 'output' | 'state' | 'limit'
  reason?: 'message-size' | 'output-budget' | 'unserializable'
  stream?: 'stdout' | 'stderr'
  text?: string
  stack?: string
  values?: ValueSnapshot[]
  status?: 'ready' | 'failed'
  error?: string
}

function messageByteLength(raw: unknown): number | null {
  try { return Buffer.byteLength(JSON.stringify(raw), 'utf8') } catch { return null }
}

export function validatePreviewMessage(raw: unknown, byteLength = messageByteLength(raw)): PreviewMessage | null {
  if (!raw || typeof raw !== 'object') return null
  const value = raw as Record<string, unknown>
  if (value.marker !== 'offline-js-lab-preview' || typeof value.runId !== 'string') return null
  if (byteLength === null || byteLength > MAX_MESSAGE_BYTES) return null
  if (value.type === 'limit' && (value.reason === 'message-size' || value.reason === 'output-budget' || value.reason === 'unserializable')) {
    return { runId: value.runId, type: 'limit', reason: value.reason }
  }
  if (value.type === 'state' && (value.status === 'ready' || value.status === 'failed')) {
    return { runId: value.runId, type: 'state', status: value.status, error: typeof value.error === 'string' ? value.error.slice(0, 4096) : undefined }
  }
  if (value.type !== 'output' || (value.stream !== 'stdout' && value.stream !== 'stderr') || typeof value.text !== 'string') return null
  let nodes = 0
  function validSnapshot(snapshot: unknown, depth = 0): snapshot is ValueSnapshot {
    if (++nodes > 400 || depth > 6 || !snapshot || typeof snapshot !== 'object') return false
    const item = snapshot as ValueSnapshot
    return typeof item.kind === 'string' && item.kind.length < 40 && typeof item.preview === 'string' && item.preview.length <= 8192 &&
      (item.children === undefined || (Array.isArray(item.children) && item.children.length <= 40 && item.children.every((child) => child && typeof child.key === 'string' && child.key.length <= 8192 && validSnapshot(child.value, depth + 1))))
  }
  const values = Array.isArray(value.values) && value.values.length <= 20 && value.values.every((item) => validSnapshot(item)) ? value.values as ValueSnapshot[] : undefined
  return { runId: value.runId, type: 'output', stream: value.stream, text: value.text.slice(0, 65537), stack: typeof value.stack === 'string' ? value.stack.slice(0, 32768) : '', values }
}

export function clampPreviewBounds(raw: unknown, content: { width: number; height: number }, zoom = 1): PreviewBounds {
  const hidden: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }
  if (!raw || typeof raw !== 'object') return hidden
  const bounds = raw as PreviewBounds
  if (![bounds.x, bounds.y, bounds.width, bounds.height, zoom].every(Number.isFinite) || zoom <= 0) return hidden
  const x = Math.max(0, Math.min(content.width, Math.round(bounds.x * zoom)))
  const y = Math.max(0, Math.min(content.height, Math.round(bounds.y * zoom)))
  const width = Math.max(0, Math.min(content.width - x, Math.round(bounds.width * zoom)))
  const height = Math.max(0, Math.min(content.height - y, Math.round(bounds.height * zoom)))
  return { x, y, width, height, visible: bounds.visible === true && width > 0 && height > 0 }
}

function send(target: Target, channel: string, payload: unknown): void {
  if (!target.isDestroyed()) target.send(channel, payload)
}

export class PreviewManager {
  private generation = 0
  private preparing = false
  private current: PreviewRecord | null = null
  private previewSession: Session | null = null
  private bounds: PreviewBounds = { x: 0, y: 0, width: 0, height: 0, visible: false }

  constructor(
    private readonly getHost: () => BrowserWindow | null,
    private readonly getWorkspace: () => string,
    private readonly getPreload: () => string,
    private readonly compile: PreviewCompiler = buildPreview
  ) {}

  hasActivePreview(): boolean { return this.preparing || this.current !== null }

  private getSession(): Session {
    if (this.previewSession) return this.previewSession
    // Electron retains BrowserContexts until app shutdown. Reuse one isolated
    // in-memory partition; each run still receives a unique origin and view.
    const previewSession = session.fromPartition(`offline-preview-${crypto.randomUUID()}`, { cache: false })
    previewSession.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    previewSession.setPermissionCheckHandler(() => false)
    previewSession.on('will-download', (event) => event.preventDefault())
    const lookupAsset = (url: string) => {
      const record = this.current
      if (!record || record.disposed) return undefined
      try {
        const parsed = new URL(url)
        return `${parsed.protocol}//${parsed.host}` === record.origin ? record.artifact.assets.get(parsed.pathname) : undefined
      } catch { return undefined }
    }
    // These handlers are registered once and only serve the current origin's
    // exact in-memory asset map. Request paths never reach the filesystem.
    previewSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: !lookupAsset(details.url) }))
    previewSession.protocol.handle(PREVIEW_SCHEME, (request) => {
      const asset = request.method === 'GET' ? lookupAsset(request.url) : undefined
      if (!asset) return new Response('Not found', { status: 404 })
      return new Response(typeof asset.body === 'string' ? asset.body : new Uint8Array(asset.body), {
        headers: { 'Content-Type': asset.mime, 'Content-Security-Policy': PREVIEW_CSP, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }
      })
    })
    this.previewSession = previewSession
    return previewSession
  }

  async start(target: Target, payload: RunStartPayload): Promise<PreviewStartResult> {
    const generation = ++this.generation
    const runId = typeof payload?.runId === 'string' && /^[a-zA-Z0-9_-]{1,100}$/.test(payload.runId) ? payload.runId : crypto.randomUUID()
    this.preparing = true
    let artifact: PreviewArtifact | undefined
    let pendingRecord: PreviewRecord | null = null
    let previousRecord: PreviewRecord | null = null
    try {
      artifact = await this.compile(this.getWorkspace(), runId, payload)
      if (generation !== this.generation) { artifact.assets.clear(); return { ok: false, error: '预览请求已被更新的运行或停止操作替代。' } }
      const host = this.getHost()
      if (!host || host.isDestroyed() || target.isDestroyed()) { artifact.assets.clear(); return { ok: false, error: '预览窗口已关闭。' } }
      const previewSession = this.getSession()
      const url = `${PREVIEW_SCHEME}://${crypto.randomUUID()}/index.html`
      const origin = new URL(url).origin === 'null' ? url.slice(0, url.lastIndexOf('/')) : new URL(url).origin
      const view = new WebContentsView({ webPreferences: {
        session: previewSession,
        preload: this.getPreload(),
        additionalArguments: [`--offline-preview-run=${runId}`],
        nodeIntegration: false,
        nodeIntegrationInWorker: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        allowRunningInsecureContent: false,
        webviewTag: false,
        navigateOnDragDrop: false,
        spellcheck: false,
        backgroundThrottling: false
      } })
      const record: PreviewRecord = { runId, host, target, view, session: previewSession, artifact, url, origin, disposed: false, failed: false, outputBytes: 0 }
      pendingRecord = record
      view.setVisible(false)
      const contents = view.webContents
      contents.setWindowOpenHandler(() => ({ action: 'deny' }))
      contents.on('will-navigate', (event) => event.preventDefault())
      contents.on('will-frame-navigate', (event) => event.preventDefault())
      contents.on('will-attach-webview', (event) => event.preventDefault())
      contents.on('preload-error', (_event, _path, error) => this.fail(record, `预览桥接加载失败：${error.message}`))
      contents.on('render-process-gone', (_event, details) => this.fail(record, `预览进程已退出（${details.reason}），可以重新运行。`))
      contents.on('unresponsive', () => this.fail(record, '预览没有响应；可停止后重新运行。'))
      const old = this.current
      previousRecord = old
      host.contentView.addChildView(view)
      this.current = record
      this.applyBounds()
      if (old) this.dispose(old)
      // Do not await user module execution: an infinite loop must leave Stop
      // available in the application renderer and Main process.
      void contents.loadURL(url).catch((error: unknown) => this.fail(record, `预览加载失败：${error instanceof Error ? error.message : String(error)}`))
      return { ok: true, runId }
    } catch (error) {
      if (pendingRecord) {
        if (this.current === pendingRecord) this.current = previousRecord?.disposed ? null : previousRecord
        this.dispose(pendingRecord)
      } else artifact?.assets.clear()
      return { ok: false, ...previewBuildFailure(error) }
    } finally {
      if (generation === this.generation) this.preparing = false
    }
  }

  private fail(record: PreviewRecord, error: string): void {
    if (record.disposed || this.current !== record) return
    record.failed = true
    send(record.target, IPC.previewState, { runId: record.runId, status: 'failed', error } satisfies PreviewState)
  }

  private stopForOutputLimit(record: PreviewRecord, reason: PreviewMessage['reason']): void {
    if (record.disposed || this.current !== record) return
    const error = reason === 'message-size' ? '单条预览消息超过 256 KB 上限，已停止组件。'
      : reason === 'unserializable' ? '预览消息无法序列化，已停止组件。'
      : '预览输出达到 8 MB 上限，已停止组件。'
    send(record.target, IPC.previewOutput, { runId: record.runId, stream: 'stderr', text: error + '\n' } satisfies RunOutputPayload)
    this.fail(record, error)
    this.current = null
    this.dispose(record)
  }

  handleMessage(event: IpcMainEvent, raw: unknown): void {
    const record = this.current
    if (!record || record.disposed || event.sender !== record.view.webContents || event.senderFrame !== event.sender.mainFrame || event.senderFrame?.url.split('#')[0] !== record.url) return
    if (!raw || typeof raw !== 'object') return
    const envelope = raw as Record<string, unknown>
    if (envelope.marker !== 'offline-js-lab-preview' || envelope.runId !== record.runId) return
    const bytes = messageByteLength(raw)
    if (bytes === null) { this.stopForOutputLimit(record, 'unserializable'); return }
    if (bytes > MAX_MESSAGE_BYTES) { this.stopForOutputLimit(record, 'message-size'); return }
    // Charge the exact raw wire payload before normalization or validation,
    // including state messages and invalid records, matching the preload gate.
    record.outputBytes += bytes
    if (record.outputBytes > MAX_OUTPUT_BYTES) { this.stopForOutputLimit(record, 'output-budget'); return }
    const message = validatePreviewMessage(raw, bytes)
    if (!message) return
    if (message.type === 'limit') { this.stopForOutputLimit(record, message.reason); return }
    if (message.type === 'state') {
      if (message.status === 'failed') this.fail(record, message.error || '组件执行失败。')
      else if (!record.failed) send(record.target, IPC.previewState, { runId: record.runId, status: 'ready' } satisfies PreviewState)
      return
    }
    const location = locatePreviewSource(record.artifact, message.stack || '')
    send(record.target, IPC.previewOutput, { runId: record.runId, stream: message.stream!, text: message.text!, values: message.values, sourceLine: location?.line, location } satisfies RunOutputPayload)
  }

  setBounds(bounds: PreviewBounds): void {
    this.bounds = bounds
    this.applyBounds()
  }

  applyBounds(): void {
    const record = this.current
    if (!record || record.disposed || record.host.isDestroyed()) return
    const bounds = clampPreviewBounds(this.bounds, record.host.getContentBounds(), record.host.webContents.getZoomFactor())
    record.view.setBounds({ x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height })
    record.view.setVisible(bounds.visible)
  }

  stop(): void {
    ++this.generation
    this.preparing = false
    const record = this.current
    this.current = null
    if (record) {
      this.dispose(record)
      send(record.target, IPC.previewState, { runId: record.runId, status: 'stopped' } satisfies PreviewState)
    }
  }

  private dispose(record: PreviewRecord): void {
    if (record.disposed) return
    record.disposed = true
    // A native attach/bounds failure may leave a partially constructed view.
    // Always finish teardown, even when it was never successfully attached.
    try { if (!record.host.isDestroyed()) record.host.contentView.removeChildView(record.view) } catch { /* Already detached. */ }
    try { if (!record.view.webContents.isDestroyed()) record.view.webContents.close({ waitForBeforeUnload: false }) } catch { /* Already closing. */ }
    record.artifact.assets.clear()
    // Each run's origin is unique. Asynchronous cleanup for the old view must
    // never clear a replacement view's storage or unregister shared handlers.
    void record.session.clearStorageData({ origin: record.origin }).catch(() => {})
  }
}
