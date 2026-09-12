import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import vm from 'node:vm'
import { transformSync } from 'esbuild'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { session, type BrowserWindow, type IpcMainEvent } from 'electron'
import type { RunStartPayload } from '../src/shared/types'
import type { PreviewArtifact } from '../src/main/preview-build'

const state = vi.hoisted(() => ({ views: [] as any[], sessions: [] as any[], hangLoad: false }))
vi.mock('electron', () => ({
  WebContentsView: class {
    options: unknown
    bounds: unknown = {}
    visible = false
    webContents = Object.assign(new EventEmitter(), {
      mainFrame: { url: '' }, isDestroyed: () => false, close: vi.fn(), setWindowOpenHandler: vi.fn(),
      loadURL: vi.fn((url: string) => { this.webContents.mainFrame.url = url; return state.hangLoad ? new Promise<void>(() => {}) : Promise.resolve() })
    })
    constructor(options: unknown) { this.options = options; state.views.push(this) }
    setBounds(bounds: unknown): void { this.bounds = bounds }
    setVisible(visible: boolean): void { this.visible = visible }
  },
  session: { fromPartition: vi.fn(() => {
    const session = Object.assign(new EventEmitter(), {
      setPermissionRequestHandler: vi.fn(), setPermissionCheckHandler: vi.fn(),
      webRequest: { onBeforeRequest: vi.fn() },
      protocol: { handle: vi.fn(), unhandle: vi.fn() },
      clearStorageData: vi.fn(async () => {}), clearCache: vi.fn(async () => {})
    })
    state.sessions.push(session)
    return session
  }) }
}))

import { clampPreviewBounds, PreviewManager, validatePreviewMessage } from '../src/main/preview-manager'

function artifact(): PreviewArtifact { return { assets: new Map([['/index.html', { body: '<div>test</div>', mime: 'text/html' }]]), sourceFile: '/scratch.tsx', sourceMap: null } }
const payload: RunStartPayload = { runId: 'one', language: 'tsx', code: 'export default () => <button />', sourceFilePath: null }
function fixture(compile = vi.fn(async () => artifact())) {
  const host = {
    isDestroyed: () => false,
    contentView: { addChildView: vi.fn(), removeChildView: vi.fn() },
    getContentBounds: () => ({ width: 1000, height: 800 }),
    webContents: { getZoomFactor: () => 1 }
  }
  const target = { isDestroyed: () => false, send: vi.fn() }
  return { host, target, compile, manager: new PreviewManager(() => host as unknown as BrowserWindow, () => '/workspace', () => '/preload/preview.js', compile) }
}
beforeEach(() => { vi.clearAllMocks(); state.views.length = 0; state.sessions.length = 0; state.hangLoad = false })

