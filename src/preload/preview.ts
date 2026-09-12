import { ipcRenderer } from 'electron'

// A distinct preload for the user preview: no contextBridge, filesystem,
// application commands, generic IPC API, or incoming Main subscriptions.
const argument = process.argv.find((item) => item.startsWith('--offline-preview-run='))
const runId = argument?.slice('--offline-preview-run='.length)
let outputBytes = 0
let limited = false
function notifyLimit(reason: 'message-size' | 'output-budget' | 'unserializable'): void {
  if (limited) return
  limited = true
  // A fixed, tiny control record must still reach Main when the data budget is
  // exhausted. Main verifies this preview's sender, main frame, URL and run id.
  ipcRenderer.send('preview:message', { marker: 'offline-js-lab-preview', runId, type: 'limit', reason })
}
window.addEventListener('message', (event: MessageEvent<unknown>) => {
  if (limited || !runId || event.source !== window || event.origin !== window.location.origin || !event.data || typeof event.data !== 'object') return
  const message = event.data as Record<string, unknown>
  if (message.marker !== 'offline-js-lab-preview' || message.runId !== runId || (message.type !== 'output' && message.type !== 'state')) return
  try {
    const size = new TextEncoder().encode(JSON.stringify(message)).length
    if (size > 256 * 1024) { notifyLimit('message-size'); return }
    outputBytes += size
    if (outputBytes > 8 * 1024 * 1024) { notifyLimit('output-budget'); return }
    // Keep the private channel literal here to avoid a shared Rollup chunk:
    // sandboxed Electron preloads may only require Electron's built-in subset.
    ipcRenderer.send('preview:message', message)
  } catch { notifyLimit('unserializable') }
})