describe('PreviewManager lifecycle and isolation', () => {
  it('keeps a successful view when compilation fails, replaces only on success, clamps/hides bounds and fully disposes on stop', async () => {
    const f = fixture()
    expect(await f.manager.start(f.target, payload)).toEqual({ ok: true, runId: 'one' })
    const first = state.views[0]
    expect(first.visible).toBe(false)
    f.manager.setBounds({ x: 500, y: 100, width: 800, height: 800, visible: true })
    expect(first.bounds).toEqual({ x: 500, y: 100, width: 500, height: 700 })
    expect(first.visible).toBe(true)
    f.compile.mockRejectedValueOnce(new Error('Compile error'))
    expect(await f.manager.start(f.target, { ...payload, runId: 'broken' })).toEqual({ ok: false, error: 'Compile error' })
    expect(first.webContents.close).not.toHaveBeenCalled()
    await f.manager.start(f.target, { ...payload, runId: 'two' })
    expect(first.webContents.close).toHaveBeenCalledWith({ waitForBeforeUnload: false })
    f.manager.setBounds({ x: 0, y: 0, width: 400, height: 400, visible: false })
    expect(state.views[1].visible).toBe(false)
    f.manager.stop()
    expect(f.manager.hasActivePreview()).toBe(false)
    expect(state.views[1].webContents.close).toHaveBeenCalled()
    expect(session.fromPartition).toHaveBeenCalledTimes(1)
    expect(state.sessions[0].protocol.unhandle).not.toHaveBeenCalled()
    expect(state.sessions[0].clearStorageData).toHaveBeenLastCalledWith({ origin: state.views[1].webContents.mainFrame.url.replace('/index.html', '') })
    expect(f.target.send).toHaveBeenCalledWith('preview:state', { runId: 'two', status: 'stopped' })
  })

  it('ignores earlier compilation and a stopped pending run, even when they resolve later', async () => {
    let finish!: (value: PreviewArtifact) => void
    const f = fixture(vi.fn(() => new Promise<PreviewArtifact>((resolve) => { finish = resolve })))
    const first = f.manager.start(f.target, payload)
    expect(f.manager.hasActivePreview()).toBe(true)
    const finishFirst = finish
    const second = f.manager.start(f.target, { ...payload, runId: 'two' })
    finish(artifact())
    expect(await second).toEqual({ ok: true, runId: 'two' })
    finishFirst(artifact())
    expect((await first).ok).toBe(false)
    expect(state.views).toHaveLength(1)
    const third = f.manager.start(f.target, { ...payload, runId: 'three' })
    f.manager.stop()
    finish(artifact())
    expect((await third).ok).toBe(false)
    expect(state.views).toHaveLength(1)
  })

  it('reuses one session while rejecting old origins and keeping delayed old cleanup scoped to the old view', async () => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const shared = state.sessions[0]
    const oldUrl = state.views[0].webContents.mainFrame.url
    let finishCleanup!: () => void
    shared.clearStorageData.mockImplementationOnce(() => new Promise<void>(resolve => { finishCleanup = resolve }))
    await f.manager.start(f.target, { ...payload, runId: 'second' })
    const newUrl = state.views[1].webContents.mainFrame.url
    expect(newUrl).not.toBe(oldUrl)
    expect(session.fromPartition).toHaveBeenCalledTimes(1)
    expect(shared.protocol.handle).toHaveBeenCalledTimes(1)
    expect(shared.webRequest.onBeforeRequest).toHaveBeenCalledTimes(1)
    expect(shared.clearStorageData).toHaveBeenCalledExactlyOnceWith({ origin: oldUrl.replace('/index.html', '') })
    expect(shared.clearCache).not.toHaveBeenCalled()
    const check = shared.webRequest.onBeforeRequest.mock.calls[0][0]
    const serve = shared.protocol.handle.mock.calls[0][1]
    const callback = vi.fn()
    check({ url: oldUrl }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    expect(serve({ url: oldUrl, method: 'GET' }).status).toBe(404)
    check({ url: newUrl }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    finishCleanup()
    await Promise.resolve()
    expect(serve({ url: newUrl, method: 'GET' }).status).toBe(200)
    f.manager.stop()
    check({ url: newUrl }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    await f.manager.start(f.target, { ...payload, runId: 'third' })
    expect(session.fromPartition).toHaveBeenCalledTimes(1)
    expect(serve({ url: state.views[2].webContents.mainFrame.url, method: 'GET' }).status).toBe(200)
  })

  it('closes a partially attached replacement while keeping the previous working view', async () => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const first = state.views[0]
    f.host.contentView.addChildView.mockImplementationOnce(() => { throw new Error('Native view attach failed') })
    expect(await f.manager.start(f.target, { ...payload, runId: 'second' })).toEqual({ ok: false, error: 'Native view attach failed' })
    expect(state.views[1].webContents.close).toHaveBeenCalledTimes(1)
    expect(first.webContents.close).not.toHaveBeenCalled()
    expect(f.manager.hasActivePreview()).toBe(true)
    const serve = state.sessions[0].protocol.handle.mock.calls[0][1]
    expect(serve({ url: first.webContents.mainFrame.url, method: 'GET' }).status).toBe(200)
  })

  it('denies non-artifact requests and permissions, accepts only the current preview main frame, and rejects stale run output', async () => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    expect(view.options.webPreferences).toMatchObject({ nodeIntegration: false, contextIsolation: true, sandbox: true, webviewTag: false })
    const check = state.sessions[0].webRequest.onBeforeRequest.mock.calls[0][0]
    const callback = vi.fn()
    check({ url: 'https://example.invalid' }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    check({ url: view.webContents.mainFrame.url }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: false })
    check({ url: view.webContents.mainFrame.url.replace('index.html', 'secret.txt') }, callback)
    expect(callback).toHaveBeenLastCalledWith({ cancel: true })
    expect(state.sessions[0].setPermissionCheckHandler.mock.calls[0][0]()).toBe(false)
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainEvent
    const message = { marker: 'offline-js-lab-preview', type: 'output', runId: 'one', stream: 'stdout', text: 'hello\n' }
    f.manager.handleMessage({ ...event, senderFrame: { url: view.webContents.mainFrame.url } } as IpcMainEvent, message)
    f.manager.handleMessage(event, { ...message, runId: 'other' })
    expect(f.target.send).not.toHaveBeenCalled()
    f.manager.handleMessage(event, message)
    expect(f.target.send).toHaveBeenCalledWith('preview:output', expect.objectContaining({ runId: 'one', text: 'hello\n' }))
    f.manager.stop()
    f.target.send.mockClear()
    f.manager.handleMessage(event, message)
    expect(f.target.send).not.toHaveBeenCalled()
  })

  it('keeps Stop available while loadURL is pending and surfaces crashes without reviving disposed views', async () => {
    state.hangLoad = true
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    view.webContents.emit('render-process-gone', {}, { reason: 'crashed' })
    expect(f.target.send).toHaveBeenCalledWith('preview:state', expect.objectContaining({ status: 'failed', error: expect.stringContaining('crashed') }))
    f.manager.stop()
    f.target.send.mockClear()
    view.webContents.emit('render-process-gone', {}, { reason: 'killed' })
    expect(f.target.send).not.toHaveBeenCalled()
  })

  it('handles invalid bounds and bounded data without accepting arbitrary payload fields', () => {
    expect(clampPreviewBounds({ x: NaN, y: 0, width: 20, height: 20, visible: true }, { width: 100, height: 100 }).visible).toBe(false)
    expect(clampPreviewBounds({ x: 10, y: 10, width: 20, height: 20, visible: true }, { width: 100, height: 100 }, 2)).toEqual({ x: 20, y: 20, width: 40, height: 40, visible: true })
    expect(validatePreviewMessage({ marker: 'offline-js-lab-preview', runId: 'one', type: 'output', stream: 'package', text: 'bad' })).toBeNull()
    expect(validatePreviewMessage({ marker: 'offline-js-lab-preview', runId: 'one', type: 'output', stream: 'stdout', text: 'x'.repeat(300000) })).toBeNull()
  })

  it('stops the document at the shared 8 MB output budget and ignores subsequent output', async () => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainEvent
    const message = { marker: 'offline-js-lab-preview', type: 'output', runId: 'one', stream: 'stdout', text: 'x'.repeat(60000) }
    for (let index = 0; index < 150; index++) f.manager.handleMessage(event, message)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(f.manager.hasActivePreview()).toBe(false)
    expect(f.target.send).toHaveBeenCalledWith('preview:state', expect.objectContaining({ status: 'failed', error: expect.stringContaining('8 MB') }))
    f.target.send.mockClear()
    f.manager.handleMessage(event, message)
    expect(f.target.send).not.toHaveBeenCalled()
  })

  it.each(['message-size', 'output-budget', 'unserializable'])('accepts a controlled %s limit only from the current preview and disposes once', async reason => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainEvent
    const limit = { marker: 'offline-js-lab-preview', runId: 'one', type: 'limit', reason }
    f.manager.handleMessage({ ...event, senderFrame: { url: view.webContents.mainFrame.url } } as IpcMainEvent, limit)
    f.manager.handleMessage(event, { ...limit, runId: 'old' })
    expect(f.manager.hasActivePreview()).toBe(true)
    f.manager.handleMessage(event, limit)
    f.manager.handleMessage(event, limit)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(f.manager.hasActivePreview()).toBe(false)
    expect(f.target.send).toHaveBeenCalledWith('preview:state', expect.objectContaining({ runId: 'one', status: 'failed', error: expect.stringContaining('已停止组件') }))
  })

  it.each(['state', 'invalid-output'])('charges raw %s payload bytes so discarded fields cannot silently exhaust preload first', async type => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainEvent
    const message = { marker: 'offline-js-lab-preview', runId: 'one', type: type === 'state' ? 'state' : 'output', status: 'ready', stream: 'invalid', unused: 'x'.repeat(200000) }
    for (let index = 0; index < 45; index++) f.manager.handleMessage(event, message)
    expect(view.webContents.close).toHaveBeenCalledTimes(1)
    expect(f.manager.hasActivePreview()).toBe(false)
    expect(f.target.send).toHaveBeenCalledWith('preview:state', expect.objectContaining({ status: 'failed', error: expect.stringContaining('8 MB') }))
  })

  it('terminates a directly received oversized record before snapshot validation', async () => {
    const f = fixture()
    await f.manager.start(f.target, payload)
    const view = state.views[0]
    const event = { sender: view.webContents, senderFrame: view.webContents.mainFrame } as unknown as IpcMainEvent
    f.manager.handleMessage(event, { marker: 'offline-js-lab-preview', runId: 'one', type: 'output', stream: 'stdout', text: 'x'.repeat(300000) })
    expect(f.manager.hasActivePreview()).toBe(false)
    expect(f.target.send).toHaveBeenCalledWith('preview:state', expect.objectContaining({ status: 'failed', error: expect.stringContaining('256 KB') }))
  })
})

const preloadCode = transformSync(fs.readFileSync(new URL('../src/preload/preview.ts', import.meta.url), 'utf8'), { loader: 'ts', format: 'cjs', target: 'node22' }).code
function preloadFixture() {
  const send = vi.fn()
  let receive!: (event: unknown) => void
  const window = { location: { origin: 'lab-preview://current' }, addEventListener: (_type: string, handler: (event: unknown) => void) => { receive = handler } }
  vm.runInNewContext(preloadCode, { require: () => ({ ipcRenderer: { send } }), window, process: { argv: ['--offline-preview-run=one'] }, TextEncoder })
  const deliver = (data: unknown) => receive({ source: window, origin: window.location.origin, data })
  return { send, deliver }
}

describe('preview preload output gate', () => {
  it('sends one controlled limit record for an oversized message and then stops forwarding', () => {
    const f = preloadFixture()
    const message = { marker: 'offline-js-lab-preview', runId: 'one', type: 'output', stream: 'stdout', text: 'x'.repeat(300000) }
    f.deliver({ ...message, runId: 'stale' })
    expect(f.send).not.toHaveBeenCalled()
    f.deliver(message)
    f.deliver(message)
    f.deliver({ ...message, text: 'later' })
    expect(f.send).toHaveBeenCalledExactlyOnceWith('preview:message', { marker: 'offline-js-lab-preview', runId: 'one', type: 'limit', reason: 'message-size' })
  })

  it('counts all raw state bytes against 8 MB and delivers one terminal budget record', () => {
    const f = preloadFixture()
    const message = { marker: 'offline-js-lab-preview', runId: 'one', type: 'state', status: 'ready', unused: 'x'.repeat(200000) }
    for (let index = 0; index < 45; index++) f.deliver(message)
    const messages = f.send.mock.calls.map(call => call[1])
    expect(messages.filter(message => message.type === 'limit')).toEqual([{ marker: 'offline-js-lab-preview', runId: 'one', type: 'limit', reason: 'output-budget' }])
    expect(messages.at(-1).type).toBe('limit')
    expect(messages.filter(message => message.type !== 'limit').reduce((total, item) => total + Buffer.byteLength(JSON.stringify(item)), 0)).toBeLessThanOrEqual(8 * 1024 * 1024)
  })

  it('terminates nonserializable message traffic rather than repeatedly attempting to serialize it', () => {
    const f = preloadFixture()
    const message: Record<string, unknown> = { marker: 'offline-js-lab-preview', runId: 'one', type: 'output', stream: 'stdout', text: 'circular' }
    message.self = message
    f.deliver(message)
    f.deliver(message)
    expect(f.send).toHaveBeenCalledExactlyOnceWith('preview:message', { marker: 'offline-js-lab-preview', runId: 'one', type: 'limit', reason: 'unserializable' })
  })
})
